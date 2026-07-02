import type { PluginContextV1 } from '@happier-dev/plugin-sdk';

import type { OpenCodeServerClient } from './openCodeServerClient.js';
import type { OpenCodeServerRuntimeState } from './state.js';

export function attachOpenCodeProviderEventSubscriptionIfNeeded(params: Readonly<{
  client: OpenCodeServerClient;
  ctx: PluginContextV1;
  state: OpenCodeServerRuntimeState;
  handleProviderEvent: (event: unknown) => Promise<void>;
}>): void {
  if (params.state.subscriptionAbort) return;
  if (!params.state.providerSessionId) return;
  const controller = new AbortController();
  params.state.subscriptionAbort = controller;
  void params.client.subscribeGlobalEvents({
    signal: controller.signal,
    onEvent: (event) => {
      void params.handleProviderEvent(event).catch((error: unknown) => {
        params.ctx.logger.debug('[OpenCodeServer] failed to handle provider event (non-fatal)', { error });
      });
    },
  }).catch((error: unknown) => {
    if (controller.signal.aborted) return;
    params.ctx.logger.debug('[OpenCodeServer] provider event subscription failed (non-fatal)', { error });
  });
}
