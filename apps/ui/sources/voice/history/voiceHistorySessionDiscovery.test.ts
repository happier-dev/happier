import 'fake-indexeddb/auto';
import { createSessionReadBatchFetchBoundary } from '@/dev/testkit/harness/sessionReadBatchHttpBoundary';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createSessionFixture } from '@/dev/testkit';

const fixtureMetadata = (() => {
    const metadata = createSessionFixture().metadata;
    if (!metadata) throw new Error('Canonical Session fixture metadata missing');
    return metadata;
})();
import { buildSystemSessionMetadataV1, SessionCurrentProjectionRecordV1Schema, SessionLookupByTagsResponseV2Schema } from '@happier-dev/protocol';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { createSessionMetadataHttpBoundary } from '@/dev/testkit/harness/sessionMetadataHttpBoundary';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';

const http = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(http);
installDisconnectedServerSocketBoundary();
await loadSyncSingletonForTests();
const { buildVoiceTranscriptHistorySessionMetadata, VOICE_TRANSCRIPT_HISTORY_SYSTEM_SESSION_TAG } = await import('@/voice/persistence/voiceTranscriptHistorySession');
const { discoverVoiceHistorySession } = await import('./voiceHistorySessionDiscovery');
const { apiSocket } = await import('@/sync/api/session/apiSocket');
const { sync } = await import('@/sync/sync');
const discover = async () => {
  const { getActiveServerAccountScope } = await import('@/sync/domains/scope/activeServerAccountScope');
  const { captureServerRequestAuthorityForServerAccountScope } = await import('@/sync/runtime/orchestration/serverScopedRpc/createServerRequestWithServerScope');
  const scope = getActiveServerAccountScope();
  if (!scope) throw new Error('Discovery Account scope missing');
  const authority = await captureServerRequestAuthorityForServerAccountScope({ scope,
    activeRequest: (path, init) => apiSocket.request(path, init) });
  try { return await discoverVoiceHistorySession({
  lookupByTags: async tags => {
    const response = await authority.request('/v2/sessions/lookup-by-tags', { method: 'POST', body: JSON.stringify({ tags }) });
    return SessionLookupByTagsResponseV2Schema.parse(await response.json()).sessions;
  },
  hydrateSession: sessionId => sync.ensureSessionVisibleForMessageRoute(sessionId, { forceRefresh: true, authority }),
  readHydratedSession: sessionId => storage.getState().sessions[sessionId] ?? null,
  }); } finally { await authority.release(); }
};
const { storage } = await import('@/sync/domains/state/storage');
const { switchConnectionToActiveServer, disconnectActiveServerConnection } = await import('@/sync/runtime/orchestration/connectionManager');
const { setRuntimeFetch, resetRuntimeFetch } = await import('@/utils/system/runtimeFetch');
let homeId: string;

function carrierSession(input: Readonly<{ id: string; active?: boolean; key?: 'voice_transcript_history' | 'voice_conversation'; hidden?: boolean }>) {
  const marker = input.key === undefined && input.hidden === undefined
    ? buildVoiceTranscriptHistorySessionMetadata()
    : buildSystemSessionMetadataV1({ key: input.key ?? 'voice_transcript_history', hidden: input.hidden ?? true });
  return createSessionFixture({ id: input.id, serverId: homeId, active: input.active ?? false,
    metadata: { ...fixtureMetadata, ...marker } });
}

