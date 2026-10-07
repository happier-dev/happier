#!/bin/bash
# Remote command custody uses the existing execution PID file. Noninteractive
# controllers keep stdin open as a lifetime pipe; payload stdin remains closed
# unless the admitted runtime-build control channel explicitly forwards it.
# Parse before execution: source synchronization must not change a running
# command's remaining cleanup or status handling. Keep the same shell scope.
{

set -u
lifetime_stdin=${HAPPIER_REMOTE_EXEC_LIFELINE-0}
control_stdin=${HAPPIER_REMOTE_EXEC_CONTROL_STDIN-0}
unset HAPPIER_REMOTE_EXEC_LIFELINE
. "${BASH_SOURCE[0]%/*}/../proc/native_process_identity.sh"
mode=$1
pid_file=$2
execution_id=$3
shift 3

collect_descendants() {
  for child in $(ps -eo pid=,ppid= | awk -v parent="$1" '$2 == parent {print $1}'); do
    collect_descendants "$child"
  done
  printf '%s\n' "$1"
}

group_identities() {
  local member token
  for member in $(ps -eo pid=,pgid= | awk -v group="$1" '$2 == group {print $1}'); do
    token=$(heavyweight_process_token "$member")
    [ "$token" = - ] || printf '%s:%s ' "$member" "$token"
  done
}

group_has_current_member() {
  local identity member token current_group
  for identity in $2; do
    member=${identity%%:*}; token=${identity#*:}
    heavyweight_process_is_current "$member" "$token" || continue
    current_group=$(ps -p "$member" -o pgid= 2>/dev/null | tr -d ' ')
    [ "$current_group" = "$1" ] && return 0
  done
  return 1
}

finish_group_cancellation() {
  if group_has_current_member "$1" "$2"; then
    kill -KILL -- "-$1" 2>/dev/null || true
  elif kill -0 -- "-$1" 2>/dev/null; then
    printf '[preferred-execution] cancellation incomplete for remote process group %s of %s: original process identity unavailable; skipping delayed KILL\n' "$1" "$execution_id" >&2
  fi
}

cancel_record() {
  [ -f "$pid_file" ] || return 0
  pid=$(sed -n '1p' "$pid_file")
  case "$pid" in ''|*[!0-9]*) return 0 ;; esac
  command=$(ps -p "$pid" -o command= 2>/dev/null || true)
  case "$command" in *"$execution_id"*) ;; *) rm -f -- "$pid_file"; return 0 ;; esac
  recorded_token=$(sed -n '3p' "$pid_file")
  if [ -n "$recorded_token" ] && [ "$recorded_token" != - ] && ! heavyweight_process_is_current "$pid" "$recorded_token"; then
    rm -f -- "$pid_file"
    return 0
  fi
  root_token=$(heavyweight_process_token "$pid")
  group=$(sed -n '2p' "$pid_file")
  case "$group" in
    ''|*[!0-9]*) ;;
    *)
      group_parent=$(ps -p "$group" -o ppid= 2>/dev/null | tr -d ' ')
      group_id=$(ps -p "$group" -o pgid= 2>/dev/null | tr -d ' ')
      if [ "$group_parent" = "$pid" ] && [ "$group_id" = "$group" ]; then
        members=$(group_identities "$group")
        kill -TERM -- "-$group" 2>/dev/null || true
        sleep 2
        current_command=$(ps -p "$pid" -o command= 2>/dev/null || true)
        if heavyweight_process_is_current "$pid" "$root_token"; then
          case "$current_command" in
            *"$execution_id"*)
              finish_group_cancellation "$group" "$members"
              kill -TERM "$pid" 2>/dev/null || true
              ;;
          esac
        fi
        return 0
      fi
      ;;
  esac
  # Pin descendants before signaling them, then recheck the delayed KILL.
  # An interactive wrapper's fg builtin can defer TERM traps until the job
  # exits, so cancellation cannot rely on signaling only that wrapper.
  pids=$(collect_descendants "$pid")
  identities=
  for child in $pids; do
    [ "$child" = "$pid" ] && continue
    token=$(heavyweight_process_token "$child")
    if [ "$token" = - ]; then
      printf '[preferred-execution] cannot verify remote descendant %s of %s; leaving it untouched\n' "$child" "$execution_id" >&2
      continue
    fi
    identities="$identities $child:$token"
    heavyweight_process_is_current "$child" "$token" && kill -TERM "$child" 2>/dev/null || true
  done
  sleep 2
  for identity in $identities; do
    child=${identity%%:*}; token=${identity#*:}
    heavyweight_process_is_current "$child" "$token" && kill -KILL "$child" 2>/dev/null || true
  done
  if heavyweight_process_is_current "$pid" "$root_token"; then
    current_command=$(ps -p "$pid" -o command= 2>/dev/null || true)
    case "$current_command" in *"$execution_id"*) kill -TERM "$pid" 2>/dev/null || true ;; esac
  fi
  rm -f -- "$pid_file"
}

