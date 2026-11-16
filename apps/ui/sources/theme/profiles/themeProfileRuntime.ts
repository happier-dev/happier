import { readThemeProfileLegacyAccountScope } from '@/sync/domains/state/themeProfileMigrationUiState';
import { Appearance, Platform } from 'react-native';
import * as SystemUI from 'expo-system-ui';
import { setStatusBarStyle } from 'expo-status-bar';
import { UnistylesRuntime } from 'react-native-unistyles';

import type { Theme } from '@/theme';
import { darkTheme, lightTheme } from '@/theme';
import type { ThemePreference } from '@/components/ui/layout/statusBarStyle';
import { resolveStatusBarStyleForThemePreference } from '@/components/ui/layout/statusBarStyle';
import {
    runThemePreferenceChange as defaultRunThemePreferenceChange,
    type ThemeTransitionPlatform,
} from '@/components/settings/appearance/themePreferenceTransition';
import {
    loadLocalSettings as defaultLoadLocalSettings,
    loadThemeRuntimeLocalState,
    saveLocalSettings as defaultSaveLocalSettings,
} from '@/sync/domains/state/persistence';
import type { LocalSettings } from '@/sync/domains/settings/localSettings';
import { loadPendingAccountSettingsState } from '@/sync/domains/state/accountSettingsPersistence';
import { loadStartupAccountSettings } from '@/sync/domains/state/startupAccountSettings';
import { canUseLegacyThemeProfiles, encodeThemeProfileSelection } from '@/sync/domains/settings/themeProfiles';
import { applyLocalSettings, localSettingsDefaults } from '@/sync/domains/settings/localSettings';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { addBreadcrumbIfEnabled } from '@/utils/system/sentry';
import {
    DEFAULT_THEME_PROFILES_LOCAL_STATE,
    findActiveThemeProfileForMode,
    setActiveThemeProfileForMode,
} from './themeProfilePersistence';
import { createThemeProfileResolver } from './resolveThemeProfile';
import { applyThemeFontFamilyVariables } from '../themeFontFamilyVariables';
import { applyThemeStylesheet } from '../css/themeStylesheet';
import { applyThemeStyleScales, resolveThemeStyleScales, themeStyleSelectionFromSurfaceFinish, type ThemeStyleSelection } from '../themeStyleScales';
import type { ThemeProfileMode, ThemeProfileSelectionByMode, ThemeProfilesLocalStateV1 } from './themeProfileTypes';

type AppThemeName = 'light' | 'dark';

export type ThemeRuntimeThemes = Readonly<Record<AppThemeName, Theme>>;

export type ThemeRuntimeUnistylesAdapter = Readonly<{
    getTheme: (themeName: AppThemeName) => Theme;
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
    /**
     * Shared scales for both themes. Absent uses the device's finish; explicit `null` uses the
     * canonical defaults. The embed supplies the style its host chose.
     */
    style?: ThemeStyleSelection | null;
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
    style?: ThemeStyleSelection | null;
}>;

type ThemeRuntimeStartupThemes = Readonly<{
    themes: ThemeRuntimeThemes;
    backgroundColor: string;
}>;

type ActivateThemeProfileInput = Readonly<{
    profileId: string | null;
    resolveProfileId?: () => string | null;
    profileMode?: ThemeProfileMode | 'all';
    themePreference?: ThemePreference;
    forceAnimate?: boolean;
    reduceMotion?: boolean;
    systemTheme?: AppThemeName | null;
    platform?: ThemeTransitionPlatform;
    loadLocalSettings?: () => Pick<LocalSettings, 'themePreference' | 'themeProfiles'>;
    saveLocalSettings?: (settings: LocalSettings) => void;
}>;

type ThemeSelection = Pick<LocalSettings, 'themePreference' | 'themeProfiles'>;

type CommitThemeSelectionInput = Readonly<{
    currentPreference: ThemePreference;
    nextPreference: ThemePreference;
    nextThemeProfiles: ThemeProfilesLocalStateV1;
    reduceMotion: boolean;
    writeLocal: (delta: ThemeSelection) => void;
    /** Rebase profile activation on the settings present when the transition actually commits. */
    resolveSelection?: () => ThemeSelection;
    forceAnimate?: boolean;
    systemTheme?: AppThemeName | null;
    platform?: ThemeTransitionPlatform;
}>;

const canonicalBaseThemes: ThemeRuntimeThemes = Object.freeze({
    light: lightTheme,
    dark: darkTheme,
});

