import * as React from 'react';
import { Stack } from 'expo-router';
import { Platform } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';

import { SettingsShell } from '@/components/settings/shell/SettingsShell';
import { RouteModalPortalScope } from '@/components/navigation/RouteModalPortalScope';
import { createAppStackScreenOptions } from '@/components/navigation/createAppStackScreenOptions';
import { getSettingsStackScreenDefinitions } from '@/components/settings/navigation/settingsRouteRegistry';
import { isRunningOnMac } from '@/utils/platform/platform';
import { useDeviceType } from '@/utils/platform/responsive';
import { getPreferredLanguage, t } from '@/text';

export default React.memo(function SettingsLayoutRoute() {
    const { theme } = useUnistyles();
    const preferredLanguage = getPreferredLanguage();

    const deviceType = useDeviceType();
    // On tablet/desktop settings is presented as a modal (there is no bottom tab bar); on
    // phones it is a full-screen tab reached via the bottom tab bar. This uses the same
    // `useDeviceType` signal that drives the tab bar, so the modal card, the header close
    // affordance, and the tab bar stay in lock-step. In modal mode we cap the shell to a
    // centered card and add a close button; on phones neither applies.
    const isModalPresentation = deviceType !== 'phone';
    const shouldUseCustomHeader = Platform.OS === 'android' || isRunningOnMac() || Platform.OS === 'web';
    const screenOptions = React.useMemo(() => createAppStackScreenOptions({
        headerBackTitle: t('common.back'),
        shouldUseCustomHeader,
        theme,
    }), [preferredLanguage, shouldUseCustomHeader, theme]);
    const screenDefinitions = React.useMemo(
        () => getSettingsStackScreenDefinitions(t, { isModalPresentation }),
        [preferredLanguage, isModalPresentation],
    );

    return (
        <RouteModalPortalScope>
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
        </RouteModalPortalScope>
    );
});
