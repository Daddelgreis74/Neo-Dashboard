const https  = require('https');
const http   = require('http');
const fs     = require('fs');
const path   = require('path');
const os     = require('os');
const { execSync } = require('child_process');
const url    = require('url');
const Parser = require('rss-parser');
const cheerio= require('cheerio');

const parser = new Parser();
let newsCache = [];
let lastNewsFetch = 0;

let fuelCache = null;
let lastFuelFetch = 0;

const PORT           = process.env.PORT || 8443;
const DIR            = __dirname;
const TASMOTA_CONFIG = path.join(DIR, 'tasmota.json');
const CALENDAR_CONFIG= path.join(DIR, 'calendar.json');
const LAYOUT_CONFIG  = path.join(DIR, 'layout.json');
const NEWS_CONFIG    = path.join(DIR, 'news.json');

// Pfad zur Abfall-Kalender Datei (.ics)
const ICS_PATH       = process.env.ICS_PATH || '/home/daddelgreis74/abfall/Abfuhrkalender-Altenburg-2026.ics';
// Optional: Pfad zur OpenClaw sessions.json für den Kontext-Balken
// Wurde entfernt, da das Dashboard nun OpenClaw-unabhängig ist.

const DEFAULT_LAYOUT = {
  order:   ['weather','server','abfall','tasmota','calendar','fuel'],
  visible: { weather:true, server:true, abfall:true, tasmota:true, calendar:true, fuel:true }
};

const tlsOptions = {
  key:  fs.readFileSync(path.join(DIR, 'key.pem')),
  cert: fs.readFileSync(path.join(DIR, 'cert.pem'))
};

