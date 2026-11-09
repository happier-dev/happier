import * as React from 'react';
import 'fake-indexeddb/auto';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import {
    createPlainSessionOwnerMetadataEnvelopeV1,
    projectSessionSharedMetadataV1,
    SessionOwnerMetadataV1Schema} from '@happier-dev/protocol/sessions/metadata/sessionMetadataSchemasV1';
import {
    projectLegacySessionAccessCapabilitiesV1} from '@happier-dev/protocol/sessions/access/sessionEffectiveAccessV1';
import {
    type SessionMessageV1} from '@happier-dev/protocol/sessions/messages/sessionMessagesPageV1';
import {
    type V2SessionRecord,
} from '@happier-dev/protocol/sessions/control/contract';
import { buildSessionTurnsProjectionV1, SessionTurnsProjectionV1Schema } from '@happier-dev/protocol/sessions/turns/sessionTurnV1';
import { deriveWorkflowSessionInputLocalIdV2 } from '@happier-dev/protocol/sessions/messages/sessionInputAdmission';
import { SessionCurrentProjectionRecordV1Schema } from '@happier-dev/protocol/sessions/listing/response';
import { SessionOrganizationSnapshotResponseSchema } from '@happier-dev/protocol/sessions/organization/snapshot';
import { SESSION_ORGANIZATION_SNAPSHOT_VERSION } from '@happier-dev/protocol/sessions/organization/constants';
import { createDeferred, flushHookEffects, renderScreen, standardCleanup } from '@/dev/testkit';
import { installWebLockManagerMock } from '@/auth/storage/tokenStorage.web.testHelpers';
import { chatListHarnessState, resetChatListHarness } from '@/dev/testkit/harness/chatListHarness';
import { createHomeHubArtifactHttpBoundary } from '@/dev/testkit/harness/homeHubArtifactHttpBoundary';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { createSessionReadBatchFetchBoundary } from '@/dev/testkit/harness/sessionReadBatchHttpBoundary';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { installTranscriptCommonModuleMocks } from './transcriptTestHelpers';
import { sessionAddressKey } from '@/sync/domains/session/sessionAddress';
import { DestinationInstanceContext } from '@/components/appShell/workspace/destinationInstanceContext';

installTranscriptCommonModuleMocks({ reactNative: async () =>
    (await import('@/dev/testkit/harness/chatListHarness')).createChatListHarnessReactNativeMock({ platformOs: 'web' }) });
installDisconnectedServerSocketBoundary();
vi.mock('socket.io-client', async (importOriginal) =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));
vi.mock('@legendapp/list/react-native', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@legendapp/list/react-native')>()),
    ...(await import('@/dev/testkit/harness/chatListHarness')).createLegendChatListModuleMock(),
}));
vi.mock('react-native-safe-area-context', () => ({
    useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }), initialWindowMetrics: null,
}));

await loadSyncSingletonForTests();
const { storage } = await import('@/sync/domains/state/storage');
const { sync } = await import('@/sync/sync');
const { useHydrateSessionForRoute } = await import('@/hooks/session/useHydrateSessionForRoute');
const { useSessionViewShellSession } = await import('../shell/sessionViewStableSession');
const { ChatList } = await import('./ChatList');
const { AppSessionTranscriptSourceProvider } = await import('./source/appSessionTranscriptSource');

const sessionId = 'opened-session';
const invocation = { runId: 'external-plugin-run', invocationRecordId: 'continue' };
const projection = SessionTurnsProjectionV1Schema.parse(buildSessionTurnsProjectionV1({
    sessionId, updatedAt: 4, latestTurnId: 'workflow-turn', turns: [
        { turnId: 'person-turn', initiator: 'user', status: 'completed', startedAt: 1, updatedAt: 1,
            transcriptAnchors: { startSeqInclusive: 1, endSeqInclusive: 1 } },
        { turnId: 'workflow-turn', initiator: 'workflow', workflowInvocation: invocation,
            status: 'completed', startedAt: 3, updatedAt: 4,
            transcriptAnchors: { startSeqInclusive: 3, endSeqInclusive: 3 } },
    ],
}));

