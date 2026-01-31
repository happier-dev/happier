#!/usr/bin/env bash
# Edison Hook: remind-tdd
# Type: PreToolUse
# Description: Remind about TDD workflow when editing code
# Blocking: NO

# Source shared guard and check execution scope
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [[ -f "$SCRIPT_DIR/_edison_guard.sh" ]]; then
    # shellcheck source=_edison_guard.sh
    source "$SCRIPT_DIR/_edison_guard.sh"
    edison_hook_guard "remind-tdd" "session"
fi

# Parse input JSON (with timeout to prevent hanging)
INPUT=$(timeout 1 cat 2>/dev/null || echo '{}')
TOOL_NAME=$(echo "$INPUT" | jq -r '.tool' 2>/dev/null || echo "")
FILE_PATH=$(echo "$INPUT" | jq -r '.args.file_path // ""' 2>/dev/null || echo "")


# Only for Write/Edit tools
if [[ "$TOOL_NAME" != "Write" && "$TOOL_NAME" != "Edit" ]]; then
  exit 0
fi

# Get current task state (prefer session context JSON; fall back to legacy task JSON)
TASK_STATE=$(edison session context --json 2>/dev/null | jq -r '.currentTaskState // empty' 2>/dev/null || true)
if [[ -z "$TASK_STATE" ]]; then
  TASK_STATE=$(edison task --json 2>/dev/null | jq -r '.state // empty' 2>/dev/null || true)
fi

# Only remind in configured states
SHOULD_REMIND=false
if [[ "$TASK_STATE" == "wip" ]]; then
  SHOULD_REMIND=true
fi

if [[ "$SHOULD_REMIND" != "true" ]]; then
  exit 0
fi

# Skip test files
if echo "$FILE_PATH" | grep -qE '\.(test|spec)\.(ts|js|tsx|jsx|py)$'; then
  exit 0
fi

# Print reminder (but don't block)
echo ""
echo "💡 TDD Reminder:"
echo "   RED: Write failing test first"
echo "   GREEN: Implement to pass"
echo "   REFACTOR: Clean up"
echo ""
echo "   See: /edison-rules-tdd for details"
echo ""

# Exit 0 = don't block
exit 0