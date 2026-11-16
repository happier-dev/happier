import { createSessionReadBatchFetchBoundary } from '@/dev/testkit/harness/sessionReadBatchHttpBoundary';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import {
  SessionMetadataTuplePatchV1Schema} from '@happier-dev/protocol/sessions/metadata/sessionMetadataSchemasV1';
import {
  SessionLookupByTagsResponseV2Schema,
  SessionLookupByTagsRequestV2Schema,
} from '@happier-dev/protocol/sessions/control/contract';
import { projectSessionOwnerCompatibilityViewV1 } from '@happier-dev/protocol/sessions/metadata/sessionMetadataSchemasV1';
import { createDeferred, createSessionFixture } from '@/dev/testkit';
import { createSessionMetadataHttpBoundary } from '@/dev/testkit/harness/sessionMetadataHttpBoundary';
import { createVoiceSettingsAccountTestHarness } from '@/voice/settings/panels/voiceSettingsAccountTestHarness';
import { settingsParse } from '@/sync/domains/settings/settings';
import { storage } from '@/sync/domains/state/storage';
import { voiceSessionBindingStore } from '@/voice/binding/voiceConversationBindingStore';
import { buildVoiceTranscriptHistorySessionMetadata, VOICE_TRANSCRIPT_HISTORY_SYSTEM_SESSION_TAG } from '@/voice/persistence/voiceTranscriptHistorySession';
import { readSessionOwnerMetadataView } from '@/sync/domains/session/readSessionOwnerMetadataView';
import { readVoiceProviderConversationMetadata, writeVoiceProviderConversationMetadata } from '@/voice/persistence/voiceProviderConversationMetadata';
import { VOICE_PROVIDER_CONVERSATION_RETENTION_MS } from '@/voice/persistence/voiceProviderConversationRetention';
import { createBundledConversationRuntimeHostLease } from './bundledConversationRuntimeHost';
import { getProviderConversationServiceFactory } from './providerConversationService';

