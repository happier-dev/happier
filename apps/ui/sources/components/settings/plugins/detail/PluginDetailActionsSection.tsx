import * as React from 'react';
import { Ionicons } from '@expo/vector-icons';
import { useUnistyles } from 'react-native-unistyles';

import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { t } from '@/text';

import type { InstalledPluginEntry } from '../model/pluginMarketplaceModel';
import type { InstalledPluginUpdateState } from '../model/usePluginSettingsScreenState';

export function PluginDetailActionsSection(props: Readonly<{
    installed: InstalledPluginEntry;
    updateState: InstalledPluginUpdateState;
    actionInFlight: boolean;
    canRunActions: boolean;
    onAction: (action: 'reload' | 'update' | 'enable' | 'disable', pluginId: string) => void;
}>) {
    const { theme } = useUnistyles();

    return (
        <ItemGroup title={t('common.actions')}>
            <Item
                testID={`settings.plugins.detail.${props.installed.pluginId}.action.reload`}
                title={t('settingsPlugins.reloadAction')}
                subtitle={t('settingsPlugins.reloadSubtitle')}
                icon={<Ionicons name="refresh-outline" size={29} color={theme.colors.textSecondary} />}
                onPress={() => props.onAction('reload', props.installed.pluginId)}
                disabled={!props.canRunActions || props.actionInFlight}
                loading={props.actionInFlight}
                showChevron={false}
            />
            {props.updateState.canUpdate ? (
                <Item
                    testID={`settings.plugins.detail.${props.installed.pluginId}.action.update`}
                    title={t('common.update')}
                    subtitle={props.updateState.updateAvailable
                        ? t('deps.ui.installedUpdateAvailable', {
                            installedVersion: props.installed.version,
                            latestVersion: props.updateState.catalogVersion ?? props.installed.version,
                        })
                        : (props.updateState.sourceUrl ?? props.installed.version)}
                    icon={<Ionicons name="cloud-download-outline" size={29} color={theme.colors.textSecondary} />}
                    onPress={() => props.onAction('update', props.installed.pluginId)}
                    disabled={!props.canRunActions || props.actionInFlight}
                    showChevron={false}
                />
            ) : null}
            <Item
                testID={`settings.plugins.detail.${props.installed.pluginId}.action.${props.installed.enabled ? 'disable' : 'enable'}`}
                title={props.installed.enabled ? t('common.disable') : t('common.enable')}
                subtitle={props.installed.enabled ? t('common.enabled') : t('common.disabled')}
                icon={(
                    <Ionicons
                        name={props.installed.enabled ? 'close-circle-outline' : 'checkmark-circle-outline'}
                        size={29}
                        color={theme.colors.textSecondary}
                    />
                )}
                onPress={() => props.onAction(props.installed.enabled ? 'disable' : 'enable', props.installed.pluginId)}
                disabled={!props.canRunActions || props.actionInFlight}
                showChevron={false}
            />
        </ItemGroup>
    );
}
