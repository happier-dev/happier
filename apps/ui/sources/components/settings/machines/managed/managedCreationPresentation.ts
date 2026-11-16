import { classifyManagedMachineAllocationV1, type ManagedMachineReadSnapshotV1 } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import { resolveManagedConfigurationCost } from '@happier-dev/protocol/machines/managed/managedConfigurationV1';
import type { RetentionCapabilitiesV1 } from '@happier-dev/protocol/machines/managed/providerFactsV1';
import { t } from '@/text';
import { describeManagedLifecycleState, type ManagedLifecycleState } from './managedLifecyclePresentation';
import type { ActionOperationProjection } from '@/sync/domains/actionOperations/actionOperationSelectors';
import type { ManagedAsleepWake } from '@/sync/domains/pending/managedWakeProjection';
import { sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import { resolveMachineWakeNativeIntentV1, resolveManagedMachinePendingPowerIntentV1 } from '@happier-dev/protocol/machines/managed/resolveMachineRetentionPolicyV1';
import { resolveSystemTaskFailureMessage } from '@/components/systemTasks/resolveSystemTaskFailureMessage';
import { resolveActionExecutionFailureMessage } from '@/sync/ops/actions/resolveActionExecutionFailureMessage';
import { isManagedMachineBootstrapIncomplete, isManagedMachineRetentionWaitOperation, managedMachineOperationMatchesResource, readManagedInstallationPromptSnapshot } from '@/sync/domains/actionOperations/managedMachineOperation';
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
    return resolveActionExecutionFailureMessage({ ok: false, errorCode: error.errorCode, details, failureCause: error.failureCause },
        resolveSystemTaskFailureMessage({ code, message: null, details }) ?? '') || null;
}

/** Setup is observed on the admitted row; Join alone cannot complete this stage. */
export function managedCreationSetup(machine: ManagedMachineReadSnapshotV1) {
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
    /** The controller has a newer guest payload than the enrolled guest reports. */
    guestPayloadStale?: boolean;
    /** Canonical presence supplied by the enrolled Machine page; null is unanswered. */
    guestOnline?: boolean | null;
    /** What starts this machine again once asleep (the wake owner's answer), said on its state row. */
    asleepWake?: ManagedAsleepWake;
}>;

/** Compare the two identities already published by the controller and enrolled guest. */
export function isManagedGuestPayloadStale(input: Readonly<{ installedVersion?: string | null; payloadVersion?: string | null }>): boolean {
    const installed = typeof input.installedVersion === 'string' ? input.installedVersion.trim() : '';
    const payload = typeof input.payloadVersion === 'string' ? input.payloadVersion.trim() : '';
    return Boolean(installed && payload && installed !== payload);
}

/** A request canceled before any resource was bound never made anything: it did not end, it never began. */
export function isManagedCreationCanceledBeforeMade(machine: Pick<ManagedMachineReadSnapshotV1, 'allocation' | 'creationState' | 'resource'>): boolean {
    return machine.allocation === 'confirmed-absent' && managedConfirmedAbsenceState(machine).kind === 'creationCanceled';
}

/** Confirmed absence keeps the distinction between a retained native identity and a never-bound creation. */
export function managedConfirmedAbsenceState(machine: Pick<ManagedMachineReadSnapshotV1, 'resource'> & Partial<Pick<ManagedMachineReadSnapshotV1, 'creationState'>>): ManagedLifecycleState {
    return machine.resource ? { kind: 'absent' } : machine.creationState === 'canceled'
        ? { kind: 'creationCanceled' } : { kind: 'notCreated' };
}

