#!/usr/bin/env bash
set -euo pipefail

# Automated Lima VM E2E smoke test runner for hstack.
#
# Usage (macOS host):
#   ./scripts/provision/macos-lima-hstack-e2e.sh [vm-name]
#
# Env:
#   HSTACK_VERSION=latest            # @happier-dev/stack version to test (default: latest)
#   HSTACK_E2E_KEEP=1                # keep sandbox dir in the VM (default: 0)
#   HSTACK_RAW_BASE=...              # override raw github base (default: happier-dev/happier main)
#
# This script:
# - creates/configures a Lima VM (via macos-lima-happy-vm.sh)
# - provisions Node/Yarn inside the VM
# - runs a sandboxed `hstack` selfhost+worktree smoke test inside the VM

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  cat <<'EOF'
Usage:
  ./scripts/provision/macos-lima-hstack-e2e.sh [vm-name]

Examples:
  ./scripts/provision/macos-lima-hstack-e2e.sh
  HSTACK_VERSION=latest ./scripts/provision/macos-lima-hstack-e2e.sh happy-e2e

Notes:
- Run on macOS (Darwin) host.
- Uses a fully isolated sandbox inside the VM (does not touch ~/.happier-stack on the VM).
EOF
  exit 0
fi

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "[lima-e2e] expected macOS (Darwin); got: $(uname -s)" >&2
  exit 1
fi

if ! command -v limactl >/dev/null 2>&1; then
  echo "[lima-e2e] limactl not found. Install Lima first (example: brew install lima)." >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VM_NAME="${1:-happy-e2e}"

HSTACK_VERSION="${HSTACK_VERSION:-latest}"
HSTACK_E2E_KEEP="${HSTACK_E2E_KEEP:-0}"

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
    if curl -fsSL "${c}/scripts/provision/linux-ubuntu-review-pr.sh" -o /dev/null >/dev/null 2>&1; then
      echo "$c"
      return 0
    fi
  done
  return 1
}

HSTACK_RAW_BASE="$(pick_raw_base || true)"
if [[ -z "${HSTACK_RAW_BASE}" ]]; then
  echo "[lima-e2e] failed to auto-detect raw GitHub base URL for scripts." >&2
  echo "[lima-e2e] Fix: set HSTACK_RAW_BASE=https://raw.githubusercontent.com/<org>/<repo>/<ref>/apps/stack" >&2
  exit 1
fi

echo "[lima-e2e] vm: ${VM_NAME}"
echo "[lima-e2e] @happier-dev/stack: ${HSTACK_VERSION}"
echo "[lima-e2e] raw base: ${HSTACK_RAW_BASE}"

echo "[lima-e2e] ensure VM exists + port forwarding..."
"${SCRIPT_DIR}/macos-lima-happy-vm.sh" "${VM_NAME}"

echo "[lima-e2e] running provisioning + e2e inside VM..."
limactl shell "${VM_NAME}" -- bash -lc "
  set -euo pipefail
  echo '[vm] downloading provision + e2e scripts...'
  curl -fsSL '${HSTACK_RAW_BASE}/scripts/provision/linux-ubuntu-review-pr.sh' -o /tmp/linux-ubuntu-review-pr.sh
  chmod +x /tmp/linux-ubuntu-review-pr.sh
  /tmp/linux-ubuntu-review-pr.sh

  curl -fsSL '${HSTACK_RAW_BASE}/scripts/provision/linux-ubuntu-e2e.sh' -o /tmp/linux-ubuntu-e2e.sh
  chmod +x /tmp/linux-ubuntu-e2e.sh

  export HSTACK_VERSION='${HSTACK_VERSION}'
  export HSTACK_E2E_KEEP='${HSTACK_E2E_KEEP}'
  /tmp/linux-ubuntu-e2e.sh
"

echo ""
echo "[lima-e2e] done."
