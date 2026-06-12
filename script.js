const config = window.GATE_CONFIG || {};
const supabaseUrl = config.SUPABASE_URL || "";
const supabaseAnonKey = config.SUPABASE_ANON_KEY || "";
const commandTimeoutMs = config.COMMAND_TIMEOUT_MS || 10000;
const onlineWindowSeconds = config.ONLINE_WINDOW_SECONDS || 60;

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

let supabaseClient = null;
let refreshTimer = null;

function assertConfig() {
  if (!supabaseUrl || !supabaseAnonKey || supabaseUrl.includes("YOUR-PROJECT")) {
    authMessage.textContent = "Заполните config.js: SUPABASE_URL и SUPABASE_ANON_KEY.";
    loginButton.disabled = true;
    return false;
  }
  return true;
}

function setupClient() {
  if (!assertConfig()) {
    return;
  }
  supabaseClient = supabase.createClient(supabaseUrl, supabaseAnonKey);
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
  const { data: gateRows, error: gatesError } = await supabaseClient
    .from("gates")
    .select("*")
    .order("id");
  if (gatesError) {
    throw gatesError;
  }

  const { data: logRows, error: logsError } = await supabaseClient
    .from("logs")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(20);
  if (logsError) {
    throw logsError;
  }

  renderGates(gateRows || []);
  renderLogs(logRows || []);
}

async function waitForAck(gateId, commandId) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < commandTimeoutMs) {
    const message = document.getElementById(`msg-${gateId}`);
    const { data, error } = await supabaseClient
      .from("gates")
      .select("ack_id,result")
      .eq("id", gateId)
      .single();
    if (error) {
      throw error;
    }
    if (Number(data.ack_id) === commandId && data.result === "DONE") {
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
  let message = document.getElementById(`msg-${gateId}`);
  message.classList.remove("ok");
  message.textContent = command === "OPEN" ? "Открываю..." : "Закрываю...";
  const commandId = Date.now();

  const { error } = await supabaseClient.rpc("send_gate_command", {
    p_gate_id: gateId,
    p_command: command,
    p_command_id: commandId,
  });
  if (error) {
    if (message) {
      message.innerHTML = `<span class="error">${error.message}</span>`;
    }
    return;
  }

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
}

async function currentGateRows() {
  const { data, error } = await supabaseClient
    .from("gates")
    .select("*")
    .order("id");
  if (error) {
    throw error;
  }
  return data || [];
}

async function login() {
  authMessage.textContent = "";
  const { error } = await supabaseClient.auth.signInWithPassword({
    email: emailInput.value.trim(),
    password: passwordInput.value,
  });
  if (error) {
    authMessage.innerHTML = `<span class="error">${error.message}</span>`;
    return;
  }
  await showApp();
}

async function logout() {
  await supabaseClient.auth.signOut();
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
  setupClient();
  if (!supabaseClient) {
    return;
  }

  loginButton.addEventListener("click", login);
  passwordInput.addEventListener("keyup", (event) => {
    if (event.key === "Enter") {
      login();
    }
  });
  logoutButton.addEventListener("click", logout);

  const { data } = await supabaseClient.auth.getSession();
  if (data.session) {
    await showApp();
  }
}

boot().catch((error) => {
  authMessage.innerHTML = `<span class="error">${error.message}</span>`;
});