function wireSession(id: string): V2SessionRecord {
    return SessionCurrentProjectionRecordV1Schema.parse({
        id, seq: 3, createdAt: 1, updatedAt: 4, active: false, activeAt: 4, archivedAt: null,
        latestTurnId: 'workflow-turn', latestTurnStatus: 'completed', latestTurnStatusObservedAt: 4,
        encryptionMode: 'plain', dataEncryptionKey: null, metadataLayoutVersion: 1,
        metadata: JSON.stringify(projectSessionSharedMetadataV1({ metadata: {} })),
        ownerMetadata: createPlainSessionOwnerMetadataEnvelopeV1(SessionOwnerMetadataV1Schema.parse({ v: 1 })),
        metadataVersion: 1, agentState: null, agentStateVersion: 0, share: null,
        responsibleAccountId: null, responsibleAccount: null,
        effectiveAccess: { v: 1, level: 'owner', sources: [{ kind: 'owner' }], audienceContext: null,
            capabilities: projectLegacySessionAccessCapabilitiesV1({ level: 'owner', canApprovePermissions: true }) },
    });
}
function wireMessage(seq: number, value: Extract<SessionMessageV1['content'], { t: 'plain' }>['v'], localId: string | null = null): SessionMessageV1 {
    return { id: `m${seq}`, seq, localId, sidechainId: null, content: { t: 'plain', v: value }, createdAt: seq, updatedAt: seq };
}
const messages = [
    wireMessage(1, { role: 'user', content: { type: 'text', text: 'Person input' } }),
    wireMessage(2, { role: 'agent', content: { type: 'event', data: { type: 'message', message: 'Workflow step input' } } },
        deriveWorkflowSessionInputLocalIdV2({ purpose: 'invocation', ...invocation })),
    wireMessage(3, { role: 'agent', content: { type: 'output', data: { type: 'assistant', uuid: 'reply', parentUuid: null,
        isSidechain: false, message: { role: 'assistant', content: [{ type: 'text', text: 'Continued reply' }] } } } }),
];

afterEach(standardCleanup);

