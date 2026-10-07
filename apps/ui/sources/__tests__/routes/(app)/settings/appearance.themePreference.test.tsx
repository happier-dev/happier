import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderSettingsView, standardCleanup } from '@/dev/testkit';
import { localSettingsParse } from '@/sync/domains/settings/localSettings';
import { settingsParse } from '@/sync/domains/settings/settings';
import { storage } from '@/sync/domains/state/storageStore';
import { BUILT_IN_THEME_PROFILES } from '@/theme/profiles/builtInThemeProfiles';
import { installSessionSettingsEntryModuleMocks, resetSessionSettingsEntryState, sessionSettingsEntryState } from './sessionSettingsEntryTestHelpers';

const testGlobal = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean };
testGlobal.IS_REACT_ACT_ENVIRONMENT = true;

const shared = vi.hoisted(() => ({
    settingsState: {
        themePreference: 'light',
        uiFontScale: 1,
        uiItemDensity: 'comfortable',
        uiMultiPanePanelsEnabled: true,
        detailsPaneTabsBehavior: 'preview',
        avatarStyle: 'gradient',
        showFlavorIcons: true,
        preferredLanguage: null,
        themeProfiles: { activeProfileIds: { light: null, dark: null }, profiles: [] },
    } as Record<string, unknown>,
    setAdaptiveThemes: vi.fn(),
    setTheme: vi.fn(),
    setRootViewBackgroundColor: vi.fn(),
    setStatusBarStyle: vi.fn(),
    setSystemBackgroundColorAsync: vi.fn(),
    startViewTransition: vi.fn(),
    documentElementAnimate: vi.fn(),
}));

const initialStorage = storage.getState();

async function renderAppearance(element: React.ReactElement, options?: Parameters<typeof renderSettingsView>[1]) {
    await act(async () => {
        storage.setState({
            localSettings: localSettingsParse(shared.settingsState),
            settings: settingsParse(shared.settingsState),
        });
    });
    return renderSettingsView(element, options);
}

installSessionSettingsEntryModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            Appearance: { getColorScheme: () => 'light' },
        });
    },
    unistyles: async () => {
        const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
        return createUnistylesMock({
            theme: {
                colors: {
                    accent: { blue: '#00f', orange: '#f90', indigo: '#6366f1' },
                    status: { connecting: '#09f' },
                },
            },
            runtime: {
                setAdaptiveThemes: shared.setAdaptiveThemes,
                setTheme: shared.setTheme,
                setRootViewBackgroundColor: shared.setRootViewBackgroundColor,
            },
        });
    },
    textModule: async () => {
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return {
            ...createTextModuleMock(),
            getLanguageNativeName: () => 'English',
            SUPPORTED_LANGUAGES: { en: true },
        };
    },
    storageModule: (importOriginal) => importOriginal<typeof import('@/sync/domains/state/storage')>(),
    useDeviceType: 'desktop',
});

vi.mock('expo-localization', () => ({ getLocales: () => [{ languageTag: 'en-US' }] }));
vi.mock('expo-status-bar', () => ({ setStatusBarStyle: shared.setStatusBarStyle }));
vi.mock('expo-system-ui', () => ({ setBackgroundColorAsync: shared.setSystemBackgroundColorAsync }));
vi.mock('@/theme', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/theme')>();
    return {
        ...actual,
        darkTheme: {
            ...actual.darkTheme,
            colors: {
                ...actual.darkTheme.colors,
                groupped: { background: '#000' },
            },
        },
        lightTheme: {
            ...actual.lightTheme,
            colors: {
                ...actual.lightTheme.colors,
                groupped: { background: '#fff' },
            },
        },
    };
});

afterEach(() => {
    standardCleanup();
    storage.setState(initialStorage, true);
    resetSessionSettingsEntryState();
    Reflect.deleteProperty(globalThis, 'document');
    shared.settingsState.themePreference = 'light';
    shared.settingsState.themeProfiles = { activeProfileIds: { light: null, dark: null }, profiles: [] };
    shared.setAdaptiveThemes.mockClear();
    shared.setTheme.mockClear();
    shared.setRootViewBackgroundColor.mockClear();
    shared.setStatusBarStyle.mockClear();
    shared.setSystemBackgroundColorAsync.mockClear();
    shared.startViewTransition.mockClear();
    shared.startViewTransition.mockImplementation((update: () => void) => {
        update();
        return { ready: Promise.resolve() };
    });
    shared.documentElementAnimate.mockClear();
});

