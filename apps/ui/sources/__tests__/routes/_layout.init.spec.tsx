import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { PUSH_NOTIFICATION_ANDROID_CHANNEL_IDS } from '@happier-dev/protocol';
import type { RenderScreenResult } from '@/dev/testkit';
import { installRouteRootCommonModuleMocks } from './routeRootTestHelpers';

// Avoid React "act(...) environment" warnings in non-JSDOM test environments.
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const loadAsyncMock = vi.fn();
const syncRestoreMock = vi.fn(async () => {});
const hideAsyncMock = vi.fn(async () => {});
let mockedPlatformOS: string = 'web';
let mockedPathname = '/';
let mockedConfigVariant: string = '';
const sentryInitMock = vi.fn();
const sentryMobileReplayIntegrationMock = vi.fn(() => ({ name: 'mobileReplayIntegration' }));
const sentryWrapMock = vi.fn((Component: any) => Component);
const routerPushMock = vi.fn();
const bootCredentialsState = vi.hoisted(() => ({
    value: null as null | { token: string; secret: string },
}));
const shellChromeState = vi.hoisted(() => ({
    isTauriDesktop: false,
    isTablet: true,
}));
const desktopPetOverlayWindowState = vi.hoisted(() => ({
    value: false,
}));
const authContextState = vi.hoisted(() => ({
    liveIsAuthenticated: null as boolean | null,
}));
const notificationNativeState = vi.hoisted(() => ({
    unavailable: false,
}));
const chromeSafeAreaWarmupMock = vi.hoisted(() => vi.fn(() => ({ top: 0, bottom: 0, left: 0, right: 0 })));
const desktopSetupInspectMock = vi.hoisted(() => vi.fn(async () => ({ status: 'pending' as const })));

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

vi.mock('@/utils/platform/tauri', () => ({
    isTauriDesktop: () => shellChromeState.isTauriDesktop,
    invokeTauri: vi.fn(),
    // Mirrors the real contract: `listenTauriEvent` is async, so it always resolves an unlisten
    // function. A bare `vi.fn()` resolves nothing and breaks every listener registered at boot.
    listenTauriEvent: vi.fn(async () => () => {}),
}));

vi.mock('@/utils/platform/responsive', () => ({
    useIsTablet: () => shellChromeState.isTablet,
}));

vi.mock('@/setup/desktopSetupCoordinator', () => ({
    desktopSetupCoordinator: {
        inspect: desktopSetupInspectMock,
        readObservedExpectation: () => null,
        startSetup: vi.fn(),
        reconcile: vi.fn(),
    },
}));

/**
 * The Tauri external-link installer patches `window.open`, a DOM boundary this node harness does
 * not have; the root only has to call it, which is not what these cases observe.
 */
vi.mock('@/utils/url/installTauriExternalLinkClicks', () => ({
    installTauriExternalLinkClicks: () => () => {},
}));

/**
 * R11 — the one setup lifecycle's mount. Probed as an element: its own behaviour is proven with the
 * real gate in `setup/useDesktopLocalSetupGate.test.tsx`; this file owns only where it is mounted.
 */
vi.mock('@/setup/DesktopLocalSetupRuntime', () => ({
    DesktopLocalSetupRuntime: () => React.createElement('DesktopLocalSetupRuntime'),
}));

vi.mock('@/components/pets/desktop/runtime/isDesktopPetOverlayWindowContext', () => ({
    isDesktopPetOverlayWindowContext: () => desktopPetOverlayWindowState.value,
}));

