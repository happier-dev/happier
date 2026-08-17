import React from 'react';
import { useRouter } from 'expo-router';

import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import { AcpCatalogSettingsSections } from '@/components/settings/acpCatalog/AcpCatalogSettingsSections';
import { AgentSetupFlow } from '@/components/settings/agents/setup/AgentSetupFlow';
import { resolveAgentChannelLabelKey } from '@/components/settings/agents/agentChannelLabel';
import { MachineAdministrationTargetSelector } from '@/components/settings/machines/MachineAdministrationTargetSelector';
import {
    getResolvedAgentCatalogEntries,
    type ResolvedAgentCatalogEntry,
} from '@/agents/backendCatalog/agentCatalogProjection';
import { useDaemonMergedProjectionInputs } from '@/agents/backendCatalog/useDaemonMergedProjectionInputs';
import { getAgentCore } from '@/agents/catalog/catalog';
import { useSetting } from '@/sync/domains/state/storage';
import { MACHINE_ADMINISTRATION_SELECTION_KEYS_V1 } from '@/sync/domains/machines/administration/selectionPreferences';
import { machineAdministrationTargetsEqual } from '@/sync/domains/machines/administration/targetSelection';
import { useMachineAdministrationTargetSelection } from '@/sync/domains/machines/administration/useTargetSelection';
import { t } from '@/text';
import { useUnistyles } from 'react-native-unistyles';
import type { AcpCatalogSettingsV1 } from '@happier-dev/protocol';
import { Icon } from '@/components/ui/icons/Icon';

function resolveAgentRowIconName(entry: ResolvedAgentCatalogEntry): string {
    return entry.iconAgentId ? getAgentCore(entry.iconAgentId).ui.agentPickerIconName : entry.iconName;
}

export default React.memo(function ProviderSettingsIndexScreen() {
    const router = useRouter();
    const { theme } = useUnistyles();
    const backendEnabledByTargetKey = useSetting('backendEnabledByTargetKey');
    const acpCatalogSettingsV1 = useSetting('acpCatalogSettingsV1') as AcpCatalogSettingsV1 | undefined;
    const administrationTargetSelection = useMachineAdministrationTargetSelection(
        MACHINE_ADMINISTRATION_SELECTION_KEYS_V1.agents,
    );
    const executionTarget = React.useMemo(() => {
        const selectedTarget = administrationTargetSelection.selectedTarget;
        const resolvedTarget = administrationTargetSelection.resolveExecutionTarget();
        return selectedTarget !== null
            && resolvedTarget !== null
            && machineAdministrationTargetsEqual(selectedTarget, resolvedTarget.target)
            ? resolvedTarget
            : null;
    }, [administrationTargetSelection]);
    const daemonMergedProjection = useDaemonMergedProjectionInputs({
        machineId: executionTarget?.machine.id ?? null,
        serverId: executionTarget?.serverId ?? null,
        enabled: executionTarget !== null,
        retainInputsAcrossScopeChange: true,
    });
    const daemonMergedProjectionInputs = daemonMergedProjection.inputs;

    const agentEntries = React.useMemo(() => {
        return getResolvedAgentCatalogEntries({
            enabledAgentIds: [],
            backendEnabledByTargetKey,
            acpCatalogSettingsV1,
            mergedProviderProjectionById: daemonMergedProjectionInputs?.mergedProviderProjectionById ?? null,
            mergedBackendProjectionById: daemonMergedProjectionInputs?.mergedBackendProjectionById ?? null,
        });
    }, [acpCatalogSettingsV1, backendEnabledByTargetKey, daemonMergedProjectionInputs]);

    return (
        <ItemList style={{ paddingTop: 0 }}>
            <MachineAdministrationTargetSelector
                selection={administrationTargetSelection}
                testIDPrefix="settings.agents.administration.target"
            />
            <ItemGroup
                title={t('settingsAgents.title')}
                footer={t('settingsAgents.footer')}
            >
                {agentEntries.length === 0 ? (
                    <Item
                        title={t('settingsAgents.notAvailable')}
                        subtitle={t('settingsAgents.footer')}
                        icon={<Icon name="warning-circle" size={29} color={theme.colors.state.danger.foreground} />}
                    />
                ) : agentEntries.map((entry) => {
                    const state = entry.enabled === true
                        ? t('settingsAgents.stateEnabled')
                        : entry.enabled === false
                            ? t('settingsAgents.stateDisabled')
                            : t('settingsAgents.notAvailable');
                    const channel = t(resolveAgentChannelLabelKey(entry.channel));
                    return (
                        <Item
                            key={entry.agentId}
                            title={entry.title}
                            subtitle={`${state} • ${channel}`}
                            icon={<Icon name={resolveAgentRowIconName(entry) as any} size={29} color={theme.colors.text.secondary} />}
                            onPress={() => router.push(`/(app)/settings/agents/${entry.agentId}` as any)}
                        />
                    );
                })}
            </ItemGroup>
            <AgentSetupFlow
                machineId={executionTarget?.machine.id ?? null}
                serverId={executionTarget?.serverId ?? null}
                agentEntries={agentEntries.map((entry) => ({
                    agentId: entry.agentId,
                    catalogAgentId: entry.catalogAgentId,
                    title: entry.title,
                    subtitle: entry.subtitle,
                    iconAgentId: entry.iconAgentId,
                    iconName: entry.iconName,
                }))}
            />
            <AcpCatalogSettingsSections />
        </ItemList>
    );
});
