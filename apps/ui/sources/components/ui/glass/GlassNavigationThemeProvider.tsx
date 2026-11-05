import * as React from 'react';
import { DarkTheme, DefaultTheme, ThemeProvider } from '@react-navigation/native';
import { useUnistyles } from 'react-native-unistyles';

import { resolveDesktopWindowContext } from '@/desktop/window/isDesktopAuxiliaryWindowContext';

import { useGlassRuntimeEnvironment } from './glassRuntimeEnvironment';
import { glassNavigationBackgroundColor } from './glassSurfacePaint';

/**
 * The navigation stack background clears only while the atmosphere paints behind the active route.
 * This leaf owns that one runtime-environment subscription, so atmosphere and transparency changes
 * reach only navigation theme readers instead of re-rendering the app tree passed as children.
 */
export function GlassNavigationThemeProvider(props: Readonly<{ children: React.ReactNode }>) {
    const { theme } = useUnistyles();
    const environment = useGlassRuntimeEnvironment();
    const background = glassNavigationBackgroundColor(theme.colors.background.canvas, environment, resolveDesktopWindowContext().role === 'presenter');
    const navigationTheme = React.useMemo(() => {
        const base = theme.dark ? DarkTheme : DefaultTheme;
        return { ...base, colors: { ...base.colors, background } };
    }, [background, theme.dark]);
    return <ThemeProvider value={navigationTheme}>{props.children}</ThemeProvider>;
}
