#!/data/data/com.termux/files/usr/bin/bash
#
# install-termux.sh - pasang panel mini-router di Termux (tanpa root).
# Jalankan DARI TERMUX (bukan dari proot Ubuntu):
#   bash install-termux.sh
#
# Setelah root (Magisk) aktif, jalankan scripts/router-init.sh sebagai root.

set -e
SRC_DIR="$(cd "$(dirname "$0")/.." && pwd)"
DEST="$HOME/mini-router"

echo "[1/4] menyalin panel ke $DEST"
mkdir -p "$DEST"
cp -r "$SRC_DIR/server.js" "$SRC_DIR/public" "$SRC_DIR/scripts" "$DEST/"
[ -f "$SRC_DIR/config.json" ] && cp "$SRC_DIR/config.json" "$DEST/" || true

echo "[2/4] cek dependensi"
command -v node >/dev/null 2>&1 || { echo "node belum ada. Jalankan: pkg install nodejs"; exit 1; }
command -v dnsmasq >/dev/null 2>&1 || echo "  petunjuk: pkg install dnsmasq (untuk adblock DNS)"
command -v tc >/dev/null 2>&1 || echo "  petunjuk: pkg install iproute2 (untuk limit bandwidth)"

echo "[3/4] membuat config default"
node -e "
const fs=require('fs'),p='$DEST/config.json';
if(!fs.existsSync(p)){
  fs.writeFileSync(p, JSON.stringify({port:8080,token:'',lan_iface:'auto',tether_ip:'auto'},null,2));
  console.log('  config.json dibuat (token kosong = tanpa auth)');
} else { console.log('  config.json sudah ada, dibiarkan'); }
"

echo "[4/4] menyiapkan autostart (Termux:Boot)"
BOOT="$HOME/.termux/boot"
mkdir -p "$BOOT"
cat > "$BOOT/mini-router" <<EOF
#!/data/data/com.termux/files/usr/bin/sh
termux-wake-lock
cd $DEST && nohup node server.js >> \$HOME/mini-router.log 2>&1 &
EOF
chmod +x "$BOOT/mini-router"

echo
echo "Selesai."
echo "  Jalankan manual : cd $DEST && node server.js"
echo "  Panel           : http://<ip-hotspot>:8080"
echo "  Setelah root    : su -c 'bash $DEST/scripts/router-init.sh'"
