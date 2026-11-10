import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SESSION_CONSUMPTION_REPLACE_EVENT, type SessionConsumptionReplaceAckV1 } from '@happier-dev/protocol/sessions';

import { createSocketIoBoundaryStub } from '@/dev/testkit/mocks/socketIo';
import { resetRuntimeFetch, setRuntimeFetch } from '@/utils/system/runtimeFetch';
import { resetServerReachabilitySupervisors } from '@/sync/runtime/connectivity/serverReachabilitySupervisorPool';
import { createServerScopedRpcSocketPool } from './serverScopedRpcSocketPool';

const network = vi.hoisted(() => ({ io: vi.fn() }));
vi.mock('socket.io-client', () => ({ io: network.io }));

const scope = { serverUrl: 'https://session-browser.example.test', token: 'recipient-token', timeoutMs: 1_000 };
const declaration = { v: 1, liveSessionIds: ['shared-session'], durableSessionIds: [] };
const admitted: SessionConsumptionReplaceAckV1 = { ok: true, v: 1, liveSessionIds: ['shared-session'], durableSessionIds: [] };
const pools: ReturnType<typeof createServerScopedRpcSocketPool>[] = [];

function createPool() {
    const pool = createServerScopedRpcSocketPool();
    pools.push(pool);
    return pool;
}

beforeEach(() => {
    network.io.mockReset();
    setRuntimeFetch(async () => Response.json({ ok: true }));
});
afterEach(async () => {
    for (const pool of pools.splice(0)) { await pool.stopAll(); pool.resetForTests(); }
    await resetServerReachabilitySupervisors();
    resetRuntimeFetch();
    vi.useRealTimers();
});

