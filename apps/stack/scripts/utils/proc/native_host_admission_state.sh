# One host identity across caller homes, private mirrors and target aliases.
# Capacity and demand are in the broker, never filesystem owner/waiter records.
native_host_admission_uid=$(id -u) || return 1
native_host_admission_root="/tmp/happier-heavyweight-admission-v3-$native_host_admission_uid"

resolve_native_host_admission_root() {
  (umask 077; mkdir -p -- "$native_host_admission_root") 2>/dev/null || return 1
  printf '%s' "$native_host_admission_root"
}

resolve_native_host_admission_machine() {
  native_host_machine=
  if [ -r /etc/machine-id ]; then IFS= read -r native_host_machine < /etc/machine-id || true; fi
  if [ -z "$native_host_machine" ] && [ -r /proc/sys/kernel/random/boot_id ]; then
    IFS= read -r native_host_machine < /proc/sys/kernel/random/boot_id || true
  fi
  case "$native_host_machine" in ''|*[!a-fA-F0-9-]*) return 1 ;; esac
  printf '%s' "$native_host_machine"
}
