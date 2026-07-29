import { describe, expect, it } from 'vitest';

import type { RuntimeEventV1 } from '@happier-dev/protocol';

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

});
