import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import renderer, { act } from 'react-test-renderer';

// Avoid React "act(...) environment" warnings in non-JSDOM test environments.
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const loadAsyncMock = vi.fn();
const syncRestoreMock = vi.fn(async () => {});
const hideAsyncMock = vi.fn(async () => {});
let mockedPlatformOS: string = 'web';

vi.mock('react-native-quick-base64', () => ({}));

vi.mock('expo-splash-screen', () => ({
    setOptions: vi.fn(),
    preventAutoHideAsync: vi.fn(async () => {}),
    hideAsync: hideAsyncMock,
}));

vi.mock('expo-font', () => ({
    loadAsync: loadAsyncMock,
}));

vi.mock('expo-notifications', () => ({
    setNotificationHandler: vi.fn(),
    setNotificationChannelAsync: vi.fn(async () => {}),
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
    afterEach(() => {
        // Ensure no test leaks fake timers into subsequent tests.
        vi.useRealTimers();
        mockedPlatformOS = 'web';
        // Clean up any navigator overrides from tests.
        // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
        delete (globalThis as any).navigator;
        // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
        delete (globalThis as any).document;
        // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
        delete (globalThis as any).window;
        vi.resetModules();
        vi.clearAllMocks();
    });

    it('continues boot when font loading fails', async () => {
        loadAsyncMock.mockRejectedValueOnce(new Error('6000ms timeout exceeded'));

        const RootLayout = (await import('./_layout')).default;

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

        const RootLayout = (await import('./_layout')).default;

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

        const RootLayout = (await import('./_layout')).default;

        let tree: renderer.ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(React.createElement(RootLayout));
        });

        await act(async () => {
            await Promise.resolve();
            await Promise.resolve();
        });

        expect(loadAsyncMock).toHaveBeenCalledTimes(1);
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

        const RootLayout = (await import('./_layout')).default;

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

        const RootLayout = (await import('./_layout')).default;

        let tree: renderer.ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(React.createElement(RootLayout));
        });

        await act(async () => {
            await Promise.resolve();
            await Promise.resolve();
        });

        expect(tree!.toJSON()).not.toBeNull();
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

        const RootLayout = (await import('./_layout')).default;

        let tree: renderer.ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(React.createElement(RootLayout));
        });

        await act(async () => {
            await Promise.resolve();
            await Promise.resolve();
        });

        expect(loadAsyncMock).toHaveBeenCalledTimes(1);
        expect(tree!.toJSON()).not.toBeNull();

        const fontInitErrors = consoleErrorSpy.mock.calls.filter(
            (call) => call[0] === 'Failed to load fonts during init, continuing startup:'
        );
        expect(fontInitErrors).toHaveLength(0);
    });
});