// ── Fuel Scraper ──────────────────────────────────────────
async function fetchFuelPrices(locationStr) {
  const loc = locationStr || '04600-altenburg';
  const now = Date.now();
  // Nutze ein Cache-Objekt pro Location
  if (!fuelCache) fuelCache = {};
  if (fuelCache[loc] && now - (fuelCache[loc].lastFetch || 0) < 15 * 60 * 1000) {
    return fuelCache[loc].data;
  }

  const urls = {
    diesel: `https://ich-tanke.de/tankstellen/diesel/umkreis/${loc}/`,
    e5: `https://ich-tanke.de/tankstellen/super-e5/umkreis/${loc}/`,
    e10: `https://ich-tanke.de/tankstellen/super-e10/umkreis/${loc}/`
  };

  const results = {};
  for (let [type, u] of Object.entries(urls)) {
    try {
      const res = await fetch(u, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' } });
      const html = await res.text();
      const $ = cheerio.load(html);
      let list = [];
      $('#search-result > ul > li').each((i, el) => {
        if(list.length >= 3) return;
        const name = $(el).find('.tankstelle h4 a').text().trim();
        let preisZahl = $(el).find('.preis1 .zahl').text().trim();
        const preisSup = $(el).find('.preis1 .zahl sup').text().trim();
        if (preisZahl && preisSup) {
          // Combine 2,11 and 9 to 2,119
          preisZahl = preisZahl.replace(preisSup, '') + preisSup;
        }
        let street = $(el).find('.tankstelle p').first().text().split('·')[0].trim();
        if (name && preisZahl) list.push({name, price: preisZahl, street});
      });
      results[type] = list;
    } catch(e) {
      console.error('Fuel fetch error for ' + type + ':', e.message);
      results[type] = [];
    }
  }

  fuelCache[loc] = { data: results, lastFetch: now };
  return results;
}

// ── ICS Parser ────────────────────────────────────────────
function parseICS() {
  try {
    const raw    = fs.readFileSync(ICS_PATH, 'utf8');
    const events = [];
    const blocks = raw.split('BEGIN:VEVENT');
    for (let i = 1; i < blocks.length; i++) {
      const block = blocks[i];
      const get   = key => { const m = block.match(new RegExp(key + '[^:]*:([^\r\n]+)')); return m ? m[1].trim() : null; };
      const summary = get('SUMMARY') || '';
      const dtraw   = get('DTSTART');
      if (!dtraw) continue;
      const digits  = dtraw.replace(/.*:(\d{8}).*/,'$1').replace(/^\d{8}T/,'').slice(0,8).replace(/[^\d]/g,'');
      const d8      = (dtraw.match(/(\d{8})/)||['',''])[1];
      const date    = d8 ? `${d8.slice(0,4)}-${d8.slice(4,6)}-${d8.slice(6,8)}` : null;
      if (!date) continue;
      const sl      = summary.toLowerCase();
      const type    = sl.includes('restm') ? 'restmuell'
                    : sl.includes('bio')   ? 'biotonne'
                    : sl.includes('papier')? 'papiertonne'
                    : sl.includes('gelb')  ? 'gelber_sack'
                    : sl.includes('schad') ? 'schadstoff'
                    : 'sonstig';
      events.push({ date, summary: summary.replace(/ in Altenburg$/, '').trim(), type });
    }
    events.sort((a, b) => a.date.localeCompare(b.date));
    return events;
  } catch (e) { return []; }
}

// ── Tasmota Config ────────────────────────────────────────
function loadTasmota() {
  try { return JSON.parse(fs.readFileSync(TASMOTA_CONFIG, 'utf8')); } catch { return { devices: [] }; }
}
function saveTasmota(data) { fs.writeFileSync(TASMOTA_CONFIG, JSON.stringify(data, null, 2)); }

// ── Layout Config ─────────────────────────────────────────
function loadLayout() {
  try {
    const cfg = JSON.parse(fs.readFileSync(LAYOUT_CONFIG, 'utf8'));
    cfg.order   = cfg.order   || DEFAULT_LAYOUT.order;
    cfg.visible = Object.assign({}, DEFAULT_LAYOUT.visible, cfg.visible || {});
    return cfg;
  } catch { return JSON.parse(JSON.stringify(DEFAULT_LAYOUT)); }
}
function saveLayout(data) { fs.writeFileSync(LAYOUT_CONFIG, JSON.stringify(data, null, 2)); }

// ── Calendar Config ───────────────────────────────────────
function loadCalendar() {
  try { return JSON.parse(fs.readFileSync(CALENDAR_CONFIG, 'utf8')); } catch { return []; }
}
function saveCalendar(data) { fs.writeFileSync(CALENDAR_CONFIG, JSON.stringify(data, null, 2)); }

// ── News Config ───────────────────────────────────────────
const DEFAULT_FEEDS = [
  { url: 'https://www.heise.de/rss/heise-atom.xml', source: 'heise online' },
  { url: 'https://stadt-bremerhaven.de/feed/', source: 'Caschys Blog' },
  { url: 'https://www.tagesschau.de/xml/rss2', source: 'Tagesschau' }
];
function loadNewsConfig() {
  try { return JSON.parse(fs.readFileSync(NEWS_CONFIG, 'utf8')); } catch { return DEFAULT_FEEDS; }
}
function saveNewsConfig(data) { fs.writeFileSync(NEWS_CONFIG, JSON.stringify(data, null, 2)); }

// ── Tasmota Proxy ─────────────────────────────────────────
function tasmotaRequest(ip, command, value, user, pass) {
  return new Promise((resolve, reject) => {
    let p = `/cm?cmnd=${encodeURIComponent(value !== undefined ? command + ' ' + value : command)}`;
    if (user && pass) p += `&user=${encodeURIComponent(user)}&password=${encodeURIComponent(pass)}`;
    const req = http.get({ hostname: ip, port: 80, path: p, timeout: 3000 }, res => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch { resolve({ raw: data }); } });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
  });
}

