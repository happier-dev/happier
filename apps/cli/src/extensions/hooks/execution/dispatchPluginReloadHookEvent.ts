import type { ResolvedExecutablePluginRuntimeRegistry } from '../../runtime/resolveExecutablePluginRuntimeRegistry';

import {
  dispatchPluginHookEvent,
  type DispatchPluginHookEventResultV1,
} from './dispatchPluginHookEvent';

export async function dispatchPluginReloadHookEvent(params: Readonly<{
  runtimeRegistry: Pick<ResolvedExecutablePluginRuntimeRegistry, 'hookHandlersByHookId' | 'readHookEventEnvelopeV1'>;
  eventId: 'plugin.reload.before' | 'plugin.reload.after';
  payload: Record<string, unknown>;
  timestampMs?: number;
}>): Promise<DispatchPluginHookEventResultV1> {
  const event = {
    hookVersion: 1,
    eventId: params.eventId,
    category: 'lifecycle',
    scope: 'plugin',
    timestampMs: typeof params.timestampMs === 'number' ? params.timestampMs : Date.now(),
    payload: params.payload,
  };

  return await dispatchPluginHookEvent({
    runtimeRegistry: params.runtimeRegistry,
    event,
  });
}
