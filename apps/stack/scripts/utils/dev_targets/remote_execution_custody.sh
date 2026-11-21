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
. "${BASH_SOURCE[0]%/*}/../proc/native_process_priority.sh" || exit 1
. "${BASH_SOURCE[0]%/*}/native_execution_signals.sh" || exit 1
mode=$1
pid_file=$2
execution_id=$3
initiating_execution_id=$execution_id
shift 3
if [ "$mode" = run ] && { [ "${HAPPIER_REMOTE_EXEC_SCRIPT_STDIN-0}" = 1 ] || [ -n "${HAPPIER_REMOTE_EXEC_SCRIPT_FILE-}" ]; }; then
  # hstack-exec sends the command's final operand (its remote script) as a
  # frame: the byte count on one line, then the bytes. Quoted into the SSH
  # command it would exceed the per-argument exec limit (Linux MAX_ARG_STRLEN,
  # 128 KiB). It arrives on stdin ahead of the lifetime pipe, or for a --tty
  # command (whose stdin is a terminal) in a file this custody consumes. Read
  # exactly that count so the lifeline stays unread; macOS bash 3.2 lacks
  # read -N and reads byte by byte instead.
  # The controller sends the frame as soon as SSH starts, so its arrival is
  # bounded by the SSH liveness window the controller passes (keepalive
  # interval x count); a controller that never sends it fails here, named,
  # instead of leaving this custody blocked on the open lifetime pipe.
  remote_script_wait=${HAPPIER_REMOTE_EXEC_SCRIPT_WAIT_SECONDS-}
  case "$remote_script_wait" in
    ''|*[!0-9]*|0) printf '%s\n' '[preferred-execution] remote script frame has no arrival window (HAPPIER_REMOTE_EXEC_SCRIPT_WAIT_SECONDS)' >&2; exit 255 ;;
  esac
  remote_script_missing() {
    if [ "$1" -gt 128 ]; then
      printf '[preferred-execution] remote script frame did not arrive in full within %s s; the controller never sent it\n' "$remote_script_wait" >&2
    else
      printf '%s\n' "$2" >&2
    fi
    exit 255
  }
  if [ -n "${HAPPIER_REMOTE_EXEC_SCRIPT_FILE-}" ]; then
    exec 6< "$HAPPIER_REMOTE_EXEC_SCRIPT_FILE" || exit 255
    rm -f -- "$HAPPIER_REMOTE_EXEC_SCRIPT_FILE"
  else
    exec 6<&0
  fi
  IFS= read -r -t "$remote_script_wait" remote_script_bytes <&6 || remote_script_missing $? '[preferred-execution] remote script frame is malformed'
  case "$remote_script_bytes" in
    ''|*[!0-9]*) printf '%s\n' '[preferred-execution] remote script frame is malformed' >&2; exit 255 ;;
  esac
  if [ "${BASH_VERSINFO[0]}" -gt 4 ] || { [ "${BASH_VERSINFO[0]}" -eq 4 ] && [ "${BASH_VERSINFO[1]}" -ge 1 ]; }; then
    LC_ALL=C IFS= read -r -t "$remote_script_wait" -N "$remote_script_bytes" remote_script <&6
  else
    LC_ALL=C IFS= read -r -t "$remote_script_wait" -d '' -n "$remote_script_bytes" remote_script <&6
  fi || remote_script_missing $? '[preferred-execution] remote script ended before its declared length'
  exec 6<&-
  set -- "$@" "$remote_script"
  unset remote_script remote_script_bytes
fi
unset HAPPIER_REMOTE_EXEC_SCRIPT_STDIN HAPPIER_REMOTE_EXEC_SCRIPT_FILE HAPPIER_REMOTE_EXEC_SCRIPT_WAIT_SECONDS

exec_worker_payload() {
  # All Linux worker payloads share scheduling, including unclassified commands
  # and controlled QA browsers. Nested admission inherits the existing slice.
  case "$(uname -s)" in
    Linux) exec_in_jobs_slice "$@" ;;
    *) exec "$@" ;;
  esac
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

signal_member() {
  native_execution_signal "$execution_id" "$initiating_execution_id" "$@"
  return "$native_signal_result"
}

