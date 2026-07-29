import React from 'react';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';

import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import { AcpCatalogSettingsSections } from '@/components/settings/acpCatalog/AcpCatalogSettingsSections';
import { AgentSetupFlow } from '@/components/settings/agents/setup/AgentSetupFlow';
import { resolveAgentChannelLabelKey } from '@/components/settings/agents/agentChannelLabel';
import {
    getResolvedAgentCatalogEntries,
    type ResolvedAgentCatalogEntry,
} from '@/agents/backendCatalog/agentCatalogProjection';
import { useDaemonMergedProjectionInputs } from '@/agents/backendCatalog/useDaemonMergedProjectionInputs';
import { getAgentCore } from '@/agents/catalog/catalog';
import { useAllMachines, useMachineListByServerId, useSetting } from '@/sync/domains/state/storage';
import { useActiveServerSnapshot } from '@/hooks/server/useActiveServerSnapshot';
import { t } from '@/text';
import { useUnistyles } from 'react-native-unistyles';
import type { AcpCatalogSettingsV1 } from '@happier-dev/protocol';
import type { Machine } from '@/sync/domains/state/storageTypes';

function resolveAgentRowIconName(entry: ResolvedAgentCatalogEntry): string {
    return entry.iconAgentId ? getAgentCore(entry.iconAgentId).ui.agentPickerIconName : entry.iconName;
}

function resolveActiveServerMachineIds(params: Readonly<{
    capabilityServerId: string | null;
    machineListByServerId: Readonly<Record<string, readonly Machine[] | null | undefined>>;
    machines: readonly Machine[];
}>): string[] {
    const capabilityServerId = params.capabilityServerId;
    if (!capabilityServerId) return [];

    const serverMachineEntries = params.machineListByServerId[capabilityServerId];
    if (Array.isArray(serverMachineEntries) && serverMachineEntries.length > 0) {
        return serverMachineEntries
            .filter((entry) => entry.revokedAt == null)
            .map((entry) => entry.id);
    }

    const machineIdsClaimedByOtherServers = new Set<string>();
    for (const [serverId, entries] of Object.entries(params.machineListByServerId)) {
        if (serverId === capabilityServerId || !Array.isArray(entries)) continue;
        for (const entry of entries) {
            if (entry?.revokedAt == null && typeof entry?.id === 'string' && entry.id.trim().length > 0) {
                machineIdsClaimedByOtherServers.add(entry.id);
            }
        }
    }

    return params.machines
        .filter((machine) => machine.revokedAt == null && !machineIdsClaimedByOtherServers.has(machine.id))
        .map((machine) => machine.id);
}

export default React.memo(function ProviderSettingsIndexScreen() {
    const router = useRouter();
    const { theme } = useUnistyles();
    const backendEnabledByTargetKey = useSetting('backendEnabledByTargetKey');
    const acpCatalogSettingsV1 = useSetting('acpCatalogSettingsV1') as AcpCatalogSettingsV1 | undefined;
    const machines = useAllMachines();
    const machineListByServerId = useMachineListByServerId();
    const activeServerSnapshot = useActiveServerSnapshot();
    const activeServerId = React.useMemo(() => {
        const value = activeServerSnapshot.serverId;
        return typeof value === 'string' && value.trim().length > 0 ? value : null;
    }, [activeServerSnapshot.serverId]);
    const activeServerMachineIds = React.useMemo(() => {
        return resolveActiveServerMachineIds({
            capabilityServerId: activeServerId,
            machineListByServerId,
            machines,
        });
    }, [activeServerId, machineListByServerId, machines]);
    const projectionMachineId = React.useMemo(() => {
        if (activeServerMachineIds.length === 0) {
            return null;
        }
        const machineMap = new Map(machines.map((machine) => [machine.id, machine] as const));
        const activeServerMachines = activeServerMachineIds
            .map((machineId) => machineMap.get(machineId) ?? null)
            .filter((machine): machine is Machine => machine !== null);
        const activeMachine = activeServerMachines.find((machine) => machine.active === true) ?? null;
        return activeMachine?.id ?? activeServerMachines[0]?.id ?? null;
    }, [activeServerMachineIds, machines]);
    const daemonMergedProjection = useDaemonMergedProjectionInputs({
        machineId: projectionMachineId,
        serverId: activeServerId,
        enabled: Boolean(projectionMachineId && activeServerId),
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
            <ItemGroup
                title={t('settingsAgents.title')}
                footer={t('settingsAgents.footer')}
            >
                {agentEntries.length === 0 ? (
                    <Item
                        title={t('settingsAgents.notAvailable')}
                        subtitle={t('settingsAgents.footer')}
                        icon={<Ionicons name="alert-circle-outline" size={29} color={theme.colors.state.danger.foreground} />}
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
                            icon={<Ionicons name={resolveAgentRowIconName(entry) as any} size={29} color={theme.colors.text.secondary} />}
                            onPress={() => router.push(`/(app)/settings/agents/${entry.agentId}` as any)}
                        />
                    );
                })}
            </ItemGroup>
            <AgentSetupFlow
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
