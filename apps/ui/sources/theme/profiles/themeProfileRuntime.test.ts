import { describe, expect, it, vi } from 'vitest';

import { darkTheme, lightTheme, type Theme } from '@/theme';
import { localSettingsDefaults, type LocalSettings } from '@/sync/domains/settings/localSettings';
import {
    activateThemeProfile,
    applyThemeRuntimeSelection,
    resolveEffectiveThemeRuntimeBackground,
    resolveThemeRuntimeStartupThemes,
    resolveThemeRuntimeThemes,
} from './themeProfileRuntime';
import { getBuiltInThemeProfileDefinition } from './builtInThemeProfiles';
import type { ThemeProfilesLocalStateV1 } from './themeProfileTypes';

const profileState: ThemeProfilesLocalStateV1 = {
    activeProfileIds: { light: 'ocean', dark: 'ocean' },
    profiles: [{
        schemaVersion: 1,
        id: 'ocean',
        name: 'Ocean',
        createdAt: '2026-05-11T00:00:00.000Z',
        updatedAt: '2026-05-11T00:00:00.000Z',
        base: { light: 'light', dark: 'dark' },
        overrides: {
            light: { 'background.canvas': '#fafafa' },
            dark: { 'background.canvas': '#0a0a0a' },
        },
    }],
};

const pairedProfileState = {
    activeProfileIds: {
        light: 'paper',
        dark: 'noir',
    },
    profiles: [
        {
            schemaVersion: 1,
            id: 'paper',
            name: 'Paper',
            createdAt: '2026-05-11T00:00:00.000Z',
            updatedAt: '2026-05-11T00:00:00.000Z',
            base: { light: 'light', dark: 'dark' },
            overrides: {
                light: { 'background.canvas': '#f8f6ef' },
                dark: { 'background.canvas': '#101010' },
            },
        },
        {
            schemaVersion: 1,
            id: 'noir',
            name: 'Noir',
            createdAt: '2026-05-11T00:00:00.000Z',
            updatedAt: '2026-05-11T00:00:00.000Z',
            base: { light: 'light', dark: 'dark' },
            overrides: {
                light: { 'background.canvas': '#eeeeee' },
                dark: { 'background.canvas': '#08090a' },
            },
        },
    ],
} as unknown as ThemeProfilesLocalStateV1;

