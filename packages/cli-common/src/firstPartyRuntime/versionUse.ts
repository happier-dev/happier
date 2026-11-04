/**
 * Native file-use evidence, shared by local activation and remote retention.
 * The native PID inventory protects script roots even when their host executable
 * lives elsewhere and the script has closed. lsof additionally protects open
 * executables, support files and working directories inside the payload.
 * One census covers the versions root for each prune invocation. Only available,
 * diagnostic-free observations permit deletion; their output stays in the shell.
 * A live PID, denied observation, missing lsof or any other error retains it.
 * Inspect the whole payload: the executable and its loaded support files can differ.
 */
export const FIRST_PARTY_VERSION_USE_SHELL_FUNCTIONS = `observe_version_use() {
  if ! version_commands="$(ps -A -ww -o args= 2>&1)"; then return 1; fi
  [ -n "$version_commands" ] || return 1
  if version_usage="$(lsof -Fn +D "$1" 2>&1)"; then
    [ -n "$version_usage" ] || return 1
    printf '%s\\n' "$version_usage" | while IFS= read -r line; do
      case "$line" in
        p*) case "\${line#p}" in ''|*[!0-9]*) exit 1;; esac;;
        n/*) ;;
        *) exit 1;;
      esac
    done
  else
    usage_status="$?"
    [ "$usage_status" -eq 1 ] && [ -z "$version_usage" ]
  fi
}
is_version_unused() {
  case "$version_commands" in *"$1/"*) return 1;; esac
  case "$version_usage
" in *"n$1/"*|*"n$1
"*) return 1;; esac
}`;
