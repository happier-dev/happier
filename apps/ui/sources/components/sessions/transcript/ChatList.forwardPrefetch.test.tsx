import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import {
    createPlainSessionOwnerMetadataEnvelopeV1,
    projectLegacySessionAccessCapabilitiesV1,
    projectSessionSharedMetadataV1,
    SessionOwnerMetadataV1Schema,
    type SessionMessageV1,
    type V2SessionRecord,
} from '@happier-dev/protocol';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import { installWebLockManagerMock } from '@/auth/storage/tokenStorage.web.testHelpers';
import {
    chatListHarnessState,
    createChatListHarnessWebScroller,
    resetChatListHarness,
    triggerLegendChatListInitialFill,
    triggerLegendChatListScroll,
    triggerLegendChatListWheel,
    withChatListHarnessWebScrollerDom,
} from '@/dev/testkit/harness/chatListHarness';
import { createHomeHubArtifactHttpBoundary } from '@/dev/testkit/harness/homeHubArtifactHttpBoundary';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { storage } from '@/sync/domains/state/storage';
import { settingsDefaults } from '@/sync/domains/settings/settings';
import { markSessionSurfaceHidden, markSessionSurfaceVisible } from '@/sync/domains/session/sessionSurfaceVisibility';
import { installTranscriptCommonModuleMocks } from './transcriptTestHelpers';
import { buildSessionMessageRouteId } from '@happier-dev/session-core/messages';

installTranscriptCommonModuleMocks({
    reactNative: async () =>
        (await import('@/dev/testkit/harness/chatListHarness')).createChatListHarnessReactNativeMock({ platformOs: 'web' }),
});
installDisconnectedServerSocketBoundary();
vi.mock('@legendapp/list/react-native', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@legendapp/list/react-native')>()),
    ...(await import('@/dev/testkit/harness/chatListHarness')).createLegendChatListModuleMock(),
}));
vi.mock('react-native-safe-area-context', () => ({
    useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
    initialWindowMetrics: null,
}));

await loadSyncSingletonForTests();
// Resolve the real transcript/editor graph before the scoped scrolling-only DOM.
const { ChatList } = await import('./ChatList');
const { AppSessionTranscriptSourceProvider } = await import('./source/appSessionTranscriptSource');
const { sync } = await import('@/sync/sync');

const SESSION_ID = 'forward-history';
function messageRouteIds() {
    const state = storage.getState().sessionMessages[SESSION_ID];
    if (!state) return [];
    return Object.keys(state.messagesById).map((messageId) => buildSessionMessageRouteId({
        messageId,
        messagesById: state.messagesById,
        reducerState: state.reducerState,
    }));
}
function wireMessage(seq: number): SessionMessageV1 {
    return {
        id: 'm' + seq, seq, localId: null, sidechainId: null,
        content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'Message ' + seq } } },
        createdAt: seq, updatedAt: seq,
    };
}
function wireSession(seq: number): V2SessionRecord {
    return {
        id: SESSION_ID, seq, createdAt: 1, updatedAt: seq, active: true, activeAt: seq, archivedAt: null,
        encryptionMode: 'plain', dataEncryptionKey: null, metadataLayoutVersion: 1,
        metadata: JSON.stringify(projectSessionSharedMetadataV1({ metadata: {} })),
        ownerMetadata: createPlainSessionOwnerMetadataEnvelopeV1(SessionOwnerMetadataV1Schema.parse({ v: 1 })),
        metadataVersion: 1, agentState: null, agentStateVersion: 0, share: null,
        effectiveAccess: {
            v: 1, level: 'owner', sources: [{ kind: 'owner' }], audienceContext: null,
            capabilities: projectLegacySessionAccessCapabilitiesV1({ level: 'owner', canApprovePermissions: true }),
        },
    };
}

afterEach(() => {
    standardCleanup();
    markSessionSurfaceHidden(SESSION_ID);
});

