#!/bin/bash
set -euo pipefail

# Run auth login (interactive) in the user's preferred terminal.
#
# Usage (backwards compatible with older callers):
#   ./auth-login.sh main <serverUrl> <webappUrl>
#   ./auth-login.sh <stackName> <serverUrl> <webappUrl> <cliHomeDir>
#
# Behavior:
# - Delegate to `hstack auth login` / `hstack stack auth <name> login` so URL + cliHome resolution stays centralized.

stack="${1:-main}"
_server_url="${2:-}"   # ignored (kept for backwards compatibility)
_webapp_url="${3:-}"   # ignored (kept for backwards compatibility)
_cli_home_dir="${4:-}" # ignored (kept for backwards compatibility)

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
hstack_TERM="$SCRIPT_DIR/hstack-term.sh"
if [[ ! -x "$hstack_TERM" ]]; then
  echo "missing hstack terminal wrapper: $hstack_TERM" >&2
  exit 1
fi

if [[ "$stack" == "main" ]]; then
  exec "$hstack_TERM" auth login
fi

exec "$hstack_TERM" stack auth "$stack" login
