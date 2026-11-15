import type { ManagedMachineV1 } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import { resolveManagedMachinePendingPowerIntentV1 } from '@happier-dev/protocol/machines/managed/resolveMachineRetentionPolicyV1';
import type { PendingActivationAuthorizationV1 } from '@happier-dev/protocol/sessions/pending/pendingActivationAuthorizationV1';
import type { PendingMessage, Session } from '@/sync/domains/state/storageTypes';

export { resolveManagedWakeAvailabilityV1 as resolveManagedWakeAvailability } from '@happier-dev/protocol/machines/managed/resolveMachineRetentionPolicyV1';

/** Held managed input recovers through its existing activation Action, not a second immediate send. */
export function isManagedPendingInputAwaitingWake(
    pending: Pick<PendingMessage, 'localId' | 'source' | 'pendingDeliveryStatus' | 'pendingActivationHoldReason'>,
    session: Pick<Session, 'active' | 'pendingActivationAuthorization'> | null | undefined,
): boolean {
    if (session?.active === true || pending.source !== 'server_pending' || pending.pendingDeliveryStatus !== 'server_queued') return false;
    const activation = session?.pendingActivationAuthorization;
    return Boolean(pending.pendingActivationHoldReason
        || activation?.managedWakeTargetV1 && activation.requestId === pending.localId);
}

/** The Session's current managed wake request: newer than its last activation and naming a managed target. */
export function readManagedWakeAuthorization(
    session: Pick<Session, 'activeAt'> & Readonly<{ pendingActivationAuthorization?: PendingActivationAuthorizationV1 | null }>,
): PendingActivationAuthorizationV1 | null {
    const authorization = session.pendingActivationAuthorization;
    return authorization && authorization.requestedAt > session.activeAt && authorization.managedWakeTargetV1 ? authorization : null;
}

export type ManagedWakeProjectionInput = Readonly<{
    managed: Pick<ManagedMachineV1, 'id' | 'homeId' | 'creationState' | 'enrolledMachineId' | 'allocation' | 'controller' | 'observation' | 'submittedNativeEffect' | 'wakeOnAcceptedMessage'> | null;
    pending: Pick<PendingMessage, 'source' | 'pendingDeliveryStatus'> | null;
    activation: PendingActivationAuthorizationV1 | null;
    /** The enrolled Machine's canonical reachability, independently of native power. */
    machineReachable: boolean | null;
    runtimeResuming: boolean;
    /** False while the Session's pending list has not been read: a missing row is then unread, not unconfirmed. */
    pendingLoaded?: boolean;
    pendingReadState?: 'loading' | 'error';
    managedReadState?: 'loading' | 'read';
    machineInventoryState?: 'loading' | 'read';
}>;

export type ManagedWakeProjection = Readonly<{
    kind: 'loading' | 'waiting' | 'starting' | 'connecting' | 'resuming' | 'agentStartFailed' | 'resourceAbsent' | 'storageLost' | 'unavailable' | 'unknown' | 'deliveryUnknown';
    inputCustody: 'queued' | 'unknown';
    canWithdraw: boolean;
    canRetryAgentStart: boolean;
    canRequestWake: boolean;
    canResumeRuntime: boolean;
    /** Typed terminal cause for the presenter; never native or approval error prose. */
    failureCode?: Extract<PendingActivationAuthorizationV1, { status: 'failed' }>['failureCode'];
    observedAt?: number;
}>;

/** Presentation only: native submissions, daemon observations and pending custody keep their owners. */
export function deriveManagedWakeProjection(input: ManagedWakeProjectionInput): ManagedWakeProjection | null {
    if (!input.pending && !input.activation) return null;
    const { managed, pending, activation } = input;
    const target = activation?.managedWakeTargetV1;
    if (!managed && !target) return null;
    const queued = pending?.source === 'server_pending' && pending.pendingDeliveryStatus === 'server_queued';
    const observation = managed?.observation;
    // Providers may omit power and storage. The Machine's actual reachability
    // owns daemon readiness; missing optional provider facts do not contradict it.
    const canConnect = observation?.availability === 'present'
        && (observation.power === undefined || observation.power === 'running');
    const ready = canConnect
        && (observation.storage === undefined || observation.storage === 'retained')
        && input.machineReachable === true;
    const base = {
        inputCustody: queued ? 'queued' as const : 'unknown' as const,
        canWithdraw: queued,
        canRetryAgentStart: false,
        canRequestWake: false,
        canResumeRuntime: false,
        ...(observation ? { observedAt: observation.observedAt } : {}),
    };
    // Hold genuinely unread inputs, but a failed read has settled without
    // proving custody. Retained snapshots remain useful during refresh failure.
    if ((input.pendingLoaded === false && input.pendingReadState !== 'error') || input.managedReadState === 'loading' || input.machineInventoryState === 'loading') {
        return { ...base, kind: 'loading' };
    }
    if (!managed) return { ...base, kind: 'unknown' };
    if (target && (managed.id !== target.managedId || managed.homeId !== target.homeId
        || managed.enrolledMachineId !== target.enrolledMachineId || managed.creationState !== 'active')) return null;
    if (managed.allocation === 'confirmed-absent' || observation?.availability === 'absent') {
        return { ...base, kind: 'resourceAbsent' };
    }
    if (observation?.storage === 'lost') return { ...base, kind: 'storageLost' };
    if (observation?.availability === 'unavailable') return { ...base, kind: 'unavailable' };
    if (!queued) return { ...base, kind: 'deliveryUnknown' };
    if (ready && input.runtimeResuming) return { ...base, kind: 'resuming' };
    // A submitted native wake outlives a failed activation until its own
    // observation advances; it cannot be unsent or retried by the queue.
    const pendingPower = resolveManagedMachinePendingPowerIntentV1(managed);
    if ((pendingPower === 'start' || pendingPower === 'resume') && !ready) {
        return { ...base, kind: 'starting' };
    }
    // An authorization is accepted input, not proof of an outstanding native
    // Start. In particular, a lost live Ask can settle stale after restart
    // without a controller invocation left to report activation failure.
    // Explicit rearming replaces that origin through the ordinary pending owner;
    // current power admission/approval still belongs to the managed controller.
    const canRequestWake = managed.wakeOnAcceptedMessage === true && !managed.submittedNativeEffect
        && managed.creationState === 'active' && managed.allocation === 'bound'
        && observation?.availability === 'present'
        && (observation.power === 'stopped' || observation.power === 'suspended');
    if (activation?.status === 'failed') {
        // Retry re-admits the intent through the managed owner. Unknown storage
        // is not loss (handled above) or a UI-owned native-effect refusal.
        return { ...base, kind: 'agentStartFailed', failureCode: activation.failureCode, canRetryAgentStart: ready,
            canRequestWake };
    }
    if (!observation) return { ...base, kind: 'unknown' };
    if (canConnect) {
        if (input.machineReachable === false) return { ...base, kind: 'connecting' };
        if (ready) return { ...base, kind: 'waiting', canResumeRuntime: activation?.status === 'waiting' };
    }
    if ((observation.storage === 'retained' || canRequestWake) && (observation.power === 'stopped' || observation.power === 'suspended')) {
        return { ...base, kind: 'waiting', canRequestWake };
    }
    return { ...base, kind: 'unknown' };
}
