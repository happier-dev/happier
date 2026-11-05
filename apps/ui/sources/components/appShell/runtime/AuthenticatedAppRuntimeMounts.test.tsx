import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import type { Socket } from 'socket.io-client';

import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';
import { RPC_ERROR_CODES, RPC_METHODS } from '@happier-dev/protocol/rpc';
import {
    currentUiContextReadClientRpcMethod,
    UiActionDispatchRequestV1Schema,
    UiActionDispatchResultV1Schema,
} from '@happier-dev/protocol/actions/clientDispatchV1';
import { CurrentUiContextSnapshotV1Schema } from '@happier-dev/protocol/plugins/ui';
import { SystemTaskResultSchema, SystemTaskSpecSchema, type SystemTaskSpec } from '@happier-dev/protocol/system/tasks/spec';
import { socketRpcCodec } from '@happier-dev/sync-client';

const host = vi.hoisted(() => ({ platform: 'web', desktop: false, electron: false, windowLabel: 'main', responderWindowId: 'main' as string | null }));
const nativeListeners = vi.hoisted(() => new Map<string, Set<(event: unknown) => void>>());

vi.mock('socket.io-client', async importOriginal =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));
vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock({
    Platform: {
        get OS() { return host.platform; },
        select: (options: Record<string, unknown>) => options[host.platform] ?? options.default,
    },
    useWindowDimensions: () => ({ width: 1280, height: 900, scale: 1, fontScale: 1 }),
}));
vi.mock('react-native-unistyles', async () =>
    (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
// The host renderer has no DOM; preserve app mounts behind the shared Radix boundary.
vi.mock('@/utils/web/radixCjs', async () =>
    (await import('@/dev/testkit/mocks/radixCjs')).createRadixCjsModuleMock());
vi.mock('@expo/vector-icons', async () =>
    (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock());
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock());
vi.mock('expo-router', async () =>
    (await import('@/dev/testkit/mocks/router')).createExpoRouterMock({ pathname: '/', segments: [] }).module);
vi.mock('@react-navigation/native', async () =>
    (await import('@/dev/testkit/mocks/reactNavigation')).createReactNavigationNativeMock());
vi.mock('expo-file-system', async () =>
    (await import('@/dev/testkit/mocks/expoFileSystem')).createExpoFileSystemFileMock().module);
vi.mock('expo-widgets', () => ({
    addUserInteractionListener: vi.fn(() => ({ remove: vi.fn() })),
}));
vi.mock('@react-native-masked-view/masked-view', () => ({ default: 'MaskedView', MaskedView: 'MaskedView' }));
vi.mock('react-native-view-shot', () => ({
    default: 'ViewShot', ViewShot: 'ViewShot', captureRef: vi.fn(async () => ''), releaseCapture: vi.fn(),
}));
vi.mock('expo-video', () => ({ Video: 'Video', VideoView: 'VideoView', useVideoPlayer: () => null }));
vi.mock('expo-blur', () => ({ BlurView: 'BlurView' }));

type HomeHarness = ReturnType<typeof import('@/dev/testkit/harness/homeGovernanceHarness').createHomeGovernanceHarness>;
type AccountConnection = Awaited<ReturnType<typeof import('@/dev/testkit/harness/serverAccountConnectionHarness').restoreServerAccountForTest>>;
type RuntimeProps = Readonly<{ isAuthenticated: boolean; isDesktopShell: boolean; children?: React.ReactNode }>;
type NativeDaemonStatus = import('@/components/settings/machines/localControl/useLocalDaemonControl').LocalDaemonStatusData;

let homes: HomeHarness;
let connection: AccountConnection | undefined;
let syncBridge: Awaited<ReturnType<typeof import('@/dev/testkit/harness/syncSingletonLoader').loadSyncSingletonForTests>>;
let secureStorage: ReturnType<typeof import('@/dev/testkit/mocks/desktopSecureStorage').createDesktopSecureStorageBoundary>;
let owners: Awaited<ReturnType<typeof loadOwners>>;
let homeId = '';
const sockets: Socket[] = [];
const emissions: Array<Readonly<{ event: string; payload: unknown }>> = [];
const nativeCalls: Array<Readonly<{ command: string; args?: Record<string, unknown> }>> = [];
const nativeTasks = new Map<string, SystemTaskSpec>();
const nativeEventHandles = new Map<number, Readonly<{ event: string; handler: (event: unknown) => void }>>();
let nativeStatus: NativeDaemonStatus;
let homeUrl = 'https://runtime.example.test';
const accountId = 'account-runtime';

// Prepare the real graph once, after its external boundaries. Cold transforms
// belong to suite collection, not each fixture's existing setup deadline.
vi.stubGlobal('indexedDB', new IDBFactory());
vi.stubGlobal('__TAURI_INTERNALS__', { get invoke() { return host.desktop ? invokeNative : undefined; } });
vi.stubEnv('EXPO_PUBLIC_SYSTEM_TASKS_RUNNER_MODE', 'tauri');
const bootstrapHomes = await import('@/dev/testkit/harness/homeGovernanceHarness');
bootstrapHomes.installHomeGovernanceBoundaries(bootstrapHomes.createHomeGovernanceHarness());
await (await import('@/dev/testkit/harness/syncSingletonLoader')).loadSyncSingletonForTests();
await loadOwners();

async function invokeNative(command: string, args?: Record<string, unknown>): Promise<unknown> {
    nativeCalls.push({ command, args });
    if (command === 'plugin:event|listen') {
        const id = Number(args?.handler);
        const internals = (globalThis as unknown as { __TAURI_INTERNALS__: {
            callbacks: Map<number, (event: unknown) => void>;
        } }).__TAURI_INTERNALS__;
        const handler = internals.callbacks.get(id);
        if (!handler) throw new Error('Missing native callback');
        const event = String(args?.event);
        const listeners = nativeListeners.get(event) ?? new Set();
        nativeListeners.set(event, listeners);
        listeners.add(handler);
        nativeEventHandles.set(id, { event, handler });
        return id;
    }
    if (command === 'plugin:event|unlisten') {
        const id = Number(args?.eventId);
        const registration = nativeEventHandles.get(id);
        if (registration) nativeListeners.get(registration.event)?.delete(registration.handler);
        nativeEventHandles.delete(id);
        return null;
    }
    if (command === 'desktop_app_window_surfaces') return [];
    if (command === 'desktop_notification_list') return [];
    if (command === 'desktop_host_get_availability') return {
        activity: { kind: 'available' }, pet: { kind: 'available' }, windows: { kind: 'available' },
    };
    // Electron's native command boundary has no multiwindow responder command.
    if (command === 'desktop_app_window_responders' && host.electron) throw new Error('not_implemented: desktop_app_window_responders');
    if (command === 'desktop_app_window_responders') return host.responderWindowId === null ? []
        : [{ homeId: connection?.serverId ?? homeId, accountId, windowId: host.responderWindowId }];
    if (command === 'desktop_secure_storage_read' || command === 'desktop_secure_storage_write'
        || command === 'desktop_secure_storage_remove') return await secureStorage.invoke(command, args);
    if (command === 'start_system_task') {
        const spec = SystemTaskSpecSchema.parse(JSON.parse(String(args?.specJson)));
        const taskId = 'runtime-task-' + nativeTasks.size;
        nativeTasks.set(taskId, spec);
        return { taskId };
    }
    if (command === 'get_system_task_snapshot') {
        const taskId = String(args?.taskId);
        const spec = nativeTasks.get(taskId);
        if (!spec) throw new Error('Unknown native test task');
        return { events: [], result: SystemTaskResultSchema.parse({
            protocolVersion: 1, taskId, ok: true,
            data: spec.kind === 'daemon.service.status.v1' ? nativeStatus : {},
        }) };
    }
    // Other consumers use the same native command port for badge/overlay publication.
    return null;
}

beforeEach(async () => {
    host.platform = 'web';
    host.desktop = false;
    host.electron = false;
    host.windowLabel = 'main';
    host.responderWindowId = 'main';
    homeUrl = 'https://runtime.example.test';
    sockets.length = 0;
    emissions.length = 0;
    nativeCalls.length = 0;
    nativeTasks.clear();
    nativeListeners.clear();
    nativeEventHandles.clear();
    nativeStatus = { serviceInstalled: true, daemonRunning: true, needsAuth: false, machineId: null,
        daemonComparableKey: homeUrl, daemonAccountId: accountId, daemonMachineRegistered: true };
    secureStorage = (await import('@/dev/testkit/mocks/desktopSecureStorage')).createDesktopSecureStorageBoundary();
    vi.stubGlobal('indexedDB', new IDBFactory());
    vi.stubGlobal('__TAURI_INTERNALS__', { metadata: { currentWindow: { get label() { return host.windowLabel; } } },
        get invoke() { return host.desktop ? invokeNative : undefined; } });
    vi.stubEnv('EXPO_PUBLIC_SYSTEM_TASKS_RUNNER_MODE', 'tauri');
    // Remote release-note assets are an independent external HTTP boundary.
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 404 })));
    const { createHomeGovernanceHarness, installHomeGovernanceBoundaries } = await import('@/dev/testkit/harness/homeGovernanceHarness');
    const { installDisconnectedServerSocketBoundary } = await import('@/dev/testkit/harness/serverAccountConnectionHarness');
    homes = createHomeGovernanceHarness();
    installHomeGovernanceBoundaries(homes);
    installDisconnectedServerSocketBoundary();
    syncBridge = await (await import('@/dev/testkit/harness/syncSingletonLoader')).loadSyncSingletonForTests();
    homeId = await homes.addHome({ name: 'Runtime Home', serverUrl: homeUrl,
        serverIdentityId: 'srv_authenticated_runtime', accountId });
    homes.answer(homeId, '/v1/kv/bulk', { body: { values: [] } });
    homes.answer(homeId, '/v1/account/activity/badge-snapshot', { body: { badgeCount: 0 } });
});

