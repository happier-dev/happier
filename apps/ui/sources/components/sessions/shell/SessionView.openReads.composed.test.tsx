import * as React from 'react';
import { act } from 'react-test-renderer';
import { expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { flushHookEffects } from '@/dev/testkit/hooks/flushHookEffects';
import { waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { createSessionFixture, createSessionListRenderableSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { createPlainSessionWithDisplayRecordFixture } from '@/dev/testkit/fixtures/sessionDisplayFixtures';
import { createDeferred } from '@/dev/testkit/hooks/createDeferred';
import { installShippedNativeFrameScheduler } from '@/dev/testkit/legend/shippedNativeLegendRuntime';
import { installSessionPaneRuntimeTestHarness } from '@/components/sessions/panes/sessionPaneRuntimeTestHarness';
import { DestinationInstanceHost } from '@/components/appShell/workspace/DestinationInstanceHost';
import { SessionDestinationBody } from './SessionDestinationBody';
import { PaneColumnsHost } from '@/components/appShell/panes/PaneColumnsHost';
import { storage } from '@/sync/domains/state/storageStore';
import { sync } from '@/sync/sync';
import { hasCurrentSessionTurnsProjection } from '@/sync/domains/session/hasAuthoritativeSessionRouteData';
import { getSessionSurfaceVisibilitySnapshot } from '@/sync/domains/session/sessionSurfaceVisibility';
import { buildSessionTurnsProjectionV1, type SessionTurnV1 } from '@happier-dev/protocol/sessions/turns/sessionTurnV1';
import { SESSION_CONSUMPTION_REPLACE_EVENT, SessionConsumptionReplaceV1Schema } from '@happier-dev/protocol/sessions';
import { buildSystemSessionMetadataV1 } from '@happier-dev/protocol/sessions/control/contract';
import { installTimerCensus } from '@/dev/testkit/performance/timerCensus';
import { ChatList } from '@/components/sessions/transcript/ChatList';
import { ChatListInternal } from '@/components/sessions/transcript/ChatListInternal';
import { createCommittedFiberRenderCounter, readTestRendererRoot } from '@/dev/testkit/performance/committedFiberCounts';
import { SessionCockpitChromeRegistryProvider, useSessionCockpitChromeRegister, type SessionCockpitChromeRegistration } from '@/components/workspaceCockpit/session/SessionCockpitChromeRegistry';
import type { Socket } from 'socket.io-client';

vi.mock('socket.io-client', async importOriginal =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));
const legendViewport = vi.hoisted(() => ({ renderAllRows: false }));
vi.mock('@legendapp/list/react-native', async importOriginal => {
    const original = await importOriginal<typeof import('@legendapp/list/react-native')>();
    const { createCapturingLegendListMock } = await import('@/dev/testkit/mocks/legendList');
    const fixture = createCapturingLegendListMock().module;
    return {
        ...original,
        LegendList: React.forwardRef<React.ComponentRef<typeof original.LegendList>, React.ComponentPropsWithoutRef<typeof original.LegendList>>(
          function SessionOpenLegendList(props, ref) {
            const List = legendViewport.renderAllRows ? fixture.LegendList : original.LegendList;
            return <List {...props} ref={ref} />;
          },
        ),
    };
});
// Only platform/transport boundaries are replaced; route hydration, navigation
// backfill, the composer, transcript and live-consumption admission stay real.
vi.mock('react-native', async () =>
    (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock({
        Platform: { OS: 'web' }, useWindowDimensions: () => ({ width: 1400, height: 900 }),
    }));
vi.mock('expo-router', async () =>
    (await import('@/dev/testkit/mocks/router')).createExpoRouterMock({ pathname: '/session/ordinary-open' }).module);
vi.mock('@react-navigation/native', async () =>
    (await import('@/dev/testkit/mocks/reactNavigation')).createReactNavigationNativeMock({ renderInitialNavigatorScreen: true }));
vi.mock('react-native-safe-area-context', () => ({
    useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
    useSafeAreaFrame: () => ({ x: 0, y: 0, width: 1400, height: 900 }),
}));

const reads: string[] = [];
const httpRequests: string[] = [];
const coldOpenId = 'cold-open-settled-turn';
const coldOpenRead = createDeferred<void>();
const coldOpenRequests: string[] = [];
const revisitId = 'turn-marker-revisit';
const jumpId = 'turn-marker-jump';
const failedId = 'turn-marker-failed';
const revisitTurnRead = createDeferred<void>();
const revisitReads: string[] = [];

function agentMessage(seq: number, content: unknown, meta?: Record<string, unknown>) {
    return {
        id: `message-${seq}`, seq, localId: null, sidechainId: null,
        content: { t: 'plain', v: { role: 'agent', content, ...(meta ? { meta } : {}) } },
        createdAt: seq, updatedAt: seq,
    };
}

function agentText(seq: number, text: string) {
    return agentMessage(seq, {
        type: 'output', data: {
            type: 'assistant', uuid: `reply-${seq}`, parentUuid: null, isSidechain: false,
            message: { role: 'assistant', content: [{ type: 'text', text }] },
        },
    });
}

function markerTurn(id: string): SessionTurnV1 {
    return { turnId: 'settled', status: id === failedId ? 'failed' : 'completed', startedAt: 1, terminalAt: 4001, updatedAt: 4001,
        transcriptAnchors: { startUserMessageSeq: 1, endSeqInclusive: 3 } };
}
const machineRequests: string[] = [];
const socketRequests: string[] = [];
const physicalSockets = new Set<Socket>();
const recordSocketRequest = (event: string) => { socketRequests.push(event); };
const runtime = installSessionPaneRuntimeTestHarness({
    rpc: async method => { machineRequests.push(method); return null; },
    onHttpRequest: (input, init) => {
        httpRequests.push(String(input));
        const path = new URL(String(input)).pathname;
        const method = init?.method ?? 'GET';
        if (method === 'GET' && [
            `/v1/sessions/${revisitId}/turns`, `/v2/sessions/${revisitId}`, `/v1/sessions/${revisitId}/messages`,
        ].includes(path)) revisitReads.push(path);
        if (method === 'GET' && (path === `/v1/sessions/${coldOpenId}/turns` || path === `/v2/sessions/${coldOpenId}`)) {
            coldOpenRequests.push(`GET ${path}`);
        } else if (method === 'POST' && path === '/v2/sessions/read-batch') {
            const batch = JSON.parse(String(init?.body));
            if (batch.includeSnapshot && batch.sessionIds.includes(coldOpenId)) {
                coldOpenRequests.push(batch.includeTurns ? 'snapshot with turns' : 'snapshot without turns');
            }
            if (batch.sessionIds.includes(revisitId)) revisitReads.push(`${path} ${String(batch.includeTurns)}`);
        }
    },
    configureSocket: socket => {
        socket.offAnyOutgoing(recordSocketRequest);
        socket.onAnyOutgoing(recordSocketRequest);
        physicalSockets.add(socket);
        const originalAck = vi.mocked(socket.emitWithAck).getMockImplementation();
        if (!originalAck) throw new Error('Expected the canonical Socket boundary');
        vi.mocked(socket.emitWithAck).mockImplementation(async (event, payload: unknown) => {
            recordSocketRequest(event);
            if (event === SESSION_CONSUMPTION_REPLACE_EVENT) {
                const request = SessionConsumptionReplaceV1Schema.parse(payload);
                return { v: 1, ok: true, liveSessionIds: request.liveSessionIds, durableSessionIds: request.durableSessionIds };
            }
            return originalAck.call(socket, event, payload);
        });
    },
    request: async (input, init) => {
        const url = new URL(String(input));
        const markerId = [revisitId, jumpId, failedId].find(id => url.pathname === `/v2/sessions/${id}`
            || url.pathname.startsWith(`/v1/sessions/${id}/`));
        if (markerId && url.pathname.startsWith('/v2/sessions/')) {
            return Response.json({ session: createPlainSessionWithDisplayRecordFixture({ id: markerId, seq: markerId === jumpId ? 50 : 3 }) });
        }
        if (markerId && url.pathname.endsWith('/turns')) {
            if (markerId === revisitId) await revisitTurnRead.promise;
            return Response.json(buildSessionTurnsProjectionV1({ sessionId: markerId, updatedAt: 4001, turns: [markerTurn(markerId)] }));
        }
        if (url.pathname === `/v2/sessions/${coldOpenId}` && (init?.method ?? 'GET') === 'GET') {
            await coldOpenRead.promise;
            return Response.json({ session: createPlainSessionWithDisplayRecordFixture({ id: coldOpenId, seq: 3 }) });
        }
        if (url.pathname === `/v1/sessions/${coldOpenId}/turns`) {
            await coldOpenRead.promise;
            return Response.json(buildSessionTurnsProjectionV1({ sessionId: coldOpenId, updatedAt: 4001, turns: [{
                turnId: 'settled', status: 'completed', startedAt: 1, updatedAt: 4001, terminalAt: 4001,
                transcriptAnchors: { startUserMessageSeq: 1, finalAssistantMessageSeq: 2 },
            }] }));
        }
        if (/^\/v1\/sessions\/[^/]+\/messages$/.test(url.pathname) && (init?.method ?? 'GET') === 'GET') {
            reads.push(url.pathname + url.search);
            if (markerId) {
                const prompt = {
                    id: 'message-1', seq: 1, localId: null, sidechainId: null,
                    content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'Marker prompt' } } },
                    createdAt: 1, updatedAt: 1,
                };
                const reply = agentText(2, 'Marker reply');
                const end = markerId === failedId
                    ? agentMessage(3, { type: 'codex', data: { type: 'turn_failed', id: 'settled' } }, { source: 'runtime', runtimeEventKind: 'turn-failed', runtimeTurnId: 'settled' })
                    : agentText(3, 'Closing reply');
                const before = url.searchParams.get('beforeSeq');
                const after = url.searchParams.get('afterSeq');
                if (markerId === jumpId) {
                    const messages = before === '2' ? [prompt] : after === '1' ? [reply]
                        : after === '2' ? [end] : after === null ? [agentText(50, 'Tail reply')] : [];
                    return Response.json({ messages, hasMore: after === '1', nextBeforeSeq: messages[0]?.seq ?? null, nextAfterSeq: messages[0]?.seq ?? null });
                }
                return Response.json({
                    messages: after === null ? [end, reply, prompt] : [],
                    hasMore: false, nextBeforeSeq: null, nextAfterSeq: null,
                });
            }
            return Response.json({ messages: url.searchParams.has('afterSeq') ? [] : [1, 2, 3].map(seq => ({
                id: `message-${seq}`, seq, localId: null, sidechainId: null,
                content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: `Turn ${seq}` } } },
                createdAt: seq, updatedAt: seq,
            })), hasMore: false, nextBeforeSeq: null, nextAfterSeq: null });
        }
        if (/^\/v1\/sessions\/[^/]+\/turns$/.test(url.pathname)) {
            const sessionId = url.pathname.split('/')[3]!;
            // Reproduce the live ordering: the retained Session can open before
            // its bounded turn projection finishes. Finishing hydration must
            // consume that transcript rather than request another tail page.
            await waitForHomeGovernance(() => expect(storage.getState().sessionMessages[sessionId]?.isLoaded).toBe(true));
            return Response.json(buildSessionTurnsProjectionV1({ sessionId, updatedAt: 1, turns: [] }));
        }
        return null;
    },
});

