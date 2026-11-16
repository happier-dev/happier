import * as React from 'react';
import { act } from 'react-test-renderer';
import { expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { flushHookEffects } from '@/dev/testkit/hooks/flushHookEffects';
import { waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { installShippedNativeFrameScheduler } from '@/dev/testkit/legend/shippedNativeLegendRuntime';
import { installSessionPaneRuntimeTestHarness } from '@/components/sessions/panes/sessionPaneRuntimeTestHarness';
import { DestinationInstanceHost } from '@/components/appShell/workspace/DestinationInstanceHost';
import { SessionDestinationBody } from './SessionDestinationBody';
import { PaneColumnsHost } from '@/components/appShell/panes/PaneColumnsHost';
import { storage } from '@/sync/domains/state/storageStore';
import { sync } from '@/sync/sync';
import { hasCurrentSessionTurnsProjection } from '@/sync/domains/session/hasAuthoritativeSessionRouteData';
import { getSessionSurfaceVisibilitySnapshot } from '@/sync/domains/session/sessionSurfaceVisibility';
import { buildSessionTurnsProjectionV1 } from '@happier-dev/protocol/sessions/turns/sessionTurnV1';
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
const machineRequests: string[] = [];
const socketRequests: string[] = [];
const physicalSockets = new Set<Socket>();
const recordSocketRequest = (event: string) => { socketRequests.push(event); };
const runtime = installSessionPaneRuntimeTestHarness({
    rpc: async method => { machineRequests.push(method); return null; },
    onHttpRequest: input => { httpRequests.push(String(input)); },
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
        if (/^\/v1\/sessions\/[^/]+\/messages$/.test(url.pathname) && (init?.method ?? 'GET') === 'GET') {
            reads.push(url.pathname + url.search);
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
    React.useLayoutEffect(() => register({ sessionId, serverId: props.serverId, activeSurface: 'chat',
        terminalTabAvailable: false, openDetailsTabCount: 0, catalog: NO_COCKPIT_CATALOG, readColumn: closedCockpitColumn,
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
