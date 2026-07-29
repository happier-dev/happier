import { describe, expect, it, vi } from 'vitest';

import type { Session } from '@/sync/domains/state/storageTypes';
import type {
  ServerAccountSessionRequestAuthority,
} from '@/sync/runtime/orchestration/serverScopedRpc/createSessionRequestWithServerScope';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import type { VoiceProviderRegistry } from '@/voice/registry/providerRegistry';

import {
  createDefaultVoiceHistoryConsumerFromRuntime,
  resolveVoiceHistoryProviderLabel,
  type DefaultVoiceHistoryRuntime,
} from './defaultVoiceHistoryConsumer';

describe('resolveVoiceHistoryProviderTitleKey', () => {
  it('uses exact provider contribution identity and descriptor-owned copy', () => {
    const registry = {
      get: () => null,
      list: () => [
        {
          kind: 'voice.conversation-provider.v1',
          pluginId: 'happier.voice.openai',
          providerId: 'realtime_openai',
          declaration: {
            id: 'realtime-openai',
            title: 'OpenAI Realtime Voice',
          },
          selectionOptions: [{
            id: 'byo',
            modeId: 'byo',
            order: 1,
            titleKey: 'settingsVoice.mode.openaiRealtime',
            subtitleKey: 'settingsVoice.mode.openaiRealtimeSubtitle',
          }],
          source: { kind: 'bundled', pluginId: 'happier.voice.openai' },
        },
        {
          kind: 'voice.conversation-provider.v1',
          pluginId: 'happier.voice.openai',
          providerId: 'other',
          declaration: { id: 'other', title: 'Other provider' },
          selectionOptions: [{
            id: 'other',
            modeId: null,
            order: 2,
            titleKey: 'wrong.title',
            subtitleKey: 'wrong.subtitle',
          }],
          source: { kind: 'bundled', pluginId: 'happier.voice.openai' },
        },
      ],
    } as unknown as VoiceProviderRegistry;

    expect(resolveVoiceHistoryProviderLabel(
      registry,
      {
        pluginId: 'happier.voice.openai',
        contributionId: 'realtime-openai',
      },
      (key) => `translated:${key}`,
    )).toBe('OpenAI Realtime Voice');
    expect(resolveVoiceHistoryProviderLabel(
      registry,
      {
        pluginId: 'happier.voice.unknown',
        contributionId: 'realtime-openai',
      },
      (key) => `translated:${key}`,
    )).toBeNull();
  });
});

