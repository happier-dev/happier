import * as React from 'react';
import { Platform } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { useRouter } from 'expo-router';

import { useAppShellPluginUiProjection } from '@/components/appShell/plugins/AppShellPluginUiProjection';
import { SafeIonicons } from '@/components/ui/icons/SafeIonicons';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { SETTINGS_ROUTES } from '@/components/settings/catalog/routes';
import { t } from '@/text';
import type { LocalServicePreviewPlatform } from '@/sync/domains/local/services/preview/url';
import type { PluginUiProjectionModel } from '@/sync/domains/plugins/ui/projection';
import { selectRenderablePluginRightSidebarTabPlacements } from '@/sync/domains/plugins/ui/surfacePlacementSelectors';

export type NativeAppPluginPanelsSettingsEntryProps = Readonly<{
    platform?: LocalServicePreviewPlatform;
    pluginUiProjection?: PluginUiProjectionModel | null;
}>;

export function NativeAppPluginPanelsSettingsEntry(
    props: NativeAppPluginPanelsSettingsEntryProps,
): React.ReactElement | null {
    const { theme } = useUnistyles();
    const router = useRouter();
    const appShellProjection = useAppShellPluginUiProjection();
    const platform = props.platform ?? (
        Platform.OS === 'ios' || Platform.OS === 'android' ? Platform.OS : 'web'
    );
    const pluginUiProjection = props.pluginUiProjection ?? appShellProjection.pluginUiProjection;
    const placements = React.useMemo(() => (
        pluginUiProjection
            ? selectRenderablePluginRightSidebarTabPlacements(pluginUiProjection, 'app')
            : []
    ), [pluginUiProjection]);

    if ((platform !== 'ios' && platform !== 'android') || placements.length === 0) {
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
                    <SafeIonicons
                        name="extension-puzzle-outline"
                        size={29}
                        color={theme.colors.accent.indigo}
                    />
                )}
                onPress={() => router.push(SETTINGS_ROUTES.pluginPanels)}
            />
        </ItemGroup>
    );
}
