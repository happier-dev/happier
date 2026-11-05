import * as React from 'react';
import 'fake-indexeddb/auto';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen as renderActivityScreen, standardCleanup, createSessionMessagesFixture } from '@/dev/testkit';
import { readMountedSessionRealtimeTranscriptConsumerSessionIds } from '@/sync/runtime/sessionRealtimeTranscriptConsumers';
import { captureMountedDesktopOverlayPresentation } from '@/components/appShell/workspace/desktopOverlayPresentationRuntime';
import { reconcileDesktopActivityOverlayState } from './useDesktopActivityOverlayState';
import { hasDesktopActivityOverlayQaFixtureProducer, selectDesktopActivityOverlayQaFixture } from './desktopActivityOverlayQaFixtureSelection';
import type { DesktopActivityOverlaySyncPayload } from './desktopActivityOverlayBridge';
import type { BotFaceSnapshot } from '../presentation/notchBotTypes';
import { ActivityPersonalSessionMembershipProvider } from '@/activity/source/activityPersonalSessionMembership';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { publishHomeAccountChange } from '@/sync/runtime/orchestration/homeAccountChange';
import { AuthProvider, setCurrentAuth } from '@/auth/context/AuthContext';
import { TokenStorage, type AuthCredentials } from '@/auth/storage/tokenStorage';
import { createSessionFixture, createSessionOwnerViewerFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { createDesktopSecureStorageBoundary } from '@/dev/testkit/mocks/desktopSecureStorage';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries, waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installSessionActionFixture, installSessionActionRpcBoundary } from '@/dev/testkit/harness/sessionActionRpcBoundary';
import { storage } from '@/sync/domains/state/storage';
import type { Session } from '@/sync/domains/state/storageTypes';
import type { StorageState } from '@/sync/store/types';
import { buildSessionListRenderableFromSession } from '@/sync/domains/session/listing/sessionListRenderable';
import { publishSessionListBotSelection } from '@/sync/store/domains/sessionListBotSelection';
import { sessionRuntimeObservations } from '@/sync/domains/session/sessionRuntimeObservation';
import { localSettingsParse } from '@/sync/domains/settings/localSettings';
import * as actionExecutor from '@/sync/ops/actions/defaultActionExecutor';
import { PUSH_NOTIFICATION_ACTION_IDS } from '@happier-dev/protocol/push/pushNotificationActions';
import { ResolvedMcpToolIdentityV1Schema } from '@happier-dev/protocol/mcp/servers/tools/mcpToolIdentityV1';

import { settingsParse } from '@/sync/domains/settings/settings';
import { setScreenSharingPrivacyActive } from '@/desktop/capture/useNativeRecordingActive';
import { DesktopActivityOverlayRuntime as NativeDesktopActivityOverlayRuntime } from './DesktopActivityOverlayRuntime';
import { DesktopActivityOverlayRuntime as WebDesktopActivityOverlayRuntime } from './DesktopActivityOverlayRuntime.web';

// The overlay is an Account delivery channel, so every candidate is admitted by its
// own Home's persisted Account policy. These Homes stay bound to a stable Account
// identity so the suite exercises the real admission path.
const DESKTOP_OVERLAY_TEST_HOME_SERVER_IDS = ['server-1', 'server-2'] as const;

async function persistDesktopOverlayHomeAccountSettings(): Promise<void> {
    const { saveAccountSettings } = await import('@/sync/domains/state/accountSettingsPersistence');
    for (const serverId of DESKTOP_OVERLAY_TEST_HOME_SERVER_IDS) {
        saveAccountSettings({ serverId, accountId: `account-${serverId}` }, settingsParse({}), 1);
    }
}

const sessionsState = vi.hoisted(() => ({
    value: [
        {
            id: 'session-1',
            serverId: 'server-1',
            createdAt: 1,
            updatedAt: 1_000,
            seq: 4,
            lastViewedSessionSeq: 2,
            active: true,
            activeAt: 950,
            archivedAt: null,
            presence: 'online',
            thinking: false,
            thinkingAt: null,
            latestTurnStatus: null,
            latestTurnStatusObservedAt: null,
            meaningfulActivityAt: 1_000,
            lastRuntimeIssue: null,
            lastTurnCompletedAt: null,
            pendingVersion: 1,
            pendingCount: 1,
            pendingPermissionRequestCount: 1,
            pendingUserActionRequestCount: 0,
            pendingRequestObservedAt: 950,
            agentStateVersion: 1,
            agentState: {
                controlledByUser: null,
                requests: {
                    'permission-1': {
                        tool: 'Bash',
                        kind: 'permission',
                        arguments: {},
                        createdAt: 950,
                    },
                },
            },
            metadata: {
                summary: { text: 'Primary session', updatedAt: 1 },
                path: '/Users/tester/project',
                host: 'tester.local',
                homeDir: '/Users/tester',
            },
        },
    ] as Array<Record<string, unknown>>,
}));
const sessionListIndexState = vi.hoisted(() => ({
    value: {
        'server-1': [
            {
                type: 'session',
                sessionId: 'session-1',
                serverId: 'server-1',
            },
        ],
    } as Record<string, Array<{ type: 'session'; sessionId: string; serverId: string }>>,
}));
const concurrentSessionListCacheState = vi.hoisted(() => ({
    value: {} as Record<string, unknown>,
}));
const sessionListRowsState = vi.hoisted(() => ({
    value: {} as Record<string, Record<string, Record<string, unknown>>>,
}));
const ordinarySessionListMembershipState = vi.hoisted(() => ({
    value: {} as Record<string, readonly string[]>,
}));

function syncCanonicalSessionListState(): void {
    const rowsByServerId: Record<string, Record<string, Record<string, unknown>>> = {};
    const membershipByServerId: Record<string, string[]> = {};
    for (const session of sessionsState.value) {
        const serverId = typeof session.serverId === 'string' && session.serverId.trim()
            ? session.serverId.trim()
            : 'server-1';
        const sessionId = String(session.id);
        (rowsByServerId[serverId] ??= {})[sessionId] = session;
        (membershipByServerId[serverId] ??= []).push(sessionId);
    }
    sessionListRowsState.value = rowsByServerId;
    ordinarySessionListMembershipState.value = membershipByServerId;
}
const localSettingsState = vi.hoisted(() => ({
    value: {
        activitySurfacesEnabled: true,
        iosLiveActivitiesEnabled: true,
        iosWidgetsEnabled: true,
        desktopOverlayEnabled: true,
        desktopOverlayVisibilityMode: 'attention_only',
    } as Record<string, unknown>,
}));
const settingsState = vi.hoisted(() => ({
    value: {} as Record<string, unknown>,
}));

const syncDesktopActivityOverlayMock = vi.hoisted(
    () => vi.fn<(payload: DesktopActivityOverlaySyncPayload) => Promise<void>>(async () => {}),
);
const listenDesktopActivityOverlayInteractionMock = vi.hoisted(
    () => vi.fn<(handler: (payload: unknown) => void) => Promise<() => void>>(async () => () => {}),
);
// Native events are broadcast: Auth and overlay owners subscribe independently.
function dispatchDesktopInteraction(payload: unknown): void {
    for (const [handler] of listenDesktopActivityOverlayInteractionMock.mock.calls) handler(payload);
}

const setDesktopActivityOverlayExpandedMock = vi.hoisted(
    () => vi.fn<(expanded: boolean) => Promise<void>>(async () => {}),
);
const showDesktopMainWindowMock = vi.hoisted(
    () => vi.fn<() => Promise<void>>(async () => {}),
);
const discardCaptureMock = vi.hoisted(() => vi.fn<(captureRef: unknown) => Promise<void>>(async () => {}));
const routerPushMock = vi.hoisted(() => vi.fn());
const emitDesktopActivityOverlayInteractionResultMock = vi.hoisted(
    () => vi.fn<(payload: { requestId: string; ok: boolean; errorCode?: string; error?: string }) => Promise<void>>(async () => {}),
);
const actionExecutorExecuteMock = vi.hoisted(
    () => vi.fn<(actionId: string, input: unknown, context: unknown) => void>(),
);
const nativeCommandNames: string[] = [];
const notchPresentationRequests: unknown[] = [];
const nativeEventNames: string[] = [];
let activityAvailable = true;
let rejectSessionActionRpc = false;
let availabilityListener: ((payload: unknown) => void) | null = null;

// The SDK is the host event boundary; native IPC below also supports its
// callback port when the Node require graph reaches the SDK before Vitest.
vi.mock('@tauri-apps/api/event', () => ({
    listen: async (event: string, handler: (event: { payload: unknown }) => void) => {
        nativeEventNames.push(event);
        if (event === 'activityOverlay://state') {
            availabilityListener = payload => handler({ payload });
            return () => {};
        }
        if (event !== 'desktopWindow://action') return () => {};
        return listenDesktopActivityOverlayInteractionMock(payload => handler({
            payload: { windowLabel: 'activity_overlay', ...(payload && typeof payload === 'object' ? payload : {}) },
        }));
    },
}));

vi.mock('socket.io-client', async (importOriginal) =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative'))
    .createReactNativeWebMock({ Platform: { OS: 'web' } }));

vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router'))
    .createExpoRouterMock({ router: { push: (value: unknown) => routerPushMock(value) } }).module);

const desktopHomes = createHomeGovernanceHarness();
let restoreDesktopBridge = () => {};
let desktopCredentials: AuthCredentials | null = null;

function DesktopAuthFixture({ children }: React.PropsWithChildren): React.ReactElement {
    return <AuthProvider initialCredentials={desktopCredentials}><ActivityPersonalSessionMembershipProvider enabled={false}>
        {children}</ActivityPersonalSessionMembershipProvider></AuthProvider>;
}

