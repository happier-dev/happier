import { afterEach, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import { RPC_ERROR_CODES, RPC_METHODS } from '@happier-dev/protocol/rpc';
import { UpdateContainerSchema } from '@happier-dev/protocol/updates';
import { encodePlainMachineStoredContent } from '@happier-dev/protocol/machines/machineStoredContent';
import { renderHook, standardCleanup } from '@/dev/testkit';
import { createMachineFixture, createMachineReadBatchResponseFixture, createPlainMachineRowFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { createEmptyAccountBootstrapHttpResponse } from '@/dev/testkit/fixtures/accountBootstrapHttpBoundary';
import { serveAccountHomes } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { configureConnectedServerSocketBoundary, installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';

vi.mock('socket.io-client', async original =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(original));

installDisconnectedServerSocketBoundary();
await loadSyncSingletonForTests();
const { probeSessionHandoffSourceReachability } = await import('@/sync/domains/sessionHandoff/probeSessionHandoffSourceReachability');
const { inspectSessionContinuationsOnMachine } = await import('@/sync/ops/sessionContinuationInspection');
const { resetScopedMachineTransportCacheForTests } = await import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedRpcPool');
const { serverScopedRpcSocketPool } = await import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedRpcSocketPool');
const { useSessionHandoffSourceReachability } = await import('@/sync/domains/sessionHandoff/useSessionHandoffSourceReachability');
const { resolveSessionContinuationDaemonGeneration } = await import('@/components/sessions/agentPicker/resolveSessionAgentContinuationEligibility');
const { useSessionContinuationInspections } = await import('@/components/sessions/agentPicker/useSessionContinuationInspections');
const { recordCachedMachineRpcDirectRouteViable } = await import('@/sync/domains/transfers/runtime/transferRouteCache');
const { storage } = await import('@/sync/domains/state/storage');
const { useSession, useMachine } = await import('@/sync/store/hooks');
const { sync } = await import('@/sync/sync');

afterEach(async () => {
    standardCleanup();
    await serverScopedRpcSocketPool.stopAll();
    resetScopedMachineTransportCacheForTests();
    installDisconnectedServerSocketBoundary();
});

it('reuses the active admitted Machine for concurrent handoff and legacy continuation admission', async () => {
    let row = createPlainMachineRowFixture({ id: 'fanout-machine', accountId: 'fanout-account' });
    const methods: string[] = [];
    const sockets: Parameters<typeof configureConnectedServerSocketBoundary>[0][] = [];
    let describeAvailable = true;
    let batchAvailable = false;
    installDisconnectedServerSocketBoundary(socket => {
        sockets.push(socket);
        configureConnectedServerSocketBoundary(socket);
        vi.spyOn(socket, 'timeout').mockReturnValue(socket);
        vi.spyOn(socket, 'emitWithAck').mockImplementation(async (event, packet) => {
            if (event !== 'rpc-call') return { v: 1, ok: true, admittedSessionIds: [] };
            if (!packet || typeof packet !== 'object' || !('method' in packet) || typeof packet.method !== 'string') {
                throw new Error('Malformed Machine RPC');
            }
            const method = packet.method.slice(packet.method.indexOf(':') + 1);
            methods.push(method);
            if (method === RPC_METHODS.SESSION_CONTINUATION_INSPECT_BATCH && batchAvailable) {
                return { ok: true, result: { v: 1, inspections: Array.from({ length: 18 }, () => ({
                    type: 'available', protocolVersion: 1, sameSessionTransition: true,
                })) } };
            }
            return method === RPC_METHODS.CAPABILITIES_DESCRIBE && describeAvailable
                ? { ok: true, result: {} }
                : { ok: false, error: 'RPC method not available', errorCode: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE };
        });
    });
    const batches: string[][] = [];
    let revision = 0;
    const home = await serveAccountHomes({ homes: [{ key: 'resource', serverUrl: 'https://fanout.example.test',
        accountId: 'fanout-account' }], route: request => {
        if (request.path === '/v2/cursor') return Response.json({ cursor: revision, changesFloor: 0 });
        if (request.path === '/v2/changes') return Response.json({ changes: Number(request.url.searchParams.get('after')) < revision
            ? [{ cursor: revision, kind: 'machine', entityId: row.id, changedAt: revision, hint: null }] : [], nextCursor: revision });
        if (request.path === '/v1/machines') return Response.json([row]);
        if (request.path !== '/v1/machines/read-batch') return createEmptyAccountBootstrapHttpResponse(request.path, { method: request.method }) ?? undefined;
        batches.push((request.body as { machineIds: string[] }).machineIds);
        return createMachineReadBatchResponseFixture(request.body, id => id === row.id ? row : null);
    } });
    try {
        const serverId = home.homes.resource!.id;
        storage.getState().applyMachines([createMachineFixture({ id: row.id, storageMode: 'plain',
            dataEncryptionKey: row.dataEncryptionKey, access: row.access })], false,
        { sourceServerId: serverId, sourceAccountId: 'fanout-account' });
        await home.restoreActiveConnection();
        await sync.awaitBootstrapForegroundAcquisition();
        await sync.refreshMachines();
        const activeSocket = sockets.at(-1)!;
        expect(activeSocket.listenersAny().length).toBeGreaterThan(0);
        batches.length = 0;
        methods.length = 0;
        const selections = Array.from({ length: 18 }, (_, index) => ({ v: 1 as const, agentId: `agent-${index}` }));
        const [reachability, inspections] = await Promise.all([
            probeSessionHandoffSourceReachability({ serverId, sourceMachineId: row.id }),
            inspectSessionContinuationsOnMachine({ serverId, machineId: row.id, sessionId: 'fanout-session',
                selections }),
        ]);
        expect(reachability).toBe('reachable');
        expect(inspections).toHaveLength(18);
        expect(inspections.every(result => result.status === 'answered'
            && result.inspection.type === 'unavailable' && result.inspection.reason === 'operation_unavailable')).toBe(true);
        expect({ batches: batches.length, methods }).toEqual({ batches: 0, methods: expect.any(Array) });
        expect(methods.filter(method => method === RPC_METHODS.CAPABILITIES_DESCRIBE)).toHaveLength(1);
        expect(methods.filter(method => method === RPC_METHODS.SESSION_CONTINUATION_INSPECT_BATCH)).toHaveLength(2);
        expect(methods.filter(method => method === RPC_METHODS.SESSION_CONTINUATION_INSPECT)).toHaveLength(36);
        describeAvailable = false;
        await expect(probeSessionHandoffSourceReachability({ serverId, sourceMachineId: row.id })).resolves.toBe('unavailable');
        expect(methods.filter(method => method === RPC_METHODS.CAPABILITIES_DESCRIBE)).toHaveLength(3);
        expect(batches).toEqual([]);
        describeAvailable = true;
        batchAvailable = true;
        const runtimeState = { status: 'running', runtimeId: 'fanout-runtime-one', startedAt: 100, pid: 42 };
        storage.getState().applyMachines([createMachineFixture({ id: row.id, storageMode: 'plain',
            dataEncryptionKey: row.dataEncryptionKey, access: row.access, daemonState: runtimeState })], false,
        { sourceServerId: serverId, sourceAccountId: 'fanout-account' });

        const session = createSessionFixture({ id: 'fanout-session', serverId,
            metadata: { path: '/repo', host: 'test', machineId: row.id } });
        storage.getState().applySessions([session, ...Array.from({ length: 999 }, (_, index) => createSessionFixture({
            id: `unrelated-${index}`, serverId }))]);
        storage.getState().applyMachines(Array.from({ length: 136 }, (_, index) => createMachineFixture({
            id: `unrelated-machine-${index}`, storageMode: 'plain' })), false, { sourceServerId: serverId });
        recordCachedMachineRpcDirectRouteViable({ serverId, remoteMachineId: row.id });
        const hook = await renderHook(() => {
            const source = useSession(session.id, serverId);
            const machine = useMachine(row.id);
            const availability = useSessionHandoffSourceReachability({ serverId, sourceMachineId: source?.metadata?.machineId });
            const continuation = useSessionContinuationInspections({ sessionId: session.id, demanded: true,
                machinePresence: 'online', machine: { machineId: row.id, serverId, connectionGeneration: 1,
                    daemonGeneration: resolveSessionContinuationDaemonGeneration(machine) }, targetSelections: selections });
            return { availability, inspection: continuation.read(selections[0]!), seq: source?.seq };
        });
        await vi.waitFor(() => expect(hook.getCurrent().inspection.status).toBe('answered'));
        methods.length = 0;
        batches.length = 0;
        await act(async () => storage.getState().applySessions([{ ...session, seq: session.seq + 1,
            updatedAt: session.updatedAt + 1 }]));
        expect(hook.getCurrent().seq).toBe(session.seq + 1);
        expect(methods).toEqual([]);
        expect(batches).toEqual([]);

        // The actual SDK catch-all delivers the record before its same-Machine
        // feed wake. Both mounted RPC consumers see the real daemon version.
        revision = 1;
        const daemonState = encodePlainMachineStoredContent({ ...runtimeState, startedAt: 200, pid: 43 });
        row = { ...row, daemonState, daemonStateVersion: (row.daemonStateVersion ?? 0) + 1 };
        const deliver = (body: unknown) => {
            const update = UpdateContainerSchema.parse({ id: `fanout-${revision}`, seq: revision, createdAt: revision, body });
            for (const listener of activeSocket.listenersAny()) listener('update', update);
        };
        for (let index = 0; index < 32; index++) {
            await act(async () => {
                storage.getState().setSocketStatus('connected');
                deliver({ t: 'update-machine', machineId: row.id,
                    daemonState: { value: encodePlainMachineStoredContent({ ...runtimeState,
                        contributionRegistryProjectionRevision: index }), version: index + 2 } });
            });
        }
        expect(storage.getState().machines[row.id]?.daemonStateVersion).toBe(33);
        expect(methods.filter(method => method === RPC_METHODS.SESSION_CONTINUATION_INSPECT_BATCH)).toHaveLength(0);
        expect(methods.filter(method => method === RPC_METHODS.SESSION_CONTINUATION_INSPECT)).toHaveLength(0);
        row = { ...row, daemonStateVersion: 34 };
        await act(async () => deliver({ t: 'update-machine', machineId: row.id,
            daemonState: { value: daemonState, version: row.daemonStateVersion } }));
        await act(async () => deliver({ t: 'account-change', changeKinds: ['machine'], entityIds: [row.id] }));
        await sync.resumeSync('changes-catch-up');
        await vi.waitFor(() => {
            expect(hook.getCurrent().availability).toBe('reachable');
            expect(hook.getCurrent().inspection.status).toBe('answered');
            expect(methods.filter(method => method === RPC_METHODS.SESSION_CONTINUATION_INSPECT_BATCH)).toHaveLength(1);
        });
        expect(methods.filter(method => method === RPC_METHODS.SESSION_CONTINUATION_INSPECT)).toHaveLength(0);
        expect(storage.getState().machines[row.id]?.daemonStateVersion).toBe(row.daemonStateVersion);
        expect(batches).toEqual([[row.id]]);
        await hook.unmount();
    } finally { await home.dispose(); }
});
