import 'fake-indexeddb/auto';
import { createSessionReadBatchFetchBoundary } from '@/dev/testkit/harness/sessionReadBatchHttpBoundary';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createSessionFixture } from '@/dev/testkit';

const fixtureMetadata = (() => {
    const metadata = createSessionFixture().metadata;
    if (!metadata) throw new Error('Canonical Session fixture metadata missing');
    return metadata;
})();
import { VoiceProviderContributionSchema } from '@happier-dev/protocol/plugins/contributions/voice';
import type {
  ServerAccountRequestAuthority,
} from '@/sync/runtime/orchestration/serverScopedRpc/createServerRequestWithServerScope';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { createSessionMetadataHttpBoundary } from '@/dev/testkit/harness/sessionMetadataHttpBoundary';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { SessionCurrentProjectionRecordV1Schema} from '@happier-dev/protocol/sessions/listing/response';
import { SessionMessagesPageV1Schema } from '@happier-dev/protocol/sessions/messages/sessionMessagesPageV1';

import type { DefaultVoiceHistoryRuntime } from './defaultVoiceHistoryConsumer';
import { VoiceHistoryOperationSupersededError } from './voiceHistoryConsumer';

const historyHttp = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(historyHttp);
installDisconnectedServerSocketBoundary();
await loadSyncSingletonForTests();
const { createVoiceProviderRegistry } = await import('@/voice/registry/providerRegistry');
const { buildSystemSessionMetadataV1 } = await import('@happier-dev/protocol/sessions/control/contract');
const buildVoiceConversationMetadata = () => buildSystemSessionMetadataV1({ key: 'voice_conversation', hidden: true });
const { buildRealtimeConversationRawRecord } = await import('@/voice/transcript/VoiceTranscriptProjector');
const { createDefaultVoiceHistoryConsumerFromRuntime, createDefaultVoiceHistoryConsumer,
  resolveVoiceHistoryProviderLabel } = await import('./defaultVoiceHistoryConsumer');
const { tLoose } = await import('@/text');
const { captureServerRequestAuthorityForServerAccountScope } = await import('@/sync/runtime/orchestration/serverScopedRpc/createServerRequestWithServerScope');
const { setRuntimeFetch, resetRuntimeFetch } = await import('@/utils/system/runtimeFetch');

async function captureHistoryAuthority(accountId: string) {
  await historyHttp.reset();
  const serverId = await historyHttp.addHome({ name: 'History authority Home',
    serverUrl: 'https://history-authority.test', accountId, currentAccount: true, active: false });
  setRuntimeFetch(createSessionReadBatchFetchBoundary(historyHttp.request));
  return await captureServerRequestAuthorityForServerAccountScope({
    scope: { serverId, accountId }, activeRequest: historyHttp.request,
  });
}

afterEach(async () => {
  resetRuntimeFetch();
  await historyHttp.reset();
});

