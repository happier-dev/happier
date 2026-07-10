import { describe, expect, it, vi } from 'vitest';

import type { RuntimeEventV1 } from '@happier-dev/protocol';

import {
  canPluginSubscribeToEvent,
  createPluginEventsService,
} from '@/plugins/runtime/context/events';

import { createNormalizedRuntimeEventPublicationHub } from './createNormalizedRuntimeEventPublicationHub';

describe('createNormalizedRuntimeEventPublicationHub', () => {
  it('allows a later runtime descriptor update to replace a fallback descriptor', () => {
    const upstream: { handler?: (message: unknown) => void } = {};
    const hub = createNormalizedRuntimeEventPublicationHub<unknown>({
      identity: {
        runtimeDescriptor: {
          v: 1,
          agentId: 'codex',
          agent: {
            backendMode: 'appServer',
          },
        },
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
    const messages: unknown[] = [];
    const unsubscribe = hub.subscribe((message) => {
      messages.push(message);
    });

    hub.publishFallbackIdentity();
    upstream.handler?.({
      type: 'event',
      name: 'runtime.descriptor',
      payload: {
        v: 1,
        agentId: 'codex',
        agent: {
          backendMode: 'appServer',
          providerSessionId: 'thread-1',
        },
      },
    });
    unsubscribe();

    expect(messages).toEqual([
      {
        type: 'event',
        name: 'runtime.descriptor',
        payload: {
          v: 1,
          agentId: 'codex',
          agent: {
            backendMode: 'appServer',
          },
        },
      },
      {
        type: 'event',
        name: 'runtime.descriptor',
        payload: {
          v: 1,
          agentId: 'codex',
          agent: {
            backendMode: 'appServer',
            providerSessionId: 'thread-1',
          },
        },
      },
    ]);
  });

  it('normalizes RuntimeEvent descriptor updates into runtime descriptor publications', () => {
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
    const messages: unknown[] = [];
    const unsubscribe = hub.subscribe((message) => {
      messages.push(message);
    });

    upstream.handler?.({
      kind: 'descriptor-update',
      sessionId: 'session-1',
      emittedAtMs: 1,
      descriptor: {
        v: 1,
        agentId: 'antigravity',
        agent: {
          runtimeMode: 'cliPrint',
          agyConversationId: 'agy-conversation-1',
        },
      },
    });
    unsubscribe();

    expect(messages).toEqual([
      {
        type: 'event',
        name: 'runtime.descriptor',
        payload: {
          v: 1,
          agentId: 'antigravity',
          agent: {
            runtimeMode: 'cliPrint',
            agyConversationId: 'agy-conversation-1',
          },
        },
      },
    ]);
  });

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
