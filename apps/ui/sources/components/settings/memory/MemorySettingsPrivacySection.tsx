import * as React from 'react';

import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { Switch } from '@/components/ui/forms/Switch';
import { t } from '@/text';

import type { MemorySettingsV1 } from '@happier-dev/protocol/memory/memorySettings';
import { SettingRow } from '@/components/settings/shell/SettingRow';
import { MEMORY_SETTINGS } from '@/components/settings/memory/memorySettings';

export const MemorySettingsPrivacySection = React.memo(function MemorySettingsPrivacySection(props: Readonly<{
    settings: MemorySettingsV1;
    writeSettings: (next: MemorySettingsV1) => void | Promise<void>;
}>) {
    const { settings } = props;

    return (
        <ItemGroup
            title={t('memorySearchSettings.privacy.groupTitle')}
            description={t('memorySearchSettings.privacy.groupFooter')}
        >
            <SettingRow
                testID="memory-settings-delete-on-disable-item"
                setting={MEMORY_SETTINGS.settings.deleteOnDisable}
                rightElement={(
                    <Switch
                        testID="memory-settings-delete-on-disable"
                        value={settings.deleteOnDisable}
                        onValueChange={(value) => {
                            void props.writeSettings({ ...settings, deleteOnDisable: Boolean(value) });
                        }}
                    />
                )}
                showChevron={false}
            />
        </ItemGroup>
    );
});
