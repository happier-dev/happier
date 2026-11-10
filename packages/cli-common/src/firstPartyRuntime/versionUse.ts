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
  # Linux hidepid can silently omit other users from an otherwise successful ps.
  if [ -d /proc ]; then
    version_mounts="$(cat /proc/mounts 2>/dev/null)" || return 1
    version_proc_visible=false
    while read -r version_device version_mount version_fs version_options version_rest; do
      if [ "$version_mount" = /proc ] && [ "$version_fs" = proc ]; then
        case ",$version_options," in
          *,hidepid=0,*|*,hidepid=off,*) ;;
          *,hidepid=*) return 1;;
        esac
        version_proc_visible=true
      fi
    done <<EOF
$version_mounts
EOF
    [ "$version_proc_visible" = true ] || return 1
  fi
  version_owner_uid="$(id -u 2>/dev/null)" || return 1
  case "$version_owner_uid" in ''|*[!0-9]*) return 1;; esac
  if ! version_commands="$(ps -A -ww -o uid=,args= 2>&1)"; then return 1; fi
  [ -n "$version_commands" ] || return 1
  # Member launches name current/, and unprivileged lsof cannot see their files.
  version_install_root="\${1%/versions}"
  while read -r version_uid version_args; do
    case "$version_uid" in ''|*[!0-9]*) return 1;; esac
    if [ "$version_uid" != "$version_owner_uid" ]; then
      case "$version_args" in *"$version_install_root/"*) return 1;; esac
    fi
  done <<EOF
$version_commands
EOF
  # +D expands to individual search terms; unused files are expected, not
  # observation failures. -Q ignores those misses while preserving real errors.
  if version_usage="$(lsof -Q -Fn +D "$1" 2>&1)"; then
    [ -z "$version_usage" ] && return 0
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
