import type { ActionOperationSnapshotV1 } from '../../actions/operations/v1.js';
import type { ManagedMachineReadSnapshotV1 } from './managedMachineV1.js';
import { sameStrictJsonValue } from '../../json/strictJsonValue.js';

/** A moved controller or replaced resource cannot borrow an earlier creation's task. */
export function managedMachineOperationMatchesResource(machine: ManagedMachineReadSnapshotV1, snapshot: ActionOperationSnapshotV1): boolean {
    // Foreground Account acquisition has no Machine operation. A retained
    // controller operation must not become its installation progress.
    if (!machine.controller || snapshot.scope.machineId !== machine.controller.machineId
        || snapshot.domainRef?.kind !== 'managedMachine' || snapshot.domainRef.id !== machine.id) return false;
    const reference = snapshot.domainRef;
    return reference.resource || reference.controller ? Boolean(reference.resource && reference.controller
        && sameStrictJsonValue(reference.resource, machine.resource)
        && sameStrictJsonValue(reference.controller, machine.controller))
        : machine.allocation === 'unsubmitted' || machine.allocation === 'may-exist'
            // A rejected purchase never bound a native resource. Its terminal acquire still explains that absence.
            || machine.allocation === 'confirmed-absent' && !machine.resource
                && snapshot.actionId === 'machines.managed.acquire' && snapshot.state === 'failed';
}

/** Only the current unanswered installer question can be displayed or answered. */
export function readManagedInstallationPromptSnapshot(snapshot: ActionOperationSnapshotV1) {
    if (snapshot.state !== 'running' || snapshot.domainRef?.kind !== 'managedMachine') return null;
    const task = snapshot.domainRef.bootstrapTask;
    return task?.prompt ? { ...task.prompt, taskId: task.id } : null;
}
