#!/bin/sh

provider_session="provider-declarative-created"
pending_prompt_id=""

send_result() {
  printf '{"jsonrpc":"2.0","id":%s,"result":%s}\n' "$1" "$2"
}

read_id() {
  value=${1#*\"id\":}
  value=${value%%,*}
  printf '%s' "$value"
}

read_session_id() {
  value=${1#*\"sessionId\":\"}
  value=${value%%\"*}
  printf '%s' "$value"
}

while IFS= read -r line; do
  case "$line" in
    *\"method\":\"initialize\"*)
      send_result "$(read_id "$line")" '{"protocolVersion":1,"authMethods":[]}'
      ;;
    *\"method\":\"session/new\"*)
      provider_session="provider-declarative-created"
      send_result "$(read_id "$line")" "{\"sessionId\":\"$provider_session\"}"
      ;;
    *\"method\":\"session/load\"*)
      provider_session="$(read_session_id "$line")"
      send_result "$(read_id "$line")" '{}'
      ;;
    *\"method\":\"session/prompt\"*cancel-before-ack*)
      pending_prompt_id="$(read_id "$line")"
      ;;
    *\"method\":\"session/prompt\"*cancel-after-ack*)
      send_result "$(read_id "$line")" '{}'
      ;;
    *\"method\":\"session/prompt\"*permission-pending*)
      pending_prompt_id="$(read_id "$line")"
      printf '{"jsonrpc":"2.0","id":7001,"method":"session/request_permission","params":{"sessionId":"%s","toolCall":{"toolCallId":"permission-pending-tool","kind":"execute","toolName":"Bash","rawInput":{"command":"pwd"}},"options":[{"optionId":"allow-once","kind":"allow_once","name":"Allow once"},{"optionId":"reject-once","kind":"reject_once","name":"Deny"}]}}\n' "$provider_session"
      ;;
    *\"method\":\"session/prompt\"*refuse*)
      send_result "$(read_id "$line")" '{"stopReason":"refusal"}'
      ;;
    *\"method\":\"session/prompt\"*unexpected-exit*)
      send_result "$(read_id "$line")" '{}'
      exit 17
      ;;
    *\"method\":\"session/prompt\"*)
      printf '{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"%s","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"packed declarative ACP"}}}}\n' "$provider_session"
      send_result "$(read_id "$line")" '{"stopReason":"end_turn"}'
      ;;
    *\"method\":\"session/cancel\"*)
      if [ -n "$pending_prompt_id" ]; then
        send_result "$pending_prompt_id" '{"stopReason":"cancelled"}'
        pending_prompt_id=""
      fi
      ;;
    *\"id\":7001,*)
      if [ -n "$pending_prompt_id" ]; then
        send_result "$pending_prompt_id" '{"stopReason":"cancelled"}'
        pending_prompt_id=""
      fi
      ;;
    *\"id\":*)
      send_result "$(read_id "$line")" '{}'
      ;;
  esac
done
