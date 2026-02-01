#!/bin/bash
set -euo pipefail

# Open preferred terminal and run a hapsta command.
#
# Preference order follows wt shell semantics:
# - HAPPIER_STACK_WT_TERMINAL=ghostty|iterm|terminal|current
#   (also accepts "auto" which tries ghostty->iterm->terminal->current)
#
# Notes:
# - iTerm / Terminal: we run the command automatically via AppleScript.
# - Ghostty: best-effort; if we can't run the command, we open Ghostty in the dir and copy the command to clipboard.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEFAULT_HOME_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"

# Prefer explicit env vars, but default to the install location inferred from this script path.
CANONICAL_HOME_DIR="${HAPPIER_STACK_CANONICAL_HOME_DIR:-$DEFAULT_HOME_DIR}"
HOME_DIR="${HAPPIER_STACK_HOME_DIR:-$DEFAULT_HOME_DIR}"

export HAPPIER_STACK_HOME_DIR="$HOME_DIR"
export HAPPIER_STACK_CANONICAL_HOME_DIR="$CANONICAL_HOME_DIR"

# Prefer running against an explicit repo checkout if provided.
ROOT_DIR="${HAPPIER_STACK_CLI_ROOT_DIR:-$HOME_DIR}"

LIB_DIR="$ROOT_DIR/extras/swiftbar/lib"
if [[ -f "$LIB_DIR/utils.sh" ]]; then
  # shellcheck source=/dev/null
  source "$LIB_DIR/utils.sh"
fi

WORKDIR="${HAPPIER_STACK_WORKSPACE_DIR:-$(resolve_workspace_dir 2>/dev/null || true)}"
[[ -z "$WORKDIR" ]] && WORKDIR="$HOME_DIR/workspace"
if [[ ! -d "$WORKDIR" ]]; then
  WORKDIR="$HOME"
fi

HAPSTA_SH="$ROOT_DIR/extras/swiftbar/hapsta.sh"
if [[ ! -x "$HAPSTA_SH" ]]; then
  echo "missing hapsta wrapper: $HAPSTA_SH" >&2
  exit 1
fi

pref_raw="$(echo "${HAPPIER_STACK_WT_TERMINAL:-auto}" | tr '[:upper:]' '[:lower:]')"
pref="$pref_raw"
if [[ "$pref" == "" ]]; then pref="auto"; fi

cmd=( "$HAPSTA_SH" "$@" )

escape_for_osascript_string() {
  local s="$1"
  s="${s//\\/\\\\}"
  s="${s//\"/\\\"}"
  echo "$s"
}

shell_cmd() {
  local joined=""
  local q
  joined="cd \"${WORKDIR//\"/\\\"}\"; "
  for q in "${cmd[@]}"; do
    local escaped
    escaped="$(printf "%s" "$q" | sed "s/'/'\\\\''/g")"
    joined+="'${escaped}' "
  done
  joined+="; echo; echo \"[hapsta] done\"; exec /bin/zsh -i"
  echo "$joined"
}

run_iterm() {
  if ! command -v osascript >/dev/null 2>&1; then
    return 1
  fi
  local s
  s="$(shell_cmd)"
  s="$(escape_for_osascript_string "$s")"
  osascript \
    -e 'tell application "iTerm" to activate' \
    -e 'tell application "iTerm" to create window with default profile' \
    -e "tell application \"iTerm\" to tell current session of current window to write text \"${s}\"" >/dev/null
}

run_terminal_app() {
  if ! command -v osascript >/dev/null 2>&1; then
    return 1
  fi
  local s
  s="$(shell_cmd)"
  s="$(escape_for_osascript_string "$s")"
  osascript \
    -e 'tell application "Terminal" to activate' \
    -e "tell application \"Terminal\" to do script \"${s}\"" >/dev/null
}

run_ghostty() {
  if ! command -v ghostty >/dev/null 2>&1; then
    return 1
  fi

  local s
  s="$(shell_cmd)"
  if ghostty --working-directory "$WORKDIR" -e /bin/zsh -lc "$s" >/dev/null 2>&1; then
    return 0
  fi

  echo -n "$s" | pbcopy 2>/dev/null || true
  ghostty --working-directory "$WORKDIR" >/dev/null 2>&1 || true
  return 0
}

try_one() {
  local t="$1"
  case "$t" in
    ghostty) run_ghostty ;;
    iterm) run_iterm ;;
    terminal) run_terminal_app ;;
    current) ( cd "$WORKDIR"; exec "${cmd[@]}" ) ;;
    *) return 1 ;;
  esac
}

if [[ "$pref" == "auto" ]]; then
  for t in ghostty iterm terminal current; do
    if try_one "$t"; then
      exit 0
    fi
  done
  exit 1
fi

try_one "$pref"

