import type { Machine } from '@/sync/domains/state/storageTypes';

import { resolveMachineSpawnReadiness, type MachineSpawnReadiness } from './resolveMachineSpawnReadiness';

type MachineWithReadinessStatus = Machine & Readonly<{
    spawnReadinessStatus?: MachineSpawnReadiness['status'];
}>;

export function resolveMachineExactSpawnReadiness(
    machine: Machine | null | undefined,
    selectedMachineId: string | null | undefined = machine?.id ?? null,
): MachineSpawnReadiness {
    const machineId = typeof selectedMachineId === 'string' ? selectedMachineId.trim() : '';
    const explicitStatus = (machine as MachineWithReadinessStatus | null | undefined)?.spawnReadinessStatus;

    if (explicitStatus === 'ready') {
        return resolveMachineSpawnReadiness({
            selectedMachineId: machineId,
            machine,
            requireExactSpawnReadiness: true,
            rpcAvailable: true,
            keyAvailable: true,
        });
    }

    if (explicitStatus === 'probing') {
        return resolveMachineSpawnReadiness({
            selectedMachineId: machineId,
            machine,
            requireExactSpawnReadiness: true,
            rpcAvailable: 'probing',
            keyAvailable: 'probing',
        });
    }

    if (explicitStatus === 'rpcUnavailable') {
        return resolveMachineSpawnReadiness({
            selectedMachineId: machineId,
            machine,
            requireExactSpawnReadiness: true,
            rpcAvailable: false,
            keyAvailable: true,
        });
    }

    if (explicitStatus === 'keyUnavailable') {
        return resolveMachineSpawnReadiness({
            selectedMachineId: machineId,
            machine,
            requireExactSpawnReadiness: true,
            rpcAvailable: true,
            keyAvailable: false,
        });
    }

    if (explicitStatus === 'unknown') {
        return resolveMachineSpawnReadiness({
            selectedMachineId: machineId,
            machine,
            requireExactSpawnReadiness: true,
            rpcAvailable: 'unknown',
            keyAvailable: 'unknown',
        });
    }

    return resolveMachineSpawnReadiness({
        selectedMachineId: machineId,
        machine,
        requireExactSpawnReadiness: true,
    });
}
