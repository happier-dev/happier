import * as React from 'react';

import { useSettingActionWriter } from '@/components/settings/catalog/useSettingActionWriter';
import { SettingAnchor } from '@/components/settings/shell/SettingRow';
import { presentSettingWriteFailure } from '@/components/settings/shell/writeFailure';
import { FieldValueItem } from '@/components/ui/forms/FieldValueItem';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { useSetting } from '@/sync/store/settingsReadHooks';
import { t } from '@/text';
import { PLUGINS_SETTINGS } from './pluginsSettings';

const setting = PLUGINS_SETTINGS.settings.databaseActivityAutoRefreshInterval;

export function DatabaseActivityRefreshSettingsEntry() {
    const intervalMs = useSetting('databaseActivityAutoRefreshIntervalMs');
    const write = useSettingActionWriter();

    const commit = async (draft: string): Promise<boolean> => {
        try {
            const result = await write(setting, Number(draft));
            if (result.ok) return true;
            if (write.isAccountCurrent(setting)) presentSettingWriteFailure(result);
        } catch (error) {
            if (write.isAccountCurrent(setting)) presentSettingWriteFailure(error);
        }
        return false;
    };

    return (
        <ItemGroup title={t('settingsPlugins.databaseWorkbench.title')}>
            <SettingAnchor setting={setting}>
                <FieldValueItem
                    title={t(setting.titleKey)}
                    subtitle={setting.descriptionKey ? t(setting.descriptionKey) : undefined}
                    fieldTestID="settings.plugins.databaseActivityAutoRefreshInterval"
                    kind="integer"
                    value={String(intervalMs)}
                    disabled={!write.ready}
                    onCommit={commit}
                />
            </SettingAnchor>
        </ItemGroup>
    );
}
