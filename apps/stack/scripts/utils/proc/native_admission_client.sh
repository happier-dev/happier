# Linux admission transport. Capacity and queue facts belong to the host broker;
# the native command policy remains the only class/floor authority.
admission_client="$script_dir/../scripts/utils/proc/admission_client.mjs"

# Finite pre-broker hstack-exec compatibility; remove with the client adapter.
# Authenticate only the exported owner, never discover another ancestor's job.
has_legacy_inherited_admission() {
  legacy_identity=${HAPPIER_HEAVYWEIGHT_ADMISSION_TOKEN-}
  legacy_root=${HAPPIER_HEAVYWEIGHT_ADMISSION_ROOT-}
  legacy_machine=${HAPPIER_HEAVYWEIGHT_ADMISSION_MACHINE-}
  case "$legacy_identity" in
    *:*) legacy_pid=${legacy_identity%%:*}; legacy_birth=${legacy_identity#*:} ;;
    *) return 1 ;;
  esac
  case "$legacy_pid:$legacy_birth" in ''|*[!0-9:]*|*:*:*) return 1 ;; esac
  [ -n "$legacy_pid" ] && [ -n "$legacy_birth" ] && [ "$legacy_birth" != 0 ] || return 1
  case "$legacy_root" in /*) ;; *) return 1 ;; esac
  legacy_owner="$legacy_root/owners/$legacy_pid-$legacy_birth"
  [ -d "$legacy_owner" ] || return 1
  IFS=' ' read -r legacy_recorded_pid legacy_recorded_birth 2>/dev/null < "$legacy_owner/process" || return 1
  [ "$legacy_recorded_pid" = "$legacy_pid" ] && [ "$legacy_recorded_birth" = "$legacy_birth" ] || return 1
  legacy_recorded_machine=$(sed -n '1p' "$legacy_owner/machine" 2>/dev/null) || return 1
  [ -n "$legacy_machine" ] && [ "$legacy_recorded_machine" = "$legacy_machine" ] || return 1
  heavyweight_process_is_current "$legacy_pid" "$legacy_birth" || return 1
  legacy_ancestor=$$
  while [ "$legacy_ancestor" != "$legacy_pid" ]; do
    case "$legacy_ancestor" in ''|*[!0-9]*|0|1) return 1 ;; esac
    legacy_ancestor=$(awk '/^PPid:/ {print $2; exit}' "/proc/$legacy_ancestor/status" 2>/dev/null) || return 1
  done
}

resolve_heavyweight_admission_root() { resolve_native_host_admission_root; }

read_native_admission_fact() {
  native_admission_query_root=$(resolve_native_host_admission_root) || return 1
  run_dependency_free_node "$admission_client" "$1" "--root=$native_admission_query_root"
}

resolve_worker_cpu_budget() {
  awk -v cpu="$1" -v active="$2" 'BEGIN {
    if(cpu !~ /^[0-9]+$/ || cpu<1) exit
    if(active !~ /^[0-9]+$/ || active<0) active=0
    workers=int(cpu/(active+1)); if(workers<1) workers=1; print workers
  }'
}

heavyweight_count_admitted_owners() {
  heavyweight_active_count=$(read_native_admission_fact --active-count) || return 1
  if [ -n "${HAPPIER_HEAVYWEIGHT_ADMISSION_SLOT-}" ] && [ "$heavyweight_active_count" -gt 0 ]; then
    heavyweight_active_count=$((heavyweight_active_count - 1))
  fi
}

ensure_native_job_cpu_budget() {
  [ -z "${GOMAXPROCS+x}" ] || return 0
  native_job_platform=$(uname -s 2>/dev/null || true)
  case "$native_job_platform" in Linux|Darwin) ;; *) return 0 ;; esac
  native_job_cpu=$(getconf _NPROCESSORS_ONLN 2>/dev/null || sysctl -n hw.ncpu 2>/dev/null || true)
  native_job_active=0
  if [ "$native_job_platform" = Linux ]; then
    heavyweight_count_admitted_owners || return 1
    native_job_active=$heavyweight_active_count
  fi
  native_job_workers=$(resolve_worker_cpu_budget "$native_job_cpu" "$native_job_active")
  [ -z "$native_job_workers" ] || export GOMAXPROCS=$native_job_workers
}

read_host_memory_kib() {
  host_memory=$(awk '/MemTotal:/ {total=$2} /MemAvailable:/ {available=$2} END {if(total>0) print available,total}' /proc/meminfo 2>/dev/null || true)
  if [ -z "$host_memory" ]; then
    host_memory_total_bytes=$(sysctl -n hw.memsize 2>/dev/null || true)
    host_memory_free=$(memory_pressure -Q 2>/dev/null | awk '/free percentage/ {gsub(/%/,"",$5); print $5/100; exit}')
    host_memory=$(awk -v bytes="${host_memory_total_bytes:-0}" -v ratio="${host_memory_free:-0}" 'BEGIN {if(bytes>0) printf "%.0f %.0f",(bytes/1024)*ratio,bytes/1024}')
  fi
  printf '%s\n' "$host_memory"
}

heavyweight_prepare_export_request() {
  [ "$heavyweight_admission_class" = source-web-export ] || return 0
  heavyweight_export_interactive=0
  if [ -t 0 ] && [ -t 1 ]; then heavyweight_export_interactive=1; fi
  heavyweight_export_request=$(node "$projection_command_policy" --source-web-export-workers "$heavyweight_export_interactive" "$@") || exit 1
  IFS=' ' read -r heavyweight_export_worker_mode heavyweight_export_requested_workers <<EOF
$heavyweight_export_request
EOF
}

heavyweight_report_pre_dispatch_failure() {
  heavyweight_exit_status=$1
  if [ "$heavyweight_exit_status" -ne 0 ] && [ "$heavyweight_exit_status" -ne 130 ] \
    && [ "$heavyweight_exit_status" -ne 129 ] && [ "${heavyweight_payload_started-0}" = 0 ] \
    && [ -n "${heavyweight_failure_id-}" ]; then
    if [ "${heavyweight_declined_disk-0}" = 1 ]; then
      printf 'HSTACK_ADMISSION_DISK:%s\n' "$heavyweight_failure_id" >&2
    elif [ "${heavyweight_declined_capacity-0}" = 1 ]; then
      printf 'HSTACK_ADMISSION_CAPACITY:%s\n' "$heavyweight_failure_id" >&2
    elif [ "${heavyweight_declined_busy-0}" = 1 ]; then
      printf 'HSTACK_ADMISSION_BUSY:%s\n' "$heavyweight_failure_id" >&2
    else
      printf 'HSTACK_ADMISSION_UNAVAILABLE:%s\n' "$heavyweight_failure_id" >&2
    fi
    exit 75
  fi
  exit "$heavyweight_exit_status"
}

run_heavyweight_admission() {
  heavyweight_admission_root=$1
  heavyweight_admission_class=$2
  heavyweight_admission_machine=$3
  shift 3
  [ "$#" -gt 0 ] || { printf '%s\n' '[preferred-execution] heavyweight admission requires a command' >&2; exit 1; }
  ensure_native_job_cpu_budget || exit 1
  heavyweight_prepare_export_request "$@"
  case "$(uname -s 2>/dev/null || true)" in
    Linux) ;;
    *)
      heavyweight_payload_started=1
      if [ -n "${heavyweight_workspace_locks-}" ]; then
        exec node "$script_dir/../scripts/utils/proc/workspace_build_admission.mjs" --standalone \
          "$heavyweight_workspace_locks" "$launcher_path" "$heavyweight_admission_class" -- "$@"
      fi
      exec "$@" ;;
  esac
  heavyweight_floor=$(heavyweight_memory_floor_kib "$heavyweight_admission_class" "${heavyweight_admission_placement-worker}" "${heavyweight_export_requested_workers-}") || exit 1
  # The payload's reentry performs only jobs-slice placement, never capacity
  # admission. Its parent client retains the connection and filesystem leases.
  set -- -- "$launcher_path" --heavyweight-admitted-exec -- "$@"
  [ "${heavyweight_no_wait-0}" != 1 ] || set -- --no-wait "$@"
  [ "${heavyweight_require_inherited-0}" != 1 ] || set -- --require-inherited "$@"
  if [ "$heavyweight_admission_class" = source-web-export ]; then
    set -- "--export-mode=$heavyweight_export_worker_mode" "--export-workers=$heavyweight_export_requested_workers" "$@"
  fi
  exec node "$admission_client" --run "--root=$heavyweight_admission_root" "--class=$heavyweight_admission_class" \
    "--floor-kib=$heavyweight_floor" "--machine=$heavyweight_admission_machine" \
    "--failure-id=${heavyweight_failure_id-}" "--repo=$repo_root" "--workspace-locks=${heavyweight_workspace_locks:-[]}" "$@"
}

check_heavyweight_admission() {
  [ "$(uname -s 2>/dev/null || true)" = Linux ] || return 0
  heavyweight_floor=$(heavyweight_memory_floor_kib "$heavyweight_admission_class" "${heavyweight_admission_placement-worker}" "${heavyweight_export_requested_workers-}") || return 1
  node "$admission_client" --check "--root=$heavyweight_admission_root" "--floor-kib=$heavyweight_floor"
}

if [ "${1-}" = --heavyweight-admitted-exec ]; then
  shift
  [ "${1-}" != -- ] || shift
  [ "$#" -gt 0 ] || exit 1
  exec_in_jobs_slice "$@"
fi
