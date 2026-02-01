#!/usr/bin/env bash
# Edison Hook: commit-guard
# Type: PreToolUse
# Description: Block commits with failing tests or low coverage
# Blocking: YES - CAN BLOCK COMMITS

# Source shared guard and check execution scope
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [[ -f "$SCRIPT_DIR/_edison_guard.sh" ]]; then
    # shellcheck source=_edison_guard.sh
    source "$SCRIPT_DIR/_edison_guard.sh"
    edison_hook_guard "commit-guard" "session"
fi

SESSION_FILE=".project/.session-id"

# Parse input JSON (with timeout to prevent hanging)
INPUT=$(timeout 1 cat 2>/dev/null || echo '{}')
TOOL_NAME=$(echo "$INPUT" | jq -r '.tool' 2>/dev/null || echo "")


SESSION_ID=$(cat "$SESSION_FILE" 2>/dev/null | head -1 || echo "")

_edison_audit_event() {
  # Fail-open: audit must never break hooks.
  local event="$1"
  shift || true
  edison audit event "$event" \
    --repo-root "$PWD" \
    --session "$SESSION_ID" \
    --field "hook_id=commit-guard" \
    --field "hook_type=PreToolUse" \
    "$@" 2>/dev/null || true
}

# Only for git commit
if [[ "$TOOL_NAME" != "Bash" ]]; then
  exit 0
fi

COMMAND=$(echo "$INPUT" | jq -r '.args.command // ""' 2>/dev/null || echo "")
if [[ "$COMMAND" != *"git commit"* ]]; then
  exit 0
fi

echo "🔍 Edison Commit Guard: Checking tests..."
_edison_audit_event "hook.commit-guard.start" --field "tool=$TOOL_NAME" --field "command=$COMMAND"

# Run tests
if ! edison ci test 2>&1; then
  echo ""
  echo "❌ Commit blocked: Tests are failing"
  echo ""
  echo "Fix failing tests before committing."
  echo "Run: edison ci test"
  echo ""
  _edison_audit_event "hook.commit-guard.blocked" --field "reason=tests_failed"
  exit 1  # BLOCK
fi

# Check coverage
COVERAGE=$(edison ci coverage --json 2>/dev/null | jq -r '.overall' || echo "0")
THRESHOLD=90

if (( $(echo "$COVERAGE < $THRESHOLD" | bc -l) )); then
  echo ""
  echo "❌ Commit blocked: Coverage too low ($COVERAGE% < $THRESHOLD%)"
  echo ""
  echo "Increase test coverage before committing."
  echo ""
  _edison_audit_event "hook.commit-guard.blocked" --field "reason=coverage_low" --field "coverage=$COVERAGE" --field "threshold=$THRESHOLD"
  exit 1  # BLOCK
fi

echo "✅ Commit guard passed"
_edison_audit_event "hook.commit-guard.passed"
exit 0