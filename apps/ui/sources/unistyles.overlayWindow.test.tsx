import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const setRootViewBackgroundColorMock = vi.fn();
const setThemeMock = vi.fn();
const setBackgroundColorAsyncMock = vi.fn(async () => {});
const loadThemePreferenceMock = vi.fn(() => 'light');
const configureMock = vi.fn();
const appearanceGetColorSchemeMock = vi.fn(() => 'light');
const appearanceAddChangeListenerMock = vi.fn(() => ({ remove: vi.fn() }));
const windowStub = {
    location: {
        href: 'http://localhost/',
        pathname: '/',
    },
} as unknown as Window & { location: { href: string; pathname: string } };

vi.mock('expo-system-ui', () => ({
    setBackgroundColorAsync: setBackgroundColorAsyncMock,
}));

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
        Appearance: {
            getColorScheme: () => appearanceGetColorSchemeMock(),
            addChangeListener: appearanceAddChangeListenerMock,
        },
    });
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
});