const defaultUnistylesRuntimeAdapter: ThemeRuntimeUnistylesAdapter = {
    getTheme: (themeName) => UnistylesRuntime.getTheme(themeName),
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

const runtimeThemeResolver = createThemeProfileResolver();

export const resolveThemeRuntimeThemes = (themeProfiles: ThemeProfilesLocalStateV1): ThemeRuntimeThemes => {
    return {
        light: runtimeThemeResolver.resolve({ mode: 'light', profile: findActiveThemeProfileForMode(themeProfiles, 'light') }),
        dark: runtimeThemeResolver.resolve({ mode: 'dark', profile: findActiveThemeProfileForMode(themeProfiles, 'dark') }),
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

/** Profile corners/typeface and device presentation occupy independent slots. */
const composeRuntimeThemeStyles = (
    themes: ThemeRuntimeThemes,
    profiles: ThemeProfilesLocalStateV1,
    style: ThemeStyleSelection | null,
): ThemeRuntimeThemes => {
    const compose = (mode: AppThemeName): Theme => applyThemeStyleScales(themes[mode], resolveThemeStyleScales({
        ...findActiveThemeProfileForMode(profiles, mode)?.style,
        ...style,
    }));
    return { light: compose('light'), dark: compose('dark') };
};

export const resolveThemeRuntimeStartupThemes = (
    input: ResolveThemeRuntimeStartupThemesInput,
): ThemeRuntimeStartupThemes => {
    const resolveThemes = input.resolveThemes ?? resolveThemeRuntimeThemes;

    let themes: ThemeRuntimeThemes;
    try {
        const resolved = resolveThemes(input.themeProfiles);
        themes = composeRuntimeThemeStyles(resolved, input.themeProfiles, input.style ?? null);
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

export const readSystemTheme = (): AppThemeName => (Appearance.getColorScheme() === 'dark' ? 'dark' : 'light');

let currentRuntimeSelection: Readonly<{ themes: ThemeRuntimeThemes; input: ApplyThemeRuntimeSelectionInput }> | null = null;
let appearanceSubscription: ReturnType<typeof Appearance.addChangeListener> | null = null;
const systemThemeSubscribers = new Set<() => void>();
/** OS readers subscribe here, never register another platform listener. */
export const subscribeSystemTheme = (listener: () => void): (() => void) => {
    systemThemeSubscribers.add(listener);
    observeSystemTheme();
    return () => { systemThemeSubscribers.delete(listener); };
};

function observeSystemTheme(): void {
    if (appearanceSubscription) return;
    appearanceSubscription = Appearance.addChangeListener(({ colorScheme }) => {
        for (const listener of systemThemeSubscribers) listener();
        const current = currentRuntimeSelection;
        if (!current || current.input.themePreference !== 'adaptive') return;
        const systemTheme = colorScheme === 'dark' ? 'dark' : 'light';
        applyThemesToUnistyles(current.themes, { ...current.input, systemTheme });
        setStatusBarStyle(resolveStatusBarStyleForThemePreference('adaptive', systemTheme), true);
    });
}

/** Both platform bootstraps and later previews/commits share this one OS observer. */
export const initializeThemeRuntimeAppearance = (input: ApplyThemeRuntimeSelectionInput, themes: ThemeRuntimeThemes): void => {
    currentRuntimeSelection = { input, themes };
    observeSystemTheme();
};

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
    const systemTheme = input.systemTheme ?? readSystemTheme();
    const visualTheme = resolveThemeRuntimeVisualTheme(input.themePreference, systemTheme);

    if (platform === 'web') {
        const source = findActiveThemeProfileForMode(input.themeProfiles, visualTheme)?.css;
        // The sheet owner parses before attachment and retains last-good on failure.
        applyThemeStylesheet(source ? { source } : null, visualTheme);
    }

    // updateTheme notifies every theme subscriber and rebuilds the web CSS sheet even when the
    // resolved tokens are identical. A mode-only flip needs just setTheme's one notification.
    const updateChangedTheme = (name: AppThemeName): void => {
        const next = themes[name];
        const registered = runtime.getTheme(name);
        if (registered === next) return;
        runtime.updateTheme(name, () => next);
    };

    recordThemeRuntimeBreadcrumb(input, { phase: 'resolved', platform, systemTheme, visualTheme });

    if (isNativeRuntimePlatform(platform)) {
        recordThemeRuntimeBreadcrumb(input, {
            phase: 'update-visual-theme',
            platform,
            systemTheme,
            visualTheme,
            themeName: visualTheme,
        });
        updateChangedTheme(visualTheme);
    } else {
        recordThemeRuntimeBreadcrumb(input, { phase: 'update-all-themes', platform, systemTheme, visualTheme });
        updateChangedTheme('light');
        updateChangedTheme('dark');
    }

    // Explicit switching notifies token hooks and CSS together. Delegating adaptive switching
    // to Unistyles as well would give the OS flip a second, competing theme owner.
    runtime.setAdaptiveThemes(false);
    recordThemeRuntimeBreadcrumb(input, { phase: 'set-theme', platform, systemTheme, visualTheme, themeName: visualTheme });
    runtime.setTheme(visualTheme);

    // Mounted web roots subscribe to the actual theme and resolved material presentation.
    // Imperative web writes here would race that owner and flatten native glass backing.
    if (isNativeRuntimePlatform(platform)) {
        if (typeof window !== 'undefined' && window.location?.pathname.replace(/\/+$/u, '') === '/desktop/activity-overlay') {
            runtime.setRootViewBackgroundColor('transparent');
            return;
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
    }
};

export const applyThemeRuntimeSelection = (input: ApplyThemeRuntimeSelectionInput): ThemeRuntimeThemes => {
    const resolveThemes = input.resolveThemes ?? resolveThemeRuntimeThemes;

    const style = input.style === undefined
        ? themeStyleSelectionFromSurfaceFinish(defaultLoadLocalSettings()) : input.style;
    let themes: ThemeRuntimeThemes;
    try {
        const profileThemes = resolveThemes(input.themeProfiles);
        themes = composeRuntimeThemeStyles(profileThemes, input.themeProfiles, style);
    } catch (error) {
        warnThemeRuntimeFallback(error);
        themes = canonicalBaseThemes;
    }

    if (resolveRuntimePlatform(input) === 'web') {
        const visualTheme = resolveThemeRuntimeVisualTheme(input.themePreference, input.systemTheme ?? readSystemTheme());
        applyThemeFontFamilyVariables(themes[visualTheme].typography);
    }

    try {
        applyThemesToUnistyles(themes, input);
        if (!input.unistylesRuntime) currentRuntimeSelection = { input, themes };
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
        if (!input.unistylesRuntime) currentRuntimeSelection = { input, themes: canonicalBaseThemes };
        return canonicalBaseThemes;
    }
};

const applyResolvedThemeRuntimeSelection = (
    selection: ThemeSelection,
    systemTheme: AppThemeName,
): void => {
    applyThemeRuntimeSelection({ ...selection, systemTheme });
    setStatusBarStyle(resolveStatusBarStyleForThemePreference(selection.themePreference, systemTheme), true);
};

/** Apply an unconfirmed selection to the running app without storing it. */
export const previewThemeSelection = (
    themePreference: ThemePreference,
    themeProfiles: ThemeProfilesLocalStateV1,
): void => {
    applyResolvedThemeRuntimeSelection({ themePreference, themeProfiles }, readSystemTheme());
};

/** The single selection mutation, transition, runtime and status-bar owner. */
export const commitThemeSelection = (input: CommitThemeSelectionInput): Promise<void> => {
    const systemTheme = input.systemTheme ?? readSystemTheme();
    return defaultRunThemePreferenceChange({
        currentPreference: input.currentPreference,
        nextPreference: input.nextPreference,
        platform: input.platform ?? Platform.OS,
        reduceMotion: input.reduceMotion,
        forceAnimate: input.reduceMotion ? false : (input.forceAnimate ?? true),
        systemTheme,
        mutation: () => {
            const selection = input.resolveSelection?.() ?? {
                themePreference: input.nextPreference,
                themeProfiles: input.nextThemeProfiles,
            };
            input.writeLocal(selection);
            applyResolvedThemeRuntimeSelection(selection, systemTheme);
        },
    });
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
    const loadLocalSettings = input.loadLocalSettings ?? (() => ({ ...defaultLoadLocalSettings(), ...loadThemeRuntimeLocalState() }));
    const saveLocalSettings = input.saveLocalSettings ?? ((settings: LocalSettings) => {
        const local = defaultLoadLocalSettings();
        const { scope, settings: account } = loadStartupAccountSettings();
        const pending = scope ? loadPendingAccountSettingsState(scope) : null;
        const legacy = canUseLegacyThemeProfiles(readThemeProfileLegacyAccountScope(), scope)
            ? local.themeProfiles : DEFAULT_THEME_PROFILES_LOCAL_STATE;
        defaultSaveLocalSettings({
            ...settings,
            themeProfiles: local.themeProfiles,
            themeProfileSelection: encodeThemeProfileSelection(account.themeProfiles, legacy, settings.themeProfiles.activeProfileIds,
                pending?.themeProfileMigration, pending?.settings.themeProfiles),
        });
    });
    const currentSettings = loadLocalSettings();
    const resolveNextThemeProfiles = (
        themeProfiles: ThemeProfilesLocalStateV1,
        fallbackThemePreference: ThemePreference,
    ): ThemeProfilesLocalStateV1 => (
        resolveActivationModes({
            profileMode: input.profileMode,
            themePreference: input.themePreference ?? fallbackThemePreference,
        }).reduce(
            (nextThemeProfiles, mode) => setActiveThemeProfileForMode(nextThemeProfiles, mode, input.resolveProfileId ? input.resolveProfileId() : input.profileId),
            themeProfiles,
        )
    );
    const nextThemeProfiles = resolveNextThemeProfiles(currentSettings.themeProfiles, currentSettings.themePreference);
    await commitThemeSelection({
        currentPreference: currentSettings.themePreference,
        nextPreference: input.themePreference ?? currentSettings.themePreference,
        nextThemeProfiles,
        reduceMotion: input.reduceMotion ?? false,
        forceAnimate: input.forceAnimate ?? false,
        systemTheme: input.systemTheme,
        platform: input.platform,
        resolveSelection: () => {
            const latestSettings = loadLocalSettings();
            return {
                themePreference: input.themePreference ?? latestSettings.themePreference,
                themeProfiles: resolveNextThemeProfiles(latestSettings.themeProfiles, latestSettings.themePreference),
            };
        },
        writeLocal: delta => saveLocalSettings(applyLocalSettings({ ...localSettingsDefaults, ...loadLocalSettings() }, delta)),
    });
};
