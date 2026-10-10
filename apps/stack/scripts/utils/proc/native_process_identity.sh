# Shared native Linux process identity for admission and remote custody. The
# kernel start token guards PID reuse; '-' means no strong identity is available.
heavyweight_read_process_token() {
  heavyweight_token_pid=$1
  heavyweight_process_token_value=-
  if [ -r "/proc/$heavyweight_token_pid/stat" ]; then
    # comm is parenthesized and can itself contain spaces or parentheses. The
    # state starts after its final closing delimiter; starttime is field 20
    # of that suffix, matching the cli-common process identity parser.
    heavyweight_stat=
    while IFS= read -r heavyweight_stat_line; do
      heavyweight_stat="$heavyweight_stat $heavyweight_stat_line"
    done 2>/dev/null < "/proc/$heavyweight_token_pid/stat" || return 0
    heavyweight_stat_fields=${heavyweight_stat##*) }
    [ "$heavyweight_stat_fields" != "$heavyweight_stat" ] || return 0
    # Kernel fields after comm contain no glob characters; split only those
    # numeric/state fields. Function positional parameters do not affect callers.
    set -- $heavyweight_stat_fields
    [ "$#" -ge 20 ] || return 0
    shift 19
    case "$1" in ''|*[!0-9]*) ;; *) heavyweight_process_token_value=$1 ;; esac
  fi
}

heavyweight_process_token() {
  heavyweight_read_process_token "$1"
  printf '%s' "$heavyweight_process_token_value"
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
  heavyweight_read_process_token "$heavyweight_current_pid"
  [ "$heavyweight_process_token_value" = "$heavyweight_current_token" ]
}