afterEach(async () => {
    (await import('@/dev/testkit')).standardCleanup();
    await connection?.dispose();
    connection = undefined;
    await homes?.reset();
    syncBridge?.dispose();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.resetModules();
});

async function loadOwners() {
    const [runtime, auth, pane, tabs, currentUi, actionHost, attention, onboarding, release, desktop, ios, badge, notifications, commands] = await Promise.all([
        import('./AuthenticatedAppRuntimeMounts'),
        import('@/auth/context/AuthContext'),
        import('@/components/appShell/providers/AppPaneModalProvider'),
        import('@/components/navigation/mobile/chrome/MainAppTabStateProvider'),
        import('@/components/appShell/currentUiContext/CurrentUiContextProvider'),
        import('@/components/appShell/currentUiContext/currentUiContextVoiceToolPort'),
        import('@/activity/attention/runtime/SessionAttentionReminderRuntime'),
        import('@/onboarding/showcase'),
        import('@/changelog/releaseNotes'),
        import('@/activity/adapters/desktop/runtime/DesktopActivityOverlayRuntime'),
        import('@/activity/adapters/ios/runtime/ActivitySurfacesRuntime'),
        import('@/activity/badges/ActivityBadgeRuntime'),
        import('@/activity/notifications/runtime/ActivityLocalNotificationRuntime'),
        import('@/components/appShell/currentUiContext/CurrentUiContextCommands'),
    ]);
    return { AuthenticatedAppRuntimeMounts: runtime.AuthenticatedAppRuntimeMounts,
        InjectedAuthProvider: auth.InjectedAuthProvider, AppPaneModalProvider: pane.AppPaneModalProvider,
        MainAppTabStateProvider: tabs.MainAppTabStateProvider, CurrentUiContextProvider: currentUi.CurrentUiContextProvider,
        CurrentUiContextActionHost: actionHost.CurrentUiContextActionHost,
        useCurrentUiContextLocalCommands: commands.useCurrentUiContextLocalCommands,
        SessionAttentionReminderRuntime: attention.SessionAttentionReminderRuntime,
        OnboardingShowcaseAutoShowMount: onboarding.OnboardingShowcaseAutoShowMount,
        ReleaseNotesAutoShowMount: release.ReleaseNotesAutoShowMount,
        DesktopActivityOverlayRuntime: desktop.DesktopActivityOverlayRuntime,
        ActivitySurfacesRuntime: ios.ActivitySurfacesRuntime,
        ActivityBadgeRuntime: badge.ActivityBadgeRuntime,
        ActivityLocalNotificationRuntime: notifications.ActivityLocalNotificationRuntime };
}

