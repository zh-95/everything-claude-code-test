/* J.A.R.V.I.S. Renderer Process */

// ── STATE ───────────────────────────────────────────────────
let currentModel  = 'claude-opus-4-7';
let conversationHistory = [];
let isStreaming   = false;
let ttsEnabled    = true;
let stats = { msgs: 0, tokensIn: 0, tokensOut: 0, cached: 0 };

// Voice
let recognition   = null;
let synth         = window.speechSynthesis;
let micActive     = false;

// ── DOM REFS ────────────────────────────────────────────────
const $messages   = document.getElementById('messages');
const $msgInput   = document.getElementById('msg-input');
const $sendBtn    = document.getElementById('send-btn');
const $micBtn     = document.getElementById('mic-btn');
const $typingRow  = document.getElementById('typing-row');
const $apiInput   = document.getElementById('api-input');
const $apiSaveBtn = document.getElementById('api-save-btn');
const $apiStatus  = document.getElementById('api-status');
const $ttsBtn     = document.getElementById('tts-btn');
const $clearBtn   = document.getElementById('clear-btn');
const $exportBtn  = document.getElementById('export-btn');
const $modalBg    = document.getElementById('modal-bg');
const $modalKey   = document.getElementById('modal-key-input');
const $modalSave  = document.getElementById('modal-save-btn');
const $contextBar = document.getElementById('context-bar');
const $contextVal = document.getElementById('context-val');
const $latencyBar = document.getElementById('latency-bar');
const $latencyVal = document.getElementById('latency-val');
const $waveCanvas = document.getElementById('waveform');
const wCtx        = $waveCanvas.getContext('2d');
const $clock      = document.getElementById('clock');
const $dateline   = document.getElementById('dateline');
const $modelBadge = document.getElementById('active-model-badge');
const $welcomeTime= document.getElementById('welcome-time');

// ── INIT ────────────────────────────────────────────────────
(async function init() {
  updateClock();
  setInterval(updateClock, 1000);
  animateWaveform();
  setupVoice();
  setupStreamListener();
  bindEvents();
  await checkApiKey();
  $welcomeTime.textContent = new Date().toLocaleTimeString('en-US', { hour12: false });
  document.querySelector('.jarvis-msg').querySelector('.msg-time').textContent =
    new Date().toLocaleTimeString('en-US', { hour12: false });
})();

// ── CLOCK ───────────────────────────────────────────────────
function updateClock() {
  const now = new Date();
  $clock.textContent = now.toLocaleTimeString('en-US', { hour12: false });
  $dateline.textContent = now.toLocaleDateString('en-US', {
    weekday: 'short', year: 'numeric', month: 'short', day: 'numeric'
  }).toUpperCase();
}

// ── API KEY ─────────────────────────────────────────────────
async function checkApiKey() {
  const has = await window.jarvis.hasApiKey();
  if (has) {
    $apiStatus.textContent = 'AUTHENTICATED';
    $apiStatus.classList.add('ok');
    $apiInput.placeholder = '••••••••••••••••';
  } else {
    $modalBg.style.display = 'flex';
  }
}

async function saveApiKey(key) {
  if (!key.trim()) return;
  await window.jarvis.setApiKey(key.trim());
  $apiStatus.textContent = 'AUTHENTICATED';
  $apiStatus.classList.add('ok');
  $apiInput.value = '';
  $apiInput.placeholder = '••••••••••••••••';
  $modalBg.style.display = 'none';
  speak('API key configured. All systems online.');
}