/** Allocation/enrollment facts are independent from the install task's observed stages. */
export function managedCreationState(machine: ManagedMachineReadSnapshotV1, context: ManagedCreationContext = {}): ManagedLifecycleState {
    const name = machine.launch?.name ?? t('common.machine');
    if (machine.allocation === 'confirmed-absent') return managedConfirmedAbsenceState(machine);
    if (machine.cleanup) return machine.creationState === 'canceled' && machine.cleanup.disposition === 'pending'
        ? { kind: 'creationCanceledCleanup' } : { kind: 'cleanupUnknown' };
    if (machine.allocation === 'may-exist') {
        const operation = currentManagedCreationOperation(machine, context.operation, context);
        const acquire = operation?.observation === 'available' && !operation.isUnavailableProjection
            ? operation.snapshot : undefined;
        return classifyManagedMachineAllocationV1(machine, acquire) === 'creating'
            ? { kind: 'creating', name } : { kind: 'mayExist', name };
    }
    const operation = currentManagedCreationOperation(machine, context.operation, context);
    const observedOperation = operation?.observation === 'available' && !operation.isUnavailableProjection ? operation.snapshot : null;
    const credentialRefused = observedOperation?.state === 'failed' && observedOperation.error?.errorCode === 'credential_unavailable';
    if (machine.observation?.availability === 'unavailable') {
        // Bootstrap retains its typed failure on the resource when operation history is unavailable.
        // A newer native read failure still owns the unavailable state.
        if (isManagedMachineBootstrapIncomplete(machine)) {
            if (context.providerAvailable === false) return { kind: 'providerRemoved', provider: context.provider ?? t('common.machine') };
            if (credentialRefused || !observedOperation && 'reason' in machine.observation
                && machine.observation.reason === 'bootstrap.credential_unavailable') {
                return { kind: 'credentialRefused' };
            }
        }
        return { kind: 'observationUnavailable' };
    }
    if (isManagedMachineResourceAbsent(machine)) return { kind: 'absent' };
    if (machine.observation?.storage === 'lost') return { kind: 'volumeLost' };
    if (context.providerAvailable === false) return { kind: 'providerRemoved', provider: context.provider ?? t('common.machine') };
    if (credentialRefused) return { kind: 'credentialRefused' };
    if (observedOperation?.state === 'running') {
        switch (observedOperation.progress?.kind === 'phase' ? observedOperation.progress.phase : undefined) {
            case 'managed.intent.busy': return { kind: 'busy' };
            case 'managed.intent.activity-unknown': return { kind: 'activityUnknown' };
            case 'managed.intent.draining': return { kind: 'draining' };
        }
    }
    if (machine.submittedNativeEffect?.intent === 'delete') return { kind: 'cleanupPending',
        cost: resolveManagedConfigurationCost({ ...machine.reviewedFacts, provider: context.provider ?? null }) };
    const pendingIntent = resolveManagedMachinePendingPowerIntentV1(machine);
    if (pendingIntent === 'stop') return { kind: 'stopPending' };
    if (pendingIntent) {
        return { kind: 'powerPending', provider: context.provider ?? t('common.machine'), state: t(`managedMachines.actions.${pendingIntent}`) };
    }
    if (machine.observation?.power === 'stopped') return machine.observation.storage === 'retained'
        ? { kind: 'stoppedStorage', ...(context.asleepWake ? { wake: context.asleepWake } : {}) } : { kind: 'storageUnknown' };
    if (machine.allocation !== 'unsubmitted') return { kind: 'resourceReady' };
    // Provider calls run where the account lives: an offline controller is what nothing waits on but the user.
    return context.controller && !context.controller.online && context.provider
        ? { kind: 'controllerWaiting', name, controller: context.controller.name, provider: context.provider }
        : { kind: 'creationWaiting', name };
}

export function describeManagedCreation(machine: ManagedMachineReadSnapshotV1, context?: ManagedCreationContext) {
    return describeManagedLifecycleState(managedCreationState(machine, context));
}

/**
 * Whether a created machine belongs in the Machines list's Archive group: archived by the person, or ended in the
 * lifecycle owner's words (gone, never made, canceled before anything was made); plan 52: ended rows leave the
 * active list. A list disposition only; it writes nothing, and a row whose cleanup is still open stays live.
 */
export function isManagedMachineListArchived(machine: ManagedMachineReadSnapshotV1): boolean {
    if (machine.archivedAt !== undefined) return true;
    const kind = managedCreationState(machine).kind;
    return kind === 'absent' || kind === 'notCreated' || kind === 'creationCanceled';
}

/** Enrollment is historical; the ordinary detail exists only after the canonical Machine projection arrives. */
export function managedMachineEnrolledDetailId(machine: ManagedMachineReadSnapshotV1, enrolledMachinePresent: boolean): string | undefined {
    return enrolledMachinePresent && machine.archivedAt === undefined && !isManagedMachineResourceAbsent(machine) ? machine.enrolledMachineId : undefined;
}

