#!/usr/bin/env bash
# Edison Hook: compaction-reminder
# Type: PreCompact
# Description: Emit session context (with Actor identity) for compaction recovery
#
# This hook is triggered automatically by Claude Code BEFORE context compaction.
# It emits deterministic session context including Actor identity for compaction recovery.

# Source shared guard and check execution scope
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [[ -f "$SCRIPT_DIR/_edison_guard.sh" ]]; then
    # shellcheck source=_edison_guard.sh
    source "$SCRIPT_DIR/_edison_guard.sh"
    edison_hook_guard "compaction-reminder" "session"
fi

# Emit a minimal, deterministic context refresher (includes Actor stanza).
command -v edison >/dev/null 2>&1 && edison session context 2>/dev/null || true

_edison_audit_event() {
  # Fail-open: audit must never break hooks.
  local event="$1"
  shift || true
  edison audit event "$event" \
    --repo-root "$PWD" \
    --field "hook_id=compaction-reminder" \
    --field "hook_type=PreCompact" \
    "$@" 2>/dev/null || true
}

command -v edison >/dev/null 2>&1 && _edison_audit_event "hook.compaction-reminder" || true


# Configuration from hooks.yaml
NOTIFY="True"

# Output compaction recovery directive (Claude Code injects this into context)
# The Actor stanza in session context already provides the exact `edison read` command.
if [ "$NOTIFY" = "true" ] || [ "$NOTIFY" = "True" ]; then
    echo "⚠️ After compaction: re-read your constitution (see Actor in Edison Context above)."
fi

exit 0