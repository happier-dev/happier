import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installSessionOpsNetworkBoundary } from '@/dev/testkit/harness/sessionOpsNetworkBoundary';

const boundary = await installSessionOpsNetworkBoundary();
const { loadSyncSingletonForTests } = await import('@/dev/testkit/harness/syncSingletonLoader');
await loadSyncSingletonForTests();
const { createServerScopedRelaySocket } = await import('./serverScopedRelaySocket');
const { serverScopedRpcSocketPool } = await import('./serverScopedRpcSocketPool');
const { resetServerReachabilitySupervisors } = await import('@/sync/runtime/connectivity/serverReachabilitySupervisorPool');
const { upsertAndActivateServer } = await import('@/sync/domains/server/serverRuntime');
const { restoreConnectionToActiveServer, disconnectActiveServerConnection } = await import('@/sync/runtime/orchestration/connectionManager');
const { storage } = await import('@/sync/domains/state/storage');
const { profileDefaults } = await import('@/sync/domains/profiles/profile');
let home: Awaited<ReturnType<typeof boundary.addHome>>;
let activeConnection = false;

type RelayParams = Parameters<typeof createServerScopedRelaySocket<string>>[0];
const unusedActiveTransport = { send: () => {}, on: () => () => {} };

function createScopedRelay(overrides: Partial<RelayParams> = {}) {
    return createServerScopedRelaySocket<string>({
        machineId: 'machine-2', serverId: home.id, timeoutMs: 2_000,
        createActiveTransport: unusedActiveTransport,
        createScopedTransport: (socket) => ({
            send: (payload) => socket.emit('payload', payload),
            on: (listener) => {
                socket.on('payload', listener);
                return () => socket.off('payload', listener);
            },
        }),
        ...overrides,
    });
}

afterAll(() => boundary.dispose());

describe('createServerScopedRelaySocket (real scoped network)', () => {
    beforeEach(async () => {
        boundary.resetRequests();
        home = await boundary.addHome('https://server-b.example.test', 'account-b');
    });

    afterEach(async () => {
        if (activeConnection) {
            await disconnectActiveServerConnection();
            activeConnection = false;
        }
        await serverScopedRpcSocketPool.stopAll();
        await resetServerReachabilitySupervisors();
    });

    it('uses the active transport and its configured socket id', async () => {
        await upsertAndActivateServer({ serverUrl: home.serverUrl });
        await restoreConnectionToActiveServer({ token: home.token });
        activeConnection = true;
        storage.getState().applyProfile({ ...profileDefaults, id: home.accountId });
        const activeTransport = { send: vi.fn(), on: vi.fn(() => () => {}) };
        const scopedTransport = vi.fn<RelayParams['createScopedTransport']>();
        const client = await createServerScopedRelaySocket<string>({
            machineId: 'machine-1', serverId: home.id,
            createActiveTransport: activeTransport, createScopedTransport: scopedTransport,
            getActiveSocketId: () => 'active-socket-1',
        });

        expect(client).toMatchObject({ scopeUserId: home.accountId, machineId: 'machine-1', socketId: 'active-socket-1' });
        client.sendEnvelope('active-payload');
        expect(activeTransport.send).toHaveBeenCalledWith('active-payload');
        const listener = vi.fn();
        client.onEnvelope(listener)();
        expect(activeTransport.on).toHaveBeenCalledWith(listener);
        expect(scopedTransport).not.toHaveBeenCalled();
        await client.disconnect();
    });

    it('prefers an explicit scoped socket id and delivers envelopes through that Home', async () => {
        const client = await createScopedRelay({
            getScopedSocketId: () => 'overridden-socket-id',
            createScopedTransport: (socket) => ({
                socketId: 'transport-socket-id',
                send: (payload) => socket.emit('payload', payload),
                on: (listener) => {
                    socket.on('payload', listener);
                    return () => socket.off('payload', listener);
                },
            }),
        });
        expect(client).toMatchObject({ scopeUserId: home.accountId, machineId: 'machine-2', socketId: 'overridden-socket-id' });
        const network = boundary.socketBoundaries[0];
        if (!network) throw new Error('Expected scoped Socket.IO boundary');
        expect(network).toMatchObject({ serverUrl: home.serverUrl, token: home.token });
        const listener = vi.fn();
        const unsubscribe = client.onEnvelope(listener);
        network.trigger('payload', 'incoming');
        expect(listener).toHaveBeenCalledWith('incoming');
        client.sendEnvelope('outgoing');
        expect(network.socket.emit).toHaveBeenCalledWith('payload', 'outgoing');
        unsubscribe();
        listener.mockClear();
        network.trigger('payload', 'after-unsubscribe');
        expect(listener).not.toHaveBeenCalled();
        await client.disconnect();
    });

    it.each(['transport', 'socket'] as const)('falls back to the %s socket id when earlier choices are absent', async (source) => {
        const client = await createScopedRelay({
            createScopedTransport: () => ({
                send: () => {}, on: () => () => {},
                ...(source === 'transport' ? { socketId: 'transport-socket-id' } : {}),
            }),
        });
        expect(client.socketId).toBe(source === 'transport' ? 'transport-socket-id' : boundary.socketBoundaries[0].socket.id);
        await client.disconnect();
    });

    it('leaves the physical socket reusable after a logical relay disconnect', async () => {
        const first = await createScopedRelay();
        const physical = boundary.socketBoundaries[0].socket;
        await first.disconnect();
        expect(physical.disconnect).not.toHaveBeenCalled();
        const second = await createScopedRelay();
        second.sendEnvelope('reused');
        expect(boundary.socketBoundaries).toHaveLength(1);
        expect(physical.emit).toHaveBeenCalledWith('payload', 'reused');
        await second.disconnect();
        await serverScopedRpcSocketPool.stopAll();
        expect(physical.connected).toBe(false);
    });

    it('drops the failed adapter use while the real pool retains a reusable socket', async () => {
        await expect(createScopedRelay({
            createScopedTransport: () => { throw new Error('transport failed'); },
        })).rejects.toThrow('transport failed');
        const physical = boundary.socketBoundaries[0].socket;
        expect(physical.disconnect).not.toHaveBeenCalled();
        const recovered = await createScopedRelay();
        recovered.sendEnvelope('recovered');
        expect(boundary.socketBoundaries).toHaveLength(1);
        expect(physical.emit).toHaveBeenCalledWith('payload', 'recovered');
        await recovered.disconnect();
    });

    it('can acquire the Home again after Socket.IO construction fails', async () => {
        boundary.setSocketConfigurator(() => { throw new Error('socket failed'); });
        await expect(createScopedRelay()).rejects.toThrow('socket failed');
        expect(boundary.socketBoundaries[0].socket.connected).toBe(false);
        boundary.setSocketConfigurator(() => {});
        const recovered = await createScopedRelay();
        expect(boundary.socketBoundaries).toHaveLength(2);
        recovered.sendEnvelope('recovered-after-connect-failure');
        expect(boundary.socketBoundaries[1].socket.emit).toHaveBeenCalledWith('payload', 'recovered-after-connect-failure');
        await recovered.disconnect();
    });
});
