# Shared eligibility for dispatch and pre-dispatch clients that need a worker
# before they ship a payload to it. The native projection owns the command pool.
execution_target_is_automatic() {
  eval '[ "${target_'"$1"'_automatic-1}" = 1 ]'
}

execution_target_accepts_resource_class() {
  [ "${command_mode-}" = auto ] || return 0
  eval 'allowed_classes=${target_'"$1"'_auto_resource_classes-*}'
  [ "$allowed_classes" != '*' ] || return 0
  case " $allowed_classes " in
    *" $2 "*) return 0 ;;
    *) return 1 ;;
  esac
}

execution_target_is_excluded() {
  case " ${HSTACK_EXEC_PRE_DISPATCH_EXCLUDED_TARGETS-} " in
    *" $1 "*) return 0 ;;
    *) return 1 ;;
  esac
}

value_for_target() {
  eval "printf '%s' \"\${target_${2}_${1}-}\""
}

execution_target_ssh_config() {
  if [ -n "${projection_mutagen_ssh_path-}" ] && [ -f "$projection_mutagen_ssh_path/config" ]; then
    printf '%s' "$projection_mutagen_ssh_path/config"
  else
    value_for_target ssh_config "$1"
  fi
}

print_execution_worker_connections() (
  [ "${command_mode-}" != local ] || return 0
  worker_number=1
  while [ "$worker_number" -le "${target_count-0}" ]; do
    if execution_target_is_automatic "$worker_number" && {
      [ -z "${1-}" ] || execution_target_accepts_resource_class "$worker_number" "$1"
    }; then
      worker_name=$(value_for_target name "$worker_number")
      if ! execution_target_is_excluded "$worker_name"; then
        printf '%s\0%s\0%s\0%s\0%s\0' "$worker_name" "$(value_for_target ssh "$worker_number")" \
          "$(execution_target_ssh_config "$worker_number")" "$(value_for_target cli_home "$worker_number")" \
          "$(value_for_target remote_path "$worker_number")"
      fi
    fi
    worker_number=$((worker_number + 1))
  done
)

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
