import type { Machine } from '@/sync/domains/state/storageTypes';

import { isMachineReplaced } from './machineIdentityTypes';

export function isMachineVisibleForLaunchSelection(machine: Machine): boolean {
    const revokedAt = machine.revokedAt;
    if (typeof revokedAt === 'number' && Number.isFinite(revokedAt) && revokedAt > 0) return false;
    return !isMachineReplaced(machine);
}

export function filterVisibleMachinesForLaunchSelection(machines: ReadonlyArray<Machine>): Machine[] {
    return machines.filter(isMachineVisibleForLaunchSelection);
}
