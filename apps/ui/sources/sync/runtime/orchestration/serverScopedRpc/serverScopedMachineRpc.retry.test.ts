import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RPC_ERROR_CODES } from '@happier-dev/protocol/rpc';
import { createDeferred } from '@/dev/testkit/hooks/createDeferred';
import { installSessionOpsNetworkBoundary, type SessionOpsRpcRequest } from '@/dev/testkit/harness/sessionOpsNetworkBoundary';

const boundary = await installSessionOpsNetworkBoundary();
const { socketRpcCodec } = await import('@happier-dev/sync-client');
const { loadSyncSingletonForTests } = await import('@/dev/testkit/harness/syncSingletonLoader');
await loadSyncSingletonForTests();
const { Encryption } = await import('@/sync/encryption/encryption');
const { TokenStorage } = await import('@/auth/storage/tokenStorage');
const { resetScopedMachineTransportCacheForTests } = await import('./serverScopedRpcPool');
const { serverScopedRpcSocketPool } = await import('./serverScopedRpcSocketPool');
const { resetServerReachabilitySupervisors } = await import('@/sync/runtime/connectivity/serverReachabilitySupervisorPool');
const { resetRunnerCreatorMachineContentKeyTrustProjectionForTests } = await import('@/sync/domains/ephemeralRunner/runnerCreatorMachineContentKeyTrust');
const { machineRpcWithServerScope } = await import('./serverScopedMachineRpc');

// The remote Machine owns the same synthetic legacy Account key as the client.
// Both sides use the real cipher and the current request/response binding codec.
const secret = new Uint8Array(32).fill(1);
const encryption = await Encryption.create(secret);
await encryption.initializeMachines(new Map([['machine-1', null]]));
const cipher = encryption.getMachineEncryption('machine-1');
if (!cipher) throw new Error('Expected initialized Machine encryption');
const content = { mode: 'e2ee' as const, cipher };
let home: Awaited<ReturnType<typeof boundary.addHome>>;

async function decodeRequest(request: SessionOpsRpcRequest) {
    return await socketRpcCodec.decodeRequestParams(content, request.payload, `${request.targetId}:${request.method}`);
}

afterAll(() => boundary.dispose());

describe('machineRpcWithServerScope (scoped encrypted network)', () => {
    beforeEach(async () => {
        boundary.resetRequests();
        resetScopedMachineTransportCacheForTests();
        resetRunnerCreatorMachineContentKeyTrustProjectionForTests();
        home = await boundary.addHome('https://server-a.example.test', 'account-a');
        // Credential storage is the genuine device boundary; context, custody,
        // Machine transport resolution and Encryption construction remain real.
        vi.mocked(TokenStorage.getCredentialsForServerUrl).mockResolvedValue({
            token: home.token,
            secret: Buffer.from(secret).toString('base64url'),
        });
        boundary.setHttpResponder(async (input) => {
            const url = new URL(String(input));
            return url.pathname === '/v1/machines/machine-1'
                ? Response.json({ machine: { id: 'machine-1', dataEncryptionKey: null } })
                : null;
        });
    });

    afterEach(async () => {
        await serverScopedRpcSocketPool.stopAll();
        await resetServerReachabilitySupervisors();
    });

    it('retries once when the scoped rpc method is not available', async () => {
        const decodedRequests: unknown[] = [];
        boundary.setRpcAckResponder(async (request) => {
            const decoded = await decodeRequest(request);
            decodedRequests.push(decoded.params);
            if (decodedRequests.length === 1) {
                return { ok: false, error: 'RPC method not available', errorCode: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE };
            }
            return { ok: true, result: await socketRpcCodec.encodeResponse(content, { ok: true }, decoded.callId) };
        });

        await expect(machineRpcWithServerScope({
            serverId: home.id, machineId: 'machine-1', method: 'method-test',
            payload: { value: 1 }, preferScoped: true, timeoutMs: 1_000,
        })).resolves.toEqual({ ok: true });

        expect(decodedRequests).toEqual([{ value: 1 }, { value: 1 }]);
        expect(boundary.requests).toHaveLength(2);
        expect(boundary.requests).toEqual([
            expect.objectContaining({ serverUrl: home.serverUrl, token: home.token, targetId: 'machine-1', method: 'method-test' }),
            expect.objectContaining({ serverUrl: home.serverUrl, token: home.token, targetId: 'machine-1', method: 'method-test' }),
        ]);
    });

    it('does not retry a scoped exact machine RPC after the real socket emit is issued', async () => {
        boundary.setRpcAckResponder(async (request) => {
            expect((await decodeRequest(request)).params).toEqual({ value: 1 });
            return { ok: false, error: 'RPC method not available', errorCode: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE };
        });
        const onIssued = vi.fn();

        await expect(machineRpcWithServerScope({
            serverId: home.id, machineId: 'machine-1', method: 'method-test',
            payload: { value: 1 }, preferScoped: true, timeoutMs: 1_000, onIssued,
        })).rejects.toMatchObject({ rpcErrorCode: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE });

        expect(onIssued).toHaveBeenCalledOnce();
        expect(boundary.requests).toHaveLength(1);
    });

    it('decrypts a scoped E2EE observation after its caller-owned wait without an expired setup budget', async () => {
        const issued = createDeferred<SessionOpsRpcRequest>();
        const acknowledgement = createDeferred<Awaited<ReturnType<typeof socketRpcCodec.encodeResponse>>>();
        boundary.setRpcResponder(async (request) => {
            issued.resolve(request);
            return await acknowledgement.promise;
        });
        const onIssued = vi.fn();
        const pending = machineRpcWithServerScope({
            serverId: home.id, machineId: 'machine-1', method: 'execution.run.get',
            payload: { runId: 'run-1' }, preferScoped: true, operationTimeoutMs: null, onIssued,
        });
        const settled = vi.fn();
        void pending.then(settled, settled);
        const request = await issued.promise;
        const decoded = await decodeRequest(request);
        expect(decoded.params).toEqual({ runId: 'run-1' });
        const response = await socketRpcCodec.encodeResponse(content, { run: { status: 'running' } }, decoded.callId);
        const startedAt = Date.now();
        const clock = vi.spyOn(Date, 'now').mockReturnValue(startedAt + 31_000);
        try {
            expect(settled).not.toHaveBeenCalled();
            acknowledgement.resolve(response);
            await expect(pending).resolves.toMatchObject({ run: { status: 'running' } });
            expect(onIssued).toHaveBeenCalledOnce();
            expect(boundary.requests).toHaveLength(1);
            expect(boundary.socketBoundaries[0]?.socket.timeout).not.toHaveBeenCalled();
        } finally {
            clock.mockRestore();
        }
    });
});
