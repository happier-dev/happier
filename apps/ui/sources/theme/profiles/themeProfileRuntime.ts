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
    type ThemeTransitionPlatform,
} from '@/components/settings/appearance/themePreferenceTransition';
import {
    loadLocalSettings as defaultLoadLocalSettings,
    saveLocalSettings as defaultSaveLocalSettings,
} from '@/sync/domains/state/persistence';
import type { LocalSettings } from '@/sync/domains/settings/localSettings';
import { applyLocalSettings, localSettingsDefaults } from '@/sync/domains/settings/localSettings';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { addBreadcrumbIfEnabled } from '@/utils/system/sentry';
import {
    findActiveThemeProfileForMode,
    setActiveThemeProfileForMode,
} from './themeProfilePersistence';
import { resolveThemeProfile } from './resolveThemeProfile';
import type { ThemeProfileMode, ThemeProfileSelectionByMode, ThemeProfilesLocalStateV1 } from './themeProfileTypes';

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
    platform?: string;
    unistylesRuntime?: ThemeRuntimeUnistylesAdapter;
    setSystemBackgroundColor?: (color: string) => Promise<unknown> | void;
    resolveThemes?: (themeProfiles: ThemeProfilesLocalStateV1) => ThemeRuntimeThemes;
    recordBreadcrumb?: (breadcrumb: ThemeRuntimeBreadcrumb) => void;
}>;

type ThemeRuntimeBreadcrumb = Readonly<{
    phase: 'resolved' | 'update-all-themes' | 'update-visual-theme' | 'set-adaptive-themes' | 'set-theme' | 'root-background';
    themePreference: ThemePreference;
    platform: string;
    activeProfileIds: ThemeProfileSelectionByMode;
    systemTheme: AppThemeName | null;
    visualTheme?: AppThemeName;
    themeName?: AppThemeName;
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
    profileMode?: ThemeProfileMode | 'all';
    themePreference?: ThemePreference;
    forceAnimate?: boolean;
    reduceMotion?: boolean;
    systemTheme?: AppThemeName | null;
    platform?: ThemeTransitionPlatform;
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
    return {
        light: resolveThemeProfile({ mode: 'light', profile: findActiveThemeProfileForMode(themeProfiles, 'light') }),
        dark: resolveThemeProfile({ mode: 'dark', profile: findActiveThemeProfileForMode(themeProfiles, 'dark') }),
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

const resolveRuntimePlatform = (input: ApplyThemeRuntimeSelectionInput): string => input.platform ?? Platform.OS;

const isNativeRuntimePlatform = (platform: string): boolean => platform !== 'web';

const recordThemeRuntimeBreadcrumb = (
    input: ApplyThemeRuntimeSelectionInput,
    breadcrumb: Omit<ThemeRuntimeBreadcrumb, 'themePreference' | 'platform' | 'activeProfileIds' | 'systemTheme'> & Readonly<{
        platform: string;
        systemTheme: AppThemeName | null;
    }>,
): void => {
    const data: ThemeRuntimeBreadcrumb = {
        ...breadcrumb,
        themePreference: input.themePreference,
        activeProfileIds: input.themeProfiles.activeProfileIds,
    };
    const record = input.recordBreadcrumb ?? ((nextBreadcrumb: ThemeRuntimeBreadcrumb) => {
        addBreadcrumbIfEnabled({
            category: 'theme.runtime',
            level: 'info',
            data: nextBreadcrumb,
        });
    });

    record(data);
};

const applyThemesToUnistyles = (
    themes: ThemeRuntimeThemes,
    input: ApplyThemeRuntimeSelectionInput,
): void => {
    const runtime = input.unistylesRuntime ?? defaultUnistylesRuntimeAdapter;
    const platform = resolveRuntimePlatform(input);
    const systemTheme = input.systemTheme ?? getSystemTheme();
    const visualTheme = resolveThemeRuntimeVisualTheme(input.themePreference, systemTheme);

    recordThemeRuntimeBreadcrumb(input, { phase: 'resolved', platform, systemTheme, visualTheme });

    if (isNativeRuntimePlatform(platform) && input.themePreference !== 'adaptive') {
        recordThemeRuntimeBreadcrumb(input, {
            phase: 'update-visual-theme',
            platform,
            systemTheme,
            visualTheme,
            themeName: visualTheme,
        });
        runtime.updateTheme(visualTheme, () => themes[visualTheme]);
    } else {
        recordThemeRuntimeBreadcrumb(input, { phase: 'update-all-themes', platform, systemTheme, visualTheme });
        runtime.updateTheme('light', () => themes.light);
        runtime.updateTheme('dark', () => themes.dark);
    }

    if (input.themePreference === 'adaptive') {
        recordThemeRuntimeBreadcrumb(input, { phase: 'set-adaptive-themes', platform, systemTheme, visualTheme });
        runtime.setAdaptiveThemes(true);
    } else {
        runtime.setAdaptiveThemes(false);
        recordThemeRuntimeBreadcrumb(input, {
            phase: 'set-theme',
            platform,
            systemTheme,
            visualTheme,
            themeName: input.themePreference,
        });
        runtime.setTheme(input.themePreference);
    }

    const background = resolveEffectiveThemeRuntimeBackground({
        themes,
        themePreference: input.themePreference,
        systemTheme,
    });
    recordThemeRuntimeBreadcrumb(input, { phase: 'root-background', platform, systemTheme, visualTheme });
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

const resolveActivationModes = (input: Readonly<{
    profileMode?: ThemeProfileMode | 'all';
    themePreference?: ThemePreference;
}>): readonly ThemeProfileMode[] => {
    if (input.profileMode === 'light' || input.profileMode === 'dark') {
        return [input.profileMode];
    }
    if (input.profileMode === 'all') {
        return ['light', 'dark'];
    }
    const themePreference = input.themePreference;
    if (themePreference === 'light' || themePreference === 'dark') {
        return [themePreference];
    }
    return ['light', 'dark'];
};

export const activateThemeProfile = async (input: ActivateThemeProfileInput): Promise<void> => {
    const loadLocalSettings = input.loadLocalSettings ?? defaultLoadLocalSettings;
    const saveLocalSettings = input.saveLocalSettings ?? defaultSaveLocalSettings;
    const runThemePreferenceChange = input.runThemePreferenceChange ?? defaultRunThemePreferenceChange;
    const applySelection = input.applySelection ?? applyThemeRuntimeSelection;
    const applyStatusBarStyle = input.setStatusBarStyle ?? setStatusBarStyle;
    const currentSettings = loadLocalSettings();
    const resolveNextThemeProfiles = (
        themeProfiles: ThemeProfilesLocalStateV1,
        fallbackThemePreference: ThemePreference,
    ): ThemeProfilesLocalStateV1 => (
        resolveActivationModes({
            profileMode: input.profileMode,
            themePreference: input.themePreference ?? fallbackThemePreference,
        }).reduce(
            (nextThemeProfiles, mode) => setActiveThemeProfileForMode(nextThemeProfiles, mode, input.profileId),
            themeProfiles,
        )
    );
    const nextThemeProfiles = resolveNextThemeProfiles(currentSettings.themeProfiles, currentSettings.themePreference);
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
                themeProfiles: resolveNextThemeProfiles(latestSettings.themeProfiles, latestSettings.themePreference),
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
