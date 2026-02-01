#!/usr/bin/env bash
# Edison Hook: session-init
# Type: SessionStart
# Description: Initialize session context

# Consume hook payload from stdin (Claude Code sends JSON); ignore it.
cat >/dev/null 2>&1 || true

# Source shared guard and check execution scope
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [[ -f "$SCRIPT_DIR/_edison_guard.sh" ]]; then
    # shellcheck source=_edison_guard.sh
    source "$SCRIPT_DIR/_edison_guard.sh"
    edison_hook_guard "session-init" "session"
fi

command -v edison >/dev/null 2>&1 || exit 0

# Fail-open: hooks must never break the host toolchain.
edison session context 2>/dev/null || true

_edison_audit_event() {
  # Fail-open: audit must never break hooks.
  local event="$1"
  shift || true
  edison audit event "$event" \
    --repo-root "$PWD" \
    --field "hook_id=session-init" \
    --field "hook_type=SessionStart" \
    "$@" 2>/dev/null || true
}

_edison_audit_event "hook.session-init"

exit 0