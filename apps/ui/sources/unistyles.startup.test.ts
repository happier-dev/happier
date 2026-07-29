import { describe, expect, it, vi } from 'vitest';

import type { ThemeProfilesLocalStateV1 } from './theme/profiles/themeProfileTypes';

const brokenProfileState = {
    activeProfileIds: { light: 'broken', dark: 'broken' },
    profiles: [{
        schemaVersion: 1,
        id: 'broken',
        name: 'Broken',
        createdAt: '2026-05-12T00:00:00.000Z',
        updatedAt: '2026-05-12T00:00:00.000Z',
        base: { light: 'light', dark: 'dark' },
        overrides: {
            light: null,
            dark: null,
        },
    }],
} as unknown as ThemeProfilesLocalStateV1;

type StartupMocks = Readonly<{
    configure: ReturnType<typeof vi.fn>;
    setRootViewBackgroundColor: ReturnType<typeof vi.fn>;
}>;

const installStartupMocks = async (mocks: StartupMocks): Promise<void> => {
    vi.doMock('react-native', async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return await createReactNativeWebMock({
            Appearance: {
                getColorScheme: () => 'light',
                addChangeListener: vi.fn(() => ({ remove: vi.fn() })),
            },
        });
    });

    vi.doMock('./sync/domains/state/persistence', () => ({
        loadThemeRuntimeLocalState: () => ({
            themePreference: 'light',
            themeProfiles: brokenProfileState,
        }),
    }));

    vi.doMock('expo-system-ui', () => ({
        setBackgroundColorAsync: vi.fn(async () => {}),
    }));

    vi.doMock('react-native-unistyles', async () => {
        const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
        const moduleMock = await createUnistylesMock({
            runtime: {
                setRootViewBackgroundColor: mocks.setRootViewBackgroundColor,
            },
        });

        return {
            ...moduleMock,
            StyleSheet: {
                ...moduleMock.StyleSheet,
                configure: mocks.configure,
            },
        };
    });
};

const expectConfiguredWithCanonicalBaseThemes = async (configure: ReturnType<typeof vi.fn>) => {
    const { darkTheme, lightTheme } = await import('./theme');

    expect(configure).toHaveBeenCalledWith(expect.objectContaining({
        themes: {
            light: lightTheme,
            dark: darkTheme,
        },
    }));

    return { darkTheme, lightTheme };
};

describe('Unistyles startup theme fallback', () => {
    it('configures native startup with canonical base themes when effective profile resolution throws', async () => {
        vi.resetModules();
        const mocks = {
            configure: vi.fn(),
            setRootViewBackgroundColor: vi.fn(),
        };
        await installStartupMocks(mocks);

        await expect(import('./unistyles')).resolves.toBeDefined();

        const { lightTheme } = await expectConfiguredWithCanonicalBaseThemes(mocks.configure);
        expect(mocks.setRootViewBackgroundColor).toHaveBeenCalledWith(lightTheme.colors.background.canvas);
    });

    it('configures web startup with canonical base themes when effective profile resolution throws', async () => {
        vi.resetModules();
        const mocks = {
            configure: vi.fn(),
            setRootViewBackgroundColor: vi.fn(),
        };
        await installStartupMocks(mocks);

        await expect(import('./unistyles.web')).resolves.toBeDefined();

        const { lightTheme } = await expectConfiguredWithCanonicalBaseThemes(mocks.configure);
        expect(mocks.setRootViewBackgroundColor).toHaveBeenCalledWith(lightTheme.colors.background.canvas);
    });
});
