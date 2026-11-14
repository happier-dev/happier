import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAccountTokenForTests, createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { configureConnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { createPlainSessionWithDisplayRecordFixture } from '@/dev/testkit/fixtures/sessionDisplayFixtures';
import { createSessionMessagesFixture } from '@/dev/testkit/fixtures/transcriptFixtures';
import { createSessionListSourceFixture } from '@/dev/testkit/harness/sessionReadBatchHttpBoundary';
import { SessionListActionResultV1Schema } from '@happier-dev/protocol/sessions/awareness/action';

const home = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(home);
vi.mock('socket.io-client', async original =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(original));
await loadSyncSingletonForTests();
const { listSessionsForVoiceTool } = await import('./sessionList');
const { storage } = await import('@/sync/domains/state/storageStore');

describe('mounted Session lists and Voice disclosure', () => {
    beforeEach(async () => { await home.reset(); });
    afterEach(async () => { await home.reset(); });

    it('returns canonical display and runtime facts to mounted UI while keeping Voice summaries private', async () => {
        const serverId = await home.addHome({ name: 'Recent Home', serverUrl: 'https://recents.test', accountId: 'alice', currentAccount: true });
        const row = { ...createPlainSessionWithDisplayRecordFixture({ id: 'recent', updatedAt: 20, metadata: {
            path: '/work/happier', host: 'work-laptop', machineId: 'machine-a', name: 'Investigate sign in',
        } }), latestTurnStatus: 'in_progress' as const, runtimeActivityState: 'active' as const, runtimeActivityActiveCount: 1,
            runtimeActivityObservedAt: 20, runtimeActivityRevision: 1 };
        home.answer(serverId, '/v2/sessions', { body: createSessionListSourceFixture({ sessions: [row], nextCursor: null, hasNext: false }) });
        const connection = await restoreServerAccountForTest({ serverUrl: 'https://recents.test', accountId: 'alice',
            credentials: { token: createAccountTokenForTests('alice', { currentAccount: true }) },
            configureSocket: socket => {
                vi.spyOn(socket, 'emit').mockReturnValue(socket);
                configureConnectedServerSocketBoundary(socket);
            },
            request: (url, init) => home.request(url, init) });
        try {
            storage.setState(state => ({ settings: { ...state.settings, voice: { ...state.settings.voice,
                privacy: { ...state.settings.voice.privacy, shareSessionSummary: false, shareFilePaths: false, shareRecentMessages: true },
            } } }));
            const message = { id: 'recent-message', kind: 'user-text', text: 'Please investigate sign in.', createdAt: 20, localId: null } as const;
            storage.setState({ sessionMessages: { recent: createSessionMessagesFixture({
                messageIdsOldestFirst: [message.id], messagesById: { [message.id]: message }, isLoaded: true,
            }) } });
            // The captured Home transport owns physical requests, including reads
            // issued through an already-bound connection.
            const requestsBefore = home.requests.length;
            const mountedRequest = { view: 'summary' as const, serverId, includeLastMessagePreview: true,
                context: { sessionListAccess: 'mounted_ui' as const } };
            const mounted = await listSessionsForVoiceTool(mountedRequest);
            expect(mounted, JSON.stringify(mounted)).toMatchObject({ ok: true, sessions: [{
                id: 'recent', serverId, title: 'Investigate sign in', path: '/work/happier', host: 'work-laptop', machineId: 'machine-a',
                latestTurnStatus: 'in_progress', runtimeActivityState: 'active', updatedAt: 20,
                lastMessagePreview: { text: message.text },
            }] });
            expect(SessionListActionResultV1Schema.parse(mounted)).toMatchObject({ sessions: [{
                title: 'Investigate sign in', path: '/work/happier', runtimeActivityState: 'active',
            }] });
            const voice = await listSessionsForVoiceTool({ view: 'summary', serverId });
            expect(voice).toMatchObject({ ok: true, sessions: [{ id: 'recent', serverId }] });
            const parsedVoice = SessionListActionResultV1Schema.parse(voice);
            expect(parsedVoice.sessions).toEqual([expect.not.objectContaining({ title: expect.any(String) })]);
            expect(parsedVoice.sessions).toEqual([expect.not.objectContaining({ path: expect.any(String) })]);
            const unqualifiedRequest = { view: 'summary' as const, resumableOnly: true,
                includeLastMessagePreview: true,
                context: { sessionListAccess: 'mounted_ui' as const } };
            const unqualified = await listSessionsForVoiceTool(unqualifiedRequest);
            expect(unqualified).toMatchObject({ sessions: [{ id: 'recent', serverId, title: 'Investigate sign in',
                path: '/work/happier', runtimeActivityState: 'active', lastMessagePreview: { text: message.text } }] });
            const requestedPaths = home.requests.slice(requestsBefore)
                .map(request => new URL(request.path, request.serverUrl).pathname);
            expect(requestedPaths.filter(path => path === '/v2/sessions')).toHaveLength(3);
            expect(requestedPaths.filter(path => /^\/v2\/sessions\/(?!read-batch$)[^/]+$/.test(path))).toEqual([]);
        } finally { await connection.dispose(); }
    });
});
