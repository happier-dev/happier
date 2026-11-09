import { createSessionReadBatchFetchBoundary } from '@/dev/testkit/harness/sessionReadBatchHttpBoundary';
import 'fake-indexeddb/auto';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { createSessionFixture } from '@/dev/testkit';
import { createSessionMetadataHttpBoundary } from '@/dev/testkit/harness/sessionMetadataHttpBoundary';
import { createVoiceSettingsAccountTestHarness } from '@/voice/settings/panels/voiceSettingsAccountTestHarness';
import { settingsParse } from '@/sync/domains/settings/settings';
import { storage } from '@/sync/domains/state/storage';
import { readSessionOwnerMetadataView } from '@/sync/domains/session/readSessionOwnerMetadataView';
import { voiceSessionBindingStore } from '@/voice/binding/voiceConversationBindingStore';
import { discoverVoiceHistorySession } from '@/voice/history/voiceHistorySessionDiscovery';
import { buildVoiceTranscriptHistorySessionMetadata, VOICE_TRANSCRIPT_HISTORY_SYSTEM_SESSION_TAG } from '@/voice/persistence/voiceTranscriptHistorySession';
import { createBundledConversationRuntimeHostLease } from './bundledConversationRuntimeHost';

vi.mock('socket.io-client', async original =>
  (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(original));

describe('voice history carrier single ownership', () => {
  it('gives every targetless provider attempt in one account the carrier Voice History reads', async () => {
    const account = await createVoiceSettingsAccountTestHarness(settingsParse({}));
    onTestFinished(account.dispose);
    const { sync } = await import('@/sync/sync');
    const { apiSocket } = await import('@/sync/api/session/apiSocket');
    const history = createSessionFixture({ id: 'history-carrier', serverId: account.scope.serverId,
      metadata: { path: '/voice-transcript-history', host: 'happier.test', ...buildVoiceTranscriptHistorySessionMetadata() },
    });
    const sessionHttp = createSessionMetadataHttpBoundary(() => ({}));
    const request = account.request.getMockImplementation();
    if (!request) throw new Error('Account HTTP boundary missing');
    account.request.mockImplementation(createSessionReadBatchFetchBoundary(async (input, init) => {
      const path = new URL(String(input)).pathname;
      if (path === '/v1/sessions' && init?.method === 'POST') {
        expect(JSON.parse(String(init.body))).toMatchObject({ tag: VOICE_TRANSCRIPT_HISTORY_SYSTEM_SESSION_TAG });
        return sessionHttp.createSessionFromPost(history.id, init);
      }
      if (path === '/v2/sessions/lookup-by-tags') {
        const { SessionLookupByTagsRequestV2Schema} = await import('@happier-dev/protocol/sessions/control/contract');
        expect(SessionLookupByTagsRequestV2Schema.parse(JSON.parse(String(init?.body))).tags)
          .toEqual([VOICE_TRANSCRIPT_HISTORY_SYSTEM_SESSION_TAG]);
        const detail = sessionHttp.handle(new URL(`/v2/sessions/${history.id}`, String(input)));
        if (!detail) throw new Error('Missing History HTTP record');
        const { SessionLookupByTagsResponseV2Schema} = await import('@happier-dev/protocol/sessions/control/contract');
        return Response.json(SessionLookupByTagsResponseV2Schema.parse({ sessions: [(await detail.json()).session] }));
      }
      return sessionHttp.handle(input, init) ?? request(input, init);
    }));
    storage.setState({ sessions: {}, sessionMessages: {} });
    voiceSessionBindingStore.setState({ runtimeBindingsByConversationSessionId: {}, persistedBindingsByConversationSessionId: {} });
    const lease = createBundledConversationRuntimeHostLease();
    onTestFinished(() => lease.revoke());
    const xai = await lease.host.acquireDirectMediaConversation({
      adapterId: 'happier.voice.xai/realtime-grok', controlSessionId: lease.host.globalVoiceSessionId,
      requestedTargetSessionAddress: null,
    });
    const openai = await lease.host.acquireDirectMediaConversation({
      adapterId: 'happier.voice.openai/realtime-openai', controlSessionId: lease.host.globalVoiceSessionId,
      requestedTargetSessionAddress: null,
    });
    expect(openai.conversationSessionId).toBe(xai.conversationSessionId);
    expect(lease.host.resolveConversationSessionId(lease.host.globalVoiceSessionId,
      'happier.voice.openai/realtime-openai')).toBe(xai.conversationSessionId);

    const historyReaderSessionId = await discoverVoiceHistorySession({
      lookupByTags: async tags => {
        const response = await apiSocket.request('/v2/sessions/lookup-by-tags', {
          method: 'POST', body: JSON.stringify({ tags }),
        });
        const { SessionLookupByTagsResponseV2Schema} = await import('@happier-dev/protocol/sessions/control/contract');
        return SessionLookupByTagsResponseV2Schema.parse(await response.json()).sessions;
      },
      hydrateSession: sessionId => sync.ensureSessionVisibleForMessageRoute(sessionId, {
        forceRefresh: true, serverId: account.scope.serverId,
      }),
      readHydratedSession: sessionId => storage.getState().sessions[sessionId] ?? null,
    });
    expect(historyReaderSessionId).toBe(xai.conversationSessionId);
    expect(readSessionOwnerMetadataView(storage.getState().sessions[historyReaderSessionId!]!)?.systemSessionV1)
      .toEqual(buildVoiceTranscriptHistorySessionMetadata().systemSessionV1);
  });
});
