import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PUSH_NOTIFICATION_ANDROID_CHANNEL_IDS } from '@happier-dev/protocol';
import type { RenderScreenResult } from '@/dev/testkit';
import { createUseLocalSettingMock } from '@/dev/testkit/mocks/storage';
import type {
    DesktopWindowChromePolicy,
    DesktopWindowState,
} from '@/utils/platform/desktopWindowBridge';
import { installRouteRootCommonModuleMocks } from './routeRootTestHelpers';

// Avoid React "act(...) environment" warnings in non-JSDOM test environments.
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const loadAsyncMock = vi.fn();
const syncRestoreMock = vi.fn(async () => {});
const hideAsyncMock = vi.fn(async () => {});
let mockedPlatformOS: string = 'web';
let mockedPathname = '/';
let mockedConfigVariant: string = '';
let sidebarNavigatorRenderMode: 'default' | 'tab-state-probe' = 'default';
const sentryInitMock = vi.fn();
const sentryMobileReplayIntegrationMock = vi.fn(() => ({ name: 'mobileReplayIntegration' }));
const sentryWrapMock = vi.fn((Component: any) => Component);
const routerPushMock = vi.fn();
const bootCredentialsState = vi.hoisted(() => ({
    value: null as null | { token: string; secret: string },
}));
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
const desktopWindowBridgeState = vi.hoisted(() => ({
    getDesktopWindowChromePolicy: vi.fn<() => Promise<DesktopWindowChromePolicy>>(async () => ({ strategy: 'none' })),
    getDesktopWindowState: vi.fn<() => Promise<DesktopWindowState>>(async () => ({ isMaximized: false })),
    listenDesktopWindowState: vi.fn<(handler: (state: DesktopWindowState) => void) => Promise<() => Promise<void>>>(async () => async () => {}),
    minimizeDesktopWindow: vi.fn(async () => {}),
    toggleDesktopWindowMaximize: vi.fn(async () => {}),
    closeDesktopWindow: vi.fn(async () => {}),
    startDesktopWindowDragging: vi.fn(async () => {}),
}));

const { fromModuleMock, trackingState, fontAwesomeFontMock, ioniconsFontMock, mainAppTabStateShim } = vi.hoisted(() => ({
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
    mainAppTabStateShim: {
        useMainAppTabState: null as null | (() => { activeTab: string; setActiveTab: () => Promise<void>; isLoading: boolean }),
    },
}));

vi.mock('react-native-quick-base64', () => ({}));
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

const consumeRestartBugReportIntentMock = vi.fn(async (..._args: unknown[]) => false);
vi.mock('@/utils/system/restartBugReportIntent', () => ({
    consumeRestartBugReportIntent: consumeRestartBugReportIntentMock,
}));

vi.mock('expo-font', () => ({
    loadAsync: loadAsyncMock,
}));

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

vi.mock('@expo/vector-icons', () => ({
    FontAwesome: { font: fontAwesomeFontMock },
    Ionicons: { font: ioniconsFontMock },
}));

vi.mock('@/auth/storage/tokenStorage', () => ({
    TokenStorage: {
        getCredentials: vi.fn(async () => null),
    },
    isLegacyAuthCredentials: (credentials: unknown) => Boolean(credentials),
}));

vi.mock('@/boot/resolveBootCredentials', () => ({
    resolveBootCredentials: vi.fn(async () => bootCredentialsState.value),
}));

vi.mock('@/utils/platform/desktopHost', () => ({
    isDesktopHost: () => shellChromeState.isDesktopHost,
    invokeDesktopHost: vi.fn(),
    listenDesktopHostEvent: vi.fn(),
}));

vi.mock('@/desktop/window/isDesktopOverlayWindowContext', () => ({
    isDesktopOverlayWindowContext: () => desktopOverlayWindowState.value,
}));

vi.mock('@/activity/adapters/desktop/runtime/isDesktopActivityOverlayWindowContext', () => ({
    isDesktopActivityOverlayWindowContext: () =>
        desktopOverlayWindowState.value && mockedPathname === '/desktop/activity-overlay',
}));