async function installCandidates(sessions: ReadonlyArray<ReturnType<typeof createSessionFixture>>) {
  const boundary = createSessionMetadataHttpBoundary(() => Object.fromEntries(sessions.map(session => [session.id, session])));
  const records = await Promise.all(sessions.map(async session => {
    const response = boundary.handle(`https://history-discovery.test/v2/sessions/${session.id}`);
    if (!response) throw new Error('Missing canonical Session detail');
    const body: unknown = await response.json();
    if (!body || typeof body !== 'object' || !('session' in body)) throw new Error('Invalid canonical detail');
    const wire = SessionCurrentProjectionRecordV1Schema.parse(body.session);
    http.answer(homeId, `/v2/sessions/${session.id}`, { body: { session: wire } });
    http.answer(homeId, `/v1/sessions/${session.id}/messages`, { body: { messages: [], hasMore: false } });
    return wire;
  }));
  http.answer(homeId, '/v2/sessions/lookup-by-tags', { body: SessionLookupByTagsResponseV2Schema.parse({ sessions: records }) });
  return boundary;
}
beforeEach(async () => {
  await http.reset();
  installHomeGovernanceBoundaries(http);
  homeId = await http.addHome({ name: 'Discovery Home', serverUrl: 'https://history-discovery.test', accountId: 'discovery-account', currentAccount: true });
  setRuntimeFetch(createSessionReadBatchFetchBoundary(http.request));
  http.answer(homeId, '/v1/auth/ping', { body: {} });
  http.answer(homeId, '/v1/account/encryption/currentness', { body: createPlainAccountEncryptionCurrentnessFixture() });
  await switchConnectionToActiveServer();
});
afterEach(async () => {
  await disconnectActiveServerConnection();
  resetRuntimeFetch();
  await http.reset();
});
const expectCanonicalTag = () => expect(http.requestsFor('/v2/sessions/lookup-by-tags').at(-1)?.input)
  .toEqual({ tags: [VOICE_TRANSCRIPT_HISTORY_SYSTEM_SESSION_TAG] });

describe('direct-media provider-state carrier discovery', () => {
  it('performs the cold carrier lookup without a server-version preflight', async () => {
    await installCandidates([]);
    expect(await discover()).toBeNull();
    expectCanonicalTag();
    expect(http.requests.some(request => request.path.includes('/server-version'))).toBe(false);
  });

  it('looks up only the canonical fixed tag and accepts only its hydrated inactive hidden marker', async () => {
    await installCandidates([carrierSession({ id: 'currently-recording', active: true }),
      carrierSession({ id: 'wrong-marker', key: 'voice_conversation' }), carrierSession({ id: 'history' })]);
    expect(await discover()).toBe('history');
    expectCanonicalTag();
    // Lookup rows already carry a canonical Session projection. Sync may use
    // that admitted record without another HTTP detail read.
    expect(storage.getState().sessions.history).toMatchObject({ id: 'history', active: false,
      metadata: buildVoiceTranscriptHistorySessionMetadata() });
  });

  it('recognizes the carrier from the canonical owner metadata view in layout v1', async () => {
    const carrier = carrierSession({ id: 'history' });
    const boundary = await installCandidates([carrier]);
    storage.getState().applySessions([carrier]);
    const url = 'https://history-discovery.test/v2/sessions/history';
    http.answer(homeId, 'PATCH /v2/sessions/history', { select: async input => {
      const response = boundary.handle(url, { method: 'PATCH', body: JSON.stringify(input) });
      if (!response) throw new Error('Missing canonical tuple mutation response');
      return { status: response.status, body: await response.json() };
    } });
    const { sync } = await import('@/sync/sync');
    await sync.patchSessionMetadataWithRetry('history', metadata => ({ ...metadata, name: 'Migrated History carrier' }));
    http.answer(homeId, '/v2/sessions/history', { select: async () => {
      const response = boundary.handle(url);
      if (!response) throw new Error('Missing migrated Session detail');
      return { status: response.status, body: await response.json() };
    } });
    const discovered = await discover();
    expect(storage.getState().sessions.history).toMatchObject({ metadataLayoutVersion: 1,
      ownerMetadataView: { systemSessionV1: { key: 'voice_transcript_history', hidden: true } } });
    expect(discovered).toBe('history');
  });

  it('returns empty without creating when lookup has no exact carrier or hydration is unavailable', async () => {
    await installCandidates([carrierSession({ id: 'history' })]);
    http.answer(homeId, '/v2/sessions/history', { status: 404, body: { error: 'not_found' } });
    expect(await discover()).toBeNull();
    expect(http.requestsFor('/v1/sessions/history/messages')).toEqual([]);
    expect(http.requestsFor('/v1/sessions').some(request =>
      request.input !== null && typeof request.input === 'object' && 'tag' in request.input,
    )).toBe(false);
  });
});