describe('theme profile runtime', () => {
    it('falls back to canonical base themes when startup effective theme resolution fails', () => {
        const result = resolveThemeRuntimeStartupThemes({
            themeProfiles: profileState,
            themePreference: 'light',
            systemTheme: 'light',
            resolveThemes: () => {
                throw new Error('resolver failed');
            },
        });

        expect(result.themes.light).toBe(lightTheme);
        expect(result.themes.dark).toBe(darkTheme);
        expect(result.backgroundColor).toBe(lightTheme.colors.background.canvas);
    });

    it('falls back to canonical base themes when startup background resolution fails', () => {
        const brokenTheme = {
            ...lightTheme,
            colors: {
                ...lightTheme.colors,
                background: undefined,
            },
        } as unknown as Theme;

        const result = resolveThemeRuntimeStartupThemes({
            themeProfiles: profileState,
            themePreference: 'light',
            systemTheme: 'light',
            resolveThemes: () => ({
                light: brokenTheme,
                dark: darkTheme,
            }),
        });

        expect(result.themes.light).toBe(lightTheme);
        expect(result.themes.dark).toBe(darkTheme);
        expect(result.backgroundColor).toBe(lightTheme.colors.background.canvas);
    });

    it('resolves startup themes from the active custom profile before runtime configuration', () => {
        const themes = resolveThemeRuntimeThemes(profileState);

        expect(themes.light.colors.background.canvas).toBe('#fafafa');
        expect(themes.dark.colors.background.canvas).toBe('#0a0a0a');
    });

    it('resolves light and dark runtime themes from independent active profile selections', () => {
        const themes = resolveThemeRuntimeThemes(pairedProfileState);

        expect(themes.light.colors.background.canvas).toBe('#f8f6ef');
        expect(themes.dark.colors.background.canvas).toBe('#08090a');
    });

    it('resolves startup themes from an active built-in preset without requiring a stored profile', () => {
        const themes = resolveThemeRuntimeThemes({
            activeProfileIds: { light: null, dark: 'premiumDark' },
            profiles: [],
        });
        const premiumDark = getBuiltInThemeProfileDefinition('premiumDark')?.profile;

        expect(themes.dark.colors.background.canvas).toBe(premiumDark?.overrides.dark['background.canvas']);
        expect(themes.light.colors.background.canvas).toBe(lightTheme.colors.background.canvas);
    });

    it('falls back to canonical base themes when the active profile id is missing', () => {
        const themes = resolveThemeRuntimeThemes({
            ...profileState,
            activeProfileIds: { light: 'missing', dark: 'missing' },
        });

        expect(themes.light).toBe(lightTheme);
        expect(themes.dark).toBe(darkTheme);
    });

    it('uses adaptive system mode to choose the effective root background', () => {
        const themes = resolveThemeRuntimeThemes(profileState);

        expect(resolveEffectiveThemeRuntimeBackground({
            themes,
            themePreference: 'adaptive',
            systemTheme: 'dark',
        })).toBe('#0a0a0a');
    });

    it('updates both registered Unistyles themes on web when applying a profile', () => {
        const updateTheme = vi.fn();
        const setAdaptiveThemes = vi.fn();
        const setTheme = vi.fn();
        const setRootViewBackgroundColor = vi.fn();

        applyThemeRuntimeSelection({
            themePreference: 'dark',
            themeProfiles: profileState,
            systemTheme: 'light',
            platform: 'web',
            unistylesRuntime: {
                updateTheme,
                setAdaptiveThemes,
                setTheme,
                setRootViewBackgroundColor,
            },
            setSystemBackgroundColor: vi.fn(),
        });

        expect(updateTheme).toHaveBeenCalledWith('light', expect.any(Function));
        expect(updateTheme).toHaveBeenCalledWith('dark', expect.any(Function));
        expect(setAdaptiveThemes).toHaveBeenCalledWith(false);
        expect(setTheme).toHaveBeenCalledWith('dark');
        expect(setRootViewBackgroundColor).toHaveBeenCalledWith('#0a0a0a');
    });

    it('updates only the visual Unistyles theme on native when applying a profile', () => {
        const updateTheme = vi.fn();
        const setAdaptiveThemes = vi.fn();
        const setTheme = vi.fn();
        const setRootViewBackgroundColor = vi.fn();
        const recordBreadcrumb = vi.fn();

        applyThemeRuntimeSelection({
            themePreference: 'dark',
            themeProfiles: profileState,
            systemTheme: 'light',
            platform: 'ios',
            unistylesRuntime: {
                updateTheme,
                setAdaptiveThemes,
                setTheme,
                setRootViewBackgroundColor,
            },
            setSystemBackgroundColor: vi.fn(),
            recordBreadcrumb,
        });

        expect(updateTheme).toHaveBeenCalledTimes(1);
        expect(updateTheme).toHaveBeenCalledWith('dark', expect.any(Function));
        expect(setAdaptiveThemes).toHaveBeenCalledWith(false);
        expect(setTheme).toHaveBeenCalledWith('dark');
        expect(setRootViewBackgroundColor).toHaveBeenCalledWith('#0a0a0a');
        expect(recordBreadcrumb).toHaveBeenCalledWith(expect.objectContaining({
            phase: 'update-visual-theme',
            visualTheme: 'dark',
            platform: 'ios',
        }));
    });

    it('updates both registered Unistyles themes on native when adaptive mode can switch visual themes later', () => {
        const updateTheme = vi.fn();
        const setAdaptiveThemes = vi.fn();
        const setTheme = vi.fn();
        const setRootViewBackgroundColor = vi.fn();

        applyThemeRuntimeSelection({
            themePreference: 'adaptive',
            themeProfiles: pairedProfileState,
            systemTheme: 'light',
            platform: 'ios',
            unistylesRuntime: {
                updateTheme,
                setAdaptiveThemes,
                setTheme,
                setRootViewBackgroundColor,
            },
            setSystemBackgroundColor: vi.fn(),
        });

        expect(updateTheme).toHaveBeenCalledWith('light', expect.any(Function));
        expect(updateTheme).toHaveBeenCalledWith('dark', expect.any(Function));
        expect(setAdaptiveThemes).toHaveBeenCalledWith(true);
        expect(setTheme).not.toHaveBeenCalled();
        expect(setRootViewBackgroundColor).toHaveBeenCalledWith('#f8f6ef');
    });

    it('falls back to canonical base themes when profile resolution fails during application', () => {
        const updateTheme = vi.fn();
        const setRootViewBackgroundColor = vi.fn();

        applyThemeRuntimeSelection({
            themePreference: 'light',
            themeProfiles: profileState,
            systemTheme: 'light',
            resolveThemes: () => {
                throw new Error('resolver failed');
            },
            unistylesRuntime: {
                updateTheme,
                setAdaptiveThemes: vi.fn(),
                setTheme: vi.fn(),
                setRootViewBackgroundColor,
            },
            setSystemBackgroundColor: vi.fn(),
        });

        const firstLightUpdater = updateTheme.mock.calls.find(([themeName]) => themeName === 'light')?.[1];

        expect(typeof firstLightUpdater).toBe('function');
        expect(firstLightUpdater?.(profileState)).toBe(lightTheme);
        expect(setRootViewBackgroundColor).toHaveBeenCalledWith(lightTheme.colors.background.canvas);
    });

    it('reapplies canonical base themes when runtime theme application fails after custom themes resolve', () => {
        const updateTheme = vi.fn();
        const setRootViewBackgroundColor = vi.fn();
        const setAdaptiveThemes = vi.fn(() => {
            throw new Error('runtime failed');
        });

        const result = applyThemeRuntimeSelection({
            themePreference: 'dark',
            themeProfiles: profileState,
            systemTheme: 'dark',
            unistylesRuntime: {
                updateTheme,
                setAdaptiveThemes,
                setTheme: vi.fn(),
                setRootViewBackgroundColor,
            },
            setSystemBackgroundColor: vi.fn(),
        });

        expect(result.light).toBe(lightTheme);
        expect(result.dark).toBe(darkTheme);
        expect(updateTheme).toHaveBeenCalledWith('dark', expect.any(Function));
        expect(updateTheme).toHaveBeenCalledTimes(2);
        const finalDarkUpdater = updateTheme.mock.calls.filter(([themeName]) => themeName === 'dark').at(-1)?.[1];
        expect(finalDarkUpdater?.(profileState)).toBe(darkTheme);
    });

    it('activates profiles through the theme transition path with forced animation', async () => {
        const saveLocalSettings = vi.fn();
        const runThemePreferenceChange = vi.fn(async (input: { mutation: () => void; forceAnimate?: boolean; reduceMotion: boolean }) => {
            input.mutation();
        });

        await activateThemeProfile({
            profileId: 'ocean',
            forceAnimate: true,
            reduceMotion: false,
            systemTheme: 'light',
            platform: 'web',
            loadLocalSettings: () => ({
                themePreference: 'light',
                themeProfiles: profileState,
            }),
            saveLocalSettings,
            runThemePreferenceChange,
            applySelection: vi.fn(),
            setStatusBarStyle: vi.fn(),
        });

        expect(runThemePreferenceChange).toHaveBeenCalledWith(expect.objectContaining({
            currentPreference: 'light',
            nextPreference: 'light',
            forceAnimate: true,
            reduceMotion: false,
        }));
        expect(saveLocalSettings).toHaveBeenCalledWith(expect.objectContaining({
            themeProfiles: expect.objectContaining({
                activeProfileIds: { light: 'ocean', dark: 'ocean' },
            }),
        }));
    });

    it('merges profile activation with the latest local settings inside the transition mutation', async () => {
        let currentSettings: LocalSettings = {
            ...localSettingsDefaults,
            themePreference: 'light' as const,
            themeProfiles: profileState,
            uiFontScale: 1,
        };
        const saveLocalSettings = vi.fn((nextSettings: LocalSettings) => {
            currentSettings = nextSettings;
        });
        const runThemePreferenceChange = vi.fn(async (input: { mutation: () => void }) => {
            currentSettings = { ...currentSettings, uiFontScale: 1.2 };
            input.mutation();
        });

        await activateThemeProfile({
            profileId: 'ocean',
            forceAnimate: true,
            reduceMotion: false,
            systemTheme: 'light',
            platform: 'web',
            loadLocalSettings: () => currentSettings,
            saveLocalSettings,
            runThemePreferenceChange,
            applySelection: vi.fn(),
            setStatusBarStyle: vi.fn(),
        });

        expect(saveLocalSettings).toHaveBeenCalledWith(expect.objectContaining({
            uiFontScale: 1.2,
            themeProfiles: expect.objectContaining({
                activeProfileIds: { light: 'ocean', dark: 'ocean' },
            }),
        }));
    });

    it('activates built-in presets without adding them to the custom profile collection', async () => {
        const saveLocalSettings = vi.fn();
        const runThemePreferenceChange = vi.fn(async (input: { mutation: () => void }) => {
            input.mutation();
        });

        await activateThemeProfile({
            profileId: 'premiumDark',
            forceAnimate: true,
            reduceMotion: false,
            systemTheme: 'dark',
            loadLocalSettings: () => ({
                themePreference: 'dark',
                themeProfiles: { activeProfileIds: { light: null, dark: null }, profiles: [] },
            }),
            saveLocalSettings,
            runThemePreferenceChange,
            applySelection: vi.fn(),
            setStatusBarStyle: vi.fn(),
        });

        expect(saveLocalSettings).toHaveBeenCalledWith(expect.objectContaining({
            themeProfiles: {
                activeProfileIds: { light: null, dark: 'premiumDark' },
                profiles: [],
            },
        }));
    });

    it('keeps reduced motion authoritative for forced profile activation', async () => {
        const runThemePreferenceChange = vi.fn(async (input: { mutation: () => void }) => {
            input.mutation();
        });

        await activateThemeProfile({
            profileId: 'ocean',
            forceAnimate: true,
            reduceMotion: true,
            systemTheme: 'dark',
            loadLocalSettings: () => ({
                themePreference: 'dark',
                themeProfiles: profileState,
            }),
            saveLocalSettings: vi.fn(),
            runThemePreferenceChange,
            applySelection: vi.fn(),
            setStatusBarStyle: vi.fn(),
        });

        expect(runThemePreferenceChange).toHaveBeenCalledWith(expect.objectContaining({
            forceAnimate: false,
            reduceMotion: true,
        }));
    });
});
