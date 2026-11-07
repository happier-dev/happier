import { describe, expect, it } from 'vitest';
import { deriveManagedWakeProjection, type ManagedWakeProjectionInput } from './managedWakeProjection';

const controller = { machineId: 'controller-a', installationId: 'installation-a' };
const resource: NonNullable<ManagedWakeProjectionInput['managed']> = {
    id: 'managed-a', homeId: 'home-a', creationState: 'active', enrolledMachineId: 'guest-a', allocation: 'bound', controller,
    wakeOnAcceptedMessage: true,
    observation: { observedAt: 10, availability: 'present', power: 'stopped', storage: 'retained' },
};
const input: ManagedWakeProjectionInput = {
    managed: resource,
    pending: { source: 'server_pending', pendingDeliveryStatus: 'server_queued' },
    activation: { status: 'waiting', requestId: 'request-a', requestedAt: 10 },
    machineReachable: false,
    runtimeResuming: false,
};

describe('managed wake observed projection', () => {
    it('reads daemon readiness from Machine reachability instead of native provider observations', () => {
        const running = { ...input, machineReachable: true, managed: { ...resource,
            observation: { observedAt: 10, availability: 'present' as const, power: 'running' as const, storage: 'retained' as const } } };
        expect(deriveManagedWakeProjection(running)).toMatchObject({ kind: 'waiting', canResumeRuntime: true });
        expect(deriveManagedWakeProjection({ ...running, runtimeResuming: true })).toMatchObject({ kind: 'resuming' });
        const offline = { ...running, machineReachable: false };
        expect(deriveManagedWakeProjection(offline)).toMatchObject({ kind: 'connecting', canResumeRuntime: false });
        const unknown = { ...running, machineReachable: null };
        expect(deriveManagedWakeProjection(unknown)).toMatchObject({ kind: 'unknown', canResumeRuntime: false });
    });
    it('distinguishes unread inputs from completed reads with unknown facts and settled failure', () => {
        const failed = { status: 'failed' as const, requestId: 'request-a', requestedAt: 10, failureCode: 'runtime_start_failed' as const };
        expect(deriveManagedWakeProjection({ ...input, activation: failed, managedReadState: 'loading', machineInventoryState: 'read' }))
            .toMatchObject({ kind: 'loading', canRequestWake: false, canRetryAgentStart: false, canResumeRuntime: false });
        expect(deriveManagedWakeProjection({ ...input, activation: failed, managedReadState: 'read', machineInventoryState: 'loading' }))
            .toMatchObject({ kind: 'loading', canRequestWake: false, canRetryAgentStart: false });
        expect(deriveManagedWakeProjection({ ...input, managed: { ...resource, observation: undefined }, managedReadState: 'read', machineInventoryState: 'read' })?.kind)
            .toBe('unknown');
        expect(deriveManagedWakeProjection({ ...input, activation: failed, managedReadState: 'read', machineInventoryState: 'read' }))
            .toMatchObject({ kind: 'agentStartFailed', failureCode: 'runtime_start_failed', canRequestWake: true });
    });

    it('waits on stopped retained compute and advances only on real submission, power and runtime observations', () => {
        // A retained activation can outlive its Start Ask's live invocation.
        // Waiting authorization alone cannot prove a Start is still pending.
        expect(deriveManagedWakeProjection(input)).toMatchObject({ kind: 'waiting', canRequestWake: true });
        expect(deriveManagedWakeProjection({ ...input, managed: {
            ...resource, submittedNativeEffect: { intentRevision: 2, requestId: 'start-a', intent: 'start', controller },
        } })?.kind).toBe('starting');
        const running = { ...resource, observation: { ...resource.observation!, power: 'running' as const } };
        expect(deriveManagedWakeProjection({ ...input, managed: running })?.kind).toBe('connecting');
        expect(deriveManagedWakeProjection({ ...input, managed: running, machineReachable: true })?.kind).toBe('waiting');
        expect(deriveManagedWakeProjection({ ...input, managed: running, machineReachable: true, runtimeResuming: true })?.kind).toBe('resuming');
        expect(deriveManagedWakeProjection({ ...input, managed: {
            ...running, submittedNativeEffect: { intentRevision: 2, requestId: 'start-a', intent: 'start', controller },
        } })?.kind).toBe('connecting');
    });

    it('keeps a real submitted Start visible when a later policy/controller edit cannot unsend it', () => {
        const managed = {
            ...resource, controller: { machineId: 'controller-b', installationId: 'installation-b' },
            submittedNativeEffect: { intentRevision: 1, requestId: 'start-a', intent: 'start' as const, controller },
        };
        expect(deriveManagedWakeProjection({ ...input, managed })?.kind).toBe('starting');
    });

    it('distinguishes Agent start refusal from compute wake and never claims ambiguous input is still queued', () => {
        const managed = { ...resource, observation: { ...resource.observation!, power: 'running' as const } };
        const failed = { status: 'failed' as const, requestId: 'request-a', requestedAt: 10, failureCode: 'runtime_start_failed' as const };
        expect(deriveManagedWakeProjection({ ...input, managed, activation: failed, machineReachable: true })).toMatchObject({
            kind: 'agentStartFailed', inputCustody: 'queued', canRetryAgentStart: true,
        });
        expect(deriveManagedWakeProjection({ ...input, managed, activation: failed, machineReachable: true, runtimeResuming: true })?.kind).toBe('resuming');
        const wakeDisabled = { ...managed, wakeOnAcceptedMessage: false };
        expect(deriveManagedWakeProjection({ ...input, managed: wakeDisabled, activation: failed, machineReachable: true })).toMatchObject({
            canRetryAgentStart: true, canRequestWake: false,
        });
        expect(deriveManagedWakeProjection({
            ...input, managed, activation: failed, pending: { source: 'server_pending', pendingDeliveryStatus: 'server_delivering' },
        })).toMatchObject({ kind: 'deliveryUnknown', inputCustody: 'unknown', canRetryAgentStart: false });
    });

    it('offers an explicit wake retry only for the retained queued input on confirmed stopped compute', () => {
        const failed = { status: 'failed' as const, requestId: 'request-a', requestedAt: 10, failureCode: 'runtime_start_failed' as const };
        expect(deriveManagedWakeProjection({ ...input, activation: failed })).toMatchObject({
            kind: 'agentStartFailed', canRequestWake: true, canRetryAgentStart: false,
        });
        // Wake admission can inspect this exact resource before deciding the
        // native effect. Unknown storage is not confirmed storage loss.
        expect(deriveManagedWakeProjection({ ...input, activation: failed, managed: { ...resource,
            observation: { ...resource.observation!, storage: 'unknown' },
        } })).toMatchObject({ canRequestWake: true, canRetryAgentStart: false });
        const wakeDisabled = { ...resource, wakeOnAcceptedMessage: false };
        expect(deriveManagedWakeProjection({ ...input, activation: failed, managed: wakeDisabled }))
            .toMatchObject({ canRequestWake: false, canRetryAgentStart: false });
        expect(deriveManagedWakeProjection({ ...input, activation: failed, managed: { ...resource, observation: undefined } }))
            .toMatchObject({ canRequestWake: false });
        expect(deriveManagedWakeProjection({ ...input, activation: failed, managed: { ...resource,
            submittedNativeEffect: { intentRevision: 2, requestId: 'start-a', intent: 'start', controller },
        } })).toMatchObject({ kind: 'starting', canRequestWake: false });
        expect(deriveManagedWakeProjection({ ...input, activation: failed,
            pending: { source: 'server_pending', pendingDeliveryStatus: 'server_delivering' },
        })).toMatchObject({ kind: 'deliveryUnknown', canRequestWake: false });
    });

    it('preserves native absence, storage loss and missing observations as distinct facts', () => {
        expect(deriveManagedWakeProjection({ ...input, managed: { ...resource, allocation: 'confirmed-absent' } })?.kind).toBe('resourceAbsent');
        expect(deriveManagedWakeProjection({ ...input, managed: { ...resource, observation: { ...resource.observation!, storage: 'lost' } } })?.kind).toBe('storageLost');
        expect(deriveManagedWakeProjection({ ...input, managed: { ...resource, observation: undefined } })?.kind).toBe('unknown');
    });

    it('does not fabricate queued wake from passive reads or a local outbound projection', () => {
        // Before the pending list is read, an absent row is "not read yet", never "delivery unconfirmed".
        expect(deriveManagedWakeProjection({ ...input, pending: null, pendingLoaded: false })?.kind).toBe('loading');
        expect(deriveManagedWakeProjection({ ...input, pending: null, pendingLoaded: true })?.kind).toBe('deliveryUnknown');
        expect(deriveManagedWakeProjection({ ...input, pending: null, activation: null })).toBeNull();
        expect(deriveManagedWakeProjection({ ...input, pending: { source: 'local_outbound', pendingDeliveryStatus: 'server_queued' } })).toMatchObject({
            inputCustody: 'unknown', canWithdraw: false,
        });
        expect(deriveManagedWakeProjection({ ...input, managed: null })).toBeNull();
    });

    it('qualifies the real retained row against the accepted Session target rather than ambient Machine metadata', () => {
        const activation = { ...input.activation!, managedWakeTargetV1: {
            homeId: 'home-a', managedId: 'managed-a', enrolledMachineId: 'guest-a', expectedIntentRevision: 1,
            controller, reason: 'admitted-work' as const,
            origin: { kind: 'session-input' as const, session: { homeId: 'home-a', sessionId: 'session-a' }, pendingRequestId: 'request-a', requestedAt: 10 },
        } };
        expect(deriveManagedWakeProjection({ ...input, activation, managed: { ...resource, enrolledMachineId: 'replacement-guest' } })).toBeNull();
        expect(deriveManagedWakeProjection({ ...input, activation, managed: { ...resource, creationState: 'canceled' } })).toBeNull();
        expect(deriveManagedWakeProjection({ ...input, activation, managed: null })).toMatchObject({ kind: 'unknown', canResumeRuntime: false });
    });
});
