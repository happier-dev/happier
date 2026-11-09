import * as React from 'react';
import { Stack, useSegments } from 'expo-router';
import type { ExtendedStackNavigationOptions } from 'expo-router/build/layouts/StackClient';

import { isDevRouteEnabled } from '@/auth/routing/devRoutePolicy';
import { t } from '@/text';
import { useUnistyles } from 'react-native-unistyles';
import { createAppStackScreenOptions, useAppStackUsesCustomHeader } from '@/components/navigation/createAppStackScreenOptions';
import { useRootStackRouteOptions } from '@/components/navigation/root/useRootStackRouteOptions';
import { NavigationTitleChromeProvider, useNavigationTitleChromeShowsTitle } from '@/components/ui/layout/navigationTitleChrome';
import { NavigatorSafeAreaBleed } from '@/components/navigation/safeArea/HorizontalSafeArea';
import { renderAppStackScreen } from '@/components/navigation/appStackScreenLayout';

export default function DevRouteLayout(): React.ReactElement | null {
    const { theme } = useUnistyles();
    const shouldUseCustomHeader = useAppStackUsesCustomHeader();
    const rootOptions = useRootStackRouteOptions();
    const segments: readonly string[] = useSegments();
    const inheritedShowsTitle = useNavigationTitleChromeShowsTitle();
    const screenOptions = React.useMemo(() => createAppStackScreenOptions({ theme, shouldUseCustomHeader, headerBackTitle: t('common.back') }),
        [rootOptions, shouldUseCustomHeader, theme]);
    // The declarations and PageHeader visibility consume the same policy.
    const routeOptions = React.useMemo<Readonly<Record<string, ExtendedStackNavigationOptions>>>(() => ({
        changes: { headerShown: false },
        track: { headerShown: false },
        artifacts: rootOptions['artifacts/index'],
        index: { headerTitle: t('navigation.developerTools') },
        'list-demo': { headerTitle: t('navigation.listComponentsDemo') },
        typography: { headerTitle: t('navigation.typography') },
        colors: { headerTitle: t('navigation.colors') },
        tools2: { headerTitle: t('navigation.toolViewsDemo') },
        'shimmer-demo': { headerTitle: t('navigation.shimmerViewDemo') },
        'multi-text-input': { headerTitle: t('navigation.multiTextInput') },
    }), [rootOptions]);
    const devIndex = segments.indexOf('dev');
    const routeName = devIndex < 0 ? 'index' : segments[devIndex + 1] ?? 'index';
    if (!isDevRouteEnabled()) return null;
    return <NavigationTitleChromeProvider showsTitle={inheritedShowsTitle && routeOptions[routeName]?.headerShown !== false}>
        <NavigatorSafeAreaBleed><Stack screenOptions={screenOptions} screenLayout={renderAppStackScreen}>
            {Object.entries(routeOptions).map(([name, options]) => <Stack.Screen key={name} name={name} options={options} />)}
        </Stack></NavigatorSafeAreaBleed>
    </NavigationTitleChromeProvider>;
}
