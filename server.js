/**
 * Sketch Mirror Server
 * Polls Sketch MCP for current selection, streams to mobile via WebSocket
 */

const https = require('https');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { WebSocketServer } = require('ws');
const os = require('os');
const { spawn } = require('child_process');

// ─── PNG Icon Generator (draws hexagon logo) ─────────────────────────────────
function generateIconPNG(size) {
  // PNG encode helpers
  const crcTable = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    crcTable[n] = c;
  }
  function crc32(buf) {
    let c = 0xFFFFFFFF;
    for (const b of buf) c = crcTable[(c ^ b) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }
  function chunk(type, data) {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const t = Buffer.from(type, 'ascii');
    const crcBuf = Buffer.alloc(4); crcBuf.writeUInt32BE(crc32(Buffer.concat([t, data])));
    return Buffer.concat([len, t, data, crcBuf]);
  }

  // Draw into RGBA pixel buffer
  const pixels = new Uint8Array(size * size * 4);
  const cx = size / 2, cy = size / 2;
  const R = size * 0.36; // hexagon radius
  const cr = size * 0.09; // inner circle radius
  const strokeW = size * 0.027;
  const dimStrokeW = size * 0.013;

  // Hexagon vertices (flat-top, rotated 90deg = pointy-top)
  const hex = [];
  for (let i = 0; i < 6; i++) {
    const a = Math.PI / 2 + i * Math.PI / 3;
    hex.push([cx + R * Math.cos(a), cy + R * Math.sin(a)]);
  }

  function setPixel(x, y, r, g, b, a) {
    x = Math.round(x); y = Math.round(y);
    if (x < 0 || x >= size || y < 0 || y >= size) return;
    const i = (y * size + x) * 4;
    const fa = a / 255, ea = pixels[i+3] / 255;
    const oa = fa + ea * (1 - fa);
    if (oa < 0.001) return;
    pixels[i]   = Math.round((r * fa + pixels[i]   * ea * (1-fa)) / oa);
    pixels[i+1] = Math.round((g * fa + pixels[i+1] * ea * (1-fa)) / oa);
    pixels[i+2] = Math.round((b * fa + pixels[i+2] * ea * (1-fa)) / oa);
    pixels[i+3] = Math.round(oa * 255);
  }

  function drawLine(x0, y0, x1, y1, r, g, b, a, w) {
    const dx = x1-x0, dy = y1-y0, len = Math.sqrt(dx*dx+dy*dy);
    const steps = Math.ceil(len * 2);
    const nx = -dy/len, ny = dx/len;
    for (let s = 0; s <= steps; s++) {
      const t = s/steps;
      const px = x0+dx*t, py = y0+dy*t;
      for (let ww = -w/2; ww <= w/2; ww += 0.5) {
        setPixel(px+nx*ww, py+ny*ww, r, g, b, a);
      }
    }
  }

  function drawCircle(cx, cy, r, thick, pr, pg, pb, pa) {
    const steps = Math.ceil(2 * Math.PI * r * 3);
    for (let s = 0; s <= steps; s++) {
      const a = s / steps * 2 * Math.PI;
      const px = cx + r * Math.cos(a), py = cy + r * Math.sin(a);
      for (let w = -thick/2; w <= thick/2; w += 0.5) {
        const nx = Math.cos(a), ny = Math.sin(a);
        setPixel(px+nx*w, py+ny*w, pr, pg, pb, pa);
      }
    }
  }

  // Background: #111
  for (let i = 0; i < size*size; i++) {
    pixels[i*4]=0x11; pixels[i*4+1]=0x11; pixels[i*4+2]=0x11; pixels[i*4+3]=255;
  }

  // Diagonal lines (dim)
  const da = Math.round(255 * 0.35);
  drawLine(hex[0][0],hex[0][1],hex[3][0],hex[3][1], 255,255,255,da, dimStrokeW);
  drawLine(hex[1][0],hex[1][1],hex[4][0],hex[4][1], 255,255,255,da, dimStrokeW);
  drawLine(hex[2][0],hex[2][1],hex[5][0],hex[5][1], 255,255,255,da, dimStrokeW);

  // Hexagon outline
  for (let i = 0; i < 6; i++) {
    const a = hex[i], b = hex[(i+1)%6];
    drawLine(a[0],a[1],b[0],b[1], 255,255,255,255, strokeW);
  }

  // Inner circle
  drawCircle(cx, cy, cr, strokeW*0.9, 255,255,255,255);

  // Pack RGBA → raw PNG filter bytes (RGBA mode)
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size,0); ihdr.writeUInt32BE(size,4);
  ihdr[8]=8; ihdr[9]=6; // RGBA
  const raw = Buffer.alloc(size*(1+size*4));
  for (let y=0;y<size;y++) {
    raw[y*(1+size*4)]=0;
    for (let x=0;x<size;x++) {
      const src=(y*size+x)*4, dst=y*(1+size*4)+1+x*4;
      raw[dst]=pixels[src]; raw[dst+1]=pixels[src+1];
      raw[dst+2]=pixels[src+2]; raw[dst+3]=pixels[src+3];
    }
  }
  return Buffer.concat([
    Buffer.from([137,80,78,71,13,10,26,10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw,{level:1})),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

function ensureIcons() {
  const pub = path.join(__dirname, 'public');
  const sizes = [[192, 'icon-192.png'], [512, 'icon-512.png']];
  for (const [sz, name] of sizes) {
    const p = path.join(pub, name);
    // Only generate if missing — don't overwrite custom icons
    if (!fs.existsSync(p)) fs.writeFileSync(p, generateIconPNG(sz));
  }
}
ensureIcons();

const PORT = 3000;
const POLL_INTERVAL = 1500; // ms
const MCP_BASE = 'http://localhost:31126';
const EXPORT_PATH = '/tmp/sketch-mirror-preview.png';
const FRAMES_DIR = '/tmp/sketch-mirror-frames';

// ─── MCP Client ──────────────────────────────────────────────────────────────

class SketchMCPClient {
  constructor() {
    this.messagesUrl = null;
    this.listeners = new Map();
    this.reqId = 0;
    this.sseProc = null;
    this.ready = false;
    this.onReconnect = null;
    this.everConnected = false; // only auto-reconnect after first successful init
  }

  connect() {
    return new Promise((resolve, reject) => {
      if (this.sseProc) {
        try { this.sseProc.kill(); } catch {}
      }

      this.ready = false;
      this.messagesUrl = null;

      this.sseProc = spawn('/usr/bin/curl', ['-sN', `${MCP_BASE}/sse`]);

      let buffer = '';

      this.sseProc.stdout.on('data', (chunk) => {
        buffer += chunk.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop();

        for (const line of lines) {
          const trimmed = line.trim();
          if (trimmed.startsWith('data: http')) {
            this.messagesUrl = trimmed.slice(6).trim();
          } else if (trimmed.startsWith('data:') && trimmed.length > 5) {
            try {
              const msg = JSON.parse(trimmed.slice(5).trim());
              const id = msg.id;
              if (id != null && this.listeners.has(id)) {
                const cb = this.listeners.get(id);
                this.listeners.delete(id);
                cb(null, msg);
              }
            } catch {}
          }
        }
      });

      this.sseProc.on('close', () => {
        this.ready = false;
        this.messagesUrl = null;
        // Cancel all pending requests immediately so they don't wait for timeout
        for (const [, cb] of this.listeners) cb(new Error('SSE disconnected'), null);
        this.listeners.clear();
        // Only auto-reconnect after we've had at least one successful connection
        if (this.everConnected) {
          process.stdout.write('\n[MCP] Connection dropped, reconnecting...\n');
          setTimeout(() => this._reconnect(), 2000);
        }
      });

      // Wait up to 5 seconds for messages URL
      const timer = setTimeout(() => reject(new Error('SSE connect timeout')), 5000);
      const check = setInterval(() => {
        if (this.messagesUrl) {
          clearInterval(check);
          clearTimeout(timer);
          resolve();
        }
      }, 100);
    });
  }

  async _reconnect() {
    try {
      await this.connect();
      await this.initialize();
      console.log('[MCP] Reconnected to Sketch');
      if (this.onReconnect) this.onReconnect();
    } catch (e) {
      console.log('[MCP] Reconnect failed, retrying...');
      setTimeout(() => this._reconnect(), 3000);
    }
  }

  _post(method, params, id) {
    return new Promise((resolve, reject) => {
      if (!this.messagesUrl) return reject(new Error('Not connected'));
      const body = JSON.stringify({ jsonrpc: '2.0', id: id ?? null, method, params: params || {} });
      const proc = spawn('/usr/bin/curl', [
        '-s', '-X', 'POST', this.messagesUrl,
        '-H', 'Content-Type: application/json',
        '-d', body
      ]);
      proc.on('close', (code) => code === 0 ? resolve() : reject(new Error(`curl exit ${code}`)));
      proc.on('error', reject);
    });
  }

  _waitFor(id, timeoutMs = 10000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.listeners.delete(id);
        reject(new Error(`Timeout for request ${id}`));
      }, timeoutMs);

      this.listeners.set(id, (err, msg) => {
        clearTimeout(timer);
        if (err) reject(err);
        else resolve(msg);
      });
    });
  }

  async initialize() {
    const id = ++this.reqId;
    const result = this._waitFor(id);
    await this._post('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'sketch-mirror', version: '1.0' }
    }, id);
    await result;
    await this._post('notifications/initialized', {}, null);
    this.ready = true;
    this.everConnected = true;
  }

  async callTool(name, args) {
    if (!this.ready) throw new Error('MCP not ready');
    const id = ++this.reqId;
    const result = this._waitFor(id, 60000); // 60s timeout for slow exports
    await this._post('tools/call', { name, arguments: args || {} }, id);
    return await result;
  }

  async exportSelectedFrame() {
    // Export at 3x to FRAMES_DIR (no filename = Sketch uses layer name@3x.png)
    const script = [
      "const sketch=require('sketch');",
      "const doc=sketch.getSelectedDocument();",
      "if(!doc){console.log('none');return;}",
      "const layers=doc.selectedLayers.layers;",
      "if(!layers||!layers.length){console.log('none');return;}",
      "let layer=layers[0];",
      "while(layer&&layer.type!=='Artboard'){layer=layer.parent;}",
      "if(!layer||layer.type!=='Artboard'){console.log('none');return;}",
      "const frames=doc.selectedPage.layers.filter(l=>l.type==='Artboard');",
      "const idx=frames.findIndex(f=>f.id===layer.id);",
      `sketch.export(layer,{output:'${FRAMES_DIR}',formats:['png'],scales:['3']});`,
      "console.log(layer.id+','+idx+','+frames.length+','+layer.name);"
    ].join('');

    const msg = await this.callTool('run_code', { script, title: 'export selected frame' });
    const content = msg?.result?.content;
    if (!Array.isArray(content)) return null;
    for (const item of content) {
      if (item.type === 'text' && item.text && !item.text.includes('none')) {
        return item.text.trim(); // "layerId,timestamp"
      }
    }
    return null;
  }
}

