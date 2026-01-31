#!/bin/bash
set -euo pipefail

# Create a PR worktree (optionally scoped to a stack).
#
# Usage:
#   ./wt-pr.sh <component> [stackName]
#
# Examples:
#   ./wt-pr.sh happy
#   ./wt-pr.sh happy-cli exp1
#
# Notes:
# - Uses an AppleScript prompt so it works well from SwiftBar without needing Terminal input.
# - Defaults to using the chosen remote's PR head ref and uses --use so the component becomes active.

COMPONENT="${1:-}"
STACK_NAME="${2:-}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

HAPSTA="$SCRIPT_DIR/hapsta.sh"
if [[ ! -x "$HAPSTA" ]]; then
  if [[ -n "${HAPPIER_STACK_SANDBOX_DIR:-}" ]]; then
    echo "missing hapsta wrapper in sandbox: $HAPSTA" >&2
    exit 1
  fi
  HAPSTA="$(command -v hapsta 2>/dev/null || true)"
  [[ -z "$HAPSTA" ]] && HAPSTA="$(command -v happier-stack 2>/dev/null || true)"
fi
if [[ -z "$HAPSTA" ]]; then
  echo "hapsta not found (run: npx @happier-dev/stack@latest init)" >&2
  exit 1
fi

if ! command -v osascript >/dev/null 2>&1; then
  echo "osascript not available" >&2
  exit 1
fi

if [[ "$COMPONENT" == "_prompt_" ]]; then
  COMPONENT=""
fi

if [[ -z "$COMPONENT" ]]; then
  COMPONENT="$(osascript <<'APPLESCRIPT'
tell application "System Events"
  activate
  set theChoice to choose from list {"happy", "happy-cli", "happy-server-light", "happy-server"} with title "Hapsta — Component" with prompt "Choose component:" default items {"happy"}
  if theChoice is false then
    return ""
  end if
  return item 1 of theChoice
end tell
APPLESCRIPT
)" || true
  COMPONENT="$(echo "${COMPONENT:-}" | tr -d '\r' | xargs || true)"
  if [[ -z "$COMPONENT" ]]; then
    echo "cancelled" >&2
    exit 0
  fi
fi

PR_INPUT="$(osascript <<'APPLESCRIPT'
tell application "System Events"
  activate
  set theDialogText to text returned of (display dialog "PR URL or number:" default answer "" with title "Hapsta — PR worktree")
  return theDialogText
end tell
APPLESCRIPT
)" || true

PR_INPUT="$(echo "${PR_INPUT:-}" | tr -d '\r' | xargs || true)"
if [[ -z "$PR_INPUT" ]]; then
  echo "cancelled" >&2
  exit 0
fi

REMOTE_CHOICE="$(osascript <<'APPLESCRIPT'
tell application "System Events"
  activate
  set theChoice to button returned of (display dialog "Remote to fetch PR from:" with title "Hapsta — PR remote" buttons {"upstream", "origin"} default button "upstream")
  return theChoice
end tell
APPLESCRIPT
)" || true

REMOTE_CHOICE="$(echo "${REMOTE_CHOICE:-upstream}" | tr -d '\r' | xargs || true)"
if [[ -z "$REMOTE_CHOICE" ]]; then
  REMOTE_CHOICE="upstream"
fi

if [[ -n "$STACK_NAME" && "$STACK_NAME" != "main" ]]; then
  "$HAPSTA" stack wt "$STACK_NAME" -- pr "$COMPONENT" "$PR_INPUT" --remote="$REMOTE_CHOICE" --use
else
  "$HAPSTA" wt pr "$COMPONENT" "$PR_INPUT" --remote="$REMOTE_CHOICE" --use
fi

echo "ok"
