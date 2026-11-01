import * as React from 'react';
import { Platform } from 'react-native';
import { Stack } from 'expo-router';
import { useUnistyles } from 'react-native-unistyles';

import { createAppStackScreenOptions } from '@/components/navigation/createAppStackScreenOptions';
import { composeAppStackScreenLayout } from '@/components/navigation/appStackScreenLayout';
import { NavigatorSafeAreaBleed } from '@/components/navigation/safeArea/HorizontalSafeArea';
import { getSettingsStackScreenDefinitions, type SettingsStackScope } from './settingsRouteRegistry';
import { t } from '@/text';
import { isRunningOnMac } from '@/utils/platform/platform';

export function SettingsStack({ scope = 'settings', screenLayout }: Readonly<{
    scope?: SettingsStackScope;
    screenLayout?: React.ComponentProps<typeof Stack>['screenLayout'];
}>) {
    const { theme } = useUnistyles();
    const shouldUseCustomHeader = Platform.OS === 'android' || isRunningOnMac() || Platform.OS === 'web';
    const screenOptions = React.useMemo(() => createAppStackScreenOptions({
        headerBackTitle: t('common.back'),
        shouldUseCustomHeader,
        theme,
    }), [shouldUseCustomHeader, theme]);
    const screenDefinitions = React.useMemo(() => getSettingsStackScreenDefinitions(t, scope), [scope]);
    const appScreenLayout = React.useMemo(() => composeAppStackScreenLayout(screenLayout), [screenLayout]);

    return (
        <NavigatorSafeAreaBleed>
            <Stack screenOptions={screenOptions} screenLayout={appScreenLayout}>
                {screenDefinitions.map((definition) => (
                    <Stack.Screen
                        key={definition.name}
                        name={definition.name}
                        options={definition.options}
                    />
                ))}
            </Stack>
        </NavigatorSafeAreaBleed>
    );
}
