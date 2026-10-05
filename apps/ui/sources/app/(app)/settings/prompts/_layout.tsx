import * as React from 'react';
import { Slot, Stack, usePathname } from '@/components/appShell/workspace/destinationRoute';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';
import { resolveSettingsRouteTitleKey } from '@/components/settings/navigation/settingsRouteRegistry';
import { createSettingsLayoutRoute } from '@/components/settings/navigation/createSettingsLayoutRoute';
import { useArtifactsLoaded } from '@/sync/domains/state/storage';
import { t } from '@/text';

const styles = StyleSheet.create({
    loading: {
        flex: 1,
        alignItems: 'center',
        justifyContent: 'center',
    },
});

/**
 * The prompts subtree is one `prompts` screen in the settings stack (this layout waits for the library,
 * then renders the active route in a Slot). The native header therefore takes its title from here,
 * following the active route through the registry, so phones read "Skills", "Templates", "Edit
 * prompt"… rather than "Prompts & Skills" on every page.
 */
const PromptsLayoutRoute = React.memo(function PromptsLayoutRoute() {
    const artifactsLoaded = useArtifactsLoaded();
    const pathname = usePathname();
    const titleKey = resolveSettingsRouteTitleKey(pathname) ?? 'settings.prompts';
    const screenOptions = React.useMemo(() => ({ headerTitle: t(titleKey) }), [titleKey]);
    return (
        <>
            <Stack.Screen options={screenOptions} />
            {artifactsLoaded ? <Slot /> : (
                <View testID="prompts.artifacts.loading" style={styles.loading}>
                    <ActivitySpinner size="small" />
                </View>
            )}
        </>
    );
});

export default createSettingsLayoutRoute(PromptsLayoutRoute, 'prompts');
