import * as React from 'react';

import { FieldValueItem } from '@/components/ui/forms/FieldValueItem';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { SettingAnchor } from '@/components/settings/shell/SettingRow';
import { MEMORY_SETTINGS } from '@/components/settings/memory/memorySettings';
import { t } from '@/text';

import type { MemorySettingsV1 } from '@happier-dev/protocol/memory/memorySettings';

/** A budget is a positive whole number of MB; anything else keeps the saved budget. */
function parseBudgetMb(draft: string): number | null {
    const parsed = Number.parseInt(draft, 10);
    return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : null;
}

export const MemorySettingsBudgetsSection = React.memo(function MemorySettingsBudgetsSection(props: Readonly<{
    settings: MemorySettingsV1;
    writeSettings: (next: MemorySettingsV1) => void | Promise<void>;
}>) {
    const { settings } = props;

    return (
        <ItemGroup
            title={t('memorySearchSettings.budgets.groupTitle')}
            description={t('memorySearchSettings.budgets.groupFooter')}
        >
            <SettingAnchor setting={MEMORY_SETTINGS.settings.lightBudget}>
                <FieldValueItem
                    testID="memory-settings-budget-light"
                    fieldTestID="memory-settings-budget-light-field"
                    title={t(MEMORY_SETTINGS.settings.lightBudget.titleKey)}
                    subtitle={t('memorySearchSettings.budgets.lightPromptBody')}
                    kind="integer"
                    placeholder="250"
                    value={String(settings.budgets.maxDiskMbLight)}
                    onCommit={(draft) => {
                        const next = parseBudgetMb(draft);
                        if (next === null) return String(settings.budgets.maxDiskMbLight);
                        void props.writeSettings({
                            ...settings,
                            budgets: { ...settings.budgets, maxDiskMbLight: next },
                        });
                        return String(next);
                    }}
                />
            </SettingAnchor>
            <SettingAnchor setting={MEMORY_SETTINGS.settings.deepBudget}>
                <FieldValueItem
                    testID="memory-settings-budget-deep"
                    fieldTestID="memory-settings-budget-deep-field"
                    title={t(MEMORY_SETTINGS.settings.deepBudget.titleKey)}
                    subtitle={t('memorySearchSettings.budgets.deepPromptBody')}
                    kind="integer"
                    placeholder="1500"
                    value={String(settings.budgets.maxDiskMbDeep)}
                    onCommit={(draft) => {
                        const next = parseBudgetMb(draft);
                        if (next === null) return String(settings.budgets.maxDiskMbDeep);
                        void props.writeSettings({
                            ...settings,
                            budgets: { ...settings.budgets, maxDiskMbDeep: next },
                        });
                        return String(next);
                    }}
                />
            </SettingAnchor>
        </ItemGroup>
    );
});
