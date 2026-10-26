# Mini Router Panel

Panel manajemen jaringan ala router OS untuk HP Android, berjalan di Termux.
Dirancang untuk Moto G45 5G (`fogos`, Android 15, kernel 5.4) yang dipakai
sebagai hotspot/router dari data seluler.

## Status fitur

| Fitur | Tanpa root | Dengan root (Magisk) |
|---|---|---|
| Info sistem (RAM, suhu, uptime, baterai) | ya | ya |
| Daftar client + hostname | tidak (SELinux blokir `/proc/net/arp`) | ya |
| Adblock / DNS filter semua client | tidak | ya (`dnsmasq` + redirect DNS) |
| Limit bandwidth per client | tidak | ya (`tc` HTB) |
| Blokir / buka client | tidak | ya (`iptables`) |
| Port forwarding | tidak | ya (`iptables` DNAT) |
| Monitoring trafik interface | tidak | ya (`/proc/net/dev`) |
| Panel web + API | ya | ya |

Tanpa root panel tetap jalan dan menampilkan alasan eksplisit pada fitur yang
tidak tersedia (tidak error diam-diam).

## Prasyarat

1. Termux (F-Droid atau GitHub, **bukan** Play Store) + Termux:Boot
2. Node.js: `pkg install nodejs`
3. Root: bootloader unlock + Magisk
4. Untuk fitur DNS/bandwidth: `pkg install dnsmasq iproute2`

## Pemasangan

```bash
# dari Termux
bash install-termux.sh

# jalankan panel
cd ~/mini-router && node server.js
```

Buka `http://<ip-hotspot>:8080` dari HP/laptop yang terhubung ke hotspot.
IP gateway default Android biasanya `192.168.43.1`.

## Mengaktifkan fitur router (butuh root)

```bash
su -c "bash ~/mini-router/scripts/router-init.sh"
```

Script ini:
- mendeteksi interface AP (`ap0`, `swlan0`, `wlan1`, …)
- menjalankan `dnsmasq` di port **5353** (tidak menabrak DHCP Android)
- me-redirect DNS client (53) ke dnsmasq tersebut → adblock berlaku
- menyiapkan qdisc HTB untuk limit bandwidth

## Arsitektur

```
client Wi-Fi
    │  DHCP + NAT: tethering Android (bawaan)
    ▼
  ap0 / swlan0
    │
    ├── dnsmasq :5353  ← blocklist, upstream 1.1.1.1
    ├── iptables       ← blokir client, port forward, DNAT DNS
    ├── tc HTB         ← limit per IP (match ip dst)
    └── panel :8080    ← Node.js, tanpa dependensi eksternal
```

## API

| Method | Endpoint | Fungsi |
|---|---|---|
| GET | `/api/status` | info sistem |
| GET | `/api/clients` | daftar client (ARP + lease) |
| GET | `/api/traffic` | counter per interface |
| GET | `/api/config` | blocklist, port forward, limit |
| POST | `/api/block` | `{ip, blocked}` |
| POST | `/api/limit` | `{ip, down_kbps}` |
| POST | `/api/dns` | `{domain, action: add|remove}` |
| POST | `/api/portforward` | `{port, ip, dport}` |

Autentikasi: header `x-token` (isi `token` di `config.json`). Kosong = terbuka,
hanya untuk uji lokal.

## Catatan penting

- **Jangan** jalankan `router-init.sh` berulang tanpa hotspot aktif — script
  akan berhenti sendiri jika interface AP tidak ditemukan.
- Panel ini **melengkapi** tethering Android, bukan menggantikannya. NAT dan
  DHCP tetap milik sistem; kita menambah DNS filtering, QoS, dan firewall.
- Throughput realistis 50–150 Mbps tergantung SoC dan kondisi radio.
- Untuk router 24/7: pakai charger + ventilasi, dan pertimbangkan dongle
  USB-C Ethernet sebagai WAN agar radio Wi-Fi tidak terbagi.

## Lisensi

MIT