vi.mock('@/utils/platform/responsive', () => ({
    useIsTablet: () => shellChromeState.isTablet,
}));

vi.mock('@/utils/platform/desktopWindowBridge', () => ({
    getDesktopWindowChromePolicy: () => desktopWindowBridgeState.getDesktopWindowChromePolicy(),
    getDesktopWindowState: () => desktopWindowBridgeState.getDesktopWindowState(),
    listenDesktopWindowState: (handler: (state: { isMaximized: boolean }) => void) =>
        desktopWindowBridgeState.listenDesktopWindowState(handler),
    minimizeDesktopWindow: () => desktopWindowBridgeState.minimizeDesktopWindow(),
    toggleDesktopWindowMaximize: () => desktopWindowBridgeState.toggleDesktopWindowMaximize(),
    closeDesktopWindow: () => desktopWindowBridgeState.closeDesktopWindow(),
    startDesktopWindowDragging: () => desktopWindowBridgeState.startDesktopWindowDragging(),
}));

vi.mock('@/hooks/ui/useTabState', () => ({
    useTabState: () => ({
        activeTab: 'sessions',
        setActiveTab: vi.fn(async () => {}),
        isLoading: false,
    }),
}));

vi.mock('@/components/navigation/mobile/chrome/MainAppTabStateProvider', async () => {
    const React = await import('react');
    const Context = React.createContext<{
        activeTab: string;
        setActiveTab: () => Promise<void>;
        isLoading: boolean;
    } | null>(null);

    const useMainAppTabState = () => {
        const value = React.useContext(Context);
        if (!value) {
            throw new Error('useMainAppTabState must be used within MainAppTabStateProvider');
        }
        return value;
    };

    mainAppTabStateShim.useMainAppTabState = useMainAppTabState;

    return {
        MainAppTabStateProvider: ({ children }: { children: React.ReactNode }) =>
            React.createElement(
                Context.Provider,
                {
                    value: {
                        activeTab: 'sessions',
                        setActiveTab: async () => {},
                        isLoading: false,
                    },
                },
                children,
            ),
        useMainAppTabState,
    };
});

vi.mock('@/components/appShell/currentUiContext/CurrentUiContextProvider', () => ({
    CurrentUiContextProvider: ({ children }: { children: React.ReactNode }) => (
        React.createElement('CurrentUiContextProvider', null, children)
    ),
}));

installRouteRootCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock(
            {
                View: ({ children }: { children?: React.ReactNode }) => React.createElement('View', null, children),
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
            },
        );
    },
    router: async () => {
        const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
        const expoRouterMock = createExpoRouterMock({
            pathname: () => mockedPathname,
            router: { push: routerPushMock, back: vi.fn() },
        });
        return expoRouterMock.module;
    },
    storage: async (importOriginal) => {
        const { createStorageModuleMock } = await import('@/dev/testkit/mocks/storage');
        const useLocalSetting = createUseLocalSettingMock({ fallback: () => undefined });

        return createStorageModuleMock({
            importOriginal,
            overrides: {
                useLocalSetting,
            },
        });
    },
    unistyles: async () => {
        const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
        return createUnistylesMock({
            theme: {
                dark: false,
                colors: {
                    groupped: { background: '#fff' },
                    divider: '#ddd',
                    surface: '#fff',
                    text: '#111',
                    textSecondary: '#777',
                    header: { tint: '#111' },
                    button: { primary: { background: '#111', tint: '#fff' } },
                    accent: { indigo: '#55f' },
                    success: '#0a0',
                    warningCritical: '#f80',
                },
            },
        });
    },
});

vi.mock('@/auth/context/AuthContext', () => {
    const React = require('react');
    return {
        AuthProvider: ({ children }: { children: React.ReactNode }) => React.createElement('AuthProvider', null, children),
        useAuth: () => {
            const isAuthenticated = Boolean(bootCredentialsState.value);
            return {
                isAuthenticated,
                credentials: isAuthenticated ? bootCredentialsState.value : null,
                login: vi.fn(async () => {}),
                loginWithCredentials: vi.fn(async () => {}),
                logout: vi.fn(async () => {}),
                refreshFromActiveServer: vi.fn(async () => {}),
            };
        },
    };
});

