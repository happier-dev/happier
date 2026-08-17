import {
  type OpenCodeGlobalEventDelivery,
  type OpenCodeServerClient,
} from './openCodeServerClient.js';
import { readOpenCodeEventReconnectBackoffMs } from './openCodeEventReconnect.js';
import type { OpenCodeServerRuntimeState } from './state.js';
import type { OpenCodeRuntimeContext } from './runtimeContext.js';

export function attachOpenCodeProviderEventSubscriptionIfNeeded(params: Readonly<{
  client: OpenCodeServerClient;
  ctx: OpenCodeRuntimeContext;
  state: OpenCodeServerRuntimeState;
  handleProviderEvent: (event: unknown) => Promise<void>;
  handleProviderObservation: (event: unknown) => Promise<void>;
  onSubscriptionUnavailable?: (error: unknown) => void;
}>): void {
  if (params.state.subscriptionAbort) return;
  if (params.state.subscriptionReconnectTimer) return;
  if (params.state.disposed) return;
  if (!params.state.providerSessionId) return;

  const notifySubscriptionUnavailable = (error: unknown): void => {
    params.ctx.logger.debug('[OpenCodeServer] provider event subscription failed (non-fatal)', { error });
    try {
      params.onSubscriptionUnavailable?.(error);
    } catch (notificationError) {
      params.ctx.logger.debug(
        '[OpenCodeServer] provider event subscription availability notification failed (non-fatal)',
        { error: notificationError },
      );
    }
  };

  const scheduleAttach = (attempt: number): void => {
    if (params.state.disposed || !params.state.providerSessionId) return;
    const delayMs = readOpenCodeEventReconnectBackoffMs(attempt);
    params.state.subscriptionReconnectTimer = setTimeout(() => {
      params.state.subscriptionReconnectTimer = null;
      startSubscription(attempt);
    }, delayMs);
    params.state.subscriptionReconnectTimer.unref?.();
  };

  const startSubscription = (attempt: number): void => {
    if (params.state.disposed || params.state.subscriptionAbort || !params.state.providerSessionId) return;
    const controller = new AbortController();
    params.state.subscriptionAbort = controller;
    void params.client.subscribeGlobalEvents({
      signal: controller.signal,
      onEvent: (event, delivery: OpenCodeGlobalEventDelivery) => {
        const eventType = typeof event.payload?.type === 'string'
          ? event.payload.type
          : typeof event.type === 'string'
            ? event.type
            : '';
        if (delivery.provenance === 'connection-boundary' && eventType !== 'server.connected') return;
        const handler = delivery.provenance === 'untrusted-observation'
          ? params.handleProviderObservation
          : params.handleProviderEvent;
        void handler(event).catch((error: unknown) => {
          params.ctx.logger.debug('[OpenCodeServer] failed to handle provider event (non-fatal)', { error });
        });
      },
      onUnavailable: notifySubscriptionUnavailable,
    }).then(
      () => {
        if (params.state.subscriptionAbort === controller) {
          params.state.subscriptionAbort = null;
        }
        if (!controller.signal.aborted) {
          scheduleAttach(attempt + 1);
        }
      },
      (error: unknown) => {
        if (params.state.subscriptionAbort === controller) {
          params.state.subscriptionAbort = null;
        }
        if (controller.signal.aborted || params.state.disposed) return;
        notifySubscriptionUnavailable(error);
        scheduleAttach(attempt + 1);
      },
    );
  };

  startSubscription(0);
}