describe('canonical History Account boundary', () => {
  it('keeps cold discovery, hydration, transcript paging and carrier deletion on the admitted Account', async () => {
    const { storage } = await import('@/sync/domains/state/storage');
    const { switchConnectionToActiveServer, disconnectActiveServerConnection } = await import('@/sync/runtime/orchestration/connectionManager');
    const { setRuntimeFetch, resetRuntimeFetch } = await import('@/utils/system/runtimeFetch');
    const { TokenStorage } = await import('@/auth/storage/tokenStorage');
    await historyHttp.reset();
    installHomeGovernanceBoundaries(historyHttp);
    const homeId = await historyHttp.addHome({ name: 'History Home', serverUrl: 'https://history-owner.test', accountId: 'history-account', currentAccount: true });
  setRuntimeFetch(createSessionReadBatchFetchBoundary(historyHttp.request));
    const sessionId = 'history-carrier';
    const session = createSessionFixture({ id: sessionId, serverId: homeId, seq: 20, active: false,
      metadata: { ...fixtureMetadata, ...buildVoiceConversationMetadata() },
    });
    const metadata = createSessionMetadataHttpBoundary(() => ({ [sessionId]: session }));
    const response = metadata.handle(`https://history-owner.test/v2/sessions/${sessionId}`);
    if (!response) throw new Error('Missing canonical History Session response');
    const detail: unknown = await response.json();
    if (!detail || typeof detail !== 'object' || !('session' in detail)) throw new Error('Missing canonical Session detail');
    const wire = SessionCurrentProjectionRecordV1Schema.parse(detail.session);
    historyHttp.answer(homeId, '/v1/auth/ping', { body: {} });
    historyHttp.answer(homeId, '/v1/account/encryption/currentness', { body: createPlainAccountEncryptionCurrentnessFixture() });
    historyHttp.answer(homeId, '/v2/sessions', { body: { sessions: [wire], hasNext: false, nextCursor: null } });
    historyHttp.answer(homeId, '/v2/sessions/archived', { body: { sessions: [], hasNext: false, nextCursor: null } });
    historyHttp.answer(homeId, `/v2/sessions/${sessionId}`, { body: { session: wire } });
    historyHttp.answer(homeId, `DELETE /v1/sessions/${sessionId}`, { body: { success: true } });
    const page = (seq: number, hasMore: boolean) => SessionMessagesPageV1Schema.parse({ messages: [{
      id: `voice-${seq}`, localId: null, seq, createdAt: seq, messageRole: 'agent',
      content: { t: 'plain', v: buildRealtimeConversationRawRecord({ id: `voice-${seq}`, role: 'assistant', text: `Voice ${seq}` }) },
    }], hasMore, nextBeforeSeq: hasMore ? seq : null });
    historyHttp.answer(homeId, `/v1/sessions/${sessionId}/messages`, { select: () => ({
      body: page(historyHttp.requests.at(-1)?.path.includes('beforeSeq=20') ? 10 : 20,
        !historyHttp.requests.at(-1)?.path.includes('beforeSeq=20')),
    }) });
    try {
      await switchConnectionToActiveServer();
      const consumer = createDefaultVoiceHistoryConsumer();
      await consumer.open();
      expect(consumer.read().rows.map(row => row.text)).toEqual(['Voice 20']);
      await consumer.loadOlder();
      expect(consumer.read().rows.map(row => row.text)).toEqual(['Voice 10', 'Voice 20']);
      await consumer.clear();
      expect(consumer.read().rows).toEqual([]);
      expect(storage.getState().sessions[sessionId]).toBeUndefined();
      expect(storage.getState().sessionMessages[sessionId]).toBeUndefined();
      const credentials = await TokenStorage.getCredentialsForServerUrl('https://history-owner.test');
      expect(credentials).not.toBeNull();
      const requests = historyHttp.requests.filter(request => request.path.includes(sessionId) || request.path === '/v2/sessions/lookup-by-tags');
      expect(requests.some(request => request.path.includes('beforeSeq=20'))).toBe(true);
      expect(requests.every(request => request.serverId === homeId && request.token === credentials?.token)).toBe(true);
    } finally {
      await disconnectActiveServerConnection();
      resetRuntimeFetch();
      await historyHttp.reset();
    }
  });
});

describe('resolveVoiceHistoryProviderTitleKey', () => {
  it('uses exact provider contribution identity and descriptor-owned copy', () => {
    const declarations = [
      { id: 'realtime-openai', title: 'OpenAI Realtime Voice' },
      { id: 'other', title: 'Other provider' },
    ].map((identity) => ({
      pluginId: 'happier.voice.openai',
      providerId: `happier.voice.openai/${identity.id}`,
      declaration: VoiceProviderContributionSchema.parse({
        ...identity,
        kind: 'conversation', roles: ['realtime_conversation'], platforms: ['web'],
        capabilities: { turn: { cancelResponse: true, bargeIn: true }, tools: { effectCalls: 'none' } },
        client: { artifactId: 'voice', exportName: 'activate' },
      }),
    }));
    const registry = createVoiceProviderRegistry({
      bundledContributions: declarations,
      bundledPresentations: declarations.map(({ providerId }) => ({
        providerId,
        settingsSectionId: 'voice.fixture',
        selectionOptions: [{ id: 'byo', modeId: 'byo', order: 1, titleKey: 'wrong.title' }],
      })),
    });

    expect(resolveVoiceHistoryProviderLabel(
      registry,
      {
        pluginId: 'happier.voice.openai',
        contributionId: 'realtime-openai',
      },
      tLoose,
    )).toBe('OpenAI Realtime Voice');
    expect(resolveVoiceHistoryProviderLabel(
      registry,
      {
        pluginId: 'happier.voice.unknown',
        contributionId: 'realtime-openai',
      },
      tLoose,
    )).toBeNull();
  });
});

