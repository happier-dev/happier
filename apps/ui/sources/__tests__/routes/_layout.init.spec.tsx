import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import renderer, { act } from 'react-test-renderer';
import { PUSH_NOTIFICATION_ANDROID_CHANNEL_IDS } from '@happier-dev/protocol';

// Avoid React "act(...) environment" warnings in non-JSDOM test environments.
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const loadAsyncMock = vi.fn();
const syncRestoreMock = vi.fn(async () => {});
const hideAsyncMock = vi.fn(async () => {});
let mockedPlatformOS: string = 'web';
let mockedConfigVariant: string = '';
const sentryInitMock = vi.fn();
const sentryMobileReplayIntegrationMock = vi.fn(() => ({ name: 'mobileReplayIntegration' }));
const sentryWrapMock = vi.fn((Component: any) => Component);
const routerPushMock = vi.fn();

const { fromModuleMock } = vi.hoisted(() => ({
    fromModuleMock: vi.fn(),
}));

vi.mock('react-native-quick-base64', () => ({}));

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

vi.mock('expo-router', () => ({
    useRouter: () => ({ push: routerPushMock, back: vi.fn() }),
}));

vi.mock('expo-font', () => ({
    loadAsync: loadAsyncMock,
}));

vi.mock('expo-asset', () => ({
    Asset: {
        fromModule: (...args: any[]) => (fromModuleMock as any).apply(undefined, args),
    },
}));

vi.mock('expo-notifications', () => ({
    setNotificationHandler: vi.fn(),
    setNotificationChannelAsync: vi.fn(async () => {}),
    setNotificationCategoryAsync: vi.fn(async () => {}),
    AndroidImportance: { MAX: 5 },
}));

vi.mock('@expo/vector-icons', () => ({
    FontAwesome: { font: {} },
}));

vi.mock('@/auth/storage/tokenStorage', () => ({
    TokenStorage: {
        getCredentials: vi.fn(async () => null),
    },
    isLegacyAuthCredentials: (credentials: unknown) => Boolean(credentials),
}));

vi.mock('@/auth/context/AuthContext', () => {
    const React = require('react');
    return {
        AuthProvider: ({ children }: { children: React.ReactNode }) => React.createElement('AuthProvider', null, children),
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
        SidebarNavigator: () => React.createElement('SidebarNavigator'),
    };
});

vi.mock('@/components/appShell/AppCrashRecoveryBoundary', () => {
    const React = require('react');
    return {
        AppCrashRecoveryBoundary: ({ children }: { children: React.ReactNode }) =>
            React.createElement('AppCrashRecoveryBoundary', null, children),
    };
});

vi.mock('@/encryption/libsodium.lib', () => ({
    default: {
        ready: Promise.resolve(),
    },
}));

vi.mock('react-native', () => {
    const React = require('react');
    return {
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
    };
});

vi.mock('@/modal', () => {
    const React = require('react');
    return {
        ModalProvider: ({ children }: { children: React.ReactNode }) => React.createElement('ModalProvider', null, children),
    };
});

vi.mock('posthog-react-native', () => {
    const React = require('react');
    return {
        PostHogProvider: ({ children }: { children: React.ReactNode }) => React.createElement('PostHogProvider', null, children),
    };
});

vi.mock('@/track/tracking', () => ({
    tracking: null,
}));

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

vi.mock('@/components/CommandPalette/CommandPaletteProvider', () => {
    const React = require('react');
    return {
        CommandPaletteProvider: ({ children }: { children: React.ReactNode }) => React.createElement('CommandPaletteProvider', null, children),
    };
});

vi.mock('@/components/ui/layout/StatusBarProvider', () => ({
    StatusBarProvider: () => null,
}));

vi.mock('@/components/ui/feedback/DesktopUpdateBanner', () => ({
    DesktopUpdateBanner: () => null,
}));

vi.mock('@/utils/system/remoteLogger', () => ({
    monkeyPatchConsoleForRemoteLoggingForFasterAiAutoDebuggingOnlyInLocalBuilds: vi.fn(),
}));

vi.mock('react-native-unistyles', () => ({
    StyleSheet: {
        create: (styles: any) => styles,
        hairlineWidth: 1,
    },
    useUnistyles: () => ({
        theme: {
            dark: false,
            colors: {
                groupped: { background: '#fff' },
            },
        },
    }),
}));

