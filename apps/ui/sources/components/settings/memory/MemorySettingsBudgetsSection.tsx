import * as React from 'react';
import { Ionicons } from '@expo/vector-icons';
import { useUnistyles } from 'react-native-unistyles';

import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { Item } from '@/components/ui/lists/Item';
import { Modal } from '@/modal';
import { t } from '@/text';

import type { MemorySettingsV1 } from '@happier-dev/protocol';

export const MemorySettingsBudgetsSection = React.memo(function MemorySettingsBudgetsSection(props: Readonly<{
    settings: MemorySettingsV1;
    writeSettings: (next: MemorySettingsV1) => void | Promise<void>;
}>) {
    const { theme } = useUnistyles();
    const { settings } = props;

    return (
        <ItemGroup
            title={t('memorySearchSettings.budgets.groupTitle')}
            footer={t('memorySearchSettings.budgets.groupFooter')}
        >
            <Item
                testID="memory-settings-budget-light"
                title={t('memorySearchSettings.budgets.lightTitle')}
                subtitle={t('memorySearchSettings.budgets.mbLabel', { mb: settings.budgets.maxDiskMbLight })}
                icon={<Ionicons name="server-outline" size={29} color={theme.colors.accent.blue} />}
                onPress={async () => {
                    const next = await Modal.prompt(
                        t('memorySearchSettings.budgets.lightPromptTitle'),
                        t('memorySearchSettings.budgets.lightPromptBody'),
                        {
                            defaultValue: String(settings.budgets.maxDiskMbLight),
                            placeholder: '250',
                            confirmText: t('common.save'),
                            cancelText: t('common.cancel'),
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
                title={t('memorySearchSettings.budgets.deepTitle')}
                subtitle={t('memorySearchSettings.budgets.mbLabel', { mb: settings.budgets.maxDiskMbDeep })}
                icon={<Ionicons name="server-outline" size={29} color={theme.colors.accent.purple} />}
                onPress={async () => {
                    const next = await Modal.prompt(
                        t('memorySearchSettings.budgets.deepPromptTitle'),
                        t('memorySearchSettings.budgets.deepPromptBody'),
                        {
                            defaultValue: String(settings.budgets.maxDiskMbDeep),
                            placeholder: '1500',
                            confirmText: t('common.save'),
                            cancelText: t('common.cancel'),
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