describe('createDefaultVoiceHistoryConsumerFromRuntime', () => {
  it('exposes only safe canonical initial-load stage facts while preserving existing typed and code-compatible failures', async () => {
    const authority = await captureHistoryAuthority('account-a');
    const scope = authority.scope;
    const registry = createVoiceProviderRegistry({});
    const createRuntime = (
      overrides: Partial<DefaultVoiceHistoryRuntime> = {},
    ): DefaultVoiceHistoryRuntime => ({
      readActiveScope: () => scope,
      captureAuthority: async () => authority,
      listConversations: async () => [{ id: 'voice-history' }],
      hydrateSession: async (sessionId) => ({ kind: 'available', sessionId }),
      refreshSessionMessages: async () => undefined,
      loadOlderMessages: async () => ({
        loaded: 0,
        hasMore: false,
        status: 'no_more',
      }),
      readMessages: () => [],
      readMessagesRevision: () => 0,
      subscribeMessages: () => () => {},
      deleteSession: async () => ({ success: true }),
      retireLocalSession: () => undefined,
      ...overrides,
    });
    const stageCases: ReadonlyArray<Readonly<{
      stage: 'capture_scope' | 'lookup' | 'hydrate' | 'refresh';
      runtime: DefaultVoiceHistoryRuntime;
      status?: number;
    }>> = [
      {
        stage: 'capture_scope',
        runtime: createRuntime({
          captureAuthority: async () => {
            throw new Error('captured account details');
          },
        }),
      },
      {
        stage: 'lookup',
        runtime: createRuntime({
          listConversations: async () => {
            throw Object.assign(new Error('lookup response body'), { status: 503 });
          },
        }),
        status: 503,
      },
      {
        stage: 'hydrate',
        runtime: createRuntime({
          hydrateSession: async () => {
            throw new Error('hydration response body');
          },
        }),
      },
      {
        stage: 'refresh',
        runtime: createRuntime({
          refreshSessionMessages: async () => {
            throw new Error('refresh response body');
          },
        }),
      },
    ];

    for (const testCase of stageCases) {
      const consumer = createDefaultVoiceHistoryConsumerFromRuntime(testCase.runtime, registry);
      await expect(consumer.open()).rejects.toMatchObject({
        code: 'voice_history_load_failed',
        stage: testCase.stage,
        ...(testCase.status === undefined ? {} : { status: testCase.status }),
        message: 'Voice History failed to load',
      });
    }

    const outOfRangeStatusConsumer = createDefaultVoiceHistoryConsumerFromRuntime(
      createRuntime({
        listConversations: async () => {
          throw Object.assign(new Error('lookup response body'), { status: 700 });
        },
      }),
      registry,
    );
    await expect(outOfRangeStatusConsumer.open()).rejects.toMatchObject({
      code: 'voice_history_load_failed',
      stage: 'lookup',
      message: 'Voice History failed to load',
    });
    await expect(outOfRangeStatusConsumer.open()).rejects.not.toHaveProperty('status');

    const superseded = new VoiceHistoryOperationSupersededError();
    await expect(createDefaultVoiceHistoryConsumerFromRuntime(
      createRuntime({
        listConversations: async () => {
          throw superseded;
        },
      }),
      registry,
    ).open()).rejects.toBe(superseded);

    const codeCompatibleSuperseded = {
      code: 'voice_history_operation_superseded',
    } as const;
    await expect(createDefaultVoiceHistoryConsumerFromRuntime(
      createRuntime({
        listConversations: async () => {
          throw codeCompatibleSuperseded;
        },
      }),
      registry,
    ).open()).rejects.toBe(codeCompatibleSuperseded);
  });

  it('performs no lookup when account authority capture fails during a same-server switch', async () => {
    const scopeA = { serverId: 'server-1', accountId: 'account-a' } as const;
    const scopeB = { serverId: 'server-1', accountId: 'account-b' } as const;
    let activeScope: ServerAccountScope = scopeA;
    let releaseCapture!: () => void;
    const captureGate = new Promise<void>((resolve) => {
      releaseCapture = resolve;
    });
    const listConversations = vi.fn(async () => []);
    const runtime: DefaultVoiceHistoryRuntime = {
      readActiveScope: () => activeScope,
      captureAuthority: async (requestedScope) => {
        await captureGate;
        if (activeScope.accountId !== requestedScope.accountId) {
          throw new Error('authenticated account does not match captured scope');
        }
        throw new Error('unreachable');
      },
      listConversations,
      hydrateSession: async () => ({ kind: 'missing' }),
      refreshSessionMessages: async () => undefined,
      loadOlderMessages: async () => ({
        loaded: 0,
        hasMore: false,
        status: 'no_more',
      }),
      readMessages: () => [],
      readMessagesRevision: () => 0,
      subscribeMessages: () => () => {},
      deleteSession: async () => ({ success: true }),
      retireLocalSession: () => undefined,
    };
    const registry = createVoiceProviderRegistry({});
    const consumer = createDefaultVoiceHistoryConsumerFromRuntime(runtime, registry);

    const open = consumer.open();
    activeScope = scopeB;
    releaseCapture();

    await expect(open).rejects.toMatchObject({
      code: 'voice_history_load_failed',
      stage: 'capture_scope',
      message: 'Voice History failed to load',
    });
    expect(listConversations).not.toHaveBeenCalled();
  });

  it('rejects a same-server account switch while every in-flight request remains bound to the captured account', async () => {
    const authorityA = await captureHistoryAuthority('account-a');
    const scopeA = authorityA.scope;
    const scopeB = { serverId: scopeA.serverId, accountId: 'account-b' } as const;
    let activeScope: ServerAccountScope = scopeA;
    let resolveLookup!: (sessions: readonly { id: string }[]) => void;
    const lookup = new Promise<readonly { id: string }[]>((resolve) => {
      resolveLookup = resolve;
    });
    const seenAuthorities: ServerAccountRequestAuthority[] = [];
    const runtime: DefaultVoiceHistoryRuntime = {
      readActiveScope: () => activeScope,
      captureAuthority: async () => authorityA,
      listConversations: async (authority) => {
        seenAuthorities.push(authority);
        return await lookup;
      },
      hydrateSession: async (sessionId, authority) => {
        seenAuthorities.push(authority);
        return { kind: 'available', sessionId };
      },
      refreshSessionMessages: async (_sessionId, authority) => {
        seenAuthorities.push(authority);
      },
      loadOlderMessages: async (_sessionId, authority) => {
        seenAuthorities.push(authority);
        return { loaded: 0, hasMore: false, status: 'no_more' };
      },
      readMessages: () => [],
      readMessagesRevision: () => 0,
      subscribeMessages: () => () => {},
      deleteSession: async (_sessionId, authority) => {
        seenAuthorities.push(authority);
        return { success: true };
      },
      retireLocalSession: () => undefined,
    };
    const registry = createVoiceProviderRegistry({});
    const consumer = createDefaultVoiceHistoryConsumerFromRuntime(runtime, registry);

    const open = consumer.open();
    activeScope = scopeB;
    resolveLookup([{ id: 'voice-history' }]);

    await expect(open).rejects.toMatchObject({
      name: 'VoiceHistoryOperationSupersededError',
    });
    expect(seenAuthorities).toEqual([authorityA, authorityA]);
    expect(seenAuthorities.every((authority) => (
      authority.context.token === authorityA.context.token
      && authority.scope.accountId === 'account-a'
    ))).toBe(true);
  });
});
