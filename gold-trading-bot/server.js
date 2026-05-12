'use strict';

const express = require('express');
const WebSocket = require('ws');
const http = require('http');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.static(path.join(__dirname, 'public')));

// ===== CONSTANTS =====
const INITIAL_BALANCE    = 50;
const TRADE_SIZE_PCT     = 0.30;   // 30% del balance per trade
const SPREAD_PCT         = 0.0012; // 0.12% spread (CFD oro realistico)
const STOP_LOSS_PCT      = 0.008;  // 0.8% stop loss
const TAKE_PROFIT_PCT    = 0.014;  // 1.4% take profit
const TICK_INTERVAL_MS   = 5000;   // 5 secondi
const SCRAPE_INTERVAL_MS = 30000;  // aggiorna prezzo reale ogni 30s

// ===== STATE =====
let state = {
  balance: INITIAL_BALANCE,
  position: null,
  trades: [],
  prices: [],
  totalPnL: 0,
  wins: 0,
  losses: 0,
  startTime: Date.now(),
  lastPrice: null,
  lastRealPrice: null,
  dataSource: 'simulazione',
  botLogs: [],
  paused: false
};

// Base realistica: oro ~€2130/oz
let basePrice = 2130.0;
let trendBias = 0;

// ===== LOGGER =====
function addLog(msg) {
  const entry = { t: Date.now(), msg };
  state.botLogs.unshift(entry);
  if (state.botLogs.length > 80) state.botLogs.pop();
  console.log(`[BOT] ${msg}`);
}

// ===== WEB SCRAPING / PRICE FETCHING =====

