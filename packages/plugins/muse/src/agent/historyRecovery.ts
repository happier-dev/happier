import type { JsonValue } from '@happier-dev/plugin-sdk';
import type { AgentRuntimeContext } from '@happier-dev/plugin-sdk/agents/runtime';
import { readMuseRecord } from './events.js';
import { readMuseHistoryItems, replayMusePagedHistory } from './externalSessions.js';
import type { MuseMsp } from './msp.js';

type NativeMessage = Readonly<{ method: string; params?: JsonValue }>;

/** MSP v1 permits re-anchoring after dropped live frames through session/read.
 * Reuse the active item projection: replay cannot become new usage or a turn. */
export async function reconcileMuseHistoryNotification(message: NativeMessage, options: Readonly<{
  msp: MuseMsp;
  nativeSessionId: string;
  projection: Readonly<{
    replayItems(items: readonly JsonValue[]): Promise<void>;
    replayHistoryEvent(message: NativeMessage): Promise<void>;
  }>;
  context: AgentRuntimeContext;
}>): Promise<void> {
  if (message.method !== 'view/gap' && message.method !== 'session/viewHealthChanged') return;
  const params = readMuseRecord(message.params);
  if (params.sessionId !== options.nativeSessionId
    || message.method === 'session/viewHealthChanged' && params.health !== 'unavailable') return;
  let reason: string | undefined;
  try {
    const result = readMuseRecord(await options.msp.client.request('session/read', {
      sessionId: options.nativeSessionId, excludeItems: false,
    }, { signal: options.context.signal }));
    if (readMuseRecord(result.session).sessionId !== options.nativeSessionId) reason = 'PLUGIN_EXEC_PROTOCOL_ERROR';
    else {
      const history = readMuseRecord(result.history);
      // These native pull reasons mean the projection itself is unavailable;
      // paging it cannot establish a complete repaired history.
      if (history.mode === 'none' && (history.noneReason === 'projectionUnavailable'
        || history.noneReason === 'projectionReadLimit')) reason = history.noneReason;
      else {
        const items = readMuseHistoryItems(result.history);
        if (items) await options.projection.replayItems(items);
        else await replayMusePagedHistory(options.msp.client, { sessionId: options.nativeSessionId,
          signal: options.context.signal, replay: options.projection.replayHistoryEvent });
      }
    }
  } catch (error) {
    // Keep the transport's numeric native code, never raw RPC messages/content.
    reason = error instanceof Error && 'code' in error && typeof error.code === 'number'
      ? `JSON-RPC ${error.code}` : 'PLUGIN_EXEC_FAILED';
  }
  if (options.context.signal.aborted) return;
  const text = reason ? `Muse history is incomplete (${reason}). Reopen the Session to retry history recovery.` : null;
  if (text && reason) options.context.services.logger.diagnostic({ code: 'PLUGIN_EXEC_FAILED', severity: 'warning',
    message: text, details: { method: message.method, reason } });
  await options.context.ui?.status.set('muse.history', text, { signal: options.context.signal });
}