/**
 * Enrolled healthy or stopped resources use the observation row instead of repeating their state: the page header's
 * presence line already says Stopped or Asleep in the Machines rail's word (`managedMachineHeaderPresence`).
 */
export function isManagedCreationStateRowVisible(machine: Pick<ManagedMachineReadSnapshotV1, 'enrolledMachineId'>, state: ManagedLifecycleState,
    options?: Readonly<{ offersStart?: boolean }>): boolean {
    // The header says "Asleep" for a joined machine; the row earns its place only by carrying Start.
    // So does one whose wake waits for its offline controller: nothing else on the page says why it can't start.
    if (state.kind === 'stoppedStorage' && (options?.offersStart === true || state.wake?.kind === 'waitsForController')) return true;
    return !machine.enrolledMachineId || state.kind !== 'resourceReady' && state.kind !== 'stoppedStorage'
        && state.kind !== 'powerPending' && state.kind !== 'stopPending';
}

/**
 * The power actions a created machine's receipt offers: the one its observed power allows, never Start beside Stop.
 * Power that is unknown, unreported or not yet observed offers none; the state row's Check now reads it first, and
 * settlement stays the power owner's (POWER-UNKNOWN). A submitted wake that has not reached native power yet
 * is withdrawn by Stop alone. Running offers its parking verbs (Stop, or Suspend where declared).
 */
export function managedReceiptPowerIntents(machine: Pick<ManagedMachineReadSnapshotV1, 'observation' | 'desired' | 'enrolledMachineId' | 'submittedNativeEffect'>,
    supportedIntents: RetentionCapabilitiesV1['supportedIntents'],
    enrolledMachine?: Readonly<{ machineId: string; online: boolean }>): ('start' | 'stop' | 'suspend' | 'resume')[] {
    // Presence can outlive a native Stop. Use it only while native power is unanswered.
    const observedPower = machine.observation?.power;
    const power = observedPower && observedPower !== 'unknown' ? observedPower
        : enrolledMachine?.machineId === machine.enrolledMachineId && enrolledMachine?.online ? 'running' : observedPower;
    if (power !== 'running' && power !== 'stopped' && power !== 'suspended') return [];
    const declared = supportedIntents.filter((intent): intent is 'start' | 'stop' | 'suspend' | 'resume' =>
        intent === 'start' || intent === 'stop' || intent === 'suspend' || intent === 'resume');
    if (power === 'running') return declared.filter(intent => intent === 'stop' || intent === 'suspend');
    const pendingIntent = resolveManagedMachinePendingPowerIntentV1(machine);
    const wakePending = pendingIntent === 'start' || pendingIntent === 'resume';
    if (wakePending) return declared.filter(intent => intent === 'stop');
    const wake = resolveMachineWakeNativeIntentV1(power, supportedIntents);
    return wake ? [wake] : [];
}

/** Retained resources whose installation is incomplete remain recoverable when controller history is lost. */
export type ManagedInstallationRecoveryKind = 'retryInstallation' | 'update' | 'restartDaemon';
type InstallationRecoveryContext = Pick<ManagedCreationContext, 'providerAvailable' | 'enrolledMachine' | 'guestPayloadStale' | 'guestOnline'>;

