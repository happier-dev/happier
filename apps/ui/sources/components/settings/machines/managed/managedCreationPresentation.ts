import type { ManagedMachineV1 } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import { t } from '@/text';
import { describeManagedLifecycleState, type ManagedLifecycleState } from './managedLifecyclePresentation';
import type { ActionOperationProjection } from '@/sync/domains/actionOperations/actionOperationSelectors';
import { sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';

/** Allocation/enrollment facts are independent from the install task's observed stages. */
export function managedCreationState(machine: ManagedMachineV1): ManagedLifecycleState {
    if (machine.allocation === 'confirmed-absent') return { kind: 'absent' };
    if (machine.cleanup) return machine.creationState === 'canceled' && machine.cleanup.disposition === 'pending'
        ? { kind: 'creationCanceledCleanup' } : { kind: 'cleanupUnknown' };
    if (machine.allocation === 'may-exist') return { kind: 'mayExist', name: machine.launch.name };
    if (machine.observation?.availability === 'unavailable') return { kind: 'observationUnavailable' };
    if (machine.observation?.availability === 'absent') return { kind: 'absent' };
    if (machine.observation?.storage === 'lost') return { kind: 'volumeLost' };
    if (machine.submittedNativeEffect?.intent === 'delete') return { kind: 'cleanupPending' };
    if (machine.submittedNativeEffect?.intent === 'stop' && machine.observation?.power !== 'stopped') return { kind: 'stopPending' };
    const pendingIntent = machine.submittedNativeEffect?.intent;
    if ((pendingIntent === 'start' || pendingIntent === 'resume') && machine.observation?.power !== 'running'
        || pendingIntent === 'suspend' && machine.observation?.power !== 'suspended') {
        return { kind: 'powerPending', provider: t('common.unknown'), state: t(`managedMachines.actions.${pendingIntent}`) };
    }
    if (machine.observation?.power === 'stopped') return machine.observation.storage === 'retained'
        ? { kind: 'stoppedStorage' } : { kind: 'storageUnknown' };
    return machine.allocation === 'unsubmitted' ? { kind: 'creationWaiting', name: machine.launch.name } : { kind: 'resourceReady' };
}

export function describeManagedCreation(machine: ManagedMachineV1) {
    return describeManagedLifecycleState(managedCreationState(machine));
}

/** Installation and boot recovery follow the correlated host operation's failure. */
export function canRetryManagedInstallation(machine: ManagedMachineV1, operation?: ActionOperationProjection | null): boolean {
    operation = currentManagedCreationOperation(machine, operation);
    const snapshot = operation?.snapshot;
    const lifecycle = managedCreationState(machine);
    return operation?.observation === 'available' && !operation.isUnavailableProjection
        && machine.creationState === 'active'
        && machine.allocation === 'bound' && Boolean(machine.resource) && !machine.cleanup
        && lifecycle.kind !== 'cleanupPending' && lifecycle.kind !== 'absent' && lifecycle.kind !== 'volumeLost'
        && snapshot?.state === 'failed' && snapshot.scope.machineId === machine.controller.machineId
        && snapshot.domainRef?.kind === 'managedMachine' && snapshot.domainRef.id === machine.id;
}

/** A replaced resource or installation cannot borrow a previous operation's observations. */
export function currentManagedCreationOperation(machine: ManagedMachineV1, operation?: ActionOperationProjection | null): ActionOperationProjection | null {
    if (!operation) return null;
    const snapshot = operation.snapshot;
    if (snapshot.scope.machineId !== machine.controller.machineId
        || snapshot.domainRef?.kind !== 'managedMachine' || snapshot.domainRef.id !== machine.id) return null;
    const reference = snapshot.domainRef;
    if (reference.resource || reference.controller) return reference.resource && reference.controller
        && sameStrictJsonValue(reference.resource, machine.resource)
        && sameStrictJsonValue(reference.controller, machine.controller) ? operation : null;
    return machine.allocation === 'unsubmitted' || machine.allocation === 'may-exist' ? operation : null;
}

/** A durable managed deep link becomes an ordinary Machine destination only after verified binding. */
export function managedMachineDestination(machine: ManagedMachineV1, serverId: string): string | null {
    return machine.enrolledMachineId
        ? `/machine/${encodeURIComponent(machine.enrolledMachineId)}?serverId=${encodeURIComponent(serverId)}`
        : null;
}
