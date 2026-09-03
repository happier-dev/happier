import { describe, expect, it } from 'vitest';

import { resolvePendingActivationBanner } from './resolvePendingActivationBanner';

const waiting = { requestId: 'p2', requestedAt: 200, status: 'waiting' as const };
const failed = { requestId: 'p2', requestedAt: 200, status: 'failed' as const, failureCode: 'runtime_start_failed' as const };
const rows = [
    { id: '1', localId: 'p1', createdAt: 10, updatedAt: 10, text: 'one', rawRecord: {}, messageRole: 'user' as const, pendingDeliveryStatus: 'server_queued' as const, requestedAction: { v: 1 as const, kind: 'enqueue' as const } },
    { id: '2', localId: 'p2', createdAt: 20, updatedAt: 20, text: 'two', rawRecord: {}, messageRole: 'user' as const, pendingDeliveryStatus: 'server_queued' as const, requestedAction: { v: 1 as const, kind: 'send_now' as const } },
];

describe('resolvePendingActivationBanner', () => {
    it('uses only a current authorization and its exact request row', () => {
        expect(resolvePendingActivationBanner({ authorization: waiting, activeAt: 100, active: false, machineReachable: false, canWrite: true, pendingMessages: rows })).toMatchObject({ kind: 'waiting_offline', row: { localId: 'p2' } });
        expect(resolvePendingActivationBanner({ authorization: waiting, activeAt: 200, active: false, machineReachable: false, canWrite: true, pendingMessages: rows })).toMatchObject({ kind: 'queued_offline', row: { localId: 'p1' }, primaryAction: 'process_when_online' });
    });

    it('distinguishes a manual offline queue from durable resume authorization', () => {
        expect(resolvePendingActivationBanner({ authorization: null, activeAt: 100, active: false, machineReachable: false, canWrite: true, pendingMessages: rows })).toMatchObject({
            kind: 'queued_offline',
            row: { localId: 'p1' },
            primaryAction: 'process_when_online',
        });
        expect(resolvePendingActivationBanner({ authorization: waiting, activeAt: 100, active: false, machineReachable: false, canWrite: true, pendingMessages: rows })).toMatchObject({
            kind: 'waiting_offline',
            row: { localId: 'p2' },
            primaryAction: null,
        });
    });

    it('presents failed authorization without initiating work and selects a deterministic queue fallback', () => {
        expect(resolvePendingActivationBanner({ authorization: failed, activeAt: 100, active: false, machineReachable: true, canWrite: true, pendingMessages: rows })).toMatchObject({ kind: 'failed', row: { localId: 'p2' }, primaryAction: 'retry' });
        expect(resolvePendingActivationBanner({ authorization: null, activeAt: 100, active: false, machineReachable: true, canWrite: true, pendingMessages: [...rows].reverse() })).toMatchObject({ kind: 'queued', row: { localId: 'p1' }, primaryAction: 'resume' });
    });

    it('hides ordinary active online queues and malformed/non-user rows', () => {
        expect(resolvePendingActivationBanner({ authorization: null, activeAt: 100, active: true, machineReachable: true, canWrite: true, pendingMessages: rows })).toBeNull();
        expect(resolvePendingActivationBanner({ authorization: waiting, activeAt: 100, active: true, machineReachable: true, canWrite: true, pendingMessages: rows })).toBeNull();
        expect(resolvePendingActivationBanner({ authorization: failed, activeAt: 100, active: true, machineReachable: true, canWrite: true, pendingMessages: rows })).toBeNull();
        expect(resolvePendingActivationBanner({ authorization: waiting, activeAt: 100, active: true, machineReachable: false, canWrite: true, pendingMessages: rows })).toMatchObject({ kind: 'waiting_offline' });
        expect(resolvePendingActivationBanner({ authorization: null, activeAt: 100, active: false, machineReachable: false, canWrite: true, pendingMessages: [{ ...rows[0], requestedActionMalformed: true }] })).toBeNull();
    });
});