function renderScreen(element: Parameters<typeof renderActivityScreen>[0]) {
    return renderActivityScreen(element, { wrapper: DesktopAuthFixture });
}

async function renderSessionHydration(element: Parameters<typeof renderActivityScreen>[0]) {
    const sessions = sessionsState.value;
    const rows = sessionListRowsState.value;
    // Keep the real Home membership while its row bodies hydrate. Account
    // admission can initially publish a withheld snapshot; that bootstrap is
    // outside the changed projection's one content-publication observation.
    sessionsState.value = [];
    sessionListRowsState.value = {};
    const screen = await renderScreen(element);
    expect(syncDesktopActivityOverlayMock).toHaveBeenCalledWith(expect.objectContaining({ visible: false }));
    syncDesktopActivityOverlayMock.mockClear();
    await act(async () => {
        sessionsState.value = sessions;
        sessionListRowsState.value = rows;
    });
    await screen.update(element);
    await waitForHomeGovernance(() => expect(syncDesktopActivityOverlayMock.mock.calls.at(-1)?.[0])
        .toMatchObject({ visible: true }));
    return screen;
}

function canonicalSession(input: Record<string, unknown>): Session {
    // Historical test inputs are untyped boundary fixtures. The canonical fixture
    // supplies the actual owner access contract; the viewer producer derives facts.
    const session = createSessionFixture({
        ...input,
        metadata: { machineId: 'machine-1', ...(input.metadata as Session['metadata']) },
    } as Partial<Session>);
    return { ...session, viewer: createSessionOwnerViewerFixture(session) };
}

function publishDesktopFixture(): void {
    const sessions = sessionsState.value.map(canonicalSession);
    const rows: Record<string, Record<string, ReturnType<typeof buildSessionListRenderableFromSession>>> = {};
    for (const [serverId, byId] of Object.entries(sessionListRowsState.value)) {
        rows[serverId] = Object.fromEntries(Object.entries(byId).map(([id, row]) =>
            [id, buildSessionListRenderableFromSession(canonicalSession({ ...row, serverId }))]));
    }
    for (const session of sessions) {
        if (session.serverId) installSessionActionFixture({ homes: desktopHomes, storage, serverId: session.serverId, session });
    }
    storage.setState({
        isDataReady: true,
        sessions: Object.fromEntries(sessions.map((session) => [session.id, session])),
        settings: settingsParse(settingsState.value),
        localSettings: localSettingsParse(localSettingsState.value),
        sessionMessages: {},
        sessionListRowsByServerId: rows,
        sessionListBotRowsByServerId: publishSessionListBotSelection(storage.getState().sessionListRowsByServerId, rows,
            storage.getState().sessionListBotRowsByServerId),
        ordinarySessionListMembershipByServerId: ordinarySessionListMembershipState.value,
        sessionListIndexByServerId: sessionListIndexState.value,
        concurrentSessionListCacheByServerId: concurrentSessionListCacheState.value as StorageState['concurrentSessionListCacheByServerId'],
    });
}

// All mounted fixture updates go through the actual Zustand owner and selectors.
for (const fixture of [sessionsState, sessionListRowsState, ordinarySessionListMembershipState,
    sessionListIndexState, concurrentSessionListCacheState, localSettingsState, settingsState]) {
    let value = fixture.value;
    Object.defineProperty(fixture, 'value', {
        get: () => value,
        set: (next: typeof value) => { value = next; publishDesktopFixture(); },
    });
}

