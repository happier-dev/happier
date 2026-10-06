import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { parseCapabilityId } from '@happier-dev/protocol/capabilities';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import type { CapabilitiesInvokeRequest } from '@/sync/api/capabilities/capabilitiesProtocol';
import { installSessionOpsNetworkBoundary } from '@/dev/testkit/harness/sessionOpsNetworkBoundary';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import type { UpdateItem } from './items/updateItem';

const boundary = vi.hoisted(() => ({
    invoke: vi.fn<(accountId: string, request: CapabilitiesInvokeRequest) => Promise<unknown>>(),
}));

let runUpdateBatch: typeof import('./machineUpdateRuns').runUpdateBatch;
let runMachineItemUpdate: typeof import('./machineUpdateRuns').runMachineItemUpdate;
let readMachineUpdateRuns: typeof import('./machineUpdateRuns').readMachineUpdateRuns;
let observeMachineUpdateRun: typeof import('./machineUpdateRuns').observeMachineUpdateRun;

// Validate the untyped daemon-network payload without replacing the capability or scope owners.
function isInvokeRequest(value: unknown): value is CapabilitiesInvokeRequest {
    return value !== null && typeof value === 'object'
        && 'id' in value && parseCapabilityId(value.id) !== null
        && 'method' in value && typeof value.method === 'string'
        && (!('params' in value) || (value.params !== null && typeof value.params === 'object' && !Array.isArray(value.params)));
}

function item(id: string, subject: UpdateItem['subject']): UpdateItem {
    return {
        id, subject, machineId: 'studio', title: id, currentVersion: '1', latestVersion: '2',
        state: 'available', progressPercent: null, step: null, managedBy: 'happier',
        action: { kind: 'run', verb: 'update' }, failure: null, skipped: false,
    };
}

describe('machine update account scope at the real RPC credential boundary', () => {
    const homeUrl = 'https://updates-account-scope.example.test';
    let network: Awaited<ReturnType<typeof installSessionOpsNetworkBoundary>>;
    let scope: { serverId: string; accountId: string };
    beforeEach(async () => {
        vi.resetModules();
        boundary.invoke.mockReset();
        network = await installSessionOpsNetworkBoundary();
        const home = await network.addHome(homeUrl, 'account-a');
        scope = { serverId: home.id, accountId: home.accountId };
        network.setRpcResponder(async (request) => {
            if (request.method === RPC_METHODS.CAPABILITIES_DETECT) return { protocolVersion: 1, results: {} };
            expect(request.serverUrl).toBe(home.serverUrl);
            expect(request.targetId).toBe('studio');
            expect(request.method).toBe(RPC_METHODS.CAPABILITIES_INVOKE);
            if (!isInvokeRequest(request.payload) || !request.token) throw new Error('Malformed daemon invoke fixture');
            const { parseToken } = await import('@/utils/auth/parseToken');
            return await boundary.invoke(parseToken(request.token), request.payload);
        });
        const { upsertAndActivateServer } = await import('@/sync/domains/server/serverRuntime');
        await loadSyncSingletonForTests();
        const { restoreConnectionToActiveServer } = await import('@/sync/runtime/orchestration/connectionManager');
        await upsertAndActivateServer({ serverUrl: home.serverUrl });
        await restoreConnectionToActiveServer({ token: home.token });
        ({ runUpdateBatch, runMachineItemUpdate, readMachineUpdateRuns, observeMachineUpdateRun } = await import('./machineUpdateRuns'));
        vi.useFakeTimers();
    });
    afterEach(async () => {
        const { disconnectActiveServerConnection } = await import('@/sync/runtime/orchestration/connectionManager');
        await disconnectActiveServerConnection();
        const { serverScopedRpcSocketPool } = await import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedRpcSocketPool');
        const { resetScopedMachineTransportCacheForTests } = await import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedRpcPool');
        serverScopedRpcSocketPool.resetForTests();
        resetScopedMachineTransportCacheForTests();
        network.dispose();
        vi.clearAllTimers();
        vi.useRealTimers();
    });

    it.each(['happier-cli', 'installable'] as const)('rejects a queued %s update after same-server account replacement', async (kind) => {
        const first = item(`first-${kind}`, { kind: 'installable', key: 'gh' });
        const second = item(`second-${kind}`, kind === 'happier-cli' ? { kind } : { kind, key: 'gh' });
        let release!: () => void;
        const pending = new Promise<void>((resolve) => { release = resolve; });
        let entered!: () => void;
        const firstIssued = new Promise<void>((resolve) => { entered = resolve; });
        boundary.invoke.mockImplementation(async (_accountId, request) => {
            entered();
            await pending;
            return request.method === 'start'
                ? { ok: true, result: { taskId: 'task-queued' } }
                : { ok: true, result: request.method === 'poll' ? { result: { ok: true } } : {} };
        });
        const running = runUpdateBatch(scope, [first, second], (update) => runMachineItemUpdate(update, { scope }));
        await firstIssued;
        network.setAccount(homeUrl, 'account-b');
        release();
        await running;

        expect(boundary.invoke.mock.calls.map(([accountId]) => accountId)).toEqual(['account-a']);
        expect(observeMachineUpdateRun(readMachineUpdateRuns(scope.serverId), second.id)).toMatchObject({
            running: false, errorMessage: expect.any(String),
        });
    });

    it('admits the remote CLI update when start and poll retain the initiating account', async () => {
        const cli = item('cli-retained-account', { kind: 'happier-cli' });
        boundary.invoke.mockImplementation(async (_accountId, request) => ({
            ok: true, result: request.method === 'poll' ? { result: { ok: true } } : { taskId: 'task-retained' },
        }));
        await runUpdateBatch(scope, [cli], (update) => runMachineItemUpdate(update, { scope }));

        expect(boundary.invoke.mock.calls.map(([accountId, request]) => [accountId, request.method])).toEqual([
            ['account-a', 'start'], ['account-a', 'poll'],
        ]);
        expect(observeMachineUpdateRun(readMachineUpdateRuns(scope.serverId), cli.id)).toMatchObject({
            running: true, errorMessage: null,
        });
    });

    it('reports an unknown outcome without polling through replacement-account credentials', async () => {
        const cli = item('cli-start-poll-account', { kind: 'happier-cli' });
        boundary.invoke.mockImplementation(async (_accountId, request) => {
            network.setAccount(homeUrl, 'account-b');
            return { ok: true, result: request.method === 'poll' ? { result: { ok: true } } : { taskId: 'task-started' } };
        });
        await runUpdateBatch(scope, [cli], (update) => runMachineItemUpdate(update, { scope }));

        expect(boundary.invoke.mock.calls.map(([accountId, request]) => [accountId, request.method])).toEqual([['account-a', 'start']]);
        expect(observeMachineUpdateRun(readMachineUpdateRuns(scope.serverId), cli.id)).toMatchObject({
            running: false, errorMessage: expect.any(String),
        });
    });
});
