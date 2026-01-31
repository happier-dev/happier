#!/usr/bin/env bash
# Edison Hook: enforce-worktree
# Type: PreToolUse
# Description: Block tool use outside the active session worktree
# Blocking: YES - CAN BLOCK

# This hook enforces that tool actions run from within the session worktree when one is present.

# Source shared guard and check execution scope
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [[ -f "$SCRIPT_DIR/_edison_guard.sh" ]]; then
    # shellcheck source=_edison_guard.sh
    source "$SCRIPT_DIR/_edison_guard.sh"
    edison_hook_guard "enforce-worktree" "session"
fi

INPUT=$(timeout 1 cat 2>/dev/null || echo '{}')
TOOL_NAME=$(echo "$INPUT" | jq -r '.tool // ""' 2>/dev/null || echo "")

case "$TOOL_NAME" in
  Write|Edit|Glob|Grep|Bash) ;;
  *) exit 0 ;;
esac


if [[ "$TOOL_NAME" == "Bash" ]]; then
  COMMAND=$(echo "$INPUT" | jq -r '.args.command // ""' 2>/dev/null || echo "")
  if [[ -z "$COMMAND" ]]; then
    exit 0
  fi

  # Allowlist specific safe bash commands/prefixes so agents can recover (e.g. run `edison session detect`).
  if [[ "$COMMAND" == "cd" || "$COMMAND" == "cd "* ]]; then
    exit 0
  fi
  if [[ "$COMMAND" == "pwd" || "$COMMAND" == "pwd "* ]]; then
    exit 0
  fi
  if [[ "$COMMAND" == "ls" || "$COMMAND" == "ls "* ]]; then
    exit 0
  fi
  if [[ "$COMMAND" == "cat" || "$COMMAND" == "cat "* ]]; then
    exit 0
  fi
  if [[ "$COMMAND" == "echo" || "$COMMAND" == "echo "* ]]; then
    exit 0
  fi

  if [[ "$COMMAND" == "edison" || "$COMMAND" == "edison "* ]]; then
    exit 0
  fi
  if [[ "$COMMAND" == "uv run edison" || "$COMMAND" == "uv run edison "* ]]; then
    exit 0
  fi
  if [[ "$COMMAND" == "python -m edison" || "$COMMAND" == "python -m edison "* ]]; then
    exit 0
  fi
  if [[ "$COMMAND" == "python3 -m edison" || "$COMMAND" == "python3 -m edison "* ]]; then
    exit 0
  fi
fi

DETECTED_JSON=$(edison session detect --json 2>/dev/null || echo '{}')
SESSION_ID=$(echo "$DETECTED_JSON" | jq -r '.sessionId // ""' 2>/dev/null || echo "")
WORKTREE_PATH=$(echo "$DETECTED_JSON" | jq -r '.worktreePath // ""' 2>/dev/null || echo "")
IN_WORKTREE=$(echo "$DETECTED_JSON" | jq -r '.inWorktree // false' 2>/dev/null || echo "false")
ARCHIVED_PATH=$(echo "$DETECTED_JSON" | jq -r '.archivedWorktreePath // ""' 2>/dev/null || echo "")

if [[ -z "$SESSION_ID" || -z "$WORKTREE_PATH" ]]; then
  # No active session/worktree detected.
  exit 0
fi

if [[ "$IN_WORKTREE" == "true" ]]; then
  exit 0
fi

echo ""
echo "❌ WORKTREE ENFORCEMENT: tool use blocked outside session worktree"
echo ""
echo "Session:"
echo "  $SESSION_ID"
echo ""
echo "Expected worktree:"
echo "  $WORKTREE_PATH"
echo ""

if [[ -n "$ARCHIVED_PATH" ]]; then
  echo "Archived worktree detected:"
  echo "  $ARCHIVED_PATH"
  echo ""
  echo "Restore it with:"
  echo "  edison git worktree-restore $SESSION_ID"
else
  echo "Run:"
  echo "  cd $WORKTREE_PATH"
  echo "  export AGENTS_SESSION=$SESSION_ID"
fi

# Emit audit event (best-effort, fail-open)
edison audit event "hook.enforce-worktree.blocked" \
  --repo-root "$PWD" \
  --session "$SESSION_ID" \
  --field "hook_id=enforce-worktree" \
  --field "tool=$TOOL_NAME" 2>/dev/null || true

exit 1
