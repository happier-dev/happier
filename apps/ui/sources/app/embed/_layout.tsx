import * as React from 'react';
import { Slot } from 'expo-router';
import { DarkTheme, DefaultTheme, ThemeProvider } from '@react-navigation/native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { KeyboardProvider } from 'react-native-keyboard-controller';
import { SafeAreaProvider, initialWindowMetrics } from 'react-native-safe-area-context';
import { useUnistyles } from 'react-native-unistyles';

import { AppPaneModalProvider } from '@/components/appShell/providers/AppPaneModalProvider';
import { PluginSurfaceNestingBoundary } from '@/components/plugins/surfaces/pluginSurfaceNesting';
import { useWebUiFontScale } from '@/components/ui/text/useWebUiFontScale';
import { SessionCockpitChromeRegistryProvider } from '@/components/workspaceCockpit/session/SessionCockpitChromeRegistry';
import { EmbedSessionViewport } from '@/embed/EmbedSessionViewport';

export default function EmbedLayout() {
    const { theme } = useUnistyles();
    useWebUiFontScale();
    React.useEffect(() => {
        if (typeof document === 'undefined') return;
        const root = document.documentElement;
        const previous = root.style.overscrollBehavior;
        root.style.overscrollBehavior = 'contain';
        return () => { root.style.overscrollBehavior = previous; };
    }, []);
    const navigationTheme = React.useMemo(() => {
        const base = theme.dark ? DarkTheme : DefaultTheme;
        return { ...base, colors: { ...base.colors, background: theme.colors.background.canvas } };
    }, [theme.dark, theme.colors.background.canvas]);
    return (
        <SafeAreaProvider initialMetrics={initialWindowMetrics}>
            <GestureHandlerRootView style={{ flex: 1, minHeight: 0 }}>
                <KeyboardProvider>
                    <ThemeProvider value={navigationTheme}>
                        <AppPaneModalProvider>
                            <SessionCockpitChromeRegistryProvider>
                                <PluginSurfaceNestingBoundary>
                                    {/* Keep the real controller above route replacement: first-send draft
                                        settlement continues when /new becomes /session/<id>. */}
                                    <EmbedSessionViewport />
                                    <Slot />
                                </PluginSurfaceNestingBoundary>
                            </SessionCockpitChromeRegistryProvider>
                        </AppPaneModalProvider>
                    </ThemeProvider>
                </KeyboardProvider>
            </GestureHandlerRootView>
        </SafeAreaProvider>
    );
}
