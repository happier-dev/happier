import type { AgentState, Metadata } from '@/api/types';
import { logger } from '@/ui/logger';

/**
 * Delays between successive retry attempts (ms). The number of attempts is
 * derived from this array: total attempts = delays.length + 1 (the initial
 * attempt plus one attempt per delay interval). Keeping the two values coupled
 * prevents silent drift if the array is extended without updating a separate
 * attempts constant.
 *
 * All errors are retried unconditionally. This is intentional: the helpers are
 * best-effort fire-and-forget writes; distinguishing transient vs permanent
 * failures adds complexity that is not warranted here.
 */
const BEST_EFFORT_RETRY_DELAYS_MS = [1_000, 2_000] as const;
const BEST_EFFORT_MAX_ATTEMPTS = BEST_EFFORT_RETRY_DELAYS_MS.length + 1;

/**
 * Calls `fn` up to `BEST_EFFORT_MAX_ATTEMPTS` times, waiting
 * `BEST_EFFORT_RETRY_DELAYS_MS[n]` between each attempt.
 *
 * Retry timers are unref'd so they never prevent the Node process from
 * exiting if the event loop would otherwise be empty (e.g. during daemon
 * shutdown). `onFailure` is invoked after every failed attempt with the error,
 * the 1-based attempt number, and a flag indicating whether this was the final
 * attempt.
 */
async function withRetry(
  fn: () => Promise<void> | void,
  onFailure: (error: unknown, attempt: number, isFinal: boolean) => void,
): Promise<void> {
  for (let attempt = 1; attempt <= BEST_EFFORT_MAX_ATTEMPTS; attempt++) {
    try {
      await Promise.resolve(fn());
      return;
    } catch (error) {
      const isFinal = attempt >= BEST_EFFORT_MAX_ATTEMPTS;
      onFailure(error, attempt, isFinal);
      if (!isFinal) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, BEST_EFFORT_RETRY_DELAYS_MS[attempt - 1]);
          // Do not keep the CLI alive solely for a best-effort retry.
          timer.unref?.();
        });
      }
    }
  }
}

/**
 * Fires a best-effort `updateAgentState` call, retrying up to
 * `BEST_EFFORT_MAX_ATTEMPTS` times on transient failure. All errors are
 * swallowed after the final attempt; intermediate failures are logged at
 * debug level.
 */
export function updateAgentStateBestEffort(
  session: Readonly<{ updateAgentState: (updater: (state: AgentState) => AgentState) => Promise<void> | void }>,
  updater: (state: AgentState) => AgentState,
  logPrefix: string,
  reason: string,
): void {
  void withRetry(
    () => session.updateAgentState(updater),
    (error, attempt, isFinal) => {
      if (isFinal) {
        logger.debug(`${logPrefix} Failed to update agent state (${reason}) after ${BEST_EFFORT_MAX_ATTEMPTS} attempts (non-fatal)`, error);
      } else {
        logger.debug(`${logPrefix} Failed to update agent state (${reason}), retrying (attempt ${attempt}/${BEST_EFFORT_MAX_ATTEMPTS}) (non-fatal)`, error);
      }
    },
  );
}

/**
 * Fires a best-effort `updateMetadata` call, retrying up to
 * `BEST_EFFORT_MAX_ATTEMPTS` times on transient failure. All errors are
 * swallowed after the final attempt; intermediate failures are logged at
 * debug level.
 *
 * This is the write path for vendor session IDs (e.g. `claudeSessionId`).
 * Retrying here makes sessions resumable even when the initial write races a
 * brief network hiccup at session start.
 */
export function updateMetadataBestEffort(
  session: Readonly<{ updateMetadata: (updater: (metadata: Metadata) => Metadata) => Promise<void> | void }>,
  updater: (metadata: Metadata) => Metadata,
  logPrefix: string,
  reason: string,
): void {
  void withRetry(
    () => session.updateMetadata(updater),
    (error, attempt, isFinal) => {
      if (isFinal) {
        logger.debug(`${logPrefix} Failed to update session metadata (${reason}) after ${BEST_EFFORT_MAX_ATTEMPTS} attempts (non-fatal)`, error);
      } else {
        logger.debug(`${logPrefix} Failed to update session metadata (${reason}), retrying (attempt ${attempt}/${BEST_EFFORT_MAX_ATTEMPTS}) (non-fatal)`, error);
      }
    },
  );
}