it('includes settled turn markers in the first populated cold transcript commit with one open read', async () => {
    const id = coldOpenId;
    storage.getState().applyServerScopedSessionListRows(runtime.serverId, [
        createSessionListRenderableSessionFixture({ id, serverId: runtime.serverId, seq: 3 }),
    ], { source: 'rowOnly', mode: 'append' });
    expect(storage.getState().sessions[id]).toBeUndefined();

    // All three rows fit in the test viewport. Keep Session and the row renderer real.
    legendViewport.renderAllRows = true;
    let screen: Awaited<ReturnType<typeof renderScreen>> | undefined;
    let firstPaintMarkerCount: number | undefined;
    let observeFirstPaint: (() => void) | undefined;
    try {
        const mounted = await renderScreen(<React.Profiler id="cold-open" onRender={() => observeFirstPaint?.()}>
            <DestinationInstanceHost tabId={id}
                ref={{ kind: 'session', params: { id, serverId: runtime.serverId } }} pathname={`/session/${id}`} focused visible
                navigation={{ push: () => {}, replace: () => {}, back: () => {} }}>
                <SessionDestinationBody />
            </DestinationInstanceHost>
        </React.Profiler>, { wrapper: runtime.Wrapper });
        screen = mounted;
        observeFirstPaint = () => {
            if (firstPaintMarkerCount === undefined && mounted.getTextContent().includes('Turn 1')) {
                firstPaintMarkerCount = mounted.findAllHostsByTestId('transcript-turn-duration').length;
            }
        };
        await act(async () => {
            coldOpenRead.resolve();
            await waitForHomeGovernance(() => expect(hasCurrentSessionTurnsProjection(storage.getState().sessions[id] ?? {})).toBe(true));
            await waitForHomeGovernance(() => expect(storage.getState().sessionMessages[id]?.isLoaded).toBe(true));
        });
        await flushHookEffects({ cycles: 3, turns: 3 });
        expect.soft(coldOpenRequests).toEqual(['snapshot with turns']);
        expect.soft(reads.filter(path => path.startsWith(`/v1/sessions/${id}/messages`))).toHaveLength(1);
        expect(screen.getTextContent()).toContain('Turn 1');
        expect(firstPaintMarkerCount).toBe(1);
    } finally {
        await screen?.unmount();
        legendViewport.renderAllRows = false;
    }
});

