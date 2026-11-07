import React from 'react';
import { ProviderUsageGaugeSettingsGroup } from '@/components/settings/connectedServices/ProviderUsageGaugeSettingsGroup';
import { ProviderUsageRefreshIntervalSetting } from '@/components/settings/usage/ProviderUsageRefreshIntervalSetting';
import { UsagePanel } from '@/components/settings/usage/UsagePanel';
import { ItemList } from '@/components/ui/lists/ItemList';

export default function UsageSettingsScreen() {
    return (
        <ItemList style={{ paddingTop: 0 }}>
            <ProviderUsageRefreshIntervalSetting />
            <ProviderUsageGaugeSettingsGroup />
            <UsagePanel />
        </ItemList>
    );
}
