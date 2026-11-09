import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { PUSH_NOTIFICATION_ANDROID_CHANNEL_IDS } from '@happier-dev/protocol/push/pushNotificationActions';
import type { RenderScreenResult } from '@/dev/testkit';
import type {
    DesktopWindowChromePolicy,
    DesktopWindowState,
} from '@/utils/platform/desktopWindowBridge';
import { installRouteRootCommonModuleMocks } from './routeRootTestHelpers';

// Avoid React "act(...) environment" warnings in non-JSDOM test environments.
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const loadAsyncMock = vi.fn();
const hideAsyncMock = vi.fn(async () => {});
let mockedPlatformOS: string = 'web';
let mockedPathname = '/';
let embedRouteLayout: React.ComponentType | null = null;
let shellRouteProbe: React.ComponentType | null = null;
const embedSlotDepth = React.createContext(0);
let mockedConfigVariant: string = '';
const sentryInitMock = vi.fn();
const sentryMobileReplayIntegrationMock = vi.fn(() => ({ name: 'mobileReplayIntegration' }));
const sentryWrapMock = vi.fn((Component: any) => Component);
const routerPushMock = vi.fn();
const bootCredentialsState = vi.hoisted(() => ({ authenticated: false }));
const shellChromeState = vi.hoisted(() => ({
    isDesktopHost: false,
    isTablet: true,
}));
const desktopOverlayWindowState = vi.hoisted(() => ({
    value: false,
}));
const notificationNativeState = vi.hoisted(() => ({
    unavailable: false,
}));
const desktopSecureStorageState = vi.hoisted(() => ({
    boundary: null as null | ReturnType<typeof import('@/dev/testkit/mocks/desktopSecureStorage').createDesktopSecureStorageBoundary>,
}));
const desktopWindowBridgeState = vi.hoisted(() => ({
    getDesktopWindowChromePolicy: vi.fn<() => Promise<DesktopWindowChromePolicy>>(async () => ({ strategy: 'none' })),
    getDesktopWindowState: vi.fn<() => Promise<DesktopWindowState>>(async () => ({ isMaximized: false, isFullscreen: false })),
    listenDesktopWindowState: vi.fn<(handler: (state: DesktopWindowState) => void) => Promise<() => Promise<void>>>(async () => async () => {}),
    minimizeDesktopWindow: vi.fn(async () => {}),
    toggleDesktopWindowMaximize: vi.fn(async () => {}),
    closeDesktopWindow: vi.fn(async () => {}),
    startDesktopWindowDragging: vi.fn(async () => {}),
}));

const { fromModuleMock, trackingState, fontAwesomeFontMock, ioniconsFontMock } = vi.hoisted(() => ({
    fromModuleMock: vi.fn(),
    trackingState: {
        client: null as null | {
            identify?: ReturnType<typeof vi.fn>;
            group?: ReturnType<typeof vi.fn>;
            capture?: ReturnType<typeof vi.fn>;
        },
    },
    fontAwesomeFontMock: { FontAwesome: 101 },
    ioniconsFontMock: { Ionicons: 202 },
}));

vi.mock('socket.io-client', async importOriginal => (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));
vi.mock('expo-file-system', async () => (await import('@/dev/testkit/mocks/expoFileSystem')).createExpoFileSystemFileMock().module);

vi.mock('react-native-quick-base64', () => ({}));
// Metro owns route discovery; Node does not implement require.context.
vi.mock('expo-router/_ctx', () => ({
    ctx: Object.assign(() => { throw new Error('Unexpected Metro route load in root-layout fixture'); }, {
        keys: () => [],
    }),
}));
vi.mock('@react-native-masked-view/masked-view', () => ({
    __esModule: true,
    default: (props: any) => React.createElement('MaskedView', props, props.children),
    MaskedView: (props: any) => React.createElement('MaskedView', props, props.children),
}));
vi.mock('react-native-view-shot', () => ({
    __esModule: true,
    default: (props: any) => React.createElement('ViewShot', props, props.children),
    ViewShot: (props: any) => React.createElement('ViewShot', props, props.children),
    captureRef: vi.fn(async () => ''),
    releaseCapture: vi.fn(),
}));
vi.mock('expo-video', () => ({
    __esModule: true,
    Video: (props: any) => React.createElement('Video', props, props.children),
    VideoView: (props: any) => React.createElement('VideoView', props, props.children),
    useVideoPlayer: () => null,
}));
vi.mock('expo-blur', () => ({
    __esModule: true,
    BlurView: (props: any) => React.createElement('BlurView', props, props.children),
}));

vi.mock('@/config', () => ({
    config: {
        get variant() {
            return mockedConfigVariant;
        },
        get postHogKey() {
            return trackingState.client ? 'root-layout-test-project' : '';
        },
    },
}));

vi.mock('@sentry/react-native', () => ({
    init: (...args: any[]) => (sentryInitMock as any).apply(undefined, args),
    mobileReplayIntegration: (...args: any[]) => (sentryMobileReplayIntegrationMock as any).apply(undefined, args),
    wrap: (...args: any[]) => (sentryWrapMock as any).apply(undefined, args),
}));

vi.mock('expo-splash-screen', () => ({
    setOptions: vi.fn(),
    preventAutoHideAsync: vi.fn(async () => {}),
    hideAsync: hideAsyncMock,
}));

vi.mock('expo-font', () => ({
    loadAsync: loadAsyncMock,
}));
// Applying the native root-view background is an Expo SDK effect.
vi.mock('expo-system-ui', () => ({ setBackgroundColorAsync: vi.fn(async () => {}) }));

vi.mock('expo-asset', () => ({
    Asset: {
        fromModule: (...args: any[]) => (fromModuleMock as any).apply(undefined, args),
    },
}));

vi.mock('expo-notifications', () => {
    if (notificationNativeState.unavailable) {
        throw new Error('expo-notifications native module unavailable');
    }
    return {
        setNotificationHandler: vi.fn(),
        setNotificationChannelAsync: vi.fn(async () => {}),
        setNotificationCategoryAsync: vi.fn(async () => {}),
        AndroidImportance: { HIGH: 4, MAX: 5 },
    };
});

vi.mock('@expo/vector-icons', async () => {

    const { createExpoVectorIconsMock } = await import('@/dev/testkit/mocks/icons');

    const icons = createExpoVectorIconsMock();
    const Icon = (props: Record<string, unknown>) => React.createElement('Icon', props);
    return { ...icons, FontAwesome: Object.assign(Icon, { font: fontAwesomeFontMock }),
        Ionicons: Object.assign((props: Record<string, unknown>) => React.createElement('Icon', props), { font: ioniconsFontMock }) };
});

vi.mock('@/utils/platform/desktopHost', () => ({
    isDesktopHost: () => shellChromeState.isDesktopHost,
    desktopHostKind: () => shellChromeState.isDesktopHost ? 'tauri' : null,
    invokeDesktopHost: vi.fn(async (command: string, args?: Readonly<Record<string, unknown>>) => {
        if (!desktopSecureStorageState.boundary) throw new Error('Desktop secure-storage fixture is not installed');
        return await desktopSecureStorageState.boundary.invoke(command, args) ?? null;
    }),
    listenDesktopHostEvent: vi.fn(async () => () => {}),
}));

