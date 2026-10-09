import type { ManagedMachineV1 } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import { t } from '@/text';
import { describeManagedLifecycleState, type ManagedLifecycleState } from './managedLifecyclePresentation';
import type { ActionOperationProjection } from '@/sync/domains/actionOperations/actionOperationSelectors';
import { sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';

/** Setup is observed on the admitted row; Join alone cannot complete this stage. */
export function managedCreationSetup(machine: ManagedMachineV1) {
    const setup = machine.environmentSetup;
    if (!setup || !machine.enrolledMachineId) return null;
    const canRecover = setup.state === 'failed' && machine.creationState === 'active'
        && machine.allocation === 'bound' && Boolean(machine.resource) && !machine.cleanup;
    const recoveryActions: readonly ('retrySetup' | 'continueWithoutSetup' | 'delete')[] = canRecover
        ? ['retrySetup', 'continueWithoutSetup', 'delete'] : [];
    return { ...setup, recoveryActions };
}

/** What the page knows beside the row: the controller's name and presence, and the provider's display name. */
export type ManagedCreationContext = Readonly<{
    controller?: Readonly<{ name: string; online: boolean }>;
    provider?: string;
}>;

/** Allocation/enrollment facts are independent from the install task's observed stages. */
export function managedCreationState(machine: ManagedMachineV1, context: ManagedCreationContext = {}): ManagedLifecycleState {
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
        return { kind: 'powerPending', provider: context.provider ?? t('common.unknown'), state: t(`managedMachines.actions.${pendingIntent}`) };
    }
    if (machine.observation?.power === 'stopped') return machine.observation.storage === 'retained'
        ? { kind: 'stoppedStorage' } : { kind: 'storageUnknown' };
    if (machine.allocation !== 'unsubmitted') return { kind: 'resourceReady' };
    // Provider calls run where the account lives: an offline controller is what nothing waits on but the user.
    return context.controller && !context.controller.online && context.provider
        ? { kind: 'controllerWaiting', name: machine.launch.name, controller: context.controller.name, provider: context.provider }
        : { kind: 'creationWaiting', name: machine.launch.name };
}

export function describeManagedCreation(machine: ManagedMachineV1, context?: ManagedCreationContext) {
    return describeManagedLifecycleState(managedCreationState(machine, context));
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
    if (snapshot.domainRef?.kind === 'machineEnvironment') {
        const reference = snapshot.domainRef;
        const scopeMatches = snapshot.actionId === 'machines.environment.apply' && snapshot.scope.machineId === machine.enrolledMachineId
            || (snapshot.actionId === 'machines.managed.acquire' || snapshot.actionId === 'machines.managed.bootstrap.retry')
                && snapshot.scope.machineId === machine.controller.machineId;
        return scopeMatches && reference.serverId === machine.homeId && reference.machineId === machine.enrolledMachineId
            && reference.managedId === machine.id && sameStrictJsonValue(reference.preset, machine.preset) ? operation : null;
    }
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