describe('Session open → turn projection → mounted transcript', () => {
    it.each(['cold', 'cached', 'cached-stale-turns', 'cached-running-turn', 'retained-reopen', 'background-in-flight'] as const)('loads turns once for the opened Session (%s), leaving list rows lean', async mode => {
        resetChatListHarness({ platformOs: 'web' });
        const locks = installWebLockManagerMock();
        let connection: Awaited<ReturnType<typeof restoreServerAccountForTest>> | undefined;
        onTestFinished(async () => {
            standardCleanup();
            await connection?.dispose();
            storage.setState(storage.getInitialState(), true);
            locks.restore();
        });
        const requests: string[] = [];
        const sessionResponse = createDeferred<void>();
        const backgroundReadStarted = createDeferred<void>();
        let holdExactSessionRead = false;
        onTestFinished(() => sessionResponse.resolve());
        if (mode !== 'background-in-flight') sessionResponse.resolve();
        const http = createHomeHubArtifactHttpBoundary('reader');
        let currentProjection = projection;
        let currentMessages = messages;
        const currentSession = () => ({ ...wireSession(sessionId), seq: currentMessages.at(-1)!.seq,
            updatedAt: currentProjection.updatedAt, latestTurnId: currentProjection.latestTurnId,
            latestTurnStatusObservedAt: currentProjection.updatedAt });
        connection = await restoreServerAccountForTest({ serverUrl: 'https://session-open.test', accountId: 'reader', request: createSessionReadBatchFetchBoundary(async (input, init) => {
            const path = new URL(String(input)).pathname;
            requests.push(path);
            if (path === '/v2/session-organization') return Response.json(SessionOrganizationSnapshotResponseSchema.parse({ snapshot: {
                schemaVersion: SESSION_ORGANIZATION_SNAPSHOT_VERSION, version: 0, pins: [], folders: [], folderAssignments: [],
                tags: [], tagAssignments: [], orderEntries: [], labels: [],
            } }));
            if (path === '/v2/sessions' || path === '/v2/sessions/active')
                return Response.json({ sessions: [currentSession(), wireSession('unopened-session')], hasNext: false, nextCursor: null });
            if (path === `/v2/sessions/${sessionId}`) {
                if (holdExactSessionRead) {
                    backgroundReadStarted.resolve();
                    await sessionResponse.promise;
                }
                return Response.json({ session: currentSession() });
            }
            if (path === '/v2/sessions/metadata-upgrades') return Response.json({ sessionIds: [] });
            if (path === `/v1/sessions/${sessionId}/turns`) return Response.json(currentProjection);
            if (path === `/v1/sessions/${sessionId}/messages`)
                return Response.json({ messages: currentMessages, hasMore: false, nextBeforeSeq: null, nextAfterSeq: null });
            return http.request(input, init);
        }) });
        await sync.refreshSessions({ awaitSessionListHydration: true });
        expect(requests.filter(path => path.endsWith('/turns'))).toEqual([]);
        if (mode === 'cached' || mode === 'cached-stale-turns' || mode === 'cached-running-turn') {
            await sync.ensureSessionVisibleForMessageRoute(sessionId, { hydrateMessages: false });
            expect(storage.getState().sessions[sessionId]).toBeDefined();
            expect(storage.getState().sessions[sessionId]?.sessionTurns).toBeUndefined();
            if (mode === 'cached-stale-turns' || mode === 'cached-running-turn') {
                // A hidden Session keeps its prior turn inventory while public
                // lifecycle facts advance; opening must satisfy the new turn demand.
                const cached = storage.getState().sessions[sessionId]!;
                storage.getState().applySessions([{ ...cached, sessionTurns: buildSessionTurnsProjectionV1({
                    sessionId,
                    latestTurnId: mode === 'cached-stale-turns' ? 'person-turn' : 'workflow-turn', updatedAt: 1,
                    turns: mode === 'cached-stale-turns' ? [projection.turns[0]!] : projection.turns.map(turn =>
                        turn.turnId !== 'workflow-turn' ? turn : { ...turn, status: 'in_progress' as const,
                            transcriptAnchors: { startSeqInclusive: 3, endSeqInclusive: null } }),
                }) }]);
            }
        }
        holdExactSessionRead = mode === 'background-in-flight';
        const background = mode === 'background-in-flight'
            ? sync.ensureSessionVisibleForMessageRoute(sessionId, { hydrateMessages: false, forceRefresh: true })
            : null;
        if (background) await backgroundReadStarted.promise;
        const serverId = connection.home.id;
        function OpenTranscript() {
            useHydrateSessionForRoute(sessionId, 'FIX86.open', { serverId });
            const session = useSessionViewShellSession(sessionId, serverId);
            return session ? <AppSessionTranscriptSourceProvider sessionId={sessionId} serverId={serverId}>
                <ChatList session={session} sessionSurfaceKey={sessionAddressKey({ sessionId, serverId })} />
            </AppSessionTranscriptSourceProvider> : null;
        }
        const navigation = { push: vi.fn(), replace: vi.fn(), back: vi.fn() };
        let currentFocus = true;
        const render = (visible: boolean) => {
            currentFocus = visible;
            return mode === 'retained-reopen'
                ? <DestinationInstanceContext.Provider value={{ tabId: 'opened-session-tab',
                    ref: { kind: 'session', params: { id: sessionId, serverId } }, pathname: `/session/${sessionId}`,
                    focused: visible, isFocused: () => currentFocus, visible, navigation }}><OpenTranscript /></DestinationInstanceContext.Provider>
                : <OpenTranscript />;
        };
        const screen = await renderScreen(render(true));
        await flushHookEffects({ cycles: 40 });
        await act(async () => {
            sessionResponse.resolve();
            await background;
        });
        await flushHookEffects({ cycles: 40 });
        await act(async () => { await sync.refreshSessionMessages(sessionId); });
        await flushHookEffects({ cycles: 40 });
        expect(storage.getState().sessions[sessionId]?.sessionTurns).toEqual(projection);
        expect(chatListHarnessState.legendListProps?.data).toEqual(expect.arrayContaining([
            expect.objectContaining({ kind: 'turn', workflowRun: { runId: invocation.runId, turnCount: 1 } }),
        ]));
        expect(screen.findHostByTestId(`workflow-run-fold:${invocation.runId}`)).not.toBeNull();
        await sync.ensureSessionVisibleForMessageRoute(sessionId, { serverId, includeTurnsProjection: true });
        expect(requests.filter(path => path.endsWith('/turns'))).toEqual([`/v1/sessions/${sessionId}/turns`]);
        if (mode === 'retained-reopen') {
            await screen.update(render(false));
            const nextInvocation = { ...invocation, invocationRecordId: 'continue-again' };
            currentProjection = buildSessionTurnsProjectionV1({ sessionId, updatedAt: 6, latestTurnId: 'workflow-turn-2',
                turns: [...projection.turns, { turnId: 'workflow-turn-2', initiator: 'workflow', workflowInvocation: nextInvocation,
                    status: 'completed', startedAt: 5, updatedAt: 6,
                    transcriptAnchors: { startSeqInclusive: 4, endSeqInclusive: 5 } }] });
            currentMessages = [...messages, wireMessage(4, { role: 'agent', content: { type: 'event',
                data: { type: 'message', message: 'Workflow step input' } } },
            deriveWorkflowSessionInputLocalIdV2({ purpose: 'invocation', ...nextInvocation })),
            wireMessage(5, { role: 'agent', content: { type: 'output', data: { type: 'assistant', uuid: 'reply-again',
                parentUuid: null, isSidechain: false,
                message: { role: 'assistant', content: [{ type: 'text', text: 'Continued again' }] } } } })];
            await act(async () => storage.getState().applySessions([{ ...storage.getState().sessions[sessionId]!,
                seq: 5, updatedAt: 6, latestTurnId: 'workflow-turn-2', latestTurnStatusObservedAt: 6 }]));
            await flushHookEffects({ cycles: 20 });
            expect(requests.filter(path => path.endsWith('/turns'))).toHaveLength(1);
            await screen.update(render(true));
            await flushHookEffects({ cycles: 40 });
            expect(storage.getState().sessions[sessionId]?.sessionTurns).toEqual(currentProjection);
            expect(requests.filter(path => path.endsWith('/turns'))).toHaveLength(2);
        }
    });
});
