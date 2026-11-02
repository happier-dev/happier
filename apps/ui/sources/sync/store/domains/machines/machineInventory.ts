import type { Machine } from '@/sync/domains/state/storageTypes';

/** Keyed and ordered views of the same admitted Home inventory. */
export function indexMachineInventory(machines: readonly Machine[] | null | undefined): Record<string, Machine> {
    const byId: Record<string, Machine> = {};
    for (const machine of machines ?? []) byId[machine.id] = machine;
    return byId;
}