vi.mock('@/utils/platform/desktopWindowBridge', async importOriginal => ({
    ...await importOriginal<typeof import('@/utils/platform/desktopWindowBridge')>(),
    getDesktopWindowChromePolicy: () => desktopWindowBridgeState.getDesktopWindowChromePolicy(),
    getDesktopWindowState: () => desktopWindowBridgeState.getDesktopWindowState(),
    listenDesktopWindowState: (handler: (state: { isMaximized: boolean }) => void) =>
        desktopWindowBridgeState.listenDesktopWindowState(handler),
    minimizeDesktopWindow: () => desktopWindowBridgeState.minimizeDesktopWindow(),
    toggleDesktopWindowMaximize: () => desktopWindowBridgeState.toggleDesktopWindowMaximize(),
    closeDesktopWindow: () => desktopWindowBridgeState.closeDesktopWindow(),
    startDesktopWindowDragging: () => desktopWindowBridgeState.startDesktopWindowDragging(),
}));

installRouteRootCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock(
            {
                Platform: {
                    get OS() {
                        return mockedPlatformOS;
                    },
                    set OS(value: string) {
                        mockedPlatformOS = value;
                    },
                    select: (options: any) =>
                        options?.[mockedPlatformOS] ?? options?.default ?? options?.ios ?? options?.android,
                },
                useWindowDimensions: () => ({ width: shellChromeState.isTablet ? 1280 : 480,
                    height: 900, scale: 1, fontScale: 1 }),
            },
        );
    },
    router: async () => {
        const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
        const expoRouterMock = createExpoRouterMock({
            pathname: () => mockedPathname,
            router: { push: routerPushMock, back: vi.fn() },
        });
        return {
            ...expoRouterMock.module,
            // Router owns placing the selected route below the real shell.
            Stack: Object.assign(function StackBoundary(props: React.PropsWithChildren) {
                return React.createElement(expoRouterMock.module.Stack, props,
                    props.children, shellRouteProbe ? React.createElement(shellRouteProbe) : null);
            }, { Screen: expoRouterMock.module.Stack.Screen }),
            // Metro/Router owns route discovery; render the real nested layout below this boundary.
            Slot: function SlotBoundary() {
                const depth = React.useContext(embedSlotDepth);
                if (depth !== 0 || !embedRouteLayout) return null;
                return React.createElement(embedSlotDepth.Provider, { value: depth + 1 },
                    React.createElement(embedRouteLayout));
            },
        };
    },
});

vi.mock('@react-navigation/native', async () => (await import('@/dev/testkit/mocks/reactNavigation')).createReactNavigationNativeMock());

vi.mock('react-native-keyboard-controller', () => {
    const React = require('react');
    return {
        KeyboardProvider: ({ children }: { children: React.ReactNode }) => React.createElement('KeyboardProvider', null, children),
    };
});

vi.mock('react-native-gesture-handler', async () => {
    const React = require('react');
    return {
        ...(await import('@/dev/testkit/mocks/gestureHandler')).createGestureHandlerMock(),
        GestureHandlerRootView: ({ children }: { children: React.ReactNode }) => React.createElement('GestureHandlerRootView', null, children),
    };
});

vi.mock('posthog-react-native', () => {
    const React = require('react');
    return {
        default: class PostHog {
            identify = trackingState.client?.identify ?? vi.fn();
            group = trackingState.client?.group ?? vi.fn();
            capture = trackingState.client?.capture ?? vi.fn();
            optIn = vi.fn(async () => {});
            optOut = vi.fn(async () => {});
            flush = vi.fn(async () => {});
            getAnonymousId = vi.fn(() => 'root-layout-anonymous');
            register = vi.fn();
            screen = vi.fn();
            reset = vi.fn();
        },
        PostHogProvider: ({ children, ...props }: { children: React.ReactNode } & Record<string, unknown>) =>
            React.createElement('PostHogProvider', { testID: 'posthog-provider', ...props }, children),
    };
});

// Source transformation is collection setup, not part of a boot assertion's
// deadline. Retire this graph before cases: font state and Sentry's static
// environment/platform captures must still be evaluated afresh in every case.
{
    const browser = await (await import('@/dev/testkit/harness/browserRuntimeHarness')).installBrowserRuntimeForTests({
        url: 'https://root.example.test/',
    });
    let homes: ReturnType<typeof import('@/dev/testkit/harness/homeGovernanceHarness').createHomeGovernanceHarness> | undefined;
    let bridge: Awaited<ReturnType<typeof import('@/dev/testkit/harness/syncSingletonLoader').loadSyncSingletonForTests>> | undefined;
    try {
        const { createHomeGovernanceHarness, installHomeGovernanceBoundaries } = await import('@/dev/testkit/harness/homeGovernanceHarness');
        homes = createHomeGovernanceHarness();
        installHomeGovernanceBoundaries(homes);
        (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).installDisconnectedServerSocketBoundary();
        desktopSecureStorageState.boundary = (await import('@/dev/testkit/mocks/desktopSecureStorage')).createDesktopSecureStorageBoundary();
        bridge = await (await import('@/dev/testkit/harness/syncSingletonLoader')).loadSyncSingletonForTests();
        await import('@/app/_layout');
    } finally {
        try {
            if (bridge) await (await import('@/sync/runtime/orchestration/connectionManager')).disconnectActiveServerConnection();
        } finally {
            try { await homes?.reset(); }
            finally {
                bridge?.dispose();
                browser.restore();
                delete (globalThis as Record<string, unknown>).__HAPPIER_SENTRY_INIT__;
                vi.resetModules();
                vi.clearAllMocks();
            }
        }
    }
}