it('keeps late markers out of held rows, then includes them on a retained revisit with zero reads', async () => {
    const id = revisitId;
    const serverId = runtime.serverId;
    storage.getState().applySessions([createSessionFixture({ id, serverId, seq: 3, encryptionMode: 'plain' })]);
    await expect(sync.ensureSessionVisibleForMessageRoute(id, {
        serverId, forceRefresh: true, includeTurnsProjection: false, awaitMessageHydration: true,
    }))
        .resolves.toMatchObject({ kind: 'available' });
    expect(storage.getState().sessionMessages[id]?.isLoaded).toBe(true);
    expect(storage.getState().sessions[id]?.sessionTurns).toBeUndefined();
    const body = <SessionDestinationBody />;
    const navigation = { push: () => {}, replace: () => {}, back: () => {} };
    const ref = { kind: 'session' as const, params: { id, serverId } };
    let observeCommit: (() => void) | undefined;
    const tab = (shown: boolean) => <React.Profiler id={id} onRender={() => observeCommit?.()}>
        <DestinationInstanceHost tabId={id} ref={ref}
            pathname={`/session/${id}`} focused={shown} visible={shown} navigation={navigation}>
            {body}
        </DestinationInstanceHost>
    </React.Profiler>;
    legendViewport.renderAllRows = true;
    const screen = await renderScreen(tab(true), { wrapper: runtime.Wrapper });
    try {
        expect(screen.getTextContent()).toContain('Marker prompt');
        expect(screen.findAllHostsByTestId('transcript-turn-duration')).toHaveLength(0);
        await act(async () => {
            revisitTurnRead.resolve();
            await waitForHomeGovernance(() => expect(hasCurrentSessionTurnsProjection(storage.getState().sessions[id] ?? {})).toBe(true));
        });
        await flushHookEffects({ cycles: 3, turns: 3 });
        expect(screen.findAllHostsByTestId('transcript-turn-duration')).toHaveLength(0);
        await screen.update(tab(false));
        expect(getSessionSurfaceVisibilitySnapshot().visibleSessionIds).not.toContain(id);
        expect(storage.getState().sessionMessages[id]?.isLoaded).toBe(true);
        expect(storage.getState().sessions[id]?.sessionTurns?.turns).toHaveLength(1);
        const readsBeforeRevisit = revisitReads.length;
        let firstRevisitMarkerCount: number | undefined;
        const revealCommits: Array<{ visible: boolean; rows: boolean; markers: number }> = [];
        const readCommit = () => ({
            visible: screen.findHostByTestId(`session-view-retained-surface:${id}`)?.props.pointerEvents === 'auto',
            rows: screen.getTextContent().includes('Marker prompt'),
            markers: screen.findAllHostsByTestId('transcript-turn-duration').length,
        });
        const hiddenCommit = readCommit();
        observeCommit = () => {
            const commit = readCommit();
            revealCommits.push(commit);
            if (firstRevisitMarkerCount === undefined && commit.visible && commit.rows) {
                firstRevisitMarkerCount = commit.markers;
            }
        };
        await screen.update(tab(true));
        await flushHookEffects({ cycles: 3, turns: 3 });
        expect(revisitReads.slice(readsBeforeRevisit)).toEqual([]);
        expect.soft(firstRevisitMarkerCount, JSON.stringify({ hiddenCommit, revealCommits })).toBe(1);
        expect(screen.findAllHostsByTestId('transcript-turn-duration')).toHaveLength(1);
    } finally {
        await screen.unmount();
        legendViewport.renderAllRows = false;
    }
});

