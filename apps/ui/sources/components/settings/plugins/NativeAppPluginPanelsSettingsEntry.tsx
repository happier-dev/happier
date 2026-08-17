import * as React from 'react';
import { Platform } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { useRouter } from 'expo-router';

import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { SETTINGS_ROUTES } from '@/components/settings/catalog/routes';
import { t } from '@/text';
import type { LocalServicePreviewPlatform } from '@/sync/domains/local/services/preview/url';
import { Icon } from '@/components/ui/icons/Icon';
import { useCompactAppDestinations } from '@/components/appShell/destinations/compactAppDestinationCatalog';

export type NativeAppPluginPanelsSettingsEntryProps = Readonly<{
    platform?: LocalServicePreviewPlatform;
}>;

export function NativeAppPluginPanelsSettingsEntry(
    props: NativeAppPluginPanelsSettingsEntryProps,
): React.ReactElement | null {
    const { theme } = useUnistyles();
    const router = useRouter();
    const platform = props.platform ?? (
        Platform.OS === 'ios' || Platform.OS === 'android' ? Platform.OS : 'web'
    );
    const compactDestinations = useCompactAppDestinations({ browseExistingSessionsEnabled: false });
    const hasAvailableAppPanel = compactDestinations.some((destination) => (
        destination.kind === 'plugin'
        && destination.container === 'rightSidebarTab'
        && destination.availability === 'available'
    ));

    if ((platform !== 'ios' && platform !== 'android') || !hasAvailableAppPanel) {
        return null;
    }

    return (
        <ItemGroup>
            <Item
                testID="settings.plugins.appPanels"
                accessibilityLabel={t('settingsPlugins.appPanelsTitle')}
                title={t('settingsPlugins.appPanelsTitle')}
                subtitle={t('settingsPlugins.appPanelsSubtitle')}
                icon={(
                    <Icon
                        name="puzzle-piece"
                        size={29}
                        color={theme.colors.accent.indigo}
                    />
                )}
                onPress={() => router.push(SETTINGS_ROUTES.pluginPanels)}
            />
        </ItemGroup>
    );
}
