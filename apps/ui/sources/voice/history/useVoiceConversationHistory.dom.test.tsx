/** @vitest-environment jsdom */
import 'fake-indexeddb/auto';
import * as React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildSystemSessionMetadataV1 } from '@happier-dev/protocol/sessions/control/contract';
import { SessionListQueryV1Schema } from '@happier-dev/protocol/sessions/listing/query';
import { encodeV2SessionListCursorV1 } from '@happier-dev/protocol/sessions/control/contract';
import { waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { createSessionMessagesFixture } from '@/dev/testkit/fixtures/transcriptFixtures';
import { storage } from '@/sync/domains/state/storageStore';
import { useVoiceConversationHistory } from './useVoiceConversationHistory';
import { createVoiceHistoryListRowFixture } from './voiceConversationHistory.testkit';
import { createVoiceSettingsAccountTestHarness, type VoiceSettingsAccountTestHarness } from '@/voice/settings/panels/voiceSettingsAccountTestHarness';
import { settingsParse } from '@/sync/domains/settings/settings';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { getServerFeaturesSnapshot } from '@/sync/api/capabilities/serverFeaturesClient';
import { configureConnectedServerSocketBoundary, installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { setScreenSharingPrivacyActive } from '@/desktop/capture/useNativeRecordingActive';
import { buildSessionOrganizationSessionKey } from '@/sync/domains/session/organization/keys';
import { buildVoiceTranscriptHistorySessionMetadata } from '@/voice/persistence/voiceTranscriptHistorySession';
import { createSessionReadBatchFetchBoundary } from '@/dev/testkit/harness/sessionReadBatchHttpBoundary';
import { createPlainSessionByIdResponseFixture } from '@/dev/testkit/fixtures/sessionFixtures';

vi.mock('socket.io-client', async original =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(original));

describe.each([true, false])('Voice conversation History discovery (filtered listing: %s)', filteredListing => {
    let account: VoiceSettingsAccountTestHarness;
    beforeEach(async () => {
        installDisconnectedServerSocketBoundary(configureConnectedServerSocketBoundary);
        account = await createVoiceSettingsAccountTestHarness(settingsParse({}), { features: createRootLayoutFeaturesResponse({
            features: { sessions: { enabled: true, filteredListing: { enabled: filteredListing } } },
        }) });
        await getServerFeaturesSnapshot({ serverId: account.scope.serverId, force: true });
        const { sync } = await import('@/sync/sync');
        await waitForHomeGovernance(() => expect(storage.getState().isDataReady).toBe(true));
        await sync.refreshSessions();
    });
    afterEach(async () => { setScreenSharingPrivacyActive(false); await account?.dispose(); installDisconnectedServerSocketBoundary(); });
    it('pages active and archived custody on demand without transcript reads or unrelated arrival work', async () => {
        const serverId = account.scope.serverId;
        const requests: string[] = [];
        let bodyReads = 0;
        const metadataReads: string[] = [];
        const transcriptSessions = ['realtime-history', 'archived-realtime-history'].map((id, index) => createSessionFixture({
            id, serverId, active: false, archivedAt: index ? 10 : null,
            metadata: { ...createSessionFixture().metadata!, name: id, ...buildVoiceTranscriptHistorySessionMetadata() },
        }));
        const unrelatedSystemSession = createSessionFixture({ id: 'other-hidden', serverId, active: false,
            metadata: { ...createSessionFixture().metadata!,
                ...buildSystemSessionMetadataV1({ key: 'other-system', hidden: true }) } });
        const wire = async (id: string, voice: boolean, retired = false, realtime = false) => {
            const session = createSessionFixture({ id, active: false, archivedAt: retired ? 10 : null,
                metadata: { ...createSessionFixture().metadata!, name: id,
                    ...(realtime ? buildVoiceTranscriptHistorySessionMetadata()
                        : voice ? buildSystemSessionMetadataV1({ key: retired ? 'voice_conversation_retired' : 'voice_conversation', hidden: true }) : {}) } });
            return createVoiceHistoryListRowFixture(session, { credentials: account.credentials });
        };
        const [ordinary, older, retired, realtime, archivedRealtime] = await Promise.all([
            wire('ordinary', false), wire('older-voice', true), wire('retired-voice', true, true),
            wire('realtime-history', true, false, true), wire('archived-realtime-history', true, true, true),
        ]);
        const unrelatedSystem = await createVoiceHistoryListRowFixture(unrelatedSystemSession, { credentials: account.credentials });
        const request = account.request.getMockImplementation()!;
        account.request.mockImplementation(createSessionReadBatchFetchBoundary(async (input, init) => {
            const url = new URL(String(input));
            const path = url.pathname;
            if (path === '/v2/sessions/query' || path === '/v2/sessions' || path === '/v2/sessions/archived') {
                const query = path === '/v2/sessions/query' ? SessionListQueryV1Schema.parse(JSON.parse(String(init?.body)))
                    : { storage: path.endsWith('/archived') ? 'archived' : 'active', cursor: url.searchParams.get('cursor') };
                requests.push(`${query.storage}:${query.cursor ?? 'first'}`);
                const archived = query.storage === 'archived';
                return Response.json({ sessions: archived ? [retired, archivedRealtime] : query.cursor ? [older, realtime] : [ordinary, unrelatedSystem],
                    nextCursor: archived || query.cursor ? null : encodeV2SessionListCursorV1('ordinary'),
                    hasNext: !archived && !query.cursor, attentionNextCursor: null, attentionHasNext: false });
            }
            const transcriptSession = [...transcriptSessions, unrelatedSystemSession].find(session => path === `/v2/sessions/${session.id}`);
            if (transcriptSession && (init?.method ?? 'GET') === 'GET') {
                metadataReads.push(transcriptSession.id);
                const detail = createPlainSessionByIdResponseFixture(transcriptSession);
                const row = [realtime, archivedRealtime, unrelatedSystem].find(row => row.id === transcriptSession.id)!;
                return Response.json({ ...detail, session: { ...detail.session, displayProjectionV1: row.displayProjectionV1 } });
            }
            if (/\/sessions\/[^/]+\/messages$/u.test(path)) bodyReads += 1;
            return request(input, init);
        }));
        const environment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
        const previousAct = environment.IS_REACT_ACT_ENVIRONMENT;
        environment.IS_REACT_ACT_ENVIRONMENT = true;
        const container = document.createElement('div');
        document.body.appendChild(container);
        const root = createRoot(container);
        let renders = 0;
        let query = '';
        type History = ReturnType<typeof useVoiceConversationHistory> & Readonly<{
            coverageComplete?: boolean; loadNext?: () => Promise<void>;
        }>;
        const state: { current: History | null } = { current: null };
        function Host() { renders += 1; state.current = useVoiceConversationHistory(query); return null; }
        try {
            await act(async () => root.render(<Host />));
            expect(state.current?.coverageComplete).toBe(false);
            await waitForHomeGovernance(async () => {
                await act(async () => {});
                expect(requests).toEqual(expect.arrayContaining(['active:first', 'archived:first']));
                expect(state.current?.states.active).toMatchObject({ phase: 'ready' });
                expect(state.current?.states.archived).toMatchObject({ phase: 'ready' });
                expect(state.current?.conversations.map(row => row.address.sessionId)).toContain('retired-voice');
                // Unrelated summary windows advance within this Voice page, without a Load more gesture.
                expect(state.current?.conversations.map(row => row.address.sessionId)).toContain('older-voice');
                expect(state.current?.conversations).toEqual(expect.arrayContaining([
                    expect.objectContaining({ address: { serverId, sessionId: 'realtime-history' }, canContinue: false }),
                    expect.objectContaining({ address: { serverId, sessionId: 'archived-realtime-history' }, canContinue: false }),
                ]));
            });
            expect(metadataReads.sort(), 'metadata reads after initial discovery').toEqual(['archived-realtime-history', 'other-hidden', 'realtime-history']);
            await act(async () => { await state.current?.loadNext?.(); });
            await waitForHomeGovernance(async () => { await act(async () => {});
                expect(state.current?.conversations.map(row => row.address.sessionId)).toContain('older-voice'); });
            await waitForHomeGovernance(async () => {
                await act(async () => {});
                expect(state.current?.states.active?.phase).toBe('ready');
                expect(state.current?.states.archived?.phase).toBe('ready');
                expect(state.current?.coverageComplete).toBe(true);
            });
            const beforeSearchRequests = requests.length;
            query = 'OLDER';
            await act(async () => root.render(<Host />));
            expect(state.current?.conversations.map(row => row.address.sessionId)).toEqual(['older-voice']);
            expect(requests.length).toBe(beforeSearchRequests);
            await act(async () => storage.getState().applySessions([createSessionFixture({ id: 'older-voice', serverId,
                metadata: { ...createSessionFixture().metadata!, name: 'older-voice',
                    ...buildSystemSessionMetadataV1({ key: 'voice_conversation', hidden: true }) } })]));
            await act(async () => storage.setState(state => ({ sessionMessages: { ...state.sessionMessages,
                'older-voice': createSessionMessagesFixture({ isLoaded: true, messagesVersion: 1,
                    messageIdsOldestFirst: ['spoken-question', 'spoken-answer'], messagesById: {
                        'spoken-question': { id: 'spoken-question', kind: 'user-text', localId: null,
                            text: 'Is the release ready yet?', createdAt: 1 },
                        'spoken-answer': { id: 'spoken-answer', kind: 'agent-text', localId: null,
                            text: 'The release is ready', createdAt: 2 },
                    } }),
            } })));
            query = 'release';
            await act(async () => root.render(<Host />));
            // D1: transcript search and preview must preserve the canonical authored Session title.
            expect(state.current?.conversations).toMatchObject([{ title: 'older-voice', lastLine: 'The release is ready', loadedMessageCount: 2 }]);
            expect(requests.length).toBe(beforeSearchRequests);
            expect(bodyReads).toBe(0);
            expect(metadataReads.sort()).toEqual(['archived-realtime-history', 'other-hidden', 'realtime-history']);
            expect(state.current?.conversations.map(row => row.address.sessionId)).not.toContain('other-hidden');
            query = '';
            await act(async () => root.render(<Host />));
            const settledRenders = renders;
            const settledRequests = requests.length;
            for (let index = 0; index < 60; index++) await act(async () => storage.setState(state => ({
                sessionMessages: { ...state.sessionMessages, unrelated: createSessionMessagesFixture({ messagesVersion: index + 1 }) },
            })));
            expect(renders - settledRenders).toBe(0);
            expect(requests.length - settledRequests).toBe(0);
            expect(bodyReads).toBe(0);
            expect(metadataReads).toHaveLength(3);
            await act(async () => storage.setState({ settings: { ...storage.getState().settings,
                sessionListHiddenTagIdsWhileRecording: { [serverId]: ['private'] } },
                sessionOrganizationTagAssignmentsBySessionKey: {
                    [buildSessionOrganizationSessionKey(serverId, 'older-voice')]: { sessionId: 'older-voice', tagIds: ['private'] },
                } }));
            await act(async () => setScreenSharingPrivacyActive(true));
            expect(state.current?.conversations.map(row => row.address.sessionId)).not.toContain('older-voice');
            expect(state.current?.conversations.map(row => row.address.sessionId)).toContain('retired-voice');
            expect(requests.length).toBe(settledRequests);
            await act(async () => setScreenSharingPrivacyActive(false));
            expect(state.current?.conversations.map(row => row.address.sessionId)).toContain('older-voice');
            await act(async () => storage.getState().applyServerScopedSessionListRowPatches(serverId, [{ sessionId: 'older-voice',
                patch: { pendingCount: 1, pendingBlockedCount: 1 } }]));
            expect(state.current?.conversations.find(row => row.address.sessionId === 'older-voice')?.hasBlockedInputs).toBe(true);
            await act(async () => storage.getState().applyServerScopedSessionListRowPatches(serverId, [{ sessionId: 'older-voice',
                patch: { pendingCount: 0, pendingBlockedCount: 0 } }]));
            expect(state.current?.conversations.find(row => row.address.sessionId === 'older-voice')?.hasBlockedInputs).toBe(false);
        } finally {
            await act(async () => root.unmount());
            container.remove();
            environment.IS_REACT_ACT_ENVIRONMENT = previousAct;
            account.request.mockImplementation(request);
        }
    });
});
