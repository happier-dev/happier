import type { ManagedMachineV1 } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import type { PendingActivationAuthorizationV1 } from '@happier-dev/protocol/sessions/pending/pendingActivationAuthorizationV1';
import type { PendingMessage } from '@/sync/domains/state/storageTypes';

export type ManagedWakeProjectionInput = Readonly<{
    managed: Pick<ManagedMachineV1, 'id' | 'homeId' | 'creationState' | 'enrolledMachineId' | 'allocation' | 'controller' | 'observation' | 'submittedNativeEffect'> | null;
    pending: Pick<PendingMessage, 'source' | 'pendingDeliveryStatus'> | null;
    activation: PendingActivationAuthorizationV1 | null;
    runtimeResuming: boolean;
}>;

export type ManagedWakeProjection = Readonly<{
    kind: 'waiting' | 'starting' | 'connecting' | 'resuming' | 'agentStartFailed' | 'resourceAbsent' | 'storageLost' | 'unavailable' | 'unknown' | 'deliveryUnknown';
    inputCustody: 'queued' | 'unknown';
    canWithdraw: boolean;
    canRetryAgentStart: boolean;
    canResumeRuntime: boolean;
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
    const ready = observation?.availability === 'present'
        && observation.power === 'running'
        && observation.storage === 'retained'
        && observation.daemon === 'connected';
    const base = {
        inputCustody: queued ? 'queued' as const : 'unknown' as const,
        canWithdraw: queued,
        canRetryAgentStart: false,
        canResumeRuntime: false,
        ...(observation ? { observedAt: observation.observedAt } : {}),
    };
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
    if (activation?.status === 'failed') {
        return { ...base, kind: 'agentStartFailed', canRetryAgentStart: ready };
    }
    if (!observation) return { ...base, kind: 'unknown' };
    if (observation.power === 'running') {
        if (observation.daemon === 'disconnected') return { ...base, kind: 'connecting' };
        if (ready) return { ...base, kind: 'waiting', canResumeRuntime: activation?.status === 'waiting' };
    }
    // Submission remains factual across policy/Move edits, but a current
    // running observation has already advanced past the native Start stage.
    if (managed.submittedNativeEffect?.intent === 'start') return { ...base, kind: 'starting' };
    if (observation.storage === 'retained' && (observation.power === 'stopped' || observation.power === 'suspended')) {
        return { ...base, kind: 'waiting' };
    }
    return { ...base, kind: 'unknown' };
}
