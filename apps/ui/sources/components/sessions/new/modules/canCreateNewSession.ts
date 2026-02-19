import type { Machine } from '@/sync/domains/state/storageTypes';
import { isMachineOnline } from '@/utils/sessions/machineUtils';

export function canCreateNewSession(params: Readonly<{
    selectedMachineId: string | null;
    selectedMachine: Machine | null;
    selectedPath: string;
}>): boolean {
    if (!params.selectedMachineId) return false;
    if (!params.selectedPath.trim()) return false;
    if (!params.selectedMachine) return false;
    return isMachineOnline(params.selectedMachine);
}

