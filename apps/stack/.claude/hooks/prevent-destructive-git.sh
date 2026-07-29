#!/usr/bin/env bash
# Hook: prevent-destructive-git
# Type: PreToolUse
# Description: Block destructive git commands unless explicitly approved.
# Blocking: YES

set -u

if [[ -t 0 ]]; then
  INPUT='{}'
else
  INPUT=$(cat 2>/dev/null || echo '{}')
fi

json_field() {
  local expression="$1"
  node -e '
const fs = require("node:fs");
const expression = process.argv[1];
let payload = {};
try { payload = JSON.parse(fs.readFileSync(0, "utf8") || "{}"); } catch {}
const value = expression.split(".").reduce((current, key) => current && current[key], payload);
if (typeof value === "string") process.stdout.write(value);
' "$expression" <<<"$INPUT" 2>/dev/null || true
}

TOOL_NAME=$(json_field 'tool')
if [[ "$TOOL_NAME" != "Bash" ]]; then
  exit 0
fi

COMMAND=$(json_field 'args.command')
if [[ -z "$COMMAND" ]]; then
  exit 0
fi

if [[ -n "${ALLOW_DESTRUCTIVE_GIT:-}" && "${ALLOW_DESTRUCTIVE_GIT:-}" != "0" ]]; then
  exit 0
fi

MATCHED=""
case "$COMMAND" in
  *"git reset"*) MATCHED="git reset" ;;
  *"git restore"*) MATCHED="git restore" ;;
  *"git clean"*) MATCHED="git clean" ;;
  *"git checkout"*) MATCHED="git checkout" ;;
  *"git switch"*) MATCHED="git switch" ;;
  *) MATCHED="" ;;
esac

if [[ -z "$MATCHED" ]]; then
  exit 0
fi

cat <<EOF

❌ BLOCKED: destructive git command detected

Command:
  $COMMAND

Matched:
  $MATCHED

Repo policy: do not discard, revert, or clean unrelated/uncommitted work unless the user explicitly asked for that exact destructive action.

If this destructive operation is truly required, ask for explicit approval first. After approval, re-run with:
  export ALLOW_DESTRUCTIVE_GIT=1

Prefer inspection commands when possible:
  git status --porcelain
  git diff

EOF

exit 1