function coldMarkerTab(id: string, seq: number) {
    const serverId = runtime.serverId;
    storage.getState().applyServerScopedSessionListRows(serverId, [
        createSessionListRenderableSessionFixture({ id, serverId, seq }),
    ], { source: 'rowOnly', mode: 'append' });
    return <DestinationInstanceHost tabId={id} ref={{ kind: 'session', params: { id, serverId } }}
        pathname={`/session/${id}`} focused visible navigation={{ push: () => {}, replace: () => {}, back: () => {} }}>
        <SessionDestinationBody />
    </DestinationInstanceHost>;
}

it('shows a duration in a jumped historical window only when its closing anchor pages in', async () => {
    const id = jumpId;
    legendViewport.renderAllRows = true;
    const screen = await renderScreen(coldMarkerTab(id, 50), { wrapper: runtime.Wrapper });
    try {
        await waitForHomeGovernance(() => expect(screen.getTextContent()).toContain('Tail reply'));
        const target = { kind: 'seq', seq: 1 } as const;
        await act(async () => {
            await expect(sync.loadTargetWindowMessages(id, target, { limit: 1 }))
                .resolves.toMatchObject({ status: 'loaded', targetPresent: true, hasMoreNewer: true });
        });
        expect(screen.getTextContent()).toContain('Marker prompt');
        expect(screen.getTextContent()).not.toContain('Closing reply');
        expect(screen.findAllHostsByTestId('transcript-turn-duration')).toHaveLength(0);
        await act(async () => {
            await expect(sync.loadTargetWindowMessages(id, target, { limit: 1, direction: 'newer' }))
                .resolves.toMatchObject({ status: 'loaded', rawSeqs: [3] });
        });
        expect(screen.getTextContent()).toContain('Closing reply');
        expect(screen.findAllHostsByTestId('transcript-turn-duration')).toHaveLength(1);
    } finally {
        await screen.unmount();
        legendViewport.renderAllRows = false;
    }
});

it('shows Stopped after on a cold open when the failed terminal row was absorbed by the reducer', async () => {
    legendViewport.renderAllRows = true;
    const screen = await renderScreen(coldMarkerTab(failedId, 3), { wrapper: runtime.Wrapper });
    try {
        await waitForHomeGovernance(() => expect(screen.getTextContent()).toContain('Marker reply'));
        expect(storage.getState().sessionMessages[failedId]?.latestNonRenderableMessageSeq).toBe(3);
        expect(screen.getTextContent()).toContain('Stopped after');
    } finally {
        await screen.unmount();
        legendViewport.renderAllRows = false;
    }
});

it('muse.experience.pc14 keeps a settled Session idle for 60 seconds without timers or requests', async () => {
    installShippedNativeFrameScheduler();
    const id = 'idle-session';
    storage.getState().applySessions([createSessionFixture({ id, serverId: runtime.serverId, seq: 4, encryptionMode: 'plain' })]);
    await sync.ensureSessionVisibleForMessageRoute(id, { serverId: runtime.serverId, hydrateMessages: false });
    vi.useFakeTimers();
    const census = installTimerCensus(stack => stack);
    let screen: Awaited<ReturnType<typeof renderScreen>> | null = null;
    try {
        screen = await renderScreen(<DestinationInstanceHost tabId={id}
            ref={{ kind: 'session', params: { id, serverId: runtime.serverId } }} pathname={`/session/${id}`} focused visible
            navigation={{ push: () => {}, replace: () => {}, back: () => {} }}>
            <SessionDestinationBody />
        </DestinationInstanceHost>, { wrapper: runtime.Wrapper });
        await act(async () => {
            await waitForHomeGovernance(() => expect(storage.getState().sessionMessages[id]?.isLoaded).toBe(true));
            await waitForHomeGovernance(() => expect(hasCurrentSessionTurnsProjection(storage.getState().sessions[id] ?? {})).toBe(true));
        });
        // Initial mount owns finite retention/viewed/persistence/prefetch/socket-release
        // callbacks. Drain that existing cohort once; no timers are excluded from idle counts.
        await flushHookEffects({ cycles: 3, turns: 3, advanceTimersMs: 20 });
        const physicalSocket = [...physicalSockets].find(socket => socket.connected);
        expect(physicalSocket).toBeDefined();
        const beforeSocketControl = socketRequests.length;
        physicalSocket!.emit('muse.experience.pc14.counter-control');
        expect(socketRequests.slice(beforeSocketControl)).toEqual(['muse.experience.pc14.counter-control']);
        await act(async () => { await vi.runOnlyPendingTimersAsync(); });
        expect(census.read()).toEqual([]);
        expect(storage.getState().sessionMessages[id]!.messageIdsOldestFirst).toHaveLength(3);
        expect(screen.findAllByType(ChatList)).toHaveLength(1);
        expect(screen.getTextContent()).toContain('Turn 1');
        const fires = census.readFires();
        const pendingAtIdle = census.read();
        const requests = { http: httpRequests.length, machine: machineRequests.length, socket: socketRequests.length };
        await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
        expect(census.readFires(), JSON.stringify({ pendingAtIdle, pendingAfterIdle: census.read(), requests: {
            http: httpRequests.slice(requests.http), machine: machineRequests.slice(requests.machine), socket: socketRequests.slice(requests.socket),
        } })).toEqual(fires);
        expect({ http: httpRequests.length, machine: machineRequests.length, socket: socketRequests.length }).toEqual(requests);
    } finally {
        await screen?.unmount();
        census.stop();
        vi.useRealTimers();
    }
});

