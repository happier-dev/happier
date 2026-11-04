import type { ManagedMachineV1 } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import type { RetentionCapabilitiesV1 } from '@happier-dev/protocol/machines/managed/providerFactsV1';
import { t } from '@/text';
import { managedMachineOperationMatchesResource } from '@/sync/domains/actionOperations/managedMachineOperation';
import { describeManagedLifecycleState, type ManagedLifecycleState } from './managedLifecyclePresentation';
import type { ActionOperationProjection } from '@/sync/domains/actionOperations/actionOperationSelectors';
import { sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import { isRedundantManagedWakeIntentV1 } from '@happier-dev/protocol/machines/managed/resolveMachineRetentionPolicyV1';
import { machinePageHref } from '@/components/machines/page/machinePageHref';
import { resolveSystemTaskFailureMessage } from '@/components/systemTasks/resolveSystemTaskFailureMessage';
import { isManagedMachineResourceAbsent } from './managedMachineResource';
export { isManagedMachineResourceAbsent } from './managedMachineResource';

/**
 * The short cause the page says for a failed install, in the app's words; null when only the installer's own
 * message exists. That raw message (it can name commands and environment variables) stays behind Details.
 */
export function describeManagedInstallationFailure(
    error: NonNullable<ActionOperationProjection['snapshot']['error']>,
    progress: ActionOperationProjection['snapshot']['progress'],
): string | null {
    const details = error.details;
    const request = details && 'kind' in details && details.kind === 'managedControllerRequest' ? details : undefined;
    if (error.errorCode === 'database_connection_unavailable' || error.errorCode === 'database_transaction_conflict_exhausted'
        || request?.category === 'status' && (request.status ?? 0) >= 500) {
        return t('managedMachines.creation.homeRequestFailed');
    }
    if (error.errorCode === 'provider_unavailable' && progress?.kind === 'phase'
        && progress.phase === 'ssh.auth.wait') return t('managedMachines.creation.enrollmentUnavailable');
    return resolveSystemTaskFailureMessage({ code: error.errorCode, message: null }) ?? null;
}

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
    enrolledMachine?: Readonly<{ machineId: string; installationId: string; online: boolean; serviceManaged: boolean; activeAt?: number }>;
    provider?: string;
    providerAvailable?: boolean;
    operation?: ActionOperationProjection | null;
}>;

