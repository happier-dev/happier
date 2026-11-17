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
import { loadLocalSettings as defaultLoadLocalSettings } from '@/sync/domains/state/persistence';
import type { LocalSettings } from '@/sync/domains/settings/localSettings';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { addBreadcrumbIfEnabled } from '@/utils/system/sentry';
import { findActiveThemeProfileForMode } from './themeProfilePersistence';
import { createThemeProfileResolver } from './resolveThemeProfile';
import { applyThemeFontFamilyVariables } from '../themeFontFamilyVariables';
import { applyThemeStylesheet } from '../css/themeStylesheet';
import { prepareThemeProfileCssAsync, readPreparedThemeProfileCss } from '../css/prepareThemeCss';
import type { ThemeSurfaceStyleTable } from '../css/types';
import { applyThemeStyleScales, resolveThemeStyleScales, themeStyleSelectionFromSurfaceFinish, type ThemeStyleSelection } from '../themeStyleScales';
import type { ThemeProfileMode, ThemeProfileSelectionByMode, ThemeProfilesLocalStateV1 } from './themeProfileTypes';
import type { ThemeTryOnSnapshot } from './themeTryOn';

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
    resolveThemes?: (themeProfiles: ThemeProfilesLocalStateV1, preview?: ThemeTryOnSnapshot | null) => ThemeRuntimeThemes;
    preview?: ThemeTryOnSnapshot | null;
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
    platform?: string;
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

function readRuntimeProfile(profiles: ThemeProfilesLocalStateV1, mode: AppThemeName, preview?: ThemeTryOnSnapshot | null) {
    return preview?.mode === mode ? preview.document?.profile ?? null : findActiveThemeProfileForMode(profiles, mode);
}

export const resolveThemeRuntimeThemes = (themeProfiles: ThemeProfilesLocalStateV1, preview?: ThemeTryOnSnapshot | null): ThemeRuntimeThemes => {
    return {
        light: runtimeThemeResolver.resolve({ mode: 'light', profile: readRuntimeProfile(themeProfiles, 'light', preview) }),
        dark: runtimeThemeResolver.resolve({ mode: 'dark', profile: readRuntimeProfile(themeProfiles, 'dark', preview) }),
    };
};

export const resolveThemeRuntimeVisualTheme = (
    themePreference: ThemePreference,
    systemTheme: ReturnType<typeof Appearance.getColorScheme> | undefined,
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
    preview?: ThemeTryOnSnapshot | null,
): ThemeRuntimeThemes => {
    const compose = (mode: AppThemeName): Theme => applyThemeStyleScales(themes[mode], resolveThemeStyleScales({
        ...readRuntimeProfile(profiles, mode, preview)?.style,
        ...style,
    }));
    return { light: compose('light'), dark: compose('dark') };
};

const nativeCssThemes = new WeakMap<Theme, Readonly<{ surfaces: ThemeSurfaceStyleTable; theme: Theme }>>();
function composeNativeCss(
    themes: ThemeRuntimeThemes,
    profiles: ThemeProfilesLocalStateV1,
    mode: AppThemeName,
    platform: string,
    preview?: ThemeTryOnSnapshot | null,
): ThemeRuntimeThemes {
    if (platform === 'web') return themes;
    const profile = readRuntimeProfile(profiles, mode, preview);
    if (!profile?.css) return themes;
    const prepared = readPreparedThemeProfileCss(profile);
    if (!prepared) return themes;
    const surfaces = prepared[mode];
    const base = themes[mode];
    const previous = nativeCssThemes.get(base);
    const theme = previous?.surfaces === surfaces ? previous.theme : { ...base, surfaces };
    nativeCssThemes.set(base, { surfaces, theme });
    return { ...themes, [mode]: theme };
}

export const resolveThemeRuntimeStartupThemes = (
    input: ResolveThemeRuntimeStartupThemesInput,
): ThemeRuntimeStartupThemes => {
    const resolveThemes = input.resolveThemes ?? resolveThemeRuntimeThemes;

    let themes: ThemeRuntimeThemes;
    try {
        const resolved = resolveThemes(input.themeProfiles);
        themes = composeNativeCss(
            composeRuntimeThemeStyles(resolved, input.themeProfiles, input.style ?? null),
            input.themeProfiles, resolveThemeRuntimeVisualTheme(input.themePreference, input.systemTheme ?? readSystemTheme()),
            input.platform ?? Platform.OS,
        );
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
const runtimeSelections = new WeakMap<ThemeRuntimeUnistylesAdapter, ApplyThemeRuntimeSelectionInput>();

function acquireNativeCss(input: ApplyThemeRuntimeSelectionInput): void {
    const runtime = input.unistylesRuntime ?? defaultUnistylesRuntimeAdapter;
    runtimeSelections.set(runtime, input);
    if (resolveRuntimePlatform(input) === 'web') return;
    const mode = resolveThemeRuntimeVisualTheme(input.themePreference, input.systemTheme ?? readSystemTheme());
    const profile = readRuntimeProfile(input.themeProfiles, mode, input.preview);
    if (!profile?.css || readPreparedThemeProfileCss(profile)) return;
    fireAndForget(prepareThemeProfileCssAsync(profile).then(() => {
        // A newer selection owns the runtime while this first-use chunk loads.
        if (runtimeSelections.get(runtime) === input) applyThemeRuntimeSelection(input);
    }), { tag: 'themeProfileRuntime.acquireCss', onError: warnThemeRuntimeFallback });
}
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
        applyThemeRuntimeSelection({ ...current.input, systemTheme });
    });
}

