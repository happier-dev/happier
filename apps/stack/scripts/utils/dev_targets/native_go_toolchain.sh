# Placement checks installation evidence only. The managed-runtime notices
# owner still verifies the built binary, exact Go version and notice contents.
native_go_toolchain_evidence_is_available() {
  # The managed-runtime notices owner observes Go from ModuleRoot. Running
  # at repo root can select the distro Go instead of the module's toolchain.
  native_go_root=$(cd -- "$1" && go env GOROOT 2>/dev/null) || return 1
  [ -n "$native_go_root" ] || return 1
  # thirdpartynotices/notices.go#collectGoDistributionEvidence consumes both.
  for native_go_evidence in LICENSE PATENTS; do
    [ -f "$native_go_root/$native_go_evidence" ] \
      && [ -r "$native_go_root/$native_go_evidence" ] \
      && [ -s "$native_go_root/$native_go_evidence" ] || return 1
  done
}
