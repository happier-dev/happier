import { afterEach, describe, expect, it, vi } from 'vitest';
import { Platform } from 'react-native';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { createDeferred, createMachineFixture, flushHookEffects } from '@/dev/testkit';
import { createMachineReadBatchResponseFixture, createPlainMachineRowFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { createLegacyAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { waitForNetworkResponseForTests } from '@/dev/testkit/mocks/runtimeFetch';
import { captureLazyActionAccountContext, withActionAccountRequestSignal } from '@/sync/ops/actions/actionAccountContext';
import { readMachineRows } from './machineRowsApi';
import { serveAccountHomes } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { createAccountTokenForTests } from '@/dev/testkit/harness/homeGovernanceHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { machineWorkerPolicyGet } from '@/sync/ops/machineFinitePolicy';
import { resetScopedMachineTransportCacheForTests, resolveScopedMachineTransport } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedRpcPool';
import { resolveServerScopedContext } from '@/sync/runtime/orchestration/serverScopedRpc/resolveServerScopedContext';
import { installLocalStorageMock } from '@/auth/storage/tokenStorage.web.testHelpers';
import { configureConnectedServerSocketBoundary, installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';

vi.mock('socket.io-client', async original =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(original));

// The real Sync/Account/transport graph is prepared outside a timed test.
installDisconnectedServerSocketBoundary();
await loadSyncSingletonForTests();
afterEach(async () => {
    resetScopedMachineTransportCacheForTests();
    const { serverScopedRpcSocketPool } = await import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedRpcSocketPool');
    const { resetServerReachabilitySupervisors } = await import('@/sync/runtime/connectivity/serverReachabilitySupervisorPool');
    await serverScopedRpcSocketPool.stopAll();
    await resetServerReachabilitySupervisors();
});

describe('Machine rows through captured Home readers', () => {
    it('reads only selected Machines for a request-only Account', async () => {
        const selected: string[] = [];
        const machine = createPlainMachineRowFixture({ id: 'selected-machine', accountId: 'owner' });
        const rows = await readMachineRows({ machineIds: [machine.id], request: async (path, init) => {
            expect(path).toBe('/v1/machines/read-batch');
            return createMachineReadBatchResponseFixture(init.body, id => {
                selected.push(id);
                return id === machine.id ? machine : null;
            });
        } });
        expect(selected).toEqual([machine.id]);
        expect(rows.get(machine.id)).toEqual(machine);
    });

    it('cancels a held 185-Machine read when its Account changes without delivering the retired rows', async () => {
        const ids = Array.from({ length: 185 }, (_, index) => `retired-machine-${index}`);
        const entered = createDeferred<void>();
        const release = createDeferred<void>();
        let physical: AbortSignal | null | undefined;
        const home = await serveAccountHomes({ homes: [{ key: 'resource', serverUrl: 'https://retiring-machine-read.test',
            accountId: 'original-account' }], route: async request => {
            if (request.path === '/v1/machines') return Response.json([]);
            if (request.path !== '/v1/machines/read-batch') return undefined;
            if (request.accountId === 'original-account') {
                physical = request.signal;
                entered.resolve();
                await waitForNetworkResponseForTests(release.promise, request.signal);
            }
            return createMachineReadBatchResponseFixture(request.body, id => request.accountId === 'original-account'
                ? createPlainMachineRowFixture({ id, accountId: 'original-account' }) : null);
        } });
        const account = await captureLazyActionAccountContext(home.homes.resource!.id);
        try {
            if (!account.readTransport) throw new Error('Captured Machine transport unavailable');
            const pending = withActionAccountRequestSignal(account, undefined, signal => readMachineRows({
                readTransport: account.readTransport!, machineIds: ids, signal,
            }));
            const cancelled = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
            await entered.promise;
            expect(home.requests.filter(request => request.path === '/v1/machines/read-batch')).toHaveLength(1);
            await home.switchAccount('resource', 'replacement-account');
            await cancelled;
            expect(physical?.aborted).toBe(true);
            const replacement = await captureLazyActionAccountContext(home.homes.resource!.id);
            try {
                if (!replacement.readTransport) throw new Error('Replacement Machine transport unavailable');
                const rows = await readMachineRows({ readTransport: replacement.readTransport, machineIds: ids });
                expect([...rows.values()]).toEqual(ids.map(() => null));
                expect(home.requests.filter(request => request.path === '/v1/machines/read-batch')).toHaveLength(2);
            } finally { replacement.dispose(); }
        } finally { release.resolve(); account.dispose(); await home.dispose(); }
    });

    it.each(['ios', 'web'] as const)('batches 185 exact Machine RPC preparations after real E2EE credential acquisition (%s)', async platform => {
        const previousPlatform = Object.getOwnPropertyDescriptor(Platform, 'OS')!;
        const webStorage = platform === 'web' ? installLocalStorageMock() : null;
        Object.defineProperty(Platform, 'OS', { ...previousPlatform, value: platform });
        try {
            const ids = Array.from({ length: 185 }, (_, index) => `machine-preparation-${index}`);
            const secret = new Uint8Array(32).fill(47);
            const { Encryption } = await import('@/sync/encryption/encryption');
            const { socketRpcCodec } = await import('@happier-dev/sync-client');
            const { machineRpcWithServerScope } = await import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc');
            const { sync } = await import('@/sync/sync');
            const encryption = await Encryption.create(secret);
            await encryption.initializeMachines(new Map(ids.map(id => [id, null])));
            const rpcTargets: string[] = [];
            installDisconnectedServerSocketBoundary(socket => {
                configureConnectedServerSocketBoundary(socket);
                vi.spyOn(socket, 'timeout').mockReturnValue(socket);
                vi.spyOn(socket, 'emitWithAck').mockImplementation(async (event, payload) => {
                    if (event !== 'rpc-call') return { v: 1, ok: true, admittedSessionIds: [] };
                    if (!payload || typeof payload !== 'object' || !('method' in payload)
                        || typeof payload.method !== 'string' || !('params' in payload)) throw new Error('Malformed RPC request');
                    const id = payload.method.slice(0, payload.method.indexOf(':'));
                    const cipher = encryption.getMachineEncryption(id);
                    if (!cipher) throw new Error('Unexpected Machine target');
                    const content = { mode: 'e2ee' as const, cipher };
                    const decoded = await socketRpcCodec.decodeRequestParams(content, payload.params, payload.method);
                    expect(decoded.params).toEqual({});
                    rpcTargets.push(id);
                    return { ok: true, result: await socketRpcCodec.encodeResponse(content, { machineId: id }, decoded.callId) };
                });
            });
            const batches: string[][] = [];
            const entered = createDeferred<void>();
            const release = createDeferred<void>();
            const home = await serveAccountHomes({ homes: [{ key: 'resource', serverUrl: 'https://machine-preparation.test',
                accountId: 'machine-reader', accountMode: 'e2ee',
                encryptionCurrentness: () => createLegacyAccountEncryptionCurrentnessFixture({ secret }), credentials: {
                    token: createAccountTokenForTests('machine-reader', { currentAccount: true }),
                    secret: Buffer.from(secret).toString('base64url'),
                } }], route: async request => {
                if (request.path === '/v1/machines') return Response.json([]);
                if (request.path !== '/v1/machines/read-batch') return undefined;
                const response = createMachineReadBatchResponseFixture(request.body, id => ids.includes(id)
                    ? { id, managedMachineRef: null, metadata: null, metadataVersion: 0, daemonState: null, daemonStateVersion: 0, dataEncryptionKey: null }
                    : null);
                batches.push((request.body as { machineIds: string[] }).machineIds);
                entered.resolve();
                await release.promise;
                return response;
            } });
            try {
                // Initial cursor capture publishes a Home wake that separates read
                // revisions. Exercise one demand after that real startup phase.
                expect(await sync.awaitBootstrapForegroundAcquisition()).toBe(true);
                const pending = Promise.all(ids.map(machineId => machineRpcWithServerScope({
                    serverId: home.homes.resource!.id, machineId, method: RPC_METHODS.CAPABILITIES_DETECT,
                    payload: {}, preferScoped: true,
                })));
                try {
                    await entered.promise;
                    await flushHookEffects();
                    // All demanded rows issue before any response is released: one
                    // physical request and one dependency wave for the measured fleet.
                    expect(batches.map(batch => batch.length)).toEqual([ids.length]);
                } finally { release.resolve(); }
                const results = await pending;
                expect(results).toEqual(ids.map(machineId => ({ machineId })));
                expect(rpcTargets.sort()).toEqual([...ids].sort());
                expect({ requests: batches.length, batchSizes: batches.map(batch => batch.length) })
                    .toEqual({ requests: 1, batchSizes: [ids.length] });
                expect([...batches[0]!].sort()).toEqual([...ids].sort());
            } finally { release.resolve(); await home.dispose(); }
        } finally {
            Object.defineProperty(Platform, 'OS', previousPlatform);
            webStorage?.restore();
            installDisconnectedServerSocketBoundary();
        }
    });

    it('shares a pending exact row between active finite-policy and scoped transport readers, but re-reads after settlement', async () => {
        const token = createAccountTokenForTests('machine-row-account');
        const row = createPlainMachineRowFixture({ id: 'machine-row', accountId: 'machine-row-account' });
        const entered = createDeferred<void>();
        const release = createDeferred<void>();
        const home = await serveAccountHomes({ homes: [{ key: 'resource', serverUrl: 'https://machine-row-read.test',
            accountId: 'machine-row-account', accountMode: 'plain', credentials: { token } }],
            route: async request => {
                if (request.path === '/v1/machines') return Response.json([row]);
                if (request.path !== '/v1/machines/machine-row' && request.path !== '/v1/machines/read-batch') return undefined;
                entered.resolve();
                await release.promise;
                return request.path === '/v1/machines/read-batch'
                    ? Response.json({ results: [{ machineId: row.id, status: 'found', machine: row }] })
                    : Response.json({ machine: row });
            } });
        const { storage } = await import('@/sync/domains/state/storage');
        await flushHookEffects({ cycles: 12, turns: 2 });
        storage.getState().applyMachines([createMachineFixture({ id: row.id, storageMode: 'plain', access: row.access,
            dataEncryptionKey: row.dataEncryptionKey })], false, { sourceServerId: home.homes.resource!.id });
        const context = await resolveServerScopedContext({ serverId: home.homes.resource!.id,
            machineId: row.id, forceScoped: true });
        if (context.scope !== 'scoped') throw new Error('Expected captured scoped Machine authority');
        const scope = { serverId: context.targetServerId, serverUrl: context.targetServerUrl,
            token: context.token, machineId: row.id, accountId: context.targetAccountId,
            readTransport: context.readTransport, expectedAccountMode: 'plain' as const };
        const policy = machineWorkerPolicyGet(row.id);
        const transport = resolveScopedMachineTransport(scope);
        const outcomes = Promise.all([policy, transport]);
        try {
            await entered.promise;
            await flushHookEffects({ cycles: 12, turns: 2 });
            const exactReads = () => home.requests.filter(request => request.path === '/v1/machines/machine-row' || request.path === '/v1/machines/read-batch');
            expect.soft(exactReads()).toHaveLength(1);
            release.resolve();
            expect(await outcomes).toMatchObject([{ status: 'ready' }, { mode: 'plain' }]);
            await resolveScopedMachineTransport(scope);
            expect(exactReads()).toHaveLength(2);
        } finally {
            release.resolve();
            await outcomes.catch(() => {});
            await context.release?.();
            await home.dispose();
        }
    });
});
