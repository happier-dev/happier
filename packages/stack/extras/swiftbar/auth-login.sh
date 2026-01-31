#!/bin/bash
set -euo pipefail

# Run auth login (interactive) in the user's preferred terminal.
#
# Usage (backwards compatible with older callers):
#   ./auth-login.sh main <serverUrl> <webappUrl>
#   ./auth-login.sh <stackName> <serverUrl> <webappUrl> <cliHomeDir>
#
# New behavior:
# - Delegate to `happys auth login` / `happys stack auth <name> login` so URL + cliHome resolution stays centralized.

stack="${1:-main}"
_server_url="${2:-}"   # ignored (kept for backwards compatibility)
_webapp_url="${3:-}"   # ignored (kept for backwards compatibility)
_cli_home_dir="${4:-}" # ignored (kept for backwards compatibility)

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEFAULT_HOME_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"

HAPPY_LOCAL_DIR="${HAPPY_LOCAL_DIR:-${HAPPY_STACKS_HOME_DIR:-$DEFAULT_HOME_DIR}}"
HAPPY_STACKS_HOME_DIR="${HAPPY_STACKS_HOME_DIR:-$HAPPY_LOCAL_DIR}"

HAPPYS_TERM="$HAPPY_LOCAL_DIR/extras/swiftbar/happys-term.sh"
if [[ ! -x "$HAPPYS_TERM" ]]; then
  echo "missing terminal happys wrapper: $HAPPYS_TERM" >&2
  exit 1
fi

if [[ "$stack" == "main" ]]; then
  exec "$HAPPYS_TERM" auth login
fi

exec "$HAPPYS_TERM" stack auth "$stack" login