describe('createDefaultVoiceHistoryConsumerFromRuntime', () => {
  it('performs no lookup when account authority capture fails during a same-server switch', async () => {
    const scopeA = { serverId: 'server-1', accountId: 'account-a' } as const;
    const scopeB = { serverId: 'server-1', accountId: 'account-b' } as const;
    let activeScope: ServerAccountScope = scopeA;
    let releaseCapture!: () => void;
    const captureGate = new Promise<void>((resolve) => {
      releaseCapture = resolve;
    });
    const lookupByTags = vi.fn(async () => []);
    const runtime: DefaultVoiceHistoryRuntime = {
      readActiveScope: () => activeScope,
      captureAuthority: async (requestedScope) => {
        await captureGate;
        if (activeScope.accountId !== requestedScope.accountId) {
          throw new Error('authenticated account does not match captured scope');
        }
        throw new Error('unreachable');
      },
      lookupByTags,
      hydrateSession: async () => ({ kind: 'missing' }),
      readHydratedSession: () => null,
      refreshSessionMessages: async () => undefined,
      loadOlderMessages: async () => ({
        loaded: 0,
        hasMore: false,
        status: 'no_more',
      }),
      readMessages: () => [],
      deleteSession: async () => ({ success: true }),
      canDeleteSession: () => true,
      retireLocalSession: () => undefined,
    };
    const registry = {
      list: () => [],
      get: () => null,
    } as unknown as VoiceProviderRegistry;
    const consumer = createDefaultVoiceHistoryConsumerFromRuntime(runtime, registry);

    const open = consumer.open();
    activeScope = scopeB;
    releaseCapture();

    await expect(open).rejects.toThrow('authenticated account does not match captured scope');
    expect(lookupByTags).not.toHaveBeenCalled();
  });

  it('forwards one captured authority through lookup, hydration, refresh, paging, and delete', async () => {
    const scopeA = { serverId: 'server-1', accountId: 'account-a' } as const;
    const authorityA = {
      scope: scopeA,
      context: {
        scope: 'scoped',
        timeoutMs: 30_000,
        targetServerId: scopeA.serverId,
        targetServerUrl: 'https://same-server.example',
        targetAccountId: scopeA.accountId,
        token: 'token-a',
        credentials: { token: 'token-a', secret: 'secret-a' },
        encryption: {},
      },
      request: async () => new Response(null, { status: 200 }),
    } as unknown as ServerAccountSessionRequestAuthority;
    const calls: Array<Readonly<{
      operation: 'lookup' | 'hydrate' | 'refresh' | 'page' | 'delete';
      authority: ServerAccountSessionRequestAuthority;
    }>> = [];
    const runtime: DefaultVoiceHistoryRuntime = {
      readActiveScope: () => scopeA,
      captureAuthority: async () => authorityA,
      lookupByTags: async (_tags, authority) => {
        calls.push({ operation: 'lookup', authority });
        return [{ id: 'voice-history' }];
      },
      hydrateSession: async (sessionId, authority) => {
        calls.push({ operation: 'hydrate', authority });
        return { kind: 'available', sessionId };
      },
      readHydratedSession: (sessionId) => ({
        id: sessionId,
        active: false,
        metadata: {
          systemSessionV1: {
            v: 1,
            key: 'voice_transcript_history',
            hidden: true,
          },
        },
      }) as unknown as Session,
      refreshSessionMessages: async (_sessionId, authority) => {
        calls.push({ operation: 'refresh', authority });
      },
      loadOlderMessages: async (_sessionId, authority) => {
        calls.push({ operation: 'page', authority });
        return { loaded: 0, hasMore: false, status: 'no_more' };
      },
      readMessages: () => [],
      deleteSession: async (_sessionId, authority) => {
        calls.push({ operation: 'delete', authority });
        return { success: true };
      },
      canDeleteSession: () => true,
      retireLocalSession: () => undefined,
    };
    const registry = {
      list: () => [],
      get: () => null,
    } as unknown as VoiceProviderRegistry;
    const consumer = createDefaultVoiceHistoryConsumerFromRuntime(runtime, registry);

    await consumer.open();
    await consumer.loadOlder();
    await consumer.clear();

    expect(calls.map((call) => call.operation)).toEqual([
      'lookup',
      'hydrate',
      'refresh',
      'page',
      'delete',
    ]);
    expect(calls.every((call) => call.authority === authorityA)).toBe(true);
  });

  it('rejects a same-server account switch while every in-flight request remains bound to the captured account', async () => {
    const scopeA = { serverId: 'server-1', accountId: 'account-a' } as const;
    const scopeB = { serverId: 'server-1', accountId: 'account-b' } as const;
    let activeScope: ServerAccountScope = scopeA;
    let resolveLookup!: (sessions: readonly { id: string }[]) => void;
    const lookup = new Promise<readonly { id: string }[]>((resolve) => {
      resolveLookup = resolve;
    });
    const authorityA = {
      scope: scopeA,
      context: {
        scope: 'scoped',
        timeoutMs: 30_000,
        targetServerId: scopeA.serverId,
        targetServerUrl: 'https://same-server.example',
        targetAccountId: scopeA.accountId,
        token: 'token-a',
        credentials: { token: 'token-a', secret: 'secret-a' },
        encryption: {},
      },
      request: async () => new Response(null, { status: 200 }),
    } as unknown as ServerAccountSessionRequestAuthority;
    const seenAuthorities: ServerAccountSessionRequestAuthority[] = [];
    const runtime: DefaultVoiceHistoryRuntime = {
      readActiveScope: () => activeScope,
      captureAuthority: async () => authorityA,
      lookupByTags: async (_tags, authority) => {
        seenAuthorities.push(authority);
        return await lookup;
      },
      hydrateSession: async (sessionId, authority) => {
        seenAuthorities.push(authority);
        return { kind: 'available', sessionId };
      },
      readHydratedSession: (sessionId) => ({
        id: sessionId,
        active: false,
        metadata: {
          systemSessionV1: {
            v: 1,
            key: 'voice_transcript_history',
            hidden: true,
          },
        },
      }) as unknown as Session,
      refreshSessionMessages: async (_sessionId, authority) => {
        seenAuthorities.push(authority);
      },
      loadOlderMessages: async (_sessionId, authority) => {
        seenAuthorities.push(authority);
        return { loaded: 0, hasMore: false, status: 'no_more' };
      },
      readMessages: () => [],
      deleteSession: async (_sessionId, authority) => {
        seenAuthorities.push(authority);
        return { success: true };
      },
      canDeleteSession: () => true,
      retireLocalSession: () => undefined,
    };
    const registry = {
      list: () => [],
      get: () => null,
    } as unknown as VoiceProviderRegistry;
    const consumer = createDefaultVoiceHistoryConsumerFromRuntime(runtime, registry);

    const open = consumer.open();
    activeScope = scopeB;
    resolveLookup([{ id: 'voice-history' }]);

    await expect(open).rejects.toMatchObject({
      name: 'VoiceHistoryOperationSupersededError',
    });
    expect(seenAuthorities).toEqual([authorityA, authorityA]);
    expect(seenAuthorities.every((authority) => (
      authority.context.token === 'token-a'
      && authority.scope.accountId === 'account-a'
    ))).toBe(true);
  });
});
