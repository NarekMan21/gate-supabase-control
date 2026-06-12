const config = window.GATE_CONFIG || {};
const supabaseUrl = (config.SUPABASE_URL || "").replace(/\/+$/, "");
const supabaseAnonKey = config.SUPABASE_ANON_KEY || "";
const commandTimeoutMs = config.COMMAND_TIMEOUT_MS || 10000;
const onlineWindowSeconds = config.ONLINE_WINDOW_SECONDS || 60;
const sessionKey = "gate-control-session-v1";

const gates = [
  { id: "gate1", title: "Первые ворота", subtitle: "Основной въезд" },
  { id: "gate2", title: "Вторые ворота", subtitle: "Дополнительный въезд" },
];

const authCard = document.getElementById("auth-card");
const app = document.getElementById("app");
const emailInput = document.getElementById("email");
const passwordInput = document.getElementById("password");
const loginButton = document.getElementById("login-button");
const logoutButton = document.getElementById("logout-button");
const authMessage = document.getElementById("auth-message");
const gatesContainer = document.getElementById("gates");
const logsContainer = document.getElementById("logs");

let refreshTimer = null;
let session = null;

function assertConfig() {
  if (!supabaseUrl || !supabaseAnonKey || supabaseUrl.includes("YOUR-PROJECT")) {
    authMessage.textContent = "Не настроен config.js.";
    loginButton.disabled = true;
    return false;
  }
  return true;
}

function loadSession() {
  try {
    session = JSON.parse(localStorage.getItem(sessionKey) || "null");
  } catch {
    session = null;
  }
}

function saveSession(nextSession) {
  session = nextSession;
  localStorage.setItem(sessionKey, JSON.stringify(nextSession));
}

function clearSession() {
  session = null;
  localStorage.removeItem(sessionKey);
}

