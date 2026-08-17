import type { McpServerBindingTargetV1 } from '@happier-dev/protocol';

import type { Machine } from '@/sync/domains/state/storageTypes';

/**
 * Creates the initial persisted MCP binding target. The binding itself remains
 * the feature-owned routing decision for later MCP operations; this draft
 * default is not a Machine Administration execution target.
 */
export function createDefaultMcpBindingTarget(_machines: readonly Pick<Machine, 'id'>[]): McpServerBindingTargetV1 {
    return { t: 'allMachines' };
}

export function resolveMcpBindingTargetTypeChange(
    currentTarget: McpServerBindingTargetV1,
    nextType: McpServerBindingTargetV1['t'],
    machines: readonly Pick<Machine, 'id'>[],
    selectedMachineId?: string,
): McpServerBindingTargetV1 | null {
    if (nextType === 'allMachines') {
        return { t: 'allMachines' };
    }

    const machineId = currentTarget.t === 'allMachines'
        ? selectedMachineId
        : currentTarget.machineId;
    if (!machineId) {
        return null;
    }
    if (currentTarget.t === 'allMachines' && !machines.some((machine) => machine.id === machineId)) {
        return null;
    }

    if (nextType === 'machine') {
        return { t: 'machine', machineId };
    }

    return { t: 'workspace', machineId, workspaceRoot: '/' };
}
