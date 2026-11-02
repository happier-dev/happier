# Native dispatch recovery uses SSH-owned evidence, never an absent PID file:
# custody removes completed records, so absence cannot prove never-started.
ssh_refused_before_session() {
  [ -n "$1" ] && [ -r "$1" ] || return 1
  # These diagnostics precede acceptance of a remote session. In particular,
  # client_loop/read/write/broken-pipe errors can follow payload execution and
  # must not be classified by their generic reset/refused suffix.
  LC_ALL=C grep -Eq '^(mux_client_request_session: session request failed:|kex_exchange_identification:|ssh_exchange_identification:|ssh: connect to host .*: (Connection refused|Connection timed out|No route to host|Network is unreachable))' "$1"
}

record_selected_unavailable() {
  dispatch_unavailable_cache="$cache_dir/$selected_name.cache"
  dispatch_unavailable_temporary=$(create_cache_temporary "$dispatch_unavailable_cache" 2>/dev/null || true)
  if [ -n "$dispatch_unavailable_temporary" ]; then
    printf '%s 0 - 1 %s\n' "$(date +%s)" "$1" > "$dispatch_unavailable_temporary" && \
      mv -f -- "$dispatch_unavailable_temporary" "$dispatch_unavailable_cache"
    rm -f -- "$dispatch_unavailable_temporary" 2>/dev/null || true
  fi
  # Per-command refusal context follows the existing exclusion handoff across
  # launcher replacement. It contains target names and closed reason codes only.
  HSTACK_EXEC_PRE_DISPATCH_REFUSALS="${HSTACK_EXEC_PRE_DISPATCH_REFUSALS-} $selected_name=$2"
  export HSTACK_EXEC_PRE_DISPATCH_REFUSALS
}

report_dispatch_refusals() {
  [ -n "${HSTACK_EXEC_PRE_DISPATCH_REFUSALS-}" ] || return 1
  printf '[preferred-execution] HSTACK_EXEC_DISPATCH_REFUSED:%s; no eligible target accepted this command before payload start\n' "$HSTACK_EXEC_PRE_DISPATCH_REFUSALS" >&2
}
