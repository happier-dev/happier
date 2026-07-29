import type { Machine } from '@/sync/domains/state/storageTypes';
import { resolveMachineSpawnReadiness, type MachineSpawnReadiness } from '@/sync/domains/machines/identity/resolveMachineSpawnReadiness';
import { isMachineOnline } from '@/utils/sessions/machineUtils';

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
    const readiness = params.spawnReadiness ?? resolveMachineSpawnReadiness({
        selectedMachineId: params.selectedMachineId,
        machine: params.selectedMachine,
    });
    if (readiness.status === 'ready') return true;
    if (readiness.status === 'unknown' || readiness.status === 'probing') {
        return isMachineOnline(params.selectedMachine);
    }
    return false;
}
