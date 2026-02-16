import type { AgentState, Metadata } from '@/api/types';
import { logger } from '@/ui/logger';

export function updateAgentStateBestEffort(
  session: Readonly<{ updateAgentState: (updater: (state: AgentState) => AgentState) => Promise<void> | void }>,
  updater: (state: AgentState) => AgentState,
  logPrefix: string,
  reason: string,
): void {
  try {
    const result = session.updateAgentState(updater);
    void Promise.resolve(result).catch((error) => {
      logger.debug(`${logPrefix} Failed to update agent state (${reason}) (non-fatal)`, error);
    });
  } catch (error) {
    logger.debug(`${logPrefix} Failed to update agent state (${reason}) (non-fatal)`, error);
  }
}

export function updateMetadataBestEffort(
  session: Readonly<{ updateMetadata: (updater: (metadata: Metadata) => Metadata) => Promise<void> | void }>,
  updater: (metadata: Metadata) => Metadata,
  logPrefix: string,
  reason: string,
): void {
  try {
    const result = session.updateMetadata(updater);
    void Promise.resolve(result).catch((error) => {
      logger.debug(`${logPrefix} Failed to update session metadata (${reason}) (non-fatal)`, error);
    });
  } catch (error) {
    logger.debug(`${logPrefix} Failed to update session metadata (${reason}) (non-fatal)`, error);
  }
}
