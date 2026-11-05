import type { Machine } from '@/sync/domains/state/storageTypes';

/** Keyed and ordered views of the same admitted Home inventory. */
export function indexMachineInventory(machines: readonly Machine[] | null | undefined): Record<string, Machine> {
    const byId: Record<string, Machine> = {};
    for (const machine of machines ?? []) byId[machine.id] = machine;
    return byId;
}

export function mergeMachineInventory(
    current: Machine[] | null | undefined,
    currentById: Record<string, Machine>,
    incoming: Machine[],
    replace: boolean,
): Readonly<{ machines: Machine[]; byId: Record<string, Machine> }> {
    const mergedById = new Map<string, Machine>();
    if (!replace) for (const machine of current ?? []) mergedById.set(machine.id, currentById[machine.id]);
    for (const machine of incoming) mergedById.set(machine.id, machine);
    const machines = Array.from(mergedById.values());
    if (Array.isArray(current) && current.length === machines.length
        && current.every((machine, index) => machine === machines[index])) {
        return { machines: current, byId: currentById };
    }
    return { machines, byId: indexMachineInventory(machines) };
}
