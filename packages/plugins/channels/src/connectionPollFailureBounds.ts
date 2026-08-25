/**
 * The one Channels-local terminal attempt count for checkpointed provider
 * polling. Poll failures are connection lifecycle recovery, not outward
 * delivery custody, so this deliberately does not reuse delivery's ceiling.
 */
export const MAX_CONVERSATION_POLL_FAILURE_ATTEMPTS = 5 as const;

export type ConversationPollFailureAttemptCountV1 =
  | 1
  | 2
  | 3
  | 4
  | typeof MAX_CONVERSATION_POLL_FAILURE_ATTEMPTS;

export type ConversationPollRetryAttemptCountV1 = Exclude<
  ConversationPollFailureAttemptCountV1,
  typeof MAX_CONVERSATION_POLL_FAILURE_ATTEMPTS
>;

/** A persisted poll-failure attempt is valid through the terminal attempt. */
export function isConversationPollFailureAttemptCount(
  value: unknown,
): value is ConversationPollFailureAttemptCountV1 {
  return typeof value === 'number'
    && Number.isSafeInteger(value)
    && value >= 1
    && value <= MAX_CONVERSATION_POLL_FAILURE_ATTEMPTS;
}

/** Only attempts before exhaustion can enter the durable retry-due phase. */
export function isConversationPollRetryAttemptCount(
  value: unknown,
): value is ConversationPollRetryAttemptCountV1 {
  return isConversationPollFailureAttemptCount(value)
    && value !== MAX_CONVERSATION_POLL_FAILURE_ATTEMPTS;
}
