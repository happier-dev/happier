/**
 * Native file-use evidence, shared by local activation and remote retention.
 * The native PID inventory protects script roots even when their host executable
 * lives elsewhere and the script has closed. lsof additionally protects open
 * executables, support files and working directories inside the payload.
 * Only an available PID inventory plus lsof's diagnostic-free "no matches"
 * permits deletion. Neither command's output leaves this native observation.
 * A live PID, denied observation, missing lsof or any other error retains it.
 * Inspect the whole payload: the executable and its loaded support files can differ.
 */
export const FIRST_PARTY_VERSION_UNUSED_SHELL_FUNCTION = 'is_version_unused() { if ! commands="$(ps -A -ww -o args= 2>&1)"; then return 1; fi; [ -n "$commands" ] || return 1; case "$commands" in *"$1/"*) return 1;; esac; if usage="$(lsof -t +D "$1" 2>&1)"; then return 1; else usage_status="$?"; fi; [ "$usage_status" -eq 1 ] && [ -z "$usage" ]; }';
