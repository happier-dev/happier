import * as React from 'react';
import { Ionicons } from '@expo/vector-icons';

import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { Item } from '@/components/ui/lists/Item';
import { Switch } from '@/components/ui/forms/Switch';

import type { MemorySettingsV1 } from '@happier-dev/protocol';

export const MemorySettingsPrivacySection = React.memo(function MemorySettingsPrivacySection(props: Readonly<{
    settings: MemorySettingsV1;
    writeSettings: (next: MemorySettingsV1) => void | Promise<void>;
}>) {
    const { settings } = props;

    return (
        <ItemGroup
            title="Privacy"
            footer="Delete local derived indexes and model caches when disabling memory search."
        >
            <Item
                testID="memory-settings-delete-on-disable-item"
                title="Delete on disable"
                subtitle="Remove local indexes and caches when memory search is turned off"
                icon={<Ionicons name="trash-outline" size={29} color="#FF3B30" />}
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

