#!/usr/bin/env bash
# Edison Hook: stop-continuation
# Type: Stop
# Description: Inject continuation nudge when session is incomplete (soft/hard continuation assist)
# Blocking: NO
#
# This hook is triggered when the Claude Code agent stops.
# It injects a continuation prompt when the session is incomplete (FC/RL assist).
# Fail-open: this hook never blocks, even if Edison is unavailable.

# Source shared guard and check execution scope
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [[ -f "$SCRIPT_DIR/_edison_guard.sh" ]]; then
    # shellcheck source=_edison_guard.sh
    source "$SCRIPT_DIR/_edison_guard.sh"
    edison_hook_guard "stop-continuation" "session"
fi


# Detect session ID (from env or session file)
_get_session_id() {
    local sid="${AGENTS_SESSION:-}"
    if [[ -z "$sid" ]]; then
        sid="${EDISON_SESSION_ID:-}"
    fi
    if [[ -z "$sid" ]] && command -v edison >/dev/null 2>&1; then
        sid=$(edison session detect --json 2>/dev/null | grep -o '"sessionId":"[^"]*"' | cut -d'"' -f4 2>/dev/null || true)
    fi
    echo "$sid"
}

SESSION_ID="$(_get_session_id)"

# Exit early if no session (nothing to continue)
if [[ -z "$SESSION_ID" ]]; then
    exit 0
fi

# Fetch completion/continuation payload (fail-open: use || true throughout)
# We use --completion-only for minimal JSON output (no actions/blockers/etc).
# The output is small enough to parse with grep/cut (no jq dependency).
PAYLOAD=""
if command -v edison >/dev/null 2>&1; then
    PAYLOAD=$(edison session next "$SESSION_ID" --json --completion-only 2>/dev/null || true)
fi

# If Edison failed or returned empty, exit silently (fail-open)
if [[ -z "$PAYLOAD" ]]; then
    exit 0
fi

# Parse key fields from JSON using grep/cut (no jq dependency)
# Expected JSON structure: {"sessionId":"...","completion":{"isComplete":...},"continuation":{"shouldContinue":...,"prompt":"..."}}

_json_bool() {
    # Extract a boolean field: returns "true" or "false" (lowercase)
    local field="$1"
    echo "$PAYLOAD" | grep -o "\"$field\":[^,}]*" | cut -d: -f2 | tr -d ' "' | tr '[:upper:]' '[:lower:]' | head -1
}

_json_string() {
    # Extract a string field (handles embedded newlines in prompt)
    local field="$1"
    # Use Python for reliable JSON extraction if available, else fallback to grep
    if command -v python3 >/dev/null 2>&1; then
        echo "$PAYLOAD" | python3 -c "
import sys, json
try:
    data = json.load(sys.stdin)
    # Handle nested fields like 'continuation.prompt'
    parts = '$field'.split('.')
    val = data
    for p in parts:
        val = val.get(p, '') if isinstance(val, dict) else ''
    print(val if isinstance(val, str) else '')
except Exception:
    pass
" 2>/dev/null || true
    else
        # Fallback: basic grep (may not handle multiline prompts well)
        echo "$PAYLOAD" | grep -o "\"$field\":\"[^\"]*\"" | cut -d'"' -f4 | head -1 || true
    fi
}

IS_COMPLETE="$(_json_bool isComplete)"
SHOULD_CONTINUE="$(_json_bool shouldContinue)"

# If session is complete, emit minimal line and exit
if [[ "$IS_COMPLETE" == "true" ]]; then
    echo "Edison: Session complete."
    exit 0
fi

# If continuation is disabled (shouldContinue=false), exit silently
if [[ "$SHOULD_CONTINUE" != "true" ]]; then
    exit 0
fi

# Emit continuation prompt (sourced from Edison, not hardcoded)
PROMPT="$(_json_string continuation.prompt)"
if [[ -n "$PROMPT" ]]; then
    echo ""
    echo "--- Edison Continuation ---"
    echo "$PROMPT"
    echo "----------------------------"
    echo ""
fi

# CWAM is already embedded in the continuation.prompt by Edison (from rules/context_window).
# No additional CWAM line needed here; Edison handles CWAM injection.

exit 0