vi.mock('socket.io-client', async original =>
  (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(original));

const providerId = 'happier.voice.xai/realtime-grok';

/** Real host/Sync ordering and codecs; delays and refusals occur only at Home HTTP. */
async function installProviderPersistence(seeds: readonly Readonly<{
  sessionId: string; conversationId?: string; updatedAt?: number;
}>[]) {
  const account = await createVoiceSettingsAccountTestHarness(settingsParse({}));
  onTestFinished(account.dispose);
  const sessions = Object.fromEntries(seeds.map(seed => [seed.sessionId, createSessionFixture({
    id: seed.sessionId, serverId: account.scope.serverId,
    metadata: writeVoiceProviderConversationMetadata({ path: '/voice', host: 'voice.test',
      ...(seed.sessionId === 'history-session' ? buildVoiceTranscriptHistorySessionMetadata() : {}),
    }, { providerId, state: seed.conversationId ? { conversationId: seed.conversationId } : null,
      updatedAt: seed.updatedAt ?? Date.now() }),
  })]));
  const sessionHttp = createSessionMetadataHttpBoundary(() => sessions);
  const request = account.request.getMockImplementation();
  if (!request) throw new Error('Account HTTP boundary missing');
  const attempts: Array<readonly [string, string | null]> = [];
  const commits: Array<readonly [string, string | null]> = [];
  let beforePatch: (() => Promise<void>) | null = null;
  account.request.mockImplementation(createSessionReadBatchFetchBoundary(async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname === '/v2/sessions/lookup-by-tags') {
      expect(SessionLookupByTagsRequestV2Schema.parse(JSON.parse(String(init?.body))).tags)
        .toEqual([VOICE_TRANSCRIPT_HISTORY_SYSTEM_SESSION_TAG]);
      const history = sessions['history-session'];
      const detail = history ? sessionHttp.handle(new URL(`/v2/sessions/${history.id}`, url)) : null;
      return Response.json(SessionLookupByTagsResponseV2Schema.parse({
        sessions: detail ? [(await detail.json()).session] : [],
      }));
    }
    let attempted: readonly [string, string | null] | null = null;
    if (init?.method === 'PATCH' && url.pathname.startsWith('/v2/sessions/')) {
      const patch = SessionMetadataTuplePatchV1Schema.parse(JSON.parse(String(init.body)));
      if (patch.mode !== 'owner_migration' && patch.mode !== 'owner') throw new Error('Expected owner mutation');
      const target = patch.mode === 'owner_migration' ? patch.target : patch;
      if (target.ownerMetadata.t !== 'plain') throw new Error('Expected Plain Account owner metadata');
      const metadata = projectSessionOwnerCompatibilityViewV1({
        sharedMetadata: JSON.parse(target.sharedMetadata.ciphertext), ownerMetadata: target.ownerMetadata.v,
      });
      attempted = [decodeURIComponent(url.pathname.slice('/v2/sessions/'.length)),
        readVoiceProviderConversationMetadata(metadata, providerId)?.conversationId ?? null];
      attempts.push(attempted);
      const barrier = beforePatch;
      beforePatch = null;
      await barrier?.();
    }
    const response = sessionHttp.handle(input, init) ?? await request(input, init);
    if (attempted && response.ok) commits.push(attempted);
    return response;
  }));
  storage.setState({ sessions });
  // The HTTP boundary serves current owner tuples. Hydrate those tuples before
  // observing provider mutations, so a legacy seed's privacy upgrade cannot
  // consume the write barrier or the injected failure under test.
  const { sync } = await import('@/sync/syncEngine');
  for (const session of Object.values(sessions)) {
    await sync.ensureSessionVisibleForMessageRoute(session.id, {
      forceRefresh: true, hydrateMessages: false, serverId: account.scope.serverId,
    });
  }
  voiceSessionBindingStore.setState({ runtimeBindingsByConversationSessionId: {}, persistedBindingsByConversationSessionId: {} });
  const lease = createBundledConversationRuntimeHostLease();
  onTestFinished(() => lease.revoke());
  for (const session of Object.values(sessions)) {
    await lease.host.acquireDirectMediaConversation({
      adapterId: providerId, controlSessionId: session.id,
      requestedTargetSessionAddress: { serverId: account.scope.serverId, sessionId: session.id },
    });
  }
  // Binding admission persists its own metadata before the tested provider
  // attempt begins; measure mutations from that settled boundary.
  attempts.length = 0;
  commits.length = 0;
  const factory = getProviderConversationServiceFactory(lease.host, providerId);
  return {
    host: lease.host, factory, attempts, commits,
    rejectNextPatch: sessionHttp.rejectNextPatch,
    beforeNextPatch(barrier: () => Promise<void>) { beforePatch = barrier; },
    read(sessionId: string) {
      return readVoiceProviderConversationMetadata(
        readSessionOwnerMetadataView(storage.getState().sessions[sessionId]!), providerId,
      )?.conversationId ?? null;
    },
  };
}

