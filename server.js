#!/usr/bin/env node
'use strict';

/**
 * Mini Router Panel - server.js
 * Panel manajemen "router OS" ringan untuk Android (Termux + Magisk).
 *
 * Tanpa root  : hanya /api/status yang berisi data (info sistem).
 * Dengan root : client list, traffic, adblock DNS, limit bandwidth,
 *               firewall / port forwarding ikut aktif.
 *
 * Jalankan: node server.js
 * Akses   : http://<ip-hotspot>:8080
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const VERSION = '0.1.0';
const BASE = __dirname;
const CONFIG_PATH = path.join(BASE, 'config.json');
const DATA_DIR = path.join(BASE, 'data');
const PUBLIC_DIR = path.join(BASE, 'public');
const TMP = '/tmp/opencode'; // dipakai hanya untuk file bantu sementara

const DEFAULT_CONFIG = {
  port: 8080,
  token: '',                       // kosong = tanpa auth (hanya untuk uji lokal)
  lan_iface: 'auto',               // interface AP, 'auto' = deteksi
  tether_ip: 'auto',               // IP gateway hotspot
  leases: '/data/misc/dhcp/dnsmasq.leases',
  dnsmasq_conf: '/data/data/com.termux/files/usr/etc/dnsmasq.d/router.conf',
  blocklist: '/data/data/com.termux/files/usr/etc/dnsmasq.d/block.conf',
  termux_prefix: '/data/data/com.termux/files/usr',
};

// ---------------------------------------------------------------- util

function sh(cmd, timeout = 8000) {
  try {
    const out = execSync(cmd, {
      timeout,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { ok: true, out: out.trim(), err: '' };
  } catch (e) {
    return {
      ok: false,
      out: (e.stdout || '').toString().trim(),
      err: (e.stderr || e.message || '').toString().trim(),
    };
  }
}

function rootSh(cmd, timeout = 8000) {
  // Termux + Magisk: `su -c "<cmd>"`. Absolute path agar tidak tertukar
  // dengan /usr/bin/su milik distro proot.
  const su = findSu();
  if (!su) return { ok: false, out: '', err: 'su tidak ditemukan (belum root)' };
  return sh(`${su} -c ${JSON.stringify(cmd)}`, timeout);
}

let _suCache = null;
function findSu() {
  if (_suCache !== null) return _suCache;
  const candidates = [
    '/data/data/com.termux/files/usr/bin/su',
    '/system/bin/su',
    '/debug_ramdisk/su',
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return (_suCache = c);
  }
  const r = sh('command -v su');
  _suCache = r.ok && r.out && r.out.startsWith('/') ? r.out : false;
  return _suCache;
}

let _rootCache = { at: 0, value: false };
function isRoot() {
  const now = Date.now();
  if (now - _rootCache.at < 15000) return _rootCache.value;
  const r = rootSh('id -u', 4000);
  const value = r.ok && r.out === '0';
  _rootCache = { at: now, value };
  return value;
}

function readSmart(p) {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch (e) {
    if (e.code === 'EACCES' || e.code === 'EPERM') {
      const r = rootSh(`cat ${p}`);
      return r.ok ? r.out : null;
    }
    return null;
  }
}

function prop(name) {
  const r = sh(`getprop ${name}`, 3000);
  return r.ok ? r.out : '';
}

function loadConfig() {
  let cfg = { ...DEFAULT_CONFIG };
  if (fs.existsSync(CONFIG_PATH)) {
    try { cfg = { ...cfg, ...JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) }; } catch {}
  } else {
    try { fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2)); } catch {}
  }
  return cfg;
}

function ensureDirs() {
  for (const d of [DATA_DIR, path.join(DATA_DIR, 'state')]) {
    if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
  }
}

function stateFile(name) { return path.join(DATA_DIR, 'state', name); }

function readState(name, fallback) {
  try { return JSON.parse(fs.readFileSync(stateFile(name), 'utf8')); }
  catch { return fallback; }
}

function writeState(name, obj) {
  ensureDirs();
  fs.writeFileSync(stateFile(name), JSON.stringify(obj, null, 2));
}

// ---------------------------------------------------------------- system info

function getMem() {
  const txt = fs.readFileSync('/proc/meminfo', 'utf8');
  const g = (k) => {
    const m = txt.match(new RegExp(`^${k}:\\s+(\\d+)`, 'm'));
    return m ? Math.round(Number(m[1]) / 1024) : 0;
  };
  return {
    total_mb: g('MemTotal'),
    avail_mb: g('MemAvailable'),
    free_mb: g('MemFree'),
    swap_total_mb: g('SwapTotal'),
    swap_free_mb: g('SwapFree'),
  };
}

function getThermal() {
  const dir = '/sys/class/thermal';
  const zones = [];
  let entries = [];
  try { entries = fs.readdirSync(dir).filter((e) => e.startsWith('thermal_zone')); } catch { return zones; }
  for (const z of entries) {
    let t = readSmart(path.join(dir, z, 'temp'));
    let type = readSmart(path.join(dir, z, 'type'));
    if (!t) continue;
    const c = Number(t) / 1000;
    if (!Number.isFinite(c) || c <= 0 || c > 200) continue;
    zones.push({ zone: z, type: (type || 'unknown').trim(), c: Math.round(c * 10) / 10 });
  }
  zones.sort((a, b) => b.c - a.c);
  return zones;
}

function getBattery() {
  const cap = readSmart('/sys/class/power_supply/battery/capacity');
  const status = readSmart('/sys/class/power_supply/battery/status');
  if (cap && !Number.isNaN(Number(cap))) {
    return { capacity: Number(cap), status: (status || '').trim() || null };
  }
  const d = rootSh('dumpsys battery', 5000);
  if (d.ok) {
    const c = (d.out.match(/level:\s*(\d+)/) || [])[1];
    const s = (d.out.match(/status:\s*(\d+)/) || [])[1];
    if (c) return { capacity: Number(c), status: s || null };
  }
  return null;
}

function getInterfaces() {
  const txt = readSmart('/proc/net/dev');
  if (!txt) return [];
  const rows = [];
  for (const line of txt.split('\n').slice(2)) {
    const m = line.trim().match(/^(\S+):\s*(.*)$/);
    if (!m) continue;
    const f = m[2].split(/\s+/).map(Number);
    if (f.length < 16) continue;
    rows.push({
      iface: m[1],
      rx_bytes: f[0],
      rx_packets: f[1],
      tx_bytes: f[8],
      tx_packets: f[9],
    });
  }
  return rows;
}

function detectLanIface() {
  const cfg = loadConfig();
  if (cfg.lan_iface && cfg.lan_iface !== 'auto') return cfg.lan_iface;
  const ifaces = getInterfaces().map((i) => i.iface);
  const prefer = ['ap0', 'swlan0', 'wlan1', 'ap1', 'softap0'];
  for (const p of prefer) if (ifaces.includes(p)) return p;
  return ifaces.find((i) => /^wlan\d/.test(i) && i !== 'wlan0') || null;
}

function detectTetherIp(lan) {
  const cfg = loadConfig();
  if (cfg.tether_ip && cfg.tether_ip !== 'auto') return cfg.tether_ip;
  if (!lan) return null;
  const r = rootSh(`ip -4 -o addr show dev ${lan}`);
  if (r.ok) {
    const m = r.out.match(/inet (\d+\.\d+\.\d+\.\d+)/);
    if (m) return m[1];
  }
  // fallback umum Android tethering
  return '192.168.43.1';
}

function systemStatus() {
  const zones = getThermal();
  const up = parseFloat((fs.readFileSync('/proc/uptime', 'utf8') || '0').split(' ')[0]);
  return {
    version: VERSION,
    time: new Date().toISOString(),
    root: isRoot(),
    uptime_s: Math.round(up),
    load: require('os').loadavg().map((n) => Math.round(n * 100) / 100),
    mem: getMem(),
    thermal_max_c: zones.length ? zones[0].c : null,
    thermal: zones.slice(0, 6),
    battery: getBattery(),
    device: {
      model: prop('ro.product.model'),
      device: prop('ro.product.device'),
      android: prop('ro.build.version.release'),
      build: prop('ro.build.display.id'),
      kernel_reported: prop('ro.kernel.version'),
      soc: prop('ro.board.platform'),
      bootloader_locked: prop('ro.boot.flash.locked') === '1',
    },
    lan_iface: detectLanIface(),
  };
}

// ---------------------------------------------------------------- clients

function parseArp() {
  const txt = readSmart('/proc/net/arp');
  if (txt === null) return null;
  const rows = [];
  for (const line of txt.split('\n').slice(1)) {
    const f = line.trim().split(/\s+/);
    if (f.length < 6) continue;
    if (f[3] === '00:00:00:00:00:00') continue;
    rows.push({ ip: f[0], mac: f[3].toLowerCase(), iface: f[5] });
  }
  return rows;
}

function parseLeases() {
  const cfg = loadConfig();
  const txt = readSmart(cfg.leases);
  if (txt === null) return null;
  const rows = [];
  for (const line of txt.split('\n')) {
    const f = line.trim().split(/\s+/);
    if (f.length < 4) continue;
    rows.push({ expires: Number(f[0]), mac: f[1].toLowerCase(), ip: f[2], hostname: f[3] === '*' ? '' : f[3] });
  }
  return rows;
}

function clients() {
  const lan = detectLanIface();
  const arp = parseArp();
  const leases = parseLeases();
  if (arp === null) {
    return {
      available: false,
      reason: 'Akses /proc/net/arp ditolak (butuh root).',
      hint: 'Setelah Magisk terpasang, panel akan otomatis bisa membaca daftar client.',
      clients: [],
    };
  }
  const leaseByMac = new Map((leases || []).map((l) => [l.mac, l]));
  const blocked = new Set(readState('blocked_ips.json', []));
  const list = arp
    .filter((a) => !lan || a.iface === lan)
    .map((a) => {
      const l = leaseByMac.get(a.mac);
      return {
        ip: a.ip,
        mac: a.mac,
        iface: a.iface,
        hostname: l ? l.hostname : '',
        lease_expires: l ? l.expires : null,
        blocked: blocked.has(a.ip),
      };
    })
    .sort((x, y) => x.ip.localeCompare(y.ip, undefined, { numeric: true }));
  return { available: true, lan_iface: lan, clients: list };
}

// ---------------------------------------------------------------- actions

function applyBlock(ip, blocked) {
  const iface = detectLanIface();
  if (!iface) return { ok: false, err: 'interface AP tidak terdeteksi' };
  if (blocked) {
    rootSh(`iptables -C FORWARD -i ${iface} -s ${ip} -j DROP 2>/dev/null || iptables -I FORWARD -i ${iface} -s ${ip} -j DROP`);
    rootSh(`iptables -C FORWARD -o ${iface} -d ${ip} -j DROP 2>/dev/null || iptables -I FORWARD -o ${iface} -d ${ip} -j DROP`);
  } else {
    rootSh(`iptables -D FORWARD -i ${iface} -s ${ip} -j DROP 2>/dev/null; iptables -D FORWARD -o ${iface} -d ${ip} -j DROP 2>/dev/null`);
  }
  const set = new Set(readState('blocked_ips.json', []));
  blocked ? set.add(ip) : set.delete(ip);
  writeState('blocked_ips.json', [...set]);
  return { ok: true, ip, blocked };
}

function applyLimit(ip, downKbps) {
  const iface = detectLanIface();
  if (!iface) return { ok: false, err: 'interface AP tidak terdeteksi' };
  const tc = tcBin();
  const down = readState('limits.json', {});
  if (!downKbps || downKbps <= 0) {
    // hapus filter untuk IP ini (rebuild seluruh qdisc agar bersih)
    delete down[ip];
    writeState('limits.json', down);
    return rebuildTc(iface, tc);
  }
  down[ip] = downKbps;
  writeState('limits.json', down);
  return rebuildTc(iface, tc);
}

function tcBin() {
  for (const p of ['/system/bin/tc', '/data/data/com.termux/files/usr/bin/tc', 'tc']) {
    if (p === 'tc' || fs.existsSync(p)) return p;
  }
  return 'tc';
}

function rebuildTc(iface, tc) {
  const limits = readState('limits.json', {});
  const cfg = loadConfig();
  const totalKbps = cfg.total_kbps || 200000; // 200 Mbps default ceiling
  const cmds = [
    `${tc} qdisc del dev ${iface} root 2>/dev/null`,
    `${tc} qdisc add dev ${iface} root handle 1: htb default 30`,
    `${tc} class add dev ${iface} parent 1: classid 1:1 htb rate ${totalKbps}kbit`,
    `${tc} class add dev ${iface} parent 1:1 classid 1:30 htb rate ${totalKbps}kbit ceil ${totalKbps}kbit`,
  ];
  let i = 10;
  for (const [ip, kbps] of Object.entries(limits)) {
    cmds.push(`${tc} class add dev ${iface} parent 1:1 classid 1:${i} htb rate ${kbps}kbit ceil ${kbps}kbit`);
    cmds.push(`${tc} filter add dev ${iface} parent 1: protocol ip prio 1 u32 match ip dst ${ip}/32 flowid 1:${i}`);
    i += 1;
  }
  const r = rootSh(cmds.join(' ; '), 15000);
  return r.ok
    ? { ok: true, applied: Object.keys(limits).length }
    : { ok: false, err: r.err || 'tc gagal', raw: r.out };
}

function dnsAdd(domain) {
  const cfg = loadConfig();
  const list = readState('dns_block.json', []);
  const d = domain.trim().toLowerCase();
  if (!d || !/^[a-z0-9.*-]+$/.test(d)) return { ok: false, err: 'domain tidak valid' };
  if (!list.includes(d)) list.push(d);
  writeState('dns_block.json', list);
  return dnsWrite(cfg);
}

function dnsRemove(domain) {
  const cfg = loadConfig();
  const list = readState('dns_block.json', []).filter((x) => x !== domain.toLowerCase());
  writeState('dns_block.json', list);
  return dnsWrite(cfg);
}

function dnsWrite(cfg) {
  const list = readState('dns_block.json', []);
  const body = [
    '# dibuat otomatis oleh mini-router panel',
    ...list.flatMap((d) => [`address=/${d}/0.0.0.0`, `address=/${d}/::`]),
    '',
  ].join('\n');
  try {
    fs.mkdirSync(path.dirname(cfg.blocklist), { recursive: true });
    fs.writeFileSync(cfg.blocklist, body);
  } catch {
    const r = rootSh(`mkdir -p ${path.dirname(cfg.blocklist)} && cat > ${cfg.blocklist} <<'EOF'\n${body}EOF`);
    if (!r.ok) return { ok: false, err: 'gagal menulis blocklist: ' + r.err };
  }
  rootSh('pkill -HUP dnsmasq 2>/dev/null || killall -HUP dnsmasq 2>/dev/null');
  return { ok: true, count: list.length, domains: list };
}

function portForwardAdd({ port, ip, dport }) {
  const iface = detectLanIface();
  if (!iface) return { ok: false, err: 'interface AP tidak terdeteksi' };
  const r = rootSh(
    `iptables -t nat -A PREROUTING -i ${iface} -p tcp --dport ${port} -j DNAT --to-destination ${ip}:${dport || port} && ` +
    `iptables -A FORWARD -i ${iface} -p tcp -d ${ip} --dport ${dport || port} -j ACCEPT`
  );
  if (!r.ok) return { ok: false, err: r.err };
  const list = readState('portforwards.json', []);
  list.push({ port: Number(port), ip, dport: Number(dport || port) });
  writeState('portforwards.json', list);
  return { ok: true, list };
}

function portForwardRemove({ port }) {
  const iface = detectLanIface();
  const list = readState('portforwards.json', []);
  const target = list.find((p) => p.port === Number(port));
  if (!target) return { ok: false, err: 'rule tidak ditemukan' };
  rootSh(`iptables -t nat -D PREROUTING -i ${iface} -p tcp --dport ${target.port} -j DNAT --to-destination ${target.ip}:${target.dport}`);
  writeState('portforwards.json', list.filter((p) => p.port !== Number(port)));
  return { ok: true };
}

// ---------------------------------------------------------------- http

function json(res, code, obj) {
  const body = JSON.stringify(obj, null, 2);
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve) => {
    let b = '';
    req.on('data', (c) => { b += c; if (b.length > 1e6) req.destroy(); });
    req.on('end', () => {
      try { resolve(JSON.parse(b || '{}')); } catch { resolve({}); }
    });
  });
}

const PUBLIC_FILES = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/index.html': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
};

const server = http.createServer(async (req, res) => {
  const cfg = loadConfig();
  const url = new URL(req.url, 'http://localhost');

  if (PUBLIC_FILES[url.pathname]) {
    const [file, type] = PUBLIC_FILES[url.pathname];
    try {
      const buf = fs.readFileSync(path.join(PUBLIC_DIR, file));
      res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' });
      return res.end(buf);
    } catch {
      return json(res, 404, { ok: false, err: 'file tidak ada' });
    }
  }

  if (!url.pathname.startsWith('/api/')) return json(res, 404, { ok: false, err: 'not found' });

  if (cfg.token) {
    const t = req.headers['x-token'] || url.searchParams.get('token');
    if (t !== cfg.token) return json(res, 401, { ok: false, err: 'token salah' });
  }

  try {
    if (url.pathname === '/api/status') return json(res, 200, systemStatus());

    if (url.pathname === '/api/clients') return json(res, 200, clients());

    if (url.pathname === '/api/traffic') {
      const ifaces = getInterfaces();
      if (!ifaces.length) {
        return json(res, 200, {
          available: false,
          reason: '/proc/net/dev tidak terbaca (butuh root).',
          interfaces: [],
        });
      }
      return json(res, 200, { available: true, interfaces: ifaces });
    }

    if (url.pathname === '/api/config') {
      return json(res, 200, {
        lan_iface: detectLanIface(),
        tether_ip: detectTetherIp(detectLanIface()),
        root: isRoot(),
        dns_blocked: readState('dns_block.json', []),
        portforwards: readState('portforwards.json', []),
        limits: readState('limits.json', {}),
        blocked_ips: readState('blocked_ips.json', []),
      });
    }

    if (req.method !== 'POST') return json(res, 405, { ok: false, err: 'method tidak didukung' });
    if (!isRoot()) return json(res, 403, { ok: false, err: 'butuh root (Magisk belum terpasang)' });

    const body = await readBody(req);

    if (url.pathname === '/api/block') return json(res, 200, applyBlock(body.ip, !!body.blocked));
    if (url.pathname === '/api/limit') return json(res, 200, applyLimit(body.ip, Number(body.down_kbps) || 0));
    if (url.pathname === '/api/dns') {
      return json(res, 200, body.action === 'remove' ? dnsRemove(body.domain) : dnsAdd(body.domain));
    }
    if (url.pathname === '/api/portforward') {
      return json(res, 200, body.action === 'remove' ? portForwardRemove(body) : portForwardAdd(body));
    }

    return json(res, 404, { ok: false, err: 'endpoint tidak ada' });
  } catch (e) {
    return json(res, 500, { ok: false, err: String(e && e.message ? e.message : e) });
  }
});

ensureDirs();
const conf = loadConfig();
server.listen(conf.port, '0.0.0.0', () => {
  console.log(`mini-router panel v${VERSION} -> http://0.0.0.0:${conf.port}`);
  console.log(`root: ${isRoot() ? 'ya' : 'belum'}`);
  try { fs.mkdirSync(TMP, { recursive: true }); } catch {}
});