read_test_temp_root_users() {
  local observed_pid observed_group observed_state observed_uid binding observed_token
  test_temp_root_users=
  while read -r observed_pid observed_group observed_state observed_uid; do
    [ "$observed_uid" = "$UID" ] || continue
    case "$observed_state" in Z*) continue ;; esac
    # Read only the explicit non-secret custody binding. Unknown visibility for
    # a live process in this account means no deletion, never guessed absence.
    if ! {
      while IFS= read -r -d '' binding; do
        case "$binding" in HAPPIER_TEST_TEMP_ROOTS=*) test_temp_root_users="$test_temp_root_users
${binding#HAPPIER_TEST_TEMP_ROOTS=}" ;; esac
      done < "/proc/$observed_pid/environ"
    } 2>/dev/null; then
      [ ! -d "/proc/$observed_pid" ] && continue
      # A process born before the creator cannot have inherited a binding for
      # this uniquely allocated root. Same-tick births remain conservatively
      # unknown; unreadable newer processes prevent reclamation.
      observed_token=$(heavyweight_process_token "$observed_pid")
      case "$observed_token:$2" in *[!0-9:]*) return 1 ;; esac
      [ "$observed_token" -lt "$2" ] || return 1
    fi
  done <<< "$1"
}

reap_test_temp_roots() {
  # Marked producer teardown does not use an age deadline. The separately
  # requested historical sweep also checks cwd, descriptors and mappings.
  [ -r /proc/sys/kernel/random/boot_id ] || return 0
  local temp_parent boot_id directory marker owner_boot owner_pid owner_token owner_group snapshot test_temp_root_users
  temp_parent=${TMPDIR:-/tmp}
  boot_id=$(cat /proc/sys/kernel/random/boot_id) || return 0
  snapshot=$(ps -eo pid=,pgid=,stat=,uid=) || return 0
  for directory in "$temp_parent"/happier-stack-unit-* "$temp_parent"/happier-dev-test-* "$temp_parent"/happier-external-hooks-config-* "$temp_parent"/docs-check-*; do
    case "$directory" in *$'\n'*|*$'\r'*) continue ;; esac
    [ -d "$directory" ] && [ ! -L "$directory" ] && [ -O "$directory" ] || continue
    marker=$directory/.happier-test-temp-owner
    [ -f "$marker" ] && [ ! -L "$marker" ] && [ -O "$marker" ] || continue
    [ "$(sed -n '1p' "$marker")" = happier-test-temp-v1 ] || continue
    owner_boot=$(sed -n '2p' "$marker")
    owner_pid=$(sed -n '3p' "$marker")
    owner_token=$(sed -n '4p' "$marker")
    owner_group=$(sed -n '5p' "$marker")
    case "$owner_pid:$owner_token:$owner_group" in *[!0-9:]*|:*|*::*|*:) continue ;; esac
    [ "$owner_pid" -gt 1 ] && [ "$owner_group" -gt 1 ] || continue
    [ "$owner_boot" = "$boot_id" ] || continue
    heavyweight_process_is_current "$owner_pid" "$owner_token" && continue
    read_test_temp_root_users "$snapshot" "$owner_token" || continue
    printf '%s\n' "$test_temp_root_users" | grep -Fx -- "$directory" >/dev/null && continue
    # A live descendant remains an owner after its creator dies. Shared or
    # recycled groups are retained conservatively; no process is signaled.
    printf '%s\n' "$snapshot" | awk -v group="$owner_group" '$2 == group && $3 !~ /^Z/ {found=1} END {exit !found}' && continue
    # Recheck the group immediately before removal, rather than trusting an
    # earlier process snapshot while a dispatch or another reaper runs.
    snapshot=$(ps -eo pid=,pgid=,stat=,uid=) || return 0
    read_test_temp_root_users "$snapshot" "$owner_token" || continue
    printf '%s\n' "$test_temp_root_users" | grep -Fx -- "$directory" >/dev/null && continue
    printf '%s\n' "$snapshot" | awk -v group="$owner_group" '$2 == group && $3 !~ /^Z/ {found=1} END {exit !found}' && continue
    heavyweight_process_is_current "$owner_pid" "$owner_token" && continue
    printf '[preferred-execution] removing abandoned test temporary root %s\n' "$directory" >&2
    rm -rf -- "$directory"
  done
}

if [ "$mode" = reap-temp-roots ]; then
  # Explicit maintenance shares the custody owner, never its process-cancel
  # path. Unknown live-process visibility retains every historical candidate.
  exec node "${BASH_SOURCE[0]%/*}/historical_temp_roots.mjs" "${TMPDIR:-/tmp}"
