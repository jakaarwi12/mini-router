(() => {
  const $ = (s) => document.querySelector(s);
  const token = () => localStorage.getItem('mr_token') || '';

  async function api(path, opts = {}) {
    const res = await fetch(path, {
      ...opts,
      headers: {
        'content-type': 'application/json',
        'x-token': token(),
        ...(opts.headers || {}),
      },
    });
    let data = {};
    try { data = await res.json(); } catch {}
    if (!res.ok) throw new Error(data.err || `HTTP ${res.status}`);
    return data;
  }

  const fmtBytes = (n) => {
    if (!Number.isFinite(n)) return '–';
    const u = ['B', 'KB', 'MB', 'GB', 'TB'];
    let i = 0;
    while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
    return `${n.toFixed(i ? 1 : 0)} ${u[i]}`;
  };
  const fmtUp = (s) => {
    if (!Number.isFinite(s)) return '–';
    const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
    return d ? `${d}h ${h}j` : h ? `${h}j ${m}m` : `${m}m`;
  };
  const stat = (k, v, s = '') => `<div class="stat"><div class="k">${k}</div><div class="v">${v}</div>${s ? `<div class="s">${s}</div>` : ''}</div>`;

  async function loadStatus() {
    try {
      const d = await api('/api/status');
      $('#dev').textContent = `${d.device.model || 'Android'} · Android ${d.device.android || '?'} · kernel ${d.device.kernel_reported || '?'}`;
      const badge = $('#rootBadge');
      badge.textContent = d.root ? 'root aktif' : 'tanpa root';
      badge.className = 'badge ' + (d.root ? 'ok' : 'no');

      const memUsed = d.mem.total_mb - d.mem.avail_mb;
      const spanPct = d.mem.total_mb ? Math.round((memUsed / d.mem.total_mb) * 100) : 0;
      const batt = d.battery ? `${d.battery.capacity}%` : 'n/a';
      const battSub = d.battery && d.battery.status ? `status ${d.battery.status}` : 'tidak terbaca';

      $('#statusGrid').innerHTML = [
        stat('Uptime', fmtUp(d.uptime_s)),
        stat('RAM terpakai', `${memUsed} MB`, `${spanPct}% · sisa ${d.mem.avail_mb} MB`),
        stat('Swap/zram', `${d.mem.swap_total_mb} MB`, `bebas ${d.mem.swap_free_mb} MB`),
        stat('Suhu maks', d.thermal_max_c != null ? `${d.thermal_max_c} °C` : 'n/a', d.thermal?.[0]?.type || ''),
        stat('Load', d.load.join(' / '), d.lan_iface ? `AP: ${d.lan_iface}` : 'AP: ?'),
        stat('Baterai', batt, battSub),
      ].join('');
    } catch (e) {
      $('#statusGrid').innerHTML = `<div class="hint warn">${e.message}</div>`;
    }
  }

  async function loadClients() {
    const msg = $('#clientsMsg'), table = $('#clientsTable');
    try {
      const d = await api('/api/clients');
      if (!d.available) {
        msg.className = 'hint warn';
        msg.textContent = `${d.reason} ${d.hint || ''}`;
        table.hidden = true;
        return;
      }
      const rows = d.clients || [];
      msg.className = 'hint';
      msg.textContent = rows.length ? `${rows.length} client di ${d.lan_iface || 'AP'}` : 'Belum ada client terhubung.';
      table.hidden = rows.length === 0;
      table.querySelector('tbody').innerHTML = rows.map((c) => `
        <tr data-ip="${c.ip}">
          <td class="mono">${c.ip}</td>
          <td class="mono">${c.mac}</td>
          <td>${c.hostname || '<span class="mono">?</span>'}</td>
          <td>
            <button class="small ghost" data-act="limit">Batasi</button>
            <button class="small ${c.blocked ? 'danger' : 'ghost'}" data-act="block">${c.blocked ? 'Buka' : 'Blokir'}</button>
          </td>
        </tr>`).join('');
    } catch (e) {
      msg.className = 'hint warn';
      msg.textContent = e.message;
      table.hidden = true;
    }
  }

  async function loadConfig() {
    try {
      const d = await api('/api/config');
      const dns = $('#dnsList');
      dns.innerHTML = (d.dns_blocked || []).map((x) => `<span class="chip">${x}<button data-domain="${x}">×</button></span>`).join('') || '<div class="hint">Belum ada domain diblokir.</div>';

      const pf = $('#pfList');
      pf.innerHTML = (d.portforwards || []).map((p) => `<span class="chip">:${p.port} → ${p.ip}:${p.dport}<button data-port="${p.port}">×</button></span>`).join('') || '<div class="hint">Belum ada aturan port forwarding.</div>';
    } catch (e) {
      console.warn(e);
    }
  }

  async function loadTraffic() {
    const msg = $('#trafficMsg'), table = $('#trafficTable');
    try {
      const d = await api('/api/traffic');
      if (!d.available) {
        msg.className = 'hint warn';
        msg.textContent = d.reason;
        table.hidden = true;
        return;
      }
      msg.className = 'hint';
      msg.textContent = '';
      table.hidden = false;
      table.querySelector('tbody').innerHTML = d.interfaces.map((i) => `
        <tr><td class="mono">${i.iface}</td><td>${fmtBytes(i.rx_bytes)}</td><td>${fmtBytes(i.tx_bytes)}</td></tr>
      `).join('');
    } catch (e) {
      msg.className = 'hint warn';
      msg.textContent = e.message;
      table.hidden = true;
    }
  }

  document.addEventListener('click', async (ev) => {
    const btn = ev.target.closest('button');
    if (!btn) return;

    if (btn.dataset.domain) {
      await api('/api/dns', { method: 'POST', body: JSON.stringify({ action: 'remove', domain: btn.dataset.domain }) }).catch(alert);
      return loadConfig();
    }
    if (btn.dataset.port) {
      await api('/api/portforward', { method: 'POST', body: JSON.stringify({ action: 'remove', port: btn.dataset.port }) }).catch(alert);
      return loadConfig();
    }
    if (btn.dataset.act) {
      const ip = btn.closest('tr').dataset.ip;
      if (btn.dataset.act === 'block') {
        const nowBlocked = btn.textContent.trim() !== 'Buka';
        await api('/api/block', { method: 'POST', body: JSON.stringify({ ip, blocked: nowBlocked }) }).catch(alert);
      } else {
        const kbps = prompt(`Batas unduh untuk ${ip} (kbit/s, 0 = hapus):`, '2000');
        if (kbps === null) return;
        await api('/api/limit', { method: 'POST', body: JSON.stringify({ ip, down_kbps: Number(kbps) }) }).catch(alert);
      }
      return loadClients();
    }
  });

  $('#dnsForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const domain = $('#dnsDomain').value.trim();
    if (!domain) return;
    await api('/api/dns', { method: 'POST', body: JSON.stringify({ domain, action: 'add' }) }).catch(alert);
    $('#dnsDomain').value = '';
    loadConfig();
  });

  $('#pfForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const port = Number($('#pfPort').value);
    const ip = $('#pfIp').value.trim();
    const dport = Number($('#pfDport').value) || port;
    if (!port || !ip) return;
    await api('/api/portforward', { method: 'POST', body: JSON.stringify({ port, ip, dport }) }).catch(alert);
    $('#pfPort').value = ''; $('#pfIp').value = ''; $('#pfDport').value = '';
    loadConfig();
  });

  $('#tokenForm').addEventListener('submit', (e) => {
    e.preventDefault();
    localStorage.setItem('mr_token', $('#tokenInput').value.trim());
    location.reload();
  });

  $('#refreshClients').addEventListener('click', loadClients);
  $('#tokenInput').value = token();

  loadStatus();
  loadClients();
  loadConfig();
  loadTraffic();
  setInterval(loadStatus, 5000);
  setInterval(loadClients, 10000);
  setInterval(loadTraffic, 10000);
})();
