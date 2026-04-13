import { readHookEventEnvelopeV1, type HookEventEnvelopeV1 } from '@happier-dev/protocol';

import type { ResolvedExecutablePluginRuntimeRegistry } from '@/extensions/runtime/resolveExecutablePluginRuntimeRegistry';

import { matchesHookRegistrationFilters } from '../filters/matchesHookRegistrationFilters';

export type DispatchedPluginHookOutcomeV1 = Readonly<{
  pluginId: string;
  hookId: string;
  status: 'fulfilled' | 'rejected';
  result?: unknown;
  error?: string;
}>;

export type DispatchPluginHookEventResultV1 = Readonly<{
  eventId: string | null;
  matchedHandlerCount: number;
  outcomes: readonly DispatchedPluginHookOutcomeV1[];
}>;

export async function dispatchPluginHookEvent(params: Readonly<{
  runtimeRegistry: Pick<
    ResolvedExecutablePluginRuntimeRegistry,
    'hookHandlersByHookId' | 'readHookEventEnvelopeV1'
  >;
  event: HookEventEnvelopeV1 | unknown;
}>): Promise<DispatchPluginHookEventResultV1> {
  const envelope = params.runtimeRegistry.readHookEventEnvelopeV1
    ? params.runtimeRegistry.readHookEventEnvelopeV1(params.event)
    : readHookEventEnvelopeV1(params.event);
  if (!envelope) {
    return {
      eventId: null,
      matchedHandlerCount: 0,
      outcomes: Object.freeze([]),
    };
  }

  const handlers = params.runtimeRegistry.hookHandlersByHookId.get(envelope.eventId) ?? [];
  const outcomes: DispatchedPluginHookOutcomeV1[] = [];

  for (const handler of handlers) {
    if (!matchesHookRegistrationFilters(envelope, handler.registration)) {
      continue;
    }

    try {
      const result = await handler.handler(envelope);
      outcomes.push({
        pluginId: handler.pluginId,
        hookId: handler.hookId,
        status: 'fulfilled',
        ...(typeof result === 'undefined' ? {} : { result }),
      });
    } catch (error) {
      outcomes.push({
        pluginId: handler.pluginId,
        hookId: handler.hookId,
        status: 'rejected',
        error: error instanceof Error ? error.message : String(error ?? 'hook_dispatch_failed'),
      });
    }
  }

  return {
    eventId: envelope.eventId,
    matchedHandlerCount: outcomes.length,
    outcomes: Object.freeze([...outcomes]),
  };
}
