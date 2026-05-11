import * as React from 'react';
import { Ionicons } from '@expo/vector-icons';
import { useUnistyles } from 'react-native-unistyles';

import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { Item } from '@/components/ui/lists/Item';
import { Switch } from '@/components/ui/forms/Switch';
import { t } from '@/text';

import type { MemorySettingsV1 } from '@happier-dev/protocol';

export const MemorySettingsPrivacySection = React.memo(function MemorySettingsPrivacySection(props: Readonly<{
    settings: MemorySettingsV1;
    writeSettings: (next: MemorySettingsV1) => void | Promise<void>;
}>) {
    const { theme } = useUnistyles();
    const { settings } = props;

    return (
        <ItemGroup
            title={t('memorySearchSettings.privacy.groupTitle')}
            footer={t('memorySearchSettings.privacy.groupFooter')}
        >
            <Item
                testID="memory-settings-delete-on-disable-item"
                title={t('memorySearchSettings.privacy.deleteOnDisableTitle')}
                subtitle={t('memorySearchSettings.privacy.deleteOnDisableSubtitle')}
                icon={<Ionicons name="trash-outline" size={29} color={theme.colors.state.danger.foreground} />}
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