describe('Session-scoped socket consumption readiness', () => {
    it('shares only the same admitted Session and selects the existing consumption-capable socket purpose', async () => {
        vi.useFakeTimers();
        const boundaries: ReturnType<typeof createSocketIoBoundaryStub>[] = [];
        network.io.mockImplementation(() => {
            const boundary = createSocketIoBoundaryStub();
            boundaries.push(boundary);
            return boundary.socket;
        });
        const pool = createPool();
        const first = await pool.acquire({ ...scope, sessionId: 'shared-session' });
        const same = await pool.acquire({ ...scope, sessionId: 'shared-session' });
        const other = await pool.acquire({ ...scope, sessionId: 'another-session' });
        const rpc = await pool.acquire(scope);
        await vi.advanceTimersByTimeAsync(60_000);
        expect(boundaries).toHaveLength(3);
        expect(network.io.mock.calls.map(([, options]) => options.auth.clientPurpose))
            .toEqual(['concurrent-server-cache', 'concurrent-server-cache', 'scoped-rpc']);
        expect(boundaries[0]!.socket.emitWithAck.mock.calls).toEqual([[SESSION_CONSUMPTION_REPLACE_EVENT, declaration]]);
        expect(boundaries[1]!.socket.emitWithAck.mock.calls).toEqual([[SESSION_CONSUMPTION_REPLACE_EVENT,
            { v: 1, liveSessionIds: ['another-session'], durableSessionIds: [] }]]);
        expect(boundaries[2]!.socket.emitWithAck).not.toHaveBeenCalled();
        expect(first.connected && same.connected && other.connected && rpc.connected).toBe(true);
        first.disconnect();
        expect(boundaries[0]!.socket.connected).toBe(true);
        same.disconnect();
        await vi.advanceTimersByTimeAsync(0);
        expect(boundaries[0]!.socket.active).toBe(false);
        expect(boundaries[1]!.socket.connected).toBe(true);
        other.disconnect(); rpc.disconnect();
    });

    it('waits for exact Session admission for every concurrent borrower and redeclares before reconnect readiness', async () => {
        const boundary = createSocketIoBoundaryStub();
        let acknowledge!: (ack: SessionConsumptionReplaceAckV1) => void;
        boundary.socket.emitWithAck.mockImplementation(async () => await new Promise(resolve => { acknowledge = resolve; }));
        network.io.mockReturnValue(boundary.socket);
        const pool = createPool();
        let ready = 0;
        const pending = pool.acquire({ ...scope, sessionId: 'shared-session' }).then(client => { ready += 1; return client; });
        await vi.waitFor(() => expect(boundary.socket.emitWithAck).toHaveBeenCalledTimes(1));
        const joining = pool.acquire({ ...scope, sessionId: 'shared-session' }).then(client => { ready += 1; return client; });
        await Promise.resolve();
        expect(ready).toBe(0);
        acknowledge(admitted);
        const [client, joined] = await Promise.all([pending, joining]);
        const connected = vi.fn();
        client.on('connect', connected);
        boundary.trigger('disconnect', 'transport close');
        expect(client.connected).toBe(false);
        expect(client.getSocketId()).toBe('');
        boundary.socket.id = 'reconnected-socket';
        boundary.trigger('connect');
        await vi.waitFor(() => expect(boundary.socket.emitWithAck).toHaveBeenCalledTimes(2));
        expect(client.connected).toBe(false);
        expect(client.getSocketId()).toBe('');
        expect(connected).not.toHaveBeenCalled();
        acknowledge(admitted);
        await vi.waitFor(() => expect(connected).toHaveBeenCalledTimes(1));
        expect(client.connected).toBe(true);
        expect(client.getSocketId()).toBe('reconnected-socket');
        client.off('connect', connected);
        boundary.trigger('disconnect', 'transport close'); boundary.trigger('connect');
        acknowledge(admitted);
        await Promise.resolve(); await Promise.resolve();
        expect(connected).toHaveBeenCalledTimes(1);
        expect(boundary.socket.emitWithAck.mock.calls).toEqual(Array.from({ length: 3 }, () => [SESSION_CONSUMPTION_REPLACE_EVENT, declaration]));
        client.disconnect(); joined.disconnect();
    });

    it('keeps admission inside the existing connection budget and ignores its late ACK after cancellation', async () => {
        vi.useFakeTimers();
        const boundary = createSocketIoBoundaryStub();
        let acknowledge!: (ack: SessionConsumptionReplaceAckV1) => void;
        boundary.socket.emitWithAck.mockImplementation(async () => await new Promise(resolve => { acknowledge = resolve; }));
        network.io.mockReturnValue(boundary.socket);
        const pool = createPool();
        const expired = pool.acquire({ ...scope, sessionId: 'shared-session' }).catch((error: unknown) => error);
        await vi.advanceTimersByTimeAsync(0);
        expect(boundary.socket.emitWithAck).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(scope.timeoutMs);
        expect(await expired).toMatchObject({ code: 'MACHINE_RPC_TIMEOUT', connectionPhase: 'socket-connect' });
        expect(boundary.socket.connected).toBe(false);
        acknowledge(admitted);
        await vi.advanceTimersByTimeAsync(0);
        expect(boundary.socket.connected).toBe(false);
        boundary.socket.emitWithAck.mockResolvedValue(admitted);
        const recovered = await pool.acquire({ ...scope, sessionId: 'shared-session' });
        expect(recovered.connected).toBe(true);
        // The last Session holder retired after expiry, so recovery owns a fresh connection.
        expect(network.io).toHaveBeenCalledTimes(2);
        expect(boundary.socket.emitWithAck).toHaveBeenCalledTimes(2);
        recovered.disconnect();
    });

    it.each([
        [{ ok: false, error: 'not_allowed' }, 'session_consumption_not_allowed'],
        [{ ok: true, v: 1, liveSessionIds: ['different-session'], durableSessionIds: [] }, 'session_consumption_partial_admission'],
        [{ ok: true }, 'session_consumption_invalid_ack'],
    ])('refuses unavailable admission and retires the socket and carrier (%j)', async (ack, reason) => {
        const boundary = createSocketIoBoundaryStub();
        boundary.socket.emitWithAck.mockResolvedValue(ack);
        network.io.mockReturnValue(boundary.socket);
        const releaseCarrier = vi.fn(async () => {});
        const pool = createPool();
        await expect(pool.acquire({ ...scope, sessionId: 'shared-session', releaseCarrier })).rejects.toThrow(String(reason));
        expect(boundary.socket.connected).toBe(false);
        expect(boundary.socket.active).toBe(false);
        expect(releaseCarrier).toHaveBeenCalledTimes(1);
        expect(boundary.socket.emitWithAck).toHaveBeenCalledTimes(1);
    });

    it('closes a retained stream when Session admission is refused on reconnect', async () => {
        const boundary = createSocketIoBoundaryStub();
        network.io.mockReturnValue(boundary.socket);
        const releaseCarrier = vi.fn(async () => {});
        const pool = createPool();
        const client = await pool.acquire({ ...scope, sessionId: 'shared-session', releaseCarrier });
        const connected = vi.fn();
        const disconnected = vi.fn();
        client.on('connect', connected); client.on('disconnect', disconnected);
        boundary.socket.emitWithAck.mockResolvedValue({ ok: false, error: 'not_allowed' });
        boundary.trigger('disconnect', 'transport close'); boundary.trigger('connect');
        await vi.waitFor(() => expect(releaseCarrier).toHaveBeenCalledTimes(1));
        expect(client.connected).toBe(false);
        expect(client.getSocketId()).toBe('');
        expect(boundary.socket.active).toBe(false);
        expect(connected).not.toHaveBeenCalled();
        expect(disconnected).toHaveBeenCalled();
        client.disconnect();
    });
});
