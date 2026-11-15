import React from 'react';
import { UsagePanel } from '@/components/settings/usage/UsagePanel';
import { ItemList } from '@/components/ui/lists/ItemList';
import { ProviderUsageGaugeSettingsGroup } from '@/components/settings/connectedServices/ProviderUsageGaugeSettingsGroup';

export default function UsageSettingsScreen() {
    return (
        <ItemList style={{ paddingTop: 0 }}>
            <ProviderUsageGaugeSettingsGroup />
            <UsagePanel />
        </ItemList>
    );
}
