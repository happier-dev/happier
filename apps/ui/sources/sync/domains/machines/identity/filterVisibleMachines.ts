import type { Machine } from '@/sync/domains/state/storageTypes';
import { isPersistentMachine } from '@happier-dev/protocol/machines/machineKind';

import { isMachineReplaced } from './machineIdentityTypes';

/** The identity facts selection visibility reads; a full `Machine` and its display projection both carry them. */
type MachineSelectionVisibilityFacts = Readonly<{
    kind?: Machine['kind'];
    revokedAt?: number | null;
    replacedByMachineId?: string | null;
    replacedAt?: unknown;
}>;

export function isMachineVisibleForSelection(machine: MachineSelectionVisibilityFacts): boolean {
    const revokedAt = machine.revokedAt;
    return isPersistentMachine(machine)
        && !(typeof revokedAt === 'number' && Number.isFinite(revokedAt) && revokedAt > 0);
}

export function isMachineVisibleForLaunchSelection(machine: MachineSelectionVisibilityFacts): boolean {
    return isMachineVisibleForSelection(machine) && !isMachineReplaced(machine);
}

type InventorySelection = Readonly<{
    visible: readonly MachineSelectionVisibilityFacts[];
    fleet: readonly MachineSelectionVisibilityFacts[];
}>;
const inventorySelections = new WeakMap<readonly MachineSelectionVisibilityFacts[], InventorySelection>();
const fleetRecordSelections = new WeakMap<object, readonly MachineSelectionVisibilityFacts[]>();

function selectInventory(machines: readonly MachineSelectionVisibilityFacts[]): InventorySelection {
    const previous = inventorySelections.get(machines);
    if (previous) return previous;
    const visible = [];
    const fleet = [];
    for (const machine of machines) {
        if (!isMachineVisibleForSelection(machine)) continue;
        visible.push(machine);
        if (!isMachineReplaced(machine)) fleet.push(machine);
    }
    const result = { visible: visible.length === machines.length ? machines : visible,
        fleet: fleet.length === machines.length ? machines : fleet };
    inventorySelections.set(machines, result);
    // Readers of the visible projection reuse its already-decided membership too.
    inventorySelections.set(result.visible, result);
    return result;
}

/** History-capable list selection; current fleet membership is decided in the same pass. */
export function selectVisibleMachineInventory<T extends MachineSelectionVisibilityFacts>(machines: readonly T[]): readonly T[] {
    // Both projections are subsets of the exact immutable input, preserving its row type.
    return selectInventory(machines).visible as readonly T[];
}

/** Current Home fleet, independent of presence and managed-record archive/display state. */
export function selectMachineFleet<T extends MachineSelectionVisibilityFacts>(machines: readonly T[]): readonly T[] {
    return selectInventory(machines).fleet as readonly T[];
}

/** Display-map readers share the same membership projection without rebuilding Object.values per reader. */
export function selectMachineFleetFromRecord<T extends MachineSelectionVisibilityFacts>(machines: Readonly<Record<string, T>>): readonly T[] {
    const previous = fleetRecordSelections.get(machines);
    if (previous) return previous as readonly T[];
    const selected = selectMachineFleet(Object.values(machines));
    fleetRecordSelections.set(machines, selected);
    return selected;
}

/** Work is proportional to Homes on repeat reads, never fleet size per surface. */
export function countMachineFleet(groups: readonly Readonly<{ machines: readonly MachineSelectionVisibilityFacts[] }>[]): number {
    return groups.reduce((count, group) => count + selectMachineFleet(group.machines).length, 0);
}
