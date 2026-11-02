# Shared payload priority for native admission and local/remote execution.
# Admission owns capacity; this owner only selects inherited scheduling priority.
exec_in_jobs_slice() {
  # The containing jobs owner already established scope and priority. Reentrant
  # payloads inherit both rather than repeating scheduling or admission work.
  case "$(sed -n 's/^0:://p' /proc/self/cgroup 2>/dev/null)" in
    *'/happier-jobs.slice/'*) exec "$@" ;;
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
    exec systemd-run --expand-environment=no "--unit=happier-jobs-$$-$jobs_slice_token.scope" \
      --user --scope --quiet --slice=happier-jobs.slice "--nice=$jobs_slice_nice" -- "$@"
  fi

  # nice takes an adjustment; systemd takes an absolute value. Apply the same
  # floor without raising an inherited lower priority or adding ten per reentry.
  if [ "$jobs_slice_current_nice" -lt "$jobs_slice_nice" ] && command -v nice >/dev/null 2>&1; then
    exec nice -n "$((jobs_slice_nice - jobs_slice_current_nice))" "$@"
  fi
  exec "$@"
}
