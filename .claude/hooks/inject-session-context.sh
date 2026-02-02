#!/usr/bin/env bash
# Edison Hook: inject-session-context
# Type: UserPromptSubmit
# Description: Inject `edison session context` output before prompt
# Blocking: NO (always exit 0)

# This hook is intentionally tiny and deterministic.
# Delegate all context building to `edison session context` so:
# - SessionStart/PreCompact/UserPromptSubmit can share the same payload
# - Hooks remain safe without jq/other external deps

# Consume hook payload from stdin (Claude Code sends JSON); ignore it.
cat >/dev/null 2>&1 || true

# Source shared guard and check execution scope
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [[ -f "$SCRIPT_DIR/_edison_guard.sh" ]]; then
    # shellcheck source=_edison_guard.sh
    source "$SCRIPT_DIR/_edison_guard.sh"
    edison_hook_guard "inject-session-context" "session"
fi

command -v edison >/dev/null 2>&1 || exit 0

# Fail-open: hooks must never break the host toolchain.
edison session context 2>/dev/null || true

exit 0