// ─── State ────────────────────────────────────────────────────────────────────

const mcp = new SketchMCPClient();
const wsClients = new Set();
let lastFileHash = null;
let lastImageB64 = null;
let pollInProgress = false;
let currentFrameInfo = null; // { index, total, name }

function fileHash(buf) {
  let h = 0x811c9dc5;
  const end = Math.min(buf.length, 8192);
  for (let i = 0; i < end; i++) {
    h ^= buf[i];
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

function broadcast(msg) {
  const data = JSON.stringify(msg);
  for (const ws of wsClients) {
    if (ws.readyState === 1) ws.send(data);
  }
}

// Ensure frames dir exists and is empty before each export
function clearFramesDir() {
  fs.rmSync(FRAMES_DIR, { recursive: true, force: true });
  fs.mkdirSync(FRAMES_DIR, { recursive: true });
}

// Recursively find the first PNG file (Sketch may export into subdirectories)
function findFirstPng(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const found = findFirstPng(full);
      if (found) return found;
    } else if (entry.name.toLowerCase().endsWith('.png')) {
      return full;
    }
  }
  return null;
}

async function poll() {
  if (pollInProgress) return; // Prevent concurrent polls
  pollInProgress = true;
  try {
    clearFramesDir();
    const token = await mcp.exportSelectedFrame();
    if (!token) {
      process.stdout.write('○'); // nothing selected
      if (lastImageB64) {
        lastImageB64 = null;
        lastFileHash = null;
        broadcast({ type: 'status', state: 'waiting' });
      }
      return;
    }

    // Find the exported file (Sketch names it "{layer}@3x.png")
    const pngFile = findFirstPng(FRAMES_DIR);
    if (!pngFile) {
      console.error('\n[poll] export produced no files');
      return;
    }
    const buf = fs.readFileSync(pngFile);
    const h = fileHash(buf);

    // Parse frame info from token: "id,idx,total,name"
    const parts = token.split(',');
    const frameInfo = parts.length >= 4
      ? { index: parseInt(parts[1]), total: parseInt(parts[2]), name: parts.slice(3).join(',') }
      : null;

    if (h !== lastFileHash) {
      lastFileHash = h;
      lastImageB64 = buf;
      currentFrameInfo = frameInfo;
      broadcast({ type: 'update', frameInfo });
      process.stdout.write('●');
    } else {
      currentFrameInfo = frameInfo;
      process.stdout.write('.');
    }
  } catch (e) {
    console.error('\n[poll error]', e.message);
  } finally {
    pollInProgress = false;
  }
}