vi.mock('@react-navigation/native', () => {
    const React = require('react');
    return {
        ThemeProvider: ({ children, ...props }: { children: React.ReactNode } & Record<string, unknown>) =>
            React.createElement('ThemeProvider', props, children),
        DarkTheme: { colors: {} },
        DefaultTheme: { colors: {} },
    };
});

vi.mock('react-native-keyboard-controller', () => {
    const React = require('react');
    return {
        KeyboardProvider: ({ children }: { children: React.ReactNode }) => React.createElement('KeyboardProvider', null, children),
    };
});

vi.mock('react-native-gesture-handler', () => {
    const React = require('react');
    return {
        GestureHandlerRootView: ({ children }: { children: React.ReactNode }) => React.createElement('GestureHandlerRootView', null, children),
    };
});

vi.mock('@/components/navigation/shell/SidebarNavigator', () => {
    const React = require('react');
    return {
        SidebarNavigator: () => {
            if (sidebarNavigatorRenderMode === 'tab-state-probe') {
                const tabState = mainAppTabStateShim.useMainAppTabState?.();
                if (!tabState) {
                    throw new Error('missing main app tab state shim');
                }
                return React.createElement('SidebarNavigator', {
                    testID: 'sidebar-navigator-tabstate-probe',
                    activeTab: tabState.activeTab,
                });
            }

            return React.createElement('SidebarNavigator');
        },
    };
});

vi.mock('@/components/navigation/desktopWindowChrome/DesktopMainContentDragSurface', () => {
    const React = require('react');
    return {
        DesktopMainContentDragSurface: (props: Record<string, unknown>) =>
            React.createElement('DesktopMainContentDragSurface', {
                ...props,
                testID: 'desktop-main-content-drag-surface',
            }, props.children),
    };
});

vi.mock('@/components/appShell/AppCrashRecoveryBoundary', () => {
    const React = require('react');
    return {
        AppCrashRecoveryBoundary: ({ children }: { children: React.ReactNode }) =>
            React.createElement('AppCrashRecoveryBoundary', { testID: 'app-crash-recovery-boundary' }, children),
    };
});

vi.mock('@/encryption/libsodium.lib', () => ({
    default: {
        ready: Promise.resolve(),
    },
}));

vi.mock('posthog-react-native', () => {
    const React = require('react');
    return {
        PostHogProvider: ({ children, ...props }: { children: React.ReactNode } & Record<string, unknown>) =>
            React.createElement('PostHogProvider', { testID: 'posthog-provider', ...props }, children),
    };
});

vi.mock('@/track/tracking', () => ({
    get tracking() {
        return trackingState.client;
    },
}));

vi.mock('@/track/settingsAnalytics/SettingsAnalyticsRuntime', () => {
    const React = require('react');
    return {
        SettingsAnalyticsRuntime: () => React.createElement('SettingsAnalyticsRuntime', { testID: 'settings-analytics-runtime' }),
    };
});

vi.mock('@/sync/sync', () => ({
    syncRestore: syncRestoreMock,
}));

vi.mock('@/track/useTrackScreens', () => ({
    useTrackScreens: () => {},
}));

vi.mock('@/realtime/RealtimeProvider', () => {
    const React = require('react');
    return {
        RealtimeProvider: ({ children }: { children: React.ReactNode }) => React.createElement(
            'RealtimeProvider',
            null,
            React.createElement('VoiceSessionRuntime'),
            children,
        ),
    };
});

vi.mock('@/components/web/FaviconPermissionIndicator', () => {
    const React = require('react');
    return {
        FaviconPermissionIndicator: () => React.createElement('FaviconPermissionIndicator'),
    };
});

vi.mock('@/components/appShell/commandPalette/CommandPaletteProvider', () => {
    const React = require('react');
    return {
        CommandPaletteProvider: ({ children }: { children: React.ReactNode }) => React.createElement('CommandPaletteProvider', null, children),
    };
});

