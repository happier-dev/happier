import { selectVisibleMachineInventory } from '@/sync/domains/machines/identity/filterVisibleMachines';
import type { Machine } from '@/sync/domains/state/storageTypes';
import { resolveSettledMachineDisplayNames } from '@/utils/sessions/machineDisplayNames';

/** Machine names that an input can use to identify a Project. */
export function selectProjectChoiceMachineNames(machines: readonly Machine[]): ReadonlyMap<string, string> {
    return resolveSettledMachineDisplayNames(selectVisibleMachineInventory(machines));
}