publish_record() {
  # Publish one complete identity before the payload starts. Readers must never
  # observe a truncated rewrite of the execution's sole custody record.
  printf '%s\n%s\n%s\n%s\n' "$1" "$2" "$3" "$4" > "$pid_file.next" &&
    mv -f -- "$pid_file.next" "$pid_file"
}

if [ "$mode" = payload ]; then
  wrapper_pid=$1
  wrapper_token=$2
  shift 2
  publish_record "$wrapper_pid" "$$" "$wrapper_token" "$(heavyweight_process_token "$$")" || exit 1
  jobs_scope_owner_pid=$wrapper_pid
  jobs_scope_owner_token=$wrapper_token
  # A routed payload (a typecheck, a test run) consumes the installed tree for
  # its whole run: keep the dependency generation it starts on until this
  # process (the payload, after exec) exits, so a refresh never retires it
  # underneath. Only generation-managed checkouts have one to keep.
  custody_checkout=${BASH_SOURCE[0]%/apps/stack/scripts/utils/dev_targets/*}
  if [ -L "$custody_checkout/node_modules/.happier-dependency-generation" ]; then
    { [ -n "${HAPPIER_REMOTE_EXEC_NODE-}" ] &&
      "$HAPPIER_REMOTE_EXEC_NODE" "$custody_checkout/apps/stack/scripts/utils/proc/retain_dependency_generation.mjs" "$custody_checkout" "$$"; } \
      || printf '%s\n' '[preferred-execution] dependency generation retention failed; this payload may lose its installed tree to a concurrent refresh' >&2
  fi
  unset HAPPIER_REMOTE_EXEC_NODE
  exec_worker_payload "$@"
fi

finish_group_cancellation() {
  if group_has_current_member "$1" "$2"; then
    signal_member "$3" KILL pgid "$1" "$2"
  elif kill -0 -- "-$1" 2>/dev/null; then
    printf '[preferred-execution] cancellation incomplete for remote process group %s of %s: original process identity unavailable; skipping delayed KILL\n' "$1" "$execution_id" >&2
    return 1
  fi
}

# A job group misses descendants that changed their session (including an
# admitted foreground launcher). Collect them before TERM can reparent them.
descendant_identities() {
  local member token
  for member in $(ps -eo pid=,ppid=,pgid= | awk -v root="$1" -v group="$2" '
    { parent[$1]=$2; pgid[$1]=$3 }
    END {
      for (pid in parent) {
        if (pid == root || pgid[pid] == group) continue
        for (ancestor=parent[pid]; ancestor > 1 && ancestor in parent; ancestor=parent[ancestor]) {
          if (ancestor == root) { print pid; break }
        }
      }
    }'); do
    token=$(heavyweight_process_token "$member")
    if [ "$token" != - ]; then printf '%s:%s ' "$member" "$token"; fi
  done
}

signal_current_descendants() {
  local reason=$1 signal=$2 identity member token result=0
  for identity in $3; do
    member=${identity%%:*}; token=${identity#*:}
    if heavyweight_process_is_current "$member" "$token"; then
      if ! signal_member "$reason" "$signal" pid "$member" "$identity" &&
          [ "$signal" = KILL ] && heavyweight_process_is_current "$member" "$token"; then
        result=1
      fi
    fi
  done
  return "$result"
}

owned_jobs_scope() {
  local unit
  [ -d /proc/self ] || return 1
  case "$1:$2" in *[!0-9:]*|:*|*:) return 1 ;; esac
  unit=$(jobs_scope_unit "$1" "$2")
  [ "$(systemctl --user show "$unit" --property=LoadState --value 2>/dev/null)" = loaded ] || return 1
  printf '%s' "$unit"
}

stop_owned_jobs_scope() {
  signal_member "$1" KILL scope "$2" '' || true
  # Stop waits for the unit, so its admission client's lifetime socket closes
  # through the existing broker release protocol.
  if systemctl --user stop "$2" >/dev/null 2>&1; then return 0; fi
  case "$(systemctl --user show "$2" --property=ActiveState --value 2>/dev/null)" in
    inactive|failed) return 0 ;;
  esac
  printf '[preferred-execution] cancellation incomplete for remote job scope %s of %s\n' "$2" "$execution_id" >&2
  return 1
}

cancel_owned_group() {
  local reason=$1 group=$2 group_token=$3 scope=$4 members identities result=0
  members=$(group_identities "$group")
  identities=$(descendant_identities "$group" "$group")
  if [ -n "$group_token" ] && ! heavyweight_process_is_current "$group" "$group_token"; then return 1; fi
  if [ -n "$scope" ]; then signal_member "$reason" TERM scope "$scope" '' || true; fi
  signal_current_descendants "$reason" TERM "$identities"
  signal_member "$reason" TERM pgid "$group" "$members"
  sleep 2
  signal_current_descendants "$reason" KILL "$identities" || result=$?
  finish_group_cancellation "$group" "$members" "$reason" || result=$?
  if [ -n "$scope" ]; then stop_owned_jobs_scope "$reason" "$scope" || result=$?; fi
  return "$result"
}

cancel_record() {
  local reason=${1:-custody_cancel} identities scope result=0
  [ -f "$pid_file" ] || return 0
  pid=$(sed -n '1p' "$pid_file")
  case "$pid" in ''|*[!0-9]*) return 0 ;; esac
  recorded_token=$(sed -n '3p' "$pid_file")
  group=$(sed -n '2p' "$pid_file")
  group_token=$(sed -n '4p' "$pid_file")
  if heavyweight_process_is_provably_retired "$pid" "${recorded_token:--}"; then
    # The birth token still identifies a live process group or an owned Linux
    # scope when its original wrapper has been retired.
    scope=$(owned_jobs_scope "$pid" "${recorded_token:--}") || scope=
    if [ "$group_token" != - ] && heavyweight_process_is_current "$group" "$group_token" &&
        [ "$(ps -p "$group" -o pgid= 2>/dev/null | tr -d ' ')" = "$group" ]; then
      cancel_owned_group "$reason" "$group" "$group_token" "$scope" || return $?
    elif [ -n "$scope" ]; then
      stop_owned_jobs_scope "$reason" "$scope" || return $?
    fi
    rm -f -- "$pid_file"
    return 0
  fi
  command=$(ps -p "$pid" -o command= 2>/dev/null || true)
  case "$command" in *"$execution_id"*) ;; *) rm -f -- "$pid_file"; return 0 ;; esac
  recorded_token=$(sed -n '3p' "$pid_file")
  if [ -n "$recorded_token" ] && [ "$recorded_token" != - ] && ! heavyweight_process_is_current "$pid" "$recorded_token"; then
    rm -f -- "$pid_file"
    return 0
  fi
  root_token=$(heavyweight_process_token "$pid")
  scope=$(owned_jobs_scope "$pid" "$root_token") || scope=
  case "$group" in
    ''|*[!0-9]*) ;;
    *)
      group_parent=$(ps -p "$group" -o ppid= 2>/dev/null | tr -d ' ')
      group_id=$(ps -p "$group" -o pgid= 2>/dev/null | tr -d ' ')
      if [ "$group_parent" = "$pid" ] && [ "$group_id" = "$group" ] &&
          { [ -z "$group_token" ] || heavyweight_process_is_current "$group" "$group_token"; }; then
        if ! heavyweight_process_is_current "$pid" "$root_token"; then return 1; fi
        cancel_owned_group "$reason" "$group" "$group_token" "$scope" || result=$?
        if heavyweight_process_is_current "$pid" "$root_token"; then
          signal_member "$reason" TERM pid "$pid" "$pid:$root_token" || true
        fi
        return "$result"
      fi
      ;;
  esac
  # An interactive wrapper can defer TERM in fg. When there is no dedicated
  # PGID, snapshot the same command's descendants and signal them directly.
  identities=$(descendant_identities "$pid" '')
  if ! heavyweight_process_is_current "$pid" "$root_token"; then return 1; fi
  if [ -n "$scope" ]; then signal_member "$reason" TERM scope "$scope" '' || true; fi
  signal_current_descendants "$reason" TERM "$identities"
  sleep 2
  signal_current_descendants "$reason" KILL "$identities" || result=$?
  if [ -n "$scope" ]; then stop_owned_jobs_scope "$reason" "$scope" || result=$?; fi
  if heavyweight_process_is_current "$pid" "$root_token"; then
    signal_member "$reason" TERM pid "$pid" "$pid:$root_token" || true
  fi
  [ "$result" -ne 0 ] || rm -f -- "$pid_file"
  return "$result"
}

read_test_temp_root_users() {
  # One owner observes native and historical custody. Query only bindings for
  # native teardown; same-UID denial reuses its read-only privileged observer.
  # The probe is not a consumer and must not publish inherited temp bindings.
  # Reclamation passes $2=--references: a root is in use by a process working in
  # it (cwd, descriptor, mapping) even after that process dropped the binding.
  test_temp_root_users=$(TMPDIR= HAPPIER_TEST_TEMP_ROOTS= node "${BASH_SOURCE[0]%/*}/historical_temp_roots.mjs" --test-temp-users --census ${2-} <<< "$1")
}

reap_test_temp_roots() {
  # Marked producer teardown does not use an age deadline. The separately
  # requested historical sweep also checks cwd, descriptors and mappings.
  [ -r /proc/sys/kernel/random/boot_id ] || return 0
  local temp_parent boot_id directory marker owner_boot owner_pid owner_token owner_group snapshot test_temp_root_users index
  local -a candidates=() candidate_pids=() candidate_tokens=() candidate_groups=()
  temp_parent=${TMPDIR:-/tmp}
  boot_id=$(cat /proc/sys/kernel/random/boot_id) || return 0
  # The marker is the producer's authority; the name families are the ones the
  # historical owner may remove (knownRoot), so unrelated marked scratch stays.
  for directory in "$temp_parent"/happier-* "$temp_parent"/hstack-* "$temp_parent"/docs-check-*; do
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
    candidates+=("$directory"); candidate_pids+=("$owner_pid"); candidate_tokens+=("$owner_token"); candidate_groups+=("$owner_group")
  done
  [ "${#candidates[@]}" -gt 0 ] || return 0
  # A live descendant remains an owner after its creator dies; shared or
  # recycled groups are retained conservatively; no process is signaled. That
  # retention needs only the process snapshot, so it is decided first and the
  # census runs only when some candidate is still undecided (every top-level
  # test producer runs this pass at exit; a full census costs seconds of CPU).
  snapshot=$(ps -eo pid=,pgid=,stat=,uid=) || return 0
  local -a undecided=()
  for index in "${!candidates[@]}"; do
    printf '%s\n' "$snapshot" | awk -v group="${candidate_groups[$index]}" '$2 == group && $3 !~ /^Z/ {found=1} END {exit !found}' && continue
    undecided+=("$index")
  done
  [ "${#undecided[@]}" -gt 0 ] || return 0
  # One fresh observation of every remaining candidate, taken after discovery
  # and immediately before removal (a per-root census scales with the abandoned
  # set). It includes cwd, descriptors and mappings: a process working in a
  # root uses it even after dropping the binding.
  read_test_temp_root_users "$snapshot" --references || return 0
  for index in "${undecided[@]}"; do
    directory=${candidates[$index]}
    printf '%s\n' "$test_temp_root_users" | grep -Fx -- "$directory" >/dev/null && continue
    heavyweight_process_is_current "${candidate_pids[$index]}" "${candidate_tokens[$index]}" && continue
    printf '[preferred-execution] removing abandoned test temporary root %s\n' "$directory" >&2
    rm -rf -- "$directory" 2>/dev/null || node "${BASH_SOURCE[0]%/*}/historical_temp_roots.mjs" --remove-owned-temp-root "$directory"
  done
}

if [ "$mode" = reap-temp-roots ]; then
  # Explicit maintenance shares the custody owner, never its process-cancel
  # path. Unknown UID or same-UID visibility retains historical candidates.
  exec node "${BASH_SOURCE[0]%/*}/historical_temp_roots.mjs" "${TMPDIR:-/tmp}"
fi

if [ "$mode" = reap-test-temp-roots ]; then
  reap_test_temp_roots
  exit 0
fi

if [ "$mode" = test-temp-users ]; then
  # Test producers ask the same custody owner before deleting their root during
  # teardown. Only this non-secret binding is emitted; unknown observation
  # retains every root in the caller's cleanup batch.
  snapshot=$(ps -eo pid=,pgid=,stat=,uid=) || exit 2
  owner_token=$(sed -n '4p' "$pid_file/.happier-test-temp-owner" 2>/dev/null)
  case "$owner_token" in ''|*[!0-9]*) exit 2 ;; esac
  read_test_temp_root_users "$snapshot" || exit 2
  printf '%s\n' "$test_temp_root_users"
  exit 0
fi

if [ "$mode" = cancel ]; then
  initiating_execution_id=${2:-$execution_id}
  cancel_record "${1:-custody_cancel}"
  exit $?
fi
# Linux uses the disk-backed root already swept by worker disk maintenance.
# Explicit TMPDIR remains caller-owned; never relocate an active scratch tree.
command_temp=
command_temp_parent=
command_temp_token=
command_temp_group=
if [ -z "${TMPDIR-}" ]; then
  if [ -d /proc/self ]; then
    command_temp_parent=/var/tmp
  else
    TMPDIR="${pid_file%/remote-exec/*}/tmp"
    mkdir -p -m 700 -- "$TMPDIR" || exit 1
    export TMPDIR
  fi
fi
# Shared historical/test scratch is explicit maintenance, not launch work.

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
    cancel_record reaper_orphan
  elif [ -z "$parent" ]; then
    # Wrapper loss does not prove its recorded worker group has finished.
    cancel_record reaper_orphan
  fi
done
pid_file=$requested_pid_file
execution_id=$requested_execution_id
HAPPIER_REMOTE_EXECUTION_ID=$execution_id
export HAPPIER_REMOTE_EXECUTION_ID
mkdir -p -- "${pid_file%/*}"
wrapper_token=$(heavyweight_process_token "$$")
publish_record "$$" '' "$wrapper_token" '' || exit 1
remote_child_pid=
lifetime_pid=
lifetime_token=
termination_reason=completed
control_pipe=
cleanup() {
  rm -f -- "$pid_file"
  [ -z "$control_pipe" ] || { exec 4>&-; rm -f -- "$control_pipe"; }
  if [ -n "$lifetime_pid" ] && heavyweight_process_is_current "$lifetime_pid" "$lifetime_token"; then
    signal_member "$termination_reason" TERM pid "$lifetime_pid" "$lifetime_pid:$lifetime_token"
  fi
  [ -z "$lifetime_pid" ] || wait "$lifetime_pid" 2>/dev/null || true
  if [ -n "$command_temp" ]; then
    # Producer custody owns lifetime. Detached descendants can drop TMPDIR;
    # the canonical reaper also checks cwd, descriptors, mappings and inodes.
    local snapshot
    case "$command_temp_token" in ''|*[!0-9]*) return ;; esac
    case "$command_temp" in *$'\n'*|*$'\r'*) return ;; esac
    snapshot=$(ps -eo pid=,pgid=,stat=,uid=) || return
    printf '%s\n' "$snapshot" | awk -v group="$command_temp_group" '$2 == group && $3 !~ /^Z/ {found=1} END {exit !found}' && return
    [ -d "$command_temp" ] && [ ! -L "$command_temp" ] && [ -O "$command_temp" ] || return
    TMPDIR= HAPPIER_TEST_TEMP_ROOTS= node "${BASH_SOURCE[0]%/*}/historical_temp_roots.mjs" --reap-command-temp-root "$command_temp" <<< "$snapshot"
  fi
}
terminate_command() {
  local reason=${1:-completed}
  [ -n "$remote_child_pid" ] || return 0
  if [ "${HAPPIER_STACK_PROCESS_KIND-}" = browser ] && [ "$control_stdin" = 1 ]; then
    # Browser close owns detached Chromium and may outlive the generic group
    # grace. Reuse its control channel: repeated TERM could also interrupt the
    # worker's close subprocess via ordinary foreground signal forwarding.
    # The original parent reaps it; the lifeline reader is not its wait owner.
    # A reaped child must not authorize a recycled PID. The existing parent
    # edge identifies this still-owned worker without another custody record.
    if [ "$(ps -p "$remote_child_pid" -o ppid= 2>/dev/null | tr -d ' ')" = "$$" ]; then
      printf 'close\n' > "$control_pipe" || return 1
    fi
    # In the reader subshell this is not our child and wait returns immediately;
    # only the original parent can reap it. No Bash-4-only BASHPID is required.
    wait "$remote_child_pid" 2>/dev/null || true
    return 0
  fi
  # The scope, unlike a process group, retains admitted/detached workers.
  # Name only the scope this wrapper could have created; inherited scopes
  # belong to their containing executor and are never cancelled here.
  local members owned_scope=
  if [ "$reason" != completed ] && owned_scope=$(owned_jobs_scope "$$" "$wrapper_token"); then
    printf '[preferred-execution] stopping owned job scope %s (reason=%s)\n' "$owned_scope" "$reason" >&2
    signal_member "$reason" TERM scope "$owned_scope" '' || true
  fi
  members=$(group_identities "$remote_child_pid")
  kill -0 -- "-$remote_child_pid" 2>/dev/null || [ -n "$owned_scope" ] || return 0
  # Job control establishes a group for the command and all its descendants.
  signal_member "$reason" TERM pgid "$remote_child_pid" "$members"
  for ((attempt=0; attempt<20; attempt++)); do
    kill -0 -- "-$remote_child_pid" 2>/dev/null || [ -n "$owned_scope" ] || return 0
    sleep 0.1
  done
  # The command leader may already have exited. An original member's positive
  # start identity plus its current PGID prevents signaling a recycled group.
  finish_group_cancellation "$remote_child_pid" "$members" "$reason"
  if [ -n "$owned_scope" ]; then
    # Reuse custody's existing TERM grace above, including when the group
    # leader departed before its detached workers. Admission releases its
    # existing slot through socket close; there is no separate release path.
    stop_owned_jobs_scope "$reason" "$owned_scope"
  fi
}
# Teardown outlives the controller's output readers: a dead SSH dispatcher
# closes stdout/stderr with the lifeline, and the first diagnostic write would
# otherwise SIGPIPE custody before it stops the payload. Ignore PIPE only here,
# never before the payload starts, so the payload keeps the default disposition.
cancel() { trap '' HUP INT TERM PIPE; termination_reason=signal; terminate_command "$termination_reason"; exit 130; }
trap cleanup EXIT
trap cancel HUP INT TERM
if [ -n "$command_temp_parent" ]; then
  # Acquire scratch after installing the teardown traps. The 45-byte Chromium
  # socket suffix leaves 62 bytes of the 107-byte Linux limit for TMPDIR.
  # /var/tmp/hstack-XXXXXX is 22 bytes, independent of the target name.
  command_temp=$(mktemp -d "$command_temp_parent/hstack-XXXXXX") || exit 1
  command_temp_token=$(heavyweight_process_token "$$")
  export TMPDIR="$command_temp"
fi
# The dispatcher has already projected the worker's login PATH. Select Node
# from that same environment before handing off to the non-login payload.
HAPPIER_REMOTE_EXEC_NODE=$(command -v node)
export HAPPIER_REMOTE_EXEC_NODE
set -m
if [ "$lifetime_stdin" = 1 ]; then
  exec 3<&0
  if [ "$control_stdin" = 1 ]; then
    control_pipe="$pid_file.stdin"
    mkfifo -m 600 "$control_pipe" || exit 1
    exec 4<> "$control_pipe"
    (exec 3<&- 4>&-; exec bash "${BASH_SOURCE[0]}" payload "$pid_file" "$execution_id" "$$" "$wrapper_token" "$@" < "$control_pipe") &
  else
    # The lifeline belongs only to the custody reader. A payload's descendant
    # tree must not inherit this private descriptor as it launches more work.
    (exec 3<&-; exec bash "${BASH_SOURCE[0]}" payload "$pid_file" "$execution_id" "$$" "$wrapper_token" "$@" </dev/null) &
  fi
else
  bash "${BASH_SOURCE[0]}" payload "$pid_file" "$execution_id" "$$" "$wrapper_token" "$@" <&0 &
fi
remote_child_pid=$!
command_temp_group=$remote_child_pid
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
    trap '' HUP INT TERM PIPE
    signal_member lifeline_eof TERM pid "$$" "$$:$wrapper_token"
    terminate_command lifeline_eof
    rm -f -- "$pid_file"
  ) <&3 &
  lifetime_pid=$!
  lifetime_token=$(heavyweight_process_token "$lifetime_pid")
  exec 3<&-
fi
if [ -t 0 ]; then fg %1; else wait "$remote_child_pid"; fi
command_status=$?
terminate_command
remote_child_pid=
exit "$command_status"
}