// ─── Frame Navigation ────────────────────────────────────────────────────────

async function navigateFrame(delta) {
  if (pollInProgress) return;
  pollInProgress = true;
  try {
    const d = delta > 0 ? 1 : -1;
    const script = [
      "const sketch=require('sketch');",
      "const doc=sketch.getSelectedDocument();",
      "if(!doc){console.log('none');return;}",
      "const page=doc.selectedPage;",
      "const frames=page.layers.filter(l=>l.type==='Artboard');",
      "if(!frames.length){console.log('none');return;}",
      "const sel=doc.selectedLayers.layers;",
      "let cur=sel.length?sel[0]:null;",
      "while(cur&&cur.type!=='Artboard')cur=cur.parent;",
      "const curIdx=cur?frames.findIndex(f=>f.id===cur.id):-1;",
      `const nextIdx=(curIdx+${d}+frames.length)%frames.length;`,
      "const layer=frames[nextIdx];",
      "[...doc.selectedLayers.layers].forEach(l=>{try{l.selected=false;}catch(e){}});",
      "layer.selected=true;",
      `sketch.export(layer,{output:'${FRAMES_DIR}',formats:['png'],scales:['3']});`,
      "console.log(layer.id+','+nextIdx+','+frames.length+','+layer.name);"
    ].join('');

    clearFramesDir();
    const msg = await mcp.callTool('run_code', { script, title: 'navigate' });
    const content = msg?.result?.content;
    const text = Array.isArray(content)
      ? content.find(c => c.type === 'text')?.text?.trim() : null;
    if (!text || text === 'none') return;

    const parts = text.split(',');
    if (parts.length < 4) return;
    const frameInfo = { index: parseInt(parts[1]), total: parseInt(parts[2]), name: parts.slice(3).join(',') };

    const pngFile = findFirstPng(FRAMES_DIR);
    if (!pngFile) return;
    const buf = fs.readFileSync(pngFile);
    lastFileHash = fileHash(buf);
    lastImageB64 = buf;
    currentFrameInfo = frameInfo;
    broadcast({ type: 'update', frameInfo });
    process.stdout.write('\n[nav] ' + frameInfo.name + ' (' + (frameInfo.index + 1) + '/' + frameInfo.total + ')\n');
  } catch (e) {
    console.error('\n[nav error]', e.message);
  } finally {
    pollInProgress = false;
  }
}

