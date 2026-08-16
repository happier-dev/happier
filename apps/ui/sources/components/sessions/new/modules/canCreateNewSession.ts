import type { Machine } from '@/sync/domains/state/storageTypes';
import { canAttemptMachineSpawn, type MachineSpawnReadiness } from '@/sync/domains/machines/identity/resolveMachineSpawnReadiness';

export function canCreateNewSession(params: Readonly<{
    selectedMachineId: string | null;
    selectedMachine: Machine | null;
    selectedPath: string;
    allowOfflineMachine?: boolean;
    spawnReadiness?: MachineSpawnReadiness | null;
}>): boolean {
    if (!params.selectedMachineId) return false;
    if (!params.selectedPath.trim()) return false;
    if (!params.selectedMachine) return false;
    if (params.allowOfflineMachine === true) return true;
    return canAttemptMachineSpawn({
        selectedMachineId: params.selectedMachineId,
        machine: params.selectedMachine,
        spawnReadiness: params.spawnReadiness,
    });
}
