# Shared payload priority for native admission and local/remote execution.
# Admission owns capacity; this owner only selects inherited scheduling priority.
jobs_scope_unit() {
  printf 'happier-jobs-%s-%s.scope' "$1" "$2"
}

exec_in_jobs_slice() {
  # The containing jobs owner already established scope and priority. Reentrant
  # payloads inherit both rather than repeating scheduling or admission work.
  case "$(sed -n 's/^0:://p' /proc/self/cgroup 2>/dev/null)" in
    *'/happier-jobs.slice/'*) exec "$@" ;;
  esac
  exec_in_jobs_scope "$@"
}

# An admission client reports its payload's kernel peak (memory.peak) only from
# its own per-dispatch scope. A shared jobs-slice scope (an agent's tmux session)
# is not one: the client takes its own scope there, and its payload reenters it.
exec_in_jobs_scope() {
  case "$(sed -n 's/^0:://p' /proc/self/cgroup 2>/dev/null)" in
    *'/happier-jobs.slice/happier-jobs-'*'.scope') exec "$@" ;;
  esac
  jobs_slice_current_nice=$(ps -o ni= -p "$$") || return
  jobs_slice_current_nice=$((jobs_slice_current_nice))
  jobs_slice_nice=$jobs_slice_current_nice
  if [ "$jobs_slice_nice" -lt 10 ]; then jobs_slice_nice=10; fi

  if command -v systemd-run >/dev/null 2>&1 \
    && command -v systemctl >/dev/null 2>&1 \
    && systemctl --user show-environment >/dev/null 2>&1 \
    && [ "$(systemctl --user show happier-jobs.slice --property=LoadState --value 2>/dev/null || true)" = loaded ]; then
    jobs_slice_token=$(heavyweight_process_token "$$")
    exec systemd-run --expand-environment=no "--unit=$(jobs_scope_unit "${jobs_scope_owner_pid:-$$}" "${jobs_scope_owner_token:-$jobs_slice_token}")" \
      --user --scope --quiet --slice=happier-jobs.slice "--nice=$jobs_slice_nice" -- "$@"
  fi

  # nice takes an adjustment; systemd takes an absolute value. Apply the same
  # floor without raising an inherited lower priority or adding ten per reentry.
  if [ "$jobs_slice_current_nice" -lt "$jobs_slice_nice" ] && command -v nice >/dev/null 2>&1; then
    exec nice -n "$((jobs_slice_nice - jobs_slice_current_nice))" "$@"
  fi
  exec "$@"
}

