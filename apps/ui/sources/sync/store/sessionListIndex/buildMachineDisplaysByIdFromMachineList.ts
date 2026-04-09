import type { MachineDisplayRenderable } from '@/sync/domains/machines/machineDisplayRenderable';
import { buildMachineDisplayRenderableFromMachine } from '@/sync/domains/machines/machineDisplayRenderable';
import type { Machine } from '@/sync/domains/state/storageTypes';

export function buildMachineDisplaysByIdFromMachineList(
    machines: ReadonlyArray<Machine> | null | undefined,
): Record<string, MachineDisplayRenderable> {
    const out: Record<string, MachineDisplayRenderable> = {};
    if (!Array.isArray(machines)) {
        return out;
    }
    for (const machine of machines) {
        out[machine.id] = buildMachineDisplayRenderableFromMachine(machine);
    }
    return out;
}
