import * as React from 'react';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { Switch } from '@/components/ui/forms/Switch';
import { t } from '@/text';
import type { InstalledPluginEntry } from '../model/pluginMarketplaceModel';

/** Desired scope facts come from the catalog; effective enablement remains its decision. */
export function PluginEnablementSection(props: Readonly<{
    installed: InstalledPluginEntry;
    disabled: boolean;
    onChange: (action: 'enable' | 'disable', scope: 'account' | 'machine') => void;
}>) {
    const { installed } = props;
    return (
        <ItemGroup title={t('common.enabled')} description={t('settingsPlugins.enablement.description')}>
            {(['account', 'machine'] as const).map(scope => {
                const value = scope === 'account' ? installed.accountEnabled : installed.machineEnabled;
                return (
                    <Item
                        key={scope}
                        title={t(scope === 'account' ? 'settingsPlugins.enablement.account' : 'settingsPlugins.enablement.machine')}
                        showChevron={false}
                        rightElement={<Switch
                            testID={`settings.plugins.detail.${installed.pluginId}.enablement.${scope}`}
                            value={value === true}
                            disabled={props.disabled}
                            onValueChange={next => props.onChange(next ? 'enable' : 'disable', scope)}
                        />}
                    />
                );
            })}
        </ItemGroup>
    );
}