vi.mock('@/components/ui/layout/useChromeSafeAreaInsets', () => ({
    useChromeSafeAreaInsets: chromeSafeAreaWarmupMock,
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
    unistyles: async () => {
        const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
        return createUnistylesMock({
            theme: {
                dark: false,
                colors: {
                    groupped: { background: '#fff' },
                },
            },
        });
    },
});

vi.mock('@/auth/context/AuthContext', () => {
    const React = require('react');
    return {
        AuthProvider: ({ children, initialCredentials }: { children: React.ReactNode; initialCredentials: unknown }) => {
            const isAuthenticated = authContextState.liveIsAuthenticated ?? Boolean(initialCredentials);
            return React.createElement('AuthProvider', { isAuthenticated }, children);
        },
        useAuth: () => {
            const isAuthenticated = authContextState.liveIsAuthenticated ?? Boolean(bootCredentialsState.value);
            return {
                isAuthenticated,
                credentials: isAuthenticated ? (bootCredentialsState.value ?? { token: 'live-token', secret: 'live-secret' }) : null,
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
        ThemeProvider: ({ children }: { children: React.ReactNode }) => React.createElement('ThemeProvider', null, children),
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

vi.mock('react-native-safe-area-context', () => {
    const React = require('react');
    return {
        initialWindowMetrics: {} as any,
        SafeAreaProvider: ({ children }: { children: React.ReactNode }) => React.createElement('SafeAreaProvider', null, children),
        useSafeAreaInsets: () => ({ left: 0, right: 0, top: 0, bottom: 0 }),
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
        SidebarNavigator: (props: Record<string, unknown>) => React.createElement('SidebarNavigator', props),
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
        PostHogProvider: ({ children }: { children: React.ReactNode }) =>
            React.createElement('PostHogProvider', { testID: 'posthog-provider' }, children),
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
        RealtimeProvider: ({ children }: { children: React.ReactNode }) => React.createElement('RealtimeProvider', null, children),
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

vi.mock('@/updates/UpdateFactsBackgroundRuntime', () => ({
    UpdateFactsBackgroundRuntime: () => null,
}));

// The root layout's Updates summary host; its classification has its own owner tests.
vi.mock('@/updates/useUpdatesSummary', () => ({
    UpdatesSummaryProvider: ({ children }: { children: React.ReactNode }) => children,
    useSharedUpdatesSummary: () => ({ actionableCount: 0, failedCount: 0, runningCount: 0, phase: 'none', status: 'upToDate', visible: false }),
}));

vi.mock('@/components/updates/UpdatesPopoverButton', () => {
    const React = require('react');
    return {
        UpdatesEntry: (props: Record<string, unknown>) =>
            React.createElement('UpdatesEntry', props),
    };
});

vi.mock('@/components/navigation/shell/desktopChrome/DesktopShellWindowControlsHost', () => {
    const React = require('react');
    return {
        DesktopShellWindowControlsHost: ({ children }: { children?: React.ReactNode }) =>
            React.createElement('DesktopShellWindowControlsHost', { testID: 'desktop-window-controls-host' }, children),
    };
});

vi.mock('@/components/navigation/shell/desktopChrome/DesktopShellUpdateIndicatorHost', () => {
    const React = require('react');
    return {
        DesktopShellUpdateIndicatorHost: ({ children }: { children?: React.ReactNode }) =>
            React.createElement('DesktopShellUpdateIndicatorHost', { testID: 'desktop-update-indicator-host' }, children),
    };
});

vi.mock('@/components/navigation/shell/desktopChrome/useResolvedDesktopWindowControls', () => {
    const React = require('react');
    return {
        useResolvedDesktopWindowControls: () => React.createElement('DesktopWindowControls', {
            testID: 'desktop-window-controls',
        }),
    };
});

vi.mock('@/utils/system/remoteLogger', () => ({
    monkeyPatchConsoleForRemoteLoggingForFasterAiAutoDebuggingOnlyInLocalBuilds: vi.fn(),
}));

describe('app/_layout init resilience', () => {
    beforeEach(() => {
        // Exercise real boot/draft preparation against the browser database boundary.
        vi.stubGlobal('indexedDB', new IDBFactory());
    });
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
        mockedPlatformOS = 'web';
        mockedPathname = '/';
        mockedConfigVariant = '';
        bootCredentialsState.value = null;
        shellChromeState.isTauriDesktop = false;
        shellChromeState.isTablet = true;
        desktopPetOverlayWindowState.value = false;
        authContextState.liveIsAuthenticated = null;
        notificationNativeState.unavailable = false;
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
        chromeSafeAreaWarmupMock.mockClear();
        desktopSetupInspectMock.mockClear();
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
        const { prepareSessionDraftPersistenceStorage } = await import('@/sync/ops/sessionDrafts/sessionDraftPersistenceStorage');
        await React.act(async () => { await prepareSessionDraftPersistenceStorage(); });
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

    it('wraps the provider stack with AppCrashRecoveryBoundary', async () => {
        mockedPlatformOS = 'ios';
        const screen = await renderSettledRootLayout();

        expect(screen.findByTestId('app-crash-recovery-boundary')).toBeTruthy();
    });

    it('mounts favicon permission signaling inside AppCrashRecoveryBoundary', async () => {
        mockedPlatformOS = 'web';
        const screen = await renderSettledRootLayout();

        const boundary = screen.findByTestId('app-crash-recovery-boundary');
        expect(boundary).toBeTruthy();
        expect(boundary!.findAllByType('FaviconPermissionIndicator')).toHaveLength(1);
    });

    it('warms chrome safe-area insets inside the root provider stack', async () => {
        mockedPlatformOS = 'ios';

        await renderSettledRootLayout();

        expect(chromeSafeAreaWarmupMock).toHaveBeenCalled();
    });

    it('mounts the settings analytics runtime inside PostHogProvider when tracking is enabled', async () => {
        mockedPlatformOS = 'ios';
        trackingState.client = {
            identify: vi.fn(),
            group: vi.fn(),
            capture: vi.fn(),
        };
        const screen = await renderSettledRootLayout();

        expect(screen.findByTestId('posthog-provider')).toBeTruthy();
        expect(screen.findByTestId('settings-analytics-runtime')).toBeTruthy();
    });

    it('navigates to the bug report screen on boot when a restart bug report intent is present', async () => {
        mockedPlatformOS = 'ios';
        consumeRestartBugReportIntentMock.mockResolvedValueOnce(true);

        await renderSettledRootLayout();

        expect(routerPushMock).toHaveBeenCalledWith('/settings/report-issue');
    });

    it('loads every injected web font family before completing startup', async () => {
        mockedPlatformOS = 'web';
        fromModuleMock.mockImplementation(() => ({ uri: 'https://example.com/font.ttf' }));

        const appended: any[] = [];
        const appendChild = vi.fn((node: any) => {
            appended.push(node);
        });
        const fontLoadMock = vi.fn(async () => [] as FontFace[]);

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

        expect(loadAsyncMock).toHaveBeenCalledTimes(0);
        expect(fontLoadMock).toHaveBeenCalledTimes(10);
        expect(fontLoadMock).toHaveBeenCalledWith('1em "Inter-Regular"');
        expect(fontLoadMock).toHaveBeenCalledWith('1em "IBMPlexMono-Regular"');

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
        expect(addEventListenerSpy).not.toHaveBeenCalled();

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
        expect(addEventListenerSpy).not.toHaveBeenCalled();
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

    it('floats no update chrome over web content: the sidebar pill is the one entry (R13 (e))', async () => {
        shellChromeState.isTauriDesktop = false;

        const screen = await renderSettledRootLayout();

        expect(screen.findAllByTestId('root-shell-updates-button')).toHaveLength(0);
        expect(screen.findAllByTestId('desktop-fallback-shell-chrome')).toHaveLength(0);
    });

    it('renders fallback desktop controls and update tag for unauthenticated Tauri desktop setup flows', async () => {
        shellChromeState.isTauriDesktop = true;
        shellChromeState.isTablet = true;

        const screen = await renderSettledRootLayout();

        expect(screen.findAllByTestId('desktop-fallback-shell-chrome')).toHaveLength(1);
        expect(screen.findAllByTestId('desktop-window-controls-host')).toHaveLength(1);
        expect(screen.findAllByTestId('root-shell-updates-button').length).toBeGreaterThan(0);
        const dragSurface = screen.findByTestId('desktop-main-content-drag-surface');
        expect(dragSurface?.props.enabled).toBe(true);
        expect(dragSurface?.props.leftOffsetPx).toBe(0);
    });

    it('preserves the navigation subtree when Tauri chrome moves between wide and narrow hosts', async () => {
        bootCredentialsState.value = { token: 'token', secret: 'secret' };
        shellChromeState.isTauriDesktop = true;
        shellChromeState.isTablet = true;
        const screen = await renderSettledRootLayout();
        const navigator = screen.tree.findByType('SidebarNavigator' as any);
        const RootLayout = (await import('@/app/_layout')).default;
        for (const isTablet of [false, true]) {
            shellChromeState.isTablet = isTablet;
            await screen.update(React.createElement(RootLayout));
            expect(screen.tree.findByType('SidebarNavigator' as any) === navigator).toBe(true);
        }
    });

    it('keeps authenticated wide Tauri desktop chrome in the sidebar host', async () => {
        bootCredentialsState.value = { token: 'token', secret: 'secret' };
        shellChromeState.isTauriDesktop = true;
        shellChromeState.isTablet = true;

        const screen = await renderSettledRootLayout();
        expect(screen.tree.findAllByType('SidebarNavigator' as any)).toHaveLength(1);

        expect(screen.findAllByTestId('desktop-fallback-shell-chrome')).toHaveLength(0);
        expect(screen.findAllByTestId('root-shell-updates-button')).toHaveLength(0);
        expect(screen.findByTestId('desktop-main-content-drag-surface')?.props.enabled).toBe(false);
    });

    it('moves Tauri desktop chrome to the sidebar host after live auth changes from unauthenticated boot', async () => {
        shellChromeState.isTauriDesktop = true;
        shellChromeState.isTablet = true;
        authContextState.liveIsAuthenticated = true;

        const screen = await renderSettledRootLayout();
        expect(screen.tree.findAllByType('SidebarNavigator' as any)).toHaveLength(1);

        expect(screen.findAllByTestId('desktop-fallback-shell-chrome')).toHaveLength(0);
        expect(screen.findAllByTestId('root-shell-updates-button')).toHaveLength(0);
    });

    it('renders fallback desktop controls and update tag when authenticated Tauri desktop is narrow', async () => {
        bootCredentialsState.value = { token: 'token', secret: 'secret' };
        shellChromeState.isTauriDesktop = true;
        shellChromeState.isTablet = false;

        const screen = await renderSettledRootLayout();

        expect(screen.findAllByTestId('desktop-fallback-shell-chrome')).toHaveLength(1);
        expect(screen.findAllByTestId('desktop-window-controls-host')).toHaveLength(1);
        expect(screen.findAllByTestId('root-shell-updates-button').length).toBeGreaterThan(0);
        const dragSurface = screen.findByTestId('desktop-main-content-drag-surface');
        expect(dragSurface?.props.enabled).toBe(true);
        expect(dragSurface?.props.leftOffsetPx).toBe(0);
    });

    it('restores sync state in the desktop pet overlay window without rendering root shell update chrome', async () => {
        bootCredentialsState.value = { token: 'token', secret: 'secret' };
        shellChromeState.isTauriDesktop = true;
        shellChromeState.isTablet = false;
        desktopPetOverlayWindowState.value = true;

        const screen = await renderSettledRootLayout();

        expect(screen.findAllByTestId('desktop-fallback-shell-chrome')).toHaveLength(0);
        expect(screen.findAllByTestId('root-shell-updates-button')).toHaveLength(0);
        expect(screen.findByTestId('desktop-main-content-drag-surface')?.props.enabled).toBe(false);
        expect(syncRestoreMock).toHaveBeenCalledWith({ token: 'token', secret: 'secret' });
    });

    it('keeps file windows free of main-window setup and fallback chrome', async () => {
        bootCredentialsState.value = { token: 'token', secret: 'secret' };
        shellChromeState.isTauriDesktop = true;
        shellChromeState.isTablet = false;
        mockedPathname = '/file-window';
        vi.stubGlobal('window', {
            location: { href: 'http://localhost/file-window?sessionId=s1&path=note.md' },
            addEventListener: vi.fn(),
            removeEventListener: vi.fn(),
        });

        const screen = await renderSettledRootLayout();

        expect(desktopSetupInspectMock).not.toHaveBeenCalled();
        expect(screen.tree.findAllByType('DesktopLocalSetupRuntime' as any)).toHaveLength(0);
        expect(screen.findAllByTestId('desktop-fallback-shell-chrome')).toHaveLength(0);
        expect(screen.findByTestId('desktop-main-content-drag-surface')?.props.enabled).toBe(false);
        expect(syncRestoreMock).toHaveBeenCalledWith({ token: 'token', secret: 'secret' });
    });

    it('warms the local readiness inspection as soon as the desktop app opens, before anyone signs in (R5/INV4)', async () => {
        // The whole point of R5: acquisition and the read-only inspection are local Tauri IPC, so
        // they must not wait for authentication. Before this mount existed the only caller sat
        // behind the authenticated root, so every user paid the full round trip after login.
        bootCredentialsState.value = null;
        shellChromeState.isTauriDesktop = true;

        const screen = await renderSettledRootLayout();

        expect(screen.findAllByTestId('desktop-fallback-shell-chrome')).toHaveLength(1);
        expect(desktopSetupInspectMock).toHaveBeenCalledTimes(1);
        // INV4: invisible. The warm-up renders nothing, so no setup chrome reaches the welcome screen.
        expect(screen.findAllByTestId('setup-surface')).toHaveLength(0);
    });

    it('warms the inspection exactly once across re-renders of the root shell', async () => {
        bootCredentialsState.value = null;
        shellChromeState.isTauriDesktop = true;
        shellChromeState.isTablet = true;

        const screen = await renderSettledRootLayout();
        const RootLayout = (await import('@/app/_layout')).default;
        shellChromeState.isTablet = false;
        await screen.update(React.createElement(RootLayout));
        const { flushHookEffects } = await import('@/dev/testkit');
        await flushHookEffects();

        expect(desktopSetupInspectMock).toHaveBeenCalledTimes(1);
    });

    it('never warms local readiness off Tauri desktop or in the pet overlay window', async () => {
        shellChromeState.isTauriDesktop = false;
        await renderSettledRootLayout();
        expect(desktopSetupInspectMock).not.toHaveBeenCalled();

        const { standardCleanup } = await import('@/dev/testkit');
        standardCleanup();
        shellChromeState.isTauriDesktop = true;
        desktopPetOverlayWindowState.value = true;
        await renderSettledRootLayout();

        expect(desktopSetupInspectMock).not.toHaveBeenCalled();
    });

    it('runs the one setup lifecycle at the authenticated desktop shell, whatever route opened the app (R11)', async () => {
        // A cold deep link never renders the Home route, so a lifecycle mounted there skipped the
        // inspection, the quiet start and readiness for every launch that did not land on `/`.
        bootCredentialsState.value = { token: 'token', secret: 'secret' };
        shellChromeState.isTauriDesktop = true;
        mockedPathname = '/settings';

        const screen = await renderSettledRootLayout();

        expect(screen.tree.findAllByType('DesktopLocalSetupRuntime' as any)).toHaveLength(1);
    });

    it('never mounts the setup lifecycle before sign-in, off desktop, or in the pet overlay window', async () => {
        const { standardCleanup } = await import('@/dev/testkit');
        shellChromeState.isTauriDesktop = true;
        bootCredentialsState.value = null;
        const unauthenticated = await renderSettledRootLayout();
        expect(unauthenticated.tree.findAllByType('DesktopLocalSetupRuntime' as any)).toHaveLength(0);

        standardCleanup();
        bootCredentialsState.value = { token: 'token', secret: 'secret' };
        shellChromeState.isTauriDesktop = false;
        const web = await renderSettledRootLayout();
        expect(web.tree.findAllByType('DesktopLocalSetupRuntime' as any)).toHaveLength(0);

        standardCleanup();
        shellChromeState.isTauriDesktop = true;
        desktopPetOverlayWindowState.value = true;
        const overlay = await renderSettledRootLayout();
        expect(overlay.tree.findAllByType('DesktopLocalSetupRuntime' as any)).toHaveLength(0);
    });
});