// React Test Renderer exposes a simple memo's rendered function as its component type.
function renderedType(component: unknown): React.ElementType {
    return (typeof component === 'object' && component !== null && 'type' in component
        ? component.type : component) as React.ElementType;
}

function RuntimeComposition(props: RuntimeProps): React.ReactElement {
    return <owners.InjectedAuthProvider credentials={props.isAuthenticated ? connection!.credentials : null}>
        <owners.AppPaneModalProvider>
            <owners.MainAppTabStateProvider>
                <owners.CurrentUiContextProvider>
                    <owners.CurrentUiContextActionHost />
                    <owners.AuthenticatedAppRuntimeMounts {...props} />
                    {props.children}
                </owners.CurrentUiContextProvider>
            </owners.MainAppTabStateProvider>
        </owners.AppPaneModalProvider>
    </owners.InjectedAuthProvider>;
}

async function mount(props: RuntimeProps, machineIds: readonly string[] = [], serverIdentityId = 'srv_authenticated_runtime') {
    if (host.desktop) {
        // The sync singleton can load the real SDK outside Vitest's module graph.
        // Model its actual native IPC/callback boundary so both import paths agree.
        if (typeof window === 'undefined') vi.stubGlobal('window', {
            location: new URL('https://runtime.example.test/'),
            addEventListener() {}, removeEventListener() {},
        });
        Object.assign(window, { crypto: globalThis.crypto });
        const { mockIPC } = await import('@tauri-apps/api/mocks');
        // These renderer commands use named IPC arguments, never binary payloads.
        mockIPC((command, args) => invokeNative(command, args as Record<string, unknown> | undefined));
        const nativeWindow = window as unknown as { __TAURI_INTERNALS__: {
            metadata?: { currentWindow: { readonly label: string } };
        } };
        nativeWindow.__TAURI_INTERNALS__.metadata = { currentWindow: { get label() { return host.windowLabel; } } };
        vi.stubGlobal('__TAURI_INTERNALS__', nativeWindow.__TAURI_INTERNALS__);
    }
    const { createPlainMachineRowFixture } = await import('@/dev/testkit/fixtures/machineFixtures');
    const machines = machineIds.map(id => createPlainMachineRowFixture({ id, accountId }));
    homes.answer(homeId, '/v1/machines', { body: machines });
    const { configureConnectedServerSocketBoundary, restoreServerAccountForTest } = await import('@/dev/testkit/harness/serverAccountConnectionHarness');
    connection = await restoreServerAccountForTest({ serverUrl: homeUrl,
        serverIdentityId, accountId, request: homes.request,
        configureSocket: socket => {
            sockets.push(socket);
            configureConnectedServerSocketBoundary(socket);
            const emit = socket.emit.bind(socket);
            socket.emit = vi.fn<typeof socket.emit>((event, ...args) => {
                emissions.push({ event, payload: args[0] });
                return emit(event, ...args);
            });
            socket.emitWithAck = vi.fn<typeof socket.emitWithAck>(async event => event === SOCKET_RPC_EVENTS.CALL
                ? { ok: false, error: 'Method not available in native fixture', errorCode: RPC_ERROR_CODES.METHOD_NOT_FOUND }
                : { v: 1, ok: true, admittedSessionIds: [] });
        },
    });
    const { waitForHomeGovernance } = await import('@/dev/testkit/harness/homeGovernanceHarness');
    const { storage } = await import('@/sync/domains/state/storage');
    await waitForHomeGovernance(() => {
        expect(storage.getState().profile?.id).toBe(accountId);
        for (const machineId of machineIds) {
            expect(storage.getState().machines[machineId]).toMatchObject({
                storageMode: 'plain', availability: { kind: 'available' },
                access: { resourceMode: 'plain', accessState: 'ready' },
            });
        }
    });
    owners = await loadOwners();
    const screen = await (await import('@/dev/testkit')).renderScreen(<RuntimeComposition {...props} />);
    return screen;
}

