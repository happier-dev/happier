import type { McpServerBindingTargetV1 } from '@happier-dev/protocol';

import type { Machine } from '@/sync/domains/state/storageTypes';

export function createDefaultMcpBindingTarget(machines: readonly Machine[]): McpServerBindingTargetV1 {
    const firstMachineId = machines[0]?.id;
    if (!firstMachineId) {
        return { t: 'allMachines' };
    }

    return { t: 'machine', machineId: firstMachineId };
}

export function resolveMcpBindingTargetTypeChange(
    currentTarget: McpServerBindingTargetV1,
    nextType: McpServerBindingTargetV1['t'],
    machines: readonly Machine[],
): McpServerBindingTargetV1 | null {
    if (nextType === 'allMachines') {
        return { t: 'allMachines' };
    }

    const fallbackMachineId = currentTarget.t === 'allMachines'
        ? machines[0]?.id
        : currentTarget.machineId;
    if (!fallbackMachineId) {
        return null;
    }

    if (nextType === 'machine') {
        return { t: 'machine', machineId: fallbackMachineId };
    }

    return { t: 'workspace', machineId: fallbackMachineId, workspaceRoot: '/' };
}
