import type { AgentState, Metadata } from '@/api/types';
import { logger } from '@/ui/logger';

const BEST_EFFORT_MAX_ATTEMPTS = 3;
const BEST_EFFORT_RETRY_DELAYS_MS = [1_000, 2_000];

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
        await new Promise<void>((resolve) =>
          setTimeout(resolve, BEST_EFFORT_RETRY_DELAYS_MS[attempt - 1]),
        );
      }
    }
  }
}

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