describe('Appearance settings theme preference', () => {
    it('summarizes which theme each mode uses and how many themes exist, without an embedded preview', async () => {
        shared.settingsState.themePreference = 'dark';
        shared.settingsState.themeProfiles = { activeProfileIds: { light: null, dark: 'nightDark' }, profiles: [] };
        const { default: Appearance } = await import('@/app/(app)/settings/appearance');
        const screen = await renderAppearance(<Appearance />);

        expect(screen.findByTestId('settings-theme-profile-preview')).toBeNull();
        const themesRow = screen.findRow('settings-appearance-themeProfiles') as any;
        expect(themesRow.props.subtitle).toBe(
            'settingsAppearance.themesSummary(light=settingsAppearance.themeProfiles.defaultTheme,dark=settingsAppearance.themeProfiles.presets.nightDark)',
        );
        expect(themesRow.props.detail).toBe(`settingsAppearance.themesCount(builtIn=${BUILT_IN_THEME_PROFILES.length + 2},custom=0)`);
    });

    const findThemeModeTiles = (screen: Awaited<ReturnType<typeof renderSettingsView>>) =>
        screen.findByProps({ testIdPrefix: 'settings-appearance-themeMode' });

    it('shows the mode as tiles in every mode', async () => {
        for (const mode of ['dark', 'adaptive'] as const) {
            shared.settingsState.themePreference = mode;
            const mod = await import('@/app/(app)/settings/appearance');
            const screen = await renderAppearance(React.createElement(mod.default), {
                flushOptions: { cycles: 0 },
            });

            expect(findThemeModeTiles(screen).props.value).toBe(mode);
            expect(findThemeModeTiles(screen).props.options.map((option: any) => option.id)).toEqual(['adaptive', 'light', 'dark']);
        }
    });

    it('applies status bar style immediately when selecting dark mode', async () => {
        const mod = await import('@/app/(app)/settings/appearance');
        const screen = await renderAppearance(React.createElement(mod.default), {
            flushOptions: { cycles: 0 },
        });

        await act(async () => {
            findThemeModeTiles(screen).props.onChange('dark');
        });

        expect(storage.getState().localSettings.themePreference).toBe('dark');
        expect(shared.setTheme).toHaveBeenCalledWith('dark');
        expect(shared.setStatusBarStyle).toHaveBeenCalledWith('light', true);
    });

    it('wraps web theme changes in a view transition', async () => {
        Object.defineProperty(globalThis, 'document', {
            configurable: true,
            value: {
                documentElement: {
                    animate: shared.documentElementAnimate,
                },
                startViewTransition: shared.startViewTransition,
            } as unknown as Document,
        });

        const mod = await import('@/app/(app)/settings/appearance');
        const screen = await renderAppearance(React.createElement(mod.default), {
            flushOptions: { cycles: 0 },
        });

        await act(async () => {
            findThemeModeTiles(screen).props.onChange('dark');
        });

        expect(shared.startViewTransition).toHaveBeenCalledOnce();
        expect(shared.documentElementAnimate).toHaveBeenCalledWith(
            { clipPath: ['inset(0 0 100% 0)', 'inset(0)'] },
            expect.objectContaining({ pseudoElement: '::view-transition-new(root)' }),
        );
    });

    it('switching mode keeps the theme already assigned to that mode', async () => {
        shared.settingsState.themePreference = 'light';
        shared.settingsState.themeProfiles = { activeProfileIds: { light: null, dark: 'premiumDark' }, profiles: [] };
        const mod = await import('@/app/(app)/settings/appearance');
        const screen = await renderAppearance(React.createElement(mod.default), {
            flushOptions: { cycles: 0 },
        });

        await act(async () => {
            findThemeModeTiles(screen).props.onChange('dark');
        });

        const { themeProfiles, themePreference } = storage.getState().localSettings;
        expect(themePreference).toBe('dark');
        expect(themeProfiles.activeProfileIds).toEqual({ light: null, dark: 'premiumDark' });
    });

    it('opens theme profile management from the theme group', async () => {
        const mod = await import('@/app/(app)/settings/appearance');
        const screen = await renderAppearance(React.createElement(mod.default), {
            flushOptions: { cycles: 0 },
        });

        await act(async () => {
            screen.pressByTestId('settings-appearance-themeProfiles');
        });

        expect(sessionSettingsEntryState.routerPushSpy).toHaveBeenCalledWith('/settings/appearance/themes');
    });
});