describe('provider conversation service', () => {
  it('orders forget after an in-flight write and rejects late writes from the invalidated attempt', async () => {
    const fixture = await installProviderPersistence([{ sessionId: 'session-1', conversationId: 'conv-old' }]);
    const admitted = createDeferred<void>();
    const release = createDeferred<void>();
    fixture.beforeNextPatch(async () => { admitted.resolve(); await release.promise; });
    const attempt = fixture.factory.createAttempt('session-1');
    await expect(attempt.read()).resolves.toBe('conv-old');
    const writing = attempt.write('conv-stale');
    await admitted.promise;
    const forgetting = attempt.forget();
    await attempt.write('conv-too-late');
    release.resolve();
    await Promise.all([writing, forgetting]);
    expect(fixture.commits).toEqual([['session-1', 'conv-stale'], ['session-1', null]]);
    expect(fixture.read('session-1')).toBeNull();
  });

  it('runs the canonical scoped fixed-carrier clear after an already-admitted write', async () => {
    const fixture = await installProviderPersistence([{ sessionId: 'history-session', conversationId: 'conv-old' }]);
    const admitted = createDeferred<void>();
    const release = createDeferred<void>();
    fixture.beforeNextPatch(async () => { admitted.resolve(); await release.promise; });
    const attempt = fixture.factory.createAttempt('history-session');
    const writing = attempt.write('conv-admitted');
    await admitted.promise;
    const forget = fixture.host.forgetProviderConversationState;
    if (!forget) throw new Error('Provider conversation persistence unavailable');
    const forgetting = forget({ providerId });
    await Promise.resolve();
    expect(fixture.commits).toEqual([]);
    release.resolve();
    await Promise.all([writing, forgetting]);
    expect(fixture.commits).toEqual([['history-session', 'conv-admitted'], ['history-session', null]]);
    expect(fixture.read('history-session')).toBeNull();
  });

  it('fences a superseded attempt while keeping sessions independent', async () => {
    const fixture = await installProviderPersistence([
      { sessionId: 'session-a', conversationId: 'conv-a' }, { sessionId: 'session-b' },
    ]);
    const old = fixture.factory.createAttempt('session-a');
    const latest = fixture.factory.createAttempt('session-a');
    const independent = fixture.factory.createAttempt('session-b');
    await old.write('conv-old-attempt');
    await latest.write('conv-latest');
    await independent.write('conv-independent');
    expect(fixture.commits).toEqual([['session-a', 'conv-latest'], ['session-b', 'conv-independent']]);
    expect(fixture.read('session-a')).toBe('conv-latest');
    expect(fixture.read('session-b')).toBe('conv-independent');
  });

  it('shares attempt fencing across host projections with the same persistence boundary', async () => {
    const fixture = await installProviderPersistence([
      { sessionId: 'history-session', conversationId: 'conv-retained' }, { sessionId: 'direct-session' },
    ]);
    const projectedFactory = getProviderConversationServiceFactory(Object.freeze({ ...fixture.host }), providerId);
    const old = projectedFactory.createAttempt('history-session');
    const direct = projectedFactory.createAttempt('direct-session');
    const forget = fixture.factory.createAttempt('history-session');
    await old.write('conv-late');
    await direct.write('conv-direct-current');
    await forget.forget();
    expect(fixture.commits).toEqual([['direct-session', 'conv-direct-current'], ['history-session', null]]);
    expect(fixture.read('history-session')).toBeNull();
    expect(fixture.read('direct-session')).toBe('conv-direct-current');
  });

  it('keeps a failed forget invalidated until an explicit retry succeeds', async () => {
    const fixture = await installProviderPersistence([{ sessionId: 'session-1', conversationId: 'conv-old' }]);
    const attempt = fixture.factory.createAttempt('session-1');
    fixture.rejectNextPatch('session-1');
    await expect(attempt.forget()).rejects.toThrow();
    expect(fixture.read('session-1')).toBe('conv-old');
    await attempt.write('conv-late');
    await attempt.forget();
    expect(fixture.attempts).toEqual([['session-1', null], ['session-1', null]]);
    expect(fixture.commits).toEqual([['session-1', null]]);
    expect(fixture.read('session-1')).toBeNull();
  });

  it('accepts an identity inside the window, then rejects and durably removes it at the exact retention boundary', async () => {
    const now = Date.now();
    const fixture = await installProviderPersistence([
      { sessionId: 'fresh', conversationId: 'conv-fresh', updatedAt: now - VOICE_PROVIDER_CONVERSATION_RETENTION_MS + 1 },
      { sessionId: 'expired', conversationId: 'conv-expired', updatedAt: now - VOICE_PROVIDER_CONVERSATION_RETENTION_MS },
    ]);
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
    onTestFinished(() => clock.mockRestore());
    await expect(fixture.factory.createAttempt('fresh').read()).resolves.toBe('conv-fresh');
    await expect(fixture.factory.createAttempt('expired').read()).resolves.toBeNull();
    expect(fixture.commits).toEqual([['expired', null]]);
    expect(fixture.read('expired')).toBeNull();
  });

  it('does not let an older in-flight forget suppress forgetting a replacement conversation', async () => {
    const fixture = await installProviderPersistence([{ sessionId: 'session-1', conversationId: 'conv-old' }]);
    const admitted = createDeferred<void>();
    const release = createDeferred<void>();
    fixture.beforeNextPatch(async () => { admitted.resolve(); await release.promise; });
    const old = fixture.factory.createAttempt('session-1');
    const forgettingOld = old.forget();
    await admitted.promise;
    const replacement = fixture.factory.createAttempt('session-1');
    const writingReplacement = replacement.write('conv-replacement');
    release.resolve();
    await Promise.all([forgettingOld, writingReplacement]);
    await replacement.forget();
    expect(fixture.commits).toEqual([['session-1', null], ['session-1', 'conv-replacement'], ['session-1', null]]);
    expect(fixture.read('session-1')).toBeNull();
  });
});
