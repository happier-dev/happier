import type { ManagedControllerV1, ManagedMachineV1 } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import { isManagedMachineResourceAbsent } from './managedMachineResource';

/** The admission owner identifies local resources; retention decides only their lifetime. */
export function managedMachineSandboxController(machine: ManagedMachineV1): ManagedControllerV1 | null {
    return machine.acquisitionMode === 'resource-bound' ? machine.controller ?? null : null;
}

function isManagedMachineSandboxOnHost(machine: ManagedMachineV1, controller: ManagedControllerV1): boolean {
    const host = managedMachineSandboxController(machine);
    return host?.machineId === controller.machineId && host.installationId === controller.installationId;
}

export function selectHostMachineSandboxes(machines: readonly ManagedMachineV1[], controller: ManagedControllerV1): readonly ManagedMachineV1[] {
    return machines.filter(machine => machine.archivedAt === undefined && isManagedMachineSandboxOnHost(machine, controller));
}

function hostKey(controller: ManagedControllerV1): string {
    return JSON.stringify([controller.machineId, controller.installationId]);
}

/** One inventory pass supplies every host row; retained Session sandboxes and kept sandboxes both count. */
export function projectHostMachineSandboxCounts(machines: readonly ManagedMachineV1[]): ReadonlyMap<string, number> {
    const counts = new Map<string, number>();
    for (const machine of machines) {
        const controller = managedMachineSandboxController(machine);
        if (!controller || machine.archivedAt !== undefined) continue;
        const key = hostKey(controller);
        counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return counts;
}

export function readHostMachineSandboxCount(counts: ReadonlyMap<string, number>, controller: ManagedControllerV1): number {
    return counts.get(hostKey(controller)) ?? 0;
}

/** One pass over an admitted Home inventory. A controller selects its local sandboxes; otherwise count Machines. */
export function projectManagedPresetAllocationCounts(machines: readonly ManagedMachineV1[],
    controller?: ManagedControllerV1): ReadonlyMap<string, Readonly<{ allocated: number; running: number; powerUnknown: boolean }>> {
    const counts = new Map<string, { allocated: number; running: number; powerUnknown: boolean }>();
    for (const machine of machines) {
        if (!machine.preset || machine.archivedAt !== undefined || machine.creationState !== 'active'
            || machine.allocation !== 'bound' || isManagedMachineResourceAbsent(machine)) continue;
        if (controller ? !isManagedMachineSandboxOnHost(machine, controller) : machine.acquisitionMode === 'resource-bound') continue;

        const presetId = machine.preset.id;
        const count = counts.get(presetId) ?? { allocated: 0, running: 0, powerUnknown: false };
        count.allocated += 1;
        const power = machine.observation?.power;
        if (power === 'running') count.running += 1;
        if (!power || power === 'unknown') count.powerUnknown = true;
        counts.set(presetId, count);
    }
    return counts;
}
