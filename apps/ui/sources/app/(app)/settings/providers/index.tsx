import React from 'react';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';

import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import { AcpCatalogSettingsSections } from '@/components/settings/acpCatalog/AcpCatalogSettingsSections';
import { AGENT_IDS, getAgentCore } from '@/agents/catalog/catalog';
import { useSetting } from '@/sync/domains/state/storage';
import { t } from '@/text';
import { useUnistyles } from 'react-native-unistyles';
import { buildBackendTargetKey } from '@happier-dev/protocol';

const PROVIDER_SETTINGS_AGENT_IDS = AGENT_IDS.filter((agentId) => agentId !== 'customAcp');

export default React.memo(function ProviderSettingsIndexScreen() {
    const router = useRouter();
    const { theme } = useUnistyles();
    const backendEnabledByTargetKey = useSetting('backendEnabledByTargetKey');

    return (
        <ItemList style={{ paddingTop: 0 }}>
            <ItemGroup
                title={t('settingsProviders.title')}
                footer={t('settingsProviders.footer')}
            >
                {PROVIDER_SETTINGS_AGENT_IDS.map((agentId) => {
                    const core = getAgentCore(agentId);
                    const targetKey = buildBackendTargetKey({ kind: 'builtInAgent', agentId });
                    const isEnabled = backendEnabledByTargetKey?.[targetKey] !== false;
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
            <AcpCatalogSettingsSections />
        </ItemList>
    );
});