vi.mock('@/components/ui/layout/StatusBarProvider', () => ({
    StatusBarProvider: () => null,
}));

vi.mock('@/components/ui/feedback/AppUpdateStatusTag', () => {
    const React = require('react');
    return {
        AppUpdateStatusTag: () => React.createElement('AppUpdateStatusTag'),
    };
});

vi.mock('@/utils/system/remoteLogger', () => ({
    monkeyPatchConsoleForRemoteLoggingForFasterAiAutoDebuggingOnlyInLocalBuilds: vi.fn(),
}));

describe('app/_layout init resilience', () => {
    const previousSentryDsn = process.env.EXPO_PUBLIC_SENTRY_DSN;
    const previousSentryLogs = process.env.EXPO_PUBLIC_SENTRY_ENABLE_LOGS;
    const previousSentryReplay = process.env.EXPO_PUBLIC_SENTRY_ENABLE_REPLAY;
    const previousSentryReplaySessionRate = process.env.EXPO_PUBLIC_SENTRY_REPLAYS_SESSION_SAMPLE_RATE;
    const previousSentryReplayOnErrorRate = process.env.EXPO_PUBLIC_SENTRY_REPLAYS_ON_ERROR_SAMPLE_RATE;

    afterEach(async () => {
        const { standardCleanup } = await import('@/dev/testkit');
        standardCleanup();
        // Ensure no test leaks fake timers into subsequent tests.
        vi.useRealTimers();
        sidebarNavigatorRenderMode = 'default';
        mockedPlatformOS = 'web';
        mockedPathname = '/';
        mockedConfigVariant = '';
        bootCredentialsState.value = null;
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
        desktopWindowBridgeState.getDesktopWindowState.mockResolvedValue({ isMaximized: false });
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
        consumeRestartBugReportIntentMock.mockClear();
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
        vi.resetModules();
        vi.clearAllMocks();
    });

    async function renderRootLayout(): Promise<RenderScreenResult> {
        const RootLayout = (await import('@/app/_layout')).default;
        const { renderScreen } = await import('@/dev/testkit');
        return renderScreen(React.createElement(RootLayout), { flushOptions: { cycles: 0 } });
    }

    async function renderSettledRootLayout(): Promise<RenderScreenResult> {
        const screen = await renderRootLayout();
        const { flushHookEffects } = await import('@/dev/testkit');
        await flushHookEffects();
        return screen;
    }

    it('wraps the root layout with Sentry.wrap', async () => {
        process.env.EXPO_PUBLIC_SENTRY_DSN = 'https://examplePublicKey@o0.ingest.sentry.io/0';
        await import('@/app/_layout');
        expect(sentryWrapMock).toHaveBeenCalledTimes(1);
        expect(typeof sentryWrapMock.mock.calls[0]?.[0]).toBe('function');
    });

    it('does not wrap the root layout with Sentry.wrap when EXPO_PUBLIC_SENTRY_DSN is unset', async () => {
        delete process.env.EXPO_PUBLIC_SENTRY_DSN;
        await import('@/app/_layout');
        expect(sentryWrapMock).toHaveBeenCalledTimes(0);
    });

    it('does not fail root layout import when expo notifications are unavailable on Android', async () => {
        mockedPlatformOS = 'android';
        notificationNativeState.unavailable = true;

        await expect(import('@/app/_layout')).resolves.toHaveProperty('default');
    });

    it('provides the main app tab state to the root sidebar shell', async () => {
        sidebarNavigatorRenderMode = 'tab-state-probe';

        const screen = await renderSettledRootLayout();

        const probes = screen.tree.findAll((node) =>
            node.props?.testID === 'sidebar-navigator-tabstate-probe' && node.props?.activeTab === 'sessions',
        );
        expect(probes).toHaveLength(1);
        expect(screen.findAllByType('RealtimeProvider' as any)).toHaveLength(1);
    });

    for (const platform of ['web', 'ios', 'android'] as const) {
        it(`mounts the realtime voice runtime beneath the one AppShell current UI provider on ${platform}`, async () => {
            mockedPlatformOS = platform;
            const screen = await renderSettledRootLayout();

            const currentUiProvider = screen.findByType('CurrentUiContextProvider' as any);
            expect(currentUiProvider.findAllByType('RealtimeProvider' as any)).toHaveLength(1);
            expect(currentUiProvider.findAllByType('VoiceSessionRuntime' as any)).toHaveLength(1);
        });
    }

    it('configures separate Android notification channels for permission/action request pushes', async () => {
        mockedPlatformOS = 'android';
        await import('@/app/_layout');

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
        expect(syncRestoreMock).not.toHaveBeenCalled();
        expect(screen.findByTestId('app-crash-recovery-boundary')).not.toBeNull();
        consoleErrorSpy.mockRestore();
    });

    it('skips sync restore inside the dedicated desktop activity overlay window', async () => {
        mockedPlatformOS = 'web';
        mockedPathname = '/desktop/activity-overlay';
        shellChromeState.isDesktopHost = true;
        desktopOverlayWindowState.value = true;
        bootCredentialsState.value = { token: 'overlay-token', secret: 'overlay-secret' };

        const screen = await renderSettledRootLayout();

        expect(screen.findAllByType('RealtimeProvider' as any)).toHaveLength(0);
        expect(screen.findAllByType('VoiceSessionRuntime' as any)).toHaveLength(0);
        expect(screen.findAllByType('CurrentUiContextProvider' as any)).toHaveLength(1);
        expect(syncRestoreMock).not.toHaveBeenCalled();
    });

    it('restores synced pet state while keeping the pet overlay free of realtime runtimes', async () => {
        mockedPlatformOS = 'web';
        mockedPathname = '/desktop/pet-overlay';
        shellChromeState.isDesktopHost = true;
        desktopOverlayWindowState.value = true;
        bootCredentialsState.value = { token: 'overlay-token', secret: 'overlay-secret' };

        const screen = await renderSettledRootLayout();

        expect(screen.findAllByType('RealtimeProvider' as any)).toHaveLength(0);
        expect(screen.findAllByType('SidebarNavigator' as any)).toHaveLength(1);
        expect(syncRestoreMock).toHaveBeenCalledTimes(1);
        expect(syncRestoreMock).toHaveBeenCalledWith(bootCredentialsState.value);
    });

    it('does not mount desktop fallback shell chrome inside the dedicated desktop overlay window', async () => {
        mockedPlatformOS = 'web';
        mockedPathname = '/desktop/activity-overlay';
        bootCredentialsState.value = { token: 'overlay-token', secret: 'overlay-secret' };
        shellChromeState.isDesktopHost = true;
        shellChromeState.isTablet = false;
        desktopOverlayWindowState.value = true;
        desktopWindowBridgeState.getDesktopWindowChromePolicy.mockResolvedValue({ strategy: 'native-macos-traffic-lights' });

        const screen = await renderSettledRootLayout();

        expect(screen.findAllByTestId('desktop-narrow-shell-chrome')).toHaveLength(0);
        expect(screen.findAllByTestId('desktop-focus-mode-shell-chrome')).toHaveLength(0);
        expect(screen.findAllByType('AppUpdateStatusTag' as any)).toHaveLength(0);
    });

    it('uses a transparent navigation background inside the dedicated desktop overlay window', async () => {
        mockedPlatformOS = 'web';
        mockedPathname = '/desktop/activity-overlay';
        bootCredentialsState.value = { token: 'overlay-token', secret: 'overlay-secret' };
        shellChromeState.isDesktopHost = true;
        desktopOverlayWindowState.value = true;

        const screen = await renderSettledRootLayout();

        const themeProvider = screen.findByType('ThemeProvider' as any);
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

        expect(screen.findByTestId('app-crash-recovery-boundary')).toBeTruthy();
    });

    it('mounts favicon permission signaling inside AppCrashRecoveryBoundary for ordinary routes', async () => {
        mockedPlatformOS = 'ios';
        mockedPathname = '/';
        const screen = await renderSettledRootLayout();

        const boundary = screen.findByTestId('app-crash-recovery-boundary');
        expect(boundary).toBeTruthy();
        expect(boundary!.findAllByType('FaviconPermissionIndicator' as any)).toHaveLength(1);
    });

    it('keeps the shell navigator mounted while hiding the shell update tag for terminal-connect routes', async () => {
        mockedPathname = '/terminal/connect';
        const screen = await renderSettledRootLayout();

        expect(screen.findAllByType('SidebarNavigator' as any)).toHaveLength(1);
        expect(screen.findAllByType('AppUpdateStatusTag' as any)).toHaveLength(0);
        expect(screen.findAllByType('FaviconPermissionIndicator' as any)).toHaveLength(0);
    });

    it('mounts the shell update tag on ordinary app routes', async () => {
        mockedPathname = '/';
        const screen = await renderSettledRootLayout();

        expect(screen.findAllByType('SidebarNavigator' as any)).toHaveLength(1);
        expect(screen.findAllByType('AppUpdateStatusTag' as any)).toHaveLength(1);
    });

    it('does not mount a root-shell update tag for unauthenticated desktop flows owned by the pre-auth host', async () => {
        mockedPathname = '/';
        shellChromeState.isDesktopHost = true;

        const screen = await renderSettledRootLayout();

        expect(screen.findAllByType('SidebarNavigator' as any)).toHaveLength(1);
        expect(screen.findAllByType('AppUpdateStatusTag' as any)).toHaveLength(0);
        expect(screen.findAllByTestId('desktop-focus-mode-shell-chrome')).toHaveLength(0);
        expect(screen.findAllByTestId('desktop-narrow-shell-chrome')).toHaveLength(0);
        const dragSurface = screen.findByTestId('desktop-main-content-drag-surface');
        expect(dragSurface?.props.enabled).toBe(true);
        expect(dragSurface?.props.leftOffsetPx).toBe(0);
    });

    it('keeps desktop shell chrome inside the sidebar host for authenticated wide desktop flows', async () => {
        mockedPathname = '/';
        bootCredentialsState.value = { token: 'token', secret: 'secret' };
        shellChromeState.isDesktopHost = true;
        shellChromeState.isTablet = true;
        desktopWindowBridgeState.getDesktopWindowChromePolicy.mockResolvedValue({ strategy: 'native-macos-traffic-lights' });

        const screen = await renderSettledRootLayout();

        expect(screen.findAllByTestId('desktop-focus-mode-shell-chrome')).toHaveLength(0);
        expect(screen.findAllByTestId('desktop-narrow-shell-chrome')).toHaveLength(0);
        expect(screen.findAllByTestId('desktop-main-content-drag-surface')).toHaveLength(0);
        expect(screen.findAllByType('SidebarNavigator' as any)).toHaveLength(1);
    });

    it('renders an explicit narrow-desktop fallback host instead of folding it into focus-mode fallback', async () => {
        mockedPathname = '/';
        bootCredentialsState.value = { token: 'token', secret: 'secret' };
        shellChromeState.isDesktopHost = true;
        shellChromeState.isTablet = false;
        desktopWindowBridgeState.getDesktopWindowChromePolicy.mockResolvedValue({ strategy: 'native-macos-traffic-lights' });

        const screen = await renderSettledRootLayout();

        expect(screen.findByTestId('desktop-narrow-shell-chrome')).toBeTruthy();
        expect(screen.findAllByTestId('desktop-focus-mode-shell-chrome')).toHaveLength(0);
        expect(screen.findByTestId('desktop-window-controls-slot')).toBeTruthy();
        const dragSurface = screen.findByTestId('desktop-main-content-drag-surface');
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
        expect(screen.findByTestId('settings-analytics-runtime')).toBeTruthy();
    });

    it('navigates to the bug report screen on boot when a restart bug report intent is present', async () => {
        mockedPlatformOS = 'ios';
        consumeRestartBugReportIntentMock.mockResolvedValueOnce(true);

        await renderSettledRootLayout();

        expect(routerPushMock).toHaveBeenCalledWith('/(app)/settings/report-issue');
    });

    it('keeps web startup pending until every injected font family load settles', async () => {
        mockedPlatformOS = 'web';
        fromModuleMock.mockImplementation(() => ({ uri: 'https://example.com/font.ttf' }));

        const appended: any[] = [];
        const appendChild = vi.fn((node: any) => {
            appended.push(node);
        });
        const fontLoadResolvers: Array<() => void> = [];
        const fontLoadMock = vi.fn(() => new Promise<FontFace[]>((resolve) => {
            fontLoadResolvers.push(() => resolve([]));
        }));

        Object.defineProperty(globalThis, 'document', {
            value: {
                getElementById: vi.fn(() => null),
                createElement: vi.fn(() => ({ textContent: '', id: '' })),
                head: { appendChild },
                fonts: { load: fontLoadMock },
            },
            configurable: true,
        });

        const screen = await renderRootLayout();
        const { flushHookEffects } = await import('@/dev/testkit');
        await flushHookEffects({ cycles: 1 });

        expect(loadAsyncMock).toHaveBeenCalledTimes(0);
        expect(fontLoadMock).toHaveBeenCalledTimes(10);
        expect(fontLoadMock).toHaveBeenCalledWith('1em "Inter-Regular"');
        expect(fontLoadMock).toHaveBeenCalledWith('1em "IBMPlexMono-Regular"');
        expect(screen.findByTestId('app-crash-recovery-boundary')).toBeNull();

        for (const resolveFontLoad of fontLoadResolvers.slice(0, -1)) {
            resolveFontLoad();
        }
        await flushHookEffects({ cycles: 1 });
        expect(screen.findByTestId('app-crash-recovery-boundary')).toBeNull();

        fontLoadResolvers.at(-1)?.();
        await flushHookEffects();

        // We inject a <style> for @font-face rules and also add a <style> for UI font scaling overrides.
        expect(appendChild).toHaveBeenCalledTimes(2);
        const texts = appended.map((n) => String(n?.textContent ?? ''));
        expect(texts.some((t) => t.includes('@font-face'))).toBe(true);
        expect(texts.some((t) => t.includes('Inter-Regular'))).toBe(true);
        expect(texts.some((t) => t.includes('example.com/font.ttf'))).toBe(true);
        expect(screen.findByTestId('app-crash-recovery-boundary')).not.toBeNull();
    });

    it('continues web startup after injected font family loads fail', async () => {
        mockedPlatformOS = 'web';
        fromModuleMock.mockImplementation(() => ({ uri: 'https://example.com/font.ttf' }));
        const fontLoadMock = vi.fn(async () => {
            throw new Error('font unavailable');
        });

        Object.defineProperty(globalThis, 'document', {
            value: {
                getElementById: vi.fn(() => null),
                createElement: vi.fn(() => ({ textContent: '', id: '' })),
                head: { appendChild: vi.fn() },
                fonts: { load: fontLoadMock },
            },
            configurable: true,
        });

        const screen = await renderSettledRootLayout();

        expect(fontLoadMock).toHaveBeenCalledTimes(10);
        expect(screen.findByTestId('app-crash-recovery-boundary')).not.toBeNull();
    });

    it('continues web startup when FontFaceSet is unavailable', async () => {
        mockedPlatformOS = 'web';
        fromModuleMock.mockImplementation(() => ({ uri: 'https://example.com/font.ttf' }));

        Object.defineProperty(globalThis, 'document', {
            value: {
                getElementById: vi.fn(() => null),
                createElement: vi.fn(() => ({ textContent: '', id: '' })),
                head: { appendChild: vi.fn() },
            },
            configurable: true,
        });

        const screen = await renderSettledRootLayout();

        expect(loadAsyncMock).not.toHaveBeenCalled();
        expect(screen.findByTestId('app-crash-recovery-boundary')).not.toBeNull();
    });

    it('continues web startup when the font-face stylesheet cannot be injected', async () => {
        mockedPlatformOS = 'web';
        fromModuleMock.mockImplementation(() => ({ uri: 'https://example.com/font.ttf' }));
        const fontLoadMock = vi.fn(async () => []);
        const appendChild = vi.fn((node: { id?: string }) => {
            if (node.id === 'happier-web-font-faces') {
                throw new Error('stylesheet unavailable');
            }
        });

        Object.defineProperty(globalThis, 'document', {
            value: {
                getElementById: vi.fn(() => null),
                createElement: vi.fn(() => ({ textContent: '', id: '' })),
                head: { appendChild },
                fonts: { load: fontLoadMock },
            },
            configurable: true,
        });

        const screen = await renderSettledRootLayout();

        expect(appendChild).toHaveBeenCalledWith(expect.objectContaining({
            id: 'happier-web-font-faces',
        }));
        expect(fontLoadMock).not.toHaveBeenCalled();
        expect(screen.findByTestId('app-crash-recovery-boundary')).not.toBeNull();
    });

    it('does not surface font loading timeouts as errors in web automation contexts', async () => {
        // Playwright (and other automation) sets navigator.webdriver=true. In that context, expo-font's
        // web FontFaceObserver path can time out even when font files are reachable (headless quirks).
        // We should not show startup error overlays for that case.
        Object.defineProperty(globalThis, 'navigator', {
            value: { webdriver: true, userAgent: 'HeadlessChrome' },
            configurable: true,
        });
        const addEventListenerSpy = vi.fn();
        Object.defineProperty(globalThis, 'window', {
            value: { addEventListener: addEventListenerSpy },
            configurable: true,
        });

        const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        loadAsyncMock.mockRejectedValueOnce(new Error('6000ms timeout exceeded'));

        const screen = await renderSettledRootLayout();

        // In automation contexts, skip expo-font on web entirely to avoid FontFaceObserver's
        // timeout behavior surfacing as dev overlays (uncaught errors / unhandled rejections).
        expect(loadAsyncMock).toHaveBeenCalledTimes(0);
        expect(screen.findByTestId('app-crash-recovery-boundary')).not.toBeNull();

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
        const addEventListenerSpy = vi.fn();
        Object.defineProperty(globalThis, 'window', {
            value: { addEventListener: addEventListenerSpy },
            configurable: true,
        });

        const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        loadAsyncMock.mockRejectedValueOnce(new Error('6000ms timeout exceeded'));

        const screen = await renderSettledRootLayout();

        // On web we no longer invoke expo-font at all (it uses FontFaceObserver with a hard-coded
        // timeout and can surface uncaught errors / unhandled rejections). Web fonts are injected
        // via `@font-face` rules instead.
        expect(loadAsyncMock).toHaveBeenCalledTimes(0);
        expect(screen.findByTestId('app-crash-recovery-boundary')).not.toBeNull();
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
        const addEventListenerSpy = vi.fn();
        Object.defineProperty(globalThis, 'window', {
            value: { addEventListener: addEventListenerSpy },
            configurable: true,
        });

        const screen = await renderSettledRootLayout();

        expect(screen.findByTestId('app-crash-recovery-boundary')).not.toBeNull();
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

        expect(screen.findByTestId('app-crash-recovery-boundary')).not.toBeNull();
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
        Object.defineProperty(globalThis, 'document', { value: {}, configurable: true });
        Object.defineProperty(globalThis, 'window', { value: {}, configurable: true });

        const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        loadAsyncMock.mockRejectedValueOnce(new Error('6000ms timeout exceeded'));

        const screen = await renderSettledRootLayout();

        expect(loadAsyncMock).toHaveBeenCalledTimes(0);
        expect(screen.findByTestId('app-crash-recovery-boundary')).not.toBeNull();

        const fontInitErrors = consoleErrorSpy.mock.calls.filter(
            (call) => call[0] === 'Failed to load fonts during init, continuing startup:'
        );
        expect(fontInitErrors).toHaveLength(0);
    });

});
