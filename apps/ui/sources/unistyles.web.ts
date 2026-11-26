import { StyleSheet, UnistylesRuntime } from 'react-native-unistyles';

import { resolveDesktopWindowContext } from './desktop/window/isDesktopAuxiliaryWindowContext';
import { loadThemeRuntimeLocalState } from './sync/domains/state/persistence';
import {
    resolveThemeRuntimeStartupThemes,
    resolveThemeRuntimeVisualTheme,
    readSystemTheme,
    initializeThemeRuntimeAppearance,
} from './theme/profiles/themeProfileRuntime';
import { themeStyleSelectionFromSurfaceFinish } from './theme/themeStyleScales';

type AppThemeName = 'light' | 'dark';

const themeRuntimeLocalState = loadThemeRuntimeLocalState();
const themePreference = themeRuntimeLocalState.themePreference;
const startupThemes = resolveThemeRuntimeStartupThemes({
    themeProfiles: themeRuntimeLocalState.themeProfiles,
    themePreference,
    systemTheme: readSystemTheme(),
    style: themeStyleSelectionFromSurfaceFinish(themeRuntimeLocalState),
});
const appThemes = startupThemes.themes;

const breakpoints = {
    xs: 0,
    sm: 300,
    md: 500,
    lg: 800,
    xl: 1200,
};

const getInitialTheme = (): AppThemeName => {
    return resolveThemeRuntimeVisualTheme(themePreference, readSystemTheme());
};

const settings = { initialTheme: getInitialTheme(), CSSVars: true };

StyleSheet.configure({
    settings,
    breakpoints,
    themes: appThemes,
});

UnistylesRuntime.setRootViewBackgroundColor(
    resolveDesktopWindowContext().role === 'presenter' ? 'transparent' : startupThemes.backgroundColor,
);
initializeThemeRuntimeAppearance({ ...themeRuntimeLocalState, style: themeStyleSelectionFromSurfaceFinish(themeRuntimeLocalState) }, appThemes);
