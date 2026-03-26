import { Appearance } from 'react-native';
import { StyleSheet, UnistylesRuntime } from 'react-native-unistyles';

import { darkTheme, lightTheme } from './theme';
import { loadThemePreference } from './sync/domains/state/persistence';

const appThemes = {
    light: lightTheme,
    dark: darkTheme,
};

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

const themePreference = loadThemePreference();

const getInitialTheme = (): 'light' | 'dark' => {
    if (themePreference === 'adaptive') {
        const systemTheme = Appearance.getColorScheme();
        return systemTheme === 'dark' ? 'dark' : 'light';
    }
    return themePreference;
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
    const resolvedTheme =
        themePreference === 'adaptive'
            ? (Appearance.getColorScheme() === 'dark' ? 'dark' : 'light')
            : themePreference;
    const color = resolvedTheme === 'dark'
        ? appThemes.dark.colors.groupped.background
        : appThemes.light.colors.groupped.background;
    UnistylesRuntime.setRootViewBackgroundColor(color);
};

setRootBackgroundColor();
