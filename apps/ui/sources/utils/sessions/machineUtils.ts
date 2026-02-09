import type { Machine } from '@/sync/domains/state/storageTypes';

export function isMachineOnline(machine: Machine): boolean {
    // Use the active flag directly, no timeout checks
    return machine.active;
}