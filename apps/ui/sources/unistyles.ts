import { Appearance } from 'react-native';
import * as SystemUI from 'expo-system-ui';
import { StyleSheet, UnistylesRuntime } from 'react-native-unistyles';

import { darkTheme, lightTheme } from './theme';
import { loadThemePreference } from './sync/domains/state/persistence';
import { fireAndForget } from './utils/system/fireAndForget';

const appThemes = {
    light: lightTheme,
    dark: darkTheme
};

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

const themePreference = loadThemePreference();

const normalizeColorScheme = (colorScheme: ReturnType<typeof Appearance.getColorScheme>): 'light' | 'dark' => {
    return colorScheme === 'dark' ? 'dark' : 'light';
};

const getInitialTheme = (): 'light' | 'dark' => {
    if (themePreference === 'adaptive') {
        return normalizeColorScheme(Appearance.getColorScheme());
    }
    return themePreference;
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

const applyRootBackgroundColor = (themeName: 'light' | 'dark') => {
    const color = themeName === 'dark'
        ? appThemes.dark.colors.background.canvas
        : appThemes.light.colors.background.canvas;
    UnistylesRuntime.setRootViewBackgroundColor(color);
    fireAndForget(SystemUI.setBackgroundColorAsync(color), { tag: 'unistyles.setRootBackgroundColor' });
};

const setRootBackgroundColor = () => {
    if (isDesktopActivityOverlayWindow()) {
        UnistylesRuntime.setRootViewBackgroundColor('transparent');
        return;
    }

    applyRootBackgroundColor(getInitialTheme());
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
