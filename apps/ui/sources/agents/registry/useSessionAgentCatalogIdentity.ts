import * as React from 'react';
import { useShallow } from 'zustand/react/shallow';
import { buildMachineAgentInventoryKey } from '@happier-dev/protocol/capabilities';

import { normalizeAgentCatalogId, resolveAgentCatalogProjection, resolveConfiguredAcpAgentCatalogProjection, type ResolvedAgentCatalogEntry } from '@/agents/backendCatalog/agentCatalogProjection';
import { useDaemonMergedProjectionSummary } from '@/agents/backendCatalog/useDaemonMergedProjectionInputs';
import { BackendTargetRefV2Schema } from '@happier-dev/protocol/backends/targets/backendTargetRefV2';
import { machineAgentInventoryStore } from '@/agents/machineAgents/machineAgentInventoryStore';
import { getAcpCatalogSnapshot, subscribeAcpCatalogSnapshots } from '@/sync/store/settings/acpCatalogSnapshot';
import { useAccountSettingsScope } from '@/sync/store/settingsWriters';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { serverAccountScopedResourceKey } from '@/sync/domains/scope/serverAccountScope';
const NO_MACHINES: readonly Readonly<{ machineId: string; agentIds: readonly string[] }>[] = Object.freeze([]);

export type SessionAgentCatalogIdentity = Readonly<{
    entry: ResolvedAgentCatalogEntry;
    current: boolean;
    markAgentId: ResolvedAgentCatalogEntry['iconAgentId'];
}>;

/** Several Agents' catalog identities (names and marks) from the same inert summary, in the given order. */
export function useAgentCatalogIdentities(input: Readonly<{
    agentIds: readonly string[];
    machineId: string | null;
    serverId: string | null;
    /** Aggregate reach words retain the Machines that supplied their concrete inventory. */
    machines?: readonly Readonly<{ machineId: string; agentIds: readonly string[] }>[];
}>): readonly SessionAgentCatalogIdentity[] {
    const projection = useDaemonMergedProjectionSummary(input);
    const key = input.agentIds.join('\u0000');
    // The selected value may be a persisted target key; resolve just those identities.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    const agentIds = React.useMemo(() => input.agentIds.map(normalizeAgentCatalogId), [key]);
    const needsDefinitions = agentIds.some(agentId => !BackendTargetRefV2Schema.safeParse({ kind: 'backend', backendId: agentId }).success);
    const accountScope = useAccountSettingsScope();
    const scope = needsDefinitions && accountScope && (!input.serverId
        || areServerProfileIdentifiersEquivalent(input.serverId, accountScope.serverId)) ? accountScope : null;
    const machines = needsDefinitions ? input.machines ?? (input.machineId ? [{ machineId: input.machineId, agentIds }] : NO_MACHINES) : NO_MACHINES;
    const machineKey = JSON.stringify(machines);
    const inventoryKeys = React.useMemo(() => scope
        ? machines.map(machine => serverAccountScopedResourceKey(scope, 'machine-agents', machine.machineId)) : [],
    // The key represents the Machine ids' contents, including for a new equal array.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [scope, machineKey]);
    // Identity needs installed configured membership, not check timestamps,
    // loading/offline state, versions or authentication presentation.
    const readInventory = useShallow<void, ReadonlySet<string>>(() => new Set(inventoryKeys.flatMap((inventoryKey, index) =>
        machineAgentInventoryStore.read(inventoryKey).agents.filter(agent => agent.installed && agent.definitionId !== undefined
            && machines[index]?.agentIds.some(agentId => buildMachineAgentInventoryKey({ agentId, definitionId: agent.definitionId })
                === buildMachineAgentInventoryKey(agent))).map(agent => buildMachineAgentInventoryKey(agent)))));
    const subscribeInventory = React.useCallback((listener: () => void) => {
        const disposers = inventoryKeys.map(inventoryKey => machineAgentInventoryStore.subscribe(inventoryKey, listener));
        return () => { for (const dispose of disposers) dispose(); };
    }, [inventoryKeys]);
    const installedDefinitions = React.useSyncExternalStore(subscribeInventory, readInventory, readInventory);
    const readAcp = React.useCallback(() => getAcpCatalogSnapshot(scope), [scope]);
    const acp = React.useSyncExternalStore(subscribeAcpCatalogSnapshots, readAcp, readAcp);
    return React.useMemo(() => agentIds.flatMap((agentId): SessionAgentCatalogIdentity[] => {
        const params = {
            enabledAgentIds: [],
            mergedBackendProjectionById: projection.inputs?.mergedBackendProjectionById ?? null,
            mergedProviderProjectionById: projection.inputs?.mergedProviderProjectionById ?? null,
        };
        if (!BackendTargetRefV2Schema.safeParse({ kind: 'backend', backendId: agentId }).success) {
            return (acp?.data?.definitions ?? []).filter(definition => installedDefinitions.has(buildMachineAgentInventoryKey({
                agentId, definitionId: definition.id,
            }))).map(definition => ({
                entry: { ...resolveConfiguredAcpAgentCatalogProjection(definition, params), agentId },
                current: projection.current,
                markAgentId: null,
            }));
        }
        const entry = resolveAgentCatalogProjection(agentId, params);
        return [{ entry, current: projection.current, markAgentId: entry.isBuiltIn ? entry.iconAgentId : null }];
        // `key` stands for the ids' contents, so a new array with the same ids keeps the identities.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }), [projection.inputs?.mergedBackendProjectionById, projection.inputs?.mergedProviderProjectionById, projection.current, key, installedDefinitions, acp?.data, machineKey]);
}

/** Session chrome shares the existing inert catalog summary; reading a mark starts no daemon work. */
export function useSessionAgentCatalogIdentity(input: Readonly<{
    agentId: string;
    machineId: string | null;
    serverId: string | null;
}>): SessionAgentCatalogIdentity {
    const agentIds = React.useMemo(() => [input.agentId], [input.agentId]);
    const identities = useAgentCatalogIdentities({ agentIds, machineId: input.machineId, serverId: input.serverId });
    const identity = identities.find(candidate => BackendTargetRefV2Schema.safeParse({ kind: 'backend', backendId: candidate.entry.agentId }).success);
    // Session chrome without a configured target keeps a neutral contribution mark; it never picks an arbitrary instance.
    return React.useMemo(() => identity ?? ({ entry: resolveAgentCatalogProjection(input.agentId, { enabledAgentIds: [] }),
        current: false, markAgentId: null }), [identity, input.agentId]);
}
