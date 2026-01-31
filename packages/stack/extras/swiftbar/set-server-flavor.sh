#!/bin/bash
set -euo pipefail

# Usage:
#   ./set-server-flavor.sh main|<stackName> happy-server|happy-server-light
#
# For main:
#   - updates env.local via `hapsta srv use ...`
#   - restarts the LaunchAgent service if installed (best-effort)
#
# For stacks:
#   - updates the stack env via `hapsta stack srv <name> -- use ...`
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
HAPSTA_BIN="$SCRIPT_DIR/hapsta.sh"
if [[ ! -x "$HAPSTA_BIN" ]]; then
  echo "hapsta wrapper not found (run: hapsta menubar install)" >&2
  exit 1
fi

restart_main_service_best_effort() {
  if [[ -n "${HAPPIER_STACK_SANDBOX_DIR:-}" ]]; then
    return 0
  fi
  "$HAPSTA_BIN" service:restart >/dev/null 2>&1 || true
  # If the installed LaunchAgent is still legacy/baked, reinstall so it persists only env-file pointer.
  "$HAPSTA_BIN" service:install >/dev/null 2>&1 || true
}

restart_stack_service_best_effort() {
  local name="$1"
  if [[ -n "${HAPPIER_STACK_SANDBOX_DIR:-}" ]]; then
    return 0
  fi
  "$HAPSTA_BIN" stack service:restart "$name" >/dev/null 2>&1 || true
  "$HAPSTA_BIN" stack service:install "$name" >/dev/null 2>&1 || true
}

if [[ "$STACK" == "main" ]]; then
  "$HAPSTA_BIN" srv -- use "$FLAVOR"
  restart_main_service_best_effort
  echo "ok: main -> $FLAVOR"
  exit 0
fi

"$HAPSTA_BIN" stack srv "$STACK" -- use "$FLAVOR"
restart_stack_service_best_effort "$STACK"
echo "ok: $STACK -> $FLAVOR"