// ── EVENTS ──────────────────────────────────────────────────
function bindEvents() {
  // Window controls
  document.getElementById('btn-min').onclick   = () => window.jarvis.minimize();
  document.getElementById('btn-max').onclick   = () => window.jarvis.maximize();
  document.getElementById('btn-close').onclick = () => window.jarvis.close();

  // Send message
  $sendBtn.onclick = sendMessage;
  $msgInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
  });
  $msgInput.addEventListener('input', autoResize);

  // Mic
  $micBtn.onclick = toggleMic;
  document.addEventListener('keydown', (e) => {
    if (e.ctrlKey && e.key === 'm') { e.preventDefault(); toggleMic(); }
  });

  // Model selector
  document.querySelectorAll('.model-opt').forEach(btn => {
    btn.onclick = () => {
      document.querySelectorAll('.model-opt').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      currentModel = btn.dataset.model;
      const labels = {
        'claude-opus-4-7':   'OPUS 4.7',
        'claude-sonnet-4-6': 'SONNET 4.6',
        'claude-haiku-4-5':  'HAIKU 4.5',
      };
      $modelBadge.textContent = labels[currentModel] || currentModel.toUpperCase();
    };
  });

  // TTS toggle
  $ttsBtn.onclick = () => {
    ttsEnabled = !ttsEnabled;
    $ttsBtn.textContent = `${ttsEnabled ? '🔊' : '🔇'} VOICE OUTPUT: ${ttsEnabled ? 'ON' : 'OFF'}`;
    $ttsBtn.classList.toggle('active', ttsEnabled);
    if (!ttsEnabled) synth.cancel();
  };

  // Clear
  $clearBtn.onclick = () => {
    conversationHistory = [];
    $messages.innerHTML = `
      <div class="msg jarvis-msg">
        <div class="msg-meta">
          <span class="msg-from">J.A.R.V.I.S.</span>
          <span class="msg-time">${new Date().toLocaleTimeString('en-US',{hour12:false})}</span>
        </div>
        <div class="msg-body">Session cleared. Memory wiped. Ready for new orders, sir.</div>
      </div>`;
    stats = { msgs: 0, tokensIn: 0, tokensOut: 0, cached: 0 };
    updateStats();
    updateContext(0);
  };

  // Export
  $exportBtn.onclick = exportLog;

  // API key
  $apiSaveBtn.onclick = () => saveApiKey($apiInput.value);
  $apiInput.addEventListener('keydown', e => { if (e.key === 'Enter') saveApiKey($apiInput.value); });
  $modalSave.onclick = () => saveApiKey($modalKey.value);
  $modalKey.addEventListener('keydown', e => { if (e.key === 'Enter') saveApiKey($modalKey.value); });
}

function autoResize() {
  $msgInput.style.height = 'auto';
  $msgInput.style.height = Math.min($msgInput.scrollHeight, 120) + 'px';
}

// ── SEND MESSAGE ────────────────────────────────────────────
async function sendMessage() {
  const text = $msgInput.value.trim();
  if (!text || isStreaming) return;

  // Check API key first
  const hasKey = await window.jarvis.hasApiKey();
  if (!hasKey) { $modalBg.style.display = 'flex'; return; }

  $msgInput.value = '';
  $msgInput.style.height = 'auto';

  // Add user message to UI
  appendMessage('user', text);

  // Add to history
  conversationHistory.push({ role: 'user', content: text });

  // Update context usage (rough estimate: 4 chars ≈ 1 token)
  const totalChars = conversationHistory.reduce((s, m) =>
    s + (typeof m.content === 'string' ? m.content.length : 0), 0);
  updateContext(Math.min(Math.round(totalChars / 40000 * 100), 95));

  // Start streaming
  isStreaming = true;
  $sendBtn.disabled = true;
  $typingRow.style.display = 'flex';

  const startTime = Date.now();
  const streamMsgEl = createStreamingMessage();

  try {
    window.jarvis.removeStreamListeners();
    window.jarvis.onStreamChunk((chunk) => {
      appendToStreamingMessage(streamMsgEl, chunk);
    });

    const result = await window.jarvis.sendMessage({
      content: text,
      model: currentModel,
      history: conversationHistory.slice(0, -1), // exclude last user msg (already in content)
    });

    finalizeStreamingMessage(streamMsgEl);

    // Update stats
    if (result?.usage) {
      stats.tokensIn  += result.usage.input_tokens  || 0;
      stats.tokensOut += result.usage.output_tokens || 0;
      stats.cached    += result.usage.cache_read_input_tokens || 0;
    }
    stats.msgs++;
    updateStats();

    // Latency
    const ms = Date.now() - startTime;
    $latencyVal.textContent = ms + 'ms';
    $latencyBar.style.width = Math.max(10, Math.min(100, 100 - ms / 50)) + '%';

    // Add assistant response to history
    const responseText = streamMsgEl.querySelector('.msg-body').textContent;
    conversationHistory.push({ role: 'assistant', content: responseText });

    // TTS
    if (ttsEnabled) speak(responseText);

  } catch (err) {
    finalizeStreamingMessage(streamMsgEl, true);
    streamMsgEl.querySelector('.msg-body').textContent = `⚠ ERROR: ${err.message}`;
    if (err.message.includes('API key')) {
      $modalBg.style.display = 'flex';
    }
  } finally {
    isStreaming = false;
    $sendBtn.disabled = false;
    $typingRow.style.display = 'none';
    window.jarvis.removeStreamListeners();
  }
}

