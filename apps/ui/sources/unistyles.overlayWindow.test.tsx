import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const platformBoundary = vi.hoisted(() => ({ os: 'ios' as 'ios' | 'web' }));

const setRootViewBackgroundColorMock = vi.fn();
const setThemeMock = vi.fn();
const setBackgroundColorAsyncMock = vi.fn(async () => {});
const loadThemePreferenceMock = vi.fn(() => 'light');
const configureMock = vi.fn();
const appearanceGetColorSchemeMock = vi.fn(() => 'light');
const appearanceAddChangeListenerMock = vi.fn((_listener: (event: { colorScheme: 'light' | 'dark' | null }) => void) => ({ remove: vi.fn() }));
const windowStub = {
    location: {
        href: 'http://localhost/',
        pathname: '/',
    },
} as unknown as Window & { location: { href: string; pathname: string } };

vi.mock('expo-system-ui', () => ({
    setBackgroundColorAsync: setBackgroundColorAsyncMock,
}));
vi.mock('expo-status-bar', () => ({ setStatusBarStyle: vi.fn() }));

vi.mock('react-native', async () => {
    const { createReactNativeNativeMock, createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    const overrides = {
        Appearance: {
            getColorScheme: () => appearanceGetColorSchemeMock(),
            addChangeListener: appearanceAddChangeListenerMock,
        },
    };
    return platformBoundary.os === 'web' ? createReactNativeWebMock(overrides)
        : createReactNativeNativeMock({ platformOS: 'ios' }, overrides);
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock({
        runtime: {
            setTheme: setThemeMock,
            setRootViewBackgroundColor: setRootViewBackgroundColorMock,
        },
        styleSheet: {
            configure: configureMock,
        },
    });
});

vi.mock('./sync/domains/state/persistence', () => ({
    loadThemeRuntimeLocalState: () => ({
        themePreference: loadThemePreferenceMock(),
        themeProfiles: {
            profiles: [],
            activeProfileIds: { light: null, dark: null },
        },
    }),
}));

describe('unistyles overlay background bootstrap', () => {
    beforeEach(() => {
        vi.resetModules();
        platformBoundary.os = 'ios';
        vi.stubGlobal('window', windowStub);
        setRootViewBackgroundColorMock.mockReset();
        setThemeMock.mockReset();
        setBackgroundColorAsyncMock.mockReset();
        loadThemePreferenceMock.mockReset();
        configureMock.mockReset();
        appearanceGetColorSchemeMock.mockReset();
        appearanceAddChangeListenerMock.mockReset();
        loadThemePreferenceMock.mockReturnValue('light');
        appearanceGetColorSchemeMock.mockReturnValue('light');
        appearanceAddChangeListenerMock.mockReturnValue({ remove: vi.fn() });
        windowStub.location.href = 'http://localhost/';
        windowStub.location.pathname = '/';
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('keeps the overlay window root background transparent instead of applying the theme surface color', async () => {
        windowStub.location.href = 'http://localhost/desktop/activity-overlay?desktopOverlayWindow=1';
        windowStub.location.pathname = '/desktop/activity-overlay';

        await import('./unistyles');

        expect(setRootViewBackgroundColorMock).toHaveBeenCalledWith('transparent');
        expect(setBackgroundColorAsyncMock).not.toHaveBeenCalled();
    });

    it('keeps the first-open desktop document transparent from web theme startup', async () => {
        platformBoundary.os = 'web';
        windowStub.location.href = 'http://localhost/desktop/opening';
        windowStub.location.pathname = '/desktop/opening';
        vi.stubGlobal('isTauri', true);

        await import('./unistyles.web');

        expect(setRootViewBackgroundColorMock).toHaveBeenLastCalledWith('transparent');
    });

    it('keeps the main window themed from web theme startup', async () => {
        platformBoundary.os = 'web';
        vi.stubGlobal('isTauri', true);

        await import('./unistyles.web');

        expect(setRootViewBackgroundColorMock).toHaveBeenLastCalledWith('#F5F5F5');
    });

    it('uses an explicit initial theme for adaptive preferences instead of native adaptive theme registration', async () => {
        loadThemePreferenceMock.mockReturnValue('adaptive');
        appearanceGetColorSchemeMock.mockReturnValue('dark');

        await import('./unistyles');

        const [configureOptions] = configureMock.mock.calls[0] ?? [];
        expect(configureOptions).toEqual(expect.objectContaining({
            settings: {
                CSSVars: true,
                initialTheme: 'dark',
            },
        }));

        const settings = (configureOptions as { settings?: Record<string, unknown> }).settings;
        expect(settings).not.toHaveProperty('adaptiveThemes');
    });

    it('keeps adaptive preferences synced to React Native appearance changes', async () => {
        loadThemePreferenceMock.mockReturnValue('adaptive');
        appearanceGetColorSchemeMock.mockReturnValue('dark');

        await import('./unistyles');

        const firstListenerCall = appearanceAddChangeListenerMock.mock.calls[0] as unknown as [
            (event: { colorScheme: 'light' | 'dark' | null }) => void,
        ] | undefined;
        if (!firstListenerCall) {
            throw new Error('Appearance change listener was not registered');
        }
        const listener = firstListenerCall[0];
        expect(listener).toEqual(expect.any(Function));

        setThemeMock.mockReset();
        setRootViewBackgroundColorMock.mockReset();
        setBackgroundColorAsyncMock.mockReset();

        listener({ colorScheme: 'light' });

        expect(setThemeMock).toHaveBeenCalledWith('light');
        expect(setRootViewBackgroundColorMock).toHaveBeenCalledWith(expect.any(String));
        expect(setBackgroundColorAsyncMock).toHaveBeenCalledWith(expect.any(String));
    });

    it('observes OS changes for a blocking fallback before theme bootstrap and reuses that observer', async () => {
        const { subscribeSystemTheme } = await import('./theme/profiles/themeProfileRuntime');
        const reader = vi.fn();
        const unsubscribe = subscribeSystemTheme(reader);
        expect(appearanceAddChangeListenerMock).toHaveBeenCalledTimes(1);
        const listener = appearanceAddChangeListenerMock.mock.calls[0]?.[0];
        listener?.({ colorScheme: 'dark' });
        expect(reader).toHaveBeenCalledOnce();
        await import('./unistyles');
        expect(appearanceAddChangeListenerMock).toHaveBeenCalledTimes(1);
        unsubscribe();
        listener?.({ colorScheme: 'light' });
        expect(reader).toHaveBeenCalledOnce();
    });

    it('keeps web adaptive paint on the explicit theme notification path across scheme flips', async () => {
        platformBoundary.os = 'web';
        loadThemePreferenceMock.mockReturnValue('adaptive');
        await import('./unistyles.web');
        const listener = appearanceAddChangeListenerMock.mock.calls[0]?.[0];
        expect(listener).toEqual(expect.any(Function));
        for (const colorScheme of ['dark', 'light', 'dark'] as const) {
            listener({ colorScheme });
            expect(setThemeMock).toHaveBeenLastCalledWith(colorScheme);
        }
        expect(appearanceAddChangeListenerMock).toHaveBeenCalledTimes(1);
    });

    it('follows the current preference after booting explicit, then choosing adaptive and explicit again', async () => {
        await import('./unistyles');
        const { applyThemeRuntimeSelection } = await import('./theme/profiles/themeProfileRuntime');
        const themeProfiles = { profiles: [], activeProfileIds: { light: null, dark: null } };
        applyThemeRuntimeSelection({ themePreference: 'adaptive', themeProfiles, style: null });
        const listener = appearanceAddChangeListenerMock.mock.calls[0]?.[0];
        expect(listener).toEqual(expect.any(Function));
        listener({ colorScheme: 'dark' });
        expect(setThemeMock).toHaveBeenLastCalledWith('dark');
        applyThemeRuntimeSelection({ themePreference: 'light', themeProfiles, style: null });
        setThemeMock.mockClear();
        listener({ colorScheme: 'dark' });
        expect(setThemeMock).not.toHaveBeenCalled();
        expect(appearanceAddChangeListenerMock).toHaveBeenCalledTimes(1);
    });
});
