import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installSessionOpsNetworkBoundary } from '@/dev/testkit/harness/sessionOpsNetworkBoundary';
import { waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { EphemeralUpdateSchema } from '@happier-dev/protocol/updates';

const boundary = await installSessionOpsNetworkBoundary();
const { loadSyncSingletonForTests } = await import('@/dev/testkit/harness/syncSingletonLoader');
await loadSyncSingletonForTests();
const { apiSocket } = await import('./apiSocket');
const owner = await import('@/sync/domains/machines/reachability/machineReachability');
let home: Awaited<ReturnType<typeof boundary.addHome>>;
const disposers: Array<() => void> = [];

beforeEach(async () => {
    boundary.resetRequests();
    owner.clearMachineRequestReachabilityForTest();
    home = await boundary.addHome('https://reachability.example.test', 'account-a');
    apiSocket.initialize({ endpoint: home.serverUrl, serverId: home.id, token: home.token,
        request: async () => Response.json({ cursor: 0 }), isCurrent: () => true }, null);
    await waitForHomeGovernance(() => expect(boundary.socketBoundaries.at(-1)?.socket.connected).toBe(true));
});
afterEach(() => { for (const dispose of disposers.splice(0)) dispose(); apiSocket.disconnect(); owner.clearMachineRequestReachabilityForTest(); vi.useRealTimers(); });
afterAll(() => boundary.dispose());

describe('Machine reachability through the authenticated socket ingress', () => {
    it('retains the 65-Machine online/offline fleet across socket loss, reconnect and errors', async () => {
        const { resolveMachinePickerPresence } = await import('@/sync/domains/machines/identity/resolveMachinePickerPresence');
        const socket = boundary.socketBoundaries.at(-1)!;
        const scope = { serverId: home.id, accountId: 'account-a' };
        const now = Date.now();
        const machines = Array.from({ length: 65 }, (_, index) => ({
            id: `machine-${index}`, active: index < 2, activeAt: index < 2 ? now : now - 97_000,
            presenceProtocolVersion: 1 as const,
        }));
        const statuses = () => machines.map(machine => resolveMachinePickerPresence(machine, Date.now(), scope).status);
        expect(statuses()).toEqual([...Array(2).fill('online'), ...Array(63).fill('offline')]);
        const initial = statuses();
        socket.trigger('disconnect', 'transport close');
        expect(statuses()).toEqual(initial);
        socket.trigger('connect');
        expect(statuses()).toEqual(initial);
        socket.trigger('connect_error', new Error('Transport unavailable'));
        expect(statuses()).toEqual(initial);
    });
    it('retains reachability through loss and reconnect until fresh activity changes it', async () => {
        const { resolveMachinePickerPresence } = await import('@/sync/domains/machines/identity/resolveMachinePickerPresence');
        const { resolveMachineSpawnReadiness, canAttemptMachineSpawn } = await import('@/sync/domains/machines/identity/resolveMachineSpawnReadiness');
        const socket = boundary.socketBoundaries.at(-1)!;
        const scope = { serverId: home.id, accountId: 'account-a' };
        const now = Date.now();
        const { createMachineFixture } = await import('@/dev/testkit');
        const { storage } = await import('@/sync/domains/state/storage');
        const { flushMachineActivityUpdates } = await import('@/sync/engine/socket/socket');
        const { resolveServerScopedMachine } = await import('@/sync/domains/machines/resolveServerScopedMachine');
        const previousState = storage.getState();
        let machine = createMachineFixture({ id: 'machine', active: true, activeAt: now, presenceProtocolVersion: 1 });
        storage.getState().applyMachines([machine], false, { sourceServerId: scope.serverId });
        const unsubscribe = apiSocket.onMessage('ephemeral', (raw) => {
            const { success, data } = EphemeralUpdateSchema.safeParse(raw);
            if (!success || data.type !== 'machine-activity') return;
            const observe = owner.captureMachinePresenceObservation(scope);
            flushMachineActivityUpdates({ updates: new Map([[data.id, data]]), sourceServerId: scope.serverId });
            machine = resolveServerScopedMachine(storage.getState(), scope.serverId, machine.id) ?? machine;
            observe([data.id]);
        });
        disposers.push(() => { unsubscribe(); storage.setState(previousState, true); });
        expect(resolveMachinePickerPresence(machine, now, scope).status).toBe('online');
        socket.trigger('disconnect', 'transport close');
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(now + 97_000);
        const checkRetained = () => {
            expect.soft(resolveMachinePickerPresence(machine, Date.now(), scope)).toEqual({ status: 'online', selectable: true });
            expect.soft(owner.isMachineReachable(scope, machine)).toBe(true);
            expect.soft(resolveMachineSpawnReadiness({ selectedMachineId: machine.id, machine, scope }).status).toBe('ready');
            expect.soft(resolveMachineSpawnReadiness({ selectedMachineId: machine.id, machine, scope, machineReachable: false }).status).toBe('offline');
            expect.soft(canAttemptMachineSpawn({ selectedMachineId: machine.id, machine, scope })).toBe(true);
        };
        checkRetained();
        socket.trigger('connect');
        checkRetained();
        socket.trigger('ephemeral', { type: 'machine-activity', id: 'another-machine', active: true, activeAt: Date.now() });
        checkRetained();
        // Other Home/Account facts are not withdrawn by this socket.
        expect(resolveMachinePickerPresence(machine, now, { ...scope, accountId: 'account-b' }).status).toBe('online');
        expect(resolveMachinePickerPresence(machine, now, { ...scope, serverId: 'another-home' }).status).toBe('online');
        socket.trigger('ephemeral', { type: 'machine-activity', id: machine.id, active: true, activeAt: Date.now() });
        expect(owner.resolveMachineReachability(scope, machine)).toBe('reachable');
        expect(resolveMachinePickerPresence({ ...machine, activeAt: Date.now() }, Date.now(), scope).status).toBe('online');
        expect(owner.resolveMachineReachability(scope, { ...machine, revokedAt: now })).toBe('unreachable');
        // A real offline observation must restore the ordinary offline verdict.
        socket.trigger('disconnect', 'transport close');
        socket.trigger('connect');
        vi.setSystemTime(now + 194_000);
        socket.trigger('ephemeral', { type: 'machine-activity', id: machine.id, active: false, activeAt: now + 97_001 });
        expect(resolveMachinePickerPresence({ ...machine, active: false }, Date.now(), scope).status).toBe('offline');
    });
    describe('intentional visibility pause', () => {
        async function presenceFixture() {
            const { createMachineFixture } = await import('@/dev/testkit');
            const { storage } = await import('@/sync/domains/state/storage');
            const scope = { serverId: home.id, accountId: 'account-a' };
            const machine = createMachineFixture({ id: 'machine', active: true, activeAt: Date.now(), presenceProtocolVersion: 1 });
            const previousState = storage.getState();
            storage.getState().applyMachines([machine], false, { sourceServerId: scope.serverId });
            disposers.push(() => storage.setState(previousState, true));
            // Fresh presence for this machine has been observed on the live socket.
            owner.captureMachinePresenceObservation(scope)([machine.id]);
            return { scope, machine };
        }
        const reconnect = async () => {
            apiSocket.initialize({ endpoint: home.serverUrl, serverId: home.id, token: home.token,
                request: async () => Response.json({ cursor: 0 }), isCurrent: () => true }, null);
            await waitForHomeGovernance(() => expect(boundary.socketBoundaries.at(-1)?.socket.connected).toBe(true));
        };
        it('keeps retained presence through a pause and resume until fresh presence arrives', async () => {
            const { scope, machine } = await presenceFixture();
            expect(owner.resolveMachineReachability(scope, machine)).toBe('reachable');
            apiSocket.disconnect({ visibilityPause: true });
            expect(owner.resolveMachineReachability(scope, machine)).toBe('reachable');
            await reconnect();
            expect(owner.resolveMachineReachability(scope, machine)).toBe('reachable');
        });
        it('becomes unreachable once fresh presence says the machine went offline while paused', async () => {
            const { scope, machine } = await presenceFixture();
            apiSocket.disconnect({ visibilityPause: true });
            await reconnect();
            boundary.socketBoundaries.at(-1)!.trigger('ephemeral', { type: 'machine-activity', id: machine.id, active: false, activeAt: Date.now() });
            const { resolveServerScopedMachine } = await import('@/sync/domains/machines/resolveServerScopedMachine');
            const { storage } = await import('@/sync/domains/state/storage');
            const fresh = resolveServerScopedMachine(storage.getState(), scope.serverId, machine.id) ?? machine;
            expect(owner.resolveMachineReachability(scope, { ...fresh, active: false })).toBe('unreachable');
        });
        it('keeps the admitted Account mode through a pause and revalidates it once fresh transport arrives', async () => {
            const { getAccountEncryptionModeCacheRevision } = await import('@/sync/api/account/apiAccountEncryptionMode');
            const admitted = getAccountEncryptionModeCacheRevision(home.id);
            apiSocket.disconnect({ visibilityPause: true });
            expect(getAccountEncryptionModeCacheRevision(home.id)).toBe(admitted);
            await reconnect();
            expect(getAccountEncryptionModeCacheRevision(home.id)).toBeGreaterThan(admitted);
        });
        it('still withdraws the Account mode on a plain disconnect', async () => {
            const { getAccountEncryptionModeCacheRevision } = await import('@/sync/api/account/apiAccountEncryptionMode');
            const admitted = getAccountEncryptionModeCacheRevision(home.id);
            apiSocket.disconnect();
            expect(getAccountEncryptionModeCacheRevision(home.id)).toBeGreaterThan(admitted);
        });
        it('keeps known presence on a plain disconnect', async () => {
            const { scope, machine } = await presenceFixture();
            apiSocket.disconnect();
            expect(owner.resolveMachineReachability(scope, machine)).toBe('reachable');
        });
    });
    it('keeps a request-scoped Forbidden response from poisoning Machine reachability through the real scoped RPC owner', async () => {
        const { machineRpcWithServerScope } = await import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc');
        const { RPC_ERROR_CODES, RPC_METHODS } = await import('@happier-dev/protocol/rpc');
        const scope = { serverId: home.id, accountId: 'account-a' };
        boundary.setRpcAckResponder(async request => request.method === RPC_METHODS.CAPABILITIES_DESCRIBE
            ? { ok: false, error: 'Forbidden', errorCode: RPC_ERROR_CODES.FORBIDDEN }
            : { ok: true, result: { available: true } });
        const call = (method: string) => machineRpcWithServerScope({ ...scope, machineId: 'machine', method,
            payload: {}, preferScoped: true, onIssued: () => {} });
        await expect(call(RPC_METHODS.CAPABILITIES_DESCRIBE)).rejects.toMatchObject({ rpcErrorCode: RPC_ERROR_CODES.FORBIDDEN });
        expect(owner.readMachineRequestReachabilityObservation(scope, 'machine')).toBeNull();
        expect(owner.isMachineReachable(scope, { id: 'machine', active: true })).toBe(true);
        await expect(call(RPC_METHODS.DAEMON_MEMORY_STATUS)).resolves.toEqual({ available: true });
        expect(owner.readMachineRequestReachabilityObservation(scope, 'machine')?.outcome).toBe('succeeded');
    });
    it('preserves heartbeat failures and heals only the re-established socket Home and Account', () => {
        const socket = boundary.socketBoundaries.at(-1)!;
        const scope = { serverId: home.id, accountId: 'account-a' };
        const otherAccount = { ...scope, accountId: 'account-b' };
        const otherHome = { ...scope, serverId: 'other-home' };
        for (const identity of [scope, otherAccount, otherHome]) {
            owner.recordMachineRequestFailed({ ...identity, machineId: 'machine' });
            owner.recordMachineRequestFailed({ ...identity, machineId: 'machine', route: 'loopback_direct' });
        }
        socket.trigger('ephemeral', { type: 'machine-activity', id: 'machine', active: true, activeAt: Date.now() });
        expect(owner.readMachineRequestReachabilityObservation(scope, 'machine')?.outcome).toBe('failed');
        expect(owner.readMachineRequestReachabilityObservation(scope, 'machine', 'loopback_direct')?.outcome).toBe('failed');
        socket.trigger('disconnect', 'transport close');
        socket.trigger('connect');
        expect(owner.readMachineRequestReachabilityObservation(scope, 'machine')).toBeNull();
        expect(owner.readMachineRequestReachabilityObservation(scope, 'machine', 'loopback_direct')).toBeNull();
        expect(owner.readMachineRequestReachabilityObservation(otherAccount, 'machine')?.outcome).toBe('failed');
        expect(owner.readMachineRequestReachabilityObservation(otherHome, 'machine')?.outcome).toBe('failed');
        expect(owner.readMachineRequestReachabilityObservation(otherAccount, 'machine', 'loopback_direct')?.outcome).toBe('failed');
        expect(owner.readMachineRequestReachabilityObservation(otherHome, 'machine', 'loopback_direct')?.outcome).toBe('failed');
    });

    it('heals only the admitted Machine reconnect and ignores malformed, inactive and retired ingress', () => {
        const socket = boundary.socketBoundaries.at(-1)!;
        const scope = { serverId: home.id, accountId: 'account-a' };
        owner.recordMachineRequestFailed({ ...scope, machineId: 'machine' });
        owner.recordMachineRequestFailed({ ...scope, machineId: 'other-machine' });
        owner.recordMachineRequestFailed({ ...scope, accountId: 'account-b', machineId: 'machine' });
        for (const payload of [
            { type: 'machine-activity', id: 'machine', active: true, activeAt: 100 },
            { type: 'machine-activity', id: 'machine', active: true, activeAt: 100, reconnected: 'true' },
            { type: 'machine-activity', id: 'machine', active: false, activeAt: 100, reconnected: true },
        ]) {
            socket.trigger('ephemeral', payload);
            expect(owner.readMachineRequestReachabilityObservation(scope, 'machine')?.outcome).toBe('failed');
        }
        socket.trigger('ephemeral', { type: 'machine-activity', id: 'machine', active: true, activeAt: 101, reconnected: true });
        expect(owner.readMachineRequestReachabilityObservation(scope, 'machine')).toBeNull();
        expect(owner.readMachineRequestReachabilityObservation(scope, 'other-machine')?.outcome).toBe('failed');
        expect(owner.readMachineRequestReachabilityObservation({ ...scope, accountId: 'account-b' }, 'machine')?.outcome).toBe('failed');
        owner.recordMachineRequestFailed({ ...scope, machineId: 'machine' });
        apiSocket.disconnect();
        socket.trigger('ephemeral', { type: 'machine-activity', id: 'machine', active: true, activeAt: 102, reconnected: true });
        socket.trigger('connect');
        expect(owner.readMachineRequestReachabilityObservation(scope, 'machine')?.outcome).toBe('failed');
    });

    it('never gives a Session-scoped socket Account-wide Machine recovery authority', async () => {
        apiSocket.initialize({ endpoint: home.serverUrl, serverId: home.id, token: home.token,
            socketRole: { clientType: 'session-scoped', sessionId: 'frame-session' },
            request: async () => Response.json({ cursor: 0 }), isCurrent: () => true }, null);
        await waitForHomeGovernance(() => expect(boundary.socketBoundaries.at(-1)?.socket.connected).toBe(true));
        const socket = boundary.socketBoundaries.at(-1)!;
        const scope = { serverId: home.id, accountId: 'account-a' };
        expect(owner.resolveMachineReachability(scope, { id: 'unaffected', active: true })).toBe('reachable');
        owner.recordMachineRequestFailed({ ...scope, machineId: 'machine' });
        socket.trigger('ephemeral', { type: 'machine-activity', id: 'machine', active: true, activeAt: 100, reconnected: true });
        socket.trigger('disconnect', 'transport close');
        socket.trigger('connect');
        expect(owner.readMachineRequestReachabilityObservation(scope, 'machine')?.outcome).toBe('failed');
    });
});
