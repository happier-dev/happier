#!/usr/bin/env bash
# Edison Hook: inject-task-rules
# Type: UserPromptSubmit
# Description: Inject Edison-rendered rules for current task state
# Blocking: NO (always exit 0)

# Source shared guard and check execution scope
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [[ -f "$SCRIPT_DIR/_edison_guard.sh" ]]; then
    # shellcheck source=_edison_guard.sh
    source "$SCRIPT_DIR/_edison_guard.sh"
    edison_hook_guard "inject-task-rules" "session"
fi

# Parse input JSON (with timeout to prevent hanging)
INPUT=$(timeout 1 cat 2>/dev/null || echo '{}')
FILE_PATHS=$(echo "$INPUT" | jq -r '.file_paths // [] | .[]' 2>/dev/null || echo "")

# Check if any file matches our patterns using bash glob matching
RELEVANT=false
for file in $FILE_PATHS; do
  case "$file" in
*|*.___never_match___)
      RELEVANT=true
      break
      ;;
  esac
done

if [[ "$RELEVANT" != "true" ]]; then
  exit 0
fi

# Get current task state (prefer session context JSON; fall back to legacy task JSON)
TASK_STATE=$(edison session context --json 2>/dev/null | jq -r '.currentTaskState // empty' 2>/dev/null || true)
if [[ -z "$TASK_STATE" ]]; then
  TASK_STATE=$(edison task 2>/dev/null | jq -r '.state // empty' 2>/dev/null || true)
fi
if [[ -z "$TASK_STATE" ]]; then
  exit 0  # No active task, nothing to inject
fi

# Newer centralized injection API (best-effort; keep silent on failures)
INJECTION=$(edison rules inject --state "$TASK_STATE" --format markdown 2>/dev/null || echo "")
if [[ -n "$INJECTION" ]]; then
  echo ""
  echo "$INJECTION"
  echo ""
fi

exit 0