it('reads one page per ordinary or Voice Session open and preserves a warm reopen probe', async () => {
    reads.length = 0;
    installShippedNativeFrameScheduler();
    for (const [id, expectedReads] of [['ordinary-open', 1], ['voice-open', 1], ['ordinary-open', 2]] as const) {
        // The live report's shell hint was ahead of its main transcript frontier.
        // An admission-triggered re-open must not manufacture another tail read.
        const session = createSessionFixture({ id, serverId: runtime.serverId, seq: 4, encryptionMode: 'plain' });
        if (id === 'voice-open') session.metadata = { ...session.metadata, ...buildSystemSessionMetadataV1({ key: 'voice_conversation', hidden: true }) };
        storage.getState().applySessions([session]);
        await expect(sync.ensureSessionVisibleForMessageRoute(id, {
            serverId: runtime.serverId, hydrateMessages: false,
        })).resolves.toMatchObject({ kind: 'available' });
        const screen = await renderScreen(<DestinationInstanceHost tabId={id}
            ref={{ kind: 'session', params: { id, serverId: runtime.serverId } }}
            pathname={`/session/${id}`} focused visible
            navigation={{ push: () => {}, replace: () => {}, back: () => {} }}>
            <SessionDestinationBody />
        </DestinationInstanceHost>, { wrapper: runtime.Wrapper });
        try {
            await act(async () => {
                await waitForHomeGovernance(() => expect(storage.getState().sessionMessages[id]?.isLoaded).toBe(true));
                await waitForHomeGovernance(() => expect(hasCurrentSessionTurnsProjection(storage.getState().sessions[id] ?? {})).toBe(true));
            });
            await flushHookEffects({ cycles: 3, turns: 3 });
            expect(reads.filter(path => path.startsWith(`/v1/sessions/${id}/messages`))).toHaveLength(expectedReads);
        } finally { await screen.unmount(); }
    }
    expect(reads).toHaveLength(3);
});

