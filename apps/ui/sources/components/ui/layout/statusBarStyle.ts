import type { ColorSchemeName } from 'react-native';
import type { StatusBarStyle } from 'expo-status-bar';

export type ThemePreference = 'light' | 'dark' | 'adaptive';

export function resolveStatusBarStyleForDarkTheme(isDarkTheme: boolean): StatusBarStyle {
    return isDarkTheme ? 'light' : 'dark';
}

export function resolveStatusBarStyleForThemePreference(
    themePreference: ThemePreference,
    systemColorScheme: ColorSchemeName,
): StatusBarStyle {
    const isDarkTheme = themePreference === 'adaptive'
        ? systemColorScheme === 'dark'
        : themePreference === 'dark';

    return resolveStatusBarStyleForDarkTheme(isDarkTheme);
}
