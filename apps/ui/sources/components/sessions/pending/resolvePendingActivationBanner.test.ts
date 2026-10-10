import { describe, expect, it } from 'vitest';

import { resolvePendingActivationBanner } from './resolvePendingActivationBanner';
import { deriveManagedWakeProjection } from '@/sync/domains/pending/managedWakeProjection';

const waiting = { requestId: 'p2', requestedAt: 200, status: 'waiting' as const };
const failed = { requestId: 'p2', requestedAt: 200, status: 'failed' as const, failureCode: 'runtime_start_failed' as const };
const rows = [
    { id: '1', localId: 'p1', createdAt: 10, updatedAt: 10, text: 'one', rawRecord: {}, messageRole: 'user' as const, pendingDeliveryStatus: 'server_queued' as const, pendingRequestedAction: { v: 1 as const, kind: 'enqueue' as const } },
    { id: '2', localId: 'p2', createdAt: 20, updatedAt: 20, text: 'two', rawRecord: {}, messageRole: 'user' as const, pendingDeliveryStatus: 'server_queued' as const, pendingRequestedAction: { v: 1 as const, kind: 'send_now' as const } },
];

describe('resolvePendingActivationBanner', () => {
    it('uses a current authorization and its exact request row', () => {
        expect(resolvePendingActivationBanner({ authorization: waiting, activeAt: 100, active: false, machineReachable: false, canWrite: true, pendingMessages: rows })).toMatchObject({ kind: 'waiting_offline', row: { localId: 'p2' } });
        expect(resolvePendingActivationBanner({ authorization: waiting, activeAt: 200, active: false, machineReachable: false, canWrite: true, pendingMessages: rows })).toMatchObject({ kind: 'queued_offline', row: { localId: 'p1' }, primaryAction: 'process_when_online' });
    });

    it('distinguishes an offline queue without durable activation authorization', () => {
        expect(resolvePendingActivationBanner({ authorization: null, activeAt: 100, active: false, machineReachable: false, canWrite: true, pendingMessages: rows })).toMatchObject({
            kind: 'queued_offline',
            row: { localId: 'p1' },
            primaryAction: 'process_when_online',
        });
    });

    it('presents reachable waiting, failed terminal, and queue-only states without initiating work', () => {
        expect(resolvePendingActivationBanner({ authorization: waiting, activeAt: 100, active: false, machineReachable: true, canWrite: true, pendingMessages: rows })).toMatchObject({ kind: 'waiting', row: { localId: 'p2' } });
        expect(resolvePendingActivationBanner({ authorization: failed, activeAt: 100, active: false, machineReachable: true, canWrite: true, pendingMessages: rows })).toMatchObject({ kind: 'failed', row: { localId: 'p2' }, primaryAction: 'retry' });
        expect(resolvePendingActivationBanner({ authorization: failed, activeAt: 100, active: false, machineReachable: false, canWrite: true, pendingMessages: rows })).toMatchObject({ kind: 'failed', row: { localId: 'p2' }, primaryAction: 'process_when_online' });
        expect(resolvePendingActivationBanner({ authorization: null, activeAt: 100, active: false, machineReachable: true, canWrite: true, pendingMessages: [...rows].reverse() })).toMatchObject({ kind: 'queued', row: { localId: 'p1' }, primaryAction: 'resume' });
    });

    it('suppresses waiting and failed authorization while active and reachable', () => {
        expect(resolvePendingActivationBanner({ authorization: waiting, activeAt: 100, active: true, machineReachable: true, canWrite: true, pendingMessages: rows })).toBeNull();
        expect(resolvePendingActivationBanner({ authorization: failed, activeAt: 100, active: true, machineReachable: true, canWrite: true, pendingMessages: rows })).toBeNull();
    });

    it('retains waiting authorization while active but unreachable', () => {
        expect(resolvePendingActivationBanner({ authorization: waiting, activeAt: 100, active: true, machineReachable: false, canWrite: true, pendingMessages: rows })).toMatchObject({ kind: 'waiting_offline', row: { localId: 'p2' } });
    });

    it('suppresses active-online, malformed, non-user, and read-only state', () => {
        expect(resolvePendingActivationBanner({ authorization: null, activeAt: 100, active: true, machineReachable: true, canWrite: true, pendingMessages: rows })).toBeNull();
        expect(resolvePendingActivationBanner({ authorization: null, activeAt: 100, active: false, machineReachable: false, canWrite: true, pendingMessages: [{ ...rows[0], pendingRequestedActionMalformed: true }] })).toBeNull();
        expect(resolvePendingActivationBanner({ authorization: null, activeAt: 100, active: false, machineReachable: false, canWrite: true, pendingMessages: [{ ...rows[0], messageRole: 'assistant' as any }] })).toBeNull();
        expect(resolvePendingActivationBanner({ authorization: waiting, activeAt: 100, active: false, machineReachable: false, canWrite: false, pendingMessages: rows })).toBeNull();
    });

    it('hides the activation banner while the session is already resuming', () => {
        expect(resolvePendingActivationBanner({ authorization: null, activeAt: 100, active: false, machineReachable: true, canWrite: true, resumingAt: 300, pendingMessages: rows })).toBeNull();
    });

    it('does not offer Agent retry before native prerequisites or label ambiguous delivery as safely queued', () => {
        const managed = {
            id: 'managed-a', homeId: 'home-a', creationState: 'active' as const, allocation: 'bound' as const,
            enrolledMachineId: 'guest-a', controller: { machineId: 'controller-a', installationId: 'installation-a' },
            observation: { observedAt: 10, availability: 'present' as const, power: 'stopped' as const, storage: 'retained' as const, daemon: 'disconnected' as const },
        };
        const managedWakeProjection = deriveManagedWakeProjection({
            managed, activation: failed, pending: { ...rows[1], source: 'server_pending' }, runtimeResuming: false,
        });
        expect(resolvePendingActivationBanner({
            authorization: failed, activeAt: 100, active: false, machineReachable: false, canWrite: true, pendingMessages: rows,
            ...{ managedWakeProjection },
        })).toMatchObject({ kind: 'failed', primaryAction: null, managedWakeProjection: { kind: 'agentStartFailed' } });
        const unknown = deriveManagedWakeProjection({
            managed, activation: failed, pending: { ...rows[1], source: 'server_pending', pendingDeliveryStatus: 'server_delivering' }, runtimeResuming: false,
        });
        expect(resolvePendingActivationBanner({
            authorization: failed, activeAt: 100, active: false, machineReachable: false, canWrite: true, pendingMessages: [],
            ...{ managedWakeProjection: unknown },
        })).toMatchObject({ managedWakeProjection: { kind: 'deliveryUnknown' }, primaryAction: null, secondaryAction: null });
    });
    it('keeps managed resuming and loss visible through the managed badge without a generic recovery action', () => {
        for (const kind of ['resuming', 'storageLost', 'resourceAbsent', 'unknown', 'unavailable'] as const) {
            expect(resolvePendingActivationBanner({ authorization: waiting, activeAt: 100, active: false, machineReachable: true,
                canWrite: true, resumingAt: 300, pendingMessages: rows,
                managedWakeProjection: { kind, inputCustody: 'queued', canWithdraw: true, canRetryAgentStart: false, canResumeRuntime: false },
            })).toMatchObject({ managedWakeProjection: { kind }, primaryAction: null });
        }
    });
});
