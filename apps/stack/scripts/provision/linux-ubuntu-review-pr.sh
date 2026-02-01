#!/usr/bin/env bash
set -euo pipefail

# Provision an Ubuntu VM for running Hapsta (Happier Stack) in an isolated Linux environment.
#
# Intended usage (inside a Lima VM):
#   curl -fsSL https://raw.githubusercontent.com/leeroybrun/happier-dev/main/apps/stack/scripts/provision/linux-ubuntu-review-pr.sh -o /tmp/linux-ubuntu-review-pr.sh \
#     && chmod +x /tmp/linux-ubuntu-review-pr.sh \
#     && /tmp/linux-ubuntu-review-pr.sh
#
# After provisioning, run:
#   npx --yes -p @happier-dev/stack@latest hapsta setup --profile=dev --bind=loopback

require_cmd() {
  command -v "$1" >/dev/null 2>&1
}

as_root() {
  if [[ "$(id -u)" == "0" ]]; then
    "$@"
    return
  fi
  if require_cmd sudo; then
    sudo "$@"
    return
  fi
  echo "[provision] missing sudo; re-run as root" >&2
  exit 1
}

echo "[provision] updating apt..."
as_root apt-get update -y

echo "[provision] installing base packages..."
as_root apt-get install -y --no-install-recommends \
  ca-certificates \
  curl \
  git \
  gnupg \
  jq \
  build-essential \
  python3

if ! require_cmd node; then
  echo "[provision] installing Node.js (NodeSource 24.x)..."
  as_root bash -lc 'curl -fsSL https://deb.nodesource.com/setup_24.x | bash -'
  as_root apt-get install -y nodejs
fi

echo "[provision] node: $(node --version)"

if ! require_cmd corepack; then
  echo "[provision] corepack not found (expected with Node >=16)."
  exit 1
fi

echo "[provision] enabling corepack + yarn..."
corepack enable
corepack prepare yarn@1.22.22 --activate
yarn --version

echo ""
echo "[provision] done."
echo ""
echo "Next:"
echo "  npx --yes -p @happier-dev/stack@latest hapsta setup --profile=dev --bind=loopback"