function emittedMethods(event: string): string[] {
    return emissions.filter(emission => emission.event === event).flatMap(({ payload }) =>
        payload && typeof payload === 'object' && 'method' in payload && typeof payload.method === 'string'
            ? [payload.method] : []);
}

async function waitForDaemonStatus() {
    const { getSystemTasksRunner } = await import('@/components/systemTasks/systemTasksRuntime');
    const { readLocalDaemonSharedState } = await import('@/components/settings/machines/localControl/localDaemonSharedState');
    const { waitForHomeGovernance } = await import('@/dev/testkit/harness/homeGovernanceHarness');
    const { flushHookEffects } = await import('@/dev/testkit');
    await waitForHomeGovernance(async () => {
        await flushHookEffects();
        expect([...nativeTasks.values()].map(spec => spec.kind)).toContain('daemon.service.status.v1');
    });
    for (const [taskId, spec] of nativeTasks) {
        if (spec.kind === 'daemon.service.status.v1') {
            expect(getSystemTasksRunner().getSnapshot(taskId)?.result?.ok).not.toBe(false);
        }
    }
    await waitForHomeGovernance(async () => {
        // Native subscription/snapshot promises settle after the initial render's act.
        // Commit the real hook's status projection before reading its dependent RPC registration.
        await flushHookEffects();
        expect(readLocalDaemonSharedState(getSystemTasksRunner()).status).toMatchObject(nativeStatus);
    });
}

