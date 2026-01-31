#!/usr/bin/env bash
set -euo pipefail

# Provision a fresh Ubuntu VM for running happy-local's `review-pr` end-to-end.
# Intended for Apple Silicon users running Ubuntu ARM64 via Lima/UTM.
#
# This installs:
# - Node (via nvm)
# - corepack (yarn/pnpm shims)
# - basic build tooling for native deps used by Expo/React Native ecosystem
# - a few common CLI utilities used in developer workflows (zip/unzip/jq/rsync)

if [[ "$(uname -s)" != "Linux" ]]; then
  echo "[provision] expected Linux; got: $(uname -s)" >&2
  exit 1
fi

export DEBIAN_FRONTEND=noninteractive

echo "[provision] installing apt dependencies..."
sudo apt-get update -y
sudo apt-get install -y \
  ca-certificates \
  curl \
  git \
  build-essential \
  python3 \
  pkg-config \
  unzip \
  zip \
  jq \
  rsync

echo "[provision] tuning Linux file watcher limits (Expo/Metro)..."
# Expo/Metro can exhaust default inotify watcher limits on fresh VMs (ENOSPC).
# Raise the limits and persist them across reboots.
sudo tee /etc/sysctl.d/99-happy-stacks.conf >/dev/null <<'EOF'
fs.inotify.max_user_watches=1048576
fs.inotify.max_user_instances=1024
EOF
sudo sysctl --system >/dev/null 2>&1 || true

echo "[provision] (optional) installing watchman (improves Metro watcher performance when available)..."
if sudo apt-get install -y watchman >/dev/null 2>&1; then
  echo "[provision] watchman installed"
else
  echo "[provision] watchman not available via apt (skipping)"
fi

echo "[provision] installing nvm + Node..."
export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
if [[ ! -s "$NVM_DIR/nvm.sh" ]]; then
  mkdir -p "$NVM_DIR"
  curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash
fi

# shellcheck disable=SC1090
source "$NVM_DIR/nvm.sh"

# Use the current Node.js LTS by default.
# Override if needed: `NODE_VERSION=24 ...` (or any version supported by nvm).
# (As of 2026-01-24, the current LTS line is 24.x.)
NODE_VERSION="${NODE_VERSION:-lts/*}"
nvm install "$NODE_VERSION"
nvm use "$NODE_VERSION"

echo "[provision] enabling corepack..."
corepack enable >/dev/null 2>&1 || true
# Pre-activate common package managers so first-run installs are smoother.
# (Yarn classic is used by the slopus/happy monorepo today.)
corepack prepare yarn@1.22.22 --activate >/dev/null 2>&1 || true
corepack prepare pnpm@latest --activate >/dev/null 2>&1 || true

echo "[provision] configuring happy-stacks VM defaults (ports)..."
# When port-forwarding a VM to the macOS host, it's convenient to avoid using the host's default ports (3005/8081).
# Persist these as happy-stacks *home* defaults so non-sandbox `happys ...` commands pick them up automatically.
#
# NOTE: `npx happy-stacks review-pr ...` runs in a fully isolated sandbox (separate HOME), so it will NOT read
# this file by default. For review-pr in a VM, pass `--vm-ports` (or explicit `--stack-port-start=...`) to
# force the port ranges inside the sandbox.
HS_HOME="${HOME}/.happy-stacks"
mkdir -p "$HS_HOME"
ENV_LOCAL="${HS_HOME}/env.local"
MARK_BEGIN="# --- happy-stacks-vm defaults (added by provision script) ---"
MARK_END="# --- /happy-stacks-vm defaults ---"
if ! grep -qF "$MARK_BEGIN" "$ENV_LOCAL" 2>/dev/null; then
  cat >>"$ENV_LOCAL" <<'EOF'

# --- happy-stacks-vm defaults (added by provision script) ---
# Server port selection for stacks (affects `happys stack new ...` defaults, including main).
HAPPY_STACKS_STACK_PORT_START=13005

# Expo dev-server (web) ports for stacks (avoid 8081; keep stable per stack).
HAPPY_STACKS_EXPO_DEV_PORT_STRATEGY=stable
HAPPY_STACKS_EXPO_DEV_PORT_BASE=18081
HAPPY_STACKS_EXPO_DEV_PORT_RANGE=1000

# Optional: set a preferred bind mode for VM usage.
# - loopback: prefer localhost-only URLs (best for port-forwarded VM usage; not reachable from phones)
# - lan: prefer LAN URLs (best for phones on same network)
# HAPPY_STACKS_BIND_MODE=loopback
# --- /happy-stacks-vm defaults ---
EOF
fi

echo "[provision] done."
echo "[provision] Node: $(node --version)"
echo "[provision] npm:  $(npm --version)"
echo "[provision] git:  $(git --version)"

# Helpful for VM workflows: show a best-effort LAN IP (useful with Lima `--network vzNAT`).
if command -v hostname >/dev/null 2>&1; then
  IPS_RAW="$(hostname -I 2>/dev/null || true)"
  if [[ -n "${IPS_RAW// }" ]]; then
    echo "[provision] VM IPs: ${IPS_RAW}"
    VM_IP="$(echo "$IPS_RAW" | tr ' ' '\n' | grep -E '^[0-9]+\.' | grep -v '^127\.' | head -n1 || true)"
    if [[ -n "${VM_IP:-}" ]]; then
      echo "[provision] VM IP (best guess): ${VM_IP}"
    fi
  fi
fi

cat <<'EOF'
[provision] tip: If you want to open Happy/Expo URLs in your macOS browser:
- Prefer localhost port forwarding (secure context) instead of opening `http://<vm-ip>:<port>`
  (Expo web uses WebCrypto and may fail on insecure origins).
- On the macOS host, add `portForwards` for the VM port ranges in `~/.lima/<name>/lima.yaml`,
  then restart the VM.
- Then run happy-stacks with: `--bind=loopback` (or omit `--bind`) and open the `http://localhost/...`
  or `http://*.localhost/...` URLs.
EOF
