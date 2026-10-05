import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { encodePlainMachineStoredContent, FeaturesResponseSchema, MACHINE_PLAIN_DATA_KEY_MARKER } from '@happier-dev/protocol';
import { SOCKET_RPC_EVENTS, SocketRpcRequestIdSchema } from '@happier-dev/protocol/socketRpc';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';

const socketAckSpy = vi.hoisted(() => vi.fn<(event: string, ...args: unknown[]) => Promise<unknown>>());
const socketEmitSpy = vi.hoisted(() => vi.fn<(event: string, ...args: unknown[]) => void>());
const createEphemeralSocketSpy = vi.hoisted(() => vi.fn());
const machineRpcWithPeerMediationRouteSpy = vi.hoisted(() => vi.fn());

installDisconnectedServerSocketBoundary((socket) => {
    // A connected Socket.IO transport is the external fact under test; all
    // Account admission, RPC encoding, issuance, and cancellation remain real.
    socket.connected = true;
    // There is no native engine behind this transport. Suppress only its wire
    // packet writer, preserving real Socket disconnect events and cleanup.
    vi.spyOn(socket.io, '_packet').mockImplementation(() => {});
    vi.spyOn(socket, 'emitWithAck').mockImplementation((event, ...args) => socketAckSpy(event, ...args));
    vi.spyOn(socket, 'emit').mockImplementation((event, ...args) => {
        socketEmitSpy(event, ...args);
        return socket;
    });
});

vi.mock('@/sync/runtime/orchestration/serverScopedRpc/createEphemeralServerSocketClient', () => ({
    createEphemeralServerSocketClient: (...args: unknown[]) => createEphemeralSocketSpy(...args),
}));

vi.mock('@/sync/domains/machines/peer/mediation/rpc/client', () => ({
    machineRpcWithPeerMediationRoute: (...args: unknown[]) => machineRpcWithPeerMediationRouteSpy(...args),
}));

// Serialize the real graph after transport registration, outside case budgets.
const { loadSyncSingletonForTests } = await import('@/dev/testkit/harness/syncSingletonLoader');
await loadSyncSingletonForTests();
const { sync } = await import('@/sync/syncEngine');
const { resetScopedMachineTransportCacheForTests } = await import('./serverScopedRpcPool');
const { machineRpcWithServerScope } = await import('./serverScopedMachineRpc');
let connection: Awaited<ReturnType<typeof restoreServerAccountForTest>> | null = null;

function machineCalls() {
    return socketAckSpy.mock.calls.filter(([event]) => event === SOCKET_RPC_EVENTS.CALL);
}

describe('machineRpcWithServerScope signal', () => {
    beforeEach(async () => {
        connection = await restoreServerAccountForTest({
            serverUrl: 'https://server-a.example.test',
            request: async (input) => {
                const path = new URL(String(input)).pathname;
                if (path === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 0 });
                if (path === '/v1/account/encryption/currentness') return Response.json(createPlainAccountEncryptionCurrentnessFixture());
                if (path === '/v2/account/settings') return Response.json({ content: { t: 'plain', v: {} }, version: 1 });
                if (path === '/v1/features') return Response.json(FeaturesResponseSchema.parse({ features: {}, capabilities: {} }));
                if (path === '/v1/machines') {
                    const machine = createMachineFixture();
                    if (!machine.metadata) throw new Error('Expected Machine fixture metadata');
                    return Response.json([{ ...machine, metadata: encodePlainMachineStoredContent(machine.metadata), dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER }]);
                }
                if (path === '/v2/sessions' || path === '/v2/sessions/active') return Response.json({ sessions: [], hasNext: false, nextCursor: null });
                return new Response('{}', { status: 404 });
            },
        });
        await sync.refreshMachines();
        machineRpcWithPeerMediationRouteSpy.mockImplementation(async (params: {
            serverId?: string | null;
            machineId: string;
            method: string;
            payload: unknown;
            timeoutMs?: number;
            serverFallback: (input: {
                serverId?: string | null;
                machineId: string;
                method: string;
                payload: unknown;
                timeoutMs?: number;
                reasonCode: string;
            }) => Promise<unknown>;
        }) => await params.serverFallback({
            serverId: params.serverId,
            machineId: params.machineId,
            method: params.method,
            payload: params.payload,
            timeoutMs: params.timeoutMs,
            reasonCode: 'server_required',
        }));
    });

    afterEach(async () => {
        await connection?.dispose();
        connection = null;
        socketAckSpy.mockReset();
        socketEmitSpy.mockReset();
        createEphemeralSocketSpy.mockReset();
        machineRpcWithPeerMediationRouteSpy.mockReset();
        resetScopedMachineTransportCacheForTests();
    });

    it('rejects with an abort error when the signal fires during an in-flight attempt', async () => {
        socketAckSpy.mockImplementation(() => new Promise(() => {}));
        const controller = new AbortController();

        const rpcPromise = machineRpcWithServerScope({
            machineId: 'machine-1',
            method: 'method-test',
            payload: { value: 1 },
            signal: controller.signal,
        });
        const captured = rpcPromise.catch((error: unknown) => error);

        await vi.waitFor(() => expect(machineCalls()).toHaveLength(1));
        const request = machineCalls()[0]?.[1];
        expect(request).toMatchObject({ method: 'machine-1:method-test', params: { value: 1 }, requestId: expect.any(String) });
        const requestId = SocketRpcRequestIdSchema.parse(request && typeof request === 'object' && 'requestId' in request ? request.requestId : undefined);

        controller.abort();

        const error = await captured;
        expect((error as { name?: string })?.name).toBe('AbortError');
        expect((error as { code?: string })?.code).toBe('MACHINE_RPC_ABORTED');
        const { readRpcRequestDisposition } = await import('@happier-dev/sync-client');
        expect(readRpcRequestDisposition(error)).toBe('outcomeUnknown');
        expect(socketEmitSpy.mock.calls.filter(([event]) => event === SOCKET_RPC_EVENTS.CANCEL)).toEqual([
            [SOCKET_RPC_EVENTS.CANCEL, { requestId }],
        ]);
        expect(createEphemeralSocketSpy).not.toHaveBeenCalled();
    });

    it('rejects immediately when the signal is already aborted', async () => {
        socketAckSpy.mockResolvedValue({ ok: true, result: { ok: true } });
        const controller = new AbortController();
        controller.abort();

        const outcome = machineRpcWithServerScope({
            machineId: 'machine-1',
            method: 'method-test',
            payload: { value: 1 },
            signal: controller.signal,
        }).catch((error: unknown) => error);
        await expect(outcome).resolves.toMatchObject({ code: 'MACHINE_RPC_ABORTED' });
        const { readRpcRequestDisposition } = await import('@happier-dev/sync-client');
        expect(readRpcRequestDisposition(await outcome)).toBe('notSent');
        expect(machineCalls()).toHaveLength(0);
        expect(socketEmitSpy.mock.calls.filter(([event]) => event === SOCKET_RPC_EVENTS.CANCEL)).toHaveLength(0);
    });

    it('resolves normally when no signal is provided', async () => {
        socketAckSpy.mockResolvedValue({ ok: true, result: { ok: true } });

        await expect(
            machineRpcWithServerScope({
                machineId: 'machine-1',
                method: 'method-test',
                payload: { value: 1 },
            }),
        ).resolves.toEqual({ ok: true });
    });
});