export function resolveManagedInstallationRecovery(machine: ManagedMachineReadSnapshotV1, operation?: ActionOperationProjection | null,
    context: InstallationRecoveryContext = {}): ManagedInstallationRecoveryKind | null {
    const lifecycle = managedCreationState(machine, { ...context, operation });
    if (context.providerAvailable === false || machine.creationState !== 'active' || machine.archivedAt !== undefined || machine.desired === 'delete'
        || machine.allocation !== 'bound' || !machine.resource || machine.cleanup
        || lifecycle.kind === 'cleanupPending' || lifecycle.kind === 'absent' || lifecycle.kind === 'volumeLost'
        || lifecycle.kind === 'credentialRefused') return null;
    const guestOnline = context.guestOnline ?? context.enrolledMachine?.online;
    const recovery: ManagedInstallationRecoveryKind | null = !machine.enrolledMachineId || isManagedMachineBootstrapIncomplete(machine)
        ? 'retryInstallation' : guestOnline === false && machine.observation?.power === 'running' && lifecycle.kind === 'resourceReady'
            ? 'restartDaemon' : context.guestPayloadStale === true ? 'update' : null;
    if (!operation) return recovery;
    operation = currentManagedCreationOperation(machine, operation, context);
    if (!operation) return null;
    const snapshot = operation.snapshot;
    if (snapshot.error?.errorCode === 'credential_unavailable') return null;
    // A newer inspect or power receipt must not hide an unfinished installation.
    if (snapshot.actionId !== 'machines.managed.acquire'
        && snapshot.actionId !== 'machines.managed.bootstrap.retry') return recovery;
    if (operation.observation !== 'available' || operation.isUnavailableProjection
        || snapshot.domainRef?.kind !== 'managedMachine' || snapshot.domainRef.id !== machine.id) return null;
    // A failed install of this resource is retried even once it enrolled (a boot step after enrollment can fail).
    if (snapshot.state === 'failed') return recovery ?? 'retryInstallation';
    return snapshot.state === 'succeeded' && (context.guestPayloadStale === true || recovery === 'restartDaemon') ? recovery : null;
}

export function canRetryManagedInstallation(machine: ManagedMachineReadSnapshotV1, operation?: ActionOperationProjection | null,
    context: InstallationRecoveryContext = {}): boolean {
    return resolveManagedInstallationRecovery(machine, operation, context) !== null;
}

/** The UI retry, Machine recovery and Updates surfaces share the retained revision operand. */
export function buildManagedInstallationRetryInput(machine: Pick<ManagedMachineReadSnapshotV1, 'homeId' | 'id' | 'intentRevision'>) {
    return { homeId: machine.homeId, managedId: machine.id, expectedIntentRevision: machine.intentRevision };
}

/**
 * "Setup interrupted" (58b L4): the provider made the resource, it never joined, and nothing is installing it now.
 * Recorded facts only, for a creation with no operation to report (the app did the work and was closed, or its
 * history is gone): leaving the app is never read as a pause, and an observed failure stays "install failed".
 * Continue setup acts on this same resource, which `canRetryManagedInstallation` already admits.
 */
export function isManagedCreationInterrupted(machine: ManagedMachineReadSnapshotV1): boolean {
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
    machine: Pick<ManagedMachineReadSnapshotV1, 'allocation' | 'resource' | 'bootstrapInstalled' | 'enrolledMachineId'> | undefined,
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
export function currentManagedCreationOperation(machine: ManagedMachineReadSnapshotV1, operation?: ActionOperationProjection | null,
    context: Pick<ManagedCreationContext, 'enrolledMachine'> = {}): ActionOperationProjection | null {
    if (!operation) return null;
    const snapshot = operation.snapshot;
    // Keep's idle wait is not an installation. Failed retention work still carries its diagnostic.
    if (snapshot.actionId === 'machines.managed.power.set' && snapshot.state === 'running'
        && snapshot.progress?.kind === 'phase' && snapshot.progress.phase === 'managed.intent.waiting-idle') return null;
    const failedIdleObservation = snapshot.state === 'failed' && isManagedMachineRetentionWaitOperation(snapshot)
        && ['managed_controller_request_failed', 'ECONNABORTED', 'admission_unavailable',
            'RPC_TRANSPORT_UNAVAILABLE', 'RPC_CLIENT_NOT_AVAILABLE'].includes(snapshot.error?.errorCode ?? '');
    // Confirmed removal supersedes an earlier failed request on this resource.
    // A superseded operation can fail after Delete observed absence. Compare
    // request admission, not settlement. A passive idle failure is obsolete
    // even if it raced the absence report; later actionable requests still
    // need attention. Cancellation before submission confirms only that nothing
    // was made; the failed creation remains its diagnostic authority.
    if (machine.desired === 'delete' && machine.allocation === 'confirmed-absent'
        && snapshot.state === 'failed'
        && machine.observation?.availability === 'absent'
        && (snapshot.createdAt <= machine.observation.observedAt || failedIdleObservation)) return null;
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
    const healthyEnrollment = !isManagedMachineBootstrapIncomplete(machine) && machine.creationState === 'active' && machine.allocation === 'bound' && !machine.cleanup
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