describe('app/_layout init resilience', () => {
    let homes: ReturnType<typeof import('@/dev/testkit/harness/homeGovernanceHarness').createHomeGovernanceHarness>;
    let syncBridge: Awaited<ReturnType<typeof import('@/dev/testkit/harness/syncSingletonLoader').loadSyncSingletonForTests>> | undefined;
    let hasHomeFixture = false;
    let components: Awaited<ReturnType<typeof loadRootComponents>>;
    let homeId: string;
    let fixtureReady = false;
    let retainDomOnNative = false;
    let browser: Awaited<ReturnType<typeof import('@/dev/testkit/harness/browserRuntimeHarness').installBrowserRuntimeForTests>> | undefined;

    beforeEach(async () => {
        shellRouteProbe = null;
        browser = await (await import('@/dev/testkit/harness/browserRuntimeHarness')).installBrowserRuntimeForTests({
            url: 'https://root.example.test/',
        });
        retainDomOnNative = false;
        vi.stubGlobal('indexedDB', new IDBFactory());
        loadAsyncMock.mockReset().mockResolvedValue(undefined);
        fromModuleMock.mockReset();
        fixtureReady = false;
        desktopSecureStorageState.boundary = (await import('@/dev/testkit/mocks/desktopSecureStorage')).createDesktopSecureStorageBoundary();
    });

    async function prepareRootFixture() {
        if (fixtureReady) return;
        // Native boot cases intentionally have no DOM. The one misreported
        // Platform case below explicitly retains its real browser environment.
        if (mockedPlatformOS !== 'web' && !retainDomOnNative) {
            browser?.restore();
            browser = undefined;
        }
        const { createHomeGovernanceHarness, installHomeGovernanceBoundaries } = await import('@/dev/testkit/harness/homeGovernanceHarness');
        const { installDisconnectedServerSocketBoundary } = await import('@/dev/testkit/harness/serverAccountConnectionHarness');
        homes = createHomeGovernanceHarness();
        hasHomeFixture = true;
        installHomeGovernanceBoundaries(homes);
        installDisconnectedServerSocketBoundary();
        syncBridge = await (await import('@/dev/testkit/harness/syncSingletonLoader')).loadSyncSingletonForTests();
        homeId = await homes.addHome({ name: 'Root fixture Home', serverUrl: 'https://root.example.test',
            serverIdentityId: 'srv_root_layout', accountId: null });
        homes.answer(homeId, '/v1/kv/bulk', { body: { values: [] } });
        fixtureReady = true;
    }

    async function disposeRootFixture() {
        try {
            if (syncBridge) {
                await (await import('@/sync/runtime/orchestration/connectionManager')).disconnectActiveServerConnection();
            }
        } finally {
            try {
                // addHome may fail before fixtureReady; its installed ports still need disposal.
                if (hasHomeFixture) await homes.reset();
            } finally {
                syncBridge?.dispose();
                syncBridge = undefined;
                hasHomeFixture = false;
                fixtureReady = false;
            }
        }
    }

    const previousSentryDsn = process.env.EXPO_PUBLIC_SENTRY_DSN;
    const previousSentryLogs = process.env.EXPO_PUBLIC_SENTRY_ENABLE_LOGS;
    const previousSentryReplay = process.env.EXPO_PUBLIC_SENTRY_ENABLE_REPLAY;
    const previousSentryReplaySessionRate = process.env.EXPO_PUBLIC_SENTRY_REPLAYS_SESSION_SAMPLE_RATE;
    const previousSentryReplayOnErrorRate = process.env.EXPO_PUBLIC_SENTRY_REPLAYS_ON_ERROR_SAMPLE_RATE;

    afterEach(async () => {
        try {
            const { standardCleanup } = await import('@/dev/testkit');
            standardCleanup();
        } finally {
            await disposeRootFixture();
        }
        browser?.restore();
        browser = undefined;
        // Ensure no test leaks fake timers into subsequent tests.
        vi.useRealTimers();
        mockedPlatformOS = 'web';
        mockedPathname = '/';
        embedRouteLayout = null;
        mockedConfigVariant = '';
        bootCredentialsState.authenticated = false;
        shellChromeState.isDesktopHost = false;
        shellChromeState.isTablet = true;
        desktopOverlayWindowState.value = false;
        notificationNativeState.unavailable = false;
        desktopWindowBridgeState.getDesktopWindowChromePolicy.mockReset();
        desktopWindowBridgeState.getDesktopWindowState.mockReset();
        desktopWindowBridgeState.listenDesktopWindowState.mockReset();
        desktopWindowBridgeState.minimizeDesktopWindow.mockReset();
        desktopWindowBridgeState.toggleDesktopWindowMaximize.mockReset();
        desktopWindowBridgeState.closeDesktopWindow.mockReset();
        desktopWindowBridgeState.startDesktopWindowDragging.mockReset();
        desktopWindowBridgeState.getDesktopWindowChromePolicy.mockResolvedValue({ strategy: 'none' });
        desktopWindowBridgeState.getDesktopWindowState.mockResolvedValue({ isMaximized: false, isFullscreen: false });
        desktopWindowBridgeState.listenDesktopWindowState.mockResolvedValue(async () => {});
        // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
        delete (globalThis as any).__HAPPIER_SENTRY_INIT__;
        // Clean up any navigator overrides from tests.
        // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
        delete (globalThis as any).navigator;
        // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
        delete (globalThis as any).document;
        // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
        delete (globalThis as any).window;
        sentryInitMock.mockClear();
        sentryMobileReplayIntegrationMock.mockClear();
        sentryWrapMock.mockClear();
        routerPushMock.mockClear();
        if (previousSentryDsn === undefined) delete process.env.EXPO_PUBLIC_SENTRY_DSN;
        else process.env.EXPO_PUBLIC_SENTRY_DSN = previousSentryDsn;
        if (previousSentryLogs === undefined) delete process.env.EXPO_PUBLIC_SENTRY_ENABLE_LOGS;
        else process.env.EXPO_PUBLIC_SENTRY_ENABLE_LOGS = previousSentryLogs;
        if (previousSentryReplay === undefined) delete process.env.EXPO_PUBLIC_SENTRY_ENABLE_REPLAY;
        else process.env.EXPO_PUBLIC_SENTRY_ENABLE_REPLAY = previousSentryReplay;
        if (previousSentryReplaySessionRate === undefined) delete process.env.EXPO_PUBLIC_SENTRY_REPLAYS_SESSION_SAMPLE_RATE;
        else process.env.EXPO_PUBLIC_SENTRY_REPLAYS_SESSION_SAMPLE_RATE = previousSentryReplaySessionRate;
        if (previousSentryReplayOnErrorRate === undefined) delete process.env.EXPO_PUBLIC_SENTRY_REPLAYS_ON_ERROR_SAMPLE_RATE;
        else process.env.EXPO_PUBLIC_SENTRY_REPLAYS_ON_ERROR_SAMPLE_RATE = previousSentryReplayOnErrorRate;
        trackingState.client = null;
        vi.restoreAllMocks();
        vi.resetModules();
        vi.clearAllMocks();
    });

    async function loadRootComponents() {
        const [crash, currentUi, actions, realtime, voice, sidebar, favicon, updates, summary, analytics, drag] = await Promise.all([
            import('@/components/appShell/AppCrashRecoveryBoundary'),
            import('@/components/appShell/currentUiContext/CurrentUiContextProvider'),
            import('@/components/appShell/runtime/ClientActionReverseRuntime'),
            import('@/realtime/RealtimeProvider'),
            import('@/voice/session/VoiceSessionRuntime'),
            import('@/components/navigation/shell/SidebarNavigator'),
            import('@/components/web/FaviconPermissionIndicator'),
            import('@/components/updates/UpdatesPopoverButton'),
            import('@/updates/useUpdatesSummary'),
            import('@/track/settingsAnalytics/SettingsAnalyticsRuntime'),
            import('@/components/navigation/desktopWindowChrome/DesktopMainContentDragSurface'),
        ]);
        return {
            AppCrashRecoveryBoundary: crash.AppCrashRecoveryBoundary,
            CurrentUiContextProvider: currentUi.CurrentUiContextProvider,
            ClientActionReverseRuntime: actions.ClientActionReverseRuntime,
            RealtimeProvider: realtime.RealtimeProvider,
            VoiceSessionRuntime: voice.VoiceSessionRuntime,
            UpdatesSummaryProvider: summary.UpdatesSummaryProvider,
            SettingsAnalyticsRuntime: analytics.SettingsAnalyticsRuntime,
            // React's host renderer exposes the inner type of simple memo components.
            SidebarNavigator: Reflect.get(sidebar.SidebarNavigator, 'type'),
            FaviconPermissionIndicator: Reflect.get(favicon.FaviconPermissionIndicator, 'type'),
            UpdatesEntry: Reflect.get(updates.UpdatesEntry, 'type'),
            DesktopMainContentDragSurface: Reflect.get(drag.DesktopMainContentDragSurface, 'type'),
        };
    }

    async function importRootLayout() {

        await prepareRootFixture();

        const root = await import('@/app/_layout');
        return root;
    }

    async function renderRootLayout(): Promise<RenderScreenResult> {
        await prepareRootFixture();
        if (bootCredentialsState.authenticated) await homes.switchAccount(homeId, 'root-layout-account');
        if (desktopOverlayWindowState.value) {
            browser?.reconfigureUrl(`https://root.example.test${mockedPathname}`);
        }
        const RootLayout = (await importRootLayout()).default;
        components = await loadRootComponents();
        const { renderScreen } = await import('@/dev/testkit');
        const screen = await renderScreen(React.createElement(RootLayout), { flushOptions: { cycles: 0 } });
        return screen;
    }

    async function renderSettledRootLayout(): Promise<RenderScreenResult> {
        const screen = await renderRootLayout();
        const { prepareSessionDraftPersistenceStorage } = await import('@/sync/ops/sessionDrafts/sessionDraftPersistenceStorage');
        await React.act(async () => { await prepareSessionDraftPersistenceStorage(); });
        const { flushHookEffects } = await import('@/dev/testkit');
        await flushHookEffects();
        return screen;
    }

    describe('embedded frame boot', () => {
        beforeEach(() => {
            mockedPathname = '/embed/new';
            browser?.reconfigureUrl('https://root.example.test/embed/new');
            // Realm captures must observe the embed DOM before route/credential imports.
            vi.resetModules();
        });

        it('boots the real embed route composition before credential admission without an auth-provider crash', async () => {
            expect((await import('@/embed/isEmbedWindowContext')).isEmbedWindowContext()).toBe(true);
            await prepareRootFixture();
            const EmbedLayout = (await import('@/app/embed/_layout')).default;
            const { useAuth } = await import('@/auth/context/AuthContext');
            // Exercise a real auth consumer before the nested layout: a provider
            // inside that layout cannot protect route-composition consumers.
            embedRouteLayout = function AuthConsumingEmbedRoute() {
                useAuth();
                return React.createElement(EmbedLayout);
            };
            const RootLayout = (await importRootLayout()).default;
            const { renderScreen } = await import('@/dev/testkit');
            const { EmbedSessionViewport } = await import('@/embed/EmbedSessionViewport');
            const screen = await renderScreen(React.createElement(RootLayout));
            try {
                await vi.waitFor(() => expect(screen.root.findAllByType(EmbedSessionViewport)).toHaveLength(1));
            } finally {
                await screen.unmount();
            }
        });
    });

    it('wraps the root layout with Sentry.wrap', async () => {
        process.env.EXPO_PUBLIC_SENTRY_DSN = 'https://examplePublicKey@o0.ingest.sentry.io/0';
        await importRootLayout();
        expect(sentryWrapMock).toHaveBeenCalledTimes(1);
        expect(typeof sentryWrapMock.mock.calls[0]?.[0]).toBe('function');
    });

    it('does not wrap the root layout with Sentry.wrap when EXPO_PUBLIC_SENTRY_DSN is unset', async () => {
        delete process.env.EXPO_PUBLIC_SENTRY_DSN;
        await importRootLayout();
        expect(sentryWrapMock).toHaveBeenCalledTimes(0);
    });

    it('does not fail root layout import when expo notifications are unavailable on Android', async () => {
        mockedPlatformOS = 'android';
        notificationNativeState.unavailable = true;

        await expect(importRootLayout()).resolves.toHaveProperty('default');
    });

    it('shows a person-handled original question once in the shell Inbox and removes it on owner settlement', async () => {
        bootCredentialsState.authenticated = true;
        await prepareRootFixture();
        const { installDisconnectedServerSocketBoundary, configureConnectedServerSocketBoundary } = await import('@/dev/testkit/harness/serverAccountConnectionHarness');
        installDisconnectedServerSocketBoundary(configureConnectedServerSocketBoundary);
        const [{ createSessionFixture, createSessionViewerFixture, createPlainSessionByIdResponseFixture },
            { createSessionListSourceFixture }, { createRootLayoutFeaturesResponse }, { tryWriteServerEnabledBitInPlace },
            { InboxModelProvider, useInboxModel }, { publishHomeAccountChange }] = await Promise.all([
            import('@/dev/testkit/fixtures/sessionFixtures'),
            import('@/dev/testkit/harness/sessionReadBatchHttpBoundary'),
            import('@/dev/testkit/fixtures/featureFixtures'),
            import('@happier-dev/protocol/features/serverEnabledBit'),
            import('@/hooks/inbox/useInboxModel'),
            import('@/sync/runtime/orchestration/homeAccountChange'),
        ]);
        const features = createRootLayoutFeaturesResponse();
        expect(tryWriteServerEnabledBitInPlace(features, 'sessions.filteredListing', true)).toBe(true);
        const { primeServerFeaturesSnapshot } = await import('@/sync/api/capabilities/serverFeaturesClient');
        primeServerFeaturesSnapshot({ serverId: homeId, snapshot: { status: 'ready', features } });
        homes.answer(homeId, '/v1/features', { body: features });
        homes.answer(homeId, '/v1/features/authenticated', { body: features });
        homes.answer(homeId, '/v2/sessions', { body: { sessions: [], hasNext: false, nextCursor: null } });
        homes.answer(homeId, '/v2/sessions/active', { body: { sessions: [], hasNext: false, nextCursor: null } });
        const requestId = 'original-worker-question';
        const worker = createSessionFixture({ id: 'inbox-worker', serverId: homeId, encryptionMode: 'plain',
            active: true, activeAt: Date.now(), updatedAt: Date.now(), manager: { sessionId: 'manager' },
            ownerAccountId: 'root-layout-account', latestTurnStatus: 'waiting', pendingUserActionRequestCount: 1,
            viewer: createSessionViewerFixture({ relevance: { relevant: true, reasons: ['owned_by_me'] },
                attention: { needsAttention: true, reasons: ['user_action_required'], primary: 'user_action_required', presentation: 'full' } }),
            agentState: { requests: { [requestId]: { kind: 'user_action', tool: 'AskUserQuestion',
                arguments: { questions: [{ question: 'Which region?' }] }, createdAt: Date.now(),
                questionV1: { mode: 'wait', type: 'decision', lasting: false }, currentHandler: { kind: 'person' } } } } });
        let current = worker;
        const wire = () => ({ ...createPlainSessionByIdResponseFixture(current).session,
            ownerAccountId: current.ownerAccountId, viewer: current.viewer });
        homes.answer(homeId, '/v2/sessions/query', { select: () => ({ body: createSessionListSourceFixture({
            sessions: [wire()], hasNext: false, nextCursor: null, attentionHasNext: false, attentionNextCursor: null,
        }) }) });
        homes.answer(homeId, `/v2/sessions/${worker.id}`, { select: () => ({ body: { session: wire() } }) });
        homes.answer(homeId, `/v1/sessions/${worker.id}/messages`, { body: { messages: [], hasMore: false, nextAfterSeq: null } });
        let inbox: ReturnType<typeof useInboxModel> | null = null;
        function Probe() { inbox = useInboxModel(); return null; }
        shellRouteProbe = () => React.createElement(InboxModelProvider, null, React.createElement(Probe));
        await renderSettledRootLayout();
        const ownRows = () => inbox?.items.filter(item => item.focus.kind === 'session' && item.focus.id === worker.id);
        await vi.waitFor(() => expect(ownRows(), JSON.stringify({
            membership: inbox?.source.personalSessionListMembershipByServerId,
            queries: Object.fromEntries(Object.entries(inbox?.source.personalSessionListQueryStatesByServerId ?? {}).map(([id, value]) =>
                [id, { phase: value?.phase, reason: value?.failureReason, code: value?.failureCode }])),
            calls: homes.requests.filter(request => request.path.includes('sessions')).map(request => request.path),
        })).toEqual([expect.objectContaining({ view: 'needs_you', type: 'decision',
            question: expect.objectContaining({ requestId, currentHandler: { kind: 'person' } }),
            focus: { kind: 'session', id: worker.id, serverId: 'srv_root_layout' },
        })]));
        const queryReads = () => homes.requests.filter(request => request.path === '/v2/sessions/query').length;
        const before = queryReads();
        const { act, flushHookEffects } = await import('@/dev/testkit');
        const { resolveServerProfileScopeIdForIdentifier } = await import('@/sync/domains/server/serverProfiles');
        const sourceHomeId = resolveServerProfileScopeIdForIdentifier(homeId);
        await act(async () => {
            // Mirror the socket owner's accounting-only wake: it cannot move a Session corpus.
            for (let index = 0; index < 100; index++) publishHomeAccountChange(sourceHomeId, [], {
                usageQueryAffects: true, accountSettingsAffects: false, profileCatalogAffects: false, sessionListQueryAffects: false,
            });
        });
        await flushHookEffects();
        expect(queryReads()).toBe(before);
        expect(ownRows()).toHaveLength(1);
        current = createSessionFixture({ ...worker, agentStateVersion: worker.agentStateVersion + 1,
            seq: worker.seq + 1, updatedAt: Date.now(), pendingRequestObservedAt: Date.now(),
            pendingUserActionRequestCount: 0, latestTurnStatus: 'completed', latestTurnStatusObservedAt: Date.now(), agentState: { requests: {}, completedRequests: {
                [requestId]: { ...worker.agentState!.requests![requestId]!, status: 'approved', completedAt: Date.now() },
            } }, viewer: createSessionViewerFixture({ relevance: worker.viewer!.relevance }) });
        await act(async () => publishHomeAccountChange(sourceHomeId, [worker.id], { changeKinds: ['session'], sessionListQueryAffects: true }));
        await vi.waitFor(() => expect(queryReads()).toBeGreaterThan(before));
        await vi.waitFor(() => expect(ownRows()).toEqual([]));
    });

    it('provides the main app tab state to the root sidebar shell', async () => {
        const screen = await renderSettledRootLayout();

        const { readCurrentUiContextActionReader } = await import('@/components/appShell/currentUiContext/currentUiContextActionRuntime');
        const reader = readCurrentUiContextActionReader({ surface: 'ui', signal: new AbortController().signal });
        expect(reader?.readCurrentUiContext()?.navigation).toEqual(expect.objectContaining({ screen: 'tab.sessions' }));
        expect(screen.findAllByType(components.RealtimeProvider)).toHaveLength(1);
    });

    for (const platform of ['web', 'ios', 'android'] as const) {
        it(`mounts the realtime voice runtime beneath the one AppShell current UI provider on ${platform}`, async () => {
            mockedPlatformOS = platform;
            const screen = await renderSettledRootLayout();

            const currentUiProvider = screen.findByType(components.CurrentUiContextProvider);
            expect(currentUiProvider.findAllByType(components.RealtimeProvider)).toHaveLength(1);
            expect(currentUiProvider.findAllByType(components.VoiceSessionRuntime)).toHaveLength(1);
        });
    }

    it('publishes the pre-auth root current UI context without an authenticated reverse Action runtime', async () => {
        const screen = await renderSettledRootLayout();

        const { readCurrentUiContextActionReader } = await import('@/components/appShell/currentUiContext/currentUiContextActionRuntime');
        const reader = readCurrentUiContextActionReader({ surface: 'ui', signal: new AbortController().signal });
        expect(reader?.readCurrentUiContext()).toEqual(expect.objectContaining({
            navigation: expect.objectContaining({ area: 'app', screen: 'tab.sessions' }),
            commands: [],
        }));
        const currentUiProvider = screen.findByType(components.CurrentUiContextProvider);
        expect(currentUiProvider.findAllByType(components.ClientActionReverseRuntime)).toHaveLength(0);
    });

    it('configures separate Android notification channels for permission/action request pushes', async () => {
        mockedPlatformOS = 'android';
        await importRootLayout();

        const Notifications = await import('expo-notifications');
        expect((Notifications as any).setNotificationChannelAsync).toHaveBeenCalledWith(
            PUSH_NOTIFICATION_ANDROID_CHANNEL_IDS.defaultV1,
            expect.objectContaining({
                importance: Notifications.AndroidImportance.MAX,
                showBadge: true,
            }),
        );
        expect((Notifications as any).setNotificationChannelAsync).toHaveBeenCalledWith(
            PUSH_NOTIFICATION_ANDROID_CHANNEL_IDS.permissionRequestsV1,
            expect.objectContaining({
                importance: Notifications.AndroidImportance.MAX,
                showBadge: true,
            }),
        );
        expect((Notifications as any).setNotificationChannelAsync).toHaveBeenCalledWith(
            PUSH_NOTIFICATION_ANDROID_CHANNEL_IDS.userActionRequestsV1,
            expect.objectContaining({
                importance: Notifications.AndroidImportance.HIGH,
                showBadge: true,
            }),
        );
        expect((Notifications as any).setNotificationChannelAsync).toHaveBeenCalledWith(
            PUSH_NOTIFICATION_ANDROID_CHANNEL_IDS.defaultSoftV1,
            expect.objectContaining({
                sound: 'happier_soft',
                importance: Notifications.AndroidImportance.MAX,
            }),
        );
        expect((Notifications as any).setNotificationChannelAsync).toHaveBeenCalledWith(
            PUSH_NOTIFICATION_ANDROID_CHANNEL_IDS.permissionRequestsUrgentV1,
            expect.objectContaining({
                sound: 'happier_urgent',
                importance: Notifications.AndroidImportance.MAX,
            }),
        );
    });

    it('uses app variant as the default Sentry environment when EXPO_PUBLIC_SENTRY_ENVIRONMENT is unset', async () => {
        process.env.EXPO_PUBLIC_SENTRY_DSN = 'https://examplePublicKey@o0.ingest.sentry.io/0';
        mockedConfigVariant = 'preview';

        await renderRootLayout();

        expect(sentryInitMock).toHaveBeenCalledTimes(1);
        expect(sentryInitMock.mock.calls[0]?.[0]).toEqual(expect.objectContaining({
            environment: 'preview',
        }));
    });

    it('initializes Sentry when EXPO_PUBLIC_SENTRY_DSN is configured', async () => {
        process.env.EXPO_PUBLIC_SENTRY_DSN = 'https://examplePublicKey@o0.ingest.sentry.io/0';
        process.env.EXPO_PUBLIC_SENTRY_ENABLE_LOGS = '1';
        process.env.EXPO_PUBLIC_SENTRY_ENABLE_REPLAY = '1';
        process.env.EXPO_PUBLIC_SENTRY_REPLAYS_SESSION_SAMPLE_RATE = '0.1';
        process.env.EXPO_PUBLIC_SENTRY_REPLAYS_ON_ERROR_SAMPLE_RATE = '1';

        await renderRootLayout();

        expect(sentryMobileReplayIntegrationMock).toHaveBeenCalledTimes(1);
        expect(sentryInitMock).toHaveBeenCalledTimes(1);
        expect(sentryInitMock.mock.calls[0]?.[0]).toEqual(expect.objectContaining({
            dsn: 'https://examplePublicKey@o0.ingest.sentry.io/0',
            enableLogs: true,
            replaysSessionSampleRate: 0.1,
            replaysOnErrorSampleRate: 1,
        }));
    });

    it('continues boot when native font loading fails', async () => {
        mockedPlatformOS = 'ios';
        const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        loadAsyncMock.mockRejectedValueOnce(new Error('6000ms timeout exceeded'));

        const screen = await renderSettledRootLayout();

        expect(loadAsyncMock).toHaveBeenCalledTimes(1);
        expect(homes.requestsFor('/v1/account/profile')).toHaveLength(0);
        expect(screen.findAllByType(components.SidebarNavigator)).toHaveLength(1);
        consoleErrorSpy.mockRestore();
    });

    it('skips sync restore inside the dedicated desktop activity overlay window', async () => {
        mockedPlatformOS = 'web';
        mockedPathname = '/desktop/activity-overlay';
        shellChromeState.isDesktopHost = true;
        desktopOverlayWindowState.value = true;
        bootCredentialsState.authenticated = true;

        const screen = await renderSettledRootLayout();

        expect(screen.findAllByType(components.RealtimeProvider)).toHaveLength(0);
        expect(screen.findAllByType(components.VoiceSessionRuntime)).toHaveLength(0);
        expect(screen.findAllByType(components.CurrentUiContextProvider)).toHaveLength(1);
        expect(screen.findAllByType(components.ClientActionReverseRuntime)).toHaveLength(0);
        expect(homes.requestsFor('/v1/account/profile')).toHaveLength(0);
    });

    it('restores synced pet state while keeping the pet overlay free of realtime runtimes', async () => {
        mockedPlatformOS = 'web';
        mockedPathname = '/desktop/pet-overlay';
        shellChromeState.isDesktopHost = true;
        desktopOverlayWindowState.value = true;
        bootCredentialsState.authenticated = true;

        const screen = await renderSettledRootLayout();

        expect(screen.findAllByType(components.RealtimeProvider)).toHaveLength(0);
        expect(screen.findAllByType(components.SidebarNavigator)).toHaveLength(1);
        const { storage } = await import('@/sync/domains/state/storage');
        await vi.waitFor(() => expect(storage.getState().profile?.id).toBe('root-layout-account'));
        expect(homes.requestsFor('/v1/account/profile').some(request => request.serverId === homeId)).toBe(true);
    });

    it('does not mount desktop fallback shell chrome inside the dedicated desktop overlay window', async () => {
        mockedPlatformOS = 'web';
        mockedPathname = '/desktop/activity-overlay';
        bootCredentialsState.authenticated = true;
        shellChromeState.isDesktopHost = true;
        shellChromeState.isTablet = false;
        desktopOverlayWindowState.value = true;
        desktopWindowBridgeState.getDesktopWindowChromePolicy.mockResolvedValue({ strategy: 'native-macos-traffic-lights' });

        const screen = await renderSettledRootLayout();

        expect(screen.findAllByTestId('desktop-narrow-shell-chrome')).toHaveLength(0);
        expect(screen.findAllByTestId('desktop-focus-mode-shell-chrome')).toHaveLength(0);
        expect(screen.findAllByType(components.UpdatesEntry)).toHaveLength(0);
    });

    it('uses a transparent navigation background inside the dedicated desktop overlay window', async () => {
        mockedPlatformOS = 'web';
        mockedPathname = '/desktop/activity-overlay';
        bootCredentialsState.authenticated = true;
        shellChromeState.isDesktopHost = true;
        desktopOverlayWindowState.value = true;

        const screen = await renderSettledRootLayout();

        const { ThemeProvider } = await import('@react-navigation/native');
        const themeProvider = screen.findByType(ThemeProvider);
        expect(themeProvider?.props?.value?.colors?.background).toBe('transparent');
    });

    it('preloads both FontAwesome and Ionicons icon fonts on native', async () => {
        mockedPlatformOS = 'ios';

        await renderSettledRootLayout();

        expect(loadAsyncMock).toHaveBeenCalledTimes(1);
        expect(loadAsyncMock.mock.calls[0]?.[0]).toEqual(expect.objectContaining({
            ...fontAwesomeFontMock,
            ...ioniconsFontMock,
        }));
    });

    it('wraps the provider stack with AppCrashRecoveryBoundary', async () => {
        mockedPlatformOS = 'ios';
        const screen = await renderSettledRootLayout();

        expect(screen.findAllByType(components.AppCrashRecoveryBoundary)[0] ?? null).toBeTruthy();
    });

    it('mounts favicon permission signaling inside AppCrashRecoveryBoundary for ordinary routes', async () => {
        mockedPlatformOS = 'ios';
        mockedPathname = '/';
        const screen = await renderSettledRootLayout();

        const boundary = screen.findAllByType(components.AppCrashRecoveryBoundary)[0] ?? null;
        expect(boundary).toBeTruthy();
        expect(boundary!.findAllByType(components.FaviconPermissionIndicator)).toHaveLength(1);
    });

    it('keeps the shell navigator mounted while hiding the shell Updates entry for terminal-connect routes', async () => {
        mockedPathname = '/terminal/connect';
        const screen = await renderSettledRootLayout();

        expect(screen.findAllByType(components.SidebarNavigator)).toHaveLength(1);
        expect(screen.findAllByType(components.UpdatesEntry)).toHaveLength(0);
        expect(screen.findAllByType(components.FaviconPermissionIndicator)).toHaveLength(0);
    });

    it('adds no floating update chrome on ordinary routes and computes the one shared Updates summary', async () => {
        mockedPathname = '/';
        const screen = await renderSettledRootLayout();

        expect(screen.findAllByType(components.SidebarNavigator)).toHaveLength(1);
        expect(screen.findAllByType(components.UpdatesEntry)).toHaveLength(0);
        expect(screen.findAllByType(components.UpdatesSummaryProvider)).toHaveLength(1);
    });

    it('does not mount a root-shell Updates entry for unauthenticated desktop flows owned by the pre-auth host', async () => {
        mockedPathname = '/';
        shellChromeState.isDesktopHost = true;

        const screen = await renderSettledRootLayout();

        expect(screen.findAllByType(components.SidebarNavigator)).toHaveLength(1);
        expect(screen.findAllByType(components.UpdatesEntry)).toHaveLength(0);
        expect(screen.findAllByTestId('desktop-focus-mode-shell-chrome')).toHaveLength(0);
        expect(screen.findAllByTestId('desktop-narrow-shell-chrome')).toHaveLength(0);
        const dragSurface = screen.findByType(components.DesktopMainContentDragSurface);
        expect(dragSurface?.props.enabled).toBe(true);
        expect(dragSurface?.props.leftOffsetPx).toBe(0);
    });

    it('preserves the navigation subtree when desktop chrome moves between wide and narrow hosts', async () => {
        bootCredentialsState.authenticated = true;
        shellChromeState.isDesktopHost = true;
        const screen = await renderSettledRootLayout();
        const navigator = screen.tree.findByType(components.SidebarNavigator);
        const RootLayout = (await importRootLayout()).default;
        for (const isTablet of [false, true]) {
            shellChromeState.isTablet = isTablet;
            await screen.update(React.createElement(RootLayout));
            expect(screen.tree.findByType(components.SidebarNavigator) === navigator).toBe(true);
        }
    });

    it('keeps desktop shell chrome inside the sidebar host for authenticated wide desktop flows', async () => {
        mockedPathname = '/';
        bootCredentialsState.authenticated = true;
        shellChromeState.isDesktopHost = true;
        shellChromeState.isTablet = true;
        desktopWindowBridgeState.getDesktopWindowChromePolicy.mockResolvedValue({ strategy: 'native-macos-traffic-lights' });

        const screen = await renderSettledRootLayout();

        expect(screen.findAllByTestId('desktop-focus-mode-shell-chrome')).toHaveLength(0);
        expect(screen.findAllByTestId('desktop-narrow-shell-chrome')).toHaveLength(0);
        expect(screen.findByType(components.DesktopMainContentDragSurface).props.enabled).toBe(false);
        expect(screen.findAllByType(components.SidebarNavigator)).toHaveLength(1);
    });

    it('renders an explicit narrow-desktop fallback host instead of folding it into focus-mode fallback', async () => {
        mockedPathname = '/';
        bootCredentialsState.authenticated = true;
        shellChromeState.isDesktopHost = true;
        shellChromeState.isTablet = false;
        desktopWindowBridgeState.getDesktopWindowChromePolicy.mockResolvedValue({ strategy: 'native-macos-traffic-lights' });

        const screen = await renderSettledRootLayout();

        expect(screen.findHostByTestId('desktop-narrow-shell-chrome')).toBeTruthy();
        expect(screen.findAllHostsByTestId('desktop-focus-mode-shell-chrome')).toHaveLength(0);
        expect(screen.findHostByTestId('desktop-window-controls-slot')).toBeTruthy();
        const dragSurface = screen.findByType(components.DesktopMainContentDragSurface);
        expect(dragSurface?.props.enabled).toBe(true);
        expect(dragSurface?.props.leftOffsetPx).toBe(0);
    });

    it('mounts the settings analytics runtime inside PostHogProvider when tracking is enabled', async () => {
        mockedPlatformOS = 'ios';
        trackingState.client = {
            identify: vi.fn(),
            group: vi.fn(),
            capture: vi.fn(),
        };
        const screen = await renderSettledRootLayout();
        const provider = screen.findByTestId('posthog-provider');

        expect(provider).toBeTruthy();
        if (provider == null) {
            throw new Error('expected PostHogProvider to be present');
        }
        expect(provider.props.autocapture).toEqual({ captureScreens: false });
        expect(screen.findByType(components.SettingsAnalyticsRuntime)).toBeTruthy();
    });

    it('navigates to the bug report screen on boot when a restart bug report intent is present', async () => {
        mockedPlatformOS = 'ios';
        const { persistRestartBugReportIntent } = await import('@/utils/system/restartBugReportIntent');
        await persistRestartBugReportIntent({ v: 1, createdAtMs: Date.now(), reason: 'crash' });

        await renderSettledRootLayout();

        expect(routerPushMock.mock.calls[0]?.[0]).toBe('/settings/report-issue');
    });

    it.each(['/', '/settings'])('retains a crash report boot destination from %s through the nested Settings navigator mount', async initialPath => {
        mockedPlatformOS = 'web';
        mockedPathname = initialPath;
        bootCredentialsState.authenticated = true;
        browser?.reconfigureUrl(`https://root.example.test${initialPath}`);
        await prepareRootFixture();
        const { useOptionalWorkspaceNavigation } = await import('@/components/appShell/workspace/WorkspaceNavigationContext');
        const admission: Array<{ active: boolean; ownsRoute?: boolean }> = [];
        shellRouteProbe = function WorkspaceBootProbe() {
            const navigation = useOptionalWorkspaceNavigation();
            if (navigation) admission.push({ active: navigation.active, ownsRoute: navigation.ownsRoute });
            return React.createElement('WorkspaceBootProbe', {
                testID: 'workspace-boot-probe', navigation,
            });
        };
        // Expo is the URL-mirroring boundary. Its nested Settings navigator initially
        // presents the parent while mounting a requested child (also characterized
        // by WorkspaceProvider's exact-Team-arrival tests).
        routerPushMock.mockImplementation(() => {
            window.history.replaceState(window.history.state, '', '/settings');
        });
        const { persistRestartBugReportIntent } = await import('@/utils/system/restartBugReportIntent');
        await persistRestartBugReportIntent({ v: 1, createdAtMs: Date.now(), reason: 'crash' });
        const screen = await renderSettledRootLayout();
        await vi.waitFor(() => expect(screen.findByTestId('workspace-boot-probe')?.props.navigation?.active).toBe(true));
        await vi.waitFor(() => expect(window.location.pathname, JSON.stringify(admission)).toBe('/settings/report-issue'));
        expect(admission.length).toBeGreaterThan(0);
        expect(admission.some(facts => !facts.active && !facts.ownsRoute)).toBe(true);
        expect(admission.some(facts => facts.active && facts.ownsRoute)).toBe(true);
        await React.act(async () => {
            window.history.replaceState(window.history.state, '', '/settings');
        });
        expect(window.location.pathname).toBe('/settings/report-issue');
    });

    it('keeps web startup usable while every injected font family load settles in the background', async () => {
        mockedPlatformOS = 'web';
        fromModuleMock.mockImplementation(() => ({ uri: 'https://example.com/font.ttf' }));

        const appended: Node[] = [];
        const append = document.head.appendChild.bind(document.head);
        const appendChild = vi.spyOn(document.head, 'appendChild').mockImplementation(node => {
            appended.push(node);
            return append(node);
        });
        const fontLoadResolvers: Array<() => void> = [];
        const fontLoadMock = vi.fn(() => new Promise<FontFace[]>((resolve) => {
            fontLoadResolvers.push(() => resolve([]));
        }));

        Object.defineProperty(document, 'fonts', {
            value: { load: fontLoadMock },
            configurable: true,
        });

        const screen = await renderSettledRootLayout();
        const { flushHookEffects } = await import('@/dev/testkit');
        await flushHookEffects({ cycles: 1 });

        expect(loadAsyncMock).toHaveBeenCalledTimes(0);
        expect(fontLoadMock).toHaveBeenCalledTimes(11);
        expect(fontLoadMock).toHaveBeenCalledWith('1em "Inter-Regular"');
        expect(fontLoadMock).toHaveBeenCalledWith('1em "IBMPlexMono-Regular"');
        expect(screen.findAllByType(components.SidebarNavigator)).toHaveLength(1);

        for (const resolveFontLoad of fontLoadResolvers.slice(0, -1)) {
            resolveFontLoad();
        }
        await flushHookEffects({ cycles: 1 });
        expect(screen.findAllByType(components.SidebarNavigator)).toHaveLength(1);

        fontLoadResolvers.at(-1)?.();
        await flushHookEffects();

        // We inject a <style> for @font-face rules and also add a <style> for UI font scaling overrides
        // (other head additions are not this contract).
        expect(appended.map((n) => (n as Element).id)).toEqual(expect.arrayContaining(['happier-web-font-faces', 'happier-ui-font-scale-overrides']));
        const texts = appended.map((n) => String(n?.textContent ?? ''));
        expect(texts.some((t) => t.includes('@font-face'))).toBe(true);
        expect(texts.some((t) => t.includes('Inter-Regular'))).toBe(true);
        expect(texts.some((t) => t.includes('example.com/font.ttf'))).toBe(true);
        expect(screen.findAllByType(components.SidebarNavigator)).toHaveLength(1);
    });

    it('continues web startup after injected font family loads fail', async () => {
        mockedPlatformOS = 'web';
        fromModuleMock.mockImplementation(() => ({ uri: 'https://example.com/font.ttf' }));
        const fontLoadMock = vi.fn(async () => {
            throw new Error('font unavailable');
        });

        Object.defineProperty(document, 'fonts', {
            value: { load: fontLoadMock },
            configurable: true,
        });

        const screen = await renderSettledRootLayout();

        expect(fontLoadMock).toHaveBeenCalledTimes(11);
        expect(screen.findAllByType(components.SidebarNavigator)).toHaveLength(1);
    });

    it('continues web startup when FontFaceSet is unavailable', async () => {
        mockedPlatformOS = 'web';
        fromModuleMock.mockImplementation(() => ({ uri: 'https://example.com/font.ttf' }));

        Object.defineProperty(document, 'fonts', {
            value: undefined,
            configurable: true,
        });

        const screen = await renderSettledRootLayout();

        expect(loadAsyncMock).not.toHaveBeenCalled();
        expect(screen.findAllByType(components.SidebarNavigator)).toHaveLength(1);
    });

    it('continues web startup when the font-face stylesheet cannot be injected', async () => {
        mockedPlatformOS = 'web';
        fromModuleMock.mockImplementation(() => ({ uri: 'https://example.com/font.ttf' }));
        const fontLoadMock = vi.fn(async () => []);
        const append = document.head.appendChild.bind(document.head);
        const appendChild = vi.spyOn(document.head, 'appendChild').mockImplementation(node => {
            if (node instanceof HTMLElement && node.id === 'happier-web-font-faces') {
                throw new Error('stylesheet unavailable');
            }
            return append(node);
        });

        Object.defineProperty(document, 'fonts', {
            value: { load: fontLoadMock },
            configurable: true,
        });

        const screen = await renderSettledRootLayout();

        expect(appendChild).toHaveBeenCalledWith(expect.objectContaining({
            id: 'happier-web-font-faces',
        }));
        expect(fontLoadMock).not.toHaveBeenCalled();
        expect(screen.findAllByType(components.SidebarNavigator)).toHaveLength(1);
    });

    it('does not surface font loading timeouts as errors in web automation contexts', async () => {
        // Playwright (and other automation) sets navigator.webdriver=true. In that context, expo-font's
        // web FontFaceObserver path can time out even when font files are reachable (headless quirks).
        // We should not show startup error overlays for that case.
        Object.defineProperties(navigator, {
            webdriver: { value: true, configurable: true },
            userAgent: { value: 'HeadlessChrome', configurable: true },
        });
        const addEventListenerSpy = vi.spyOn(window, 'addEventListener');

        const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        loadAsyncMock.mockRejectedValueOnce(new Error('6000ms timeout exceeded'));

        const screen = await renderSettledRootLayout();

        // In automation contexts, skip expo-font on web entirely to avoid FontFaceObserver's
        // timeout behavior surfacing as dev overlays (uncaught errors / unhandled rejections).
        expect(loadAsyncMock).toHaveBeenCalledTimes(0);
        expect(screen.findAllByType(components.SidebarNavigator)).toHaveLength(1);

        // Verify we install a suppression handler for FontFaceObserver's timeout behavior, since
        // other font loads (e.g. icon fonts) may still trigger it in automation.
        const unhandledRejectionListener = addEventListenerSpy.mock.calls.find(
            (call) => call[0] === 'unhandledrejection'
        )?.[1] as ((event: any) => void) | undefined;
        expect(typeof unhandledRejectionListener).toBe('function');
        const preventDefault = vi.fn();
        const stopImmediatePropagation = vi.fn();
        unhandledRejectionListener?.({
            reason: Object.assign(new Error('6000ms timeout exceeded'), { stack: '...fontfaceobserver...' }),
            preventDefault,
            stopImmediatePropagation,
        });
        expect(preventDefault).toHaveBeenCalledTimes(1);
        expect(stopImmediatePropagation).toHaveBeenCalledTimes(1);

        // Some environments surface FontFaceObserver timeouts without an informative stack string.
        unhandledRejectionListener?.({
            reason: Object.assign(new Error('6000ms timeout exceeded'), { stack: '' }),
            preventDefault,
            stopImmediatePropagation,
        });
        expect(preventDefault).toHaveBeenCalledTimes(2);
        expect(stopImmediatePropagation).toHaveBeenCalledTimes(2);

        // Some environments use a different casing in the stack string (e.g. "FontFaceObserver").
        unhandledRejectionListener?.({
            reason: Object.assign(new Error('6000ms timeout exceeded'), { stack: '...FontFaceObserver...' }),
            preventDefault,
            stopImmediatePropagation,
        });
        expect(preventDefault).toHaveBeenCalledTimes(3);
        expect(stopImmediatePropagation).toHaveBeenCalledTimes(3);

        // Some environments surface FontFaceObserver failures as uncaught errors (not unhandled rejections).
        const errorListener = addEventListenerSpy.mock.calls.find(
            (call) => call[0] === 'error'
        )?.[1] as ((event: any) => void) | undefined;
        expect(typeof errorListener).toBe('function');
        const preventDefaultError = vi.fn();
        const stopImmediatePropagationError = vi.fn();
        errorListener?.({
            message: '6000ms timeout exceeded',
            error: Object.assign(new Error('6000ms timeout exceeded'), { stack: '...fontfaceobserver...' }),
            preventDefault: preventDefaultError,
            stopImmediatePropagation: stopImmediatePropagationError,
        });
        expect(preventDefaultError).toHaveBeenCalledTimes(1);
        expect(stopImmediatePropagationError).toHaveBeenCalledTimes(1);
        errorListener?.({
            message: '6000ms timeout exceeded',
            error: Object.assign(new Error('6000ms timeout exceeded'), { stack: '' }),
            preventDefault: preventDefaultError,
            stopImmediatePropagation: stopImmediatePropagationError,
        });
        expect(preventDefaultError).toHaveBeenCalledTimes(2);
        expect(stopImmediatePropagationError).toHaveBeenCalledTimes(2);

        errorListener?.({
            message: '6000ms timeout exceeded',
            error: Object.assign(new Error('6000ms timeout exceeded'), { stack: '...FontFaceObserver...' }),
            preventDefault: preventDefaultError,
            stopImmediatePropagation: stopImmediatePropagationError,
        });
        expect(preventDefaultError).toHaveBeenCalledTimes(3);
        expect(stopImmediatePropagationError).toHaveBeenCalledTimes(3);

        const fontInitErrors = consoleErrorSpy.mock.calls.filter(
            (call) => call[0] === 'Failed to load fonts during init, continuing startup:'
        );
        expect(fontInitErrors).toHaveLength(0);
    });

    it('does not surface font loading timeouts as errors on web startup', async () => {
        const addEventListenerSpy = vi.spyOn(window, 'addEventListener');

        const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        loadAsyncMock.mockRejectedValueOnce(new Error('6000ms timeout exceeded'));

        const screen = await renderSettledRootLayout();

        // On web we no longer invoke expo-font at all (it uses FontFaceObserver with a hard-coded
        // timeout and can surface uncaught errors / unhandled rejections). Web fonts are injected
        // via `@font-face` rules instead.
        expect(loadAsyncMock).toHaveBeenCalledTimes(0);
        expect(screen.findAllByType(components.SidebarNavigator)).toHaveLength(1);
        // Non-automation web startup should not install global error suppression handlers.
        // Other web-only runtime helpers (viewport/safe-area) may still register resize listeners.
        const installedEvents = addEventListenerSpy.mock.calls.map((call) => call[0]);
        expect(installedEvents).not.toContain('error');
        expect(installedEvents).not.toContain('unhandledrejection');

        const fontInitErrors = consoleErrorSpy.mock.calls.filter(
            (call) => call[0] === 'Failed to load fonts during init, continuing startup:'
        );
        expect(fontInitErrors).toHaveLength(0);
    });

    it('does not install FontFaceObserver timeout suppression listeners on non-automation web startup', async () => {
        const addEventListenerSpy = vi.spyOn(window, 'addEventListener');

        const screen = await renderSettledRootLayout();

        expect(screen.findAllByType(components.SidebarNavigator)).toHaveLength(1);
        const installedEvents = addEventListenerSpy.mock.calls.map((call) => call[0]);
        expect(installedEvents).not.toContain('error');
        expect(installedEvents).not.toContain('unhandledrejection');
    });

    it('does not surface synchronous expo-font errors as console errors on web startup', async () => {
        const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        loadAsyncMock.mockImplementationOnce(() => {
            throw new Error('6000ms timeout exceeded');
        });

        const screen = await renderSettledRootLayout();

        expect(screen.findAllByType(components.SidebarNavigator)).toHaveLength(1);
        expect(loadAsyncMock).toHaveBeenCalledTimes(0);
        const fontInitErrors = consoleErrorSpy.mock.calls.filter(
            (call) => call[0] === 'Failed to load fonts during init, continuing startup:'
        );
        expect(fontInitErrors).toHaveLength(0);
    });

    it('treats DOM environments as web even when Platform.OS is misreported', async () => {
        // In some web builds/environments, Platform.OS can be surprising. If we're running with a DOM,
        // don't block startup on expo-font, since its FontFaceObserver path can time out.
        mockedPlatformOS = 'ios';
        retainDomOnNative = true;

        const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        loadAsyncMock.mockRejectedValueOnce(new Error('6000ms timeout exceeded'));

        const screen = await renderSettledRootLayout();

        expect(loadAsyncMock).toHaveBeenCalledTimes(0);
        expect(screen.findAllByType(components.SidebarNavigator)).toHaveLength(1);

        const fontInitErrors = consoleErrorSpy.mock.calls.filter(
            (call) => call[0] === 'Failed to load fonts during init, continuing startup:'
        );
        expect(fontInitErrors).toHaveLength(0);
    });

});
