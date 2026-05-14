import { Appearance, Platform } from 'react-native';
import * as SystemUI from 'expo-system-ui';
import { setStatusBarStyle } from 'expo-status-bar';
import type { StatusBarStyle } from 'expo-status-bar';
import { UnistylesRuntime } from 'react-native-unistyles';

import type { Theme } from '@/theme';
import { darkTheme, lightTheme } from '@/theme';
import type { ThemePreference } from '@/components/ui/layout/statusBarStyle';
import { resolveStatusBarStyleForThemePreference } from '@/components/ui/layout/statusBarStyle';
import {
    runThemePreferenceChange as defaultRunThemePreferenceChange,
    type ThemePreferenceChangeInput,
} from '@/components/settings/appearance/themePreferenceTransition';
import {
    loadLocalSettings as defaultLoadLocalSettings,
    saveLocalSettings as defaultSaveLocalSettings,
} from '@/sync/domains/state/persistence';
import type { LocalSettings } from '@/sync/domains/settings/localSettings';
import { applyLocalSettings, localSettingsDefaults } from '@/sync/domains/settings/localSettings';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { findThemeProfileById } from './themeProfilePersistence';
import { resolveThemeProfile } from './resolveThemeProfile';
import type { ThemeProfilesLocalStateV1 } from './themeProfileTypes';

type AppThemeName = 'light' | 'dark';

export type ThemeRuntimeThemes = Readonly<Record<AppThemeName, Theme>>;

export type ThemeRuntimeUnistylesAdapter = Readonly<{
    updateTheme: (themeName: AppThemeName, updater: (theme: Theme) => Theme) => void;
    setAdaptiveThemes: (enabled: boolean) => void;
    setTheme: (themeName: AppThemeName) => void;
    setRootViewBackgroundColor: (color: string) => void;
}>;

type ApplyThemeRuntimeSelectionInput = Readonly<{
    themePreference: ThemePreference;
    themeProfiles: ThemeProfilesLocalStateV1;
    systemTheme?: AppThemeName | null;
    unistylesRuntime?: ThemeRuntimeUnistylesAdapter;
    setSystemBackgroundColor?: (color: string) => Promise<unknown> | void;
    resolveThemes?: (themeProfiles: ThemeProfilesLocalStateV1) => ThemeRuntimeThemes;
}>;

type ResolveThemeRuntimeStartupThemesInput = Readonly<{
    themePreference: ThemePreference;
    themeProfiles: ThemeProfilesLocalStateV1;
    systemTheme?: AppThemeName | null;
    resolveThemes?: (themeProfiles: ThemeProfilesLocalStateV1) => ThemeRuntimeThemes;
}>;

type ThemeRuntimeStartupThemes = Readonly<{
    themes: ThemeRuntimeThemes;
    backgroundColor: string;
}>;

type ActivateThemeProfileInput = Readonly<{
    profileId: string | null;
    themePreference?: ThemePreference;
    forceAnimate?: boolean;
    reduceMotion?: boolean;
    systemTheme?: AppThemeName | null;
    platform?: string;
    loadLocalSettings?: () => Pick<LocalSettings, 'themePreference' | 'themeProfiles'>;
    saveLocalSettings?: (settings: LocalSettings) => void;
    runThemePreferenceChange?: (input: ThemePreferenceChangeInput) => Promise<void>;
    applySelection?: (input: ApplyThemeRuntimeSelectionInput) => void;
    setStatusBarStyle?: (style: StatusBarStyle, animated?: boolean) => void;
}>;

const canonicalBaseThemes: ThemeRuntimeThemes = Object.freeze({
    light: lightTheme,
    dark: darkTheme,
});

const defaultUnistylesRuntimeAdapter: ThemeRuntimeUnistylesAdapter = {
    updateTheme: (themeName, updater) => {
        UnistylesRuntime.updateTheme(themeName, updater);
    },
    setAdaptiveThemes: (enabled) => {
        UnistylesRuntime.setAdaptiveThemes(enabled);
    },
    setTheme: (themeName) => {
        UnistylesRuntime.setTheme(themeName);
    },
    setRootViewBackgroundColor: (color) => {
        UnistylesRuntime.setRootViewBackgroundColor(color);
    },
};

const warnThemeRuntimeFallback = (error: unknown): void => {
    if (typeof __DEV__ !== 'undefined' && __DEV__) {
        console.warn('Falling back to canonical base themes after theme profile runtime failure.', error);
    }
};

export const resolveThemeRuntimeThemes = (themeProfiles: ThemeProfilesLocalStateV1): ThemeRuntimeThemes => {
    const activeProfile = findThemeProfileById(themeProfiles, themeProfiles.activeProfileId);
    if (!activeProfile) {
        return canonicalBaseThemes;
    }

    return {
        light: resolveThemeProfile({ mode: 'light', profile: activeProfile }),
        dark: resolveThemeProfile({ mode: 'dark', profile: activeProfile }),
    };
};

export const resolveThemeRuntimeVisualTheme = (
    themePreference: ThemePreference,
    systemTheme: AppThemeName | null | undefined,
): AppThemeName => {
    if (themePreference === 'adaptive') {
        return systemTheme === 'dark' ? 'dark' : 'light';
    }
    return themePreference;
};

export const resolveEffectiveThemeRuntimeBackground = (input: Readonly<{
    themes: ThemeRuntimeThemes;
    themePreference: ThemePreference;
    systemTheme?: AppThemeName | null;
}>): string => {
    const visualTheme = resolveThemeRuntimeVisualTheme(input.themePreference, input.systemTheme);
    return input.themes[visualTheme].colors.background.canvas;
};

