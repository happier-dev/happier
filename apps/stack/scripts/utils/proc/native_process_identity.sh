# Shared native Linux process identity for admission and remote custody. The
# kernel start token guards PID reuse; '-' means no strong identity is available.
heavyweight_process_token() {
  heavyweight_token_pid=$1
  if [ -r "/proc/$heavyweight_token_pid/stat" ]; then
    # comm is parenthesized and can itself contain spaces or parentheses. The
    # state starts after its final closing delimiter; starttime is field 20
    # of that suffix, matching the cli-common process identity parser.
    heavyweight_token=$(awk '{sub(/^.*\) /, ""); print $20}' "/proc/$heavyweight_token_pid/stat" 2>/dev/null || true)
    case "$heavyweight_token" in ''|*[!0-9]*) ;; *) printf '%s' "$heavyweight_token"; return 0 ;; esac
  fi
  printf '%s' '-'
}

heavyweight_process_is_current() {
  heavyweight_current_pid=$1
  heavyweight_current_token=$2
  case "$heavyweight_current_pid" in ''|*[!0-9]*) return 1 ;; esac
  if [ "$heavyweight_current_token" = - ]; then
    kill -0 "$heavyweight_current_pid" 2>/dev/null
    return
  fi
  [ -r "/proc/$heavyweight_current_pid/stat" ] || return 1
  heavyweight_observed_token=$(heavyweight_process_token "$heavyweight_current_pid")
  [ "$heavyweight_observed_token" = "$heavyweight_current_token" ]
}