// ── Network Scanner ───────────────────────────────────────
function checkTasmota(ip) {
  return new Promise(resolve => {
    const req = http.get({ hostname: ip, port: 80, path: '/cm?cmnd=Status%200', timeout: 800 }, res => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        try {
          const j = JSON.parse(data);
          if (j.Status) {
            const fn = j.Status.FriendlyName;
            resolve({ ip, name: (Array.isArray(fn) ? fn[0] : fn) || ip, topic: j.Status.Topic || '' });
          } else resolve(null);
        } catch { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

function getLocalIp() {
  for (const nets of Object.values(os.networkInterfaces()))
    for (const n of nets)
      if (n.family === 'IPv4' && !n.internal) return n.address;
  return null;
}

// ── Server Stats ──────────────────────────────────────────
function formatGB(b) { return (b / 1024 / 1024 / 1024).toFixed(1); }

function getStats() {
  function cpu() {
    try {
      const rd = () => fs.readFileSync('/proc/stat','utf8').split('\n')[0].split(/\s+/).slice(1).map(Number);
      const s1 = rd(); const i1 = s1[3]+s1[4]; const t1 = s1.reduce((a,b)=>a+b,0);
      const ts = Date.now(); while (Date.now()-ts < 200) {}
      const s2 = rd(); const i2 = s2[3]+s2[4]; const t2 = s2.reduce((a,b)=>a+b,0);
      return Math.round((1-(i2-i1)/(t2-t1))*100);
    } catch { return 0; }
  }
  const tot = os.totalmem(), free = os.freemem(), used = tot - free;
  let swapTot = 0, swapFree = 0;
  try {
    const mi = fs.readFileSync('/proc/meminfo','utf8');
    const st = mi.match(/SwapTotal:\s+(\d+)/), sf = mi.match(/SwapFree:\s+(\d+)/);
    if (st) swapTot  = parseInt(st[1]) * 1024;
    if (sf) swapFree = parseInt(sf[1]) * 1024;
  } catch {}
  const up = os.uptime();
  const uptime = (Math.floor(up/86400)>0 ? Math.floor(up/86400)+'d ' : '')
              + Math.floor((up%86400)/3600)+'h '+Math.floor((up%3600)/60)+'m';
  const ip = getLocalIp() || '?';
  let temp = null;
  try { temp = (parseInt(fs.readFileSync('/sys/class/thermal/thermal_zone0/temp','utf8'))/1000).toFixed(1)+'°C'; } catch {}
  let procs = '?';
  try { procs = execSync('ps aux --no-headers | wc -l').toString().trim(); } catch {}
  let disks = [];
  try {
    execSync("df -BGB --output=source,target,size,used,avail,pcent -x tmpfs -x devtmpfs -x squashfs 2>/dev/null | tail -n +2")
      .toString().split('\n').filter(Boolean).forEach(line => {
        const p = line.trim().split(/\s+/);
        if (p.length >= 6) disks.push({ mount: p[1], totalGB: p[2].replace('GB',''), usedGB: p[3].replace('GB',''), percent: parseInt(p[5]) });
      });
  } catch {}
  return {
    cpu: { usage: cpu() },
    ram:  { total: tot, used, free, totalGB: formatGB(tot), usedGB: formatGB(used) },
    swap: { total: swapTot, used: swapTot-swapFree, free: swapFree, totalGB: formatGB(swapTot), usedGB: formatGB(swapTot-swapFree) },
    load: os.loadavg().map(l => l.toFixed(2)),
    uptime, hostname: os.hostname(), ip, temp, processes: procs, disks
  };
}

// ── News Parser ───────────────────────────────────────────
async function fetchNews() {
  const now = Date.now();
  if (now - lastNewsFetch < 15 * 60 * 1000 && newsCache.length > 0) return newsCache;

  const feeds = loadNewsConfig();

  let allNews = [];
  for (const feed of feeds) {
    try {
      const parsed = await parser.parseURL(feed.url);
      const items = parsed.items.slice(0, 3).map(item => ({
        title: item.title,
        link: item.link,
        source: feed.source,
        date: new Date(item.pubDate || item.isoDate).getTime(),
        snippet: item.contentSnippet || item.summary || ''
      }));
      allNews = allNews.concat(items);
    } catch (e) {
      console.warn('News fetch error for ' + feed.source, e.message);
    }
  }

  // Sort by newest
  allNews.sort((a, b) => b.date - a.date);
  newsCache = allNews.slice(0, 6); // Keep the 6 newest items overall
  lastNewsFetch = now;
  return newsCache;
}

// ── Request Router ────────────────────────────────────────
async function handleRequest(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  const { pathname } = url.parse(req.url, true);

  if (pathname === '/api/fuel' && req.method === 'GET') {
    try {
      const loc = url.parse(req.url, true).query.loc || '04600-altenburg';
      const data = await fetchFuelPrices(loc);
      res.writeHead(200, {'Content-Type':'application/json'});
      res.end(JSON.stringify(data));
    } catch (e) {
      res.writeHead(500, {'Content-Type':'application/json'});
      res.end(JSON.stringify({error: e.message}));
    }
    return;
  }

  if (pathname === '/api/stats' && req.method === 'GET') {
    res.writeHead(200, {'Content-Type':'application/json'});
    res.end(JSON.stringify(getStats())); return;
  }

  if (pathname === '/api/abfall' && req.method === 'GET') {
    if (!fs.existsSync(ICS_PATH)) {
      res.writeHead(200, {'Content-Type':'application/json'});
      res.end(JSON.stringify({ error: 'NO_FILE' }));
      return;
    }
    res.writeHead(200, {'Content-Type':'application/json'});
    res.end(JSON.stringify(parseICS())); return;
  }

  // --- ICS UPLOAD ---
  if (pathname === '/api/upload-ics' && req.method === 'POST') {
    let body = Buffer.alloc(0);
    req.on('data', chunk => { body = Buffer.concat([body, chunk]); });
    req.on('end', () => {
      // Basic multipart/form-data parsing
      const dataStr = body.toString('binary');
      const boundaryMatch = dataStr.match(/--[^\r\n]+/);
      if (!boundaryMatch) {
         res.writeHead(400); res.end('Invalid upload format'); return;
      }
      const boundary = boundaryMatch[0];
      const parts = dataStr.split(boundary);
      let fileData = null;
      
      for (let p of parts) {
        if (p.includes('filename=')) {
           const headerEnd = p.indexOf('\r\n\r\n');
           if (headerEnd !== -1) {
             fileData = p.substring(headerEnd + 4, p.length - 2); 
             break;
           }
        }
      }

      if (fileData) {
        fs.writeFileSync(ICS_PATH, fileData, 'binary');
        res.writeHead(200, {'Content-Type':'application/json'});
        res.end(JSON.stringify({ ok: true }));
      } else {
        res.writeHead(400); res.end('No file found');
      }
    });
    return;
  }

  if (pathname === '/api/layout' && req.method === 'GET') {
    res.writeHead(200, {'Content-Type':'application/json'});
    res.end(JSON.stringify(loadLayout())); return;
  }

  if (pathname === '/api/layout' && req.method === 'POST') {
    let body = ''; req.on('data', d => body += d);
    req.on('end', () => {
      try { saveLayout(JSON.parse(body)); res.writeHead(200, {'Content-Type':'application/json'}); res.end(JSON.stringify({ok:true})); }
      catch(e) { res.writeHead(400); res.end(JSON.stringify({error:e.message})); }
    }); return;
  }

  if (pathname === '/api/scan' && req.method === 'GET') {
    res.writeHead(200, {'Content-Type':'text/event-stream','Cache-Control':'no-cache','Connection':'keep-alive'});
    const localIp = getLocalIp();
    if (!localIp) { res.write('data: {"error":"Kein Interface"}\n\ndata: {"done":true}\n\n'); res.end(); return; }
    const subnet = localIp.split('.').slice(0,3).join('.');
    res.write(`data: ${JSON.stringify({scanning:`${subnet}.0/24`})}\n\n`);
    let found = 0;
    await Promise.all(Array.from({length:254},(_,i)=>i+1).map(i =>
      checkTasmota(`${subnet}.${i}`).then(r => {
        if (r && !res.writableEnded) { found++; res.write(`data: ${JSON.stringify({found:r})}\n\n`); }
      }).catch(()=>{})
    ));
    if (!res.writableEnded) { res.write(`data: ${JSON.stringify({done:true,total:found})}\n\n`); res.end(); }
    return;
  }

  if (pathname === '/api/tasmota/devices' && req.method === 'GET') {
    res.writeHead(200, {'Content-Type':'application/json'});
    res.end(JSON.stringify(loadTasmota())); return;
  }

  if (pathname === '/api/tasmota/devices' && req.method === 'POST') {
    let body = ''; req.on('data', d => body += d);
    req.on('end', () => {
      try {
        const dev = JSON.parse(body);
        if (!dev.ip || !dev.name) { res.writeHead(400); res.end(JSON.stringify({error:'ip + name required'})); return; }
        const cfg = loadTasmota();
        dev.id = Date.now().toString(); dev.channels = dev.channels || 1;
        cfg.devices.push(dev); saveTasmota(cfg);
        res.writeHead(200, {'Content-Type':'application/json'}); res.end(JSON.stringify({ok:true,device:dev}));
      } catch(e) { res.writeHead(400); res.end(JSON.stringify({error:e.message})); }
    }); return;
  }

  if (pathname.match(/^\/api\/tasmota\/devices\/[^/]+$/) && req.method === 'DELETE') {
    const id = pathname.split('/').pop();
    const cfg = loadTasmota(); cfg.devices = cfg.devices.filter(d => d.id !== id); saveTasmota(cfg);
    res.writeHead(200, {'Content-Type':'application/json'}); res.end(JSON.stringify({ok:true})); return;
  }

  if (pathname === '/api/tasmota/cmd' && req.method === 'POST') {
    let body = ''; req.on('data', d => body += d);
    req.on('end', async () => {
      try {
        const {ip,command,value,user,pass} = JSON.parse(body);
        const result = await tasmotaRequest(ip, command, value, user, pass);
        res.writeHead(200, {'Content-Type':'application/json'}); res.end(JSON.stringify(result));
      } catch(e) { res.writeHead(200, {'Content-Type':'application/json'}); res.end(JSON.stringify({error:e.message})); }
    }); return;
  }

  if (pathname === '/api/calendar' && req.method === 'GET') {
    res.writeHead(200, {'Content-Type':'application/json'});
    res.end(JSON.stringify(loadCalendar())); return;
  }

  if (pathname === '/api/news/config' && req.method === 'GET') {
    res.writeHead(200, {'Content-Type':'application/json'});
    res.end(JSON.stringify(loadNewsConfig())); return;
  }

  if (pathname === '/api/news/config' && req.method === 'POST') {
    let body = ''; req.on('data', d => body += d);
    req.on('end', () => {
      try {
        const list = JSON.parse(body);
        saveNewsConfig(list);
        lastNewsFetch = 0; // force refresh
        res.writeHead(200, {'Content-Type':'application/json'}); res.end(JSON.stringify({success:true}));
      } catch(e) {
        res.writeHead(400, {'Content-Type':'application/json'}); res.end(JSON.stringify({error:e.message}));
      }
    }); return;
  }

  if (pathname === '/api/calendar' && req.method === 'POST') {
    let body = ''; req.on('data', d => body += d);
    req.on('end', () => {
      try {
        const item = JSON.parse(body);
        if (!item.title || !item.date) throw new Error('Missing title or date');
        item.id = Date.now().toString();
        const cal = loadCalendar();
        cal.push(item);
        saveCalendar(cal);
        res.writeHead(200, {'Content-Type':'application/json'}); res.end(JSON.stringify({ok:true, item}));
      } catch(e) { res.writeHead(400); res.end(JSON.stringify({error:e.message})); }
    }); return;
  }

  if (pathname.match(/^\/api\/calendar\/[^/]+$/) && req.method === 'DELETE') {
    const id = pathname.split('/').pop();
    const cal = loadCalendar();
    saveCalendar(cal.filter(c => c.id !== id));
    res.writeHead(200, {'Content-Type':'application/json'}); res.end(JSON.stringify({ok:true})); return;
  }

  // --- NEWS API ---
  if (pathname === '/api/news' && req.method === 'GET') {
    res.writeHead(200, {'Content-Type':'application/json'});
    fetchNews().then(news => res.end(JSON.stringify(news))).catch(e => res.end(JSON.stringify([])));
    return;
  }

  // Static files
  const filePath = path.join(DIR, pathname === '/' ? 'index.html' : pathname.slice(1));
  if (!filePath.startsWith(DIR)) { res.writeHead(403); res.end(); return; }
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    const mime = {'.html':'text/html','.css':'text/css','.js':'application/javascript','.json':'application/json','.png':'image/png','.jpg':'image/jpeg','.svg':'image/svg+xml'};
    res.writeHead(200, {'Content-Type': mime[path.extname(filePath)] || 'text/plain'});
    res.end(data);
  });
}

const server = https.createServer(tlsOptions, (req, res) => {
  handleRequest(req, res).catch(e => {
    if (!res.writableEnded) { res.writeHead(500, {'Content-Type':'application/json'}); res.end(JSON.stringify({error:e.message})); }
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ Neo Dashboard → https://192.168.178.101:${PORT}`);
});
