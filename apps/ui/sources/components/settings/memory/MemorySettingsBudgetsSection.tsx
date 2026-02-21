import * as React from 'react';
import { Ionicons } from '@expo/vector-icons';
import { useUnistyles } from 'react-native-unistyles';

import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { Item } from '@/components/ui/lists/Item';
import { Modal } from '@/modal';

import type { MemorySettingsV1 } from '@happier-dev/protocol';

export const MemorySettingsBudgetsSection = React.memo(function MemorySettingsBudgetsSection(props: Readonly<{
    settings: MemorySettingsV1;
    writeSettings: (next: MemorySettingsV1) => void | Promise<void>;
}>) {
    const { theme } = useUnistyles();
    const { settings } = props;

    return (
        <ItemGroup
            title="Disk budget"
            footer="Limits how much disk space the local memory index can use (best-effort eviction)."
        >
            <Item
                testID="memory-settings-budget-light"
                title="Light index budget"
                subtitle={`${settings.budgets.maxDiskMbLight} MB`}
                icon={<Ionicons name="server-outline" size={29} color={theme.colors.accent.blue} />}
                onPress={async () => {
                    const next = await Modal.prompt(
                        'Light index budget',
                        'Max MB for the light (summary shards) index on this machine.',
                        {
                            defaultValue: String(settings.budgets.maxDiskMbLight),
                            placeholder: '250',
                            confirmText: 'Save',
                            cancelText: 'Cancel',
                        },
                    );
                    const parsed = typeof next === 'string' ? Number.parseInt(next, 10) : NaN;
                    if (!Number.isFinite(parsed) || parsed <= 0) return;
                    void props.writeSettings({
                        ...settings,
                        budgets: { ...settings.budgets, maxDiskMbLight: Math.trunc(parsed) },
                    });
                }}
                showChevron={false}
            />
            <Item
                testID="memory-settings-budget-deep"
                title="Deep index budget"
                subtitle={`${settings.budgets.maxDiskMbDeep} MB`}
                icon={<Ionicons name="server-outline" size={29} color={theme.colors.accent.purple} />}
                onPress={async () => {
                    const next = await Modal.prompt(
                        'Deep index budget',
                        'Max MB for the deep (chunk) index on this machine.',
                        {
                            defaultValue: String(settings.budgets.maxDiskMbDeep),
                            placeholder: '1500',
                            confirmText: 'Save',
                            cancelText: 'Cancel',
                        },
                    );
                    const parsed = typeof next === 'string' ? Number.parseInt(next, 10) : NaN;
                    if (!Number.isFinite(parsed) || parsed <= 0) return;
                    void props.writeSettings({
                        ...settings,
                        budgets: { ...settings.budgets, maxDiskMbDeep: Math.trunc(parsed) },
                    });
                }}
                showChevron={false}
            />
        </ItemGroup>
    );
});
