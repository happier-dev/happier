import type { PluginContextV1 } from '@happier-dev/plugin-sdk';

import type { OpenCodeServerClient } from './openCodeServerClient.js';
import type { OpenCodeServerRuntimeState } from './state.js';

function readReconnectBackoffMs(attempt: number): number {
  return Math.min(1_000, 50 * 2 ** Math.max(0, attempt));
}

export function attachOpenCodeProviderEventSubscriptionIfNeeded(params: Readonly<{
  client: OpenCodeServerClient;
  ctx: PluginContextV1;
  state: OpenCodeServerRuntimeState;
  handleProviderEvent: (event: unknown) => Promise<void>;
  onSubscriptionUnavailable?: (error: unknown) => void;
}>): void {
  if (params.state.subscriptionAbort) return;
  if (params.state.subscriptionReconnectTimer) return;
  if (params.state.disposed) return;
  if (!params.state.providerSessionId) return;

  const scheduleAttach = (attempt: number): void => {
    if (params.state.disposed || !params.state.providerSessionId) return;
    const delayMs = readReconnectBackoffMs(attempt);
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
      onEvent: (event) => {
        void params.handleProviderEvent(event).catch((error: unknown) => {
          params.ctx.logger.debug('[OpenCodeServer] failed to handle provider event (non-fatal)', { error });
        });
      },
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
        params.ctx.logger.debug('[OpenCodeServer] provider event subscription failed (non-fatal)', { error });
        params.onSubscriptionUnavailable?.(error);
        scheduleAttach(attempt + 1);
      },
    );
  };

  startSubscription(0);
}
