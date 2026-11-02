#!/bin/sh
# Source once at executor startup: teardown must keep its signal owner even if
# synchronization or fixture cleanup removes the original source tree.
native_execution_signal() {
  native_signal_execution_id=$1
  native_signal_initiating_id=$2
  native_signal_reason=$3
  native_signal_signal=$4
  native_signal_kind=$5
  native_signal_target=$6
  native_signal_members=
  native_signal_separator=
  for native_signal_member in $7; do
    case "$native_signal_member" in *[!0-9:]*|:*|*::*|*:) continue ;; esac
    native_signal_members="$native_signal_members$native_signal_separator\"$native_signal_member\""
    native_signal_separator=,
  done
  # ENVIRON keeps arbitrary identifier text out of awk source and -v escape
  # interpretation. Prepare fields before signaling: launching a serializer
  # after kill can make Bash announce a job before its caller can wait for it.
  native_signal_fields=$(
  NATIVE_SIGNAL_EXECUTION_ID=$native_signal_execution_id \
  NATIVE_SIGNAL_INITIATING_ID=$native_signal_initiating_id \
  NATIVE_SIGNAL_REASON=$native_signal_reason NATIVE_SIGNAL_SIGNAL=$native_signal_signal \
  NATIVE_SIGNAL_KIND=$native_signal_kind NATIVE_SIGNAL_TARGET=$native_signal_target \
  NATIVE_SIGNAL_MEMBERS=$native_signal_members awk '
    function quote(value, result, offset, character, control) {
      result = "\""
      for (offset = 1; offset <= length(value); offset++) {
        character = substr(value, offset, 1)
        if (character == "\\") result = result "\\\\"
        else if (character == "\"") result = result "\\\""
        else if ((control = index(controls, character)) > 0) result = result sprintf("\\u%04x", control)
        else result = result character
      }
      return result "\""
    }
    BEGIN {
      for (code = 1; code < 32; code++) controls = controls sprintf("%c", code)
      printf "\"execution_id\":%s,\"initiating_execution_id\":%s,\"reason\":%s,\"signal\":%s,\"target_kind\":%s,\"target_id\":%s,\"members\":[%s]", \
        quote(ENVIRON["NATIVE_SIGNAL_EXECUTION_ID"]), \
        quote(ENVIRON["NATIVE_SIGNAL_INITIATING_ID"]), quote(ENVIRON["NATIVE_SIGNAL_REASON"]), \
        quote(ENVIRON["NATIVE_SIGNAL_SIGNAL"]), quote(ENVIRON["NATIVE_SIGNAL_KIND"]), \
        ENVIRON["NATIVE_SIGNAL_TARGET"], ENVIRON["NATIVE_SIGNAL_MEMBERS"]
      exit
    }
  ' </dev/null
  )
  native_signal_at=$(date -u '+%Y-%m-%dT%H:%M:%SZ')
  if [ "$native_signal_kind" = pgid ]; then
    if kill -s "$native_signal_signal" -- "-$native_signal_target" 2>/dev/null; then native_signal_result=0; else native_signal_result=$?; fi
  else
    if kill "-$native_signal_signal" "$native_signal_target" 2>/dev/null; then native_signal_result=0; else native_signal_result=$?; fi
  fi
  printf '[preferred-execution] custody_signal {"at":"%s",%s,"syscall_result":%s}\n' "$native_signal_at" "$native_signal_fields" "$native_signal_result" >&2
  return 0
}
