import React from 'react';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';

import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import { AGENT_IDS, getAgentCore } from '@/agents/catalog';
import { useSetting } from '@/sync/storage';
import { t } from '@/text';
import { useUnistyles } from 'react-native-unistyles';

export default React.memo(function ProviderSettingsIndexScreen() {
    const router = useRouter();
    const { theme } = useUnistyles();
    const backendEnabledById = useSetting('backendEnabledById');

    return (
        <ItemList style={{ paddingTop: 0 }}>
            <ItemGroup
                title={t('settingsProviders.title')}
                footer={t('settingsProviders.footer')}
            >
                {AGENT_IDS.map((agentId) => {
                    const core = getAgentCore(agentId);
                    const isEnabled = backendEnabledById?.[agentId] !== false;
                    const state = isEnabled ? t('settingsProviders.stateEnabled') : t('settingsProviders.stateDisabled');
                    const channel = core.availability.experimental ? t('settingsProviders.channelExperimental') : t('settingsProviders.channelStable');
                    return (
                        <Item
                            key={agentId}
                            title={t(core.displayNameKey)}
                            subtitle={`${state} • ${channel}`}
                            icon={<Ionicons name={core.ui.agentPickerIconName as any} size={29} color={theme.colors.textSecondary} />}
                            onPress={() => router.push(`/(app)/settings/providers/${agentId}` as any)}
                        />
                    );
                })}
            </ItemGroup>
        </ItemList>
    );
});
