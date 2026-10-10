import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TRANSFER_RELAY_V2_SOCKET_EVENT, type TransferRelayV2SendEnvelope } from '@happier-dev/protocol';
import { installSessionOpsNetworkBoundary } from '@/dev/testkit/harness/sessionOpsNetworkBoundary';

const boundary = await installSessionOpsNetworkBoundary();
const { loadSyncSingletonForTests } = await import('@/dev/testkit/harness/syncSingletonLoader');
await loadSyncSingletonForTests();
const { resolveServerScopedTransferRelaySocket } = await import('./serverScopedTransferRelaySocket');
const { serverScopedRpcSocketPool } = await import('./serverScopedRpcSocketPool');
const { resetServerReachabilitySupervisors } = await import('@/sync/runtime/connectivity/serverReachabilitySupervisorPool');
const { upsertAndActivateServer } = await import('@/sync/domains/server/serverRuntime');
const { restoreConnectionToActiveServer, disconnectActiveServerConnection } = await import('@/sync/runtime/orchestration/connectionManager');
const { storage } = await import('@/sync/domains/state/storage');
const { profileDefaults } = await import('@/sync/domains/profiles/profile');
let activeHome: Awaited<ReturnType<typeof boundary.addHome>>;
let scopedHome: Awaited<ReturnType<typeof boundary.addHome>>;

function envelope(scopeUserId: string): TransferRelayV2SendEnvelope {
    return {
        scopeUserId,
        sender: { kind: 'user', socketId: 'socket-source' },
        recipient: { kind: 'machine', machineId: 'machine-1' },
        envelope: { transferId: 'transfer-1', kind: 'ack', nextSequence: 2 },
    };
}

afterAll(() => boundary.dispose());

describe('resolveServerScopedTransferRelaySocket (real scoped network)', () => {
    beforeEach(async () => {
        boundary.resetRequests();
        activeHome = await boundary.addHome('https://server-a.example.test', 'account-a');
        scopedHome = await boundary.addHome('https://server-b.example.test', 'account-b');
        await upsertAndActivateServer({ serverUrl: activeHome.serverUrl });
        await restoreConnectionToActiveServer({ token: activeHome.token });
        storage.getState().applyProfile({ ...profileDefaults, id: activeHome.accountId });
        await vi.waitFor(() => expect(boundary.socketBoundaries.some((network) =>
            network.serverUrl === activeHome.serverUrl && network.socket.connected,
        )).toBe(true));
    });

    afterEach(async () => {
        await disconnectActiveServerConnection();
        await serverScopedRpcSocketPool.stopAll();
        await resetServerReachabilitySupervisors();
    });

    it('uses the active apiSocket when the target server is active', async () => {
        const client = await resolveServerScopedTransferRelaySocket({
            machineId: 'machine-1', serverId: activeHome.id, timeoutMs: 1_000,
        });
        expect(client).toMatchObject({ scopeUserId: activeHome.accountId, machineId: 'machine-1' });
        const network = boundary.socketBoundaries.find((socket) => socket.serverUrl === activeHome.serverUrl);
        if (!network) throw new Error('Expected active Socket.IO boundary');
        const listener = vi.fn();
        const unsubscribe = client.onEnvelope(listener);
        const payload = envelope(activeHome.accountId);
        client.sendEnvelope(payload);
        expect(network.socket.emit).toHaveBeenCalledWith(TRANSFER_RELAY_V2_SOCKET_EVENT, payload);
        network.trigger(TRANSFER_RELAY_V2_SOCKET_EVENT, payload);
        expect(listener).toHaveBeenCalledWith(payload, { serverId: activeHome.id });
        unsubscribe();
        listener.mockClear();
        network.trigger(TRANSFER_RELAY_V2_SOCKET_EVENT, payload);
        expect(listener).not.toHaveBeenCalled();
        await client.disconnect();
        expect(boundary.socketBoundaries.filter((socket) => socket.serverUrl === scopedHome.serverUrl)).toHaveLength(0);
    });

    it('uses the target Home Account and a scoped socket when that Home is not active', async () => {
        const client = await resolveServerScopedTransferRelaySocket({
            machineId: 'machine-1', serverId: scopedHome.id, timeoutMs: 2_000,
        });
        expect(client).toMatchObject({ scopeUserId: scopedHome.accountId, machineId: 'machine-1' });
        const network = boundary.socketBoundaries.find((socket) => socket.serverUrl === scopedHome.serverUrl);
        if (!network) throw new Error('Expected scoped Socket.IO boundary');
        expect(network.token).toBe(scopedHome.token);
        const listener = vi.fn();
        const unsubscribe = client.onEnvelope(listener);
        const payload = envelope(scopedHome.accountId);
        client.sendEnvelope(payload);
        expect(network.socket.emit).toHaveBeenCalledWith(TRANSFER_RELAY_V2_SOCKET_EVENT, payload);
        network.trigger(TRANSFER_RELAY_V2_SOCKET_EVENT, payload);
        expect(listener).toHaveBeenCalledWith(payload);
        unsubscribe();
        listener.mockClear();
        network.trigger(TRANSFER_RELAY_V2_SOCKET_EVENT, payload);
        expect(listener).not.toHaveBeenCalled();
        await client.disconnect();
        expect(network.socket.disconnect).not.toHaveBeenCalled();
    });

    it('fails closed when the active account profile id is unavailable', async () => {
        storage.getState().applyProfile({ ...profileDefaults });
        await expect(resolveServerScopedTransferRelaySocket({
            machineId: 'machine-1', serverId: activeHome.id, timeoutMs: 1_000,
        })).rejects.toThrow('Active account profile id is unavailable for transfer relay');
    });
});
