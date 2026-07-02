import { Appearance } from 'react-native';
import * as SystemUI from 'expo-system-ui';
import { StyleSheet, UnistylesRuntime } from 'react-native-unistyles';

import { loadThemeRuntimeLocalState } from './sync/domains/state/persistence';
import {
    resolveEffectiveThemeRuntimeBackground,
    resolveThemeRuntimeStartupThemes,
    resolveThemeRuntimeVisualTheme,
} from './theme/profiles/themeProfileRuntime';
import { fireAndForget } from './utils/system/fireAndForget';

type AppThemeName = 'light' | 'dark';

const normalizeColorScheme = (colorScheme: ReturnType<typeof Appearance.getColorScheme>): AppThemeName => {
    return colorScheme === 'dark' ? 'dark' : 'light';
};

const themeRuntimeLocalState = loadThemeRuntimeLocalState();
const themePreference = themeRuntimeLocalState.themePreference;
const startupThemes = resolveThemeRuntimeStartupThemes({
    themeProfiles: themeRuntimeLocalState.themeProfiles,
    themePreference,
    systemTheme: normalizeColorScheme(Appearance.getColorScheme()),
});
const appThemes = startupThemes.themes;

const breakpoints = {
    xs: 0, // <-- make sure to register one breakpoint with value 0
    sm: 300,
    md: 500,
    lg: 800,
    xl: 1200
};

type AppThemes = typeof appThemes;
type AppBreakpoints = typeof breakpoints;

declare module 'react-native-unistyles' {
    export interface UnistylesThemes extends AppThemes { }
    export interface UnistylesBreakpoints extends AppBreakpoints { }
}

const getInitialTheme = (): AppThemeName => {
    return resolveThemeRuntimeVisualTheme(themePreference, normalizeColorScheme(Appearance.getColorScheme()));
};

const settings = {
    initialTheme: getInitialTheme(),
    CSSVars: true,
};

StyleSheet.configure({
    settings,
    breakpoints,
    themes: appThemes,
});

function isDesktopActivityOverlayWindow(): boolean {
    if (typeof window === 'undefined' || typeof window.location?.pathname !== 'string') {
        return false;
    }

    return window.location.pathname.replace(/\/+$/u, '') === '/desktop/activity-overlay';
}

const applyRootBackgroundColor = (systemTheme: AppThemeName) => {
    const color = resolveEffectiveThemeRuntimeBackground({
        themes: appThemes,
        themePreference,
        systemTheme,
    });
    UnistylesRuntime.setRootViewBackgroundColor(color);
    fireAndForget(SystemUI.setBackgroundColorAsync(color), { tag: 'unistyles.setRootBackgroundColor' });
};

const setRootBackgroundColor = () => {
    if (isDesktopActivityOverlayWindow()) {
        UnistylesRuntime.setRootViewBackgroundColor('transparent');
        return;
    }

    applyRootBackgroundColor(normalizeColorScheme(Appearance.getColorScheme()));
};

setRootBackgroundColor();

if (themePreference === 'adaptive') {
    Appearance.addChangeListener(({ colorScheme }) => {
        const themeName = normalizeColorScheme(colorScheme);
        UnistylesRuntime.setTheme(themeName);

        if (isDesktopActivityOverlayWindow()) {
            UnistylesRuntime.setRootViewBackgroundColor('transparent');
            return;
        }

        applyRootBackgroundColor(themeName);
    });
}
