import * as React from 'react';
import { useRouter } from 'expo-router';
import { useUnistyles } from 'react-native-unistyles';

import { getResolvedBackendCatalogEntries } from '@/agents/backendCatalog/getResolvedBackendCatalogEntries';
import { useEnabledAgentIds } from '@/agents/hooks/useEnabledAgentIds';
import { ICON_SIZE, Icon } from '@/components/ui/icons/Icon';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import { useSetting } from '@/sync/domains/state/storage';
import { t } from '@/text';

import { SessionRoleProfilesGroup } from './roleProfiles/SessionRoleProfilesGroup';
import { VisibleAgentsSettings } from './visibleAgents/VisibleAgentsSettings';

export const VisibleSubagentsSettingsView = React.memo(function VisibleSubagentsSettingsView() {
    const router = useRouter();
    const { theme } = useUnistyles();
    const enabledAgentIds = useEnabledAgentIds();
    const acpCatalogSettingsV1 = useSetting('acpCatalogSettingsV1');
    const backendEnabledByTargetKey = useSetting('backendEnabledByTargetKey');
    const backendEntries = React.useMemo(() => getResolvedBackendCatalogEntries({
        enabledAgentIds,
        acpCatalogSettingsV1,
        backendEnabledByTargetKey: backendEnabledByTargetKey as Record<string, boolean> | undefined,
    }), [acpCatalogSettingsV1, backendEnabledByTargetKey, enabledAgentIds]);

    return (
        <ItemList style={{ paddingTop: 0 }}>
            <ItemGroup
                title={t('visibleAgents.overview.title')}
                footer={`${t('visibleAgents.overview.description')}\n\n${t('visibleAgents.overview.additionalHelper')}`}
            >
                <Item
                    title={t('subAgentGuidance.settings.groupTitle')}
                    subtitle={t('settingsSession.subAgentGuidanceEntry.openSubtitle')}
                    icon={<Icon name="robot" size={ICON_SIZE.xl} color={theme.colors.accent.orange} />}
                    onPress={() => router.push('/settings/sub-agent')}
                />
            </ItemGroup>
            <SessionRoleProfilesGroup />
            <VisibleAgentsSettings backendEntries={backendEntries} />
        </ItemList>
    );
});