async function prepareHistory() {
    resetChatListHarness({ platformOs: 'web' });
    const locks = installWebLockManagerMock();
    let connection: Awaited<ReturnType<typeof restoreServerAccountForTest>> | undefined;
    onTestFinished(async () => {
        standardCleanup();
        markSessionSurfaceHidden(SESSION_ID);
        await connection?.dispose();
        storage.setState(storage.getInitialState(), true);
        locks.restore();
    });
    const http = createHomeHubArtifactHttpBoundary('reader');
    let serverSeq = 10;
    const forwardRequests: URL[] = [];
    connection = await restoreServerAccountForTest({
        serverUrl: 'https://forward-history.example.test',
        accountId: 'reader',
        request: async (input, init) => {
            const url = new URL(String(input));
            if (url.pathname === '/v2/sessions' || url.pathname === '/v2/sessions/active')
                return Response.json({ sessions: [wireSession(serverSeq)], hasNext: false, nextCursor: null });
            if (url.pathname === '/v2/sessions/' + SESSION_ID)
                return Response.json({ session: wireSession(serverSeq) });
            if (url.pathname === '/v2/sessions/metadata-upgrades') return Response.json({ sessionIds: [] });
            if (url.pathname === '/v1/sessions/' + SESSION_ID + '/messages') {
                if (serverSeq > 10) forwardRequests.push(url);
                return Response.json({
                    messages: [wireMessage(serverSeq > 10 ? 11 : 10)],
                    hasMore: false, nextAfterSeq: null, nextBeforeSeq: null,
                });
            }
            return http.request(input, init);
        },
    });
    await sync.refreshSessions({ awaitSessionListHydration: true });
    await sync.ensureSessionVisibleForMessageRoute(SESSION_ID);
    markSessionSurfaceVisible(SESSION_ID);
    await sync.refreshSessionMessages(SESSION_ID);
    expect(messageRouteIds()).toContain('server:m10');
    storage.setState({ settings: { ...settingsDefaults, transcriptGroupingMode: 'linear', transcriptMotionPreset: 'off' } });
    const home = connection.home;

    return {
        home,
        forwardRequests,
        async deferNewer() {
            serverSeq = 600;
            await act(async () => {
                await sync.refreshSessions({ awaitSessionListHydration: true });
                // A seq-only list refresh does not rehydrate an unchanged metadata
                // tuple. Catch-up reads the exact Session shell's durable seq hint.
                const hydration = await sync.ensureSessionVisibleForMessageRoute(SESSION_ID, {
                    serverId: home.id,
                    forceRefresh: true,
                    hydrateMessages: false,
                });
                expect(hydration.kind).toBe('available');
                expect(storage.getState().sessions[SESSION_ID]?.seq).toBe(serverSeq);
                await sync.refreshSessionMessages(SESSION_ID);
            });
            expect(sync.hasDeferredNewerMessages(SESSION_ID)).toBe(true);
            forwardRequests.length = 0;
        },
    };
}

describe('ChatList (forward prefetch)', () => {
    it.each([
        ['near the bottom', true],
        ['outside the configured threshold', false],
    ] as const)('uses the real deferred-newer owner while detached %s', async (_label, shouldLoad) => {
        const history = await prepareHistory();
        const threshold = sync.getSyncTuning().transcriptForwardPrefetchThresholdPx;
        const distanceFromBottom = shouldLoad ? threshold / 2 : threshold + 100;
        const scrollTop = 200;
        const clientHeight = 500;
        const scrollHeight = scrollTop + clientHeight + distanceFromBottom;
        const scroller = createChatListHarnessWebScroller({
            clientHeight, scrollHeight, scrollTop: scrollHeight - clientHeight,
        });

        await withChatListHarnessWebScrollerDom(scroller, async () => {
            const session = storage.getState().sessions[SESSION_ID];
            expect(session).toBeDefined();
            if (!session) throw new Error('Expected the real Home Session hydration to complete');
            const screen = await renderScreen(
                <AppSessionTranscriptSourceProvider sessionId={SESSION_ID} serverId={history.home.id}>
                    <ChatList
                        session={session}
                        sessionSurfaceKey={JSON.stringify([history.home.id, SESSION_ID])}
                        onViewportChange={(state) => sync.onSessionViewportChange(SESSION_ID, state)}
                    />
                </AppSessionTranscriptSourceProvider>,
            );
            try {
            await triggerLegendChatListInitialFill(screen, { contentHeight: scrollHeight, layoutHeight: clientHeight });
            await triggerLegendChatListScroll(scroller.scrollTop, {
                contentSize: { height: scrollHeight, width: 400 },
                layoutMeasurement: { height: clientHeight, width: 400 },
            });
            await triggerLegendChatListWheel(-100);
            // A browser wheel precedes its physical DOM movement. The real web
            // viewport owner reads scrollTop, rather than the synthetic payload.
            scroller.scrollTop = scrollTop;
            chatListHarnessState.legendListState = {
                contentLength: scrollHeight, scrollLength: clientHeight, scroll: scrollTop,
                isAtEnd: false, isNearEnd: false, isWithinMaintainScrollAtEndThreshold: false,
            };
            await triggerLegendChatListScroll(scrollTop, {
                contentSize: { height: scrollHeight, width: 400 },
                layoutMeasurement: { height: clientHeight, width: 400 },
                isTrusted: true,
            });
            expect(sync.getSessionViewport(SESSION_ID)?.isPinned).toBe(false);
            await history.deferNewer();
            scroller.scrollTop = scrollTop - 1;
            await triggerLegendChatListScroll(scrollTop - 1, {
                contentSize: { height: scrollHeight, width: 400 },
                layoutMeasurement: { height: clientHeight, width: 400 },
                isTrusted: true,
            });

            if (shouldLoad) {
                await vi.waitFor(() => {
                    expect(history.forwardRequests).toHaveLength(1);
                    expect(messageRouteIds()).toContain('server:m11');
                });
                expect(history.forwardRequests[0]?.origin).toBe(history.home.serverUrl);
                expect(sync.hasDeferredNewerMessages(SESSION_ID)).toBe(false);
            } else {
                expect(history.forwardRequests).toEqual([]);
                expect(messageRouteIds()).not.toContain('server:m11');
                expect(sync.hasDeferredNewerMessages(SESSION_ID)).toBe(true);
            }
            } finally {
                await screen.unmount();
            }
        });
    });
});
