import type { ActionOperationSnapshotV1 } from '@happier-dev/protocol/actions/operations/v1';
import { isManagedOpaquePresetMachineV1, type ManagedMachineReadSnapshotV1 } from '@happier-dev/protocol/machines/managed/managedMachineV1';

/** Enrollment can precede bootstrap completion; its producer retains bootstrap.<failure code> after failure. */
export function isManagedMachineBootstrapIncomplete(machine: ManagedMachineReadSnapshotV1): boolean {
    return !isManagedOpaquePresetMachineV1(machine) && machine.observation?.reason?.startsWith('bootstrap.') === true;
}

/** Waiting for idle has not submitted the retention effect. Activity keeps this operation's receipt. */
export function isManagedMachineRetentionWaitOperation(snapshot: ActionOperationSnapshotV1): boolean {
    return snapshot.actionId === 'machines.managed.power.set' && snapshot.progress?.kind === 'phase'
        && ['managed.intent.waiting-idle', 'managed.intent.busy', 'managed.intent.activity-unknown'].includes(snapshot.progress.phase);
}

export { managedMachineOperationMatchesResource, readManagedInstallationPromptSnapshot } from '@happier-dev/protocol/machines/managed/installationPrompt';
