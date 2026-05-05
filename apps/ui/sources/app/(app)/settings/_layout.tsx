import * as React from 'react';
import { Stack } from 'expo-router';
import { Platform } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';

import { SettingsShell } from '@/components/settings/shell/SettingsShell';
import { createAppStackScreenOptions } from '@/components/navigation/createAppStackScreenOptions';
import { getSettingsStackScreenDefinitions } from '@/components/settings/navigation/settingsRouteRegistry';
import { isRunningOnMac } from '@/utils/platform/platform';
import { getPreferredLanguage, t } from '@/text';

export default React.memo(function SettingsLayoutRoute() {
    const { theme } = useUnistyles();
    const preferredLanguage = getPreferredLanguage();

    const shouldUseCustomHeader = Platform.OS === 'android' || isRunningOnMac() || Platform.OS === 'web';
    const screenOptions = React.useMemo(() => createAppStackScreenOptions({
        headerBackTitle: t('common.back'),
        shouldUseCustomHeader,
        theme,
    }), [preferredLanguage, shouldUseCustomHeader, theme]);
    const screenDefinitions = React.useMemo(() => getSettingsStackScreenDefinitions(t), [preferredLanguage]);

    return (
        <SettingsShell>
            <Stack screenOptions={screenOptions}>
                {screenDefinitions.map((definition) => (
                    <Stack.Screen
                        key={definition.name}
                        name={definition.name}
                        options={definition.options}
                    />
                ))}
            </Stack>
        </SettingsShell>
    );
});
