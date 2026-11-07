import { classifyManagedMachineAllocationV1, type ManagedMachineV1 } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import { resolveManagedConfigurationCost } from '@happier-dev/protocol/machines/managed/managedConfigurationV1';
import type { RetentionCapabilitiesV1 } from '@happier-dev/protocol/machines/managed/providerFactsV1';
import { t } from '@/text';
import { describeManagedLifecycleState, type ManagedLifecycleState } from './managedLifecyclePresentation';
import type { ActionOperationProjection } from '@/sync/domains/actionOperations/actionOperationSelectors';
import { sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import { isRedundantManagedWakeIntentV1 } from '@happier-dev/protocol/machines/managed/resolveMachineRetentionPolicyV1';
import { resolveSystemTaskFailureMessage } from '@/components/systemTasks/resolveSystemTaskFailureMessage';
import { managedMachineOperationMatchesResource, readManagedInstallationPromptSnapshot } from '@/sync/domains/actionOperations/managedMachineOperation';
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
        || error.errorCode === 'database_transaction_timeout'
        || request?.category === 'status' && (request.status ?? 0) >= 500) {
        return t('managedMachines.creation.homeRequestFailed');
    }
    if (error.errorCode === 'provider_unavailable' && progress?.kind === 'phase'
        && progress.phase === 'ssh.auth.wait') return t('managedMachines.creation.enrollmentUnavailable');
    // A refusal outside the typed controller codes reaches the executor's result as `action_failed` with its code as the message.
    const code = error.errorCode === 'action_failed' ? error.error : error.errorCode;
    return resolveSystemTaskFailureMessage({ code, message: null }) ?? null;
}

