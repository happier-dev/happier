import { describe, expect, it } from 'vitest';
import { deriveManagedWakeProjection, type ManagedWakeProjectionInput } from './managedWakeProjection';

const controller = { machineId: 'controller-a', installationId: 'installation-a' };
const resource: NonNullable<ManagedWakeProjectionInput['managed']> = {
    id: 'managed-a', homeId: 'home-a', creationState: 'active', enrolledMachineId: 'guest-a', allocation: 'bound', controller,
    observation: { observedAt: 10, availability: 'present', power: 'stopped', storage: 'retained', daemon: 'disconnected' },
};
const input: ManagedWakeProjectionInput = {
    managed: resource,
    pending: { source: 'server_pending', pendingDeliveryStatus: 'server_queued' },
    activation: { status: 'waiting', requestId: 'request-a', requestedAt: 10 },
    runtimeResuming: false,
};

describe('managed wake observed projection', () => {
    it('waits on stopped retained compute and advances only on real submission, power and runtime observations', () => {
        expect(deriveManagedWakeProjection(input)?.kind).toBe('waiting');
        expect(deriveManagedWakeProjection({ ...input, managed: {
            ...resource, submittedNativeEffect: { intentRevision: 2, requestId: 'start-a', intent: 'start', controller },
        } })?.kind).toBe('starting');
        const running = { ...resource, observation: { ...resource.observation!, power: 'running' as const } };
        expect(deriveManagedWakeProjection({ ...input, managed: running })?.kind).toBe('connecting');
        const connected = { ...running, observation: { ...running.observation, daemon: 'connected' as const } };
        expect(deriveManagedWakeProjection({ ...input, managed: connected })?.kind).toBe('waiting');
        expect(deriveManagedWakeProjection({ ...input, managed: connected, runtimeResuming: true })?.kind).toBe('resuming');
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
        const managed = { ...resource, observation: { ...resource.observation!, power: 'running' as const, daemon: 'connected' as const } };
        const failed = { status: 'failed' as const, requestId: 'request-a', requestedAt: 10, failureCode: 'runtime_start_failed' as const };
        expect(deriveManagedWakeProjection({ ...input, managed, activation: failed })).toMatchObject({
            kind: 'agentStartFailed', inputCustody: 'queued', canRetryAgentStart: true,
        });
        expect(deriveManagedWakeProjection({ ...input, managed, activation: failed, runtimeResuming: true })?.kind).toBe('resuming');
        expect(deriveManagedWakeProjection({
            ...input, managed, activation: failed, pending: { source: 'server_pending', pendingDeliveryStatus: 'server_delivering' },
        })).toMatchObject({ kind: 'deliveryUnknown', inputCustody: 'unknown', canRetryAgentStart: false });
    });

    it('preserves native absence, storage loss and missing observations as distinct facts', () => {
        expect(deriveManagedWakeProjection({ ...input, managed: { ...resource, allocation: 'confirmed-absent' } })?.kind).toBe('resourceAbsent');
        expect(deriveManagedWakeProjection({ ...input, managed: { ...resource, observation: { ...resource.observation!, storage: 'lost' } } })?.kind).toBe('storageLost');
        expect(deriveManagedWakeProjection({ ...input, managed: { ...resource, observation: undefined } })?.kind).toBe('unknown');
    });

    it('does not fabricate queued wake from passive reads or a local outbound projection', () => {
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
        expect(deriveManagedWakeProjection({ ...input, activation, managed: { ...resource, creationState: 'retired' } })).toBeNull();
        expect(deriveManagedWakeProjection({ ...input, activation, managed: null })).toMatchObject({ kind: 'unknown', canResumeRuntime: false });
    });
});