it('renders only its focus readers when its retained Session tab is hidden and shown again', async () => {
    installShippedNativeFrameScheduler();
    const id = 'retained-switch';
    storage.getState().applySessions([createSessionFixture({ id, serverId: runtime.serverId, seq: 4, encryptionMode: 'plain' })]);
    await sync.ensureSessionVisibleForMessageRoute(id, { serverId: runtime.serverId, hydrateMessages: false });
    const counts = createCommittedFiberRenderCounter();
    let readRoot: (() => ReturnType<ReturnType<typeof readTestRendererRoot>>) | null = null;
    const navigation = { push: () => {}, replace: () => {}, back: () => {} };
    const ref = { kind: 'session' as const, params: { id, serverId: runtime.serverId } };
    // The workspace's retained tab host keeps its body element: a tab switch flips only these two facts.
    const body = <SessionDestinationBody />;
    const tab = (shown: boolean) => <React.Profiler id="session-tab" onRender={() => { if (readRoot) counts.onCommitRoot(readRoot()); }}>
        <DestinationInstanceHost tabId={id} ref={ref} pathname={`/session/${id}`} focused={shown} visible={shown} navigation={navigation}>
            {body}
        </DestinationInstanceHost>
    </React.Profiler>;
    const screen = await renderScreen(tab(true), { wrapper: runtime.Wrapper });
    try {
        await act(async () => {
            await waitForHomeGovernance(() => expect(storage.getState().sessionMessages[id]?.isLoaded).toBe(true));
            await waitForHomeGovernance(() => expect(hasCurrentSessionTurnsProjection(storage.getState().sessions[id] ?? {})).toBe(true));
        });
        await flushHookEffects({ cycles: 3, turns: 3 });
        expect(screen.getTextContent()).toContain('Turn 1');
        readRoot = readTestRendererRoot(screen.tree.root);
        counts.start();
        await screen.update(tab(false));
        await flushHookEffects({ cycles: 2, turns: 2 });
        // Hidden: the Session's demand withdraws (no visible or focused surface claims it).
        expect(getSessionSurfaceVisibilitySnapshot()).toMatchObject({ focusedSessionId: null, visibleSessionIds: [] });
        await screen.update(tab(true));
        await flushHookEffects({ cycles: 2, turns: 2 });
        expect(getSessionSurfaceVisibilitySnapshot()).toMatchObject({ focusedSessionId: id, visibleSessionIds: [id] });
        counts.stop();
        expect(screen.getTextContent()).toContain('Turn 1');
        const renders = counts.read().renders;
        const total = [...renders.values()].reduce((sum, count) => sum + count, 0);
        const summary = JSON.stringify(Object.fromEntries([...renders].sort((a, b) => b[1] - a[1]).slice(0, 25)));
        // Focus reaches the Session view's readers, not the view: its loaded frame, the cockpit
        // around it and the side rail draw nothing from a hide or show (a tab switch).
        expect(renders.get('SessionViewLoaded') ?? 0, summary).toBe(0);
        expect(renders.get('RightSidebarActionRailView') ?? 0, summary).toBe(0);
        expect(renders.get('SessionCockpitPanePresentationBoundary') ?? 0, summary).toBe(0);
        // The transcript list draws nothing from focus: only its focus-reading leaves (Find, Next landing, row
        // content demand) render, never the list or its renderer.
        expect(counts.read().commitsFor(ChatListInternal), summary).toBe(0);
        expect(renders.get('ChatListContent') ?? 0, summary).toBe(0);
        expect(renders.get('LegendListTranscriptRendererInner') ?? 0, summary).toBe(0);
        // Presence reaches the composer, the Session body, its header and the pane hosts by subscription:
        // none of them draws anything from a hide or show.
        expect(renders.get('SessionHeaderSlot') ?? 0, summary).toBe(0);
        expect(counts.read().commitsFor(SessionDestinationBody), summary).toBe(0);
        expect(counts.read().commitsFor(PaneColumnsHost), summary).toBe(0);
        // Find follows eligibility by subscription; the header carries its test IDs at their own nodes; the
        // destination chrome and Session scope keep their elements; a Session's atmosphere glass draws nothing
        // from visibility.
        for (const name of ['TranscriptFindSurface', 'TranscriptFindProvider', 'ChatFindSeedHost', 'SessionPaneHeaderBand',
            'DetailsTabHeader2', 'DestinationNavigationChrome', 'SessionViewerDestinationScope', 'SessionBoardControllerProvider', 'GlassSurface2']) {
            expect(renders.get(name) ?? 0, `${name} ${summary}`).toBe(0);
        }
        // HEAD before W5: ~564 (A/B arm); W5: 434; transcript list: 393; composer, body and pane hosts: 159;
        // Find, header, destination chain, atmosphere glass: 90. What remains draws from focus or visibility
        // (test IDs, display/inert, the atmosphere stage), is a null leaf that runs focus-gated effects, or is
        // this harness's wrapper; see P03-UI-RESIDUALS.
        expect(total, summary).toBeLessThan(100);
    } finally {
        await screen.unmount();
    }
});

const NO_COCKPIT_CATALOG: SessionCockpitChromeRegistration['catalog'] = [];
const closedCockpitColumn = () => ({ present: false, visible: false, available: false, setVisible: () => {} });
/** The phone's shown Session registers the bottom cockpit chrome; another Session's show replaces it. */
function CockpitChromeRegistrar(props: Readonly<{ initialSessionId: string; serverId: string; show: { current: (sessionId: string) => void } }>) {
    const register = useSessionCockpitChromeRegister();
    const [sessionId, setSessionId] = React.useState(props.initialSessionId);
    props.show.current = setSessionId;
    // A Session screen offers its Terminal tab unless told otherwise (SessionCockpitSurfaceScreen), so the shown
    // Session's registration differs from this view's own on each switch.
    React.useLayoutEffect(() => register({ sessionId, serverId: props.serverId, activeSurface: 'chat',
        terminalTabAvailable: true, openDetailsTabCount: 0, catalog: NO_COCKPIT_CATALOG, readColumn: closedCockpitColumn,
        switchSurface: () => {} }), [props.serverId, sessionId, register]);
    return null;
}