describe('app/_layout init resilience', () => {
    const previousSentryDsn = process.env.EXPO_PUBLIC_SENTRY_DSN;
    const previousSentryLogs = process.env.EXPO_PUBLIC_SENTRY_ENABLE_LOGS;
    const previousSentryReplay = process.env.EXPO_PUBLIC_SENTRY_ENABLE_REPLAY;
    const previousSentryReplaySessionRate = process.env.EXPO_PUBLIC_SENTRY_REPLAYS_SESSION_SAMPLE_RATE;
    const previousSentryReplayOnErrorRate = process.env.EXPO_PUBLIC_SENTRY_REPLAYS_ON_ERROR_SAMPLE_RATE;

    afterEach(() => {
        // Ensure no test leaks fake timers into subsequent tests.
        vi.useRealTimers();
        mockedPlatformOS = 'web';
        mockedConfigVariant = '';
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
        vi.resetModules();
        vi.clearAllMocks();
    });

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

    it('configures separate Android notification channels for permission/action request pushes', async () => {
        mockedPlatformOS = 'android';
        await import('@/app/_layout');

        const Notifications = await import('expo-notifications');
        expect((Notifications as any).setNotificationChannelAsync).toHaveBeenCalledWith(
            PUSH_NOTIFICATION_ANDROID_CHANNEL_IDS.permissionRequestsV1,
            expect.objectContaining({ showBadge: true }),
        );
        expect((Notifications as any).setNotificationChannelAsync).toHaveBeenCalledWith(
            PUSH_NOTIFICATION_ANDROID_CHANNEL_IDS.userActionRequestsV1,
            expect.objectContaining({ showBadge: true }),
        );
    });

    it('uses app variant as the default Sentry environment when EXPO_PUBLIC_SENTRY_ENVIRONMENT is unset', async () => {
        process.env.EXPO_PUBLIC_SENTRY_DSN = 'https://examplePublicKey@o0.ingest.sentry.io/0';
        mockedConfigVariant = 'preview';

        const RootLayout = (await import('@/app/_layout')).default;

        await act(async () => {
            renderer.create(React.createElement(RootLayout));
        });

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

        const RootLayout = (await import('@/app/_layout')).default;

        await act(async () => {
            renderer.create(React.createElement(RootLayout));
        });

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

        const RootLayout = (await import('@/app/_layout')).default;

        let tree: renderer.ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(React.createElement(RootLayout));
        });

        await act(async () => {
            await Promise.resolve();
            await Promise.resolve();
        });

        expect(loadAsyncMock).toHaveBeenCalledTimes(1);
        expect(syncRestoreMock).not.toHaveBeenCalled();
        expect(tree!.toJSON()).not.toBeNull();
        consoleErrorSpy.mockRestore();
    });

    it('wraps the provider stack with AppCrashRecoveryBoundary', async () => {
        mockedPlatformOS = 'ios';
        const RootLayout = (await import('@/app/_layout')).default;

        let tree: renderer.ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(React.createElement(RootLayout));
        });

        await act(async () => {
            await Promise.resolve();
            await Promise.resolve();
        });

        expect(tree!.root.findAllByType('AppCrashRecoveryBoundary' as any)).toHaveLength(1);
    });

    it('navigates to the bug report screen on boot when a restart bug report intent is present', async () => {
        mockedPlatformOS = 'ios';
        consumeRestartBugReportIntentMock.mockResolvedValueOnce(true);

        const RootLayout = (await import('@/app/_layout')).default;

        await act(async () => {
            renderer.create(React.createElement(RootLayout));
        });

        await act(async () => {
            await Promise.resolve();
            await Promise.resolve();
        });

        expect(routerPushMock).toHaveBeenCalledWith('/(app)/settings/report-issue');
    });

    it('injects web font faces and does not invoke expo-font on web', async () => {
        mockedPlatformOS = 'web';
        fromModuleMock.mockImplementation(() => ({ uri: 'https://example.com/font.ttf' }));

        const appended: any[] = [];
        const appendChild = vi.fn((node: any) => {
            appended.push(node);
        });

        Object.defineProperty(globalThis, 'document', {
            value: {
                getElementById: vi.fn(() => null),
                createElement: vi.fn(() => ({ textContent: '', id: '' })),
                head: { appendChild },
            },
            configurable: true,
        });

        const RootLayout = (await import('@/app/_layout')).default;

        let tree: renderer.ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(React.createElement(RootLayout));
        });

        await act(async () => {
            await Promise.resolve();
            await Promise.resolve();
        });

        expect(loadAsyncMock).toHaveBeenCalledTimes(0);
        // We inject a <style> for @font-face rules and also add a <style> for UI font scaling overrides.
        expect(appendChild).toHaveBeenCalledTimes(2);
        const texts = appended.map((n) => String(n?.textContent ?? ''));
        expect(texts.some((t) => t.includes('@font-face'))).toBe(true);
        expect(texts.some((t) => t.includes('Inter-Regular'))).toBe(true);
        expect(texts.some((t) => t.includes('example.com/font.ttf'))).toBe(true);
        expect(tree!.toJSON()).not.toBeNull();
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

        const RootLayout = (await import('@/app/_layout')).default;

        let tree: renderer.ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(React.createElement(RootLayout));
        });

        await act(async () => {
            await Promise.resolve();
            await Promise.resolve();
        });

        // In automation contexts, skip expo-font on web entirely to avoid FontFaceObserver's
        // timeout behavior surfacing as dev overlays (uncaught errors / unhandled rejections).
        expect(loadAsyncMock).toHaveBeenCalledTimes(0);
        expect(tree!.toJSON()).not.toBeNull();

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

        const RootLayout = (await import('@/app/_layout')).default;

        let tree: renderer.ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(React.createElement(RootLayout));
        });

        await act(async () => {
            await Promise.resolve();
            await Promise.resolve();
        });

        // On web we no longer invoke expo-font at all (it uses FontFaceObserver with a hard-coded
        // timeout and can surface uncaught errors / unhandled rejections). Web fonts are injected
        // via `@font-face` rules instead.
        expect(loadAsyncMock).toHaveBeenCalledTimes(0);
        expect(tree!.toJSON()).not.toBeNull();
        // Non-automation web startup should not install global error suppression handlers.
        expect(addEventListenerSpy).not.toHaveBeenCalled();

        const fontInitErrors = consoleErrorSpy.mock.calls.filter(
            (call) => call[0] === 'Failed to load fonts during init, continuing startup:'
        );
        expect(fontInitErrors).toHaveLength(0);
    });

    it('does not install FontFaceObserver timeout suppression listeners on non-automation web startup', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2020-01-01T00:00:00.000Z'));

        const addEventListenerSpy = vi.fn();
        Object.defineProperty(globalThis, 'window', {
            value: { addEventListener: addEventListenerSpy },
            configurable: true,
        });

        const RootLayout = (await import('@/app/_layout')).default;

        let tree: renderer.ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(React.createElement(RootLayout));
        });

        await act(async () => {
            await Promise.resolve();
            await Promise.resolve();
        });

        expect(tree!.toJSON()).not.toBeNull();
        expect(addEventListenerSpy).not.toHaveBeenCalled();
    });

    it('does not surface synchronous expo-font errors as console errors on web startup', async () => {
        const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        loadAsyncMock.mockImplementationOnce(() => {
            throw new Error('6000ms timeout exceeded');
        });

        const RootLayout = (await import('@/app/_layout')).default;

        let tree: renderer.ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(React.createElement(RootLayout));
        });

        await act(async () => {
            await Promise.resolve();
            await Promise.resolve();
        });

        expect(tree!.toJSON()).not.toBeNull();
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

        const RootLayout = (await import('@/app/_layout')).default;

        let tree: renderer.ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(React.createElement(RootLayout));
        });

        await act(async () => {
            await Promise.resolve();
            await Promise.resolve();
        });

        expect(loadAsyncMock).toHaveBeenCalledTimes(0);
        expect(tree!.toJSON()).not.toBeNull();

        const fontInitErrors = consoleErrorSpy.mock.calls.filter(
            (call) => call[0] === 'Failed to load fonts during init, continuing startup:'
        );
        expect(fontInitErrors).toHaveLength(0);
    });
});