await loadSyncSingletonForTests();
describe('DesktopActivityOverlayRuntime', () => {
    it('N3 returns typed unavailable for session.open overlay on a non-desktop client', async () => {
        vi.stubGlobal('__TAURI_INTERNALS__', undefined);
        vi.stubGlobal('window', { ...window, __TAURI_INTERNALS__: undefined, location: { href: 'https://app.example.test/' } });
        const { restoreServerAccountForTest } = await import('@/dev/testkit/harness/serverAccountConnectionHarness');
        const environment = await restoreServerAccountForTest({ serverUrl: 'http://overlay-unavailable.test' });
        try {
            const executor = actionExecutor.createDefaultActionExecutor();
            const result = await executor.execute('session.open', {
                sessionId: 'session-1', serverId: environment.home.id, presentation: 'overlay',
            }, { surface: 'ui', serverId: environment.home.id });
            expect(result).toMatchObject({ ok: false, errorCode: 'unavailable' });
            expect(routerPushMock).not.toHaveBeenCalled();
        } finally { await environment.dispose(); }
    });
    beforeEach(async () => {
        selectDesktopActivityOverlayQaFixture(null);
        activityAvailable = true;
        rejectSessionActionRpc = false;
        availabilityListener?.({ availability: { activity: { kind: 'available' }, pet: { kind: 'available' }, windows: { kind: 'available' } } });
        nativeCommandNames.length = 0;
        notchPresentationRequests.length = 0;
        nativeEventNames.length = 0;
        const secureStorage = createDesktopSecureStorageBoundary();
        const callbacks = new Map<number, (payload: unknown) => void>();
        const eventDisposers = new Map<number, () => void>();
        let nextCallbackId = 0;
        const desktopBridge = { transformCallback: (callback: (payload: unknown) => void) => {
            const id = ++nextCallbackId;
            callbacks.set(id, callback);
            return id;
        }, invoke: async (command: string, args?: Record<string, unknown>) => {
            nativeCommandNames.push(command);
            if (command === 'plugin:event|listen') {
                const event = String(args?.event);
                const id = Number(args?.handler);
                const handler = callbacks.get(id);
                if (!handler) throw new Error('Native event callback was not registered');
                nativeEventNames.push(event);
                if (event === 'activityOverlay://state') availabilityListener = payload => handler({ payload });
                if (event === 'desktopWindow://action') {
                    eventDisposers.set(id, await listenDesktopActivityOverlayInteractionMock(payload => handler({
                        payload: { windowLabel: 'activity_overlay', ...(payload && typeof payload === 'object' ? payload : {}) },
                    })));
                }
                return id;
            }
            if (command === 'plugin:event|unlisten') {
                const id = Number(args?.eventId);
                eventDisposers.get(id)?.();
                eventDisposers.delete(id);
                callbacks.delete(id);
                return;
            }
            if (command === 'desktop_host_get_availability') return {
                activity: activityAvailable ? { kind: 'available' } : { kind: 'unavailable', reason: 'panel_host_apply_failed' },
                pet: { kind: 'available' }, windows: { kind: 'available' },
            };
            if (command.startsWith('desktop_secure_storage_')) return secureStorage.invoke(command, args);
            // The simulated native IPC receives the overlay producer's typed payload.
            if (command === 'desktop_activity_overlay_sync') return syncDesktopActivityOverlayMock(args?.payload as DesktopActivityOverlaySyncPayload);
            if (command === 'desktop_activity_overlay_request_presentation') {
                notchPresentationRequests.push(args?.requestedState);
                return;
            }
            if (command === 'desktop_activity_overlay_set_expanded') return setDesktopActivityOverlayExpandedMock(args?.expanded === true);
            if (command === 'desktop_show_main_window') return showDesktopMainWindowMock();
            if (command === 'desktop_capture_discard') return discardCaptureMock(args?.captureRef);
            if (command === 'desktop_capture_read_state') return { status: 'idle' };
            if (command === 'desktop_window_emit_action_result') {
                return emitDesktopActivityOverlayInteractionResultMock(args?.payload as Parameters<typeof emitDesktopActivityOverlayInteractionResultMock>[0]);
            }
            throw new Error(`Unexpected desktop IPC command: ${command}`);
        } };
        vi.stubGlobal('__TAURI_INTERNALS__', desktopBridge);
        discardCaptureMock.mockClear();
        restoreDesktopBridge = () => vi.stubGlobal('__TAURI_INTERNALS__', desktopBridge);
        const windowEvents = new EventTarget();
        vi.stubGlobal('window', {
            __TAURI_INTERNALS__: desktopBridge,
            __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener: () => {} },
            location: { href: 'https://app.example.test/' },
            addEventListener: windowEvents.addEventListener.bind(windowEvents),
            removeEventListener: windowEvents.removeEventListener.bind(windowEvents),
            dispatchEvent: windowEvents.dispatchEvent.bind(windowEvents),
            localStorage: globalThis.localStorage,
        });
        for (const serverId of DESKTOP_OVERLAY_TEST_HOME_SERVER_IDS) {
            await desktopHomes.addHome({ name: serverId, serverUrl: `https://${serverId}`,
                accountId: `account-${serverId}`, currentAccount: true, active: serverId === 'server-1' });
            desktopHomes.answer(serverId, '/v2/account/session-delivery-mutes', { body: { scopes: [] } });
        }
        desktopCredentials = await TokenStorage.getCredentialsForServerUrl('https://server-1', { serverId: 'server-1' });
        if (!desktopCredentials) throw new Error('Desktop fixture Home did not persist its Account credential');
        installHomeGovernanceBoundaries(desktopHomes);
        installSessionActionRpcBoundary(() => {
            if (rejectSessionActionRpc) throw new Error('action_failed');
            return undefined;
        });
        const { restoreConnectionToActiveServer } = await import('@/sync/runtime/orchestration/connectionManager');
        // Wait for this restore's readiness, rather than the prior case's bit.
        storage.setState({ isDataReady: false });
        await restoreConnectionToActiveServer(desktopCredentials);
        storage.getState().activateProfileScope({ serverId: 'server-1', accountId: 'account-server-1' });
        await waitForHomeGovernance(() => expect(storage.getState().isDataReady).toBe(true));
        const createExecutor = actionExecutor.createDefaultActionExecutor;
        vi.spyOn(actionExecutor, 'createDefaultActionExecutor').mockImplementation((options) => {
            const executor = createExecutor(options);
            return { ...executor, execute: (...args) => {
                // Call-through observation; no Action result or decision is replaced.
                actionExecutorExecuteMock(...args);
                return executor.execute(...args);
            } };
        });
        await persistDesktopOverlayHomeAccountSettings();
        const now = Date.now();
        syncDesktopActivityOverlayMock.mockImplementation(async () => {});
        listenDesktopActivityOverlayInteractionMock.mockImplementation(async () => () => {});
        setDesktopActivityOverlayExpandedMock.mockImplementation(async () => {});
        showDesktopMainWindowMock.mockImplementation(async () => {});
        emitDesktopActivityOverlayInteractionResultMock.mockImplementation(async () => {});

        sessionsState.value = [
            {
                id: 'session-1',
                serverId: 'server-1',
                createdAt: 1,
                updatedAt: now,
                seq: 4,
                lastViewedSessionSeq: 2,
                active: true,
                activeAt: now - 50,
                archivedAt: null,
                presence: 'online',
                thinking: false,
                thinkingAt: null,
                latestTurnStatus: null,
                latestTurnStatusObservedAt: null,
                meaningfulActivityAt: now,
                lastRuntimeIssue: null,
                lastTurnCompletedAt: null,
                pendingVersion: 1,
                pendingCount: 1,
                pendingPermissionRequestCount: 1,
                pendingUserActionRequestCount: 0,
                pendingRequestObservedAt: now - 50,
                agentStateVersion: 1,
                agentState: {
                    controlledByUser: null,
                    requests: {
                        'permission-1': {
                            tool: 'Bash',
                            kind: 'permission',
                            arguments: {},
                            createdAt: now - 50,
                        },
                    },
                },
                metadata: {
                    summary: { text: 'Primary session', updatedAt: 1 },
                    path: '/Users/tester/project',
                    host: 'tester.local',
                    homeDir: '/Users/tester',
                },
            },
        ];
        syncCanonicalSessionListState();
        sessionListIndexState.value = {
            'server-1': [
                {
                    type: 'session',
                    sessionId: 'session-1',
                    serverId: 'server-1',
                },
            ],
        };
        sessionListRowsState.value = {
            'server-1': { 'session-1': sessionsState.value[0]! },
        };
        ordinarySessionListMembershipState.value = {
            'server-1': ['session-1'],
        };
        concurrentSessionListCacheState.value = {};
        localSettingsState.value = {
            activitySurfacesEnabled: true,
            iosLiveActivitiesEnabled: true,
            iosWidgetsEnabled: true,
            desktopOverlayEnabled: true,
            desktopOverlayVisibilityMode: 'attention_only',
        };
        settingsState.value = {
        };
    });

    afterEach(async () => {
        setScreenSharingPrivacyActive(false);
        standardCleanup();
        const { stopConcurrentSessionCacheSync } = await import('@/sync/runtime/orchestration/concurrentSessionCache');
        stopConcurrentSessionCacheSync();
        const { disconnectActiveServerConnection } = await import('@/sync/runtime/orchestration/connectionManager');
        await disconnectActiveServerConnection();
        setCurrentAuth(null);
        desktopCredentials = null;
        sessionsState.value = [];
        sessionListIndexState.value = {
            'server-1': [],
        };
        sessionListRowsState.value = {};
        ordinarySessionListMembershipState.value = {};
        concurrentSessionListCacheState.value = {};
        localSettingsState.value = {
            activitySurfacesEnabled: true,
            iosLiveActivitiesEnabled: true,
            iosWidgetsEnabled: true,
            desktopOverlayEnabled: true,
        };
        settingsState.value = {
        };
        syncDesktopActivityOverlayMock.mockReset();
        listenDesktopActivityOverlayInteractionMock.mockReset();
        setDesktopActivityOverlayExpandedMock.mockReset();
        showDesktopMainWindowMock.mockReset();
        emitDesktopActivityOverlayInteractionResultMock.mockReset();
        routerPushMock.mockReset();
        actionExecutorExecuteMock.mockReset();
        vi.useRealTimers();
        vi.restoreAllMocks();
        // The non-desktop case hides this port only for the render; credential
        // rollback must use the same device store that accepted the writes.
        restoreDesktopBridge();
        await desktopHomes.reset();
        vi.unstubAllGlobals();
    });

    it('omits recording-private Sessions before native overlay JSON and restores them after sharing ends', async () => {
        settingsState.value = { sessionListHiddenTagIdsWhileRecording: { 'server-1': ['private'] } };
        storage.getState().setSessionTagAssignmentsOptimistic('server-1', 'session-1', ['private']);
        setScreenSharingPrivacyActive(true);
        const screen = await renderScreen(<NativeDesktopActivityOverlayRuntime />);
        await waitForHomeGovernance(() => expect(syncDesktopActivityOverlayMock).toHaveBeenCalled());
        expect(JSON.stringify(syncDesktopActivityOverlayMock.mock.calls.at(-1)?.[0])).not.toContain('session-1');
        await act(async () => { setScreenSharingPrivacyActive(false); });
        await waitForHomeGovernance(() => expect(JSON.stringify(syncDesktopActivityOverlayMock.mock.calls.at(-1)?.[0])).toContain('session-1'));
        await screen.unmount();
    });

    it('preserves explicitly opened private overlay conversation without exposing its Session header', async () => {
        storage.setState({ sessionMessages: { 'session-1': createSessionMessagesFixture({ isLoaded: true,
            messageIdsOldestFirst: ['reply'], messagesById: { reply: {
                kind: 'agent-text', id: 'reply', localId: null, createdAt: 1, text: 'Explicit conversation body',
            } },
        }) } });
        const screen = await renderScreen(<NativeDesktopActivityOverlayRuntime />);
        await waitForHomeGovernance(() => expect(syncDesktopActivityOverlayMock.mock.calls.at(-1)?.[0]).toMatchObject({ visible: true }));
        const executor = actionExecutor.createDefaultActionExecutor();
        await act(async () => {
            const result = await executor.execute('session.open', { serverId: 'server-1', sessionId: 'session-1', presentation: 'overlay' },
                { surface: 'ui', serverId: 'server-1' });
            expect(result.ok).toBe(true);
        });
        await act(async () => {
            storage.getState().applySettingsLocal({ sessionListHiddenTagIdsWhileRecording: { 'server-1': ['private'] } });
            storage.getState().setSessionTagAssignmentsOptimistic('server-1', 'session-1', ['private']);
            setScreenSharingPrivacyActive(true);
        });
        expect(syncDesktopActivityOverlayMock.mock.calls.at(-1)?.[0]).toMatchObject({ model: {
            conversation: { sessionId: 'session-1', reply: { state: 'ready', text: 'Explicit conversation body' } },
            expanded: { rows: [] }, faces: { faces: [] },
        } });
        expect(syncDesktopActivityOverlayMock.mock.calls.at(-1)?.[0]).toMatchObject({ visible: true });
        expect(JSON.stringify(syncDesktopActivityOverlayMock.mock.calls.at(-1)?.[0])).not.toContain('Primary session');
        await screen.unmount();
    });

    it('N3 pins an admitted Session through the presentation Action and releases its conversation on target:null and disable', async () => {
        const target = { serverId: 'server-1', sessionId: 'session-1' };
        storage.setState({ sessionMessages: { 'session-1': createSessionMessagesFixture({ isLoaded: true,
            messageIdsOldestFirst: ['reply'], messagesById: { reply: {
                kind: 'agent-text', id: 'reply', localId: null, createdAt: 1, text: 'Pinned reply',
            } },
        }) } });
        const screen = await renderScreen(<NativeDesktopActivityOverlayRuntime />);
        await waitForHomeGovernance(() => expect(syncDesktopActivityOverlayMock.mock.calls.at(-1)?.[0]).toMatchObject({ visible: true }));
        const executor = actionExecutor.createDefaultActionExecutor();
        let result: unknown;
        await act(async () => { result = await executor.execute('session.open', { ...target, presentation: 'overlay' },
            { surface: 'ui', serverId: target.serverId }); });
        expect(result).toMatchObject({ ok: true });
        expect(notchPresentationRequests).toEqual(['pinned']);
        await act(async () => {
            const result = await executor.execute('session.open', { ...target, presentation: 'overlay' },
                { surface: 'agent', authority: 'account_automation', actionCaller: { kind: 'host' },
                    defaultSessionId: target.sessionId, serverId: target.serverId });
            expect(result.ok, JSON.stringify(result)).toBe(true);
        });
        expect(notchPresentationRequests).toEqual(['pinned', 'pinned']);
        expect(syncDesktopActivityOverlayMock.mock.calls.at(-1)?.[0]).toMatchObject({ model: {
            conversation: { ...target, accountId: 'account-server-1', reply: { state: 'ready', text: 'Pinned reply' }, refreshing: false },
        } });
        expect(readMountedSessionRealtimeTranscriptConsumerSessionIds(target.serverId)).toEqual([target.sessionId]);
        await act(async () => { dispatchDesktopInteraction({ actionIdentifier: 'overlay-set-expanded',
            data: { expanded: false, target: null } }); });
        expect(syncDesktopActivityOverlayMock.mock.calls.at(-1)?.[0]).toMatchObject({ model: { conversation: null } });
        expect(readMountedSessionRealtimeTranscriptConsumerSessionIds(target.serverId)).toEqual([]);
        await act(async () => { await executor.execute('session.open', { ...target, presentation: 'overlay' },
            { surface: 'ui', serverId: target.serverId }); });
        await act(async () => { storage.getState().applyLocalSettings({ desktopOverlayEnabled: false }, { persist: false }); });
        expect(captureMountedDesktopOverlayPresentation()).toBeNull();
        expect(readMountedSessionRealtimeTranscriptConsumerSessionIds(target.serverId)).toEqual([]);
        await screen.unmount();
    });

    it('N3 retargets one consumer, keeps a demoted Bot pinned, and withdraws private reply and ask on policy changes', async () => {
        sessionsState.value = ['session-1', 'session-2'].map(id => ({ ...sessionsState.value[0]!, id,
            metadata: { ...(sessionsState.value[0]!.metadata as object), bot: { kind: 'bot' } },
        }));
        syncCanonicalSessionListState();
        storage.setState({ sessionMessages: Object.fromEntries(['session-1', 'session-2'].map(id => [id,
            createSessionMessagesFixture({ isLoaded: true, messageIdsOldestFirst: ['reply'], messagesById: {
                reply: { kind: 'agent-text', id: 'reply', localId: null, createdAt: 1, text: `Private ${id}` },
            } }),
        ])) });
        const screen = await renderScreen(<NativeDesktopActivityOverlayRuntime />);
        await waitForHomeGovernance(() => expect(syncDesktopActivityOverlayMock.mock.calls.at(-1)?.[0]).toMatchObject({ visible: true }));
        const executor = actionExecutor.createDefaultActionExecutor();
        for (const sessionId of ['session-1', 'session-2']) {
            await act(async () => { expect(await executor.execute('session.open', { sessionId, serverId: 'server-1', presentation: 'overlay' },
                { surface: 'ui', serverId: 'server-1' })).toMatchObject({ ok: true }); });
            expect(readMountedSessionRealtimeTranscriptConsumerSessionIds('server-1')).toEqual([sessionId]);
        }
        expect(notchPresentationRequests).toEqual(['pinned', 'pinned']);
        await act(async () => {
            const session = storage.getState().sessions['session-2']!;
            storage.getState().applySessions([{ ...session, metadata: { ...session.metadata!, bot: null } }]);
        });
        expect(readMountedSessionRealtimeTranscriptConsumerSessionIds('server-1')).toEqual(['session-2']);
        expect((syncDesktopActivityOverlayMock.mock.calls.at(-1)?.[0] as DesktopActivityOverlaySyncPayload)
            .model.expanded.cards?.some(card => card.kind === 'permission_request')).toBe(true);
        syncDesktopActivityOverlayMock.mockClear();
        await act(async () => { storage.getState().applyLocalSettings({ activitySurfacePrivacyMode: 'status_only' }, { persist: false }); });
        expect(syncDesktopActivityOverlayMock).toHaveBeenCalled();
        for (const [payload] of syncDesktopActivityOverlayMock.mock.calls) {
            expect(payload).toMatchObject({ model: {
                conversation: { sessionId: 'session-2', reply: { state: 'hidden', text: null } },
            } });
            const cards = (payload as DesktopActivityOverlaySyncPayload).model.expanded.cards ?? [];
            expect(cards.some(card => card.kind === 'permission_request' || card.kind === 'user_question')).toBe(false);
        }
        desktopHomes.answer('server-1', '/v2/account/session-delivery-mutes', {
            body: { scopes: [{ kind: 'source', source: { kind: 'session', sessionId: 'session-2' } }] },
        });
        await act(async () => publishHomeAccountChange('server-1', ['session-follows']));
        await waitForHomeGovernance(() => expect(syncDesktopActivityOverlayMock.mock.calls.at(-1)?.[0]).toMatchObject({ model: { conversation: null } }));
        expect(readMountedSessionRealtimeTranscriptConsumerSessionIds('server-1')).toEqual([]);
        await screen.unmount();
    });

    it('does no QA fixture work in a production producer', async () => {
        vi.stubGlobal('__DEV__', false);
        const screen = await renderScreen(<NativeDesktopActivityOverlayRuntime />);
        try {
            await waitForHomeGovernance(() => expect(syncDesktopActivityOverlayMock.mock.calls.at(-1)?.[0]).toMatchObject({ visible: true }));
            expect(hasDesktopActivityOverlayQaFixtureProducer()).toBe(false);
            syncDesktopActivityOverlayMock.mockClear();
            await act(async () => { await selectDesktopActivityOverlayQaFixture('quota_summary'); });
            expect(syncDesktopActivityOverlayMock).not.toHaveBeenCalled();
        } finally {
            await screen.unmount();
            vi.unstubAllGlobals();
        }
    });

    it('publishes QA fixtures through the mounted canonical producer, suppresses repeated modes, and restores live content', async () => {
        const screen = await renderScreen(<NativeDesktopActivityOverlayRuntime />);
        await waitForHomeGovernance(() => expect(syncDesktopActivityOverlayMock.mock.calls.at(-1)?.[0]).toMatchObject({ visible: true }));
        const live = syncDesktopActivityOverlayMock.mock.calls.at(-1)?.[0] as DesktopActivityOverlaySyncPayload;
        syncDesktopActivityOverlayMock.mockClear();
        await act(async () => { await selectDesktopActivityOverlayQaFixture('quota_summary'); });
        expect(syncDesktopActivityOverlayMock).toHaveBeenCalledTimes(1);
        expect(syncDesktopActivityOverlayMock.mock.calls.at(-1)?.[0]).toMatchObject({ model: { expanded: {
            cards: [expect.objectContaining({ kind: 'quota_summary' })],
        } } });
        const selected = syncDesktopActivityOverlayMock.mock.calls.at(-1)?.[0];
        syncDesktopActivityOverlayMock.mockClear();
        for (let index = 0; index < 50; index += 1) await act(async () => { await selectDesktopActivityOverlayQaFixture('quota_summary'); });
        expect(syncDesktopActivityOverlayMock).not.toHaveBeenCalled();
        await act(async () => { await selectDesktopActivityOverlayQaFixture(null); });
        expect(syncDesktopActivityOverlayMock).toHaveBeenCalledTimes(1);
        // Restoring live content may rebuild its timestamp; it is not a rendered fact.
        const { generatedAt: _generatedAt, ...liveContent } = live.model;
        expect(syncDesktopActivityOverlayMock.mock.calls.at(-1)?.[0]).toMatchObject({
            visible: live.visible,
            policy: live.policy,
            model: liveContent,
        });
        expect(syncDesktopActivityOverlayMock.mock.calls.at(-1)?.[0]).not.toBe(selected);
        await screen.unmount();
    });

    it('notch.N3.F1/F2 composed producer keeps publications and face leaves scoped to real changes', async () => {
        const homeIds = ['server-1', 'server-2', 'server-3'];
        await desktopHomes.addHome({ name: 'server-3', serverUrl: 'https://server-3', accountId: 'account-server-3',
            currentAccount: true, active: false });
        const { saveAccountSettings } = await import('@/sync/domains/state/accountSettingsPersistence');
        saveAccountSettings({ serverId: 'server-3', accountId: 'account-server-3' }, settingsParse({}), 1);
        // Let unrelated Auth bootstrap finish rather than retry an unanswered Task route.
        desktopHomes.answer('server-1', '/v1/tasks', { body: { tasks: [] } });
        const { PluginAvailabilityActionHttpPathsV1, PluginAvailabilityMaterializationsReadActionOutputV1Schema,
            PluginAvailabilityIntentsListActionOutputV1Schema } = await import('@happier-dev/protocol/plugins/availability');
        desktopHomes.answer('server-1', PluginAvailabilityActionHttpPathsV1['account.plugins.availability.materializations.read'], {
            body: PluginAvailabilityMaterializationsReadActionOutputV1Schema.parse({ availabilityCursor: 0, snapshots: [] }),
        });
        desktopHomes.answer('server-1', PluginAvailabilityActionHttpPathsV1['account.plugins.availability.intents.list'], {
            body: PluginAvailabilityIntentsListActionOutputV1Schema.parse({ availabilityCursor: 0, pluginIds: [], intentReads: [], failedPluginIds: [] }),
        });
        desktopHomes.answer('server-1', '/v2/account/session-delivery-mutes', {
            body: { scopes: [{ kind: 'source', source: { kind: 'session', sessionId: 'bot-0' } }] },
        });
        const now = Date.now();
        // Isolate arrival cost from the explicitly accepted time-only activity changes.
        // Keep timers real so native/HTTP promises still settle normally.
        vi.spyOn(Date, 'now').mockReturnValue(now);
        const sessions = Array.from({ length: 1_000 }, (_, index) => canonicalSession({
            id: index < 40 ? `bot-${index}` : `ordinary-${index}`, serverId: homeIds[index % 3],
            active: true, activeAt: now, meaningfulActivityAt: now - index, seq: 0, lastViewedSessionSeq: 0,
            metadata: { path: '/repo', host: 'test', ...(index < 40 ? { bot: { kind: 'bot' } } : {}) },
        }));
        for (const session of sessions) {
            const address = { serverId: session.serverId!, sessionId: session.id };
            sessionRuntimeObservations.recordFullPublication(address, session.updatedAt, session);
            // A stable heartbeat fixture includes the already-observed device presence.
            sessionRuntimeObservations.observe(address, session);
        }
        // Seed one loaded corpus. The single-Session Action fixture also installs
        // HTTP bodies and republishes the store per Session; none is needed here.
        const rows = Object.fromEntries(homeIds.map(serverId => [serverId, Object.fromEntries(sessions
            .filter(session => session.serverId === serverId).map(session => [session.id, buildSessionListRenderableFromSession(session)]))]));
        storage.setState({
            sessions: Object.fromEntries(sessions.map(session => [session.id, session])),
            sessionListRowsByServerId: rows,
            sessionListBotRowsByServerId: publishSessionListBotSelection({}, rows),
            ordinarySessionListMembershipByServerId: Object.fromEntries(homeIds.map(serverId =>
                [serverId, sessions.filter(session => session.serverId === serverId).map(session => session.id)])),
            sessionListIndexByServerId: Object.fromEntries(homeIds.map(serverId => [serverId, sessions
                .filter(session => session.serverId === serverId).map(session => ({ type: 'session' as const, sessionId: session.id, serverId }))])),
        });
        storage.getState().applyLocalSettings({ desktopOverlayEnabled: true, activitySurfacesEnabled: true,
            desktopOverlayVisibilityMode: 'always_when_enabled' });
        for (const serverId of homeIds) storage.getState().applySessionOrganizationSnapshot(serverId, {
            schemaVersion: 1, version: 1, folders: [], folderAssignments: [], tags: [], tagAssignments: [], labels: [], orderEntries: [],
            pins: sessions.slice(0, 12).filter(session => session.serverId === serverId).map((session, index) => ({
                sessionId: session.id, sortKey: String(index), pinnedAt: now, listPinned: false, railPinned: true,
            })),
        });
        const renders: string[] = [];
        const FaceLeaf = React.memo(({ face }: { face: BotFaceSnapshot }) => { renders.push(face.sessionId); return null; });
        let receive: ((payload: DesktopActivityOverlaySyncPayload) => void) | undefined;
        function TransportConsumer(): React.ReactElement {
            const [payload, setPayload] = React.useState<DesktopActivityOverlaySyncPayload | null>(null);
            receive = next => setPayload(previous => reconcileDesktopActivityOverlayState(previous, next));
            return <>{payload?.model.faces.faces.map(face => <FaceLeaf key={JSON.stringify([face.serverId, face.sessionId])} face={face} />)}</>;
        }
        syncDesktopActivityOverlayMock.mockImplementation(async payload => {
            // Native IPC delivers JSON values; the real reconciler restores leaf identity.
            receive?.(JSON.parse(JSON.stringify(payload)) as DesktopActivityOverlaySyncPayload);
        });
        const screen = await renderScreen(<><TransportConsumer /><NativeDesktopActivityOverlayRuntime /></>);
        await vi.waitFor(() => expect(storage.getState().todoState).not.toBeNull(), { timeout: 20_000 });
        await act(async () => {
            const { getSyncSingleton } = await import('@/sync/runtime/getSyncSingleton');
            await getSyncSingleton().refreshPluginAccountAvailability();
        });
        await vi.waitFor(() => expect(syncDesktopActivityOverlayMock.mock.calls.at(-1)?.[0]).toMatchObject({ model: {
            faces: { faces: [expect.objectContaining({ sessionId: 'bot-3' }), expect.objectContaining({ sessionId: 'bot-6' }),
                expect.objectContaining({ sessionId: 'bot-9' })], overflowCount: 0 },
        } }), { timeout: 20_000 });
        syncDesktopActivityOverlayMock.mockClear();
        renders.length = 0;
        const requestsBefore = desktopHomes.requests.length;
        for (let index = 0; index < 100; index++) act(() => {
            const id = index % 3 === 0 ? 'ordinary-999' : 'bot-3';
            // Session-list arrivals enter through the real incremental row owner;
            // full transcript hydration has its own F3 contract.
            storage.getState().applyServerScopedSessionListRowPatches('server-1', [{ sessionId: id,
                patch: row => index % 3 === 1 ? { activeAt: now + index } : {
                    metadata: { ...row.metadata!, operatingSystem: `unrendered-${index}` },
                },
            }]);
        });
        await act(async () => {}); // Drain native bridge promises after each synchronous store commit has rendered.
        expect(syncDesktopActivityOverlayMock).not.toHaveBeenCalled();
        expect(renders).toEqual([]);
        expect(desktopHomes.requests.slice(requestsBefore)).toEqual([]);
        await act(async () => {
            const session = storage.getState().sessions['bot-36']!;
            storage.getState().applySessions([canonicalSession({ ...session, agentStateVersion: session.agentStateVersion + 1,
                pendingPermissionRequestCount: 1, pendingRequestObservedAt: now, viewer: undefined,
                agentState: { requests: { permission: { tool: 'Bash', kind: 'permission', arguments: {}, createdAt: now } } },
            })]);
        });
        expect(syncDesktopActivityOverlayMock).toHaveBeenCalledTimes(1);
        expect(renders).toEqual(['bot-36']);
        expect(desktopHomes.requests.slice(requestsBefore)).toEqual([]);
        const { getPersistenceStorage } = await import('@/sync/domains/state/persistenceStorage');
        const writes = vi.spyOn(getPersistenceStorage(), 'set'); // Call-through physical storage boundary.
        syncDesktopActivityOverlayMock.mockClear();
        renders.length = 0;
        await act(async () => { storage.getState().applyLocalSettings({ desktopOverlayVisibilityMode: 'attention_only' }); });
        expect(writes.mock.calls.filter(([key]) => key === 'local-settings')).toHaveLength(1);
        expect(syncDesktopActivityOverlayMock).toHaveBeenCalledTimes(1);
        expect(renders).toEqual([]); // Only unchanged bot-36 remains; membership removal mounts no leaf.
        expect(desktopHomes.requests.slice(requestsBefore)).toEqual([]);
        syncDesktopActivityOverlayMock.mockClear();
        await act(async () => { storage.getState().applyLocalSettings({ sidebarWidthPx: 456 }); });
        expect(syncDesktopActivityOverlayMock).not.toHaveBeenCalled();
        expect(renders).toEqual([]);
        await screen.unmount();
    }, 600_000);

    it.each([
        ['native', NativeDesktopActivityOverlayRuntime], ['web', WebDesktopActivityOverlayRuntime],
    ] as const)('synchronizes %s through the real desktop runtime', async (_entry, DesktopActivityOverlayRuntime) => {
        await renderScreen(React.createElement(DesktopActivityOverlayRuntime));

        expect(syncDesktopActivityOverlayMock).toHaveBeenCalledWith(expect.objectContaining({
            visible: true,
            model: expect.objectContaining({
                visible: true,
                expanded: expect.objectContaining({
                    cards: expect.arrayContaining([
                        expect.objectContaining({ sessionId: 'session-1' }),
                    ]),
                }),
            }),
        }));
        await waitForHomeGovernance(() => expect(nativeEventNames).toContain('desktopWindow://action'));
        expect(listenDesktopActivityOverlayInteractionMock).toHaveBeenCalled();
    }, 120_000);

    it('consumes the captured Account mute and Undo through the existing census without deleting Work', async () => {
        const { DesktopActivityOverlayRuntime } = await import('./DesktopActivityOverlayRuntime');
        const screen = await renderScreen(<DesktopActivityOverlayRuntime />);
        await waitForHomeGovernance(() => expect(syncDesktopActivityOverlayMock.mock.calls.at(-1)?.[0]).toMatchObject({ visible: true }));
        desktopHomes.answer('server-1', '/v2/account/session-delivery-mutes', {
            body: { scopes: [{ kind: 'source', source: { kind: 'session', sessionId: 'session-1' } }] },
        });
        await act(async () => publishHomeAccountChange('server-1', ['session-follows']));
        await waitForHomeGovernance(() => expect(syncDesktopActivityOverlayMock.mock.calls.at(-1)?.[0]).toMatchObject({ visible: false }));
        expect(storage.getState().sessions['session-1']).toBeDefined();
        desktopHomes.answer('server-1', '/v2/account/session-delivery-mutes', { body: { scopes: [] } });
        await act(async () => publishHomeAccountChange('server-1', ['session-follows']));
        await waitForHomeGovernance(() => expect(syncDesktopActivityOverlayMock.mock.calls.at(-1)?.[0]).toMatchObject({ visible: true }));
        await screen.unmount();
    });

    it('publishes no content for unrelated preferences and once for a changed rendered preference', async () => {
        const { DesktopActivityOverlayRuntime } = await import('./DesktopActivityOverlayRuntime');
        const screen = await renderSessionHydration(React.createElement(DesktopActivityOverlayRuntime));

        expect(syncDesktopActivityOverlayMock.mock.calls.at(-1)?.[0]).toMatchObject({ visible: true });

        syncDesktopActivityOverlayMock.mockClear();
        const buildModel = await import('../presentation/buildDesktopActivityOverlayModel');
        const buildSpy = vi.spyOn(buildModel, 'buildDesktopActivityOverlayModel');
        act(() => {
            storage.getState().applyLocalSettings({ sidebarWidthPx: 400 }, { persist: false });
        });
        expect(buildSpy).not.toHaveBeenCalled();
        expect(syncDesktopActivityOverlayMock).not.toHaveBeenCalled();
        await act(async () => {
            storage.getState().applyLocalSettings({ desktopOverlayAlwaysOnTop: false }, { persist: false });
        });
        expect(syncDesktopActivityOverlayMock).toHaveBeenCalledTimes(1);
        expect(syncDesktopActivityOverlayMock.mock.calls[0]?.[0]).toMatchObject({ policy: { alwaysOnTop: false } });
    }, 120_000);

    it('publishes terminal disabled policy when the content projection is unchanged', async () => {
        const { DesktopActivityOverlayRuntime } = await import('./DesktopActivityOverlayRuntime');
        const screen = await renderSessionHydration(React.createElement(DesktopActivityOverlayRuntime));

        expect(syncDesktopActivityOverlayMock).toHaveBeenCalledTimes(1);

        syncDesktopActivityOverlayMock.mockClear();
        localSettingsState.value = {
            ...localSettingsState.value,
            desktopOverlayEnabled: false,
        };

        await act(async () => {
            await screen.update(React.createElement(DesktopActivityOverlayRuntime));
        });

        expect(syncDesktopActivityOverlayMock).toHaveBeenCalledWith(expect.objectContaining({
            visible: false,
            model: expect.objectContaining({
                visible: false,
            }),
        }));
    }, 120_000);

    it('does not use pet desktop overlay settings to host the activity overlay', async () => {
        localSettingsState.value = {
            ...localSettingsState.value,
            desktopOverlayEnabled: false,
            desktopPetOverlayEnabledOverride: 'enabled',
            desktopPetOverlayVisibilityModeOverride: 'alwaysWhenEnabled',
        };

        const { DesktopActivityOverlayRuntime } = await import('./DesktopActivityOverlayRuntime');
        await renderScreen(React.createElement(DesktopActivityOverlayRuntime));

        expect(syncDesktopActivityOverlayMock).not.toHaveBeenCalled();
    }, 120_000);

    it('publishes one terminal hide when the content producer unmounts', async () => {
        const { DesktopActivityOverlayRuntime } = await import('./DesktopActivityOverlayRuntime');
        const screen = await renderScreen(<DesktopActivityOverlayRuntime />);
        await waitForHomeGovernance(() => expect(syncDesktopActivityOverlayMock.mock.calls.at(-1)?.[0])
            .toMatchObject({ visible: true }));
        syncDesktopActivityOverlayMock.mockClear();
        await screen.unmount();
        expect(syncDesktopActivityOverlayMock).toHaveBeenCalledTimes(1);
        expect(syncDesktopActivityOverlayMock.mock.calls[0]?.[0]).toMatchObject({ visible: false,
            model: { visible: false }, policy: { enabled: false } });
    });

    it('uses the desktop overlay selection path instead of widget mode when choosing visible sessions', async () => {
        sessionsState.value = [
            {
                id: 'session-1',
                serverId: 'server-1',
                seq: 4,
                lastViewedSessionSeq: 2,
                active: true,
                presence: 'online',
                thinking: false,
                pendingPermissionRequestCount: 1,
                pendingUserActionRequestCount: 0,
                metadata: {
                    summary: { text: 'Primary session', updatedAt: 1 },
                    path: '/Users/tester/project',
                    host: 'tester.local',
                    homeDir: '/Users/tester',
                },
            },
            {
                id: 'session-2',
                serverId: 'server-1',
                seq: 5,
                lastViewedSessionSeq: 1,
                active: false,
                presence: 1,
                thinking: false,
                pendingPermissionRequestCount: 0,
                pendingUserActionRequestCount: 1,
                metadata: {
                    summary: { text: 'Question session', updatedAt: 2 },
                    path: '/Users/tester/project-two',
                    host: 'tester.local',
                    homeDir: '/Users/tester',
                },
            },
        ];
        syncCanonicalSessionListState();
        sessionListIndexState.value = {
            'server-1': [
                {
                    type: 'session',
                    sessionId: 'session-1',
                    serverId: 'server-1',
                },
                {
                    type: 'session',
                    sessionId: 'session-2',
                    serverId: 'server-1',
                },
            ],
        };
        localSettingsState.value = {
            ...localSettingsState.value,
            widgetsPresetMode: 'attention',
            desktopOverlayVisibilityMode: 'active_sessions',
            desktopOverlayShowWhenRunning: true,
            desktopOverlayShowWhenAttentionRequired: true,
            desktopOverlayShowWhenReady: true,
        };

        const { DesktopActivityOverlayRuntime } = await import('./DesktopActivityOverlayRuntime');
        await renderScreen(React.createElement(DesktopActivityOverlayRuntime));

        expect(syncDesktopActivityOverlayMock).toHaveBeenCalledWith(expect.objectContaining({
            model: expect.objectContaining({
                expanded: expect.objectContaining({
                    rows: [expect.objectContaining({ sessionId: 'session-1' })],
                }),
            }),
        }));
    });

    it('does not synchronize when not running on tauri', async () => {
        vi.stubGlobal('__TAURI_INTERNALS__', undefined);
        Object.assign(window, { __TAURI_INTERNALS__: undefined });
        const { DesktopActivityOverlayRuntime } = await import('./DesktopActivityOverlayRuntime');
        await renderScreen(React.createElement(DesktopActivityOverlayRuntime));

        expect(syncDesktopActivityOverlayMock).not.toHaveBeenCalled();
        expect(listenDesktopActivityOverlayInteractionMock).not.toHaveBeenCalled();
    });

    it('does not synchronize when rendering inside the overlay window context', async () => {
        window.location.href = 'https://app.example.test/desktop/activity-overlay';
        const { DesktopActivityOverlayRuntime } = await import('./DesktopActivityOverlayRuntime');
        await renderScreen(React.createElement(DesktopActivityOverlayRuntime));

        expect(syncDesktopActivityOverlayMock).not.toHaveBeenCalled();
        expect(listenDesktopActivityOverlayInteractionMock).not.toHaveBeenCalled();
    });

    it.each(['enabled', 'disabled', 'unavailable'] as const)('executes settled Capture discard while the overlay is %s', async state => {
        if (state === 'disabled') localSettingsState.value = { ...localSettingsState.value, desktopOverlayEnabled: false };
        activityAvailable = state !== 'unavailable';
        if (!activityAvailable) availabilityListener?.({ availability: { activity: { kind: 'unavailable', reason: 'panel_host_apply_failed' } } });
        const { DesktopActivityOverlayRuntime } = await import('./DesktopActivityOverlayRuntime');
        await renderScreen(React.createElement(DesktopActivityOverlayRuntime));
        const handler = dispatchDesktopInteraction;
        expect(handler).toBeTypeOf('function');
        await act(async () => {
            handler?.({ windowLabel: 'capture', requestId: 'settled-discard', actionIdentifier: 'screenCapture.discard',
                data: { captureRef: 'discard-after-undo' } });
        });
        await waitForHomeGovernance(() => expect(emitDesktopActivityOverlayInteractionResultMock)
            .toHaveBeenCalledWith(expect.objectContaining({ windowLabel: 'capture', requestId: 'settled-discard', phase: 'settled' })));
        expect(discardCaptureMock).toHaveBeenCalledExactlyOnceWith('discard-after-undo');
        expect(emitDesktopActivityOverlayInteractionResultMock).toHaveBeenCalledWith({ windowLabel: 'capture',
            requestId: 'settled-discard', phase: 'settled', ok: true,
            result: { captureRef: 'discard-after-undo', status: 'discarded' } });
    });

    it('routes overlay interactions to the selected session without deciding presentation', async () => {
        const { DesktopActivityOverlayRuntime } = await import('./DesktopActivityOverlayRuntime');
        await renderScreen(React.createElement(DesktopActivityOverlayRuntime));

        const handler = dispatchDesktopInteraction as
            | ((payload: { actionIdentifier: string; data?: Record<string, unknown> }) => void)
            | undefined;

        expect(handler).toBeTypeOf('function');

        await act(async () => {
            handler?.({
                actionIdentifier: 'open-session:session-1',
                data: {
                    serverId: 'server-1',
                    sessionId: 'session-1',
                },
            });
        });

        expect(showDesktopMainWindowMock).toHaveBeenCalledTimes(1);
        expect(routerPushMock).toHaveBeenCalledWith('/session/session-1?serverId=server-1');
        expect(showDesktopMainWindowMock.mock.invocationCallOrder[0]).toBeLessThan(
            routerPushMock.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
        );
        expect(setDesktopActivityOverlayExpandedMock).not.toHaveBeenCalled();
    });

    it('acknowledges a request-bearing legacy completion Open after showing and routing its Session', async () => {
        const { DesktopActivityOverlayRuntime } = await import('./DesktopActivityOverlayRuntime');
        await renderScreen(React.createElement(DesktopActivityOverlayRuntime));
        let finishShowing!: () => void;
        showDesktopMainWindowMock.mockImplementationOnce(() => new Promise<void>(resolve => { finishShowing = resolve; }));

        await act(async () => {
            dispatchDesktopInteraction({
                requestId: 'completion-open',
                actionIdentifier: 'open-session:session-1',
                data: { serverId: 'server-1', sessionId: 'session-1' },
            });
        });
        expect(emitDesktopActivityOverlayInteractionResultMock).not.toHaveBeenCalled();

        await act(async () => { finishShowing(); });
        expect(routerPushMock).toHaveBeenCalledWith('/session/session-1?serverId=server-1');
        expect(emitDesktopActivityOverlayInteractionResultMock).toHaveBeenCalledWith({
            windowLabel: 'activity_overlay', requestId: 'completion-open', ok: true,
        });
        expect(routerPushMock.mock.invocationCallOrder[0]).toBeLessThan(
            emitDesktopActivityOverlayInteractionResultMock.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
        );
    });

    it('notch.N3.F4.act executes each decision and send once with surface ui', async () => {
        const { DesktopActivityOverlayRuntime } = await import('./DesktopActivityOverlayRuntime');
        await renderScreen(React.createElement(DesktopActivityOverlayRuntime));

        const handler = dispatchDesktopInteraction as
            | ((payload: { actionIdentifier: string; data?: Record<string, unknown> }) => void)
            | undefined;

        expect(handler).toBeTypeOf('function');

        await act(async () => {
            handler?.({
                actionIdentifier: 'session.permission.respond',
                data: {
                    sessionId: 'session-1',
                    serverId: 'server-1',
                    requestId: 'permission-1',
                    decision: 'allow',
                },
            });
            handler?.({
                actionIdentifier: 'session.user_action.answer',
                data: {
                    sessionId: 'session-1',
                    serverId: 'server-1',
                    requestId: 'question-1',
                    answers: [
                        {
                            question: 'Which deployment target?',
                            answer: 'Production',
                        },
                    ],
                },
            });
            handler?.({
                actionIdentifier: 'session.message.send',
                data: {
                    sessionId: 'session-1',
                    serverId: 'server-1',
                    message: 'Continue',
                },
            });
        });

        const permissionCall = actionExecutorExecuteMock.mock.calls.find(([actionId]) => actionId === 'session.permission.respond');
        expect(permissionCall?.[1]).toEqual(expect.objectContaining({
            sessionId: 'session-1',
            requestId: 'permission-1',
            decision: 'allow',
        }));
        expect(permissionCall?.[1]).not.toHaveProperty('serverId');
        expect(permissionCall?.[2]).toEqual(
            expect.objectContaining({
                surface: 'ui',
                defaultSessionId: 'session-1',
                serverId: 'server-1',
            }),
        );
        const userActionCall = actionExecutorExecuteMock.mock.calls.find(([actionId]) => actionId === 'session.user_action.answer');
        expect(userActionCall?.[1]).toEqual(expect.objectContaining({
            sessionId: 'session-1',
            requestId: 'question-1',
            answers: [
                {
                    question: 'Which deployment target?',
                    answer: 'Production',
                },
            ],
        }));
        expect(userActionCall?.[1]).not.toHaveProperty('serverId');
        expect(userActionCall?.[2]).toEqual(
            expect.objectContaining({
                surface: 'ui',
                defaultSessionId: 'session-1',
                serverId: 'server-1',
            }),
        );
        const quickReplyCall = actionExecutorExecuteMock.mock.calls.find(([actionId]) => actionId === 'session.message.send');
        expect(quickReplyCall?.[1]).toEqual(expect.objectContaining({
            sessionId: 'session-1',
            message: 'Continue',
        }));
        expect(quickReplyCall?.[1]).not.toHaveProperty('serverId');
        expect(quickReplyCall?.[2]).toEqual(
            expect.objectContaining({
                surface: 'ui',
                defaultSessionId: 'session-1',
                serverId: 'server-1',
            }),
        );
        expect(routerPushMock).not.toHaveBeenCalled();
        for (const actionId of ['session.permission.respond', 'session.user_action.answer', 'session.message.send']) {
            expect(actionExecutorExecuteMock.mock.calls.filter(([id]) => id === actionId)).toHaveLength(1);
        }
    });

    it('opens the session instead of executing a direct action when the payload lacks verified server scope', async () => {
        const { DesktopActivityOverlayRuntime } = await import('./DesktopActivityOverlayRuntime');
        await renderScreen(React.createElement(DesktopActivityOverlayRuntime));

        const handler = dispatchDesktopInteraction as
            | ((payload: { actionIdentifier: string; data?: Record<string, unknown> }) => void)
            | undefined;

        expect(handler).toBeTypeOf('function');

        await act(async () => {
            handler?.({
                actionIdentifier: 'session.message.send',
                data: {
                    sessionId: 'session-1',
                    message: 'Continue',
                },
            });
        });

        expect(actionExecutorExecuteMock).not.toHaveBeenCalled();
        expect(showDesktopMainWindowMock).toHaveBeenCalledTimes(1);
        expect(routerPushMock).toHaveBeenCalledWith('/session/session-1?serverId=server-1');
        expect(setDesktopActivityOverlayExpandedMock).not.toHaveBeenCalled();
    });

    it('does not open an unqualified session when two Homes use the same session id', async () => {
        // The real list runtime retires unselected Home membership. Admit both
        // Homes before seeding their retained rows and awaiting channel policy.
        await desktopHomes.selectHomes(['server-1', 'server-2']);
        const { startConcurrentSessionCacheSync } = await import('@/sync/runtime/orchestration/concurrentSessionCache');
        startConcurrentSessionCacheSync();
        await waitForHomeGovernance(() => expect(storage.getState().concurrentSessionListCacheByServerId['server-2']).toBeDefined());
        const { saveAccountSettings } = await import('@/sync/domains/state/accountSettingsPersistence');
        saveAccountSettings({ serverId: 'server-1', accountId: 'account-server-1' }, settingsParse({
            attentionDeliveryPolicyV1: { v: 1, channels: { desktop_overlay: { enabled: false } } },
        }), 2);
        const secondarySession = {
            ...sessionsState.value[0],
            serverId: 'server-2',
            metadata: {
                ...sessionsState.value[0]?.metadata as Record<string, unknown>,
                summary: { text: 'Secondary Home session', updatedAt: 2 },
            },
        };
        sessionsState.value = [secondarySession];
        concurrentSessionListCacheState.value = {};
        sessionListRowsState.value = {
            'server-1': {
                'session-1': {
                    ...secondarySession,
                    serverId: 'server-1',
                    metadata: {
                        ...secondarySession.metadata as Record<string, unknown>,
                        summary: { text: 'Primary Home session', updatedAt: 1 },
                    },
                },
            },
            'server-2': { 'session-1': secondarySession },
        };
        ordinarySessionListMembershipState.value = {
            'server-1': ['session-1'],
            'server-2': ['session-1'],
        };
        sessionListIndexState.value = {
            'server-1': [{ type: 'session', sessionId: 'session-1', serverId: 'server-1' }],
            'server-2': [{ type: 'session', sessionId: 'session-1', serverId: 'server-2' }],
        };

        const { DesktopActivityOverlayRuntime } = await import('./DesktopActivityOverlayRuntime');
        await renderScreen(React.createElement(DesktopActivityOverlayRuntime));

        await waitForHomeGovernance(() => expect(syncDesktopActivityOverlayMock.mock.calls.at(-1)?.[0]).toMatchObject({
            model: { expanded: { rows: [expect.objectContaining({ sessionId: 'session-1', serverId: 'server-2' })] } },
        }));
        const syncedModel = syncDesktopActivityOverlayMock.mock.calls.at(-1)?.[0] as {
            model?: { expanded?: { rows?: Array<{ sessionId: string; serverId: string | null }> } };
        } | undefined;
        // The first Home opted out of this channel, but its row remains in the
        // qualified source. An admitted snapshot is not proof that a bare id is
        // unique across the complete source used by the interaction boundary.
        expect(syncedModel?.model?.expanded?.rows).toEqual([
            expect.objectContaining({ sessionId: 'session-1', serverId: 'server-2' }),
        ]);

        const handler = dispatchDesktopInteraction as
            | ((payload: { actionIdentifier: string; data?: Record<string, unknown> }) => void)
            | undefined;
        expect(handler).toBeTypeOf('function');

        await act(async () => {
            handler?.({
                actionIdentifier: 'session.message.send',
                data: {
                    sessionId: 'session-1',
                    message: 'Continue',
                },
            });
        });

        expect(actionExecutorExecuteMock).not.toHaveBeenCalled();
        expect(showDesktopMainWindowMock).not.toHaveBeenCalled();
        expect(routerPushMock).not.toHaveBeenCalled();
    });

    it('does not preserve legacy permission notification action execution in the desktop overlay', async () => {
        const { DesktopActivityOverlayRuntime } = await import('./DesktopActivityOverlayRuntime');
        await renderScreen(React.createElement(DesktopActivityOverlayRuntime));

        const handler = dispatchDesktopInteraction as
            | ((payload: { actionIdentifier: string; data?: Record<string, unknown> }) => void)
            | undefined;

        expect(handler).toBeTypeOf('function');

        await act(async () => {
            handler?.({
                actionIdentifier: PUSH_NOTIFICATION_ACTION_IDS.permissionAllowV1,
                data: {
                    sessionId: 'session-1',
                    serverId: 'server-1',
                    requestId: 'permission-1',
                },
            });
        });

        expect(actionExecutorExecuteMock).not.toHaveBeenCalled();
    });

    it('answers an MCP Always allow through the request owner and reports a failed answer without a catalog write', async () => {
        rejectSessionActionRpc = true;
        const mcpTool = ResolvedMcpToolIdentityV1Schema.parse({ server: 'github', tool: 'edit_file',
            item: { serverId: 'github' }, serverTitle: 'GitHub',
            decision: { exposed: true, approval: 'ask', effectClass: 'unknown', source: 'server_default' } });
        sessionsState.value[0] = { ...sessionsState.value[0],
            metadata: { ...sessionsState.value[0]?.metadata as Record<string, unknown>, flavor: 'claude' },
            agentState: { requests: { 'permission-1': { tool: 'mcp__github__edit_file', kind: 'permission',
                arguments: {}, mcpTool, createdAt: Date.now() } } } };
        syncCanonicalSessionListState();
        const { DesktopActivityOverlayRuntime } = await import('./DesktopActivityOverlayRuntime');
        await renderScreen(<DesktopActivityOverlayRuntime />);
        await waitForHomeGovernance(() => expect(syncDesktopActivityOverlayMock.mock.calls.at(-1)?.[0]?.model.expanded.cards
            ?.find(card => card.kind === 'permission_request')?.actions?.some(action => action.id === 'mcp_always_allow')).toBe(true));
        await act(async () => dispatchDesktopInteraction({ requestId: 'mcp-click', actionIdentifier: 'overlay-mcp-always-allow',
            data: { sessionId: 'session-1', serverId: 'server-1', requestId: 'permission-1' } }));
        await waitForHomeGovernance(() => expect(emitDesktopActivityOverlayInteractionResultMock).toHaveBeenCalledWith({
            windowLabel: 'activity_overlay', requestId: 'mcp-click', ok: false,
            errorCode: 'permission_answer_failed', error: 'permission_answer_failed',
        }));
        expect(actionExecutorExecuteMock.mock.calls.filter(([id]) => id === 'mcp.servers.tools.set')).toHaveLength(0);
    });

    it('acknowledges downstream direct action failure back to the overlay request', async () => {
        rejectSessionActionRpc = true;
        const { DesktopActivityOverlayRuntime } = await import('./DesktopActivityOverlayRuntime');
        await renderScreen(React.createElement(DesktopActivityOverlayRuntime));

        const handler = dispatchDesktopInteraction as
            | ((payload: { requestId?: string; actionIdentifier: string; data?: Record<string, unknown> }) => void)
            | undefined;

        expect(handler).toBeTypeOf('function');

        await act(async () => {
            handler?.({
                requestId: 'permission-request-1',
                actionIdentifier: 'session.permission.respond',
                data: {
                    sessionId: 'session-1',
                    serverId: 'server-1',
                    requestId: 'permission-1', decision: 'allow',
                },
            });
            await Promise.resolve();
        });

        expect(actionExecutorExecuteMock).toHaveBeenCalledWith(
            'session.permission.respond',
            expect.objectContaining({
                sessionId: 'session-1',
                requestId: 'permission-1', decision: 'allow',
            }),
            expect.objectContaining({
                surface: 'ui',
                defaultSessionId: 'session-1',
                serverId: 'server-1',
            }),
        );
        expect(actionExecutorExecuteMock.mock.calls[0]?.[1]).not.toHaveProperty('serverId');
        await waitForHomeGovernance(() => expect(emitDesktopActivityOverlayInteractionResultMock).toHaveBeenCalledWith({
            windowLabel: 'activity_overlay',
            requestId: 'permission-request-1',
            ok: false,
            errorCode: expect.any(String),
            error: expect.any(String),
        }));
    });

    it('uses the canonical shared default target when the interaction has no explicit action identifier', async () => {
        localSettingsState.value = {
            ...localSettingsState.value,
            activitySurfaceTapTarget: 'open_sessions',
        };
        const { DesktopActivityOverlayRuntime } = await import('./DesktopActivityOverlayRuntime');
        await renderScreen(React.createElement(DesktopActivityOverlayRuntime));

        const handler = dispatchDesktopInteraction as
            | ((payload: { actionIdentifier: string; data?: Record<string, unknown> }) => void)
            | undefined;

        expect(handler).toBeTypeOf('function');

        await act(async () => {
            handler?.({
                actionIdentifier: ' ',
                data: {
                    primarySessionId: 'session-1',
                },
            });
        });

        expect(routerPushMock).toHaveBeenCalledWith('/inbox');
    });

    it('uses the latest shared tap target for overlay interactions after mount', async () => {
        const { DesktopActivityOverlayRuntime } = await import('./DesktopActivityOverlayRuntime');
        const screen = await renderScreen(React.createElement(DesktopActivityOverlayRuntime));

        expect(listenDesktopActivityOverlayInteractionMock).toHaveBeenCalled();

        localSettingsState.value = {
            ...localSettingsState.value,
            activitySurfaceTapTarget: 'open_sessions',
        };

        await act(async () => {
            await screen.update(React.createElement(DesktopActivityOverlayRuntime));
        });

        const handler = dispatchDesktopInteraction as
            | ((payload: { actionIdentifier: string; data?: Record<string, unknown> }) => void)
            | undefined;

        expect(handler).toBeTypeOf('function');

        await act(async () => {
            handler?.({
                actionIdentifier: ' ',
                data: {
                    primarySessionId: 'session-1',
                },
            });
        });

        expect(routerPushMock).toHaveBeenCalledWith('/inbox');
    });

    it('validates direct actions against the latest selected session server scope after mount', async () => {
        const { DesktopActivityOverlayRuntime } = await import('./DesktopActivityOverlayRuntime');
        const screen = await renderScreen(React.createElement(DesktopActivityOverlayRuntime));
        const now = Date.now();

        sessionsState.value = [
            {
                id: 'session-1',
                serverId: 'server-2',
                createdAt: 1,
                updatedAt: now,
                seq: 5,
                lastViewedSessionSeq: 2,
                active: true,
                activeAt: now - 50,
                archivedAt: null,
                presence: 'online',
                thinking: false,
                thinkingAt: null,
                latestTurnStatus: null,
                latestTurnStatusObservedAt: null,
                meaningfulActivityAt: now,
                lastRuntimeIssue: null,
                lastTurnCompletedAt: null,
                pendingVersion: 1,
                pendingCount: 1,
                pendingPermissionRequestCount: 1,
                pendingUserActionRequestCount: 0,
                pendingRequestObservedAt: now - 50,
                agentStateVersion: 1,
                agentState: {
                    controlledByUser: null,
                    requests: {
                        'permission-1': {
                            tool: 'Bash',
                            kind: 'permission',
                            arguments: {},
                            createdAt: now - 50,
                        },
                    },
                },
                metadata: {
                    summary: { text: 'Primary session', updatedAt: 2 },
                    path: '/Users/tester/project',
                    host: 'tester.local',
                    homeDir: '/Users/tester',
                },
            },
        ];
        syncCanonicalSessionListState();
        sessionListIndexState.value = {
            'server-2': [
                {
                    type: 'session',
                    sessionId: 'session-1',
                    serverId: 'server-2',
                },
            ],
        };

        await act(async () => {
            await screen.update(React.createElement(DesktopActivityOverlayRuntime));
        });

        const handler = dispatchDesktopInteraction as
            | ((payload: { requestId?: string; actionIdentifier: string; data?: Record<string, unknown> }) => void)
            | undefined;

        expect(handler).toBeTypeOf('function');

        await act(async () => {
            handler?.({
                requestId: 'quick-reply-request-2',
                actionIdentifier: 'session.message.send',
                data: {
                    sessionId: 'session-1',
                    serverId: 'server-2',
                    message: 'Continue',
                },
            });
            await Promise.resolve();
        });

        expect(actionExecutorExecuteMock).toHaveBeenCalledWith(
            'session.message.send',
            expect.objectContaining({
                sessionId: 'session-1',
                message: 'Continue',
            }),
            expect.objectContaining({
                surface: 'ui',
                defaultSessionId: 'session-1',
                serverId: 'server-2',
            }),
        );
        expect(actionExecutorExecuteMock.mock.calls[0]?.[1]).not.toHaveProperty('serverId');
        expect(routerPushMock).not.toHaveBeenCalled();
    });

    it('uses presentation interactions only to acquire and release detail demand', async () => {
        const { DesktopActivityOverlayRuntime } = await import('./DesktopActivityOverlayRuntime');
        await renderScreen(React.createElement(DesktopActivityOverlayRuntime));
        const handler = dispatchDesktopInteraction;
        expect(handler).toBeTypeOf('function');
        let detailReads = 0;
        const makeMessages = (): StorageState['sessionMessages'] => Object.defineProperty({}, 'session-1', {
            enumerable: true, get: () => { detailReads++; return undefined; },
        });
        await act(async () => { storage.setState({ sessionMessages: makeMessages() }); });
        expect(detailReads).toBe(0);
        syncDesktopActivityOverlayMock.mockClear();

        await act(async () => {
            handler?.({ actionIdentifier: 'overlay-set-expanded', data: { expanded: true, serverId: 'server-1', sessionId: 'session-1' } });
        });
        expect(detailReads).toBeGreaterThan(0);
        await act(async () => {
            handler?.({ actionIdentifier: 'overlay-set-expanded', data: { expanded: false, target: null } });
        });

        detailReads = 0;
        syncDesktopActivityOverlayMock.mockClear();
        await act(async () => { storage.setState({ sessionMessages: makeMessages() }); });
        expect(detailReads).toBe(0);
        expect(syncDesktopActivityOverlayMock).not.toHaveBeenCalled();
        expect(setDesktopActivityOverlayExpandedMock).not.toHaveBeenCalled();
        for (const [payload] of syncDesktopActivityOverlayMock.mock.calls) {
            expect(payload).not.toHaveProperty('expanded');
            expect(payload).not.toHaveProperty('window');
            expect(payload).not.toHaveProperty('model.isExpanded');
        }
    });

    it('opens the session instead of executing a direct action when the payload carries an unsafe server URL', async () => {
        const { DesktopActivityOverlayRuntime } = await import('./DesktopActivityOverlayRuntime');
        await renderScreen(React.createElement(DesktopActivityOverlayRuntime));

        const handler = dispatchDesktopInteraction as
            | ((payload: { actionIdentifier: string; data?: Record<string, unknown> }) => void)
            | undefined;

        expect(handler).toBeTypeOf('function');

        await act(async () => {
            handler?.({
                actionIdentifier: 'session.message.send',
                data: {
                    sessionId: 'session-1',
                    serverUrl: 'http://localhost:3000',
                    message: 'Continue',
                },
            });
        });

        expect(actionExecutorExecuteMock).not.toHaveBeenCalled();
        expect(showDesktopMainWindowMock).toHaveBeenCalledTimes(1);
        expect(routerPushMock).toHaveBeenCalledWith('/session/session-1?serverId=server-1');
        expect(setDesktopActivityOverlayExpandedMock).not.toHaveBeenCalled();
    });

    it('disposes a late-resolving interaction listener when runtime unmounts before subscription resolves', async () => {
        let resolveSubscription: (dispose: () => void) => void = () => {
            throw new Error('Expected deferred interaction subscription to capture its resolver.');
        };
        let capturedResolver = false;
        const deferredSubscription = new Promise<() => void>((resolve) => {
            resolveSubscription = resolve;
            capturedResolver = true;
        });
        const disposeMock = vi.fn();
        listenDesktopActivityOverlayInteractionMock.mockImplementation(
            () => deferredSubscription,
        );

        const { DesktopActivityOverlayRuntime } = await import('./DesktopActivityOverlayRuntime');
        const rendered = await renderScreen(React.createElement(DesktopActivityOverlayRuntime));

        await act(async () => {
            rendered.tree.unmount();
        });

        if (!capturedResolver) {
            throw new Error('Expected deferred interaction subscription to capture its resolver.');
        }

        resolveSubscription(disposeMock);

        await act(async () => {
            await Promise.resolve();
        });

        expect(disposeMock).toHaveBeenCalledTimes(listenDesktopActivityOverlayInteractionMock.mock.calls.length);
    });
});