it('renders nothing of a retained Session view when the phone shows another Session and then this one again', async () => {
    installShippedNativeFrameScheduler();
    const id = 'cockpit-switch';
    storage.getState().applySessions([createSessionFixture({ id, serverId: runtime.serverId, seq: 4, encryptionMode: 'plain' })]);
    await sync.ensureSessionVisibleForMessageRoute(id, { serverId: runtime.serverId, hydrateMessages: false });
    const counts = createCommittedFiberRenderCounter();
    let readRoot: (() => ReturnType<ReturnType<typeof readTestRendererRoot>>) | null = null;
    const view = <DestinationInstanceHost tabId={id} ref={{ kind: 'session', params: { id, serverId: runtime.serverId } }}
        pathname={`/session/${id}`} focused visible navigation={{ push: () => {}, replace: () => {}, back: () => {} }}>
        <SessionDestinationBody />
    </DestinationInstanceHost>;
    const show = { current: (_sessionId: string) => {} };
    const screen = await renderScreen(<React.Profiler id="session-tab" onRender={() => { if (readRoot) counts.onCommitRoot(readRoot()); }}>
        <SessionCockpitChromeRegistryProvider>
            <CockpitChromeRegistrar initialSessionId={id} serverId={runtime.serverId} show={show} />
            {view}
        </SessionCockpitChromeRegistryProvider>
    </React.Profiler>, { wrapper: runtime.Wrapper });
    try {
        await act(async () => {
            await waitForHomeGovernance(() => expect(storage.getState().sessionMessages[id]?.isLoaded).toBe(true));
            await waitForHomeGovernance(() => expect(hasCurrentSessionTurnsProjection(storage.getState().sessions[id] ?? {})).toBe(true));
        });
        await flushHookEffects({ cycles: 3, turns: 3 });
        expect(screen.getTextContent()).toContain('Turn 1');
        readRoot = readTestRendererRoot(screen.tree.root);
        counts.start();
        // A rail switch: the other Session's screen takes the cockpit chrome, then this one takes it back.
        await act(async () => { show.current('other-session'); });
        await flushHookEffects({ cycles: 2, turns: 2 });
        await act(async () => { show.current(id); });
        await flushHookEffects({ cycles: 2, turns: 2 });
        counts.stop();
        const renders = counts.read().renders;
        const summary = JSON.stringify(Object.fromEntries([...renders].sort((a, b) => b[1] - a[1])));
        // The chrome names the shown Session. This view reads only whether it is its own (and acts through it on a
        // tap), so its frame and everything under it draw nothing. HEAD before: the frame, its body and pane
        // drivers re-rendered on both registrations (~1.1-1.6k renders per Android switch-back).
        expect([...renders].filter(([name]) => /^SessionViewLoadedFrame\d*$/.test(name)), summary).toEqual([]);
        const viewRenders = [...renders].filter(([name]) => name !== 'CockpitChromeRegistrar');
        expect(viewRenders.reduce((sum, [, count]) => sum + count, 0), summary).toBe(0);
    } finally {
        await screen.unmount();
    }
});

it('a turn\'s thinking and status writes draw only the leaves that show them, not the Session view', async () => {
    installShippedNativeFrameScheduler();
    const id = 'turn-status-writes';
    storage.getState().applySessions([createSessionFixture({ id, serverId: runtime.serverId, seq: 4, encryptionMode: 'plain' })]);
    await sync.ensureSessionVisibleForMessageRoute(id, { serverId: runtime.serverId, hydrateMessages: false });
    const counts = createCommittedFiberRenderCounter();
    let readRoot: (() => ReturnType<ReturnType<typeof readTestRendererRoot>>) | null = null;
    const screen = await renderScreen(<React.Profiler id="session-tab" onRender={() => { if (readRoot) counts.onCommitRoot(readRoot()); }}>
        <DestinationInstanceHost tabId={id} ref={{ kind: 'session', params: { id, serverId: runtime.serverId } }} pathname={`/session/${id}`}
            focused visible navigation={{ push: () => {}, replace: () => {}, back: () => {} }}>
            <SessionDestinationBody />
        </DestinationInstanceHost>
    </React.Profiler>, { wrapper: runtime.Wrapper });
    try {
        await act(async () => {
            await waitForHomeGovernance(() => expect(storage.getState().sessionMessages[id]?.isLoaded).toBe(true));
            await waitForHomeGovernance(() => expect(hasCurrentSessionTurnsProjection(storage.getState().sessions[id] ?? {})).toBe(true));
        });
        await flushHookEffects({ cycles: 3, turns: 3 });
        readRoot = readTestRendererRoot(screen.tree.root);
        const now = Date.now();
        // One turn's Session-row writes: thinking on, turn started, thinking off, turn completed.
        const writes: Record<string, unknown>[] = [
            { thinking: true, thinkingAt: now },
            { latestTurnStatus: 'started', latestTurnStatusObservedAt: now + 1 },
            { thinking: false, thinkingAt: now + 2 },
            { latestTurnStatus: 'completed', latestTurnStatusObservedAt: now + 3 },
        ];
        counts.start();
        for (const patch of writes) {
            await act(async () => {
                const current = storage.getState().sessions[id]!;
                storage.getState().applySessions([{ ...current, ...patch } as typeof current]);
            });
            await flushHookEffects({ cycles: 2, turns: 2 });
        }
        counts.stop();
        const renders = counts.read().renders;
        const total = [...renders.values()].reduce((sum, count) => sum + count, 0);
        const summary = JSON.stringify(Object.fromEntries([...renders].sort((a, b) => b[1] - a[1]).slice(0, 20)));
        // HEAD before: 179–215 renders per write, ~790 for these four (the Session view, the Board owner, the cockpit
        // pane and their subtrees). Now each write reaches only its readers: the header status leaf, the composer's
        // runtime source, the transcript's thinking row and the viewed-read leaf (measured 155 for the four).
        expect(renders.get('SessionBoardControllerRuntimeOwner') ?? 0, summary).toBe(0);
        expect(renders.get('SessionBoardControllerOwner') ?? 0, summary).toBe(0);
        expect(renders.get('SessionPageTabs') ?? 0, summary).toBe(0);
        expect(total, summary).toBeLessThanOrEqual(200);
    } finally {
        await screen.unmount();
    }
});