const resolveCanonicalBaseThemeRuntimeBackground = (
    themePreference: ThemePreference,
    systemTheme: AppThemeName | null | undefined,
): string => {
    const visualTheme = resolveThemeRuntimeVisualTheme(themePreference, systemTheme);
    return canonicalBaseThemes[visualTheme].colors.background.canvas;
};

export const resolveThemeRuntimeStartupThemes = (
    input: ResolveThemeRuntimeStartupThemesInput,
): ThemeRuntimeStartupThemes => {
    const resolveThemes = input.resolveThemes ?? resolveThemeRuntimeThemes;

    let themes: ThemeRuntimeThemes;
    try {
        themes = resolveThemes(input.themeProfiles);
    } catch (error) {
        warnThemeRuntimeFallback(error);
        themes = canonicalBaseThemes;
    }

    try {
        return {
            themes,
            backgroundColor: resolveEffectiveThemeRuntimeBackground({
                themes,
                themePreference: input.themePreference,
                systemTheme: input.systemTheme,
            }),
        };
    } catch (error) {
        warnThemeRuntimeFallback(error);
        return {
            themes: canonicalBaseThemes,
            backgroundColor: resolveCanonicalBaseThemeRuntimeBackground(input.themePreference, input.systemTheme),
        };
    }
};

const getSystemTheme = (): AppThemeName => (Appearance.getColorScheme() === 'dark' ? 'dark' : 'light');

const applyThemesToUnistyles = (
    themes: ThemeRuntimeThemes,
    input: ApplyThemeRuntimeSelectionInput,
): void => {
    const runtime = input.unistylesRuntime ?? defaultUnistylesRuntimeAdapter;
    runtime.updateTheme('light', () => themes.light);
    runtime.updateTheme('dark', () => themes.dark);

    if (input.themePreference === 'adaptive') {
        runtime.setAdaptiveThemes(true);
    } else {
        runtime.setAdaptiveThemes(false);
        runtime.setTheme(input.themePreference);
    }

    const background = resolveEffectiveThemeRuntimeBackground({
        themes,
        themePreference: input.themePreference,
        systemTheme: input.systemTheme ?? getSystemTheme(),
    });
    runtime.setRootViewBackgroundColor(background);
    const setSystemBackgroundColor = input.setSystemBackgroundColor ?? SystemUI.setBackgroundColorAsync;
    fireAndForget(Promise.resolve(setSystemBackgroundColor(background)), { tag: 'themeProfileRuntime.setSystemBackgroundColor' });
};

export const applyThemeRuntimeSelection = (input: ApplyThemeRuntimeSelectionInput): ThemeRuntimeThemes => {
    const resolveThemes = input.resolveThemes ?? resolveThemeRuntimeThemes;

    let themes: ThemeRuntimeThemes;
    try {
        themes = resolveThemes(input.themeProfiles);
    } catch (error) {
        warnThemeRuntimeFallback(error);
        themes = canonicalBaseThemes;
    }

    try {
        applyThemesToUnistyles(themes, input);
        return themes;
    } catch (error) {
        warnThemeRuntimeFallback(error);
        if (themes !== canonicalBaseThemes) {
            try {
                applyThemesToUnistyles(canonicalBaseThemes, input);
            } catch (fallbackError) {
                warnThemeRuntimeFallback(fallbackError);
            }
        }
        return canonicalBaseThemes;
    }
};

export const activateThemeProfile = async (input: ActivateThemeProfileInput): Promise<void> => {
    const loadLocalSettings = input.loadLocalSettings ?? defaultLoadLocalSettings;
    const saveLocalSettings = input.saveLocalSettings ?? defaultSaveLocalSettings;
    const runThemePreferenceChange = input.runThemePreferenceChange ?? defaultRunThemePreferenceChange;
    const applySelection = input.applySelection ?? applyThemeRuntimeSelection;
    const applyStatusBarStyle = input.setStatusBarStyle ?? setStatusBarStyle;
    const resolveNextThemeProfiles = (themeProfiles: ThemeProfilesLocalStateV1): ThemeProfilesLocalStateV1 => ({
        ...themeProfiles,
        activeProfileId: findThemeProfileById(themeProfiles, input.profileId) ? input.profileId : null,
    });
    const currentSettings = loadLocalSettings();
    const nextThemeProfiles = resolveNextThemeProfiles(currentSettings.themeProfiles);
    const currentSettingsForApply = {
        ...localSettingsDefaults,
        ...currentSettings,
    } satisfies LocalSettings;
    const nextSettings = applyLocalSettings(currentSettingsForApply, {
        ...(input.themePreference ? { themePreference: input.themePreference } : {}),
        themeProfiles: nextThemeProfiles,
    });
    const systemTheme = input.systemTheme ?? getSystemTheme();
    const reduceMotion = input.reduceMotion ?? false;

    await runThemePreferenceChange({
        currentPreference: currentSettings.themePreference,
        nextPreference: nextSettings.themePreference,
        platform: input.platform ?? Platform.OS,
        reduceMotion,
        forceAnimate: reduceMotion ? false : input.forceAnimate,
        systemTheme,
        mutation: () => {
            const latestSettings = loadLocalSettings();
            const latestSettingsForApply = {
                ...localSettingsDefaults,
                ...latestSettings,
            } satisfies LocalSettings;
            const latestNextSettings = applyLocalSettings(latestSettingsForApply, {
                ...(input.themePreference ? { themePreference: input.themePreference } : {}),
                themeProfiles: resolveNextThemeProfiles(latestSettings.themeProfiles),
            });

            saveLocalSettings(latestNextSettings);
            applySelection({
                themePreference: latestNextSettings.themePreference,
                themeProfiles: latestNextSettings.themeProfiles,
                systemTheme,
            });
            applyStatusBarStyle(resolveStatusBarStyleForThemePreference(latestNextSettings.themePreference, systemTheme), true);
        },
    });
};
