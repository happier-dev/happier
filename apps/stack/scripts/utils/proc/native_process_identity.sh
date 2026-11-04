# Shared native Linux process identity for admission and remote custody. The
# kernel start token guards PID reuse; '-' means no strong identity is available.
heavyweight_read_process_token() {
  heavyweight_token_pid=$1
  heavyweight_process_token_value=-
  heavyweight_process_state=-
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
    heavyweight_process_state=$1
    shift 19
    case "$1" in ''|*[!0-9]*) ;; *) heavyweight_process_token_value=$1 ;; esac
  fi
}

heavyweight_process_token() {
  heavyweight_read_process_token "$1"
  printf '%s' "$heavyweight_process_token_value"
}

collect_descendants() (
  # Keep the iterator private to each recursive call in POSIX shells too.
  for child in $(ps -eo pid=,ppid= | awk -v parent="$1" '$2 == parent {print $1}'); do
    collect_descendants "$child"
  done
  printf '%s\n' "$1"
)

heavyweight_process_is_current() {
  heavyweight_current_pid=$1
  heavyweight_current_token=$2
  case "$heavyweight_current_pid" in ''|*[!0-9]*) return 1 ;; esac
  heavyweight_read_process_token "$heavyweight_current_pid"
  # PID existence and a matching start token also hold for an unreaped zombie.
  # Terminal tasks cannot execute work or retain a future resource envelope;
  # sleeping, blocked, stopped and orphaned live tasks still can.
  case "$heavyweight_process_state" in Z|X|x) return 1 ;; esac
  if [ "$heavyweight_current_token" = - ]; then
    kill -0 "$heavyweight_current_pid" 2>/dev/null
    return
  fi
  [ "$heavyweight_process_token_value" != - ] || return 1
  [ "$heavyweight_process_token_value" = "$heavyweight_current_token" ]
}

# Retirement is weaker than authenticated custody: an unreadable birth witness
# cannot authorize reuse, but also cannot prove that a reservation is gone.
# Keep parity with ownership.mjs#isRecordedStackProcessRetired: definite absence,
# birth mismatch retires; inconclusive observations retain custody. Native
# records carry boot-relative ticks, not a wall-clock birth/boot witness, so a
# reboot alone cannot prove retirement of a legacy record with matching ticks.
# Callers observe only their host's kernel PID space and host-local records.
heavyweight_process_is_provably_retired() {
  heavyweight_retired_pid=$1
  heavyweight_retired_token=$2
  heavyweight_process_state=-
  case "$heavyweight_retired_pid" in ''|*[!0-9]*|0) return 0 ;; esac
  [ "${#heavyweight_retired_pid}" -le 10 ] && [ "$heavyweight_retired_pid" -le 2147483647 ] || return 0
  heavyweight_read_process_token "$heavyweight_retired_pid"
  case "$heavyweight_process_state" in Z|X|x) return 0 ;; esac
  if [ "$heavyweight_retired_token" != - ] && [ "$heavyweight_process_token_value" != - ] \
    && [ "$heavyweight_retired_token" != "$heavyweight_process_token_value" ]; then return 0; fi
  kill -0 "$heavyweight_retired_pid" 2>/dev/null && return 1
  # POSIX shell kill has no errno API. Its C-locale ESRCH diagnostic is the
  # native boundary adapter; permission and every unknown error remain present.
  heavyweight_absence_error=$(LC_ALL=C kill -0 "$heavyweight_retired_pid" 2>&1) && return 1
  case "$heavyweight_absence_error" in *'No such process'*) return 0 ;; *) return 1 ;; esac
}
