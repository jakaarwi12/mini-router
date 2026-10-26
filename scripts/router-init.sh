#!/data/data/com.termux/files/usr/bin/bash
#
# router-init.sh - menyiapkan fitur "router" di atas tethering Android.
# Jalankan sebagai ROOT setelah hotspot aktif:
#   su -c "bash ~/mini-router/scripts/router-init.sh"
#
# Yang dilakukan:
#   1. deteksi interface AP + IP gateway
#   2. jalankan dnsmasq khusus (port 5353) dengan blocklist
#   3. redirect DNS client (port 53) ke dnsmasq kita
#   4. siapkan qdisc HTB untuk limit bandwidth
#
# Aman dijalankan berulang (idempotent). Tidak menyentuh DHCP Android.

set -u
PREFIX=/data/data/com.termux/files/usr
PANEL_DIR="$PREFIX/../home/mini-router"
[ -d "$PANEL_DIR" ] || PANEL_DIR="$HOME/mini-router"
DNSMASQ_DIR="$PREFIX/etc/dnsmasq.d"
LEASES=/data/misc/dhcp/dnsmasq.leases

log() { echo "[router-init] $*"; }

# --- 1. deteksi interface AP ---------------------------------------------
LAN="${LAN_IFACE:-}"
if [ -z "$LAN" ]; then
  LAN=$(ip -o link show 2>/dev/null | awk -F': ' '{print $2}' | grep -E '^(ap[0-9]|swlan[0-9]|softap[0-9]|wlan1)$' | head -n1)
fi
if [ -z "$LAN" ]; then
  log "interface AP tidak ditemukan. Nyalakan hotspot dulu."
  exit 1
fi

TETHER_IP="${TETHER_IP:-}"
if [ -z "$TETHER_IP" ]; then
  TETHER_IP=$(ip -4 -o addr show dev "$LAN" 2>/dev/null | awk '{print $4}' | cut -d/ -f1 | head -n1)
fi
[ -n "$TETHER_IP" ] || TETHER_IP=192.168.43.1

log "AP=$LAN  gateway=$TETHER_IP"

# --- 2. dnsmasq filter ----------------------------------------------------
mkdir -p "$DNSMASQ_DIR"
BLOCK="$DNSMASQ_DIR/router-block.conf"
[ -f "$BLOCK" ] || printf '# blocklist mini-router\n' > "$BLOCK"

CONF="$DNSMASQ_DIR/router-dns.conf"
cat > "$CONF" <<EOF
# dibuat oleh mini-router
port=5353
bind-interfaces
listen-address=127.0.0.1
listen-address=$TETHER_IP
no-resolv
server=1.1.1.1
server=8.8.8.8
cache-size=2000
no-hosts
log-queries
log-facility=/data/local/tmp/dnsmasq-router.log
conf-file=$BLOCK
EOF

pkill -f "dnsmasq.*router-dns.conf" 2>/dev/null
sleep 0.3
if command -v dnsmasq >/dev/null 2>&1; then
  dnsmasq --conf-file="$CONF" || log "dnsmasq gagal start (cek port 5353)"
else
  log "dnsmasq belum terpasang: pkg install dnsmasq"
fi

# --- 3. redirect DNS client ----------------------------------------------
iptables -t nat -N MR_DNS 2>/dev/null || true
iptables -t nat -F MR_DNS
iptables -t nat -A MR_DNS -p udp --dport 53 -j DNAT --to-destination "$TETHER_IP:5353"
iptables -t nat -A MR_DNS -p tcp --dport 53 -j DNAT --to-destination "$TETHER_IP:5353"
iptables -t nat -C PREROUTING -i "$LAN" -j MR_DNS 2>/dev/null || \
  iptables -t nat -I PREROUTING -i "$LAN" -j MR_DNS
iptables -C INPUT -i "$LAN" -p udp --dport 5353 -j ACCEPT 2>/dev/null || \
  iptables -I INPUT -i "$LAN" -p udp --dport 5353 -j ACCEPT
iptables -C INPUT -i "$LAN" -p tcp --dport 5353 -j ACCEPT 2>/dev/null || \
  iptables -I INPUT -i "$LAN" -p tcp --dport 5353 -j ACCEPT

# --- 4. qdisc untuk limit bandwidth --------------------------------------
TC=$(command -v tc || echo /system/bin/tc)
if [ -x "$TC" ]; then
  "$TC" qdisc show dev "$LAN" | grep -q htb || {
    "$TC" qdisc add dev "$LAN" root handle 1: htb default 30 && \
    "$TC" class add dev "$LAN" parent 1: classid 1:1 htb rate 200000kbit && \
    "$TC" class add dev "$LAN" parent 1:1 classid 1:30 htb rate 200000kbit
  }
else
  log "tc tidak tersedia (pkg install iproute2)"
fi

# --- 5. panel ------------------------------------------------------------
log "selesai. Panel: http://$TETHER_IP:8080"
log "lease DHCP Android: $LEASES"
