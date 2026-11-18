import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RPC_ERROR_CODES, RPC_METHODS } from '@happier-dev/protocol/rpc';
import type { MachinePublishedRowV1 } from '@happier-dev/protocol/machines/machineContentKeyTransitionV1';
import { createDeferred } from '@/dev/testkit/hooks/createDeferred';
import { installSessionOpsNetworkBoundary, type SessionOpsRpcRequest } from '@/dev/testkit/harness/sessionOpsNetworkBoundary';
import { createMachineReadBatchResponseFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';

const boundary = await installSessionOpsNetworkBoundary();
vi.stubGlobal('__TAURI_INTERNALS__', { invoke: vi.fn() });
const { getSystemTasksRunner } = await import('@/components/systemTasks/systemTasksRuntime');
const { publishLocalDaemonStatus } = await import('@/components/settings/machines/localControl/localDaemonSharedState');
const { socketRpcCodec, readRpcRequestDisposition } = await import('@happier-dev/sync-client');
const { loadSyncSingletonForTests } = await import('@/dev/testkit/harness/syncSingletonLoader');
await loadSyncSingletonForTests();
const { Encryption } = await import('@/sync/encryption/encryption');
const { TokenStorage } = await import('@/auth/storage/tokenStorage');
const { resetScopedMachineTransportCacheForTests } = await import('./serverScopedRpcPool');
const { serverScopedRpcSocketPool } = await import('./serverScopedRpcSocketPool');
const { resetServerReachabilitySupervisors } = await import('@/sync/runtime/connectivity/serverReachabilitySupervisorPool');
const { resetRunnerCreatorMachineContentKeyTrustProjectionForTests } = await import('@/sync/domains/ephemeralRunner/runnerCreatorMachineContentKeyTrust');
const { machineRpcWithServerScope } = await import('./serverScopedMachineRpc');
const { machineStopSession } = await import('@/sync/ops/machines');
const { resetServerFeaturesClientForTests } = await import('@/sync/api/capabilities/serverFeaturesClient');
const { fetchMachineDoctorSnapshot } = await import('@/components/machines/doctorSnapshot/readMachineDoctorSnapshot');
const {
    clearMachineRequestReachabilityForTest,
    readMachineRequestReachabilityObservation,
    recordMachineRequestFailed,
    resolveMachineReachability,
    withdrawMachinePresenceForScope,
} = await import('@/sync/domains/machines/reachability/machineReachability');

// The remote Machine owns the same synthetic legacy Account key as the client.
// Both sides use the real cipher and the current request/response binding codec.
const secret = new Uint8Array(32).fill(1);
const encryption = await Encryption.create(secret);
await encryption.initializeMachines(new Map([['machine-1', null]]));
const cipher = encryption.getMachineEncryption('machine-1');
if (!cipher) throw new Error('Expected initialized Machine encryption');
const content = { mode: 'e2ee' as const, cipher };
let home: Awaited<ReturnType<typeof boundary.addHome>>;
const publishedMachine = { id: 'machine-1', managedMachineRef: null, metadata: null, metadataVersion: 0, daemonState: null, daemonStateVersion: 0, dataEncryptionKey: null } satisfies MachinePublishedRowV1;

async function decodeRequest(request: SessionOpsRpcRequest) {
    return await socketRpcCodec.decodeRequestParams(content, request.payload, `${request.targetId}:${request.method}`);
}

async function waitForSetupBoundary(receipt: Promise<void>): Promise<void> {
    let received = false;
    void receipt.then(() => { received = true; });
    await waitForHomeGovernance(() => expect(received).toBe(true));
    await receipt;
}

async function enableDirectRoute(method: string) {
    // Existing desktop status proves the advertised listener is on this host.
    publishLocalDaemonStatus(getSystemTasksRunner(), {
        machineId: 'machine-1', daemonAccountId: 'account-a', daemonServerUrl: home.serverUrl,
    });
    const { createMachineFixture } = await import('@/dev/testkit/fixtures/machineFixtures');
    const { getStorage } = await import('@/sync/domains/state/storageStore');
    const endpoint = { v: 1, routeKind: 'loopback_direct', url: 'http://127.0.0.1:3000/',
        endpointFingerprint: 'r16-endpoint', expiresAt: Date.now() + 300_000 };
    const machine = createMachineFixture({ daemonState: { peerMediation: { loopback: { endpoint } } } });
    getStorage().setState({ machines: { [machine.id]: machine }, machineListByServerId: { [home.id]: [machine] } });
    boundary.setHttpResponder(async (input, init) => {
        const url = new URL(String(input));
        if (url.pathname === '/v1/machines/read-batch' && init?.method === 'POST') return createMachineReadBatchResponseFixture(init.body,
            id => id === publishedMachine.id ? publishedMachine : null);
        if (url.pathname === '/v1/features') return Response.json({ features: { machines: {
            enabled: true, rpc: { enabled: true, directPeer: { enabled: true } },
        } }, capabilities: {} });
        if (url.pathname === '/v1/machines/peer/mediation/route-grants') {
            const request = JSON.parse(String(init?.body));
            const now = Date.now();
            return Response.json({ ok: true, grant: { payload: {
                v: 2, grantId: 'r16-grant', accountId: 'account-a', machineId: 'machine-1',
                flowKind: 'machine_rpc', routeKind: 'loopback_direct', scope: request.scope,
                iat: now, exp: now + 300_000, aud: 'happier-daemon-route-grant',
                endpointFingerprint: endpoint.endpointFingerprint, proofKind: 'ephemeral_ed25519',
                ephemeralPublicKeyBase64Url: request.ephemeralPublicKeyBase64Url,
            }, signature: { keyId: 'r16-key', alg: 'Ed25519',
                valueBase64Url: Buffer.from(new Uint8Array(64).fill(2)).toString('base64url') } } });
        }
        return url.pathname === '/v1/machines/machine-1'
            ? Response.json({ machine: { id: 'machine-1', dataEncryptionKey: null } }) : null;
    });
    return machineRpcWithServerScope({ serverId: home.id, machineId: 'machine-1', method,
        payload: { command: 'close' }, timeoutMs: 10_000 });
}

afterAll(() => boundary.dispose());

describe('machineRpcWithServerScope (scoped encrypted network)', () => {
    beforeEach(async () => {
        vi.stubGlobal('__TAURI_INTERNALS__', { invoke: vi.fn() });
        clearMachineRequestReachabilityForTest();
        boundary.resetRequests();
        resetScopedMachineTransportCacheForTests();
        resetServerFeaturesClientForTests();
        resetRunnerCreatorMachineContentKeyTrustProjectionForTests();
        const { createAccountTokenForTests } = await import('@/dev/testkit/harness/homeGovernanceHarness');
        home = await boundary.addHome('https://server-a.example.test', 'account-a', {
            encryptionMode: 'e2ee', credentials: {
                token: createAccountTokenForTests('account-a'), secret: Buffer.from(secret).toString('base64url'),
            },
        });
        boundary.setHttpResponder(async (input, init) => {
            const url = new URL(String(input));
            if (url.pathname === '/v1/machines/read-batch' && init?.method === 'POST') return createMachineReadBatchResponseFixture(init.body,
                id => id === publishedMachine.id ? publishedMachine : null);
            return url.pathname === '/v1/machines/machine-1'
                ? Response.json({ machine: { id: 'machine-1', dataEncryptionKey: null } })
                : null;
        });
    });

    afterEach(async () => {
        publishLocalDaemonStatus(getSystemTasksRunner(), null);
        vi.unstubAllGlobals();
        await serverScopedRpcSocketPool.stopAll();
        await resetServerReachabilitySupervisors();
    });

    it.each(['not-shared-machine', 'absent-machine'])('refuses a finite Project Action without disclosing or dispatching to %s', async machineId => {
        let selectedReads = 0;
        boundary.setHttpResponder(async (input, init) => {
            const url = new URL(String(input));
            if (url.pathname === '/v1/machines/read-batch') {
                selectedReads += 1;
                return createMachineReadBatchResponseFixture(init?.body, () => null);
            }
            return null;
        });
        const { PROJECT_FINITE_ACTION_RPC_METHODS_V1 } = await import('@happier-dev/protocol/actions/projectActionFamily');
        await expect(machineRpcWithServerScope({ serverId: home.id, machineId,
            method: PROJECT_FINITE_ACTION_RPC_METHODS_V1['projects.script.run'],
            payload: { command: 'private-project-command' }, timeoutMs: 5_000,
        })).rejects.toMatchObject({ rpcErrorCode: RPC_ERROR_CODES.FORBIDDEN });
        expect(selectedReads).toBe(1);
        expect(boundary.requests).toHaveLength(0);
    });

    it('retains known Machine presence when a request completes across repeated transport withdrawal', async () => {
        const issued = createDeferred<void>();
        const reply = createDeferred<void>();
        const scope = { serverId: home.id, accountId: 'account-a' };
        const machine = { id: 'machine-1', active: true, activeAt: 0 };
        withdrawMachinePresenceForScope(scope);
        expect(resolveMachineReachability(scope, machine)).toBe('reachable');
        boundary.setRpcAckResponder(async request => {
            const decoded = await decodeRequest(request);
            issued.resolve();
            await reply.promise;
            return { ok: true, result: await socketRpcCodec.encodeResponse(content, { ok: true }, decoded.callId) };
        });
        const pending = machineRpcWithServerScope({ serverId: home.id, machineId: machine.id,
            method: 'method-test', payload: {}, preferScoped: true });
        await issued.promise;
        withdrawMachinePresenceForScope(scope);
        reply.resolve();
        await expect(pending).resolves.toEqual({ ok: true });
        expect(resolveMachineReachability(scope, machine)).toBe('reachable');
        expect(resolveMachineReachability(scope, { ...machine, id: 'untouched-machine' })).toBe('reachable');
        expect(resolveMachineReachability(scope, { ...machine, revokedAt: 1 })).toBe('unreachable');
    });

    it('records a successful reply under the captured credential Account after credentials change', async () => {
        const issued = createDeferred<void>();
        const reply = createDeferred<void>();
        const originalScope = { serverId: home.id, accountId: 'account-a' };
        const nextScope = { serverId: home.id, accountId: 'account-b' };
        recordMachineRequestFailed({ ...originalScope, machineId: 'machine-1' });
        recordMachineRequestFailed({ ...nextScope, machineId: 'machine-1' });
        boundary.setRpcAckResponder(async (request) => {
            const decoded = await decodeRequest(request);
            issued.resolve();
            await reply.promise;
            return { ok: true, result: await socketRpcCodec.encodeResponse(content, { ok: true }, decoded.callId) };
        });
        const pending = machineRpcWithServerScope({ serverId: home.id, machineId: 'machine-1',
            method: 'method-test', payload: {}, preferScoped: true });
        await issued.promise;
        vi.mocked(TokenStorage.getCredentialsForServerUrl).mockResolvedValue({
            token: `header.${Buffer.from(JSON.stringify({ sub: 'account-b' })).toString('base64url')}.signature`,
            secret: Buffer.from(secret).toString('base64url'),
        });
        reply.resolve();
        await expect(pending).resolves.toEqual({ ok: true });
        expect(readMachineRequestReachabilityObservation(originalScope, 'machine-1')).toMatchObject({ outcome: 'succeeded' });
        expect(readMachineRequestReachabilityObservation(nextScope, 'machine-1')).toMatchObject({ outcome: 'failed' });
    });

    it('preserves Machine reachability when a no-reply caller deadline expires', async () => {
        const issued = createDeferred<void>();
        const reply = createDeferred<void>();
        boundary.setRpcAckResponder(async () => {
            issued.resolve();
            await reply.promise;
            return { ok: false, error: 'Unavailable' };
        });
        vi.useFakeTimers();
        try {
            const pending = machineRpcWithServerScope({ serverId: home.id, machineId: 'machine-1',
                method: 'method-test', payload: {}, preferScoped: true, timeoutMs: 1_000 })
                .catch((error: unknown) => error);
            await waitForSetupBoundary(issued.promise);
            await vi.advanceTimersByTimeAsync(1_000);
            expect(await pending).toMatchObject({ code: 'MACHINE_RPC_TIMEOUT' });
            expect(readMachineRequestReachabilityObservation({ serverId: home.id, accountId: 'account-a' }, 'machine-1'))
                .toBeNull();
        } finally {
            reply.resolve();
            vi.useRealTimers();
        }
    });

    it.each([RPC_ERROR_CODES.FORBIDDEN, RPC_ERROR_CODES.METHOD_NOT_AVAILABLE, 'MACHINE_ENCRYPTION_UNAVAILABLE', 'MACHINE_RPC_TIMEOUT', 'action_failed'])('preserves the Computer RPC refusal through the real Action consumer: %s', async errorCode => {
        const [{ createActionExecutor}, { createUnavailableRuntimeActionExecutor}] = await Promise.all([import('@happier-dev/protocol/actions/actionExecutor'), import('@happier-dev/protocol/actions/executor/dispatch')]);
        const { ActionExecuteFailureSchema } = await import('@happier-dev/protocol/actions/actionExecutionResult');
        const { createComputerRuntimeActionExecutor } = await import('@/sync/domains/computer/actions/runtimeActionExecutor');
        const { createComputerControlClient } = await import('@/sync/domains/computer/computerControlClient');
        boundary.setRpcAckResponder(async request => {
            expect(request.method).toBe(RPC_METHODS.DAEMON_COMPUTER_ACTION_EXECUTE);
            const { DaemonComputerActionExecuteRequestV1Schema } = await import('@happier-dev/protocol/computer/v1');
            const decoded = await decodeRequest(request);
            expect(DaemonComputerActionExecuteRequestV1Schema.parse(decoded.params)).toMatchObject({ actionId: 'computer.targets.list' });
            if (errorCode === 'MACHINE_RPC_TIMEOUT') throw Object.assign(new Error('Deadline expired'), { code: errorCode });
            if (errorCode === 'action_failed') throw new Error('Unclassified network failure');
            return { ok: false, error: 'Owner refused the request', errorCode };
        });
        const executor = createActionExecutor({ runtimeActionExecute: createComputerRuntimeActionExecutor({ fallback: createUnavailableRuntimeActionExecutor() }) } as import('@happier-dev/protocol/actions/executor/types').ActionExecutorDeps);
        let failure: unknown;
        const execute: typeof executor.execute = async (...args) => {
            const result = await executor.execute(...args);
            failure = result;
            return result;
        };
        const client = createComputerControlClient({ serverId: home.id, machineId: 'machine-1', sessionId: 'computer-session' }, execute);
        expect(await client.listTargets()).toEqual({ ok: false, code: errorCode });
        expect(ActionExecuteFailureSchema.parse(failure)).toMatchObject({ errorCode });
        expect(boundary.requests.length).toBeGreaterThan(0);
    });

    it('keeps the released daemon Stop acknowledgement pending through the legacy Machine facade', async () => {
        boundary.setRpcAckResponder(async request => {
            const decoded = await decodeRequest(request);
            expect(request).toMatchObject({ serverUrl: 'https://server-a.example.test',
                targetId: 'machine-1', method: RPC_METHODS.STOP_SESSION });
            expect(decoded.params).toEqual({ sessionId: 'session-1' });
            return { ok: true, result: await socketRpcCodec.encodeResponse(content, { message: 'Session stopped' }, decoded.callId) };
        });
        expect(await machineStopSession('machine-1', 'session-1', { serverId: home.id }))
            .toEqual({ ok: true, status: 'requested' });
        expect(boundary.requests).toHaveLength(1);
    });

    it('withdraws a pre-aborted canonical Stop before transport issuance', async () => {
        const { stopSessionViaDaemonMachineRpc } = await import('@/sync/ops/sessionStopStrategy');
        const controller = new AbortController();
        controller.abort();
        expect(await stopSessionViaDaemonMachineRpc({ serverId: home.id, accountId: 'account-a',
            machineId: 'machine-1', sessionId: 'session-1', signal: controller.signal }))
            .toMatchObject({ type: 'failed', errorCode: 'MACHINE_RPC_ABORTED' });
        expect(boundary.requests).toEqual([]);
    });

    it.each(['disconnect', 'decode', 'malformed', 'refusal'] as const)('preserves canonical Stop custody after native %s', async outcome => {
        const { stopSessionUsingCanonicalStrategy } = await import('@/sync/ops/sessionStopStrategy');
        const { createSessionFixture } = await import('@/dev/testkit/fixtures/sessionFixtures');
        const { storage } = await import('@/sync/domains/state/storage');
        const sessionId = 'uncertain-stop-session';
        const session = createSessionFixture({ id: sessionId, serverId: home.id, active: true,
            metadata: { path: '/repo', host: 'tester.local', machineId: 'machine-1' } });
        storage.setState({ sessions: { [sessionId]: session } });
        boundary.setRpcAckResponder(async request => {
            expect(request.method).toBe(RPC_METHODS.STOP_SESSION);
            if (outcome === 'refusal') return { ok: false, error: 'Forbidden', errorCode: RPC_ERROR_CODES.FORBIDDEN };
            if (outcome === 'decode') return { ok: true, result: 'invalid-encrypted-response' };
            if (outcome === 'malformed') {
                const decoded = await decodeRequest(request);
                return { ok: true, result: await socketRpcCodec.encodeResponse(content, null, decoded.callId) };
            }
            const physical = boundary.socketBoundaries.find(socket => socket.serverUrl === request.serverUrl);
            if (!physical) throw new Error('Expected issued Stop socket');
            physical.trigger('disconnect', 'transport close');
            // Native Socket.IO rejects outstanding ACKs when its namespace closes.
            throw new Error('socket has been disconnected');
        });

        const result = await stopSessionUsingCanonicalStrategy({ sessionId, serverId: home.id,
            scope: { serverId: home.id, accountId: 'account-a' } });

        expect(result).toMatchObject(outcome !== 'refusal'
            ? { success: false, reason: 'requested', recovery: 'wait_for_inactive' }
            : { success: false, reason: 'failed', errorCode: RPC_ERROR_CODES.FORBIDDEN });
        expect(boundary.requests.map(request => request.method)).toEqual([RPC_METHODS.STOP_SESSION]);
        expect(storage.getState().sessions[sessionId]?.active).toBe(true);
    });

    it.each(['disconnect', 'malformed', 'refusal'] as const)('preserves runner Stop custody after native %s', async outcome => {
        const { stopSessionUsingCanonicalStrategy } = await import('@/sync/ops/sessionStopStrategy');
        const { createSessionFixture, createPlainSessionCurrentProjectionRecordFixture } = await import('@/dev/testkit/fixtures/sessionFixtures');
        const { storage } = await import('@/sync/domains/state/storage');
        const runnerHome = await boundary.addHome('https://runner-stop.example.test', 'account-a');
        const sessionId = 'runner-stop-session';
        const metadata = { path: '/repo', host: 'unmatched.local' };
        storage.setState({ sessions: { [sessionId]: createSessionFixture({ id: sessionId,
            serverId: runnerHome.id, active: true, metadata }) }, machines: {} });
        boundary.setHttpResponder(async input => {
            const url = new URL(String(input));
            return url.pathname === `/v2/sessions/${sessionId}`
                ? Response.json({ session: createPlainSessionCurrentProjectionRecordFixture({ id: sessionId, active: true, metadata }) })
                : null;
        });
        boundary.setRpcAckResponder(async request => {
            expect(request.method).toBe('killSession');
            if (outcome === 'refusal') return { ok: false, error: 'Forbidden', errorCode: RPC_ERROR_CODES.FORBIDDEN };
            if (outcome === 'malformed') return { ok: true, result: null };
            const physical = boundary.socketBoundaries.find(socket => socket.serverUrl === request.serverUrl);
            if (!physical) throw new Error('Expected issued runner Stop socket');
            physical.trigger('disconnect', 'transport close');
            throw new Error('socket has been disconnected');
        });

        expect(await stopSessionUsingCanonicalStrategy({ sessionId, serverId: runnerHome.id }))
            .toMatchObject(outcome !== 'refusal'
                ? { success: false, reason: 'requested', recovery: 'wait_for_inactive' }
                : { success: false, reason: 'failed', errorCode: RPC_ERROR_CODES.FORBIDDEN });
        expect(boundary.requests.map(request => request.method)).toEqual(['killSession']);
        expect(storage.getState().sessions[sessionId]?.active).toBe(true);
    });

    it.each(['reply', 'cancel'] as const)('keeps canonical Stop under the admitted operation lifetime: %s', async outcome => {
        const { stopSessionViaDaemonMachineRpc } = await import('@/sync/ops/sessionStopStrategy');
        const { StopSessionResultSchema } = await import('@happier-dev/protocol/sessionStop');
        const issued = createDeferred<void>();
        const reply = createDeferred<void>();
        const controller = new AbortController();
        boundary.setRpcAckResponder(async request => {
            const decoded = await decodeRequest(request);
            expect(request.method).toBe(RPC_METHODS.STOP_SESSION);
            expect(decoded.params).toEqual({ sessionId: 'slow-stopped-session' });
            issued.resolve();
            await reply.promise;
            const result = StopSessionResultSchema.parse({ status: 'stopped' });
            return { ok: true, result: await socketRpcCodec.encodeResponse(content, result, decoded.callId) };
        });
        vi.useFakeTimers();
        try {
            const pending = stopSessionViaDaemonMachineRpc({ serverId: home.id, accountId: 'account-a',
                machineId: 'machine-1', sessionId: 'slow-stopped-session', signal: controller.signal });
            const settled = vi.fn();
            void pending.then(settled, settled);
            await waitForSetupBoundary(issued.promise);
            await vi.advanceTimersByTimeAsync(31_000);
            expect(settled).not.toHaveBeenCalled();
            expect(boundary.requests).toHaveLength(1);
            if (outcome === 'cancel') controller.abort();
            else reply.resolve();
            await expect(pending).resolves.toMatchObject({ type: outcome === 'cancel' ? 'requested' : 'stopped' });
            expect(boundary.requests).toHaveLength(1);
        } finally {
            reply.resolve();
            vi.useRealTimers();
        }
    });

    it('does not poison reachability when an inner transport timeout precedes the caller deadline', async () => {
        const innerTimeout = Object.assign(new Error('Inner phase timed out'), { code: 'MACHINE_RPC_TIMEOUT' });
        boundary.setRpcAckResponder(async () => {
            throw innerTimeout;
        });
        const error = await machineRpcWithServerScope({ serverId: home.id, machineId: 'machine-1',
            method: 'method-test', payload: {}, preferScoped: true, timeoutMs: 10_000 }).catch((error: unknown) => error);
        expect(error).toMatchObject({ code: 'MACHINE_RPC_TIMEOUT' });
        expect(error).toBe(innerTimeout);
        expect(readMachineRequestReachabilityObservation({ serverId: home.id, accountId: 'account-a' }, 'machine-1')).toBeNull();
    });

    it('does not mark an answering direct daemon unreachable while its HTTP reply is being decoded', async () => {
        const answered = createDeferred<void>();
        const body = createDeferred<unknown>();
        const response = Response.json({});
        // Response is the HTTP boundary; route selection and timeout accounting remain real.
        vi.spyOn(response, 'json').mockImplementation(() => body.promise);
        vi.stubGlobal('fetch', async (_input: RequestInfo | URL, init?: RequestInit) => {
            if (init?.method === 'OPTIONS') return new Response(null, { status: 204 });
            answered.resolve(); return response;
        });
        vi.useFakeTimers();
        try {
            const pending = enableDirectRoute(RPC_METHODS.DAEMON_BROWSER_CONTROL_DISPATCH)
                .catch((error: unknown) => error);
            await answered.promise;
            await vi.advanceTimersByTimeAsync(10_000);
            expect(await pending).toMatchObject({ code: 'MACHINE_RPC_TIMEOUT' });
            expect(readMachineRequestReachabilityObservation({ serverId: home.id, accountId: 'account-a' }, 'machine-1')).toBeNull();
        } finally {
            body.resolve({});
            vi.useRealTimers();
        }
    });

    it.each([RPC_METHODS.DAEMON_BROWSER_CONTROL_DISPATCH, RPC_METHODS.DAEMON_BROWSER_CONTEXT_DISPATCH])(
        'does not replay an ambiguous direct effect over a successful relay for %s', async (method) => {
            let effects = 0;
            vi.stubGlobal('fetch', async (_input: RequestInfo | URL, init?: RequestInit) => {
                if (init?.method === 'OPTIONS') return new Response(null, { status: 204 });
                effects++; return Response.json({ unreadableResponse: true });
            });
            boundary.setRpcAckResponder(async (request) => {
                effects++;
                const decoded = await decodeRequest(request);
                return { ok: true, result: await socketRpcCodec.encodeResponse(content, { ok: true }, decoded.callId) };
            });
            const error = await enableDirectRoute(method).catch((error: unknown) => error);
            expect(effects).toBe(1);
            expect(boundary.requests).toHaveLength(0);
            expect(readRpcRequestDisposition(error)).toBe('outcomeUnknown');
        },
    );

    it('keeps a sent direct outcome unknown when relay preparation cannot emit', async () => {
        let directCalls = 0;
        vi.stubGlobal('fetch', async (_input: RequestInfo | URL, init?: RequestInit) => {
            if (init?.method === 'OPTIONS') return new Response(null, { status: 204 });
            directCalls++; return Response.json({ unreadableResponse: true });
        });
        boundary.setSocketConfigurator(({ socket }) => {
            socket.timeout.mockImplementation(() => { throw new Error('R16 relay preparation failure'); });
        });
        const error = await enableDirectRoute(RPC_METHODS.DAEMON_BROWSER_CONTROL_DISPATCH).catch((error: unknown) => error);
        expect(directCalls).toBe(1);
        expect(boundary.requests).toHaveLength(0);
        expect(readRpcRequestDisposition(error)).toBe('outcomeUnknown');
    });

    it.each(['grant_revoked', 'handler_unavailable'] as const)(
        'distinguishes the direct %s refusal from an ambiguous handler result', async (reasonCode) => {
            vi.stubGlobal('fetch', async (_input: RequestInfo | URL, init?: RequestInit) => {
                if (init?.method === 'OPTIONS') return new Response(null, { status: 204 });
                const request = JSON.parse(String(init?.body));
                return Response.json({ v: 2, ok: false, receipt: 'peer.rpc.fell_back_to_server',
                    requestId: request.requestId, method: request.method, reasonCode });
            });
            boundary.setSocketConfigurator(({ socket }) => {
                socket.timeout.mockImplementation(() => { throw new Error('R16 relay preparation failure'); });
            });
            const error = await enableDirectRoute(RPC_METHODS.DAEMON_BROWSER_CONTROL_DISPATCH).catch((error: unknown) => error);
            expect(boundary.requests).toHaveLength(0);
            expect(readRpcRequestDisposition(error)).toBe(reasonCode === 'grant_revoked' ? 'notSent' : 'outcomeUnknown');
        },
    );

    it('can deliver through the encrypted relay after a bound stale-grant refusal', async () => {
        vi.stubGlobal('fetch', async (_input: RequestInfo | URL, init?: RequestInit) => {
            if (init?.method === 'OPTIONS') return new Response(null, { status: 204 });
            const request = JSON.parse(String(init?.body));
            return Response.json({ v: 2, ok: false, receipt: 'peer.rpc.fell_back_to_server',
                requestId: request.requestId, method: request.method, reasonCode: 'grant_revoked' });
        });
        boundary.setRpcAckResponder(async (request) => {
            const decoded = await decodeRequest(request);
            expect(decoded.params).toEqual({ command: 'close' });
            return { ok: true, result: await socketRpcCodec.encodeResponse(content, { closed: true }, decoded.callId) };
        });
        await expect(enableDirectRoute(RPC_METHODS.DAEMON_BROWSER_CONTROL_DISPATCH)).resolves.toEqual({ closed: true });
        expect(boundary.requests).toHaveLength(1);
    });

    it('preserves no-effect unavailable-method rejection when the next relay attempt cannot emit', async () => {
        boundary.setRpcAckResponder(async () => ({ ok: false, error: 'RPC method not available',
            errorCode: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE }));
        let preparationCalls = 0;
        boundary.setSocketConfigurator(({ socket }) => {
            const prepare = socket.timeout.getMockImplementation();
            socket.timeout.mockImplementation((timeoutMs) => {
                if (++preparationCalls === 2) throw new Error('R16 retry preparation failure');
                return prepare?.(timeoutMs) ?? socket;
            });
        });
        const error = await machineRpcWithServerScope({ serverId: home.id, machineId: 'machine-1',
            method: 'method-test', payload: {}, preferScoped: true, timeoutMs: 10_000 }).catch((error: unknown) => error);
        expect(boundary.requests).toHaveLength(1);
        expect(readRpcRequestDisposition(error)).toBe('notSent');
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

    it('spends one total deadline across an unavailable-method reply, retry delay, and the next RPC', async () => {
        const firstIssued = createDeferred<void>();
        const firstReply = createDeferred<void>();
        const retryIssued = createDeferred<void>();
        const retryReply = createDeferred<void>();
        boundary.setRpcAckResponder(async () => {
            if (boundary.requests.length === 1) {
                firstIssued.resolve();
                await firstReply.promise;
            } else {
                retryIssued.resolve();
                await retryReply.promise;
            }
            return { ok: false, error: 'Not available', errorCode: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE };
        });
        vi.useFakeTimers();
        try {
            const startedAt = Date.now();
            const settled = vi.fn();
            const pending = machineRpcWithServerScope({
                serverId: home.id, machineId: 'machine-1', method: RPC_METHODS.BUGREPORT_COLLECT_DIAGNOSTICS,
                payload: {}, timeoutMs: 4_000,
            }).then(settled, settled);
            await waitForSetupBoundary(firstIssued.promise);
            await vi.advanceTimersByTimeAsync(3_000);
            firstReply.resolve();
            await vi.advanceTimersByTimeAsync(250);
            await waitForSetupBoundary(retryIssued.promise);
            await vi.advanceTimersByTimeAsync(startedAt + 4_000 - Date.now() - 1);
            expect(settled).not.toHaveBeenCalled();
            await vi.advanceTimersByTimeAsync(1);
            expect(settled).toHaveBeenCalledWith(expect.objectContaining({ code: 'MACHINE_RPC_TIMEOUT', timeoutMs: 4_000, scope: 'scoped' }));
            expect(readRpcRequestDisposition(settled.mock.calls[0]?.[0])).toBe('outcomeUnknown');
            await pending;
        } finally {
            firstReply.resolve();
            retryReply.resolve();
            vi.useRealTimers();
        }
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

    it('includes real peer-route feature discovery in the server fallback deadline', async () => {
        const featuresRequested = createDeferred<void>();
        const featuresReply = createDeferred<void>();
        const issued = createDeferred<void>();
        const rpcReply = createDeferred<void>();
        boundary.setHttpResponder(async (input, init) => {
            const url = new URL(String(input));
            if (url.pathname === '/v1/machines/read-batch' && init?.method === 'POST') return createMachineReadBatchResponseFixture(init.body,
                id => id === publishedMachine.id ? publishedMachine : null);
            if (url.pathname === '/v1/features') {
                featuresRequested.resolve();
                await featuresReply.promise;
                return Response.json({}, { status: 404 });
            }
            return url.pathname === '/v1/machines/machine-1'
                ? Response.json({ machine: { id: 'machine-1', dataEncryptionKey: null } })
                : null;
        });
        boundary.setRpcAckResponder(async () => {
            issued.resolve();
            await rpcReply.promise;
            return { ok: false, error: 'Unavailable' };
        });
        vi.useFakeTimers();
        try {
            const startedAt = Date.now();
            const settled = vi.fn();
            const pending = machineRpcWithServerScope({
                serverId: home.id, machineId: 'machine-1', method: RPC_METHODS.DAEMON_MEMORY_STATUS,
                payload: {}, timeoutMs: 4_000,
            }).then(settled, settled);
            await waitForSetupBoundary(featuresRequested.promise);
            await vi.advanceTimersByTimeAsync(3_000);
            featuresReply.resolve();
            await waitForSetupBoundary(issued.promise);
            await vi.advanceTimersByTimeAsync(startedAt + 4_000 - Date.now() - 1);
            expect(settled).not.toHaveBeenCalled();
            await vi.advanceTimersByTimeAsync(1);
            expect(settled).toHaveBeenCalledWith(expect.objectContaining({ code: 'MACHINE_RPC_TIMEOUT', timeoutMs: 4_000 }));
            await pending;
        } finally {
            featuresReply.resolve();
            rpcReply.resolve();
            vi.useRealTimers();
        }
    });

    it('proves saved Workflow admission was not sent when Machine setup exhausts its budget', async () => {
        const machineRequested = createDeferred<void>();
        const machineReply = createDeferred<void>();
        boundary.setHttpResponder(async (input, init) => {
            const url = new URL(String(input));
            if (url.pathname !== '/v1/machines/machine-1' && url.pathname !== '/v1/machines/read-batch') return null;
            machineRequested.resolve();
            await machineReply.promise;
            if (url.pathname === '/v1/machines/read-batch') return createMachineReadBatchResponseFixture(init?.body,
                id => id === publishedMachine.id ? publishedMachine : null);
            return Response.json({ machine: { id: 'machine-1', dataEncryptionKey: null } });
        });
        vi.useFakeTimers();
        try {
            const { createUiAccountActionTransport } = await import('@/sync/ops/actions/accountActionTransport');
            const execute = createUiAccountActionTransport({
                account: { serverId: home.id, accountId: 'account-a', assertCurrent: () => {}, assertResultCurrent: () => {} },
                resolveFallbackMachineId: () => null,
                transport: request => machineRpcWithServerScope({ ...request, preferScoped: true, timeoutMs: 4_000 }),
            });
            const attempt = execute({ actionId: 'workflow.run.start', input: {
                runId: '11111111-1111-4111-8111-111111111111',
                source: { kind: 'saved', definitionId: '22222222-2222-4222-8222-222222222222',
                    revision: { headerVersion: 1, bodyVersion: 1 } },
            }, context: { surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' }, serverId: home.id, runtimeAccountId: 'account-a',
                externalActionTarget: { kind: 'machine', machineId: 'machine-1',
                    project: { machineId: 'machine-1', directory: '/tmp' } } } }).catch((error: unknown) => error);
            await waitForSetupBoundary(machineRequested.promise);
            await vi.advanceTimersByTimeAsync(4_000);
            const error = await attempt;
            expect(error).toMatchObject({ code: 'MACHINE_RPC_TIMEOUT' });
            expect(boundary.requests).toHaveLength(0);
            expect(readRpcRequestDisposition(error)).toBe('notSent');
            machineReply.resolve();
            await vi.advanceTimersByTimeAsync(0);
            expect(boundary.requests).toHaveLength(0);
        } finally {
            machineReply.resolve();
            vi.useRealTimers();
        }
    });

    it('keeps a connected Machine reachable when real Session spawn setup exhausts its budget', async () => {
        const machineRequested = createDeferred<void>();
        const machineReply = createDeferred<void>();
        boundary.setHttpResponder(async (input, init) => {
            const path = new URL(String(input)).pathname;
            if (path !== '/v1/machines/machine-1' && path !== '/v1/machines/read-batch') return null;
            machineRequested.resolve();
            await machineReply.promise;
            if (path === '/v1/machines/read-batch') return createMachineReadBatchResponseFixture(init?.body,
                id => id === publishedMachine.id ? publishedMachine : null);
            return Response.json({ machine: { id: 'machine-1', dataEncryptionKey: null } });
        });
        const { dispatchSessionSpawnNewToMachine } = await import('@/sync/ops/actions/sessionSpawnNewAction');
        const { readSpawnSessionRpcTimeoutMsFromEnv } = await import('@/sync/domains/session/spawn/spawnSessionRpcTimeout');
        const { SessionSpawnNewInputV2Schema } = await import('@happier-dev/protocol/sessions/creation/sessionSpawnNewInputV2');
        const { SessionSpawnNewResultV1Schema } = await import('@happier-dev/protocol/sessions/creation/sessionSpawnNewResultV1');
        const { clearBugReportUserActionTrail, getBugReportUserActionTrail } = await import('@/utils/system/bugReportActionTrail');
        const { isMachineReachable, isMachineRequestReachabilityFailure } = await import('@/sync/domains/machines/reachability/machineReachability');
        clearBugReportUserActionTrail();
        const scope = { serverId: home.id, accountId: 'account-a' };
        const connectedMachine = { id: 'machine-1', active: true, activeAt: Date.now() };
        const payload = SessionSpawnNewInputV2Schema.parse({
            creationKey: 'fix81-setup', executionTarget: { serverId: home.id, machineId: 'machine-1' },
            directory: { kind: 'path', path: '/tmp' },
            agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.claude', localId: 'claude' } },
        });
        vi.useFakeTimers();
        try {
            expect(isMachineReachable(scope, connectedMachine)).toBe(true);
            const pending = dispatchSessionSpawnNewToMachine({ payload });
            await waitForSetupBoundary(machineRequested.promise);
            await vi.advanceTimersByTimeAsync(readSpawnSessionRpcTimeoutMsFromEnv());
            const result = SessionSpawnNewResultV1Schema.parse(await pending);
            expect(result).toEqual({ type: 'error', code: 'spawn_failed', retryable: true,
                launchError: expect.objectContaining({ kind: 'launch_error', code: 'MACHINE_RPC_TIMEOUT' }) });
            expect(isMachineRequestReachabilityFailure(result)).toBe(false);
            expect(readMachineRequestReachabilityObservation(scope, 'machine-1')).toBeNull();
            expect(isMachineReachable(scope, { ...connectedMachine, activeAt: Date.now() })).toBe(true);
            expect(getBugReportUserActionTrail()).toEqual([expect.objectContaining({
                action: 'session.spawn_new.transport_failure', metadata: expect.objectContaining({
                    errorCode: 'MACHINE_RPC_TIMEOUT', issued: false, phase: 'setup', transportScope: 'scoped',
                }),
            })]);
            expect(boundary.requests).toHaveLength(0);
            machineReply.resolve();
            await vi.advanceTimersByTimeAsync(0);
            expect(boundary.requests).toHaveLength(0);
        } finally {
            machineReply.resolve();
            vi.useRealTimers();
        }
    });

    it('settles the doctor snapshot with an error once the transport budget is spent, even when the daemon never answers', async () => {
        const issued = createDeferred<void>();
        const reply = createDeferred<void>();
        boundary.setRpcAckResponder(async () => {
            issued.resolve();
            await reply.promise;
            return { ok: false, error: 'Unavailable' };
        });
        vi.useFakeTimers();
        try {
            const startedAt = Date.now();
            const settled = vi.fn();
            const pending = fetchMachineDoctorSnapshot({
                serverId: home.id, machineId: 'machine-1', timeoutMs: 4_000,
            }).then(settled);
            await waitForSetupBoundary(issued.promise);
            await vi.advanceTimersByTimeAsync(startedAt + 4_000 - Date.now() - 1);
            expect(settled).not.toHaveBeenCalled();
            await vi.advanceTimersByTimeAsync(1);
            await pending;
            expect(settled).toHaveBeenCalledWith(expect.objectContaining({ status: 'error' }));
        } finally {
            reply.resolve();
            vi.useRealTimers();
        }
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
            expect(request.timeoutMs ?? null).toBeNull();
        } finally {
            clock.mockRestore();
        }
    });
});