/** Allocation/enrollment facts are independent from the install task's observed stages. */
export function managedCreationState(machine: ManagedMachineV1, context: ManagedCreationContext = {}): ManagedLifecycleState {
    if (machine.allocation === 'confirmed-absent') return { kind: 'absent' };
    if (machine.cleanup) return machine.creationState === 'canceled' && machine.cleanup.disposition === 'pending'
        ? { kind: 'creationCanceledCleanup' } : { kind: 'cleanupUnknown' };
    if (machine.allocation === 'may-exist') {
        // A submitted create stays may-exist until the provider binds it; while its acquire last ran, it is being created.
        const acquire = currentManagedCreationOperation(machine, context.operation, context)?.snapshot;
        return acquire?.state === 'running' && (acquire.actionId === 'machines.managed.acquire' || acquire.actionId === 'machines.managed.bootstrap.retry')
            ? { kind: 'creating', name: machine.launch.name } : { kind: 'mayExist', name: machine.launch.name };
    }
    if (machine.observation?.availability === 'unavailable') return { kind: 'observationUnavailable' };
    if (machine.observation?.availability === 'absent') return { kind: 'absent' };
    if (machine.observation?.storage === 'lost') return { kind: 'volumeLost' };
    if (context.providerAvailable === false) return { kind: 'providerRemoved', provider: context.provider ?? t('common.machine') };
    const operation = currentManagedCreationOperation(machine, context.operation, context);
    if (operation?.observation === 'available' && !operation.isUnavailableProjection && operation.snapshot.state === 'failed'
        && operation.snapshot.error?.errorCode === 'credential_unavailable') return { kind: 'credentialRefused' };
    if (operation?.observation === 'available' && !operation.isUnavailableProjection && operation.snapshot.state === 'running') {
        switch (operation.snapshot.progress?.kind === 'phase' ? operation.snapshot.progress.phase : undefined) {
            case 'managed.intent.busy': return { kind: 'busy' };
            case 'managed.intent.activity-unknown': return { kind: 'activityUnknown' };
            case 'managed.intent.draining': return { kind: 'draining' };
        }
    }
    if (machine.submittedNativeEffect?.intent === 'delete') return { kind: 'cleanupPending' };
    if (machine.submittedNativeEffect?.intent === 'stop' && machine.observation?.power !== 'stopped') return { kind: 'stopPending' };
    // A committed Start whose native submission is unconfirmed has no submitted effect yet (QB118), but the
    // guest is still observed asleep: the request stands, so the page must not read as a machine at rest.
    const retainedPowerIntent = machine.desired === 'start' && machine.observation?.power === 'stopped' ? 'start'
        : machine.desired === 'resume' && machine.observation?.power === 'suspended' ? 'resume' : undefined;
    const pendingIntent = machine.submittedNativeEffect?.intent ?? retainedPowerIntent;
    if ((pendingIntent === 'start' || pendingIntent === 'resume') && machine.observation?.power !== 'running'
        || pendingIntent === 'suspend' && machine.observation?.power !== 'suspended') {
        return { kind: 'powerPending', provider: context.provider ?? t('common.machine'), state: t(`managedMachines.actions.${pendingIntent}`) };
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

/**
 * A created machine its provider reports stopped or suspended is offline because of that power state; its own
 * state row and receipt (Start) explain it, so the page must not say a second, vaguer "offline".
 */
export function managedPowerExplainsOffline(machine: Pick<ManagedMachineV1, 'creationState' | 'observation'> | undefined): boolean {
    const power = machine?.observation?.power;
    return machine?.creationState === 'active' && (power === 'stopped' || power === 'suspended');
}

/** Enrolled healthy resources use the observation row instead of repeating their creation state. */
export function isManagedCreationStateRowVisible(machine: Pick<ManagedMachineV1, 'enrolledMachineId'>, state: ManagedLifecycleState): boolean {
    return !machine.enrolledMachineId || state.kind !== 'resourceReady';
}

/**
 * The power actions a created machine's receipt offers: what its observed power allows. Stop also retracts
 * a retained Start that has not reached native power. An unenrolled resource Happier has not observed yet
 * (installing, failed install) offers none: Start beside Suspend would contradict itself. A provider that
 * observes a resource without reporting power keeps its explicit controls.
 */
export function managedReceiptPowerIntents(machine: Pick<ManagedMachineV1, 'observation' | 'desired' | 'enrolledMachineId'>,
    supportedIntents: RetentionCapabilitiesV1['supportedIntents']): ('start' | 'stop' | 'suspend' | 'resume')[] {
    const power = machine.observation?.power;
    if (!machine.enrolledMachineId && !machine.observation) return [];
    return supportedIntents.filter((intent): intent is 'start' | 'stop' | 'suspend' | 'resume' =>
        intent === 'start' || intent === 'stop' || intent === 'suspend' || intent === 'resume')
        .filter(intent => !(intent === 'stop' ? power === 'stopped' && machine.desired === 'stop'
            : intent === 'suspend' ? power === 'suspended' : power === 'running')
            && !((intent === 'start' || intent === 'resume') && isRedundantManagedWakeIntentV1(intent, power, supportedIntents)));
}

/** Retained unenrolled resources remain recoverable when controller history is lost. */
export function canRetryManagedInstallation(machine: ManagedMachineV1, operation?: ActionOperationProjection | null,
    context: Pick<ManagedCreationContext, 'providerAvailable' | 'enrolledMachine'> = {}): boolean {
    const lifecycle = managedCreationState(machine);
    if (context.providerAvailable === false || machine.creationState !== 'active' || machine.archivedAt !== undefined || machine.desired === 'delete'
        || machine.allocation !== 'bound' || !machine.resource || machine.cleanup
        || lifecycle.kind === 'cleanupPending' || lifecycle.kind === 'absent' || lifecycle.kind === 'volumeLost') return false;
    if (!operation) return !machine.enrolledMachineId;
    operation = currentManagedCreationOperation(machine, operation, context);
    if (!operation) return false;
    const snapshot = operation?.snapshot;
    // A refused native credential recovers through Reconnect, whichever operation reported it.
    if (snapshot.error?.errorCode === 'credential_unavailable') return false;
    // Power, retention and inspection operations can become the newest visible
    // receipt after a failed install. They do not enroll the retained resource
    // and must not erase its same-resource Retry install affordance.
    if (snapshot.actionId !== 'machines.managed.acquire'
        && snapshot.actionId !== 'machines.managed.bootstrap.retry') return !machine.enrolledMachineId;
    return operation?.observation === 'available' && !operation.isUnavailableProjection
        && snapshot?.state === 'failed'
        && (snapshot.actionId === 'machines.managed.acquire' || snapshot.actionId === 'machines.managed.bootstrap.retry')
        && snapshot.domainRef?.kind === 'managedMachine' && snapshot.domainRef.id === machine.id;
}

/** A replaced resource or installation cannot borrow a previous operation's observations. */
export function currentManagedCreationOperation(machine: ManagedMachineV1, operation?: ActionOperationProjection | null,
    context: Pick<ManagedCreationContext, 'enrolledMachine'> = {}): ActionOperationProjection | null {
    if (!operation) return null;
    const snapshot = operation.snapshot;
    const failedIdleObservation = snapshot.state === 'failed' && snapshot.actionId === 'machines.managed.power.set'
        && snapshot.progress?.kind === 'phase'
        && ['managed.intent.waiting-idle', 'managed.intent.activity-unknown', 'managed.intent.busy'].includes(snapshot.progress.phase)
        && ['managed_controller_request_failed', 'ECONNABORTED', 'admission_unavailable',
            'RPC_TRANSPORT_UNAVAILABLE', 'RPC_CLIENT_NOT_AVAILABLE'].includes(snapshot.error?.errorCode ?? '');
    // Confirmed removal supersedes an earlier failed request on this resource.
    // A superseded operation can fail after Delete observed absence. Compare
    // request admission, not settlement. A passive idle failure is obsolete
    // even if it raced the absence report; later actionable requests still
    // need attention. Activity retains the historical failure.
    if (machine.desired === 'delete' && machine.allocation === 'confirmed-absent'
        && machine.observation?.availability === 'absent' && snapshot.state === 'failed'
        && (snapshot.createdAt <= machine.observation.observedAt || failedIdleObservation)) return null;
    if (snapshot.domainRef?.kind === 'machineEnvironment') {
        const reference = snapshot.domainRef;
        const scopeMatches = snapshot.actionId === 'machines.environment.apply' && snapshot.scope.machineId === machine.enrolledMachineId
            || (snapshot.actionId === 'machines.managed.acquire' || snapshot.actionId === 'machines.managed.bootstrap.retry')
                && machine.controller !== undefined && snapshot.scope.machineId === machine.controller.machineId;
        return scopeMatches && reference.serverId === machine.homeId && reference.machineId === machine.enrolledMachineId
            && reference.managedId === machine.id && sameStrictJsonValue(reference.preset, machine.preset) ? operation : null;
    }
    if (!managedMachineOperationMatchesResource(machine, snapshot)) return null;
    const guest = context.enrolledMachine;
    const healthyEnrollment = machine.creationState === 'active' && machine.allocation === 'bound' && !machine.cleanup
        && machine.archivedAt === undefined && machine.desired !== 'delete'
        && guest && guest.machineId === machine.enrolledMachineId && guest.installationId && guest.online && guest.serviceManaged;
    const failureDetails = snapshot.error?.details;
    const controllerRequest = failureDetails && 'kind' in failureDetails && failureDetails.kind === 'managedControllerRequest'
        ? failureDetails : undefined;
    const failedAcquireConfirmation = snapshot.state === 'failed' && snapshot.actionId === 'machines.managed.acquire'
        && snapshot.error?.errorCode === 'managed_controller_request_failed'
        && controllerRequest?.path === '/v1/machines/managed/controller/current';
    // A failed inactivity read never admitted Stop/Delete. A newer connection
    // from this enrolled service supersedes that observation on the creation
    // card; Activity retains the actual failure. Explicit or submitted power
    // effects, credential failures and unavailable history remain actionable.
    if (healthyEnrollment && !machine.submittedNativeEffect && (machine.desired === 'start' || machine.desired === 'resume')
        && machine.observation?.availability !== 'absent' && machine.observation?.availability !== 'unavailable'
        && machine.observation?.storage !== 'lost' && machine.observation?.power !== 'stopped' && machine.observation?.power !== 'suspended'
        && operation.observation === 'available' && !operation.isUnavailableProjection && failedIdleObservation
        && snapshot.settledAt !== undefined && guest.activeAt !== undefined && guest.activeAt > snapshot.settledAt) return null;
    // Acquire owns initial enrollment. Once its exact bound service is online,
    // that live fact supersedes only a late controller-current confirmation
    // failure; bootstrap retries and genuine setup failures remain actionable.
    if (healthyEnrollment && operation.observation === 'available' && !operation.isUnavailableProjection
        && failedAcquireConfirmation) return null;
    // Existing 0.3 installation operations stored this CLI activation refusal as
    // action_failed. The enrolled guest's current connection resolves only that
    // readiness failure; unrelated bootstrap/setup failures remain actionable.
    if (healthyEnrollment
        && operation.observation === 'available' && !operation.isUnavailableProjection && snapshot.state === 'failed'
        && (snapshot.actionId === 'machines.managed.acquire' || snapshot.actionId === 'machines.managed.bootstrap.retry')
        && snapshot.error?.errorCode === 'action_failed'
        && snapshot.error.error.startsWith('Background service install completed, but the expected background service did not become the active daemon for the selected Home within ')) return null;
    return operation;
}

/** The installer task's open sign-in consent, while its operation still runs; the add flow asks the same task kind the same way. */
export function readManagedInstallationPrompt(operation: ActionOperationProjection | null | undefined) {
    const snapshot = operation?.snapshot;
    if (!snapshot || snapshot.state !== 'running' || operation.observation !== 'available' || operation.isUnavailableProjection
        || snapshot.domainRef?.kind !== 'managedMachine' || !snapshot.domainRef.bootstrapTask) return null;
    const { prompt, id } = snapshot.domainRef.bootstrapTask;
    return prompt?.kind === 'auth.approveRemoteProvisioning' ? { ...prompt, taskId: id } : null;
}

/** A durable managed deep link becomes an ordinary Machine destination only after verified binding. */
export function managedMachineDestination(machine: ManagedMachineV1, serverId: string): string | null {
    return machine.enrolledMachineId
        ? machinePageHref({ door: 'rail', target: { machineId: machine.enrolledMachineId, serverId } })
        : null;
}
