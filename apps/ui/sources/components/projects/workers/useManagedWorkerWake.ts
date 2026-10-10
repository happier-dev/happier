import { resolveManagedMachineWakeStateV1 } from '@happier-dev/protocol/machines/managed/resolveMachineRetentionPolicyV1';

import { useManagedMachineInventory } from '@/components/settings/machines/managed/useManagedMachineInventory';

const NO_HOMES: readonly string[] = [];

/**
 * The retained-power fact of the exact worker a pending Run targets (FX13): `starting` while C52
 * wakes it, from the same push-refreshed managed inventory, never from the Run's own spinner.
 * Reads nothing unless a target is given.
 */
export function useManagedWorkerWake(serverId: string, machineId: string | null): 'asleep' | 'starting' | null {
    const homes = machineId ? [serverId] : NO_HOMES;
    const inventory = useManagedMachineInventory(homes);
    const entry = machineId ? inventory.entries[serverId] : undefined;
    if (!machineId || entry?.status !== 'ready') return null;
    const managed = entry.machines.find((machine) => machine.enrolledMachineId === machineId);
    return managed ? resolveManagedMachineWakeStateV1(managed, machineId) : null;
}
