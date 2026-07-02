import { Appearance } from 'react-native';
import { StyleSheet, UnistylesRuntime } from 'react-native-unistyles';

import { loadThemeRuntimeLocalState } from './sync/domains/state/persistence';
import {
    resolveThemeRuntimeStartupThemes,
    resolveThemeRuntimeVisualTheme,
} from './theme/profiles/themeProfileRuntime';

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
    xs: 0,
    sm: 300,
    md: 500,
    lg: 800,
    xl: 1200,
};

type AppThemes = typeof appThemes;
type AppBreakpoints = typeof breakpoints;

declare module 'react-native-unistyles' {
    export interface UnistylesThemes extends AppThemes {}
    export interface UnistylesBreakpoints extends AppBreakpoints {}
}

const getInitialTheme = (): AppThemeName => {
    return resolveThemeRuntimeVisualTheme(themePreference, normalizeColorScheme(Appearance.getColorScheme()));
};

const settings =
    themePreference === 'adaptive'
        ? {
            adaptiveThemes: true,
            CSSVars: true,
        }
        : {
            initialTheme: getInitialTheme(),
            CSSVars: true,
        };

StyleSheet.configure({
    settings,
    breakpoints,
    themes: appThemes,
});

const setRootBackgroundColor = () => {
    UnistylesRuntime.setRootViewBackgroundColor(startupThemes.backgroundColor);
};

setRootBackgroundColor();
