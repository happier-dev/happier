import type { OpenCodeServerClient } from '../openCodeServerClient.js';
import { asRecord, normalizeString } from '../openCodeParsing.js';
import type { OpenCodeProviderActivityTracker } from './createOpenCodeProviderActivityTracker.js';
import type { OpenCodeServerRuntimeState } from '../state.js';
import {
  readOpenCodeToolCallKey,
  readOpenCodeToolPart,
} from '../state.js';

export function refreshOpenCodeProviderActivityFromHistoryMessages(params: Readonly<{
  messages: readonly unknown[];
  state: OpenCodeServerRuntimeState;
  tracker: OpenCodeProviderActivityTracker;
}>): void {
  if (!params.state.providerSessionId) return;
  for (const message of params.messages) {
    const messageRecord = asRecord(message);
    const messageId = normalizeString(asRecord(messageRecord?.info)?.id);
    const messageMatchesActiveTurn = messageId
      ? params.state.currentTurnObservedMessageIds.has(messageId)
      : false;
    const parts = messageRecord?.parts;
    if (!Array.isArray(parts)) continue;
    for (const rawPart of parts) {
      const part = readOpenCodeToolPart(rawPart);
      if (!part) continue;
      if (
        params.state.turnInFlight &&
        !messageMatchesActiveTurn &&
        !params.state.currentTurnObservedToolCallKeys.has(readOpenCodeToolCallKey(part))
      ) {
        continue;
      }
      params.tracker.observeToolPart({
        part,
        source: 'history',
        partId: normalizeString(asRecord(rawPart)?.id) || null,
      });
    }
  }
}

export async function refreshOpenCodeProviderActivityFromHistory(params: Readonly<{
  client: OpenCodeServerClient;
  state: OpenCodeServerRuntimeState;
  tracker: OpenCodeProviderActivityTracker;
}>): Promise<void> {
  if (!params.state.providerSessionId) return;
  const messages = await params.client.sessionMessages({ sessionId: params.state.providerSessionId });
  refreshOpenCodeProviderActivityFromHistoryMessages({
    messages,
    state: params.state,
    tracker: params.tracker,
  });
}