// ─── HTTP Server ──────────────────────────────────────────────────────────────

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.json': 'application/json',
  '.svg':  'image/svg+xml',
  '.png':  'image/png',
  '.js':   'text/javascript',
  '.css':  'text/css',
};

const TAILSCALE = '/Applications/Tailscale.app/Contents/MacOS/Tailscale';

function getTailscaleDomain() {
  try {
    const { execSync } = require('child_process');
    const out = execSync(`"${TAILSCALE}" status --json 2>/dev/null`, { timeout: 5000 }).toString();
    const d = JSON.parse(out)?.Self?.DNSName;
    return d ? d.replace(/\.$/, '') : null;
  } catch { return null; }
}

function ensureCert(domain) {
  const crt = path.join(__dirname, `${domain}.crt`);
  const key = path.join(__dirname, `${domain}.key`);
  if (!fs.existsSync(crt) || !fs.existsSync(key)) {
    console.log(`Generating TLS cert for ${domain}…`);
    const { execSync } = require('child_process');
    execSync(`"${TAILSCALE}" cert --cert-file "${crt}" --key-file "${key}" "${domain}"`, { stdio: 'inherit' });
  }
  return { key: fs.readFileSync(key), cert: fs.readFileSync(crt) };
}

const CERT_NAME = getTailscaleDomain();
if (!CERT_NAME) {
  console.error('Tailscale is not connected. Please open Tailscale and connect first.');
  process.exit(1);
}
const tlsOpts = ensureCert(CERT_NAME);

