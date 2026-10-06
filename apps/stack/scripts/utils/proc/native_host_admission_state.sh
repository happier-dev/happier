# The worker owns this OS-global location. Caller homes, task mirrors, aliases
# and temporary directories do not define an independent admission authority.
native_host_admission_root='/tmp/happier-heavyweight-admission-v1'

resolve_native_host_admission_root() {
  (umask 077; mkdir -p -- "$native_host_admission_root") 2>/dev/null || return 1
  [ -d "$native_host_admission_root" ] && [ -r "$native_host_admission_root" ] \
    && [ -w "$native_host_admission_root" ] && [ -x "$native_host_admission_root" ] || return 1
  native_host_owner=$(stat -c %u -- "$native_host_admission_root" 2>/dev/null) || return 1
  native_host_account=$(id -u) || return 1
  [ "$native_host_owner" = "$native_host_account" ] || return 1
  printf '%s' "$native_host_admission_root"
}

resolve_native_host_admission_machine() {
  native_host_machine=
  if [ -r /etc/machine-id ]; then
    IFS= read -r native_host_machine < /etc/machine-id || true
  fi
  if [ -z "$native_host_machine" ] && [ -r /proc/sys/kernel/random/boot_id ]; then
    IFS= read -r native_host_machine < /proc/sys/kernel/random/boot_id || true
  fi
  case "$native_host_machine" in ''|*[!a-fA-F0-9-]*) return 1 ;; esac
  printf '%s' "$native_host_machine"
}
