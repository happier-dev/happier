import * as React from 'react';
import { useUnistyles } from 'react-native-unistyles';

import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { t } from '@/text';

import type { InstalledPluginEntry } from '../model/pluginMarketplaceModel';
import { Icon } from '@/components/ui/icons/Icon';

export function PluginDetailActionsSection(props: Readonly<{
    installed: InstalledPluginEntry;
    actionInFlight: boolean;
    canRunActions: boolean;
    onAction: (action: 'enable' | 'disable' | 'rollback' | 'uninstall' | 'forgetTrust', pluginId: string) => void;
}>) {
    const { theme } = useUnistyles();

    return (
        <ItemGroup title={t('common.actions')}>
            <Item
                testID={`settings.plugins.detail.${props.installed.pluginId}.action.${props.installed.enabled ? 'disable' : 'enable'}`}
                title={props.installed.enabled ? t('common.disable') : t('common.enable')}
                subtitle={props.installed.enabled ? t('common.enabled') : t('common.disabled')}
                icon={(
                    <Icon
                        name={props.installed.enabled ? 'x-circle' : 'check-circle'}
                        size={29}
                        color={theme.colors.text.secondary}
                    />
                )}
                onPress={() => props.onAction(props.installed.enabled ? 'disable' : 'enable', props.installed.pluginId)}
                disabled={!props.canRunActions || props.actionInFlight}
                showChevron={false}
            />
            {props.installed.rollbackAvailability === 'available' ? (
                <Item
                    testID={`settings.plugins.detail.${props.installed.pluginId}.action.rollback`}
                    title={t('settingsPlugins.rollback')}
                    icon={<Icon name="arrow-elbow-down-left" size={29} color={theme.colors.text.secondary} />}
                    onPress={() => props.onAction('rollback', props.installed.pluginId)}
                    disabled={!props.canRunActions || props.actionInFlight}
                    showChevron={false}
                />
            ) : null}
            <Item
                testID={`settings.plugins.detail.${props.installed.pluginId}.action.uninstall`}
                title={t('settingsPlugins.uninstall')}
                icon={<Icon name="trash" size={29} color={theme.colors.text.secondary} />}
                onPress={() => props.onAction('uninstall', props.installed.pluginId)}
                disabled={!props.canRunActions || props.actionInFlight}
                showChevron={false}
            />
            <Item
                testID={`settings.plugins.detail.${props.installed.pluginId}.action.forgetTrust`}
                title={t('settingsPlugins.forgetTrust')}
                icon={<Icon name="shield" size={29} color={theme.colors.text.secondary} />}
                onPress={() => props.onAction('forgetTrust', props.installed.pluginId)}
                disabled={!props.canRunActions || props.actionInFlight}
                showChevron={false}
            />
        </ItemGroup>
    );
}
