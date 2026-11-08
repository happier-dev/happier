import type { ActionOperationSnapshotV1 } from '@happier-dev/protocol/actions/operations/v1';
import type { ManagedMachineV1 } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import { sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';

/** Enrollment can precede the installer's final confirmation; joining alone does not complete bootstrap. */
export function isManagedMachineBootstrapIncomplete(machine: ManagedMachineV1): boolean {
    return machine.observation?.reason === 'bootstrap.incomplete';
}

/** Waiting for idle has not submitted the retention effect. Activity keeps this operation's receipt. */
export function isManagedMachineRetentionWaitOperation(snapshot: ActionOperationSnapshotV1): boolean {
    return snapshot.actionId === 'machines.managed.power.set' && snapshot.progress?.kind === 'phase'
        && ['managed.intent.waiting-idle', 'managed.intent.busy', 'managed.intent.activity-unknown'].includes(snapshot.progress.phase);
}

/** A moved controller or replaced resource cannot borrow an earlier creation's task. */
export function managedMachineOperationMatchesResource(machine: ManagedMachineV1, snapshot: ActionOperationSnapshotV1): boolean {
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