// ── MESSAGE RENDERING ───────────────────────────────────────
function appendMessage(role, content) {
  const el = document.createElement('div');
  el.className = `msg ${role === 'user' ? 'user-msg' : 'jarvis-msg'}`;
  const name = role === 'user' ? 'YOU' : 'J.A.R.V.I.S.';
  el.innerHTML = `
    <div class="msg-meta">
      <span class="msg-from">${name}</span>
      <span class="msg-time">${new Date().toLocaleTimeString('en-US', { hour12: false })}</span>
    </div>
    <div class="msg-body">${escapeHtml(content)}</div>`;
  $messages.appendChild(el);
  $messages.scrollTop = $messages.scrollHeight;
  return el;
}

function createStreamingMessage() {
  const el = document.createElement('div');
  el.className = 'msg jarvis-msg';
  el.innerHTML = `
    <div class="msg-meta">
      <span class="msg-from">J.A.R.V.I.S.</span>
      <span class="msg-time">${new Date().toLocaleTimeString('en-US', { hour12: false })}</span>
    </div>
    <div class="msg-body"><span class="streaming-cursor"></span></div>`;
  $messages.appendChild(el);
  $messages.scrollTop = $messages.scrollHeight;
  return el;
}

let streamBuffer = '';

function appendToStreamingMessage(el, chunk) {
  streamBuffer += chunk;
  const body = el.querySelector('.msg-body');
  // Remove cursor, set text, re-add cursor
  body.innerHTML = escapeHtml(streamBuffer) + '<span class="streaming-cursor"></span>';
  $messages.scrollTop = $messages.scrollHeight;
}

function finalizeStreamingMessage(el, isError = false) {
  const body = el.querySelector('.msg-body');
  // Remove cursor span and set final text
  body.innerHTML = escapeHtml(streamBuffer);
  streamBuffer = '';
  if (isError) body.style.color = '#ff4444';
}

function escapeHtml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/\n/g, '<br>');
}

// ── STATS ───────────────────────────────────────────────────
function updateStats() {
  document.getElementById('stat-msgs').textContent  = stats.msgs;
  document.getElementById('stat-in').textContent    = formatNum(stats.tokensIn);
  document.getElementById('stat-out').textContent   = formatNum(stats.tokensOut);
  document.getElementById('stat-cache').textContent = formatNum(stats.cached);
}

function updateContext(pct) {
  $contextBar.style.width = pct + '%';
  $contextVal.textContent = pct + '%';
  $contextBar.style.background =
    pct > 80 ? 'linear-gradient(90deg, #aa4400, #ff6a00)' :
    pct > 50 ? 'linear-gradient(90deg, #aa7700, #ffaa00)' :
               'linear-gradient(90deg, var(--cyan-dim), var(--cyan))';
}

