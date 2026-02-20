#!/usr/bin/env bash
set -euo pipefail

# Automated Lima VM smoke test runner for hstack.
#
# Usage (macOS host):
#   ./scripts/provision/macos-lima-hstack-smoke.sh [vm-name]
#
# Env:
#   HSTACK_VERSION=latest            # @happier-dev/stack version to test (default: latest)
#   HSTACK_SMOKE_KEEP=1              # keep sandbox dir in the VM (default: 0)
#   HSTACK_RAW_BASE=...              # override raw github base (default: happier-dev/happier main)
#   HSTACK_PROVISION_PROFILE=happier # guest provisioning profile (default: happier)
#
# This script:
# - creates/configures a Lima VM (via macos-lima-vm.sh)
# - provisions dependencies inside the VM (linux-ubuntu-provision.sh)
# - runs a sandboxed `hstack` smoke test inside the VM (linux-ubuntu-hstack-smoke.sh)

usage() {
  cat <<'EOF'
Usage:
  ./scripts/provision/macos-lima-hstack-smoke.sh [vm-name]

Examples:
  ./scripts/provision/macos-lima-hstack-smoke.sh
  HSTACK_VERSION=latest ./scripts/provision/macos-lima-hstack-smoke.sh happy-e2e
EOF
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
  exit 0
fi

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "[lima-smoke] expected macOS (Darwin); got: $(uname -s)" >&2
  exit 1
fi

if ! command -v limactl >/dev/null 2>&1; then
  echo "[lima-smoke] limactl not found. Install Lima first (example: brew install lima)." >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VM_NAME="${1:-happy-e2e}"

HSTACK_VERSION="${HSTACK_VERSION:-latest}"
HSTACK_SMOKE_KEEP="${HSTACK_SMOKE_KEEP:-0}"
HSTACK_PROVISION_PROFILE="${HSTACK_PROVISION_PROFILE:-happier}"

pick_raw_base() {
  if [[ -n "${HSTACK_RAW_BASE:-}" ]]; then
    echo "${HSTACK_RAW_BASE}"
    return 0
  fi
  local candidates=(
    "https://raw.githubusercontent.com/happier-dev/happier/main/apps/stack"
  )
  local c
  for c in "${candidates[@]}"; do
    if curl -fsSL "${c}/scripts/provision/linux-ubuntu-provision.sh" -o /dev/null >/dev/null 2>&1; then
      echo "$c"
      return 0
    fi
  done
  return 1
}

HSTACK_RAW_BASE="$(pick_raw_base || true)"
if [[ -z "${HSTACK_RAW_BASE}" ]]; then
  echo "[lima-smoke] failed to auto-detect raw GitHub base URL for scripts." >&2
  echo "[lima-smoke] Fix: set HSTACK_RAW_BASE=https://raw.githubusercontent.com/<org>/<repo>/<ref>/apps/stack" >&2
  exit 1
fi

echo "[lima-smoke] vm: ${VM_NAME}"
echo "[lima-smoke] @happier-dev/stack: ${HSTACK_VERSION}"
echo "[lima-smoke] provision profile: ${HSTACK_PROVISION_PROFILE}"
echo "[lima-smoke] raw base: ${HSTACK_RAW_BASE}"

echo "[lima-smoke] ensure VM exists + port forwarding..."
"${SCRIPT_DIR}/macos-lima-vm.sh" "${VM_NAME}"

echo "[lima-smoke] running provisioning + smoke inside VM..."
limactl shell "${VM_NAME}" -- bash -lc "
  set -euo pipefail
  echo '[vm] downloading provision + smoke scripts...'
  curl -fsSL '${HSTACK_RAW_BASE}/scripts/provision/linux-ubuntu-provision.sh' -o /tmp/linux-ubuntu-provision.sh
  chmod +x /tmp/linux-ubuntu-provision.sh
  /tmp/linux-ubuntu-provision.sh --profile='${HSTACK_PROVISION_PROFILE}'

  curl -fsSL '${HSTACK_RAW_BASE}/scripts/provision/linux-ubuntu-hstack-smoke.sh' -o /tmp/linux-ubuntu-hstack-smoke.sh
  chmod +x /tmp/linux-ubuntu-hstack-smoke.sh

  export HSTACK_VERSION='${HSTACK_VERSION}'
  export HSTACK_SMOKE_KEEP='${HSTACK_SMOKE_KEEP}'
  /tmp/linux-ubuntu-hstack-smoke.sh
"

echo ""
echo "[lima-smoke] done."

