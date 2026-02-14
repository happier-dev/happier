import type { ReducerState } from '../reducer';
import { applyToolResultUpdateToReducerMessage } from './applyToolResultUpdateToReducerMessage';
import { drainOrphanToolResults } from './orphanToolResults';

export function drainAndApplyOrphanToolResultsToMessage(params: Readonly<{
  state: ReducerState;
  toolUseId: string;
  messageId: string;
  changed: Set<string>;
}>): void {
  const { state, toolUseId, messageId, changed } = params;
  const orphanResults = drainOrphanToolResults({ state, toolUseId });
  if (!orphanResults) return;

  const message = state.messages.get(messageId);
  if (!message) return;

  for (const orphan of orphanResults) {
    applyToolResultUpdateToReducerMessage({
      message,
      messageId,
      toolResult: orphan.toolResult,
      resultCreatedAt: orphan.createdAt,
      meta: orphan.meta,
      changed,
    });
  }
}

