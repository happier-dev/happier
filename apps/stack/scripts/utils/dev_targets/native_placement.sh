# Serialize the host-local decision with publication of its existing active
# record. Probing, synchronization, worker admission and payloads stay outside.
acquire_placement_decision() {
  placement_decision_held=0
  # The native Darwin controller retains its existing PID-based reservation
  # path when flock is absent; Linux controllers already require flock for
  # lifetime-locked dispatch records across sandbox PID namespaces.
  command -v flock >/dev/null 2>&1 || return 0
  exec 7>>"$1/placement-decision.lock" || return 1
  if ! flock 7; then
    exec 7>&-
    return 1
  fi
  placement_decision_held=1
}

release_placement_decision() {
  if [ "${placement_decision_held-0}" = 1 ]; then
    flock -u 7 2>/dev/null || true
    exec 7>&-
    placement_decision_held=0
  fi
}
