#!/bin/bash
set -euo pipefail

# Create a PR worktree (optionally scoped to a stack).
#
# Usage:
#   ./wt-pr.sh [stackName]
#   ./wt-pr.sh [component] [stackName]   # legacy/backcompat fallback
#
# Examples:
#   ./wt-pr.sh
#   ./wt-pr.sh exp1
#
# Notes:
# - Uses an AppleScript prompt so it works well from SwiftBar without needing Terminal input.
# - Defaults to using the chosen remote's PR head ref and uses --use so the worktree becomes active.

ARG1="${1:-}"
ARG2="${2:-}"

case "$ARG1" in
  happier-ui|happier-cli|happier-server|happier-server-light)
    COMPONENT="$ARG1"
    STACK_NAME="$ARG2"
    ;;
  *)
    COMPONENT=""
    STACK_NAME="$ARG1"
    ;;
esac

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

hstack="$SCRIPT_DIR/hstack.sh"
if [[ ! -x "$hstack" ]]; then
  if [[ -n "${HAPPIER_STACK_SANDBOX_DIR:-}" ]]; then
    echo "missing hstack wrapper in sandbox: $hstack" >&2
    exit 1
  fi
  hstack="$(command -v hstack 2>/dev/null || true)"
fi
if [[ -z "$hstack" ]]; then
  echo "hstack not found (run: npx @happier-dev/stack@latest init)" >&2
  exit 1
fi

if ! command -v osascript >/dev/null 2>&1; then
  echo "osascript not available" >&2
  exit 1
fi

PR_INPUT="$(osascript <<'APPLESCRIPT'
tell application "System Events"
  activate
  set theDialogText to text returned of (display dialog "PR URL or number:" default answer "" with title "hstack — PR worktree")
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
  set theChoice to button returned of (display dialog "Remote to fetch PR from:" with title "hstack — PR remote" buttons {"upstream", "origin"} default button "upstream")
  return theChoice
end tell
APPLESCRIPT
)" || true

REMOTE_CHOICE="$(echo "${REMOTE_CHOICE:-upstream}" | tr -d '\r' | xargs || true)"
if [[ -z "$REMOTE_CHOICE" ]]; then
  REMOTE_CHOICE="upstream"
fi

prompt_component() {
  local selected
  selected="$(osascript <<'APPLESCRIPT'
tell application "System Events"
  activate
  set theChoice to choose from list {"happier-ui", "happier-cli", "happier-server-light", "happier-server"} with title "hstack — Component (legacy fallback)" with prompt "Choose component:" default items {"happier-ui"}
  if theChoice is false then
    return ""
  end if
  return item 1 of theChoice
end tell
APPLESCRIPT
)" || true
  selected="$(echo "${selected:-}" | tr -d '\r' | xargs || true)"
  echo "$selected"
}

run_modern() {
  if [[ -n "$STACK_NAME" && "$STACK_NAME" != "main" ]]; then
    "$hstack" stack wt "$STACK_NAME" -- pr "$PR_INPUT" --remote="$REMOTE_CHOICE" --use
  else
    "$hstack" wt pr "$PR_INPUT" --remote="$REMOTE_CHOICE" --use
  fi
}

run_legacy() {
  local component="$COMPONENT"
  if [[ -z "$component" ]]; then
    component="$(prompt_component)"
  fi
  if [[ -z "$component" ]]; then
    echo "cancelled" >&2
    return 2
  fi

  if [[ -n "$STACK_NAME" && "$STACK_NAME" != "main" ]]; then
    "$hstack" stack wt "$STACK_NAME" -- pr "$component" "$PR_INPUT" --remote="$REMOTE_CHOICE" --use
  else
    "$hstack" wt pr "$component" "$PR_INPUT" --remote="$REMOTE_CHOICE" --use
  fi
}

if run_modern; then
  echo "ok"
  exit 0
fi

echo "modern wt pr invocation failed; trying legacy component-scoped form..." >&2
legacy_status=0
run_legacy || legacy_status=$?
if [[ "$legacy_status" -eq 0 ]]; then
  echo "ok"
  exit 0
fi
if [[ "$legacy_status" -eq 2 ]]; then
  exit 0
fi

echo "failed to create PR worktree. Update hstack to a version that supports current SwiftBar actions." >&2
exit 1
