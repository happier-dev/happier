/**
 * The one Channels retry-delay curve. Ingress obligations and outward delivery
 * custody already share `MAX_CONVERSATION_DELIVERY_ATTEMPTS` as their attempt
 * ceiling, so the delay between those attempts is one policy too: two copies of
 * this formula had already drifted at `attemptCount === 0`, where the
 * unclamped exponent produced half the base delay.
 *
 * A provider-supplied `retryAfterMs` still wins where the caller has one; this
 * is only the default a caller falls back to.
 */
const CONVERSATION_RETRY_BASE_DELAY_MS = 1_000;
const CONVERSATION_RETRY_MAX_DELAY_MS = 8_000;

export function conversationRetryDelayMs(attemptCount: number): number {
  return Math.min(
    CONVERSATION_RETRY_BASE_DELAY_MS * (2 ** Math.max(0, attemptCount - 1)),
    CONVERSATION_RETRY_MAX_DELAY_MS,
  );
}
