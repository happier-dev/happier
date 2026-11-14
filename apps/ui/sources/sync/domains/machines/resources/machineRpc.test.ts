import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { MACHINE_RPC_TIMEOUT_ERROR_CODE, RPC_ERROR_CODES, RpcError } from '@happier-dev/protocol/rpcErrors';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { MachineVitalsGetInputV1Schema, MachineVitalsSnapshotV1Schema } from '@happier-dev/protocol/machines/vitals/machineVitalsRpcV1';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';

// The authenticated machine connection is the network boundary; decoding and classification stay real.
const network = vi.hoisted(() => ({ execute: vi.fn() }));
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', async () => {
    const { createServerScopedMachineRpcBoundaryMock } = await import('@/dev/testkit/mocks/serverScopedRpc');
    return createServerScopedMachineRpcBoundaryMock(network.execute);
});
const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes); installDisconnectedServerSocketBoundary();
// Initialize storage through Sync before resource RPC imports its daemon read target.
await loadSyncSingletonForTests();
const { machineRpcWithPeerMediationRoute } = await import('@/sync/domains/machines/peer/mediation/rpc/client');
const { fetchMachineVitalsHistoryViaMachineRpc, fetchMachineVitalsViaMachineRpc, watchMachineVitalsViaMachineRpc } = await import('./machineRpc');

const key = { serverId: 'home', machineId: 'machine', view: 'summary' as const };
beforeEach(async () => {
    await homes.reset(); await loadSyncSingletonForTests(); network.execute.mockReset();
    key.serverId = await homes.addHome({ name: 'Vitals', serverUrl: 'https://vitals-read.test', accountId: 'owner', currentAccount: true });
});
afterEach(async () => { vi.useRealTimers(); await homes.reset(); });

it('carries service history selection through real Action admission to the daemon', async () => {
    const history = { range: '1h', bucketMs: 60_000, points: [], today: { rxBytes: 1, txBytes: 2 },
        service: { serviceId: 'web', points: [{ t: 60_000, cpuPercent: 150, cpuMaxPercent: 170, memoryBytes: 1024, memoryMaxBytes: 2048 }] } };
    network.execute.mockResolvedValue(history);
    const result = await fetchMachineVitalsHistoryViaMachineRpc({ ...key, range: '1h', serviceId: 'web' });
    expect(result).toEqual({ ok: true, value: history });
    expect(network.execute.mock.calls[0]?.[0]).toMatchObject({ payload: { machineId: key.machineId, range: '1h', serviceId: 'web' } });
});

it.each([true, false])('recovers demanded Vitals after consecutive transport deadlines and a renderer stall (changed=%s)', async changed => {
    vi.useFakeTimers();
    vi.setSystemTime(60_000);
    const { createMachineResourceStore } = await import('./machineResourceStore');
    const initial = MachineVitalsSnapshotV1Schema.parse({ state: 'reporting', sample: {
        v: 1, sampledAt: Date.now(), intervalMs: 2_000, cpu: { reported: true, busyPct: 20 },
        memory: { reported: true, totalBytes: 100, availableBytes: 80, usedBytes: 20, pressure: { level: 'calm', source: 'psi' } },
        disk: { reported: true, volumes: [] }, network: { reported: true, rxBps: 12, txBps: 3 },
    }, series5m: { cpu: [], memory: [], networkRx: [], networkTx: [] } });
    const pending: Array<{ payload: unknown; signal?: AbortSignal; reply(value: unknown): void; fail(): void }> = [];
    // Only the authenticated machine transport is replaced. Real Action admission, parsing,
    // error classification, resource state and the shared watch lifecycle remain composed.
    network.execute.mockImplementation((request: {
        method: string; payload: unknown; signal?: AbortSignal; onDispatched?: () => void;
    }) => {
        if (request.method === RPC_METHODS.MACHINES_VITALS_GET) return Promise.resolve(initial);
        return new Promise<unknown>((resolve, reject) => {
            request.signal?.addEventListener('abort', () => reject(new Error('cancelled')), { once: true });
            pending.push({ payload: request.payload, signal: request.signal, reply: resolve,
                fail: () => reject(new RpcError('Transport deadline elapsed', MACHINE_RPC_TIMEOUT_ERROR_CODE,
                    { phase: 'dispatch', errorClass: 'RpcError', errorCode: MACHINE_RPC_TIMEOUT_ERROR_CODE, httpStatus: null })) });
            request.onDispatched?.();
        });
    });
    const store = createMachineResourceStore({ snapshotClient: fetchMachineVitalsViaMachineRpc,
        watchClient: watchMachineVitalsViaMachineRpc, historyClient: fetchMachineVitalsHistoryViaMachineRpc });
    const input = { ...key, expectedAccountId: 'owner', view: 'overview' as const };
    const release = store.demand(input);
    try {
        await vi.waitFor(() => expect(pending).toHaveLength(1));
        const held = store.getState(input);
        for (let attempt = 0; attempt < 3; attempt++) {
            // Model a renderer stall, then a typed transport failure. The remote/transport
            // boundary supplies failures; this client does not invent another deadline.
            vi.advanceTimersByTime(60_000);
            pending[attempt]!.fail();
            await vi.waitFor(() => expect(pending).toHaveLength(attempt + 2));
            expect(store.getState(input)).toMatchObject({ status: attempt === 0 ? 'slow' : 'error',
                errorCode: MACHINE_RPC_TIMEOUT_ERROR_CODE, stale: true, snapshot: held.snapshot, summary: held.summary,
                failure: { errorCode: MACHINE_RPC_TIMEOUT_ERROR_CODE, failureCause: { phase: 'dispatch' } } });
            expect(pending.at(-1)?.payload).toMatchObject({ sinceSampledAt: 60_000 });
            expect(vi.getTimerCount()).toBe(0); // One outstanding request, no client polling/deadline timer.
        }
        if (!changed) {
            pending.at(-1)!.reply({ changed: false });
            await vi.waitFor(() => expect(pending).toHaveLength(5));
            expect(store.getState(input)).toMatchObject({ status: 'ready', stale: true });
            expect(store.getState(input)).not.toHaveProperty('errorCode');
        }
        const fresh = { ...initial.sample!, sampledAt: Date.now() };
        pending.at(-1)!.reply({ changed: true, samples: [fresh] });
        await vi.waitFor(() => expect(store.getState(input).snapshot?.sample?.sampledAt).toBe(fresh.sampledAt));
        expect(store.getState(input)).toMatchObject({ status: 'ready', stale: false });
        expect(store.getState(input)).not.toHaveProperty('errorCode');
        const count = pending.length;
        release();
        expect(pending.at(-1)?.signal?.aborted).toBe(true);
        await vi.advanceTimersByTimeAsync(120_000);
        expect(pending).toHaveLength(count);
        expect(vi.getTimerCount()).toBe(0);
    } finally { release(); store.reset(); }
});

