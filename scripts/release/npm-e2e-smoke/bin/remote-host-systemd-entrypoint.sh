#!/usr/bin/env bash
set -euo pipefail

export DEBIAN_FRONTEND=noninteractive

remote_user="${REMOTE_USER:-happy}"
authorized_keys_src="${REMOTE_AUTHORIZED_KEYS_PATH:-/ssh/authorized_keys}"
shim_installer="${REMOTE_SHIM_HAPPIER_INSTALLER:-0}"

if ! id "$remote_user" >/dev/null 2>&1; then
  echo "[remote-host-systemd] missing user: $remote_user" >&2
  exit 1
fi

if [[ ! -f "$authorized_keys_src" ]]; then
  echo "[remote-host-systemd] missing authorized_keys at $authorized_keys_src" >&2
  exit 1
fi

if [[ "$shim_installer" == "1" ]]; then
  if [[ ! -d /usr/local/bin ]]; then
    mkdir -p /usr/local/bin
  fi

  if [[ ! -x /usr/bin/curl ]]; then
    echo "[remote-host-systemd] expected real curl at /usr/bin/curl" >&2
    exit 1
  fi

  cat > /usr/local/bin/curl <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

url=""
for a in "$@"; do
  case "$a" in
    http://*|https://*) url="$a" ;;
  esac
done

if [[ "$url" == "https://happier.dev/install" ]]; then
  cat <<'SCRIPT'
set -euo pipefail

if ! command -v npm >/dev/null 2>&1; then
  echo "[install-shim] missing npm on remote host" >&2
  exit 1
fi

if [[ ! -f /packs/cli.tgz ]]; then
  echo "[install-shim] missing /packs/cli.tgz (remote shim requires cli.tgz)" >&2
  exit 1
fi

prefix="$HOME/.happier/npm"
mkdir -p "$HOME/.happier/bin" "$prefix"
npm config set prefix "$prefix" >/dev/null

npm install -g /packs/cli.tgz >/dev/null

if [[ ! -x "$prefix/bin/happier" ]]; then
  echo "[install-shim] expected $prefix/bin/happier to exist after install" >&2
  exit 1
fi
ln -sf "$prefix/bin/happier" "$HOME/.happier/bin/happier"

if [[ -f /packs/stack.tgz ]]; then
  npm install -g /packs/stack.tgz >/dev/null
  if [[ -x "$prefix/bin/hstack" ]]; then
    ln -sf "$prefix/bin/hstack" "$HOME/.happier/bin/hstack"
  fi
fi

echo "[install-shim] ok"
SCRIPT
  exit 0
fi

exec /usr/bin/curl "$@"
EOF
  chmod 755 /usr/local/bin/curl
  echo "[remote-host-systemd] install shim enabled (curl override)"
fi

ssh_dir="/home/${remote_user}/.ssh"
install -d -m 700 -o "$remote_user" -g "$remote_user" "$ssh_dir"
install -m 600 -o "$remote_user" -g "$remote_user" "$authorized_keys_src" "${ssh_dir}/authorized_keys"

if ! [[ -f /etc/ssh/sshd_config ]]; then
  echo "[remote-host-systemd] missing sshd_config" >&2
  exit 1
fi

# Harden sshd and keep config deterministic for tests.
cp /etc/ssh/sshd_config /etc/ssh/sshd_config.bak
{
  echo 'Port 22'
  echo 'Protocol 2'
  echo 'UsePAM no'
  echo 'PasswordAuthentication no'
  echo 'KbdInteractiveAuthentication no'
  echo 'ChallengeResponseAuthentication no'
  echo 'PermitEmptyPasswords no'
  echo 'PermitRootLogin no'
  echo 'PubkeyAuthentication yes'
  echo "AllowUsers ${remote_user}"
  echo 'AuthorizedKeysFile .ssh/authorized_keys'
  echo 'AllowTcpForwarding yes'
  echo 'X11Forwarding no'
  echo 'PrintMotd no'
  echo 'Subsystem sftp /usr/lib/openssh/sftp-server'
} > /etc/ssh/sshd_config

ssh-keygen -A >/dev/null 2>&1 || true

# Ensure ssh starts on boot.
mkdir -p /etc/systemd/system/multi-user.target.wants
if [[ -f /lib/systemd/system/ssh.service ]]; then
  ln -sf /lib/systemd/system/ssh.service /etc/systemd/system/multi-user.target.wants/ssh.service
elif [[ -f /lib/systemd/system/sshd.service ]]; then
  ln -sf /lib/systemd/system/sshd.service /etc/systemd/system/multi-user.target.wants/sshd.service
else
  cat > /etc/systemd/system/sshd.service <<'UNIT'
[Unit]
Description=OpenSSH server daemon
After=network.target

[Service]
Type=simple
ExecStart=/usr/sbin/sshd -D -e
Restart=always

[Install]
WantedBy=multi-user.target
UNIT
  ln -sf /etc/systemd/system/sshd.service /etc/systemd/system/multi-user.target.wants/sshd.service
fi

echo "[remote-host-systemd] booting systemd (ssh ready for auth)"

exec /sbin/init