const server = https.createServer(tlsOpts, (req, res) => {
  // Normalize URL: strip query string, default to index.html
  let urlPath = req.url.split('?')[0];

  // /snapshot — serve current frame as PNG with ETag for efficient polling
  if (urlPath === '/snapshot') {
    if (!lastImageB64) {
      res.writeHead(204); res.end(); return;
    }
    const etag = `"${lastFileHash}"`;
    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304); res.end(); return;
    }
    res.writeHead(200, {
      'Content-Type': 'image/png',
      'Cache-Control': 'no-cache, no-store',
      'ETag': etag,
      'Access-Control-Allow-Origin': '*',
    });
    res.end(lastImageB64);
    return;
  }

  // /preview — same as snapshot (for debug)
  if (urlPath === '/preview') {
    if (lastImageB64) {
      res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-cache' });
      res.end(lastImageB64);
    } else {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('No image captured yet.');
    }
    return;
  }

  if (urlPath === '/status') {
    const info = {
      mcpReady: mcp.ready,
      lastImageCaptured: !!lastImageB64,
      lastImageBytes: lastImageB64 ? lastImageB64.length : 0,
      wsClients: wsClients.size,
      pollInProgress,
    };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(info, null, 2));
    return;
  }

  if (urlPath === '/') urlPath = '/index.html';

  const filePath = path.join(__dirname, 'public', path.normalize(urlPath));
  const ext = path.extname(filePath);

  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': 'no-cache, no-store, must-revalidate',
    });
    res.end(data);
  });
});

// ─── WebSocket Server ─────────────────────────────────────────────────────────

const wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
  wsClients.add(ws);

  // Notify client of current state
  if (lastImageB64) {
    ws.send(JSON.stringify({ type: 'update', frameInfo: currentFrameInfo }));
  } else {
    ws.send(JSON.stringify({ type: 'status', state: 'waiting' }));
  }

  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      if (msg.type === 'refresh') {
        pollInProgress = false;
        poll();
      } else if (msg.type === 'next') {
        navigateFrame(1);
      } else if (msg.type === 'prev') {
        navigateFrame(-1);
      }
    } catch {}
  });

  ws.on('close', () => wsClients.delete(ws));
  ws.on('error', () => wsClients.delete(ws));
});

// ─── Start ────────────────────────────────────────────────────────────────────

function getLocalIP() {
  const ifaces = os.networkInterfaces();
  for (const list of Object.values(ifaces)) {
    for (const iface of list) {
      if (iface.family === 'IPv4' && !iface.internal) return iface.address;
    }
  }
  return 'localhost';
}

function getTailscaleIP() {
  const ifaces = os.networkInterfaces();
  for (const list of Object.values(ifaces)) {
    for (const iface of list) {
      // Tailscale uses 100.64.0.0/10 range
      if (iface.family === 'IPv4' && /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(iface.address)) {
        return iface.address;
      }
    }
  }
  return null;
}

// ─── QR Code (via qrcode package) ───────────────────────────────────────────

async function generateQR(text) {
  try {
    const QRCode = require('qrcode');
    return await QRCode.toString(text, { type: 'terminal', small: true });
  } catch(e) {
    return '';
  }
}

// Prevent crashes from unhandled promise rejections
process.on('uncaughtException', (e) => console.error('[uncaught]', e.message));
process.on('unhandledRejection', (e) => console.error('[unhandled]', e?.message || e));

async function main() {
  console.log('Connecting to Sketch MCP...');

  try {
    await mcp.connect();
    await mcp.initialize();
    console.log('Connected to Sketch MCP ✓');
  } catch (e) {
    console.error('Could not connect to Sketch MCP:', e.message);
    console.error('Make sure Sketch is open and the MCP plugin is running.');
    process.exit(1);
  }

  server.listen(PORT, '0.0.0.0', async () => {
    const ip = getLocalIP();
    const tsURL = `https://${CERT_NAME}:${PORT}`;
    const qr = await generateQR(tsURL);

    // Check for updates (non-blocking)
    const localVersion = require('./package.json').version;
    https.get('https://gist.githubusercontent.com/velyoo/15808e46ca37c6c250915e6388f23bd9/raw/version.json', res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const remote = JSON.parse(data).version;
          if (remote && remote !== localVersion) {
            console.log(`\n⚠️  发现新版本 ${remote}（当前 ${localVersion}），请向管理员获取最新安装包\n`);
          }
        } catch (_) {}
      });
    }).on('error', () => {});

    console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('  Sketch Mirror is running!');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log(`  Local:      https://localhost:${PORT}`);
    console.log(`  WiFi:       https://${ip}:${PORT}`);
    console.log(`  Tailscale:  ${tsURL}`);
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('  手机扫描下方二维码连接：');
    console.log(qr);
    console.log('  在 Sketch 中选择一个 Frame 即可开始预览');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
    console.log('Polling Sketch', { interval: `${POLL_INTERVAL}ms` });
  });

  // Start polling loop
  setInterval(poll, POLL_INTERVAL);

  // On reconnect, re-send last image to all clients
  mcp.onReconnect = () => {
    if (lastImageB64) broadcast({ type: 'update', image: lastImageB64 });
  };
}

main();
