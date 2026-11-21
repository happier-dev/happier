import { describe, expect, it } from 'vitest';
import { dispatchSimulatorPreviewActionV1 } from '@happier-dev/protocol/devices/simulator/runtimeActionClient';
import { DaemonSimulatorPreviewActionRequestV1Schema, SIMULATOR_PREVIEW_ID_MAX_LENGTH, SIMULATOR_CONTROL_LEASE_ID_MAX_LENGTH, type SimulatorPreviewActionV1 } from '@happier-dev/protocol/devices/simulator/runtimeV1';
import { createSimulatorInputLeaseManager } from './lease';

describe('simulator lease Action round trip', () => {
    it.each([96, SIMULATOR_PREVIEW_ID_MAX_LENGTH])('accepts minted composite ids from %i-character identifiers through acquire, renew, control and release', async length => {
        const manager = createSimulatorInputLeaseManager({ ttlMs: 30_000 });
        const streamId = 's'.repeat(length), sourceId = 'd'.repeat(length), viewerId = 'v'.repeat(length);
        let nowMs = length === 96 ? 100_000_000 : Number.MAX_SAFE_INTEGER - 30_001;
        let sent = 0;
        const call = async (request: { payload: unknown }) => {
            sent += 1;
            const { event } = DaemonSimulatorPreviewActionRequestV1Schema.parse(request.payload);
            if (event.type === 'simulator.lease.acquire' || event.type === 'simulator.lease.renew') {
                const acquired = manager.acquire({ streamId, sourceId, holderId: viewerId, nowMs });
                if (!acquired.ok) throw new Error('Expected lease');
                return { protocolVersion: 1, result: { v: 1, status: 'accepted', eventType: event.type, lease: acquired.lease } };
            }
            if (event.type === 'simulator.lease.release') expect(manager.release(event)).toEqual({ ok: true });
            if (event.type === 'simulator.control.send') expect(event.control.leaseId).toBe(manager.read({ streamId, sourceId, nowMs })?.leaseId);
            return { protocolVersion: 1, result: { v: 1, status: 'accepted', eventType: event.type } };
        };
        const dispatch = (event: SimulatorPreviewActionV1) => dispatchSimulatorPreviewActionV1(call, { machineId: 'machine', event });
        const base = { simulatorId: 'sim', streamId, sourceId, viewerId };
        const acquired = await dispatch({ ...base, type: 'simulator.lease.acquire' });
        expect(acquired.ok).toBe(true);
        if (!acquired.ok || !acquired.result.lease) throw new Error('Expected acquire result');
        if (length === 96) expect(acquired.result.lease.leaseId).toHaveLength(300);
        nowMs += 1;
        const renewed = await dispatch({ ...base, type: 'simulator.lease.renew', leaseId: acquired.result.lease.leaseId });
        expect(renewed.ok).toBe(true);
        if (!renewed.ok || !renewed.result.lease) throw new Error('Expected renewed lease');
        const leaseId = renewed.result.lease.leaseId;
        expect(renewed.result.lease.expiresAtMs).toBeGreaterThan(acquired.result.lease.expiresAtMs);
        await expect(dispatch({ type: 'simulator.control.send', control: { v: 1, kind: 'tap', streamId, sourceId, eventId: 'tap', leaseId, x: 0.5, y: 0.5 } })).resolves.toMatchObject({ ok: true });
        await expect(dispatch({ type: 'simulator.lease.release', simulatorId: 'sim', streamId, sourceId, leaseId })).resolves.toMatchObject({ ok: true });
        expect(manager.read({ streamId, sourceId, nowMs })).toBeNull();
        expect(sent).toBe(4);
        const garbage = 'x'.repeat(SIMULATOR_CONTROL_LEASE_ID_MAX_LENGTH + 1);
        await expect(dispatch({ ...base, type: 'simulator.lease.renew', leaseId: garbage })).rejects.toMatchObject({ issues: [expect.objectContaining({ code: 'too_big', path: ['event', 'leaseId'] })] });
        await expect(dispatch({ type: 'simulator.lease.release', simulatorId: 'sim', streamId, sourceId, leaseId: garbage })).rejects.toMatchObject({ issues: [expect.objectContaining({ code: 'too_big', path: ['event', 'leaseId'] })] });
        await expect(dispatch({ type: 'simulator.control.send', control: { v: 1, kind: 'tap', streamId, sourceId, eventId: 'bad-tap', leaseId: garbage, x: 0.5, y: 0.5 } })).rejects.toThrow();
        expect(sent).toBe(4);
        await expect(dispatchSimulatorPreviewActionV1(async () => ({ protocolVersion: 1, result: {
            v: 1, status: 'accepted', eventType: 'simulator.lease.acquire',
            lease: { ...acquired.result.lease, leaseId: garbage },
        } }), { machineId: 'machine', event: { ...base, type: 'simulator.lease.acquire' } })).resolves.toEqual({ ok: false, reason: 'invalid_response' });
    });
});