it('renders nothing of the Session view when a turn reports its usage', async () => {
    installShippedNativeFrameScheduler();
    const id = 'usage-write';
    storage.getState().applySessions([createSessionFixture({ id, serverId: runtime.serverId, seq: 4, encryptionMode: 'plain' })]);
    await sync.ensureSessionVisibleForMessageRoute(id, { serverId: runtime.serverId, hydrateMessages: false });
    const counts = createCommittedFiberRenderCounter();
    let readRoot: (() => ReturnType<ReturnType<typeof readTestRendererRoot>>) | null = null;
    const screen = await renderScreen(<React.Profiler id="session-tab" onRender={() => { if (readRoot) counts.onCommitRoot(readRoot()); }}>
        <DestinationInstanceHost tabId={id} ref={{ kind: 'session', params: { id, serverId: runtime.serverId } }} pathname={`/session/${id}`}
            focused visible navigation={{ push: () => {}, replace: () => {}, back: () => {} }}>
            <SessionDestinationBody />
        </DestinationInstanceHost>
    </React.Profiler>, { wrapper: runtime.Wrapper });
    try {
        await act(async () => {
            await waitForHomeGovernance(() => expect(storage.getState().sessionMessages[id]?.isLoaded).toBe(true));
            await waitForHomeGovernance(() => expect(hasCurrentSessionTurnsProjection(storage.getState().sessions[id] ?? {})).toBe(true));
        });
        await flushHookEffects({ cycles: 3, turns: 3 });
        readRoot = readTestRendererRoot(screen.tree.root);
        counts.start();
        // Each usage report of a streamed turn rewrites the Session row's latestUsage. Its readers follow the
        // usage owner (useSessionUsage); the Session view body and everything under it draw nothing from it.
        for (const contextSize of [15, 30, 45]) {
            await act(async () => {
                const current = storage.getState().sessions[id]!;
                storage.getState().applySessions([{ ...current, latestUsage: { inputTokens: contextSize, outputTokens: 5,
                    cacheCreation: 0, cacheRead: 0, contextSize } }]);
            });
            await flushHookEffects({ cycles: 2, turns: 2 });
        }
        counts.stop();
        const renders = counts.read().renders;
        const summary = JSON.stringify(Object.fromEntries([...renders].sort((a, b) => b[1] - a[1]).slice(0, 15)));
        // HEAD before: ~185 renders per write (the Session body and its whole subtree).
        expect([...renders.values()].reduce((sum, count) => sum + count, 0), summary).toBe(0);
    } finally {
        await screen.unmount();
    }
});

it('a Session switch inside one workspace tab mounts the new Session view once, under the chrome it keeps', async () => {
    installShippedNativeFrameScheduler();
    const [first, second] = ['switch-first', 'switch-second'];
    storage.getState().applySessions([first, second].map(id => createSessionFixture({ id, serverId: runtime.serverId, seq: 4, encryptionMode: 'plain' })));
    for (const id of [first, second]) await sync.ensureSessionVisibleForMessageRoute(id, { serverId: runtime.serverId, hydrateMessages: false });
    const counts = createCommittedFiberRenderCounter();
    let readRoot: (() => ReturnType<ReturnType<typeof readTestRendererRoot>>) | null = null;
    const navigation = { push: () => {}, replace: () => {}, back: () => {} };
    // A sidebar row click retargets the focused preview tab (`setTarget`): same tab, same body element, new ref.
    const body = <SessionDestinationBody />;
    const tab = (id: string) => <React.Profiler id="session-tab" onRender={() => { if (readRoot) counts.onCommitRoot(readRoot()); }}>
        <DestinationInstanceHost tabId="preview-tab" ref={{ kind: 'session', params: { id, serverId: runtime.serverId } }}
            pathname={`/session/${id}`} focused visible navigation={navigation}>
            {body}
        </DestinationInstanceHost>
    </React.Profiler>;
    const loaded = async (id: string) => act(async () => {
        await waitForHomeGovernance(() => expect(storage.getState().sessionMessages[id]?.isLoaded).toBe(true));
        await waitForHomeGovernance(() => expect(hasCurrentSessionTurnsProjection(storage.getState().sessions[id] ?? {})).toBe(true));
    });
    const screen = await renderScreen(tab(first), { wrapper: runtime.Wrapper });
    try {
        await loaded(first);
        await flushHookEffects({ cycles: 3, turns: 3 });
        readRoot = readTestRendererRoot(screen.tree.root);
        counts.start();
        await screen.update(tab(second));
        await loaded(second);
        await flushHookEffects({ cycles: 3, turns: 3 });
        counts.stop();
        expect(screen.getTextContent()).toContain('Turn 1');
        const { mounts } = counts.read();
        const summary = JSON.stringify(Object.fromEntries([...mounts].sort((a, b) => b[1] - a[1]).slice(0, 40)));
        // The Session view is one instance per Session (the destination scope, transcript hand-off, retained surface,
        // Board controller and transcript list are keyed by Session address): a switch mounts that view once, and
        // nothing of it mounts a second time while it opens. The tab's host and chrome stay mounted.
        for (const name of ['SessionViewerDestinationScope', 'SessionDestinationBody', 'SessionViewLoaded', 'ChatListContent']) {
            expect(mounts.get(name) ?? 0, `${name} ${summary}`).toBe(1);
        }
        for (const name of ['DestinationInstanceHost', 'DestinationNavigationChrome', 'HeaderActionsScope']) {
            expect(mounts.get(name) ?? 0, `${name} ${summary}`).toBe(0);
        }
    } finally {
        await screen.unmount();
    }
});
