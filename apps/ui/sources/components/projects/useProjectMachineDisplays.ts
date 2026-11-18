import { useMachineDisplayById, type useActiveMachineFacts } from '@/sync/domains/state/storage';
import { isMachineDisplayHydrating } from '@/utils/sessions/machineDisplayNames';

/**
 * The Machines a Project surface names (the Projects tree, the Project's Machine chip): a Machine whose content is still
 * opening reads through the display metadata already known for it, so every Project surface hydrates names the same way.
 * Pass the Machine facts the caller already holds; the result keeps its identity while no element changes.
 */
export function useProjectMachineDisplays(machines: ReturnType<typeof useActiveMachineFacts>) {
    return useMachineDisplayById(displays => machines.map(machine =>
        isMachineDisplayHydrating(machine) ? displays[machine.id] ?? machine : machine));
}
