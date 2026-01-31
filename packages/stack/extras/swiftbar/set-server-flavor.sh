#!/bin/bash
set -euo pipefail

# Usage:
#   ./set-server-flavor.sh main|<stackName> happy-server|happy-server-light
#
# For main:
#   - updates env.local via `happys srv use ...`
#   - restarts the LaunchAgent service if installed (best-effort)
#
# For stacks:
#   - updates the stack env via `happys stack srv <name> -- use ...`
#   - restarts the stack LaunchAgent service if installed (best-effort)

STACK="${1:-}"
FLAVOR="${2:-}"

if [[ -z "$STACK" ]] || [[ -z "$FLAVOR" ]]; then
  echo "usage: $0 <main|stackName> <happy-server|happy-server-light>" >&2
  exit 2
fi
if [[ "$FLAVOR" != "happy-server" && "$FLAVOR" != "happy-server-light" ]]; then
  echo "invalid flavor: $FLAVOR" >&2
  exit 2
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEFAULT_HOME_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"

HAPPY_LOCAL_DIR="${HAPPY_LOCAL_DIR:-${HAPPY_STACKS_HOME_DIR:-$DEFAULT_HOME_DIR}}"
HAPPY_STACKS_HOME_DIR="${HAPPY_STACKS_HOME_DIR:-$HAPPY_LOCAL_DIR}"

HAPPYS_BIN="$HAPPY_LOCAL_DIR/extras/swiftbar/happys.sh"
if [[ ! -x "$HAPPYS_BIN" ]]; then
  echo "happys wrapper not found (run: happys menubar install)" >&2
  exit 1
fi

restart_main_service_best_effort() {
  if [[ -n "${HAPPY_STACKS_SANDBOX_DIR:-}" ]]; then
    return 0
  fi
  "$HAPPYS_BIN" service:restart >/dev/null 2>&1 || true
  # If the installed LaunchAgent is still legacy/baked, reinstall so it persists only env-file pointer.
  "$HAPPYS_BIN" service:install >/dev/null 2>&1 || true
}

restart_stack_service_best_effort() {
  local name="$1"
  if [[ -n "${HAPPY_STACKS_SANDBOX_DIR:-}" ]]; then
    return 0
  fi
  "$HAPPYS_BIN" stack service:restart "$name" >/dev/null 2>&1 || true
  "$HAPPYS_BIN" stack service:install "$name" >/dev/null 2>&1 || true
}

if [[ "$STACK" == "main" ]]; then
  "$HAPPYS_BIN" srv -- use "$FLAVOR"
  restart_main_service_best_effort
  echo "ok: main -> $FLAVOR"
  exit 0
fi

"$HAPPYS_BIN" stack srv "$STACK" -- use "$FLAVOR"
restart_stack_service_best_effort "$STACK"
echo "ok: $STACK -> $FLAVOR"
