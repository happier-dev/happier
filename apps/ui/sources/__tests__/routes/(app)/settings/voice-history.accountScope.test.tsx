import 'fake-indexeddb/auto';
import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createCapturingLegendListMock, createDeferred, createExpoVectorIconsMock,
  createSessionFixture, flushHookEffects, renderScreen, standardCleanup,
} from '@/dev/testkit';
import {
  createHomeGovernanceHarness, installHomeGovernanceBoundaries, waitForHomeGovernance,
} from '@/dev/testkit/harness/homeGovernanceHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { createSessionMetadataHttpBoundary } from '@/dev/testkit/harness/sessionMetadataHttpBoundary';

const legendListMock = createCapturingLegendListMock({ renderItems: true });
const homeHttp = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homeHttp);
installDisconnectedServerSocketBoundary();

vi.mock('@/components/ui/lists/virtualized', () => ({ VirtualizedList: legendListMock.module.LegendList }));
vi.mock('@expo/vector-icons', () => createExpoVectorIconsMock());
vi.mock('expo-router', async () => {
  const { createExpoRouterMock } = await vi.importActual<typeof import('@/dev/testkit/mocks/router')>('@/dev/testkit/mocks/router');
  return createExpoRouterMock({ pathname: '/settings/voice/history' }).module;
});

await loadSyncSingletonForTests();
let homeId: string;
let storage: typeof import('@/sync/domains/state/storage')['storage'];

async function restoreAccount(accountId: string): Promise<void> {
  const { TokenStorage } = await import('@/auth/storage/tokenStorage');
  const { switchConnectionToActiveServer } = await import('@/sync/runtime/orchestration/connectionManager');
  await homeHttp.switchAccount(homeId, accountId);
  const credentials = await TokenStorage.getCredentialsForServerUrl('https://voice-history.test');
  if (!credentials) throw new Error('History fixture Account has no credentials');
  await switchConnectionToActiveServer();
}

async function installHistorySession(accountId: string) {
  const { buildSystemSessionMetadataV1, SessionCurrentProjectionRecordV1Schema, SessionLookupByTagsResponseV2Schema } = await import('@happier-dev/protocol');
  const sessionId = `voice-history-${accountId}`;
  const session = createSessionFixture({ id: sessionId, serverId: homeId, seq: 20,
    metadata: { ...createSessionFixture().metadata!,
      ...buildSystemSessionMetadataV1({ key: 'voice_transcript_history', hidden: true }) },
  });
  const sessionHttp = createSessionMetadataHttpBoundary(() => ({ [sessionId]: session }));
  const response = sessionHttp.handle(`https://voice-history.test/v2/sessions/${sessionId}`);
  if (!response) throw new Error('Canonical Session HTTP fixture did not answer');
  const body: unknown = await response.json();
  if (!body || typeof body !== 'object' || !('session' in body)) throw new Error('Expected canonical Session detail');
  const wire = SessionCurrentProjectionRecordV1Schema.parse(body.session);
  homeHttp.answer(homeId, `/v2/sessions/${sessionId}`, { body: { session: wire } });
  homeHttp.answer(homeId, '/v2/sessions/lookup-by-tags', {
    body: SessionLookupByTagsResponseV2Schema.parse({ sessions: [wire] }),
  });
  return sessionId;
}

async function voicePage(id: string, text: string, seq: number, hasMore = false) {
  const { SessionMessagesPageV1Schema } = await import('@happier-dev/protocol/sessions/messages/sessionMessagesPageV1');
  const { buildRealtimeConversationRawRecord } = await import('@/voice/transcript/VoiceTranscriptProjector');
  return SessionMessagesPageV1Schema.parse({ messages: [{ id, localId: id, seq, createdAt: seq,
    messageRole: 'agent', content: { t: 'plain', v: buildRealtimeConversationRawRecord({ id, role: 'assistant', text }) },
  }], hasMore, nextBeforeSeq: hasMore ? seq : null });
}

beforeEach(async () => {
  await homeHttp.reset();
  installHomeGovernanceBoundaries(homeHttp);
  ({ storage } = await import('@/sync/domains/state/storage'));
  legendListMock.state.reset();
  homeId = await homeHttp.addHome({ name: 'History Home', serverUrl: 'https://voice-history.test', accountId: 'account-a' });
  const { setRuntimeFetch } = await import('@/utils/system/runtimeFetch');
  setRuntimeFetch(homeHttp.request);
  homeHttp.answer(homeId, '/v1/auth/ping', { body: {} });
  await restoreAccount('account-a');
});