it('distinguishes unavailable transport from missing predecessor vitals operations on reads, history, and parked watches', async () => {
    for (const code of [RPC_ERROR_CODES.METHOD_NOT_AVAILABLE, RPC_ERROR_CODES.METHOD_NOT_FOUND]) {
        network.execute.mockRejectedValue(new RpcError('Unavailable operation', code));
        const expected = code === RPC_ERROR_CODES.METHOD_NOT_FOUND
            ? { ok: false, reason: 'older_happier', errorCode: code }
            : { ok: false, reason: 'request_failed', errorCode: code };
        expect.soft(await fetchMachineVitalsViaMachineRpc(key)).toMatchObject(expected);
        expect.soft(await fetchMachineVitalsHistoryViaMachineRpc({ ...key, range: '1h' })).toMatchObject(expected);
        expect.soft(await watchMachineVitalsViaMachineRpc(key)).toMatchObject(expected);
    }
});

it('keeps denied access, transport failure, and invalid payloads distinct from older Happier', async () => {
    network.execute.mockRejectedValue(new RpcError('Forbidden', RPC_ERROR_CODES.FORBIDDEN));
    expect(await fetchMachineVitalsViaMachineRpc(key)).toMatchObject({ ok: false, reason: 'request_failed', errorCode: RPC_ERROR_CODES.FORBIDDEN });
    network.execute.mockRejectedValue(new Error('Socket not connected'));
    expect(await fetchMachineVitalsViaMachineRpc(key)).toMatchObject({ ok: false, reason: 'request_failed', errorCode: 'action_failed' });
    network.execute.mockResolvedValue({ state: 'reporting' });
    expect(await fetchMachineVitalsViaMachineRpc(key)).toMatchObject({ ok: false, reason: 'invalid_response', errorCode: 'invalid_action_output' });
});