function formatNum(n) {
  if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
  if (n >= 1000)    return (n / 1000).toFixed(1) + 'K';
  return String(n);
}

// ── STREAM LISTENER ─────────────────────────────────────────
function setupStreamListener() {
  // Listeners are set up per-request in sendMessage()
}

// ── VOICE INPUT ─────────────────────────────────────────────
function setupVoice() {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) return;
  recognition = new SpeechRecognition();
  recognition.lang = 'en-US';
  recognition.continuous = false;
  recognition.interimResults = false;
  recognition.onresult = (e) => {
    const transcript = e.results[0][0].transcript;
    $msgInput.value = transcript;
    autoResize();
    toggleMic(); // stop
    sendMessage();
  };
  recognition.onerror = () => toggleMic();
  recognition.onend = () => {
    if (micActive) { micActive = false; $micBtn.classList.remove('active'); }
  };
}

function toggleMic() {
  if (!recognition) { appendMessage('jarvis', 'Voice recognition not available in this environment.'); return; }
  if (micActive) {
    recognition.stop();
    micActive = false;
    $micBtn.classList.remove('active');
  } else {
    recognition.start();
    micActive = true;
    $micBtn.classList.add('active');
  }
}

// ── TEXT-TO-SPEECH ──────────────────────────────────────────
function speak(text) {
  if (!ttsEnabled || !synth) return;
  synth.cancel();
  // Strip HTML entities and tags
  const plain = text.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
  // Limit length for TTS
  const excerpt = plain.length > 400 ? plain.substring(0, 400) + '...' : plain;
  const utt = new SpeechSynthesisUtterance(excerpt);
  utt.rate  = 1.0;
  utt.pitch = 0.85;
  utt.volume = 0.9;
  // Try to get a British male voice
  const voices = synth.getVoices();
  const brit = voices.find(v => v.lang === 'en-GB' && v.name.toLowerCase().includes('male'))
            || voices.find(v => v.lang === 'en-GB')
            || voices.find(v => v.lang.startsWith('en'));
  if (brit) utt.voice = brit;
  synth.speak(utt);
}

// ── WAVEFORM ANIMATION ──────────────────────────────────────
function animateWaveform() {
  const W = $waveCanvas.width;
  const H = $waveCanvas.height;
  const points = 48;
  let phase = 0;

  function draw() {
    wCtx.clearRect(0, 0, W, H);
    wCtx.strokeStyle = micActive ? '#00ffee' : 'rgba(0,212,255,0.5)';
    wCtx.lineWidth = 1.5;
    wCtx.beginPath();
    for (let i = 0; i < points; i++) {
      const x = (i / (points - 1)) * W;
      const amp = micActive
        ? 10 + Math.random() * 14
        : 3 + Math.sin(phase + i * 0.4) * 4 + Math.sin(phase * 1.7 + i * 0.8) * 2;
      const y = H / 2 + Math.sin(phase + i * 0.35) * amp;
      i === 0 ? wCtx.moveTo(x, y) : wCtx.lineTo(x, y);
    }
    wCtx.stroke();
    phase += isStreaming ? 0.2 : 0.04;
    requestAnimationFrame(draw);
  }
  draw();
}

// ── EXPORT ──────────────────────────────────────────────────
function exportLog() {
  const lines = conversationHistory.map(m =>
    `[${m.role.toUpperCase()}]\n${m.content}\n`
  ).join('\n---\n\n');
  const blob = new Blob([`J.A.R.V.I.S. SESSION LOG\n${'─'.repeat(40)}\n\n${lines}`], { type: 'text/plain' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href = url;
  a.download = `jarvis-session-${Date.now()}.txt`;
  a.click();
  URL.revokeObjectURL(url);
}
