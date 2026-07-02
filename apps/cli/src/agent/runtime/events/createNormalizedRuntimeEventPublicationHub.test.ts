import { describe, expect, it, vi } from 'vitest';

import type { RuntimeEventV1 } from '@happier-dev/protocol';

import {
  canPluginSubscribeToEvent,
  createPluginEventsService,
} from '@/plugins/runtime/context/events';

import { createNormalizedRuntimeEventPublicationHub } from './createNormalizedRuntimeEventPublicationHub';

describe('createNormalizedRuntimeEventPublicationHub', () => {
  it('publishes canonical runtime events to the reserved plugin event bus namespace', async () => {
    const upstream: { handler?: (message: RuntimeEventV1) => void } = {};
    const hub = createNormalizedRuntimeEventPublicationHub<RuntimeEventV1>({
      identity: {
        runtimeDescriptor: null,
        runtimeCapabilities: null,
        runtimeFacets: null,
      },
      subscribeUpstream(handler) {
        upstream.handler = handler;
        return () => {
          if (upstream.handler === handler) {
            delete upstream.handler;
          }
        };
      },
    });
    const observer = createPluginEventsService({
      pluginId: 'observer.plugin',
      canSubscribe: (eventName) => canPluginSubscribeToEvent({
        pluginId: 'observer.plugin',
        eventName,
        permissions: new Set(['events.runtime.subscribe']),
      }),
    });
    const listener = vi.fn();
    const subscription = observer.subscribe('@happier/runtime/turn-start', listener);
    const unsubscribe = hub.subscribe(() => undefined);
    const event = {
      kind: 'turn-start',
      sessionId: 'session-1',
      turnId: 'turn-1',
      emittedAtMs: 1,
    } satisfies RuntimeEventV1;

    if (!upstream.handler) {
      throw new Error('expected upstream runtime event handler to be subscribed');
    }
    upstream.handler(event);

    await vi.waitFor(() => {
      expect(listener).toHaveBeenCalledWith({
        id: '@happier/runtime/turn-start',
        payload: event,
        envelope: expect.objectContaining({
          emittedAt: expect.any(String),
          sequence: expect.any(Number),
          source: {
            kind: 'host',
            namespace: 'runtime',
          },
        }),
      });
    });

    unsubscribe();
    subscription.unsubscribe();
  });
});
