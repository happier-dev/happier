import type { ManagedControllerV1, ManagedMachineV1 } from '@happier-dev/protocol/machines/managed/managedMachineV1';

/** The admission owner identifies local resources; retention decides only their lifetime. */
export function managedMachineSandboxController(machine: ManagedMachineV1): ManagedControllerV1 | null {
    return machine.acquisitionMode === 'resource-bound' ? machine.controller ?? null : null;
}

export function selectHostMachineSandboxes(machines: readonly ManagedMachineV1[], controller: ManagedControllerV1): readonly ManagedMachineV1[] {
    return machines.filter(machine => {
        const host = managedMachineSandboxController(machine);
        return host?.machineId === controller.machineId && host.installationId === controller.installationId;
    });
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
