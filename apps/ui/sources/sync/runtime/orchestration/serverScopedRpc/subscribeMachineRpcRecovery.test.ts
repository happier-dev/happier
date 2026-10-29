import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSocketIoBoundaryStub } from '@/dev/testkit/mocks/socketIo';
import { createAccountTokenForTests } from '@/dev/testkit/harness/homeGovernanceHarness';
import { clearMachineRequestReachabilityForMachine } from '@/sync/domains/machines/reachability/machineReachability';
import { publishHomeAccountChange } from '@/sync/runtime/orchestration/homeAccountChange';

const network = vi.hoisted(() => ({ connect: vi.fn() }));
// Only the external Socket.IO transport is replaced; ApiSocket and recovery stay real.
vi.mock('socket.io-client', async importOriginal => ({
    ...await importOriginal<typeof import('socket.io-client')>(),
    io: (...args: unknown[]) => network.connect(...args),
}));

import { apiSocket } from '@/sync/api/session/apiSocket';
import { subscribeMachineRpcRecovery } from './subscribeMachineRpcRecovery';

const scope = { serverId: 'rpc-recovery-home', accountId: 'rpc-recovery-account' };
const input = { ...scope, expectedAccountId: scope.accountId, machineId: 'machine-one' };
const subscriptions: Array<() => void> = [];

async function connect(accountId = scope.accountId, serverId = scope.serverId, completeConnection = true) {
    const boundary = createSocketIoBoundaryStub({ autoConnect: false });
    network.connect.mockReturnValue(boundary.socket);
    apiSocket.initialize({ endpoint: 'https://rpc-recovery.example.test', serverId,
        token: createAccountTokenForTests(accountId),
        // The scoped connection supervisor probes its genuine HTTP boundary.
        request: async () => Response.json({ cursor: 0, changesFloor: 0 }),
    }, null);
    await vi.waitFor(() => expect(boundary.socket.connect).toHaveBeenCalled());
    if (completeConnection) boundary.trigger('connect');
    expect(apiSocket.getMachineRequestScope()).toEqual({ serverId, accountId });
    return boundary;
}

afterEach(() => {
    for (const release of subscriptions.splice(0)) release();
    apiSocket.disconnect();
    network.connect.mockReset();
});

describe('Machine RPC recovery subscription', () => {
    it('ignores initial connected replay and recovers once for a later disconnected-to-connected transition', async () => {
        const boundary = await connect();
        const recover = vi.fn();
        // Match SyncEngine.subscribeToUpdates: its Home publication occurs in
        // ApiSocket's reconnect callback, after status has become connected.
        subscriptions.push(apiSocket.onReconnected(() => {
            publishHomeAccountChange(scope.serverId, undefined, { source: 'connected' });
        }));
        const release = subscribeMachineRpcRecovery(input, recover);
        subscriptions.push(release);
        await Promise.resolve();
        expect.soft(recover).not.toHaveBeenCalled();
        recover.mockClear();

        boundary.trigger('disconnect', 'transport close');
        boundary.trigger('connect');
        // A duplicate connected observation, not a later supervisor transition.
        boundary.trigger('connect');
        await Promise.resolve();
        expect(recover.mock.calls).toEqual([[true]]);

        release();
        boundary.trigger('disconnect', 'transport close');
        boundary.trigger('connect');
        publishHomeAccountChange(scope.serverId, undefined, { source: 'connected' });
        clearMachineRequestReachabilityForMachine(scope, input.machineId);
        await Promise.resolve();
        expect(recover.mock.calls).toEqual([[true]]);
    });

    it('keeps focused reconnects Account/Home-qualified and Machine/Home wake routing unchanged', async () => {
        const boundary = await connect();
        const recover = vi.fn();
        const otherAccount = vi.fn();
        const otherHome = vi.fn();
        subscriptions.push(subscribeMachineRpcRecovery(input, recover),
            subscribeMachineRpcRecovery({ ...input, expectedAccountId: 'another-account' }, otherAccount),
            subscribeMachineRpcRecovery({ ...input, serverId: 'another-home' }, otherHome));
        await Promise.resolve();
        recover.mockClear();
        boundary.trigger('disconnect', 'transport close');
        boundary.trigger('connect');
        await Promise.resolve();
        expect(recover.mock.calls).toEqual([[true]]);
        expect(otherAccount).not.toHaveBeenCalled();
        expect(otherHome).not.toHaveBeenCalled();

        recover.mockClear();
        clearMachineRequestReachabilityForMachine({ ...scope, accountId: 'another-account' }, input.machineId);
        clearMachineRequestReachabilityForMachine({ ...scope, serverId: 'another-home' }, input.machineId);
        clearMachineRequestReachabilityForMachine(scope, 'another-machine');
        expect(otherAccount.mock.calls).toEqual([[]]);
        expect(otherHome.mock.calls).toEqual([[]]);
        otherAccount.mockClear();
        otherHome.mockClear();
        publishHomeAccountChange('another-home', undefined, { source: 'connected' });
        publishHomeAccountChange(scope.serverId, undefined, { source: 'socket' });
        expect(recover).not.toHaveBeenCalled();
        clearMachineRequestReachabilityForMachine(scope, input.machineId);
        expect(recover.mock.calls).toEqual([[]]);
        expect(otherHome.mock.calls).toEqual([[true]]);
        // The focused identity survives a disconnect; it cannot suppress a usable
        // concurrent carrier while its own transport remains disconnected.
        recover.mockClear();
        boundary.trigger('disconnect', 'transport close');
        publishHomeAccountChange(scope.serverId, undefined, { source: 'connected' });
        expect(recover.mock.calls).toEqual([[true]]);
    });

    it('retires a reconnect notification already queued when its subscriber closes', async () => {
        const boundary = await connect();
        const recover = vi.fn();
        const release = subscribeMachineRpcRecovery(input, recover);
        subscriptions.push(release);
        await Promise.resolve();
        recover.mockClear();
        boundary.trigger('disconnect', 'transport close');
        boundary.trigger('connect');
        release();
        await Promise.resolve();
        expect(recover).not.toHaveBeenCalled();
    });

    it('recovers for the first successful connection observed after subscribing while connecting', async () => {
        const boundary = await connect(scope.accountId, scope.serverId, false);
        const recover = vi.fn();
        subscriptions.push(subscribeMachineRpcRecovery(input, recover));
        await Promise.resolve();
        expect(recover).not.toHaveBeenCalled();
        boundary.trigger('connect');
        await Promise.resolve();
        expect(recover.mock.calls).toEqual([[true]]);
    });
});
