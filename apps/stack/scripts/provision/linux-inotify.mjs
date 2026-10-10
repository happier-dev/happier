// The owner-approved development fleet policy addresses observed instance
// exhaustion (136 used versus Ubuntu's 128), not watch exhaustion.
export function buildLinuxInotifyScript() {
  return `
set -eu
inotify_file=/etc/sysctl.d/60-happier-inotify.conf
install -d -m 0755 /etc/sysctl.d
inotify_candidate="$(mktemp)"
trap 'rm -f -- "$inotify_candidate"' EXIT
printf '%s\\n' 'fs.inotify.max_user_instances=1024' > "$inotify_candidate"
if ! cmp -s -- "$inotify_candidate" "$inotify_file"; then
  install -m 0644 "$inotify_candidate" "$inotify_file"
fi
rm -f -- "$inotify_candidate"
trap - EXIT
if [ "$(sysctl -n fs.inotify.max_user_instances)" != 1024 ]; then
  sysctl -p "$inotify_file"
fi
[ "$(sysctl -n fs.inotify.max_user_instances)" = 1024 ] || {
  echo 'Happier inotify instance policy did not take effect' >&2; exit 1;
}
`;
}
