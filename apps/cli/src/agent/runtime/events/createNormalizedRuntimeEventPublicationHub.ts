import type { AgentMessage } from '@/agent/core/AgentMessage';
import { publishRuntimePluginEvent } from '@/plugins/runtime/context/events';
import { RuntimeEventV1Schema } from '@happier-dev/protocol';

import {
  createNormalizedRuntimeEventWriter,
  type NormalizedRuntimeEventPublicationInput,
} from '@/agent/runtime/events/createNormalizedRuntimeEventWriter';

export type NormalizedRuntimeEventPublicationHub<TMessage> = Readonly<{
  ensureUpstreamRegistered: () => void;
  publishFallbackIdentity: () => void;
  subscribe: (handler: (message: TMessage) => void) => () => void;
  dispose: () => void;
}>;

/**
 * Shared lower-layer primitive for host bridges: normalize/publish runtime identity/capability/facet
 * events from an upstream runtime message stream, while routing all messages to subscribers.
 *
 * This intentionally does not know about sessions vs execution runs; it only manages:
 * - upstream subscription lifecycle
 * - message fanout to subscribers
 * - best-effort subscriber isolation
 * - runtime.* event normalization + fallback publication
 */
export function createNormalizedRuntimeEventPublicationHub<TMessage>(params: Readonly<{
  subscribeUpstream: (handler: (message: TMessage) => void) => () => void;
  identity: NormalizedRuntimeEventPublicationInput;
}>): NormalizedRuntimeEventPublicationHub<TMessage> {
  const handlers = new Set<(message: TMessage) => void>();
  let unsubscribeUpstream: (() => void) | null = null;

  const dispatch = (message: AgentMessage): void => {
    for (const handler of handlers) {
      try {
        handler(message as unknown as TMessage);
      } catch {
        // Best effort: publication subscribers must not break runtime routing.
      }
    }
  };

  const runtimeEventWriter = createNormalizedRuntimeEventWriter({
    dispatch,
    identity: params.identity,
  });

  const ensureUpstreamRegistered = (): void => {
    if (unsubscribeUpstream) return;
    unsubscribeUpstream = params.subscribeUpstream((message) => {
      const parsedRuntimeEvent = RuntimeEventV1Schema.safeParse(message);
      if (parsedRuntimeEvent.success && parsedRuntimeEvent.data.kind === 'descriptor-update') {
        runtimeEventWriter.handleMessage({
          type: 'event',
          name: 'runtime.descriptor',
          payload: parsedRuntimeEvent.data.descriptor,
        });
      } else {
        runtimeEventWriter.handleMessage(message as unknown as AgentMessage);
      }
      if (parsedRuntimeEvent.success) {
        void publishRuntimePluginEvent(parsedRuntimeEvent.data).catch(() => undefined);
      }
    });
  };

  const clearUpstreamSubscription = (): void => {
    unsubscribeUpstream?.();
    unsubscribeUpstream = null;
  };

  const subscribe = (handler: (message: TMessage) => void): (() => void) => {
    handlers.add(handler);
    ensureUpstreamRegistered();
    return () => {
      handlers.delete(handler);
      if (handlers.size === 0) {
        clearUpstreamSubscription();
      }
    };
  };

  const publishFallbackIdentity = (): void => {
    runtimeEventWriter.publishFallbackIdentity();
  };

  const dispose = (): void => {
    handlers.clear();
    clearUpstreamSubscription();
  };

  return Object.freeze({
    ensureUpstreamRegistered,
    publishFallbackIdentity,
    subscribe,
    dispose,
  });
}