describe('AuthenticatedAppRuntimeMounts', () => {
    it('reconciles the full secondary route locally without acquiring primary native ingress', async () => {
        host.desktop = true;
        const location = new URL('https://runtime.example.test/desktop/app-window');
        vi.stubGlobal('window', { location, addEventListener() {}, removeEventListener() {} });
        (await import('@/desktop/window/isDesktopAuxiliaryWindowContext')).resolveDesktopWindowContext();
        location.pathname = '/session/secondary/info';
        const { RootLayoutNavigationEffects } = await import('@/components/navigation/root/RootLayoutNavigationEffects');
        const { router } = await import('expo-router');
        const screen = await mount({ isAuthenticated: true, isDesktopShell: true,
            children: <RootLayoutNavigationEffects /> });
        await vi.waitFor(() => expect(router.replace).toHaveBeenCalledWith('/session/secondary/info'));
        expect(nativeCalls.some(call => call.command === 'desktop_set_window_mode')).toBe(false);
        expect(nativeListeners.has('deep-link://new-url')).toBe(false);
        await screen.unmount();
    });

    it('adds no app-wide native producers when a secondary full realm mounts and disposes its local handlers', async () => {
        host.desktop = true;
        host.windowLabel = 'destination_secondary';
        vi.stubGlobal('window', { location: { href: 'https://runtime.example.test/desktop/app-window' },
            addEventListener() {}, removeEventListener() {} });
        const screen = await mount({ isAuthenticated: true, isDesktopShell: true }, ['machine-secondary']);
        const { storage } = await import('@/sync/domains/state/storage');
        await act(async () => {
            storage.setState(state => ({ localSettings: { ...state.localSettings, desktopOverlayEnabled: true } }));
        });
        const { flushHookEffects } = await import('@/dev/testkit');
        await flushHookEffects();
        expect(nativeCalls.filter(call => call.command === 'desktop_activity_overlay_sync')).toHaveLength(0);
        expect([...nativeTasks.values()]).toHaveLength(0);
        expect(emittedMethods(SOCKET_RPC_EVENTS.REGISTER)).toEqual([]);
        await screen.unmount();
        expect([...nativeListeners.values()].every(listeners => listeners.size === 0)).toBe(true);
    });

    it('mounts first-open onboarding before auth while keeping release notes authenticated-only', async () => {
        const screen = await mount({ isAuthenticated: false, isDesktopShell: false });
        expect(screen.findAllByType(owners.OnboardingShowcaseAutoShowMount)).toHaveLength(1);
        expect(screen.findAllByType(owners.ReleaseNotesAutoShowMount)).toHaveLength(0);
    });

    it('keeps runtime mount components stable across equivalent parent updates', async () => {
        const screen = await mount({ isAuthenticated: true, isDesktopShell: false });
        const retainedTypes = [owners.ActivityBadgeRuntime, owners.SessionAttentionReminderRuntime,
            owners.ActivityLocalNotificationRuntime, owners.OnboardingShowcaseAutoShowMount, owners.ReleaseNotesAutoShowMount];
        const retained = retainedTypes.map(type => screen.findByType(renderedType(type)));
        await screen.update(<RuntimeComposition isAuthenticated isDesktopShell={false} />);
        retainedTypes.forEach((type, index) =>
            expect(screen.findByType(renderedType(type))).toBe(retained[index]));
    });

    it('mounts desktop runtime components only for Tauri desktop hosts', async () => {
        host.desktop = true;
        const screen = await mount({ isAuthenticated: true, isDesktopShell: false });
        expect(screen.findAllByType(owners.DesktopActivityOverlayRuntime)).toHaveLength(0);
        const { getDesktopHostAvailability } = await import('@/utils/platform/desktopHost');
        expect((await getDesktopHostAvailability()).activity).toEqual({ kind: 'available' });
        const { storage } = await import('@/sync/domains/state/storage');
        await act(async () => {
            storage.setState(state => ({ localSettings: { ...state.localSettings, desktopOverlayEnabled: true } }));
        });
        expect(storage.getState().localSettings.desktopOverlayEnabled).toBe(true);
        await screen.update(<RuntimeComposition isAuthenticated isDesktopShell />);
        expect(screen.findAllByType(owners.DesktopActivityOverlayRuntime)).toHaveLength(1);
        const { waitForHomeGovernance } = await import('@/dev/testkit/harness/homeGovernanceHarness');
        await waitForHomeGovernance(() =>
            expect(nativeCalls.some(call => call.command === 'desktop_activity_overlay_sync')).toBe(true));
    });

    it('installs browser recording reverse capture from the authenticated desktop runtime', async () => {
        host.desktop = true;
        const machineId = 'machine-desktop-recording';
        nativeStatus = { ...nativeStatus, machineId };
        const screen = await mount({ isAuthenticated: true, isDesktopShell: true }, [machineId]);
        await waitForDaemonStatus();
        const method = machineId + ':' + RPC_METHODS.UI_BROWSER_RECORDING_CAPTURE_FRAME;
        const { waitForHomeGovernance } = await import('@/dev/testkit/harness/homeGovernanceHarness');
        await waitForHomeGovernance(() => expect(emittedMethods(SOCKET_RPC_EVENTS.REGISTER)).toContain(method));
        await screen.update(<RuntimeComposition isAuthenticated={false} isDesktopShell />);
        expect(emittedMethods(SOCKET_RPC_EVENTS.UNREGISTER)).toContain(method);
    });

    it('installs browser recording reverse capture only for the verified local desktop daemon machine', async () => {
        host.desktop = true;
        const localMachine = 'machine-local-desktop-recording';
        const remoteMachine = 'machine-remote-desktop-recording';
        nativeStatus = { ...nativeStatus, machineId: localMachine };
        await mount({ isAuthenticated: true, isDesktopShell: true }, [localMachine, remoteMachine]);
        await waitForDaemonStatus();
        const { waitForHomeGovernance } = await import('@/dev/testkit/harness/homeGovernanceHarness');
        await waitForHomeGovernance(() => expect(emittedMethods(SOCKET_RPC_EVENTS.REGISTER))
            .toContain(localMachine + ':' + RPC_METHODS.UI_BROWSER_RECORDING_CAPTURE_FRAME));
        expect(emittedMethods(SOCKET_RPC_EVENTS.REGISTER))
            .not.toContain(remoteMachine + ':' + RPC_METHODS.UI_BROWSER_RECORDING_CAPTURE_FRAME);
    });

    it('does not install browser recording reverse capture when local daemon identity is not verified for the active server', async () => {
        host.desktop = true;
        const machineId = 'machine-local-desktop-recording';
        nativeStatus = { ...nativeStatus, machineId, daemonComparableKey: 'https://other-relay.example.test' };
        await mount({ isAuthenticated: true, isDesktopShell: true }, [machineId]);
        await waitForDaemonStatus();
        expect(emittedMethods(SOCKET_RPC_EVENTS.REGISTER))
            .not.toContain(machineId + ':' + RPC_METHODS.UI_BROWSER_RECORDING_CAPTURE_FRAME);
    });

    it('does not mount the iOS activity surface runtime on Android', async () => {
        host.platform = 'android';
        const screen = await mount({ isAuthenticated: true, isDesktopShell: false });
        expect(screen.findAllByType(owners.ActivitySurfacesRuntime)).toHaveLength(0);
    });

    it.each(['browser', 'secondary full', 'electron'] as const)('serves current UI context through the %s Home responder and retires it when authentication ends', async realm => {
        if (realm === 'electron') {
            host.desktop = true;
            host.electron = true;
            vi.stubGlobal('navigator', { userAgent: 'Happier Electron/43.4.0', locks: navigator.locks });
        }
        if (realm === 'secondary full') {
            host.desktop = true;
            host.windowLabel = 'destination_responder';
            host.responderWindowId = 'responder';
            vi.stubGlobal('window', { location: { href: 'https://runtime.example.test/desktop/app-window' },
                addEventListener() {}, removeEventListener() {} });
        }
        const machineId = 'machine-current-ui';
        const method = machineId + ':' + currentUiContextReadClientRpcMethod();
        const isDesktopShell = realm === 'electron';
        const screen = await mount({ isAuthenticated: false, isDesktopShell }, [machineId]);
        expect(emittedMethods(SOCKET_RPC_EVENTS.REGISTER)).not.toContain(method);
        await screen.update(<RuntimeComposition isAuthenticated isDesktopShell={isDesktopShell} />);
        const { waitForHomeGovernance } = await import('@/dev/testkit/harness/homeGovernanceHarness');
        if (realm === 'electron') {
            const { UpdateFactsBackgroundRuntime } = await import('@/updates/UpdateFactsBackgroundRuntime');
            const { DesktopBrowserRecordingReverseCaptureRuntime } = await import('@/sync/domains/browser/recording/DesktopBrowserRecordingReverseCaptureRuntime');
            expect(screen.findAllByType(UpdateFactsBackgroundRuntime)).toHaveLength(1);
            expect(screen.findAllByType(DesktopBrowserRecordingReverseCaptureRuntime)).toHaveLength(1);
            expect(nativeCalls.some(call => call.command === 'desktop_app_window_responders')).toBe(false);
        }
        await waitForHomeGovernance(() => expect(emittedMethods(SOCKET_RPC_EVENTS.REGISTER)).toContain(method));
        const socket = sockets.find(candidate => candidate.listeners(SOCKET_RPC_EVENTS.REQUEST).length > 0);
        const receive = socket?.listeners(SOCKET_RPC_EVENTS.REQUEST)[0];
        if (!socket || !receive) throw new Error('The restored Account has no inbound Socket SDK listener');
        const request = UiActionDispatchRequestV1Schema.parse({ v: 1, actionId: 'ui.current_context.read',
            input: {}, context: { surface: 'ui', authority: 'account_automation' } });
        const callId = '0123456789abcdef0123456789abcdef';
        const params = await socketRpcCodec.encodeParams({ mode: 'plain' }, request, { method, callId });
        const invoke = async () => {
            const ack = await new Promise<unknown>(resolve => { receive({ method, params }, resolve); });
            return await socketRpcCodec.decodeResult({ mode: 'plain' }, { ok: true, result: ack }, callId);
        };
        const result = UiActionDispatchResultV1Schema.parse(await invoke());
        expect(result.execution.ok).toBe(true);
        if (!result.execution.ok) throw new Error('The real reverse Action did not execute');
        const snapshot = CurrentUiContextSnapshotV1Schema.parse(result.execution.result);
        expect(snapshot.navigation).toEqual({ area: 'app', screen: 'tab.sessions', presentation: 'screen' });
        if (realm === 'secondary full') {
            await act(async () => {
                for (const listener of nativeListeners.get('desktopAppWindow://responders') ?? []) listener({ payload: [] });
            });
            expect(await invoke()).toMatchObject({ errorCode: RPC_ERROR_CODES.METHOD_NOT_FOUND });
            await act(async () => {
                for (const listener of nativeListeners.get('desktopAppWindow://responders') ?? []) {
                    listener({ payload: [{ homeId: connection!.serverId, accountId, windowId: 'responder' }] });
                }
            });
            await waitForHomeGovernance(() => expect(emittedMethods(SOCKET_RPC_EVENTS.REGISTER).filter(candidate => candidate === method)).toHaveLength(2));
            expect(UiActionDispatchResultV1Schema.parse(await invoke()).execution.ok).toBe(true);
        }
        await screen.update(<RuntimeComposition isAuthenticated={false} isDesktopShell={isDesktopShell} />);
        expect(socket.connected).toBe(true);
        expect(emittedMethods(SOCKET_RPC_EVENTS.UNREGISTER)).toContain(method);
        expect(await invoke()).toMatchObject({ errorCode: RPC_ERROR_CODES.METHOD_NOT_FOUND });
    });
});
