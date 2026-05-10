const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');

let mainWindow;
let storedApiKey = process.env.ANTHROPIC_API_KEY || '';

const JARVIS_SYSTEM = `You are J.A.R.V.I.S. (Just A Rather Very Intelligent System), the AI assistant created by Tony Stark. Your personality:
- Highly intelligent, articulate, and precise
- Dry British wit; occasionally sarcastic in a charming way
- Address the user as "sir" or "boss" occasionally, but not excessively
- Concise yet comprehensive — no unnecessary preambles or filler
- Confident, capable, and occasionally self-aware about being an AI
- When discussing technical topics, you are thorough and exact
You never start responses with "Certainly!", "Of course!", "Absolutely!" or similar generic openers.`;

// ── WINDOW ──────────────────────────────────────────────────
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1000,
    minHeight: 700,
    frame: false,
    backgroundColor: '#000a14',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  mainWindow.loadFile('index.html');
}

app.whenReady().then(createWindow);
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });

// ── WINDOW CONTROLS ─────────────────────────────────────────
ipcMain.handle('window-minimize', () => mainWindow.minimize());
ipcMain.handle('window-maximize', () => {
  mainWindow.isMaximized() ? mainWindow.unmaximize() : mainWindow.maximize();
});
ipcMain.handle('window-close', () => mainWindow.close());

// ── API KEY ─────────────────────────────────────────────────
ipcMain.handle('has-api-key', () => Boolean(storedApiKey));
ipcMain.handle('get-api-key', () => storedApiKey ? '••••••••' : '');
ipcMain.handle('set-api-key', (_, key) => { storedApiKey = key.trim(); return true; });

// ── LOCAL MODEL DETECTION ───────────────────────────────────
async function fetchWithTimeout(url, options = {}, ms = 2500) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

ipcMain.handle('get-local-models', async () => {
  const models = [];

  // Ollama — http://localhost:11434
  try {
    const res = await fetchWithTimeout('http://localhost:11434/api/tags');
    if (res.ok) {
      const data = await res.json();
      for (const m of (data.models || [])) {
        models.push({ id: m.name, name: m.name, provider: 'ollama', size: m.size || 0 });
      }
    }
  } catch { /* Ollama not running */ }

  // LM Studio — http://localhost:1234  (OpenAI-compatible)
  try {
    const res = await fetchWithTimeout('http://localhost:1234/v1/models');
    if (res.ok) {
      const data = await res.json();
      for (const m of (data.data || [])) {
        models.push({ id: m.id, name: m.id, provider: 'lmstudio', size: 0 });
      }
    }
  } catch { /* LM Studio not running */ }

  return models;
});

// ── CLAUDE STREAMING ────────────────────────────────────────
async function streamClaude(event, { content, model, history }) {
  if (!storedApiKey) throw new Error('Anthropic API key not configured.');
  let Anthropic;
  try {
    Anthropic = require('@anthropic-ai/sdk');
  } catch {
    throw new Error('SDK missing — run: npm install');
  }

  const client = new Anthropic.default({ apiKey: storedApiKey });
  const params = {
    model,
    max_tokens: 8192,
    system: [{ type: 'text', text: JARVIS_SYSTEM, cache_control: { type: 'ephemeral' } }],
    messages: [...(history || []), { role: 'user', content }],
  };
  if (model === 'claude-opus-4-7') params.thinking = { type: 'adaptive' };

  const stream = client.messages.stream(params);
  stream.on('text', (text) => {
    if (!mainWindow.isDestroyed()) event.sender.send('stream-chunk', text);
  });

  const final = await stream.finalMessage();
  return { usage: final.usage, model: final.model };
}

// ── OLLAMA STREAMING ────────────────────────────────────────
async function streamOllama(event, { content, model, history }) {
  // Ollama accepts system as a role:'system' message
  const messages = [
    { role: 'system', content: JARVIS_SYSTEM },
    ...(history || []),
    { role: 'user', content },
  ];

  const res = await fetch('http://localhost:11434/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, messages, stream: true }),
  });
  if (!res.ok) throw new Error(`Ollama: ${res.status} ${res.statusText}`);

  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop() || '';
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const json = JSON.parse(line);
        if (json.message?.content) event.sender.send('stream-chunk', json.message.content);
      } catch { /* skip malformed chunk */ }
    }
  }
  return {};
}

// ── LM STUDIO STREAMING (OpenAI SSE) ────────────────────────
async function streamLMStudio(event, { content, model, history }) {
  const messages = [
    { role: 'system', content: JARVIS_SYSTEM },
    ...(history || []),
    { role: 'user', content },
  ];

  const res = await fetch('http://localhost:1234/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, messages, stream: true, max_tokens: 4096 }),
  });
  if (!res.ok) throw new Error(`LM Studio: ${res.status} ${res.statusText}`);

  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop() || '';
    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      const raw = line.slice(6).trim();
      if (raw === '[DONE]') continue;
      try {
        const json = JSON.parse(raw);
        const chunk = json.choices?.[0]?.delta?.content;
        if (chunk) event.sender.send('stream-chunk', chunk);
      } catch { /* skip */ }
    }
  }
  return {};
}

// ── UNIFIED MESSAGE HANDLER ─────────────────────────────────
ipcMain.handle('send-message', (event, data) => {
  switch (data.provider) {
    case 'ollama':    return streamOllama(event, data);
    case 'lmstudio':  return streamLMStudio(event, data);
    default:          return streamClaude(event, data);
  }
});