async function fetchFromMetalsLive() {
  const res = await fetch('https://api.metals.live/v1/spot', {
    signal: AbortSignal.timeout(4000),
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; GoldBot/1.0)' }
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  if (!data.gold) throw new Error('no gold field');
  // USD → EUR  (tasso ~0.925)
  return parseFloat(data.gold) * 0.925;
}

async function scrapeGoldPriceOrg() {
  // Tentiamo di fare scraping del JSON embedded in goldprice.org
  const res = await fetch('https://data-asg.goldprice.org/dbXRates/EUR', {
    signal: AbortSignal.timeout(4000),
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Origin': 'https://goldprice.org',
      'Referer': 'https://goldprice.org/'
    }
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  // items[0].xauPrice = prezzo oro in EUR per grammo → moltiplicare x 31.1035 per oz
  if (data.items && data.items[0] && data.items[0].xauPrice) {
    return parseFloat(data.items[0].xauPrice) * 31.1035;
  }
  throw new Error('parse error');
}

async function fetchRealGoldPrice() {
  // Prova 1: metals.live API
  try {
    const price = await fetchFromMetalsLive();
    state.dataSource = 'metals.live';
    return price;
  } catch (e) {
    // ignore
  }

  // Prova 2: goldprice.org scraping
  try {
    const price = await scrapeGoldPriceOrg();
    state.dataSource = 'goldprice.org';
    return price;
  } catch (e) {
    // ignore
  }

  return null;
}

// Aggiorna il prezzo reale ogni 30s
async function updateRealPrice() {
  const p = await fetchRealGoldPrice();
  if (p && p > 1000 && p < 5000) {
    state.lastRealPrice = p;
    basePrice = p;
    addLog(`🌐 Prezzo reale aggiornato: €${p.toFixed(2)}/oz (${state.dataSource})`);
  } else {
    addLog('⚠️  Nessuna fonte online disponibile, uso simulazione');
    state.dataSource = 'simulazione';
  }
}

// Genera un tick di prezzo realistico con micro-volatilità
function generatePriceTick() {
  // Random walk con leggero trend e mean-reversion
  const volatility  = 0.25 + Math.random() * 0.35;  // €0.25-0.60 per tick
  const trendForce  = trendBias * 0.15;
  const meanRevert  = (basePrice - state.prices.slice(-20).reduce((a,b)=>a+b,basePrice)/21) * 0.02;
  const shock       = Math.random() < 0.05 ? (Math.random() - 0.5) * 2.5 : 0; // spike rari

  const delta = (Math.random() - 0.5) * volatility * 2 + trendForce + meanRevert + shock;

  // Aggiorna bias trend (momentum)
  trendBias = trendBias * 0.85 + delta * 0.15;
  if (Math.abs(trendBias) > 0.5) trendBias *= 0.7;

  const lastPrice = state.prices.length > 0 ? state.prices[state.prices.length - 1] : basePrice;
  return Math.max(1800, lastPrice + delta);
}

async function getNextPrice() {
  // Se abbiamo prezzo reale recente, partiamo da quello con micro-variazioni
  return generatePriceTick();
}

// ===== INDICATORI TECNICI =====
function calcIndicators(prices) {
  if (prices.length < 4) return null;

  const n = prices.length;

  // EMA helper
  const ema = (arr, period) => {
    const k = 2 / (period + 1);
    let e = arr.slice(0, period).reduce((a, b) => a + b, 0) / period;
    for (let i = period; i < arr.length; i++) e = arr[i] * k + e * (1 - k);
    return e;
  };

  const ema5  = ema(prices, Math.min(5, n));
  const ema12 = ema(prices, Math.min(12, n));

  // RSI semplificato (5 periodi)
  const rsiPeriod = Math.min(5, n - 1);
  let gains = 0, losses = 0;
  for (let i = n - rsiPeriod; i < n; i++) {
    const d = prices[i] - prices[i - 1];
    if (d > 0) gains += d; else losses -= d;
  }
  const rs  = losses === 0 ? 100 : gains / losses;
  const rsi = 100 - 100 / (1 + rs);

  // Momentum (variazione % ultima vs 5 fa)
  const mom5 = n >= 6
    ? (prices[n - 1] - prices[n - 6]) / prices[n - 6] * 100
    : 0;

  // Variazione ultimo tick
  const tick = n >= 2
    ? (prices[n - 1] - prices[n - 2]) / prices[n - 2] * 100
    : 0;

  return {
    ema5, ema12,
    rsi: parseFloat(rsi.toFixed(2)),
    mom5: parseFloat(mom5.toFixed(4)),
    tick: parseFloat(tick.toFixed(4)),
    current: prices[n - 1]
  };
}

// ===== STRATEGIA =====
function decideSignal(ind, position) {
  if (!ind) return 'HOLD';

  const { ema5, ema12, rsi, mom5, tick, current } = ind;

  if (position) {
    const pct = (current - position.entryPrice) / position.entryPrice;
    const dir = position.type === 'long' ? 1 : -1;

    // Stop loss
    if (pct * dir <= -STOP_LOSS_PCT) return 'CLOSE_SL';
    // Take profit
    if (pct * dir >= TAKE_PROFIT_PCT) return 'CLOSE_TP';

    // Uscita per inversione segnale
    if (position.type === 'long'  && ema5 < ema12 && tick < -0.03) return 'CLOSE';
    if (position.type === 'short' && ema5 > ema12 && tick >  0.03) return 'CLOSE';

    return 'HOLD';
  }

  // Entrata nuova posizione
  const bullish = ema5 > ema12 && mom5 > 0.02  && rsi < 72 && tick > 0;
  const bearish = ema5 < ema12 && mom5 < -0.02 && rsi > 28 && tick < 0;

  if (bullish) return 'BUY';
  if (bearish) return 'SELL';
  return 'HOLD';
}

// ===== ESEGUI TRADE =====
function executeTrade(signal, price) {
  if (signal === 'HOLD' || state.balance <= 0.01) return;

  const spread   = price * SPREAD_PCT;
  const halfSprd = spread / 2;

  if (signal === 'BUY' && !state.position) {
    const entry = price + halfSprd;
    const size  = state.balance * TRADE_SIZE_PCT;
    state.position = { type: 'long', entryPrice: entry, size, oz: size / entry, openTime: Date.now() };
    addLog(`📈 LONG aperto @ €${entry.toFixed(2)} | Lotto: €${size.toFixed(2)}`);
  }

  else if (signal === 'SELL' && !state.position) {
    const entry = price - halfSprd;
    const size  = state.balance * TRADE_SIZE_PCT;
    state.position = { type: 'short', entryPrice: entry, size, oz: size / entry, openTime: Date.now() };
    addLog(`📉 SHORT aperto @ €${entry.toFixed(2)} | Lotto: €${size.toFixed(2)}`);
  }

  else if (signal.startsWith('CLOSE') && state.position) {
    const pos = state.position;
    let pnl = 0;

    if (pos.type === 'long') {
      const closePrice = price - halfSprd;
      pnl = pos.oz * (closePrice - pos.entryPrice);
    } else {
      const closePrice = price + halfSprd;
      pnl = pos.oz * (pos.entryPrice - closePrice);
    }

    state.balance  += pnl;
    state.totalPnL += pnl;
    if (pnl >= 0) state.wins++; else state.losses++;

    const reason = signal.replace('CLOSE_', '').replace('CLOSE', 'EXIT');
    const emoji  = pnl >= 0 ? '✅' : '❌';
    addLog(`${emoji} ${reason} ${pos.type.toUpperCase()} | P&L: ${pnl >= 0 ? '+' : ''}€${pnl.toFixed(4)} | Balance: €${state.balance.toFixed(4)}`);

    state.trades.push({
      type:       pos.type,
      entryPrice: pos.entryPrice,
      closePrice: price,
      size:       pos.size,
      pnl,
      reason,
      duration:   Date.now() - pos.openTime,
      time:       Date.now()
    });

    if (state.trades.length > 200) state.trades.shift();
    state.position = null;
  }
}

// ===== LOOP PRINCIPALE =====
async function tradingTick() {
  if (state.paused) return;

  const price = await getNextPrice();
  state.prices.push(price);
  if (state.prices.length > 200) state.prices.shift();
  state.lastPrice = price;

  const ind    = calcIndicators(state.prices);
  const signal = decideSignal(ind, state.position);
  executeTrade(signal, price);

  // Unrealized P&L
  let unrealized = 0;
  if (state.position) {
    const pos = state.position;
    unrealized = pos.type === 'long'
      ? pos.oz * (price - pos.entryPrice)
      : pos.oz * (pos.entryPrice - price);
  }

  const payload = {
    type:         'tick',
    ts:           Date.now(),
    price:        parseFloat(price.toFixed(2)),
    balance:      parseFloat(state.balance.toFixed(4)),
    totalPnL:     parseFloat(state.totalPnL.toFixed(4)),
    unrealized:   parseFloat(unrealized.toFixed(4)),
    equity:       parseFloat((state.balance + unrealized).toFixed(4)),
    wins:         state.wins,
    losses:       state.losses,
    position:     state.position,
    signal,
    indicators:   ind,
    logs:         state.botLogs.slice(0, 12),
    trades:       state.trades.slice(-15),
    prices:       state.prices.slice(-80),
    dataSource:   state.dataSource,
    paused:       state.paused,
    uptime:       Math.floor((Date.now() - state.startTime) / 1000)
  };

  broadcast(payload);
}

function broadcast(data) {
  const msg = JSON.stringify(data);
  wss.clients.forEach(c => {
    if (c.readyState === WebSocket.OPEN) c.send(msg);
  });
}

// ===== WEBSOCKET =====
wss.on('connection', ws => {
  console.log('[WS] Client connesso');
  // Invia stato iniziale
  if (state.lastPrice) {
    ws.send(JSON.stringify({
      type: 'init',
      prices: state.prices.slice(-80),
      balance: state.balance,
      trades: state.trades.slice(-15),
      logs: state.botLogs.slice(0, 12),
      dataSource: state.dataSource
    }));
  }

  ws.on('message', raw => {
    try {
      const msg = JSON.parse(raw);
      if (msg.action === 'pause') {
        state.paused = true;
        addLog('⏸️  Bot in pausa');
        broadcast({ type: 'paused', paused: true });
      } else if (msg.action === 'resume') {
        state.paused = false;
        addLog('▶️  Bot riattivato');
        broadcast({ type: 'paused', paused: false });
      } else if (msg.action === 'reset') {
        state.balance  = INITIAL_BALANCE;
        state.position = null;
        state.trades   = [];
        state.totalPnL = 0;
        state.wins     = 0;
        state.losses   = 0;
        state.prices   = [];
        state.startTime = Date.now();
        addLog('🔄 Bot resettato — budget: €50.00');
      }
    } catch (_) {}
  });
});

// ===== HTTP =====
app.get('/api/state', (_req, res) => res.json({
  balance:    state.balance,
  position:   state.position,
  totalPnL:   state.totalPnL,
  wins:       state.wins,
  losses:     state.losses,
  trades:     state.trades,
  logs:       state.botLogs,
  dataSource: state.dataSource
}));

// ===== AVVIO =====
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`\n🤖 Gold Trading Bot → http://localhost:${PORT}`);
  console.log(`   Budget iniziale: €${INITIAL_BALANCE} | Tick ogni ${TICK_INTERVAL_MS/1000}s\n`);
  addLog(`🚀 Bot avviato — budget: €${INITIAL_BALANCE.toFixed(2)}`);
  // Prima lettura prezzo reale
  updateRealPrice();
  // Avvio loop
  tradingTick();
  setInterval(tradingTick, TICK_INTERVAL_MS);
  setInterval(updateRealPrice, SCRAPE_INTERVAL_MS);
});
