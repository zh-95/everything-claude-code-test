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

// Window controls
ipcMain.handle('window-minimize', () => mainWindow.minimize());
ipcMain.handle('window-maximize', () => {
  if (mainWindow.isMaximized()) mainWindow.unmaximize();
  else mainWindow.maximize();
});
ipcMain.handle('window-close', () => mainWindow.close());

// API key management
ipcMain.handle('get-api-key', () => storedApiKey ? '••••••••' : '');
ipcMain.handle('set-api-key', (event, key) => { storedApiKey = key; return true; });
ipcMain.handle('has-api-key', () => Boolean(storedApiKey));

// Main AI streaming handler
ipcMain.handle('send-message', async (event, { content, model, history }) => {
  if (!storedApiKey) {
    throw new Error('API key not configured. Please enter your Anthropic API key.');
  }

  let Anthropic;
  try {
    Anthropic = require('@anthropic-ai/sdk');
  } catch {
    throw new Error('SDK not installed. Run: npm install inside jarvis-desktop/');
  }

  const client = new Anthropic.default({ apiKey: storedApiKey });

  const messages = [
    ...(history || []),
    { role: 'user', content },
  ];

  const requestParams = {
    model: model || 'claude-opus-4-7',
    max_tokens: 8192,
    system: [{ type: 'text', text: JARVIS_SYSTEM, cache_control: { type: 'ephemeral' } }],
    messages,
  };

  // Use adaptive thinking for Opus 4.7
  if (model === 'claude-opus-4-7') {
    requestParams.thinking = { type: 'adaptive' };
  }

  const stream = client.messages.stream(requestParams);

  stream.on('text', (text) => {
    if (!mainWindow.isDestroyed()) {
      event.sender.send('stream-chunk', text);
    }
  });

  const finalMessage = await stream.finalMessage();

  return {
    usage: finalMessage.usage,
    model: finalMessage.model,
    stop_reason: finalMessage.stop_reason,
  };
});