/** Setup is observed on the admitted row; Join alone cannot complete this stage. */
export function managedCreationSetup(machine: ManagedMachineV1) {
    const setup = machine.machineSetup;
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

/** A request canceled before any resource was bound never made anything: it did not end, it never began. */
export function isManagedCreationCanceledBeforeMade(machine: Pick<ManagedMachineV1, 'allocation' | 'creationState' | 'resource'>): boolean {
    return machine.allocation === 'confirmed-absent' && managedConfirmedAbsenceState(machine).kind === 'creationCanceled';
}

/** Confirmed absence keeps the distinction between a retained native identity and a never-bound creation. */
export function managedConfirmedAbsenceState(machine: Pick<ManagedMachineV1, 'resource'> & Partial<Pick<ManagedMachineV1, 'creationState'>>): ManagedLifecycleState {
    return machine.resource ? { kind: 'absent' } : machine.creationState === 'canceled'
        ? { kind: 'creationCanceled' } : { kind: 'notCreated' };
}

/** Allocation/enrollment facts are independent from the install task's observed stages. */
export function managedCreationState(machine: ManagedMachineV1, context: ManagedCreationContext = {}): ManagedLifecycleState {
    if (machine.allocation === 'confirmed-absent') return managedConfirmedAbsenceState(machine);
    if (machine.cleanup) return machine.creationState === 'canceled' && machine.cleanup.disposition === 'pending'
        ? { kind: 'creationCanceledCleanup' } : { kind: 'cleanupUnknown' };
    if (machine.allocation === 'may-exist') {
        const operation = currentManagedCreationOperation(machine, context.operation, context);
        const acquire = operation?.observation === 'available' && !operation.isUnavailableProjection
            ? operation.snapshot : undefined;
        return classifyManagedMachineAllocationV1(machine, acquire) === 'creating'
            ? { kind: 'creating', name: machine.launch.name } : { kind: 'mayExist', name: machine.launch.name };
    }
    if (machine.observation?.availability === 'unavailable') return { kind: 'observationUnavailable' };
    if (isManagedMachineResourceAbsent(machine)) return { kind: 'absent' };
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
    if (machine.submittedNativeEffect?.intent === 'delete') return { kind: 'cleanupPending',
        cost: resolveManagedConfigurationCost({ ...machine.reviewedFacts, provider: context.provider ?? null }) };
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

/** Enrollment is historical; the ordinary detail exists only after the canonical Machine projection arrives. */
export function managedMachineEnrolledDetailId(machine: ManagedMachineV1, enrolledMachinePresent: boolean): string | undefined {
    return enrolledMachinePresent && machine.archivedAt === undefined && !isManagedMachineResourceAbsent(machine) ? machine.enrolledMachineId : undefined;
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
    supportedIntents: RetentionCapabilitiesV1['supportedIntents'],
    enrolledMachine?: Readonly<{ machineId: string; online: boolean }>): ('start' | 'stop' | 'suspend' | 'resume')[] {
    const power = enrolledMachine?.machineId === machine.enrolledMachineId && enrolledMachine?.online
        ? 'running' : machine.observation?.power;
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

/**
 * "Setup interrupted" (58b L4): the provider made the resource, it never joined, and nothing is installing it now.
 * Recorded facts only, for a creation with no operation to report (the app did the work and was closed, or its
 * history is gone): leaving the app is never read as a pause, and an observed failure stays "install failed".
 * Continue setup acts on this same resource, which `canRetryManagedInstallation` already admits.
 */
export function isManagedCreationInterrupted(machine: ManagedMachineV1): boolean {
    return !machine.enrolledMachineId && canRetryManagedInstallation(machine);
}

export type ManagedCreationStage = Readonly<{
    id: 'create' | 'install' | 'join';
    state: 'done' | 'running' | 'upcoming';
    /** What the row cannot confirm once nothing runs it: an unrecorded install, or a join that never came. */
    note?: 'notConfirmed' | 'notJoined';
}>;

/**
 * Create, Install and Join from the row's recorded facts (58B-U1): a bound resource is created,
 * `bootstrapInstalled` (or a join) proves the install, `enrolledMachineId` the join. A step is current
 * only while this device runs the recipe; otherwise a missing fact stays unknown, never guessed.
 */
export function managedCreationStages(
    machine: Pick<ManagedMachineV1, 'allocation' | 'resource' | 'bootstrapInstalled' | 'enrolledMachineId'> | undefined,
    running: boolean,
): readonly ManagedCreationStage[] {
    const created = machine?.allocation === 'bound' && Boolean(machine.resource);
    const joined = Boolean(machine?.enrolledMachineId);
    const installed = joined || machine?.bootstrapInstalled === true;
    return [
        { id: 'create', state: created ? 'done' : running ? 'running' : 'upcoming' },
        installed ? { id: 'install', state: 'done' } : !created ? { id: 'install', state: 'upcoming' }
            : running ? { id: 'install', state: 'running' } : { id: 'install', state: 'upcoming', note: 'notConfirmed' },
        joined ? { id: 'join', state: 'done' } : !installed ? { id: 'join', state: 'upcoming' }
            : running ? { id: 'join', state: 'running' } : { id: 'join', state: 'upcoming', note: 'notJoined' },
    ];
}

/** A replaced resource or installation cannot borrow a previous operation's observations. */
export function currentManagedCreationOperation(machine: ManagedMachineV1, operation?: ActionOperationProjection | null,
    context: Pick<ManagedCreationContext, 'enrolledMachine'> = {}): ActionOperationProjection | null {
    if (!operation) return null;
    const snapshot = operation.snapshot;
    // Keep's idle wait is not an installation. Failed retention work still carries its diagnostic.
    if (snapshot.actionId === 'machines.managed.power.set' && snapshot.state === 'running'
        && snapshot.progress?.kind === 'phase' && snapshot.progress.phase === 'managed.intent.waiting-idle') return null;
    const failedIdleObservation = snapshot.state === 'failed' && snapshot.actionId === 'machines.managed.power.set'
        && snapshot.progress?.kind === 'phase'
        && ['managed.intent.waiting-idle', 'managed.intent.activity-unknown', 'managed.intent.busy'].includes(snapshot.progress.phase)
        && ['managed_controller_request_failed', 'ECONNABORTED', 'admission_unavailable',
            'RPC_TRANSPORT_UNAVAILABLE', 'RPC_CLIENT_NOT_AVAILABLE'].includes(snapshot.error?.errorCode ?? '');
    // Confirmed removal supersedes an earlier failed request on this resource.
    // A superseded operation can fail after Delete observed absence. Compare
    // request admission, not settlement. A passive idle failure is obsolete
    // even if it raced the absence report; later actionable requests still
    // need attention. Cancellation before submission has no native observation;
    // its confirmed absence supersedes the failed creation. Activity retains it.
    if (machine.desired === 'delete' && machine.allocation === 'confirmed-absent'
        && snapshot.state === 'failed'
        && (machine.creationState === 'canceled'
            && (snapshot.actionId === 'machines.managed.acquire' || snapshot.actionId === 'machines.managed.bootstrap.retry')
            || machine.observation?.availability === 'absent'
                && (snapshot.createdAt <= machine.observation.observedAt || failedIdleObservation))) return null;
    if (snapshot.domainRef?.kind === 'machineSetup') {
        const reference = snapshot.domainRef;
        const scopeMatches = snapshot.actionId === 'machines.setup.apply' && snapshot.scope.machineId === machine.enrolledMachineId
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
    if (!snapshot || operation.observation !== 'available' || operation.isUnavailableProjection) return null;
    return readManagedInstallationPromptSnapshot(snapshot);
}
