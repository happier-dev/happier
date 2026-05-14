import { resolveReplacementAwareMachineRpcTarget } from '@/sync/domains/machines/identity/resolveReplacementAwareMachineRpcTarget';
import { storage } from '@/sync/domains/state/storage';
import type { Machine } from '@/sync/domains/state/storageTypes';

export function readReplacementAwareMachineRpcTarget(
    machineId: string | null | undefined,
): { machineId: string; originMachineId: string; replaced: boolean } | null {
    const state = storage.getState() as Readonly<{ machines?: Record<string, Machine> }>;
    return resolveReplacementAwareMachineRpcTarget({
        machineId,
        machines: Object.values(state.machines ?? {}),
    });
}
