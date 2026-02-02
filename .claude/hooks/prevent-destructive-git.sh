#!/usr/bin/env bash
# Edison Hook: prevent-destructive-git
# Type: PreToolUse
# Description: Block destructive git commands unless explicitly approved
# Blocking: YES - CAN BLOCK

# Source shared guard and check execution scope
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [[ -f "$SCRIPT_DIR/_edison_guard.sh" ]]; then
    # shellcheck source=_edison_guard.sh
    source "$SCRIPT_DIR/_edison_guard.sh"
    edison_hook_guard "prevent-destructive-git" "session"
fi

SESSION_FILE=".project/.session-id"

# Parse input JSON (with timeout to prevent hanging)
INPUT=$(timeout 1 cat 2>/dev/null || echo '{}')
TOOL_NAME=$(echo "$INPUT" | jq -r '.tool' 2>/dev/null || echo "")

if [[ "$TOOL_NAME" != "Bash" ]]; then
  exit 0
fi

COMMAND=$(echo "$INPUT" | jq -r '.args.command // ""' 2>/dev/null || echo "")
if [[ -z "$COMMAND" ]]; then
  exit 0
fi


if [[ -n "$EDISON_ALLOW_DESTRUCTIVE_GIT" && "$EDISON_ALLOW_DESTRUCTIVE_GIT" != "0" ]]; then
  exit 0
fi

MATCHED=""
if [[ -z "$MATCHED" && "$COMMAND" == *"git reset"* ]]; then
  MATCHED="git reset"
fi
if [[ -z "$MATCHED" && "$COMMAND" == *"git restore"* ]]; then
  MATCHED="git restore"
fi
if [[ -z "$MATCHED" && "$COMMAND" == *"git clean"* ]]; then
  MATCHED="git clean"
fi
if [[ -z "$MATCHED" && "$COMMAND" == *"git checkout --"* ]]; then
  MATCHED="git checkout --"
fi
if [[ -z "$MATCHED" && "$COMMAND" == *"git switch"* ]]; then
  MATCHED="git switch"
fi

if [[ -z "$MATCHED" ]]; then
  exit 0
fi

SESSION_ID=""
if [[ -f "$SESSION_FILE" ]]; then
  SESSION_ID=$(cat "$SESSION_FILE" 2>/dev/null | head -1 || echo "")
fi

echo ""
echo "❌ BLOCKED: destructive git command detected"
echo ""
echo "Command:"
echo "  $COMMAND"
echo ""
echo "Matched:"
echo "  $MATCHED"
echo ""
echo "Edison policy: do NOT discard/revert 'unrelated' changes unless the user explicitly asked."
echo "If you believe this is required, ask for approval and then re-run with:"
echo "  export EDISON_ALLOW_DESTRUCTIVE_GIT=1"
echo ""
echo "Tip: If your goal is to validate/inspect, prefer:"
echo "  git status --porcelain"
echo "  git diff"
echo ""

# Emit audit event (best-effort, fail-open)
if [[ -n "$SESSION_ID" ]]; then
  edison audit event "hook.prevent-destructive-git.blocked" \
    --repo-root "$PWD" \
    --session "$SESSION_ID" \
    --field "hook_id=prevent-destructive-git" \
    --field "command=$COMMAND" 2>/dev/null || true
fi

exit 1