afterEach(async () => {
  const { disconnectActiveServerConnection } = await import('@/sync/runtime/orchestration/connectionManager');
  const { resetRuntimeFetch } = await import('@/utils/system/runtimeFetch');
  await act(async () => {
    await disconnectActiveServerConnection();
    resetRuntimeFetch();
    await homeHttp.reset();
    standardCleanup();
  });
});

describe('Voice History route account scope', () => {
  it('remounts one History consumer per same-server Account scope and never restores Account A rows', async () => {
    const sessionA = await installHistorySession('account-a');
    const messagesA = `/v1/sessions/${sessionA}/messages`;
    homeHttp.answer(homeId, messagesA, { body: await voicePage('account-a-row', 'Account A transcript', 20, true) });
    const route = await import('../../../../app/(app)/settings/voice/history');
    const screen = await renderScreen(React.createElement(route.default));
    await waitForHomeGovernance(async () => {
      await flushHookEffects();
      expect(screen.getTextContent()).toContain('Account A transcript');
    });

    const refreshA = createDeferred<void>();
    const loadOlderA = createDeferred<void>();
    const staleRefresh = await voicePage('account-a-stale-refresh', 'Account A stale refresh', 21, true);
    const staleOlder = await voicePage('account-a-stale-older', 'Account A older transcript', 10);
    homeHttp.answer(homeId, messagesA, { select: () => {
      // The shared HTTP boundary records the URL before selecting its answer.
      const path = homeHttp.requests.at(-1)?.path ?? '';
      return path.includes('beforeSeq=')
        ? { body: staleOlder, respondAfter: loadOlderA.promise }
        : { body: staleRefresh, respondAfter: refreshA.promise };
    } });
    const { sync } = await import('@/sync/sync');
    const { apiSocket } = await import('@/sync/api/session/apiSocket');
    const { captureServerRequestAuthorityForServerAccountScope } = await import('@/sync/runtime/orchestration/serverScopedRpc/createServerRequestWithServerScope');
    const authorityA = await captureServerRequestAuthorityForServerAccountScope({
      scope: { serverId: homeId, accountId: 'account-a' }, activeRequest: (path, init) => apiSocket.request(path, init),
    });
    const requestsBeforeRefresh = homeHttp.requests.length;
    const pendingRefreshA = sync.refreshSessionMessages(sessionA, { authority: authorityA });
    await waitForHomeGovernance(() => expect(homeHttp.requests.slice(requestsBeforeRefresh).some(request =>
      request.path.startsWith(messagesA) && !request.path.includes('beforeSeq='))).toBe(true));
    await act(async () => { screen.pressByTestId('voice-history-load-older'); });
    await waitForHomeGovernance(() => expect(homeHttp.requests.some(request =>
      request.path.startsWith(messagesA) && request.path.includes('beforeSeq=20'))).toBe(true));

    const sessionB = await installHistorySession('account-b');
    homeHttp.answer(homeId, `/v1/sessions/${sessionB}/messages`, { body: await voicePage('account-b-row', 'Account B transcript', 20) });
    await act(async () => { await restoreAccount('account-b'); });
    await waitForHomeGovernance(async () => {
      await flushHookEffects();
      expect(screen.getTextContent()).toContain('Account B transcript');
    });
    expect(storage.getState().profileScope).toEqual({ serverId: homeId, accountId: 'account-b' });
    expect(screen.getTextContent()).not.toContain('Account A transcript');
    const expectOnlyAccountB = () => {
      expect(screen.getTextContent()).toContain('Account B transcript');
      for (const text of ['Account A transcript', 'Account A stale refresh', 'Account A older transcript']) {
        expect(screen.getTextContent()).not.toContain(text);
      }
      expect(storage.getState().sessionMessages[sessionA]).toBeUndefined();
    };

    await act(async () => { refreshA.resolve(); await pendingRefreshA; });
    await flushHookEffects();
    expectOnlyAccountB();
    await act(async () => { loadOlderA.resolve(); await loadOlderA.promise; });
    await flushHookEffects();
    await authorityA.release();
    expectOnlyAccountB();
    const { TokenStorage } = await import('@/auth/storage/tokenStorage');
    const credentialsB = await TokenStorage.getCredentialsForServerUrl('https://voice-history.test');
    expect(homeHttp.requests.filter(request => request.path.startsWith(`/v1/sessions/${sessionB}/messages`)))
      .toEqual(expect.arrayContaining([expect.objectContaining({ serverId: homeId, token: credentialsB?.token })]));
  });
});
