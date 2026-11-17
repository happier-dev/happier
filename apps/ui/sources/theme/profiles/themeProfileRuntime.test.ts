import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { registerNativeThemePreferenceTransitionController } from '@/components/settings/appearance/themePreferenceTransition';

const platformRuntime = vi.hoisted(() => ({
    setStatusBarStyle: vi.fn(),
    setTheme: vi.fn(),
    setRootViewBackgroundColor: vi.fn(),
}));
vi.mock('expo-status-bar', () => ({ setStatusBarStyle: platformRuntime.setStatusBarStyle }));
vi.mock('expo-system-ui', () => ({ setBackgroundColorAsync: vi.fn(async () => {}) }));
vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock({ runtime: {
        setTheme: platformRuntime.setTheme,
        setRootViewBackgroundColor: platformRuntime.setRootViewBackgroundColor,
    } });
});

import { darkTheme, lightTheme, type Theme } from '@/theme';
import type { LocalSettings } from '@/sync/domains/settings/localSettings';
import {
    commitThemeSelection,
    applyThemeRuntimeSelection,
    resolveEffectiveThemeRuntimeBackground,
    resolveThemeRuntimeStartupThemes,
    resolveThemeRuntimeThemes,
} from './themeProfileRuntime';
import { getBuiltInThemeProfileDefinition } from './builtInThemeProfiles';
import type { ThemeProfilesLocalStateV1 } from './themeProfileTypes';
import { parseThemeProfileDocument } from '@happier-dev/protocol/account/settings/themeProfiles';
import type { ThemeTryOnSnapshot } from './themeTryOn';

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
    it('renders one retained preview mode and restores the latest saved selection when it clears', () => {
        platformRuntime.setStatusBarStyle.mockClear();
        const parsed = parseThemeProfileDocument({ ...profileState.profiles[0],
            overrides: { light: { 'background.canvas': '#abc123' }, dark: { 'background.canvas': '#123abc' } },
            style: { radius: 'round' } });
        if (!parsed.ok) throw new Error('Invalid preview fixture');
        const preview: ThemeTryOnSnapshot = { document: parsed.document, mode: 'light', origin: { kind: 'editor' }, previewRef: 'preview' };
        const registered: Record<'light' | 'dark', Theme> = { light: lightTheme, dark: darkTheme };
        const updateTheme = vi.fn((mode: 'light' | 'dark', updater: (theme: Theme) => Theme) => { registered[mode] = updater(registered[mode]); });
        const input = {
            themePreference: 'dark' as const, themeProfiles: profileState, platform: 'ios', systemTheme: 'dark' as const,
            unistylesRuntime: { getTheme: (mode: 'light' | 'dark') => registered[mode], updateTheme,
                setAdaptiveThemes: vi.fn(), setTheme: vi.fn(), setRootViewBackgroundColor: vi.fn() },
            setSystemBackgroundColor: vi.fn(), recordBreadcrumb: vi.fn(), style: null,
        };
        const tried = applyThemeRuntimeSelection({ ...input, preview });
        expect(tried.light.colors.background.canvas).toBe('#abc123');
        expect(tried.dark.colors.background.canvas).toBe('#0a0a0a');
        expect(tried.light.borderRadius.xl).toBeGreaterThan(lightTheme.borderRadius.xl);
        expect(input.unistylesRuntime.setTheme).toHaveBeenLastCalledWith('light');
        expect(platformRuntime.setStatusBarStyle).toHaveBeenLastCalledWith('dark', true);
        expect(updateTheme).toHaveBeenCalledTimes(1);
        updateTheme.mockClear();
        applyThemeRuntimeSelection({ ...input, preview });
        expect(updateTheme).not.toHaveBeenCalled();
        const base: ThemeTryOnSnapshot = { document: null, selection: null, mode: 'light', origin: { kind: 'editor' }, previewRef: 'base' };
        expect(applyThemeRuntimeSelection({ ...input, preview: base }).light).toBe(lightTheme);
        const latest = { ...profileState, profiles: [{ ...profileState.profiles[0], overrides: {
            light: {}, dark: { 'background.canvas': '#334455' },
        } }] };
        const restored = applyThemeRuntimeSelection({ ...input, themeProfiles: latest, preview: null });
        expect(restored.dark.colors.background.canvas).toBe('#334455');
        expect(input.unistylesRuntime.setTheme).toHaveBeenLastCalledWith('dark');
        expect(platformRuntime.setStatusBarStyle).toHaveBeenLastCalledWith('light', true);
    });
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
                getTheme: (name) => name === 'light' ? lightTheme : darkTheme,
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
        expect(setRootViewBackgroundColor).not.toHaveBeenCalled();
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
                getTheme: (name) => name === 'light' ? lightTheme : darkTheme,
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

    it('updates only the visual native theme in adaptive mode; the OS observer applies the next mode', () => {
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
                getTheme: (name) => name === 'light' ? lightTheme : darkTheme,
                updateTheme,
                setAdaptiveThemes,
                setTheme,
                setRootViewBackgroundColor,
            },
            setSystemBackgroundColor: vi.fn(),
        });

        expect(updateTheme).toHaveBeenCalledWith('light', expect.any(Function));
        expect(updateTheme).toHaveBeenCalledTimes(1);
        expect(setAdaptiveThemes).toHaveBeenCalledWith(false);
        expect(setTheme).toHaveBeenCalledWith('light');
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
                getTheme: (name) => name === 'light' ? darkTheme : lightTheme,
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
        const registeredThemes: Record<'light' | 'dark', Theme> = { light: lightTheme, dark: darkTheme };
        const updateTheme = vi.fn((name: 'light' | 'dark', updater: (theme: Theme) => Theme) => {
            registeredThemes[name] = updater(registeredThemes[name]);
        });
        const setRootViewBackgroundColor = vi.fn();
        const setAdaptiveThemes = vi.fn(() => {
            throw new Error('runtime failed');
        });

        const result = applyThemeRuntimeSelection({
            themePreference: 'dark',
            themeProfiles: profileState,
            systemTheme: 'dark',
            unistylesRuntime: {
                getTheme: (name) => registeredThemes[name],
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
        expect(finalDarkUpdater?.(registeredThemes.dark)).toBe(darkTheme);
    });

    it('commits the resolved selection through the native transition with forced animation', async () => {
        const writeLocal = vi.fn();
        const run = vi.fn(async (mutation: () => void) => mutation());
        onTestFinished(registerNativeThemePreferenceTransitionController({ run }));

        await commitThemeSelection({
            currentPreference: 'light', nextPreference: 'light', nextThemeProfiles: profileState,
            forceAnimate: true,
            reduceMotion: false,
            systemTheme: 'light',
            platform: 'ios',
            writeLocal,
        });

        expect(run).toHaveBeenCalledOnce();
        expect(writeLocal).toHaveBeenCalledWith(expect.objectContaining({
            themeProfiles: expect.objectContaining({
                activeProfileIds: { light: 'ocean', dark: 'ocean' },
            }),
        }));
    });

    it('commits the latest resolved selection inside the native transition mutation', async () => {
        let selection: Pick<LocalSettings, 'themePreference' | 'themeProfiles'> = { themePreference: 'light', themeProfiles: profileState };
        const writeLocal = vi.fn((next: typeof selection) => { selection = next; });
        const run = vi.fn(async (mutation: () => void) => {
            selection = { themePreference: 'dark',
                themeProfiles: { activeProfileIds: { light: null, dark: 'ocean' },
                    profiles: [...profileState.profiles, ...pairedProfileState.profiles] } };
            mutation();
        });
        onTestFinished(registerNativeThemePreferenceTransitionController({ run }));

        await commitThemeSelection({
            currentPreference: 'light', nextPreference: 'light', nextThemeProfiles: profileState,
            forceAnimate: true,
            reduceMotion: false,
            systemTheme: 'light',
            platform: 'ios',
            resolveSelection: () => selection,
            writeLocal,
        });

        expect(writeLocal).toHaveBeenCalledWith(expect.objectContaining({
            themePreference: 'dark',
            themeProfiles: expect.objectContaining({
                activeProfileIds: { light: null, dark: 'ocean' },
            }),
        }));
        expect(selection.themeProfiles.profiles).toHaveLength(3);
        expect(platformRuntime.setTheme).toHaveBeenLastCalledWith('dark');
        expect(platformRuntime.setRootViewBackgroundColor).toHaveBeenLastCalledWith('#0a0a0a');
        expect(platformRuntime.setStatusBarStyle).toHaveBeenLastCalledWith('light', true);
    });

    it('keeps reduced motion authoritative for a forced selection transition', async () => {
        const run = vi.fn(async (mutation: () => void) => mutation());
        onTestFinished(registerNativeThemePreferenceTransitionController({ run }));

        await commitThemeSelection({
            currentPreference: 'dark', nextPreference: 'dark', nextThemeProfiles: profileState,
            forceAnimate: true,
            reduceMotion: true,
            systemTheme: 'dark',
            platform: 'ios',
            writeLocal: vi.fn(),
        });

        expect(run).not.toHaveBeenCalled();
    });
});