async function request(path, options = {}) {
  const headers = {
    apikey: supabaseAnonKey,
    "Content-Type": "application/json",
    ...options.headers,
  };
  if (session?.access_token) {
    headers.Authorization = `Bearer ${session.access_token}`;
  } else {
    headers.Authorization = `Bearer ${supabaseAnonKey}`;
  }

  const response = await fetch(`${supabaseUrl}${path}`, {
    ...options,
    headers,
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(parseError(text) || `Ошибка ${response.status}`);
  }
  if (response.status === 204) {
    return null;
  }
  const text = await response.text();
  return text ? JSON.parse(text) : null;
}

function parseError(text) {
  try {
    const body = JSON.parse(text);
    return body.msg || body.message || body.error_description || body.error;
  } catch {
    return text;
  }
}

function gateOnline(gate) {
  if (!gate.last_seen) {
    return false;
  }
  const ageMs = Date.now() - new Date(gate.last_seen).getTime();
  return ageMs <= onlineWindowSeconds * 1000;
}

function formatTime(value) {
  if (!value) {
    return "-";
  }
  return new Date(value).toLocaleString("ru-RU");
}

function friendlyAction(command) {
  if (command === "OPEN") return "Открытие";
  if (command === "CLOSE") return "Закрытие";
  return "Действие";
}

function friendlyResult(result) {
  if (result === "DONE") return "Готово";
  if (result === "PENDING") return "В работе";
  if (result === "ERROR") return "Ошибка";
  return "Ожидание";
}

function renderGates(rows) {
  const byId = new Map(rows.map((row) => [row.id, row]));
  gatesContainer.innerHTML = gates.map((gateMeta) => {
    const gate = byId.get(gateMeta.id) || { id: gateMeta.id, command: "NONE", result: "UNKNOWN" };
    const online = gateOnline(gate);
    return `
      <section class="gate-card" data-gate="${gateMeta.id}">
        <div class="gate-head">
          <div>
            <h2>${gateMeta.title}</h2>
            <p class="gate-subtitle">${gateMeta.subtitle}</p>
          </div>
          <span class="status-pill ${online ? "online" : "offline"}">${online ? "На связи" : "Нет связи"}</span>
        </div>

        <div class="action-row">
          <button class="gate-button open" data-action="OPEN" data-gate="${gateMeta.id}" ${online ? "" : "disabled"}>Открыть</button>
          <button class="gate-button close" data-action="CLOSE" data-gate="${gateMeta.id}" ${online ? "" : "disabled"}>Закрыть</button>
        </div>
        <p id="msg-${gateMeta.id}" class="message">${online ? "Готово к команде" : "Проверьте питание или Wi-Fi"}</p>
      </section>
    `;
  }).join("");

  for (const button of gatesContainer.querySelectorAll("button[data-action]")) {
    button.addEventListener("click", () => sendCommand(button.dataset.gate, button.dataset.action));
  }
}

function renderLogs(rows) {
  if (!rows.length) {
    logsContainer.innerHTML = "<p class='hint'>Пока ничего не происходило.</p>";
    return;
  }
  logsContainer.innerHTML = rows.slice(0, 8).map((row) => `
    <div class="log-row">
      <b>${row.gate_id === "gate1" ? "Первые ворота" : "Вторые ворота"} · ${friendlyAction(row.command)}</b>
      <span>${friendlyResult(row.result)} · ${formatTime(row.created_at)}</span>
    </div>
  `).join("");
}

async function loadData() {
  const [gateRows, logRows] = await Promise.all([
    request("/rest/v1/gates?select=*&order=id.asc"),
    request("/rest/v1/logs?select=*&order=created_at.desc&limit=20"),
  ]);
  renderGates(gateRows || []);
  renderLogs(logRows || []);
}

async function waitForAck(gateId, commandId) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < commandTimeoutMs) {
    const rows = await request(`/rest/v1/gates?select=ack_id,result&id=eq.${encodeURIComponent(gateId)}&limit=1`);
    const data = rows?.[0];
    if (Number(data?.ack_id) === commandId && data.result === "DONE") {
      const message = document.getElementById(`msg-${gateId}`);
      if (message) {
        message.textContent = "Готово";
        message.classList.add("ok");
      }
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  const message = document.getElementById(`msg-${gateId}`);
  if (message) {
    message.innerHTML = "<span class='error'>Нет ответа. Попробуйте ещё раз.</span>";
  }
  return false;
}

async function sendCommand(gateId, command) {
  const message = document.getElementById(`msg-${gateId}`);
  message.classList.remove("ok");
  message.textContent = command === "OPEN" ? "Открываю..." : "Закрываю...";
  const commandId = Date.now();

  try {
    await request("/rest/v1/rpc/send_gate_command", {
      method: "POST",
      body: JSON.stringify({
        p_gate_id: gateId,
        p_command: command,
        p_command_id: commandId,
      }),
    });
    document.getElementById(`msg-${gateId}`).textContent = "Жду подтверждение...";
    const ok = await waitForAck(gateId, commandId);
    if (ok) {
      await loadData();
      const finalMessage = document.getElementById(`msg-${gateId}`);
      if (finalMessage) {
        finalMessage.textContent = "Готово";
        finalMessage.classList.add("ok");
      }
    }
  } catch (error) {
    message.innerHTML = `<span class="error">${error.message}</span>`;
  }
}

async function login() {
  authMessage.textContent = "";
  loginButton.disabled = true;
  try {
    const data = await request("/auth/v1/token?grant_type=password", {
      method: "POST",
      body: JSON.stringify({
        email: emailInput.value.trim(),
        password: passwordInput.value,
      }),
    });
    saveSession(data);
    await showApp();
  } catch (error) {
    authMessage.innerHTML = `<span class="error">${error.message}</span>`;
  } finally {
    loginButton.disabled = false;
  }
}

async function logout() {
  clearSession();
  app.classList.add("hidden");
  authCard.classList.remove("hidden");
  if (refreshTimer) {
    clearInterval(refreshTimer);
  }
}

async function showApp() {
  authCard.classList.add("hidden");
  app.classList.remove("hidden");
  await loadData();
  if (refreshTimer) {
    clearInterval(refreshTimer);
  }
  refreshTimer = setInterval(() => loadData().catch(console.error), 5000);
}

async function boot() {
  if (!assertConfig()) {
    return;
  }
  loadSession();

  loginButton.addEventListener("click", login);
  passwordInput.addEventListener("keyup", (event) => {
    if (event.key === "Enter") {
      login();
    }
  });
  logoutButton.addEventListener("click", logout);

  if (session?.access_token) {
    try {
      await showApp();
    } catch {
      clearSession();
      app.classList.add("hidden");
      authCard.classList.remove("hidden");
    }
  }
}

boot().catch((error) => {
  authMessage.innerHTML = `<span class="error">${error.message}</span>`;
});