/** Both platform bootstraps and later previews/commits share this one OS observer. */
export const initializeThemeRuntimeAppearance = (input: ApplyThemeRuntimeSelectionInput, themes: ThemeRuntimeThemes): void => {
    currentRuntimeSelection = { input, themes };
    observeSystemTheme();
    acquireNativeCss(input);
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
        const source = readRuntimeProfile(input.themeProfiles, visualTheme, input.preview)?.css;
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
    setStatusBarStyle(resolveStatusBarStyleForThemePreference(input.themePreference, systemTheme), true);

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

const prepareThemeRuntimeSelection = (requested: ApplyThemeRuntimeSelectionInput) => {
    const input = requested.preview ? { ...requested, themePreference: requested.preview.mode } : requested;
    acquireNativeCss(input);
    const resolveThemes = input.resolveThemes ?? resolveThemeRuntimeThemes;

    const style = input.style === undefined
        ? themeStyleSelectionFromSurfaceFinish(defaultLoadLocalSettings()) : input.style;
    let themes: ThemeRuntimeThemes;
    try {
        const profileThemes = resolveThemes(input.themeProfiles, input.preview);
        themes = composeNativeCss(
            composeRuntimeThemeStyles(profileThemes, input.themeProfiles, style, input.preview),
            input.themeProfiles, resolveThemeRuntimeVisualTheme(input.themePreference, input.systemTheme ?? readSystemTheme()),
            resolveRuntimePlatform(input), input.preview,
        );
    } catch (error) {
        warnThemeRuntimeFallback(error);
        themes = canonicalBaseThemes;
    }

    return { input, themes };
};

const applyPreparedThemeRuntimeSelection = ({ input, themes }: ReturnType<typeof prepareThemeRuntimeSelection>): ThemeRuntimeThemes => {
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

export const applyThemeRuntimeSelection = (requested: ApplyThemeRuntimeSelectionInput): ThemeRuntimeThemes => (
    applyPreparedThemeRuntimeSelection(prepareThemeRuntimeSelection(requested))
);

/** The text ink of the theme on screen: once a switch has applied, the theme it switched to. Moments drawn over the switch read it. */
export const readThemeRuntimeInk = (): string => {
    const current = currentRuntimeSelection;
    if (!current) return canonicalBaseThemes[readSystemTheme()].colors.text.primary;
    const mode = resolveThemeRuntimeVisualTheme(current.input.themePreference, current.input.systemTheme ?? readSystemTheme());
    return current.themes[mode].colors.text.primary;
};

/** Discrete palette changes reveal; continuous drafts paint quietly and an already-painted mode/Keep is a no-op. */
export const transitionThemeRuntimeSelection = (requested: ApplyThemeRuntimeSelectionInput, reduceMotion: boolean): Promise<void> => {
    const prepared = prepareThemeRuntimeSelection(requested);
    const { input, themes } = prepared;
    const previous = currentRuntimeSelection;
    const systemTheme = input.systemTheme ?? readSystemTheme();
    const mode = resolveThemeRuntimeVisualTheme(input.themePreference, systemTheme);
    const previousMode = previous ? resolveThemeRuntimeVisualTheme(previous.input.themePreference,
        previous.input.systemTheme ?? systemTheme) : mode;
    const css = readRuntimeProfile(input.themeProfiles, mode, input.preview)?.css;
    const previousCss = previous && readRuntimeProfile(previous.input.themeProfiles, previousMode, previous.input.preview)?.css;
    const visibleChanged = previous !== null && (previousMode !== mode || previous.themes[previousMode] !== themes[mode] || previousCss !== css);
    if (previous && !visibleChanged && previous.themes.light === themes.light && previous.themes.dark === themes.dark) {
        currentRuntimeSelection = { input, themes };
        return Promise.resolve();
    }
    return defaultRunThemePreferenceChange({
        currentPreference: previousMode, nextPreference: mode, systemTheme,
        platform: Platform.OS, reduceMotion: reduceMotion || input.preview?.transition === 'none',
        forceAnimate: visibleChanged,
        mutation: () => { applyPreparedThemeRuntimeSelection(prepared); },
    });
};

const applyResolvedThemeRuntimeSelection = (
    selection: ThemeSelection,
    systemTheme: AppThemeName,
): void => {
    applyThemeRuntimeSelection({ ...selection, systemTheme });
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
