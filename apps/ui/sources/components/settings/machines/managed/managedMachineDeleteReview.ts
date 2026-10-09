import { ManagedDeleteInputV1Schema, type ManagedMachineActionInputV1 } from '@happier-dev/protocol/machines/managed/actionsV1';
import type { ManagedMachineV1 } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import { MachineReferenceCensusV1Schema, type MachineReferenceCensusV1 } from '@happier-dev/protocol/machines/machineReferenceCensusV1';
import { sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';

export type ManagedMachineDeleteReview = Readonly<{ machine: ManagedMachineV1; census: MachineReferenceCensusV1 }>;

/** Both the detail page and composer disclose references to the exact retained row before Delete. */
export function qualifyManagedMachineDeleteReview(machine: ManagedMachineV1, result: unknown): ManagedMachineDeleteReview | null {
    const parsed = MachineReferenceCensusV1Schema.safeParse(result);
    if (!parsed.success || parsed.data.homeId !== machine.homeId
        || parsed.data.machineId !== null && parsed.data.machineId !== machine.enrolledMachineId) return null;
    return { machine, census: parsed.data };
}

function reviewedTarget(machine: ManagedMachineV1) {
    return { homeId: machine.homeId, managedId: machine.id, intentRevision: machine.intentRevision,
        controller: machine.controller, resource: machine.resource, enrolledMachineId: machine.enrolledMachineId,
        allocation: machine.allocation, creationState: machine.creationState, archivedAt: machine.archivedAt };
}

/** A changed target or intent needs a new human review; never silently move a reviewed Delete. */
export function buildReviewedManagedMachineDeleteInput(
    machine: ManagedMachineV1, review: ManagedMachineDeleteReview,
): ManagedMachineActionInputV1<'machines.managed.delete'> | null {
    if (!sameStrictJsonValue(reviewedTarget(machine), reviewedTarget(review.machine))
        || !qualifyManagedMachineDeleteReview(machine, review.census)) return null;
    return ManagedDeleteInputV1Schema.parse({ homeId: machine.homeId, managedId: machine.id,
        when: 'now', expectedRevision: machine.intentRevision, intent: 'delete', reviewedDependencies: true });
}
