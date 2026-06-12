const config = window.GATE_CONFIG || {};
const supabaseUrl = (config.SUPABASE_URL || "").replace(/\/+$/, "");
const supabaseAnonKey = config.SUPABASE_ANON_KEY || "";
const commandTimeoutMs = config.COMMAND_TIMEOUT_MS || 10000;
const onlineWindowSeconds = config.ONLINE_WINDOW_SECONDS || 60;
const requestTimeoutMs = config.REQUEST_TIMEOUT_MS || 8000;
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
let logsRefreshTimer = null;
let session = null;
let lastGateRows = [];
const busyGateIds = new Set();

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

async function request(path, options = {}, retry = true) {
  const { timeoutMs = requestTimeoutMs, authMode = "session", ...fetchOptions } = options;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const headers = {
    apikey: supabaseAnonKey,
    "Content-Type": "application/json",
    ...fetchOptions.headers,
  };
  if (authMode === "session" && session?.access_token) {
    headers.Authorization = `Bearer ${session.access_token}`;
  } else {
    headers.Authorization = `Bearer ${supabaseAnonKey}`;
  }

  let response;
  try {
    response = await fetch(`${supabaseUrl}${path}`, {
      ...fetchOptions,
      headers,
      signal: controller.signal,
    });
  } catch (error) {
    if (error.name === "AbortError") {
      throw new Error("Сеть долго не отвечает. Попробуйте ещё раз.");
    }
    throw new Error("Не удалось связаться с сервером.");
  } finally {
    clearTimeout(timeout);
  }

  if (response.status === 401 && retry && authMode === "session" && session?.refresh_token) {
    await refreshSession();
    return request(path, options, false);
  }
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

async function refreshSession() {
  const data = await request("/auth/v1/token?grant_type=refresh_token", {
    method: "POST",
    authMode: "anon",
    body: JSON.stringify({ refresh_token: session.refresh_token }),
  }, false);
  saveSession(data);
}

function parseError(text) {
  try {
    const body = JSON.parse(text);
    const message = body.msg || body.message || body.error_description || body.error;
    if (message === "command in progress") {
      return "Подождите: предыдущая команда ещё выполняется.";
    }
    return message;
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

function pendingFresh(gate) {
  if (gate.result !== "PENDING" || !gate.updated_at) {
    return false;
  }
  return Date.now() - new Date(gate.updated_at).getTime() <= 15000;
}

function setGateMessage(gateId, text, ok = false) {
  const message = document.getElementById(`msg-${gateId}`);
  if (!message) {
    return;
  }
  message.textContent = text;
  message.classList.toggle("ok", ok);
}

function renderGates(rows) {
  const byId = new Map(rows.map((row) => [row.id, row]));
  gatesContainer.innerHTML = gates.map((gateMeta) => {
    const gate = byId.get(gateMeta.id) || { id: gateMeta.id, command: "NONE", result: "UNKNOWN" };
    const online = gateOnline(gate);
    const processing = busyGateIds.has(gateMeta.id) || pendingFresh(gate);
    const message = busyGateIds.has(gateMeta.id)
      ? "Выполняется..."
      : pendingFresh(gate)
        ? "Устройство выполняет команду..."
        : online
          ? "Готово к команде"
          : "Проверьте питание или Wi-Fi";
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
          <button class="gate-button open" data-action="OPEN" data-gate="${gateMeta.id}" ${online && !processing ? "" : "disabled"}>Открыть</button>
          <button class="gate-button close" data-action="CLOSE" data-gate="${gateMeta.id}" ${online && !processing ? "" : "disabled"}>Закрыть</button>
        </div>
        <p id="msg-${gateMeta.id}" class="message">${message}</p>
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

async function loadGates() {
  const gateRows = await request("/rest/v1/gates?select=*&order=id.asc", { timeoutMs: 6000 });
  lastGateRows = gateRows || [];
  renderGates(lastGateRows);
}

async function loadLogs() {
  const logRows = await request("/rest/v1/logs?select=*&order=created_at.desc&limit=20", { timeoutMs: 6000 });
  renderLogs(logRows || []);
}

async function loadData() {
  await loadGates();
  loadLogs().catch(console.error);
}

async function waitForAck(gateId, commandId) {
  const startedAt = Date.now();
  let lastError = null;
  while (Date.now() - startedAt < commandTimeoutMs) {
    try {
      const rows = await request(`/rest/v1/gates?select=ack_id,result&id=eq.${encodeURIComponent(gateId)}&limit=1`, { timeoutMs: 4000 });
      const data = rows?.[0];
      if (Number(data?.ack_id) === commandId && data.result === "DONE") {
        setGateMessage(gateId, "Готово", true);
        return true;
      }
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 700));
  }
  setGateMessage(gateId, lastError ? lastError.message : "Нет ответа. Попробуйте ещё раз.");
  return false;
}

async function sendCommand(gateId, command) {
  if (busyGateIds.has(gateId)) {
    return;
  }
  busyGateIds.add(gateId);
  renderGates(lastGateRows);
  setGateMessage(gateId, command === "OPEN" ? "Открываю..." : "Закрываю...");
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
    setGateMessage(gateId, "Команда отправлена. Жду устройство...");
    const ok = await waitForAck(gateId, commandId);
    busyGateIds.delete(gateId);
    await loadGates();
    if (ok) {
      setGateMessage(gateId, "Готово", true);
      loadLogs().catch(console.error);
    }
  } catch (error) {
    busyGateIds.delete(gateId);
    renderGates(lastGateRows);
    const message = document.getElementById(`msg-${gateId}`);
    if (message) {
      message.innerHTML = `<span class="error">${error.message}</span>`;
    }
  }
}

async function login() {
  authMessage.textContent = "";
  loginButton.disabled = true;
  try {
    const data = await request("/auth/v1/token?grant_type=password", {
      method: "POST",
      authMode: "anon",
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
  if (logsRefreshTimer) {
    clearInterval(logsRefreshTimer);
  }
}

async function showApp() {
  authCard.classList.add("hidden");
  app.classList.remove("hidden");
  await loadData();
  if (refreshTimer) {
    clearInterval(refreshTimer);
  }
  if (logsRefreshTimer) {
    clearInterval(logsRefreshTimer);
  }
  refreshTimer = setInterval(() => loadGates().catch(console.error), 8000);
  logsRefreshTimer = setInterval(() => loadLogs().catch(console.error), 30000);
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