it('preserves the direct handler failure as a typed uncertain outcome through the Vitals Action', async () => {
    const method = RPC_METHODS.MACHINES_VITALS_GET;
    const publicKey = Buffer.from(new Uint8Array(32).fill(1)).toString('base64url');
    const signature = Buffer.from(new Uint8Array(64).fill(2)).toString('base64url');
    const route = { kind: 'selected' as const, receipt: 'peer.route.selected' as const,
        endpoint: { url: 'http://127.0.0.1:3000', endpointFingerprint: 'endpoint_1' },
        grant: { payload: { v: 2 as const, grantId: 'grant_1', accountId: 'owner', machineId: key.machineId,
            flowKind: 'machine_rpc' as const, routeKind: 'loopback_direct' as const,
            scope: { kind: 'machine_rpc' as const, rpcScopeId: 'scope_1', allowedMethods: [method], maxIdleMs: 10_000 },
            iat: 1_000, exp: 601_000, aud: 'happier-daemon-route-grant' as const, endpointFingerprint: 'endpoint_1',
            proofKind: 'ephemeral_ed25519' as const, ephemeralPublicKeyBase64Url: publicKey },
            signature: { keyId: 'key_1', alg: 'Ed25519' as const, valueBase64Url: signature } },
        proof: { v: 2 as const, kind: 'ephemeral_ed25519' as const, signedGrantDigestBase64Url: publicKey,
            nonceBase64Url: Buffer.from(new Uint8Array(16).fill(3)).toString('base64url'), signatureBase64Url: signature } };
    const serverFallback = vi.fn(async () => ({}));
    // The existing machine-connection boundary now exercises the real direct route beneath it.
    // Endpoint discovery and the daemon HTTP response are the only replaced external boundaries.
    network.execute.mockImplementation((request: { machineId: string; method: string; payload: unknown }) =>
        machineRpcWithPeerMediationRoute({ ...request, serverId: key.serverId, accountId: 'owner',
            resolveDirectRoute: async () => route,
            createRequestId: () => 'request_1',
            postDirect: async () => ({ v: 2 as const, ok: false as const,
                receipt: 'peer.rpc.fell_back_to_server' as const, requestId: 'request_1', method,
                reasonCode: 'handler_unavailable' as const }), serverFallback }));
    expect(await fetchMachineVitalsViaMachineRpc(key))
        .toMatchObject({ ok: false, reason: 'request_failed', errorCode: 'outcome_unknown',
            failureCause: { errorCode: RPC_ERROR_CODES.OUTCOME_UNKNOWN } });
    expect(serverFallback).not.toHaveBeenCalled();
});

it('reads a reporting machine through the real Action wiring with its exact Home and machine', async () => {
    const snapshot = MachineVitalsSnapshotV1Schema.parse({ state: 'reporting', sample: {
        v: 1, sampledAt: Date.now(), intervalMs: 15_000,
        cpu: { reported: true, busyPct: 20 },
        memory: { reported: true, totalBytes: 100, availableBytes: 80, usedBytes: 20, pressure: { level: 'calm', source: 'psi' } },
        disk: { reported: true, volumes: [] }, network: { reported: true, rxBps: 12, txBps: 3 },
    }, series5m: { cpu: [], memory: [], networkRx: [], networkTx: [] } });
    network.execute.mockResolvedValue(snapshot);
    expect(await fetchMachineVitalsViaMachineRpc(key)).toEqual({ ok: true, value: snapshot });
    const request = network.execute.mock.calls.find(([request]) => request.method === RPC_METHODS.MACHINES_VITALS_GET)?.[0];
    expect(request).toMatchObject({ serverId: key.serverId, accountId: 'owner', machineId: key.machineId });
    expect(MachineVitalsGetInputV1Schema.parse(request.payload)).toEqual({ serverId: key.serverId, machineId: key.machineId, view: 'summary' });
});

it('resolves an implicit active-Home target into the same Account-qualified store key', async () => {
    const { setActiveServer } = await import('@/sync/domains/server/serverRuntime');
    const { resolveMachineResourceKey } = await import('./machineRpc');
    const { machineResourceStore } = await import('./machineResourceStore');
    await setActiveServer({ serverId: key.serverId });
    const snapshot = MachineVitalsSnapshotV1Schema.parse({ state: 'reporting', sample: null,
        series5m: { cpu: [], memory: [], networkRx: [], networkTx: [] } });
    network.execute.mockResolvedValue(snapshot);
    try {
        const resolved = await resolveMachineResourceKey({ machineId: key.machineId });
        expect(resolved).not.toBeNull();
        await machineResourceStore.read({ ...resolved!, view: 'summary' });
        expect(machineResourceStore.getState({ ...key, expectedAccountId: 'owner' }).snapshot).toEqual(snapshot);
        expect(network.execute.mock.calls[0]?.[0]).toMatchObject({ serverId: key.serverId, accountId: 'owner' });
    } finally { machineResourceStore.reset(); }
});

it('keeps the Action admission refusal code before any machine request leaves the client', async () => {
    homes.answer(key.serverId, '/v2/account/settings', { body: { content: { t: 'plain', v: {
        actionsSettingsV1: { v: 1, actions: { 'machines.vitals.get': { enabled: false } } },
    } }, version: 1 } });
    expect(await fetchMachineVitalsViaMachineRpc(key))
        .toMatchObject({ ok: false, reason: 'request_failed', errorCode: 'action_disabled' });
    expect(network.execute).not.toHaveBeenCalled();
});
