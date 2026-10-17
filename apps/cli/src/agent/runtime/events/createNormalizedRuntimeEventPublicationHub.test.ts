import { describe, expect, it } from 'vitest';

import type { NormalizedRuntimeIdentityPublicationV1 } from './createNormalizedRuntimeEventWriter';
import { createNormalizedRuntimeEventPublicationHub } from './createNormalizedRuntimeEventPublicationHub';

describe('createNormalizedRuntimeEventPublicationHub', () => {
  it('retains cold messages until a message reader subscribes after an identity observer', () => {
    const messages: unknown[] = [];
    let activeWatches = 0;
    const startupMessage = { kind: 'message-delta', sessionId: 'startup-session', turnId: 'startup-turn',
      sequence: 1, emittedAtMs: 1, channel: 'assistant', text: 'startup answer' };
    const cold = [startupMessage];
    const hub = createNormalizedRuntimeEventPublicationHub<unknown>({
      identity: { runtimeDescriptor: null, runtimeCapabilities: null, runtimeFacets: null },
      subscribeUpstream(handler) {
        activeWatches += 1;
        for (const message of cold.splice(0)) handler(message);
        return () => { activeWatches -= 1; };
      },
    });
    const stopIdentity = hub.subscribeIdentityPublication(() => undefined);
    const stopMessages = hub.subscribe(message => messages.push(message));
    expect(messages).toEqual([startupMessage]);
    stopMessages();
    expect(activeWatches).toBe(0);
    stopIdentity();
    hub.dispose();
  });

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
    const published: NormalizedRuntimeIdentityPublicationV1[] = [];
    const unsubscribe = hub.subscribeIdentityPublication((publication) => {
      published.push(publication);
    });

    hub.publishFallbackIdentity();
    const stopMessages = hub.subscribe(() => undefined);
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
    stopMessages();

    expect(published).toEqual([
      {
        fact: 'runtimeDescriptor',
        value: {
          v: 1,
          agentId: 'codex',
          agent: {
            backendMode: 'appServer',
          },
        },
      },
      {
        fact: 'runtimeDescriptor',
        value: {
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

  it('normalizes runtime descriptor publications from the dedicated publication seam', () => {
    const upstream: { handler?: (message: unknown) => void } = {};
    const hub = createNormalizedRuntimeEventPublicationHub<unknown>({
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
    const published: NormalizedRuntimeIdentityPublicationV1[] = [];
    const messages: unknown[] = [];
    hub.subscribe((message) => messages.push(message));
    const unsubscribe = hub.subscribeIdentityPublication((publication) => {
      published.push(publication);
    });

    upstream.handler?.({
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
    });
    unsubscribe();

    expect(published).toEqual([
      {
        fact: 'runtimeDescriptor',
        value: {
          v: 1,
          agentId: 'antigravity',
          agent: {
            runtimeMode: 'cliPrint',
            agyConversationId: 'agy-conversation-1',
          },
        },
      },
    ]);
    // Host-owned identity never reaches the message stream unless the legacy
    // `AgentMessage` mirror is explicitly enabled.
    expect(messages).toEqual([]);
  });

  it('replays every already-published fact to a late identity subscriber', () => {
    const hub = createNormalizedRuntimeEventPublicationHub<unknown>({
      identity: {
        runtimeDescriptor: {
          v: 1,
          agentId: 'codex',
          agent: { backendMode: 'appServer' },
        },
        runtimeCapabilities: { backend: { sessions: { supported: true } } },
        runtimeFacets: { v: 1, transcriptSource: { supported: true } },
      },
      subscribeUpstream: () => () => undefined,
    });

    hub.publishFallbackIdentity();

    const published: NormalizedRuntimeIdentityPublicationV1[] = [];
    hub.subscribeIdentityPublication((publication) => published.push(publication));

    expect(published.map((publication) => publication.fact)).toEqual([
      'runtimeDescriptor',
      'runtimeCapabilities',
      'runtimeFacets',
    ]);
  });

  it('mirrors identity publication onto the legacy AgentMessage stream when the execution-run bridge asks for it', () => {
    const hub = createNormalizedRuntimeEventPublicationHub<unknown>({
      identity: {
        runtimeDescriptor: null,
        runtimeCapabilities: { backend: { sessions: { supported: true } } },
        runtimeFacets: null,
      },
      subscribeUpstream: () => () => undefined,
      mirrorIdentityPublicationToMessageStream: true,
    });
    const messages: unknown[] = [];
    hub.subscribe((message) => messages.push(message));

    hub.publishFallbackIdentity();

    expect(messages).toEqual([{
      type: 'event',
      name: 'runtime.capabilities',
      payload: { backend: { sessions: { supported: true } } },
    }]);
  });
});
