import type { PluginProjectionV2 } from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import { buildMachineAgentInventoryDescriptors as buildProtocolMachineAgentInventoryDescriptors, type MachineAgentInventoryDescriptor, type MachineAcpInventoryDefinition } from '@happier-dev/protocol/capabilities';
import { readBackendTargetKeyV2, type BackendTargetRefV2Input } from '@happier-dev/protocol/backends/targets/backendTargetRefV2';

type MachineAgentIdentity = Pick<MachineAgentInventoryDescriptor, 'agentId' | 'definitionId'>;
const inventoryTargetIndexes = new WeakMap<readonly MachineAgentIdentity[], ReadonlyMap<string, number>>();

function hasImmutableAgentIdentity(agent: MachineAgentIdentity): boolean {
    if (!Object.isFrozen(agent)) return false;
    const agentId = Object.getOwnPropertyDescriptor(agent, 'agentId');
    const definitionId = Object.getOwnPropertyDescriptor(agent, 'definitionId');
    // Freezing an accessor does not freeze the value it returns. Only data
    // identities (as published by the inventory owner) can key a retained index.
    return Boolean(agentId && 'value' in agentId
        && (!('definitionId' in agent) || (definitionId && 'value' in definitionId)));
}

function readInventoryTargetKey(agent: MachineAgentIdentity): string | null {
    // Inventory also describes setup containers that are not executable targets.
    return readBackendTargetKeyV2({ kind: 'backend', backendId: agent.agentId,
        ...(agent.definitionId === undefined ? {} : { configuredBackendId: agent.definitionId }),
    });
}

export function buildMachineAgentInventoryDescriptors(inputs: Readonly<{
    pluginProjectionV2: Pick<PluginProjectionV2, 'agentsById'> | null;
    definitions?: readonly Pick<MachineAcpInventoryDefinition, 'definitionId' | 'title'>[];
}> | null): readonly MachineAgentInventoryDescriptor[] {
    return inputs?.pluginProjectionV2
        ? buildProtocolMachineAgentInventoryDescriptors(inputs.pluginProjectionV2, inputs.definitions)
        : [];
}

/** Configured definitions and ordinary Agents share the Protocol's canonical target identity. */
export function findMachineAgentForBackendTarget<T extends Pick<MachineAgentInventoryDescriptor, 'agentId' | 'definitionId'>>(
    agents: readonly T[], backendTarget: BackendTargetRefV2Input,
): T | null {
    const targetKey = readBackendTargetKeyV2(backendTarget);
    if (targetKey === null) return null;
    return findMachineAgentForBackendTargetKey(agents, targetKey);
}

/** Match a catalog's already-canonical key; this descriptive lookup grants no execution admission. */
export function findMachineAgentForBackendTargetKey<T extends Pick<MachineAgentInventoryDescriptor, 'agentId' | 'definitionId'>>(
    agents: readonly T[], targetKey: string,
): T | null {
    let index = inventoryTargetIndexes.get(agents);
    if (!index && Object.isFrozen(agents) && agents.every(hasImmutableAgentIdentity)) {
        // The inventory producer freezes the array and each row's identity fields.
        // One index replaces per-option admission of the same immutable candidates;
        // replacement arrays naturally invalidate it and weak keys retain no old inventory.
        const next = new Map<string, number>();
        agents.forEach((agent, position) => {
            const key = readInventoryTargetKey(agent);
            if (key !== null && !next.has(key)) next.set(key, position);
        });
        inventoryTargetIndexes.set(agents, next);
        index = next;
    }
    if (!index) return agents.find(agent => readInventoryTargetKey(agent) === targetKey) ?? null;
    const position = index.get(targetKey);
    return position === undefined ? null : agents[position] ?? null;
}
