import * as React from 'react';
import { Stack } from '@/components/appShell/workspace/destinationRoute';
import { useDestinationInstanceKey } from '@/components/appShell/workspace/DestinationInstanceHost';
import { useUnistyles } from 'react-native-unistyles';

import { SettingsShell } from '@/components/settings/shell/SettingsShell';
import { NavigationTitleChromeProvider } from '@/components/ui/layout/PageHeader';
import { RouteModalPortalScope } from '@/components/navigation/RouteModalPortalScope';
import { createAppStackScreenOptions, useAppStackUsesCustomHeader } from '@/components/navigation/createAppStackScreenOptions';
import { getSettingsStackScreenDefinitions } from '@/components/settings/navigation/settingsRouteRegistry';
import { createSettingsLayoutRoute } from '@/components/settings/navigation/createSettingsLayoutRoute';
import { SettingsPresentationRouteKeeper } from '@/components/settings/navigation/SettingsPresentationRouteKeeper';
import { useDeviceType } from '@/utils/platform/responsive';
import { getPreferredLanguage, t } from '@/text';

function SettingsLayoutBody() {
    const hosted = useDestinationInstanceKey() !== null;
    const { theme } = useUnistyles();
    const preferredLanguage = getPreferredLanguage();

    const deviceType = useDeviceType();
    // On tablet/desktop settings is presented as a modal (there is no bottom tab bar); on
    // phones it is a full-screen tab reached via the bottom tab bar. This uses the same
    // `useDeviceType` signal that drives the tab bar, so the modal card, the header close
    // affordance, and the tab bar stay in lock-step. In modal mode we cap the shell to a
    // centered card and add a close button; on phones neither applies.
    const isModalPresentation = deviceType !== 'phone';
    const shouldUseCustomHeader = useAppStackUsesCustomHeader();
    const screenOptions = React.useMemo(() => createAppStackScreenOptions({
        headerBackTitle: t('common.back'),
        shouldUseCustomHeader,
        theme,
    }), [preferredLanguage, shouldUseCustomHeader, theme]);
    const screenDefinitions = React.useMemo(
        () => getSettingsStackScreenDefinitions(t, { isModalPresentation }),
        [preferredLanguage, isModalPresentation],
    );

    const navigator = <Stack screenOptions={screenOptions}>
        {screenDefinitions.map((definition) => <Stack.Screen key={definition.name}
            name={definition.name} options={definition.options} />)}
    </Stack>;
    return (
        <RouteModalPortalScope>
            {/* Crossing the phone width remounts this navigator; this keeps the page that was open. */}
            {hosted ? null : <SettingsPresentationRouteKeeper deviceType={deviceType} />}
            {/* Phones keep the native stack header (which shows the title); the modal has none. */}
            <NavigationTitleChromeProvider showsTitle={!isModalPresentation && !hosted}>
            <SettingsShell>
                {navigator}
            </SettingsShell>
            </NavigationTitleChromeProvider>
        </RouteModalPortalScope>
    );
}

export default createSettingsLayoutRoute(SettingsLayoutBody);
