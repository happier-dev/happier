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

export function filterVisibleMachinesForLaunchSelection(machines: ReadonlyArray<Machine>): Machine[] {
    return machines.filter(isMachineVisibleForLaunchSelection);
}