fi

if [ "$mode" = test-temp-users ]; then
  # Test producers ask the same custody owner before deleting their root during
  # teardown. Only this non-secret binding is emitted; unknown observation
  # retains every root in the caller's cleanup batch.
  snapshot=$(ps -eo pid=,pgid=,stat=,uid=) || exit 2
  owner_token=$(sed -n '4p' "$pid_file/.happier-test-temp-owner" 2>/dev/null)
  case "$owner_token" in ''|*[!0-9]*) exit 2 ;; esac
  read_test_temp_root_users "$snapshot" "$owner_token" || exit 2
  printf '%s\n' "$test_temp_root_users"
  exit 0
fi

if [ "$mode" = cancel ]; then cancel_record; exit 0; fi
reap_test_temp_roots

# Legacy native records lack a lifetime pipe. Reap only a positively identified
# execution whose remote controller has been reparented to init; live SSH jobs
# and mismatched/reused PIDs never qualify.
requested_pid_file=$pid_file
requested_execution_id=$execution_id
for pid_file in "${requested_pid_file%/*}"/native-*.pid; do
  [ -f "$pid_file" ] || continue
  execution_id=${pid_file##*/}; execution_id=${execution_id%.pid}
  pid=$(sed -n '1p' "$pid_file")
  case "$pid" in ''|*[!0-9]*) continue ;; esac
  parent=$(ps -p "$pid" -o ppid= 2>/dev/null | tr -d ' ')
  if [ "$parent" = 1 ]; then
    printf '[preferred-execution] reaping orphaned remote execution %s\n' "$execution_id" >&2
    cancel_record
  elif [ -z "$parent" ]; then
    rm -f -- "$pid_file"
  fi
done
pid_file=$requested_pid_file
execution_id=$requested_execution_id
mkdir -p -- "${pid_file%/*}"
printf '%s\n' "$$" > "$pid_file"
remote_child_pid=
lifetime_pid=
control_pipe=
cleanup() {
  rm -f -- "$pid_file"
  [ -z "$control_pipe" ] || { exec 4>&-; rm -f -- "$control_pipe"; }
  [ -z "$lifetime_pid" ] || kill -TERM "$lifetime_pid" 2>/dev/null || true
  reap_test_temp_roots
}
terminate_command() {
  [ -n "$remote_child_pid" ] || return 0
  local members
  members=$(group_identities "$remote_child_pid")
  # Job control establishes a group for the command and all its descendants.
  kill -TERM -- "-$remote_child_pid" 2>/dev/null || true
  for ((attempt=0; attempt<20; attempt++)); do
    kill -0 -- "-$remote_child_pid" 2>/dev/null || return 0
    sleep 0.1
  done
  # The command leader may already have exited. An original member's positive
  # start identity plus its current PGID prevents signaling a recycled group.
  finish_group_cancellation "$remote_child_pid" "$members"
}
cancel() { trap '' HUP INT TERM; terminate_command; exit 130; }
trap cleanup EXIT
trap cancel HUP INT TERM
set -m
if [ "$lifetime_stdin" = 1 ]; then
  exec 3<&0
  if [ "$control_stdin" = 1 ]; then
    control_pipe="$pid_file.stdin"
    mkfifo -m 600 "$control_pipe" || exit 1
    exec 4<> "$control_pipe"
    (exec 3<&- 4>&-; "$@" < "$control_pipe") &
  else
    "$@" </dev/null &
  fi
else
  "$@" <&0 &
fi
remote_child_pid=$!
printf '%s\n%s\n%s\n' "$$" "$remote_child_pid" "$(heavyweight_process_token "$$")" > "$pid_file"
if [ "$lifetime_stdin" = 1 ]; then
  (
    [ -z "$control_pipe" ] || exec 4>&-
    # Read until the controller-owned writer disappears. No heartbeat, timeout,
    # external registry, or process-name scan supplies execution authority.
    while IFS= read -r line; do
      if [ "$control_stdin" = 1 ]; then printf '%s\n' "$line" > "$control_pipe"; fi
    done
    # Leader exit can make the wrapper's wait finish during TERM. Once EOF is
    # observed, cleanup must not interrupt the final KILL of stubborn children.
    trap '' HUP INT TERM
    kill -TERM "$$" 2>/dev/null || true
    terminate_command
    rm -f -- "$pid_file"
  ) <&3 &
  lifetime_pid=$!
  exec 3<&-
fi
if [ -t 0 ]; then fg %1; else wait "$remote_child_pid"; fi
command_status=$?
terminate_command
remote_child_pid=
exit "$command_status"
}
