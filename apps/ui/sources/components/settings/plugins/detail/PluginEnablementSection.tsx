import * as React from 'react';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { Switch } from '@/components/ui/forms/Switch';
import { t } from '@/text';
import type { InstalledPluginEntry } from '../model/pluginMarketplaceModel';

type EnablementScope = 'account' | 'machine';

/** One message per state: which switch keeps it off, else what turning it off keeps. */
function describeEnablement(installed: InstalledPluginEntry): string {
    if (installed.accountEnabled === false) return t('settingsPlugins.enablement.accountOff');
    if (installed.machineEnabled === false) return t('settingsPlugins.enablement.machineOff');
    return t('settingsPlugins.enablement.description');
}

/**
 * Account intent and Machine catalog supply their own desired scope facts. Each row says how far its
 * switch reaches; the section says which one keeps the plugin off.
 */
export function PluginEnablementSection(props: Readonly<{
    installed: InstalledPluginEntry;
    /** The Machine "On this machine" means; beside the Plugins page no header chip names it. */
    machineLabel: string | null;
    disabled: boolean;
    onChange: (action: 'enable' | 'disable', scope: EnablementScope) => void;
}>) {
    const { installed } = props;
    // The lifecycle owner says whether a change is in flight; the section only remembers which row asked.
    const [pressed, setPressed] = React.useState<EnablementScope | null>(null);
    React.useEffect(() => {
        if (!props.disabled) setPressed(null);
    }, [props.disabled]);
    return (
        <ItemGroup title={t('common.enabled')} description={describeEnablement(installed)}>
            {(['account', 'machine'] as const).map(scope => {
                const value = scope === 'account' ? installed.accountEnabled : installed.machineEnabled;
                return (
                    <Item
                        key={scope}
                        title={t(scope === 'account' ? 'settingsPlugins.enablement.account' : 'settingsPlugins.enablement.machine')}
                        subtitle={scope === 'account' ? t('settingsPlugins.enablement.accountScope') : props.machineLabel ?? undefined}
                        showChevron={false}
                        loading={props.disabled && pressed === scope}
                        rightElement={<Switch
                            testID={`settings.plugins.detail.${installed.pluginId}.enablement.${scope}`}
                            value={value === true}
                            disabled={props.disabled || value === undefined}
                            onValueChange={next => {
                                setPressed(scope);
                                props.onChange(next ? 'enable' : 'disable', scope);
                            }}
                        />}
                    />
                );
            })}
        </ItemGroup>
    );
}
