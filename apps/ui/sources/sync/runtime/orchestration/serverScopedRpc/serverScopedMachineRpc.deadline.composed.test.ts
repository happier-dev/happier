import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from 'node:http';
import { Server } from 'socket.io';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { FeaturesResponseSchema} from '@happier-dev/protocol/features/payload/featuresResponseSchema';
import { MACHINE_PLAIN_DATA_KEY_MARKER} from '@happier-dev/protocol/machines/machineStoredContent';
import { PEER_MEDIATION_RECEIPTS} from '@happier-dev/protocol/machines/peer/mediation/receipts';
import {
    PeerLoopbackEndpointCandidateV1Schema } from '@happier-dev/protocol/machines/peer/mediation/loopbackEndpointV1';
import { RPC_ERROR_CODES, RPC_METHODS } from '@happier-dev/protocol/rpc';
import { DirectRouteGrantRequestV2Schema, SignedDirectRouteGrantV2Schema } from '@happier-dev/protocol/machines/peer/mediation/directRouteGrantV2';
import { PEER_MACHINE_RPC_DIRECT_PATH_V2, PeerMachineRpcDirectRequestV2Schema,
    PeerMachineRpcDirectResponseV2Schema } from '@happier-dev/protocol/machines/peer/mediation/rpc/directV2';
import { SOCKET_RPC_EVENTS, SocketRpcTimeoutMsSchema, type SocketRpcRequestPayload } from '@happier-dev/protocol/socketRpc';
import { readRpcRequestDisposition, socketRpcCodec } from '@happier-dev/sync-client';
import { upsertServerProfile } from '@/sync/domains/server/serverProfiles';
import { machineRpcWithServerScope } from './serverScopedMachineRpc';
import { createMachineRpcReadAdmission } from './machineRpcReadAdmission';
import { resetScopedMachineTransportCacheForTests } from './serverScopedRpcPool';
import { serverScopedRpcSocketPool } from './serverScopedRpcSocketPool';
import { createMachineFixture, createMachineReadBatchResponseFixture, createPlainMachineRowFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { getStorage } from '@/sync/domains/state/storageStore';
import { clearMachineRequestReachabilityForTest, clearMachineRequestReachabilityForMachine,
    readMachineRequestReachabilityObservation } from '@/sync/domains/machines/reachability/machineReachability';
import { resetServerFeaturesClientForTests } from '@/sync/api/capabilities/serverFeaturesClient';
import { createDeferred } from '@/dev/testkit/hooks/createDeferred';
import { createAccountEncryptionCurrentnessFixtureForCredentials } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { TestWebCryptoWorker } from '@/dev/testkit/harness/webCryptoWorkerBoundary';
import { machineWorkspaceFileList } from '@/sync/ops/machineWorkspaceFileList';
import { DaemonWorkspaceFileListRequestSchema, DaemonWorkspaceFileListResponseSchema } from '@happier-dev/protocol/machines/workspaceFiles';
import { MachineReadBatchResponseV1Schema } from '@happier-dev/protocol/machines/machineReadBatchV1';
import type { MachinePublishedRowV1 } from '@happier-dev/protocol/machines/machineContentKeyTransitionV1';
import { resetRuntimeFetch, setRuntimeFetch } from '@/utils/system/runtimeFetch';
import { getSystemTasksRunner } from '@/components/systemTasks/systemTasksRuntime';
import { publishLocalDaemonStatus } from '@/components/settings/machines/localControl/localDaemonSharedState';
import { TokenStorage } from '@/auth/storage/tokenStorage';
import { apiSocket } from '@/sync/api/session/apiSocket';
import { getActiveServerSnapshot, setActiveServer } from '@/sync/domains/server/serverRuntime';
import { publishAppliedActiveServerRuntimeAvailability, publishAppliedActiveServerSnapshot } from '@/sync/runtime/orchestration/appliedActiveServerRuntime';

// Establish the local task runner through its OS boundary, then restore the
// ordinary web crypto/runtime environment used by this HTTP/Socket.IO suite.
vi.stubGlobal('__TAURI_INTERNALS__', { invoke: vi.fn() });
const localRunner = getSystemTasksRunner();
vi.unstubAllGlobals();
expect(localRunner.mode).toBe('tauri');

/** This in-process Home boundary serves the current exact-read wire contract. */
function serializeMachineReadFixture(request: Pick<IncomingMessage, 'url'>, machine: Pick<MachinePublishedRowV1, 'id'> & Partial<MachinePublishedRowV1>) {
    const row = { metadata: null, metadataVersion: 0, daemonState: null, daemonStateVersion: 0, ...machine };
    return JSON.stringify(request.url === '/v1/machines/read-batch'
        ? MachineReadBatchResponseV1Schema.parse({ results: [{ machineId: row.id, status: 'found', machine: row }] })
        : { machine: row });
}

const credentials = vi.hoisted(() => ({ token: '', secret: undefined as string | undefined }));

/** Each in-process Home reports the persisted identity of exactly the fixture credentials' material. */
let currentnessRequests = 0;
function createHomeServer(handler: (request: IncomingMessage, response: ServerResponse) => void | Promise<void>): HttpServer {
    return createServer((request, response) => {
        if (request.url !== '/v1/account/encryption/currentness') return handler(request, response);
        currentnessRequests += 1;
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify(createAccountEncryptionCurrentnessFixtureForCredentials({ token: credentials.token,
            ...(credentials.secret ? { secret: credentials.secret } : {}) })));
    });
}

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});

// Credential persistence is the only device boundary. HTTP and Socket.IO run in process.
vi.mock('@/auth/storage/tokenStorage', async (importOriginal) => {
    const { createTokenStorageModuleMock } = await import('@/dev/testkit/mocks/tokenStorage');
    const actual = await importOriginal<typeof import('@/auth/storage/tokenStorage')>();
    return await createTokenStorageModuleMock({
        importOriginal,
        subscribeHomeCredentialMutations: actual.subscribeHomeCredentialMutations,
        tokenStorage: { getCredentialsForServerUrl: async () => ({ token: credentials.token,
            ...(credentials.secret ? { secret: credentials.secret } : {}) }) },
    });
});

beforeEach(() => {
    currentnessRequests = 0;
    TestWebCryptoWorker.instances = [];
    TestWebCryptoWorker.failure = null;
    TestWebCryptoWorker.constructorFailure = null;
    TestWebCryptoWorker.transportFault = null;
    TestWebCryptoWorker.failNextDispatch = false;
    TestWebCryptoWorker.holdStartup = false;
    TestWebCryptoWorker.hold = false;
    TestWebCryptoWorker.responseDelayMs = 0;
});

afterEach(async () => {
    publishLocalDaemonStatus(localRunner, null);
    credentials.secret = undefined;
    vi.useRealTimers();
    resetRuntimeFetch();
    vi.unstubAllGlobals();
    await serverScopedRpcSocketPool.stopAll();
    serverScopedRpcSocketPool.resetForTests();
    resetScopedMachineTransportCacheForTests();
    clearMachineRequestReachabilityForTest();
    resetServerFeaturesClientForTests();
});

it('preserves a stalled Machine key opening after caller deadlines and retires it on credential rotation', async () => {
    const { Encryption } = await import('@/sync/encryption/encryption');
    const entered = createDeferred<void>();
    const workers = TestWebCryptoWorker.instances;
    TestWebCryptoWorker.hold = true;
    // Worker delivery is the OS boundary. The actual adapter, queue, envelope
    // crypto, HTTP, scope, Machine admission and RPC owner remain real.
    class HeldWorker extends TestWebCryptoWorker {
        override postMessage(data: unknown, transfers: ArrayBuffer[]) {
            entered.resolve();
            super.postMessage(data, transfers);
        }
    }
    vi.stubGlobal('Worker', HeldWorker);
    const secret = new Uint8Array(32).fill(35), key = new Uint8Array(32).fill(36);
    const encryption = await Encryption.create(secret);
    const envelope = Buffer.from(await encryption.encryptEncryptionKey(key)).toString('base64');
    await encryption.initializeMachines(new Map([['stalled-key-machine', key]]));
    const cipher = encryption.getMachineEncryption('stalled-key-machine');
    if (!cipher) throw new Error('Expected real Machine cipher');
    let received = 0, issued = 0;
    const http = createHomeServer((request, response) => {
        response.setHeader('content-type', 'application/json');
        if (request.url === '/health' || request.url === '/v1/auth/ping') response.end('{}');
        else if (request.url === '/v1/machines/read-batch') response.end(serializeMachineReadFixture(request, {
            id: 'stalled-key-machine', dataEncryptionKey: envelope,
            access: { custodian: { accountId: 'stalled-key-account', displayName: '' }, role: 'manage',
                resourceMode: 'e2ee', accessState: 'ready' },
        }));
        else { response.statusCode = 404; response.end('{}'); }
    });
    const relay = new Server(http, { path: '/v1/updates/' });
    relay.on('connection', socket => socket.on(SOCKET_RPC_EVENTS.CALL,
        async (packet: SocketRpcRequestPayload, ack: (value: unknown) => void) => {
            received += 1;
            const decoded = await socketRpcCodec.decodeRequestParams({ mode: 'e2ee', cipher }, packet.params, packet.method);
            ack({ ok: true, result: await socketRpcCodec.encodeResponse({ mode: 'e2ee', cipher }, { success: true }, decoded.callId) });
        }));
    try {
        const port = await listen(http);
        credentials.token = `header.${Buffer.from(JSON.stringify({ sub: 'stalled-key-account' })).toString('base64url')}.signature`;
        credentials.secret = Buffer.from(secret).toString('base64url');
        const home = await upsertServerProfile({ serverUrl: `http://127.0.0.1:${port}`, name: 'Stalled Machine opening' });
        const request = { serverId: home.id, accountId: 'stalled-key-account', machineId: 'stalled-key-machine',
            method: RPC_METHODS.SCM_STATUS_SNAPSHOT, payload: {}, preferScoped: true,
            onIssued: () => { issued += 1; } };
        const pending = machineRpcWithServerScope({ ...request, timeoutMs: 1_000 }).catch((error: unknown) => error);
        await Promise.race([entered.promise, pending.then(() => { throw new Error('Caller expired before the key-opening boundary'); })]);
        expect(await pending).toMatchObject({ code: 'MACHINE_RPC_TIMEOUT' });
        expect(issued).toBe(0);
        expect(received).toBe(0);
        // SIMPLIFY-KEYS: the RPC budget detaches its borrower, not shared
        // Account crypto work. An unchanged scope still joins that opening.
        expect(workers).toHaveLength(1);
        expect(workers[0]!.terminated).toBe(false);
        await expect(machineRpcWithServerScope({ ...request, timeoutMs: 1_000 }))
            .rejects.toMatchObject({ code: 'MACHINE_RPC_TIMEOUT' });
        expect(workers).toHaveLength(1);
        expect(workers[0]!.terminated).toBe(false);
        expect(workers[0]!.pendingReplies).toHaveLength(1);
        expect(issued).toBe(0);
        expect(received).toBe(0);

        // A changed credential retires the old Account material owner at the
        // next admission. Never release its held reply: recovery must open fresh.
        credentials.token = credentials.token.replace(/\.signature$/, '.rotated-signature');
        TestWebCryptoWorker.hold = false;
        await expect(machineRpcWithServerScope(request)).resolves.toEqual({ success: true });
        expect(workers).toHaveLength(2);
        expect(workers[0]!.terminated).toBe(true);
        expect(workers[1]!.terminated).toBe(false);
        expect(issued).toBe(1);
        expect(received).toBe(1);
    } finally {
        for (const worker of workers) worker.onerror?.({ error: new Error('Owned test Worker retired'), preventDefault() {} } as ErrorEvent);
        await serverScopedRpcSocketPool.stopAll();
        await new Promise<void>(resolve => relay.close(() => resolve()));
    }
});

it('issues a cold scoped cancel ahead of held bulk openings and never reopens its warm Machine key', async () => {
    const { Encryption } = await import('@/sync/encryption/encryption');
    const bulkEntered = createDeferred<void>();
    const workers = TestWebCryptoWorker.instances;
    const opened: string[] = [];
    TestWebCryptoWorker.hold = true;
    class OwnedWorker extends TestWebCryptoWorker {
        override postMessage(data: unknown, transfers: ArrayBuffer[]) {
            if (!Array.isArray(data)) throw new Error('Expected envelope batch');
            for (const item of data) if (item?.envelope instanceof Uint8Array) opened.push(Buffer.from(item.envelope).toString('base64'));
            super.postMessage(data, transfers);
            if (TestWebCryptoWorker.hold) bulkEntered.resolve();
        }
    }
    vi.stubGlobal('Worker', OwnedWorker);
    const secret = new Uint8Array(32).fill(56), key = new Uint8Array(32).fill(57);
    const bulkOwner = await Encryption.create(secret);
    const envelope = Buffer.from(await bulkOwner.encryptEncryptionKey(key)).toString('base64');
    await bulkOwner.initializeMachines(new Map([['cancel-bulk-machine', key]]));
    const cipher = bulkOwner.getMachineEncryption('cancel-bulk-machine');
    if (!cipher) throw new Error('Expected real Machine cipher');
    const bulkEnvelopes = await Promise.all(Array.from({ length: 500 }, async (_, index) =>
        Buffer.from(await bulkOwner.encryptEncryptionKey(new Uint8Array(32).fill(index % 255))).toString('base64')));
    let received = 0, rows = 0;
    const http = createHomeServer((request, response) => {
        response.setHeader('content-type', 'application/json');
        if (request.url === '/health' || request.url === '/v1/auth/ping') response.end('{}');
        else if (request.url === '/v1/machines/read-batch') {
            rows += 1;
            response.end(serializeMachineReadFixture(request, { id: 'cancel-bulk-machine', dataEncryptionKey: envelope,
                access: { custodian: { accountId: 'cancel-bulk-account', displayName: '' }, role: 'manage',
                    resourceMode: 'e2ee', accessState: 'ready' } }));
        } else { response.statusCode = 404; response.end('{}'); }
    });
    const relay = new Server(http, { path: '/v1/updates/' });
    relay.on('connection', socket => socket.on(SOCKET_RPC_EVENTS.CALL,
        async (packet: SocketRpcRequestPayload, ack: (value: unknown) => void) => {
            received += 1;
            const decoded = await socketRpcCodec.decodeRequestParams({ mode: 'e2ee', cipher }, packet.params, packet.method);
            ack({ ok: true, result: await socketRpcCodec.encodeResponse({ mode: 'e2ee', cipher }, { cancelled: true }, decoded.callId) });
        }));
    const bulk = bulkOwner.decryptEncryptionKeys(bulkEnvelopes);
    let bulkFinished = false;
    void bulk.then(() => { bulkFinished = true; }, () => { bulkFinished = true; });
    try {
        await bulkEntered.promise;
        TestWebCryptoWorker.hold = false;
        const port = await listen(http);
        credentials.token = `header.${Buffer.from(JSON.stringify({ sub: 'cancel-bulk-account' })).toString('base64url')}.signature`;
        credentials.secret = Buffer.from(secret).toString('base64url');
        const home = await upsertServerProfile({ serverUrl: `http://127.0.0.1:${port}`, name: 'Cancel ahead of bulk' });
        const request = { serverId: home.id, accountId: 'cancel-bulk-account', machineId: 'cancel-bulk-machine',
            method: 'daemon.voiceInference.stt.stream.cancel', payload: {}, preferScoped: true, timeoutMs: 1_000 };
        await expect(machineRpcWithServerScope(request)).resolves.toEqual({ cancelled: true });
        expect(received).toBe(1);
        expect(bulkFinished).toBe(false);
        expect(opened.filter(value => value === envelope)).toHaveLength(1);
        await expect(machineRpcWithServerScope(request)).resolves.toEqual({ cancelled: true });
        expect(received).toBe(2);
        expect(rows).toBe(2); // Fresh authority is still required for a warm opening.
        expect(opened.filter(value => value === envelope)).toHaveLength(1);
    } finally {
        TestWebCryptoWorker.hold = false;
        for (const worker of workers) for (const deliver of worker.pendingReplies.splice(0)) await deliver();
        await bulk;
        for (const worker of workers) worker.onerror?.({ error: new Error('Owned test Worker retired'), preventDefault() {} } as ErrorEvent);
        await serverScopedRpcSocketPool.stopAll();
        await new Promise<void>(resolve => relay.close(() => resolve()));
    }
});

it.each([false, true])('distinguishes held SCM setup boundaries from elapsed continuation time (clock stall: %s)', async stallContinuation => {
    const { Encryption } = await import('@/sync/encryption/encryption');
    const { ScmComparisonCaptureInputSchema, ScmComparisonCaptureOutputSchema } = await import('@happier-dev/protocol/scm');
    const { ScmDiffSummaryResultListInputSchema, ScmDiffSummaryResultListResponseSchema } = await import('@happier-dev/protocol/scm/diffSummaryResult');
    const secret = new Uint8Array(32).fill(29);
    const daemonEncryption = await Encryption.create(secret);
    const dataKey = new Uint8Array(32).fill(31);
    const envelope = Buffer.from(await daemonEncryption.encryptEncryptionKey(dataKey)).toString('base64');
    await daemonEncryption.initializeMachines(new Map([['scm-setup-machine', dataKey]]));
    const cipher = daemonEncryption.getMachineEncryption('scm-setup-machine');
    if (!cipher) throw new Error('Expected real Machine cipher');
    const transport = { mode: 'e2ee' as const, cipher };
    const bodyStarted = createDeferred<void>();
    const releaseBody = createDeferred<void>();
    const handshakeStarted = createDeferred<void>();
    const releaseSocket = createDeferred<void>();
    const bodyConsumed = createDeferred<void>();
    let received = 0;
    let issued = 0;
    const responses = {
        list: ScmDiffSummaryResultListResponseSchema.parse({ success: true, results: [], count: 0, bytes: 0,
            sevenDayCost: { status: 'unavailable', pricedRunCount: 0, unpricedRunCount: 0, sinceMs: 0, untilMs: 1 } }),
        capture: ScmComparisonCaptureOutputSchema.parse({ success: false, errorCode: 'DIFF_UNAVAILABLE', error: 'No saved comparison at this test boundary' }),
    };
    const http = createHomeServer(async (request, response) => {
        response.setHeader('content-type', 'application/json');
        if (request.url === '/health' || request.url === '/v1/auth/ping') response.end('{}');
        else if (request.url === '/v1/machines/read-batch') {
            response.writeHead(200);
            response.flushHeaders();
            bodyStarted.resolve();
            await releaseBody.promise;
            if (!response.destroyed) response.end(serializeMachineReadFixture(request, {
                id: 'scm-setup-machine', dataEncryptionKey: envelope,
                access: { custodian: { accountId: 'scm-setup-account', displayName: '' }, role: 'manage',
                    resourceMode: 'e2ee', accessState: 'ready' },
            }));
        } else { response.statusCode = 404; response.end('{}'); }
    });
    const relay = new Server(http, { path: '/v1/updates/' });
    relay.use((_socket, next) => {
        handshakeStarted.resolve();
        void releaseSocket.promise.then(() => next());
    });
    relay.on('connection', socket => socket.on(SOCKET_RPC_EVENTS.CALL, async (packet: SocketRpcRequestPayload, ack: (value: unknown) => void) => {
        const decoded = await socketRpcCodec.decodeRequestParams(transport, packet.params, packet.method);
        received += 1;
        const isList = packet.method === `scm-setup-machine:${RPC_METHODS.SCM_DIFF_SUMMARY_RESULT_LIST}`;
        if (isList) ScmDiffSummaryResultListInputSchema.parse(decoded.params);
        else {
            expect(packet.method).toBe(`scm-setup-machine:${RPC_METHODS.SCM_DIFF_SUMMARY_CAPTURE}`);
            expect(ScmComparisonCaptureInputSchema.parse(decoded.params)).toMatchObject({ cwd: '/project', comparisonId: 'a'.repeat(64) });
        }
        ack({ ok: true, result: await socketRpcCodec.encodeResponse(transport, isList ? responses.list : responses.capture, decoded.callId) });
    }));
    const baselineTime = Date.now();
    if (stallContinuation) vi.useFakeTimers({ toFake: ['Date'] });
    // This is the genuine HTTP boundary, not an internal setup mock. Move only
    // the wall clock after the complete Machine HTTP body: a timeout can then occur
    // with no unresolved HTTP/body boundary. It is not a reproduced product bug.
    setRuntimeFetch(async (input, init) => {
        const response = await fetch(input, init);
        const path = new URL(input instanceof Request ? input.url : String(input)).pathname;
        if (path === '/v1/machines/read-batch' && response.body) {
            // The HTTP owner wraps response bodies to retain cancellation, so
            // observe the real stream rather than an instance's json method.
            const reader = response.body.getReader();
            return new Response(new ReadableStream<Uint8Array>({
                async pull(controller) {
                    const chunk = await reader.read();
                    if (chunk.done) {
                        controller.close();
                        if (stallContinuation) vi.setSystemTime(baselineTime + 31_000);
                        bodyConsumed.resolve();
                    } else controller.enqueue(chunk.value);
                },
                cancel: reason => reader.cancel(reason),
            }), { status: response.status, statusText: response.statusText, headers: response.headers });
        }
        return response;
    });
    try {
        const port = await listen(http);
        credentials.token = `header.${Buffer.from(JSON.stringify({ sub: 'scm-setup-account' })).toString('base64url')}.signature`;
        credentials.secret = Buffer.from(secret).toString('base64url');
        const home = await upsertServerProfile({ serverUrl: `http://127.0.0.1:${port}`, name: 'SCM setup discriminator' });
        const pending = Promise.all([
            [RPC_METHODS.SCM_DIFF_SUMMARY_RESULT_LIST, ScmDiffSummaryResultListInputSchema.parse({})],
            [RPC_METHODS.SCM_DIFF_SUMMARY_CAPTURE, ScmComparisonCaptureInputSchema.parse({ cwd: '/project', comparisonId: 'a'.repeat(64), source: { kind: 'workingTree' } })],
        ].map(([method, payload]) => machineRpcWithServerScope({ serverId: home.id, accountId: 'scm-setup-account',
            machineId: 'scm-setup-machine', method: String(method), payload, preferScoped: true,
            // Match qa-r52's instrumentation: this observer intentionally
            // selects the server route rather than peer mediation.
            onIssued: () => { issued += 1; } })
            .then(value => ({ value }), (error: unknown) => ({ error }))));
        const reach = (stage: Promise<void>) => Promise.race([stage, pending.then(results => {
            const failures = results.map(result => {
                const error = 'error' in result ? result.error : undefined;
                return error && typeof error === 'object' ? {
                    name: 'name' in error ? error.name : undefined,
                    code: 'code' in error ? error.code : undefined,
                    rpcErrorCode: 'rpcErrorCode' in error ? error.rpcErrorCode : undefined,
                } : { settled: true };
            });
            throw new Error(`SCM calls settled before the held setup stage: ${JSON.stringify(failures)}`);
        })]);
        await reach(bodyStarted.promise);
        await reach(handshakeStarted.promise);
        // Both calls share one persisted-mode identity read at the Account owner;
        // explicit resource mode still needs no additional RPC-preparation probe.
        expect(currentnessRequests).toBe(1);
        expect(issued).toBe(0);
        expect(received).toBe(0);
        releaseBody.resolve();
        await reach(bodyConsumed.promise);
        expect(issued).toBe(0);
        expect(received).toBe(0);
        releaseSocket.resolve();
        const results = await pending;
        expect(currentnessRequests).toBe(1);
        if (stallContinuation) {
            expect(results).toEqual([expect.objectContaining({ error: expect.objectContaining({ code: 'MACHINE_RPC_TIMEOUT' }) }),
                expect.objectContaining({ error: expect.objectContaining({ code: 'MACHINE_RPC_TIMEOUT' }) })]);
            expect(received).toBe(0);
            expect(issued).toBe(0);
        } else {
            expect(results).toEqual([{ value: responses.list }, { value: responses.capture }]);
            expect(issued).toBe(2);
            expect(received).toBe(2);
        }
    } finally {
        releaseBody.resolve(); releaseSocket.resolve();
        vi.useRealTimers();
        resetRuntimeFetch();
        await serverScopedRpcSocketPool.stopAll();
        await new Promise<void>(resolve => relay.close(() => resolve()));
    }
});

it.each([
    { method: 'scm.status.snapshot', failure: 'refused-dial' },
    { method: 'scm.diffSummary.result.list', failure: 'refused-dial' },
    { method: 'stop-session', failure: 'refused-dial' },
    { method: 'scm.status.snapshot', failure: 'disconnect-during-preparation' },
])('preserves a failed scoped socket before held Machine preparation times out ($method, $failure)', async ({ method, failure }) => {
    const bodyStarted = createDeferred<void>();
    const releaseBody = createDeferred<void>();
    let received = 0;
    let issued = 0;
    let recovering = false;
    const http = createHomeServer(async (request, response) => {
        response.setHeader('content-type', 'application/json');
        if (request.url === '/health' || request.url === '/v1/auth/ping') response.end('{}');
        else if (request.url === '/v1/machines/read-batch') {
            response.writeHead(200);
            response.flushHeaders();
            if (recovering) {
                bodyStarted.resolve();
                await releaseBody.promise;
            }
            if (!response.destroyed) response.end(serializeMachineReadFixture(request, {
                id: 'failed-scoped-machine', dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER,
                access: { custodian: { accountId: 'failed-scoped-account', displayName: '' },
                    role: 'manage', resourceMode: 'plain', accessState: 'ready' },
            }));
        } else if (request.url === '/v1/account/encryption') response.end(JSON.stringify({ mode: 'plain', updatedAt: 1 }));
        else { response.statusCode = 404; response.end('{}'); }
    });
    const relay = new Server(http, { path: '/v1/updates/' });
    let refusedDials = 0;
    // Distinguish refusal of a new dial from loss of an already acquired socket.
    // Both must win over the independent held HTTP body, without replaying RPCs.
    relay.use(async (_socket, next) => {
        if (recovering && failure === 'refused-dial') {
            await bodyStarted.promise;
            refusedDials += 1;
            next(new Error('scoped namespace refused'));
        } else next();
    });
    relay.on('connection', socket => socket.on(SOCKET_RPC_EVENTS.CALL,
        async (packet: SocketRpcRequestPayload, ack: (value: unknown) => void) => {
            received += 1;
            const decoded = await socketRpcCodec.decodeRequestParams({ mode: 'plain' }, packet.params, packet.method);
            ack({ ok: true, result: await socketRpcCodec.encodeResponse({ mode: 'plain' }, 'ready', decoded.callId) });
        }));
    try {
        const port = await listen(http);
        credentials.token = `header.${Buffer.from(JSON.stringify({ sub: 'failed-scoped-account' })).toString('base64url')}.signature`;
        const home = await upsertServerProfile({ serverUrl: `http://127.0.0.1:${port}`, name: 'Failed scoped preparation' });
        const call = { serverId: home.id, accountId: 'failed-scoped-account', machineId: 'failed-scoped-machine',
            method, payload: {}, preferScoped: true, timeoutMs: 1_000, onIssued: () => { issued += 1; },
            ...(failure === 'disconnect-during-preparation' ? { readAdmission: createMachineRpcReadAdmission([method]) } : {}),
        };
        const baselineCount = failure === 'refused-dial' ? 0 : 1;
        if (baselineCount) {
            expect(await machineRpcWithServerScope(call)).toBe('ready');
            expect(received).toBe(1);
            expect(issued).toBe(1);
        }
        recovering = true;
        const pending = machineRpcWithServerScope(call).then(() => null, (error: unknown) => error);
        await bodyStarted.promise;
        if (failure === 'disconnect-during-preparation') relay.sockets.sockets.forEach(socket => socket.disconnect(true));
        const error = await pending;
        expect(error).toMatchObject({ rpcErrorCode: 'MACHINE_RPC_UNREACHABLE' });
        expect(readRpcRequestDisposition(error)).toBe('notSent');
        expect(refusedDials).toBe(failure === 'refused-dial' ? 1 : 0);
        expect(issued).toBe(baselineCount);
        expect(received).toBe(baselineCount);
        recovering = false;
        releaseBody.resolve();
        expect(await machineRpcWithServerScope(call)).toBe('ready');
        expect(issued).toBe(baselineCount + 1);
        expect(received).toBe(baselineCount + 1);
    } finally {
        releaseBody.resolve();
        await serverScopedRpcSocketPool.stopAll();
        await new Promise<void>(resolve => relay.close(() => resolve()));
    }
});

it('detects Agent readiness through real scoped E2EE HTTP, crypto and Socket.IO wiring', async () => {
    const { Encryption } = await import('@/sync/encryption/encryption');
    const { machineCapabilitiesDetect } = await import('@/sync/ops/capabilities');
    const { MachineAgentInventoryItemSchema, projectMachineAgentsDetectResponse } = await import('@happier-dev/protocol/capabilities');
    const secret = new Uint8Array(32).fill(17);
    const crypto = await Encryption.create(secret);
    const dataKey = new Uint8Array(32).fill(23);
    const envelope = Buffer.from(await crypto.encryptEncryptionKey(dataKey)).toString('base64');
    await crypto.initializeMachines(new Map([['machine-1', dataKey]]));
    const cipher = crypto.getMachineEncryption('machine-1');
    if (!cipher) throw new Error('Expected real Machine cipher');
    const transport = { mode: 'e2ee' as const, cipher };
    const { agentId, title, ...facts } = MachineAgentInventoryItemSchema.parse({
        agentId: 'claude', title: 'Claude', installed: true, version: '1', latestVersion: null,
        update: { supported: false, command: null },
        signIn: { status: 'signedOut', loginSupport: 'login_terminal' }, platform: { supported: true },
        install: { available: false, mode: 'manual', sizeBytes: null, guideUrl: null }, dependencies: [],
    });
    const detected = { protocolVersion: 1, results: { 'cli.claude': { ok: true, checkedAt: 1, data: facts } } };
    const http = createHomeServer((request, response) => {
        response.setHeader('content-type', 'application/json');
        if (request.url === '/health' || request.url === '/v1/auth/ping') response.end('{}');
        else if (request.url === '/v1/machines/machine-1' || request.url === '/v1/machines/read-batch') response.end(serializeMachineReadFixture(request, { id: 'machine-1', dataEncryptionKey: envelope }));
        else if (request.url === '/v1/account/encryption') response.end(JSON.stringify({ mode: 'e2ee', updatedAt: 1 }));
        else { response.statusCode = 404; response.end('{}'); }
    });
    const relay = new Server(http, { path: '/v1/updates/' });
    const received: unknown[] = [];
    relay.on('connection', socket => socket.on(SOCKET_RPC_EVENTS.CALL, async (packet: SocketRpcRequestPayload, ack: (value: unknown) => void) => {
        expect(packet.method).toBe(`machine-1:${RPC_METHODS.CAPABILITIES_DETECT}`);
        const decoded = await socketRpcCodec.decodeRequestParams(transport, packet.params, packet.method);
        received.push(decoded.params);
        ack({ ok: true, result: await socketRpcCodec.encodeResponse(transport, detected, decoded.callId) });
    }));
    try {
        const port = await listen(http);
        credentials.token = `header.${Buffer.from(JSON.stringify({ sub: 'readiness-account' })).toString('base64url')}.signature`;
        credentials.secret = Buffer.from(secret).toString('base64url');
        const home = await upsertServerProfile({ serverUrl: `http://127.0.0.1:${port}`, name: 'Agent readiness E2EE' });
        const request = { requests: [{ id: 'cli.claude' as const }] };
        const responses = await Promise.all([1, 2].map(() => machineCapabilitiesDetect('machine-1', request, {
            serverId: home.id, accountId: 'readiness-account',
        })));
        for (const response of responses) {
            expect(response.supported).toBe(true);
            if (!response.supported) throw new Error('Expected decoded capability facts');
            expect(projectMachineAgentsDetectResponse({ agents: [{ agentId, title }], response: response.response }).items)
                .toMatchObject([{ agentId: 'claude', installed: true, signIn: { status: 'signedOut' } }]);
        }
        expect(received).toEqual([request, request]);
    } finally {
        await serverScopedRpcSocketPool.stopAll();
        await new Promise<void>(resolve => relay.close(() => resolve()));
    }
});

async function listen(http: HttpServer, port = 0) {
    await new Promise<void>((resolve, reject) => {
        http.once('error', reject);
        http.listen(port, '127.0.0.1', () => { http.removeListener('error', reject); resolve(); });
    });
    const address = http.address();
    if (!address || typeof address === 'string') throw new Error('Missing HTTP address');
    return address.port;
}

async function closeHttp(http: HttpServer) {
    http.closeAllConnections();
    await new Promise<void>((resolve, reject) => http.close(error => error ? reject(error) : resolve()));
}

it.each(['scoped', 'active'] as const)('settles 27 concurrent %s Machine chains on one Account socket without retiring a held reply', async scope => {
    const machineIds = Array.from({ length: 27 }, (_, index) => `fanout-machine-${index}`);
    const releaseLastReply = createDeferred<void>();
    const allDescriptionsReceived = createDeferred<void>();
    const first26Settled = createDeferred<void>();
    const heldReplyReceived = createDeferred<void>();
    const received = new Set<string>();
    const replied = new Set<string>();
    const accountSockets = new Set<string>();
    const refused = new Set<string>();
    const initialAckIds = new Set<string>();
    const initialMachines = getStorage().getState().machines;
    const initialMachineLists = getStorage().getState().machineListByServerId;
    let restoreAuthentication: (() => void) | undefined;
    let settledChains = 0;
    let disconnected = 0;
    const http = createHomeServer(async (request, response) => {
        response.setHeader('content-type', 'application/json');
        if (request.url === '/health' || request.url === '/v1/auth/ping') response.end('{}');
        else if (request.url === '/v1/account/encryption') response.end(JSON.stringify({ mode: 'plain', updatedAt: 1 }));
        else if (request.url === '/v1/machines/read-batch') {
            const chunks: Buffer[] = [];
            for await (const chunk of request) chunks.push(Buffer.from(chunk));
            const rows = createMachineReadBatchResponseFixture(Buffer.concat(chunks).toString(), id =>
                machineIds.includes(id) ? createPlainMachineRowFixture({ id, accountId: 'account-a' }) : null);
            response.end(await rows.text());
        } else { response.statusCode = 404; response.end('{}'); }
    });
    const relay = new Server(http, { path: '/v1/updates/' });
    relay.on('connection', socket => {
        accountSockets.add(socket.id);
        socket.on('disconnect', () => { disconnected += 1; });
        socket.on(SOCKET_RPC_EVENTS.CALL, async (packet: SocketRpcRequestPayload, ack: (value: unknown) => void) => {
            const decoded = await socketRpcCodec.decodeRequestParams({ mode: 'plain' }, packet.params, packet.method);
            if (scope === 'active' && packet.method.endsWith(':fanout.describe') && !refused.has(packet.method)) {
                refused.add(packet.method);
                ack({ ok: false, error: 'Machine RPC is not yet registered', errorCode: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE });
                return;
            }
            received.add(packet.method);
            if (packet.method.endsWith(':fanout.describe')) {
                if (received.size === machineIds.length) allDescriptionsReceived.resolve();
                await allDescriptionsReceived.promise;
            }
            if (packet.method === `${machineIds.at(-1)}:fanout.status`) {
                heldReplyReceived.resolve();
                await releaseLastReply.promise;
            }
            const result = { method: packet.method, params: decoded.params };
            ack({ ok: true, result: await socketRpcCodec.encodeResponse({ mode: 'plain' }, result, decoded.callId) });
            replied.add(packet.method);
        });
    });
    vi.stubEnv('EXPO_PUBLIC_HAPPIER_SCOPED_RPC_SOCKET_IDLE_DISCONNECT_MS', '0');
    try {
        const port = await listen(http);
        const home = await upsertServerProfile({ serverUrl: `http://127.0.0.1:${port}`, name: 'Fanout Home' });
        const credentials = await TokenStorage.getCredentialsForServerUrl(home.serverUrl);
        if (!credentials) throw new Error('Expected composed Home authentication fixture');
        const fixtureAuthentication = [
            Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url'),
            Buffer.from(JSON.stringify({ sub: 'account-a' })).toString('base64url'),
            Buffer.alloc(32).toString('base64url'),
        ].join('.');
        const authentication = vi.spyOn(TokenStorage, 'getCredentialsForServerUrl')
            .mockResolvedValue({ ...credentials, token: fixtureAuthentication });
        restoreAuthentication = () => authentication.mockRestore();
        if (scope === 'active') {
            await setActiveServer({ serverId: home.id });
            const snapshot = getActiveServerSnapshot();
            publishAppliedActiveServerSnapshot(snapshot);
            const machines = machineIds.map(id => createMachineFixture({ id, storageMode: 'plain' }));
            getStorage().setState({ machines: Object.fromEntries(machines.map(machine => [machine.id, machine])),
                machineListByServerId: { [home.id]: machines } });
            apiSocket.initialize({ endpoint: home.serverUrl, serverId: home.id, generation: snapshot.generation,
                token: fixtureAuthentication }, null);
            await vi.waitFor(() => expect(apiSocket.getSocketId()).not.toBe(''));
            const socket: unknown = Reflect.get(apiSocket, 'socket');
            if (!socket || typeof socket !== 'object') throw new Error('Expected active Socket.IO client');
            for (const id of Object.keys(Reflect.get(socket, 'acks'))) initialAckIds.add(id);
        }
        const pending = machineIds.map(async machineId => {
            for (const method of ['fanout.describe', 'fanout.status']) {
                const payload = { machineId, phase: method };
                expect(await machineRpcWithServerScope({ serverId: home.id,
                    ...(scope === 'scoped' ? { accountId: 'account-a', preferScoped: true } : {}),
                    machineId, method, payload, timeoutMs: 10_000 }))
                    .toEqual({ method: `${machineId}:${method}`, params: payload });
            }
            settledChains += 1;
            if (settledChains === 26) first26Settled.resolve();
        });
        const all = Promise.all(pending);
        // Attach rejection handling before waiting at the producer boundary.
        void all.catch(() => undefined);
        await Promise.race([Promise.all([first26Settled.promise, heldReplyReceived.promise]), all.then(() => {
            throw new Error('The held Machine chain settled before its producer released the reply');
        })]);
        expect(accountSockets.size).toBe(1);
        expect(disconnected).toBe(0);
        expect(received.size).toBe(54);
        expect(replied.size).toBe(53);
        expect(refused.size).toBe(scope === 'active' ? 27 : 0);
        releaseLastReply.resolve();
        await all;
        expect(settledChains).toBe(27);
        expect(replied).toEqual(received);
        if (scope === 'active') {
            // Read the real external Socket.IO boundary's acknowledgement table;
            // startup callbacks predate this test's RPCs and are excluded.
            const socket: unknown = Reflect.get(apiSocket, 'socket');
            if (!socket || typeof socket !== 'object') throw new Error('Expected active Socket.IO client');
            expect(Object.keys(Reflect.get(socket, 'acks')).filter(id => !initialAckIds.has(id))).toHaveLength(0);
            expect(disconnected).toBe(0);
        } else await vi.waitFor(() => expect(disconnected).toBe(1));
    } finally {
        releaseLastReply.resolve();
        allDescriptionsReceived.resolve();
        if (scope === 'active') {
            apiSocket.disconnect();
            publishAppliedActiveServerRuntimeAvailability(false);
            getStorage().setState({ machines: initialMachines, machineListByServerId: initialMachineLists });
        }
        await serverScopedRpcSocketPool.stopAll();
        await new Promise<void>(resolve => relay.close(() => resolve()));
        restoreAuthentication?.();
        vi.unstubAllEnvs();
    }
}, 60_000);

it.each(['cli.external-agent/mode-reader', 'cli.external-agent/lost-mode-reader', 'tool.external-mode-reader'] as const)(
    'keeps the native mode probe reply under its owner lifetime only for Agent preflight (%s)', async capabilityId => {
        const { machineCapabilitiesInvoke } = await import('@/sync/ops/capabilities');
        const { AgentSessionModesProbeObservationSchema } = await import('@happier-dev/protocol/capabilities');
        const issued = createDeferred<void>();
        const release = createDeferred<void>();
        const observation = AgentSessionModesProbeObservationSchema.parse({
            availableModes: [{ id: 'project-review', name: 'Project review' }], source: 'dynamic',
        });
        const http = createHomeServer((request, response) => {
            response.setHeader('content-type', 'application/json');
            if (request.url === '/health' || request.url === '/v1/auth/ping') response.end('{}');
            else if (request.url === '/v1/machines/mode-machine' || request.url === '/v1/machines/read-batch') response.end(serializeMachineReadFixture(request, {
                id: 'mode-machine', dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER,
            }));
            else if (request.url === '/v1/account/encryption') response.end(JSON.stringify({ mode: 'plain', updatedAt: 1 }));
            else { response.statusCode = 404; response.end('{}'); }
        });
        const relay = new Server(http, { path: '/v1/updates/' });
        relay.on('connection', socket => socket.on(SOCKET_RPC_EVENTS.CALL,
            async (packet: SocketRpcRequestPayload, ack: (value: unknown) => void) => {
                const decoded = await socketRpcCodec.decodeRequestParams({ mode: 'plain' }, packet.params, packet.method);
                expect(packet.method).toBe(`mode-machine:${RPC_METHODS.CAPABILITIES_INVOKE}`);
                expect(decoded.params).toMatchObject({ id: capabilityId, method: 'probeModes' });
                issued.resolve();
                if (capabilityId === 'cli.external-agent/lost-mode-reader') {
                    socket.disconnect(true);
                    return;
                }
                await release.promise;
                ack({ ok: true, result: await socketRpcCodec.encodeResponse({ mode: 'plain' },
                    { ok: true, result: observation }, decoded.callId) });
            }));
        try {
            const port = await listen(http);
            credentials.token = `header.${Buffer.from(JSON.stringify({ sub: 'mode-account' })).toString('base64url')}.signature`;
            const home = await upsertServerProfile({ serverUrl: `http://127.0.0.1:${port}`, name: 'Native mode preflight' });
            const pending = machineCapabilitiesInvoke('mode-machine', { id: capabilityId, method: 'probeModes',
                params: { cwd: '/project' } }, { serverId: home.id, accountId: 'mode-account', timeoutMs: 4_000 });
            await Promise.race([issued.promise, pending.then(() => {
                throw new Error('Mode probe settled before the producer received it');
            })]);
            // Real HTTP/Socket.IO and a held native reply: the setup deadline has
            // elapsed, but the producer has not finished its preparation/read/cleanup.
            if (capabilityId !== 'cli.external-agent/lost-mode-reader') {
                await new Promise(resolve => setTimeout(resolve, 4_100));
            }
            release.resolve();
            const result = await pending;
            if (capabilityId === 'cli.external-agent/lost-mode-reader') {
                expect(result).toEqual({ supported: false, reason: 'outcomeUnknown', requestDisposition: 'outcomeUnknown' });
            } else if (capabilityId.startsWith('cli.')) {
                expect(result).toEqual({ supported: true, response: { ok: true, result: observation } });
                if (!result.supported || !result.response.ok) throw new Error('Expected native inventory');
                expect(AgentSessionModesProbeObservationSchema.parse(result.response.result).availableModes)
                    .toEqual(observation.availableModes);
            } else {
                // Mis-wiring the same method as a tool must retain the explicit
                // operation deadline and report uncertainty, never an empty inventory.
                expect(result).toEqual({ supported: false, reason: 'error', requestDisposition: 'outcomeUnknown' });
            }
        } finally {
            release.resolve();
            await serverScopedRpcSocketPool.stopAll();
            await new Promise<void>(resolve => relay.close(() => resolve()));
        }
    }, 60_000,
);

it('connects the scoped socket while the fresh Machine row is still being read', async () => {
    const connected = createDeferred<void>();
    const http = createHomeServer(async (request, response) => {
        response.setHeader('content-type', 'application/json');
        if (request.url === '/health' || request.url === '/v1/auth/ping') response.end('{}');
        else if (request.url === '/v1/machines/parallel-machine' || request.url === '/v1/machines/read-batch') {
            // Both are independent network preparations. Holding this response
            // until the real socket connects distinguishes overlap from serial setup.
            await connected.promise;
            if (!response.destroyed) response.end(serializeMachineReadFixture(request, {
                id: 'parallel-machine', dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER,
            }));
        } else if (request.url === '/v1/account/encryption') response.end(JSON.stringify({ mode: 'plain', updatedAt: 1 }));
        else { response.statusCode = 404; response.end('{}'); }
    });
    const relay = new Server(http, { path: '/v1/updates/' });
    relay.on('connection', socket => {
        connected.resolve();
        socket.on(SOCKET_RPC_EVENTS.CALL, async (packet: SocketRpcRequestPayload, ack: (value: unknown) => void) => {
            const decoded = await socketRpcCodec.decodeRequestParams({ mode: 'plain' }, packet.params, packet.method);
            ack({ ok: true, result: await socketRpcCodec.encodeResponse({ mode: 'plain' }, { ready: true }, decoded.callId) });
        });
    });
    try {
        const port = await listen(http);
        credentials.token = `header.${Buffer.from(JSON.stringify({ sub: 'parallel-account' })).toString('base64url')}.signature`;
        const home = await upsertServerProfile({ serverUrl: `http://127.0.0.1:${port}`, name: 'Parallel RPC setup' });
        await expect(machineRpcWithServerScope({ serverId: home.id, accountId: 'parallel-account',
            machineId: 'parallel-machine', method: 'parallel.read', payload: {}, preferScoped: true,
            timeoutMs: 2_000 })).resolves.toEqual({ ready: true });
    } finally {
        connected.resolve();
        await serverScopedRpcSocketPool.stopAll();
        http.closeAllConnections();
        await new Promise<void>(resolve => relay.close(() => resolve()));
    }
});

it('retires a physical socket after Machine admission fails without sending an RPC', async () => {
    const allowConnection = createDeferred<void>();
    const handshakeStarted = createDeferred<void>();
    let disconnected = false;
    let rpcReceived = false;
    const http = createHomeServer(async (request, response) => {
        response.setHeader('content-type', 'application/json');
        if (request.url === '/health' || request.url === '/v1/auth/ping') response.end('{}');
        else {
            // The physical connection must actually exist before admission
            // fails, so cancellation cannot win before this fixture is reached.
            await handshakeStarted.promise;
            response.writeHead(404).end('{}');
        }
    });
    const relay = new Server(http, { path: '/v1/updates/' });
    // A cancelled setup can close before namespace admission; the Engine owns
    // that physical lifetime and observes both early and late close paths.
    relay.engine.on('connection', socket => socket.on('close', () => { disconnected = true; }));
    relay.use((_socket, next) => { handshakeStarted.resolve(); void allowConnection.promise.then(() => next()); });
    relay.on('connection', socket => {
        socket.on(SOCKET_RPC_EVENTS.CALL, () => { rpcReceived = true; });
    });
    vi.stubEnv('EXPO_PUBLIC_HAPPIER_SCOPED_RPC_SOCKET_IDLE_DISCONNECT_MS', '0');
    try {
        const port = await listen(http);
        credentials.token = `header.${Buffer.from(JSON.stringify({ sub: 'late-account' })).toString('base64url')}.signature`;
        const home = await upsertServerProfile({ serverUrl: `http://127.0.0.1:${port}`, name: 'Late RPC setup' });
        const outcome = await machineRpcWithServerScope({ serverId: home.id, accountId: 'late-account',
            machineId: 'missing-machine', method: 'late.read', payload: {}, preferScoped: true, timeoutMs: 2_000 })
            .then(() => null, (error: unknown) => error);
        expect(outcome).toBeInstanceOf(Error);
        expect(readRpcRequestDisposition(outcome)).toBe('notSent');
        await handshakeStarted.promise;
        allowConnection.resolve();
        await vi.waitFor(() => { expect(disconnected).toBe(true); });
        expect(rpcReceived).toBe(false);
    } finally {
        allowConnection.resolve();
        await serverScopedRpcSocketPool.stopAll();
        http.closeAllConnections();
        await new Promise<void>(resolve => relay.close(() => resolve()));
        vi.unstubAllEnvs();
    }
});

async function createDirectRelayHome(endpointPort: number, relayReply?: Promise<void>, accountReadDelayMs = 0, grantReply?: Promise<void>) {
    const features = FeaturesResponseSchema.parse({ features: { machines: {
        enabled: true, rpc: { enabled: true, directPeer: { enabled: true } },
    } }, capabilities: {} });
    const http = createHomeServer(async (request, response) => {
        response.setHeader('content-type', 'application/json');
        if (request.url === '/health' || request.url === '/v1/auth/ping') response.end('{}');
        else if (request.url === '/v1/features') response.end(JSON.stringify(features));
        else if (request.url === '/v1/account/encryption') {
            setTimeout(() => response.end(JSON.stringify({ mode: 'plain', updatedAt: 1 })), accountReadDelayMs);
        }
        else if (request.url === '/v1/machines/machine-1' || request.url === '/v1/machines/read-batch') {
            response.end(serializeMachineReadFixture(request, { id: 'machine-1', dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER }));
        } else if (request.url === '/v1/machines/peer/mediation/route-grants') {
            await grantReply;
            const chunks: Buffer[] = [];
            for await (const chunk of request) chunks.push(Buffer.from(chunk));
            const grantRequest = DirectRouteGrantRequestV2Schema.parse(JSON.parse(Buffer.concat(chunks).toString()));
            const now = Date.now();
            const grant = SignedDirectRouteGrantV2Schema.parse({ payload: {
                v: 2, grantId: 'hh-grant', accountId: 'account-a', machineId: grantRequest.machineId,
                flowKind: grantRequest.flowKind, routeKind: grantRequest.routeKind, scope: grantRequest.scope,
                iat: now, exp: now + grantRequest.ttlMs, aud: 'happier-daemon-route-grant',
                endpointFingerprint: grantRequest.endpointFingerprint, proofKind: 'ephemeral_ed25519',
                ephemeralPublicKeyBase64Url: grantRequest.ephemeralPublicKeyBase64Url,
            }, signature: { keyId: 'hh-key', alg: 'Ed25519', valueBase64Url: Buffer.alloc(64, 2).toString('base64url') } });
            response.end(JSON.stringify({ ok: true, grant }));
        } else { response.statusCode = 404; response.end('{}'); }
    });
    const relay = new Server(http, { path: '/v1/updates/' });
    const calls: SocketRpcRequestPayload[] = [];
    relay.on('connection', socket => {
        socket.on(SOCKET_RPC_EVENTS.CALL, async (packet: SocketRpcRequestPayload, ack: (response: unknown) => void) => {
            calls.push(packet);
            const fileList = packet.method === `machine-1:${RPC_METHODS.DAEMON_WORKSPACE_FILES_LIST}`;
            if (!fileList && packet.method !== `machine-1:${RPC_METHODS.DAEMON_MEMORY_STATUS}`) {
                ack({ ok: false, error: 'RPC method not available', errorCode: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE });
                return;
            }
            const decoded = await socketRpcCodec.decodeRequestParams({ mode: 'plain' }, packet.params, packet.method);
            await relayReply;
            ack({ ok: true, result: await socketRpcCodec.encodeResponse({ mode: 'plain' }, fileList ? {
                ok: true, paths: ['tmp/fsp-find-review/target.txt'], truncated: true,
            } : {
                route: 'relay', params: decoded.params,
            }, decoded.callId) });
        });
    });
    const homePort = await listen(http);
    credentials.token = `header.${Buffer.from(JSON.stringify({ sub: 'account-a' })).toString('base64url')}.signature`;
    const home = await upsertServerProfile({ serverUrl: `http://127.0.0.1:${homePort}`, name: 'HH direct/relay Home' });
    publishLocalDaemonStatus(localRunner, {
        machineId: 'machine-1', daemonAccountId: 'account-a', daemonServerUrl: home.serverUrl,
    });
    const endpoint = PeerLoopbackEndpointCandidateV1Schema.parse({ v: 1, routeKind: 'loopback_direct',
        url: `http://127.0.0.1:${endpointPort}/`, endpointFingerprint: 'hh-endpoint', expiresAt: Date.now() + 300_000 });
    const machine = createMachineFixture({ daemonState: { peerMediation: { loopback: { endpoint } } } });
    getStorage().setState({ machineListByServerId: { [home.id]: [machine] } });
    return { calls, scope: { serverId: home.id, accountId: 'account-a' },
        fileList: (timeoutMs: number) => machineWorkspaceFileList(machine.id, { rootPath: '/', query: 'fsp-find-review' }, {
            serverId: home.id, accountId: 'account-a', timeoutMs,
        }),
        call: (options: { timeoutMs?: number; signal?: AbortSignal; method?: string } = {}) => machineRpcWithServerScope({
            serverId: home.id, accountId: 'account-a', machineId: machine.id,
            method: options.method ?? RPC_METHODS.DAEMON_MEMORY_STATUS, payload: { includeWorkers: true }, preferScoped: true,
            timeoutMs: options.timeoutMs ?? 4_000, signal: options.signal }),
        close: async () => {
            await serverScopedRpcSocketPool.stopAll();
            await new Promise<void>(resolve => relay.close(() => resolve()));
        } };
}

it('preserves a real Home RPC refusal through the composed Computer Action and strict client', async () => {
    const [{ createActionExecutor}, { createUnavailableRuntimeActionExecutor}] = await Promise.all([import('@happier-dev/protocol/actions/actionExecutor'), import('@happier-dev/protocol/actions/executor/dispatch')]);
    const { ActionExecuteFailureSchema } = await import('@happier-dev/protocol/actions/actionExecutionResult');
    const { DaemonComputerActionExecuteRequestV1Schema } = await import('@happier-dev/protocol/computer/v1');
    const { createComputerRuntimeActionExecutor } = await import('@/sync/domains/computer/actions/runtimeActionExecutor');
    const { createComputerControlClient } = await import('@/sync/domains/computer/computerControlClient');
    const home = await createDirectRelayHome(1);
    try {
        const executor = createActionExecutor({ runtimeActionExecute: createComputerRuntimeActionExecutor({ fallback: createUnavailableRuntimeActionExecutor() }) } as import('@happier-dev/protocol/actions/executor/types').ActionExecutorDeps);
        let failure: unknown;
        const client = createComputerControlClient({ serverId: home.scope.serverId, machineId: 'machine-1', sessionId: 'computer-session' }, async (...args) => {
            const result = await executor.execute(...args);
            failure = result;
            return result;
        });
        expect(await client.listTargets()).toEqual({ ok: false, code: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE });
        expect(ActionExecuteFailureSchema.parse(failure)).toMatchObject({ errorCode: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE });
        expect(home.calls.length).toBeGreaterThan(0);
        for (const packet of home.calls) {
            expect(packet.method).toBe(`machine-1:${RPC_METHODS.DAEMON_COMPUTER_ACTION_EXECUTE}`);
            const decoded = await socketRpcCodec.decodeRequestParams({ mode: 'plain' }, packet.params, packet.method);
            expect(DaemonComputerActionExecuteRequestV1Schema.parse(decoded.params)).toEqual({
                actionId: 'computer.targets.list', sessionId: 'computer-session', input: { machineId: 'machine-1' },
            });
        }
    } finally { await home.close(); }
});

it('transfers the remaining filename budget after setup and preserves a partial reply after domain expiry', async () => {
    const relayReply = createDeferred<void>();
    const home = await createDirectRelayHome(1, relayReply.promise, 100);
    const release = setTimeout(() => relayReply.resolve(), 1_100);
    try {
        expect(DaemonWorkspaceFileListResponseSchema.parse(await home.fileList(1_000))).toEqual({
            ok: true, paths: ['tmp/fsp-find-review/target.txt'], truncated: true,
        });
        expect(home.calls).toHaveLength(1);
        expect(home.calls[0]?.timeoutMs).toBeNull();
        const decoded = await socketRpcCodec.decodeRequestParams({ mode: 'plain' }, home.calls[0]!.params, home.calls[0]!.method);
        const deliveredBudget = DaemonWorkspaceFileListRequestSchema.parse(decoded.params).budgetMs;
        expect(deliveredBudget).toBeGreaterThan(0);
        expect(deliveredBudget).toBeLessThanOrEqual(900);
        expect(readMachineRequestReachabilityObservation(home.scope, 'machine-1')?.outcome).toBe('succeeded');
    } finally {
        clearTimeout(release);
        relayReply.resolve();
        await home.close();
    }
});

it('relays an unreachable direct endpoint, skips it after relay success, and retries it after the exact reconnect', async () => {
    const reservation = createServer();
    const port = await listen(reservation);
    await closeHttp(reservation);
    const home = await createDirectRelayHome(port);
    let directPosts = 0;
    let directOptions = 0;
    const direct = createServer(async (request, response) => {
        if (request.method === 'OPTIONS') {
            directOptions++;
            response.writeHead(204).end();
            return;
        }
        directPosts++;
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        const rpc = PeerMachineRpcDirectRequestV2Schema.parse(JSON.parse(Buffer.concat(chunks).toString()));
        expect(request.url).toBe(PEER_MACHINE_RPC_DIRECT_PATH_V2);
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify(PeerMachineRpcDirectResponseV2Schema.parse({ v: 2, ok: true,
            receipt: PEER_MEDIATION_RECEIPTS.rpcDirectCallSucceeded, requestId: rpc.requestId, method: rpc.method,
            routeKind: 'loopback_direct', result: { route: 'direct', params: rpc.params } })));
    });
    let directListening = false;
    try {
        await expect(home.call()).resolves.toEqual({ route: 'relay', params: { includeWorkers: true } });
        expect(readMachineRequestReachabilityObservation(home.scope, 'machine-1', 'loopback_direct')?.outcome).toBe('failed');
        expect(readMachineRequestReachabilityObservation(home.scope, 'machine-1')?.outcome).toBe('succeeded');
        await listen(direct, port);
        directListening = true;
        await expect(home.call()).resolves.toMatchObject({ route: 'relay' });
        expect(directOptions + directPosts).toBe(0);
        clearMachineRequestReachabilityForMachine(home.scope, 'machine-1');
        await expect(home.call()).resolves.toEqual({ route: 'direct', params: { includeWorkers: true } });
        expect(directPosts).toBe(1);
        expect(home.calls).toHaveLength(2);
        expect(readMachineRequestReachabilityObservation(home.scope, 'machine-1', 'loopback_direct')?.outcome).toBe('succeeded');
    } finally {
        if (directListening) await closeHttp(direct);
        await home.close();
    }
});

it('skips a remote browser loopback without probing or waiting for an unusable direct-route grant', async () => {
    const direct = createServer();
    const port = await listen(direct);
    const grantReply = createDeferred<void>();
    const home = await createDirectRelayHome(port, undefined, 0, grantReply.promise);
    publishLocalDaemonStatus(localRunner, null);
    const realFetch = globalThis.fetch;
    const attempts: string[] = [];
    // Chromium exposes net::ERR_SOCKS_CONNECTION_FAILED to fetch as this
    // TypeError; the network code itself is only visible to browser tooling.
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
        if (String(input) === `http://127.0.0.1:${port}${PEER_MACHINE_RPC_DIRECT_PATH_V2}`) {
            attempts.push(init?.method ?? 'GET');
            throw new TypeError('Failed to fetch');
        }
        return realFetch(input, init);
    });
    try {
        await expect(home.call()).resolves.toEqual({ route: 'relay', params: { includeWorkers: true } });
        expect(attempts).toEqual([]);
        expect(home.calls).toHaveLength(1);
        expect(readMachineRequestReachabilityObservation(home.scope, 'machine-1', 'loopback_direct')).toBeNull();
        expect(readMachineRequestReachabilityObservation(home.scope, 'machine-1')?.outcome).toBe('succeeded');
    } finally {
        grantReply.resolve();
        await closeHttp(direct);
        await home.close();
    }
});

it.each(['lost', 'http-error'] as const)('never replays an accepted direct POST with a %s response, even when the relay is healthy', async (failure) => {
    let effects = 0;
    const direct = createServer(async (request, response) => {
        if (request.method === 'OPTIONS') { response.writeHead(204).end(); return; }
        for await (const _chunk of request) { /* Consume the delivered request before losing its reply. */ }
        effects++;
        if (failure === 'lost') response.destroy();
        else response.writeHead(500).end('{}');
    });
    const home = await createDirectRelayHome(await listen(direct));
    try {
        const error = await home.call({ method: RPC_METHODS.DAEMON_BROWSER_CONTROL_DISPATCH }).catch((cause: unknown) => cause);
        expect(readRpcRequestDisposition(error)).toBe('outcomeUnknown');
        expect(effects).toBe(1);
        expect(home.calls).toHaveLength(0);
    } finally {
        await closeHttp(direct);
        await home.close();
    }
});

it('spends the same caller deadline on direct readiness and relay, without renewing the budget', async () => {
    const relayReply = createDeferred<void>();
    const direct = createServer((_request, response) => {
        setTimeout(() => response.destroy(), 150);
    });
    const home = await createDirectRelayHome(await listen(direct), relayReply.promise);
    try {
        const error = await home.call({ timeoutMs: 1_000 }).catch((cause: unknown) => cause);
        expect(error).toMatchObject({ code: 'MACHINE_RPC_TIMEOUT', timeoutMs: 1_000 });
        expect(readRpcRequestDisposition(error)).toBe('outcomeUnknown');
        expect(home.calls).toHaveLength(1);
        const remaining = SocketRpcTimeoutMsSchema.parse(home.calls[0]?.timeoutMs);
        expect(remaining).toBeGreaterThan(0);
        expect(remaining).toBeLessThanOrEqual(850);
    } finally {
        relayReply.resolve();
        await closeHttp(direct);
        await home.close();
    }
});

it('cancels direct readiness before RPC delivery without relaying or poisoning the route', async () => {
    const arrived = createDeferred<void>();
    let directPosts = 0;
    const direct = createServer((request) => {
        if (request.method === 'POST') directPosts++;
        arrived.resolve();
    });
    const home = await createDirectRelayHome(await listen(direct));
    const controller = new AbortController();
    try {
        const pending = home.call({ signal: controller.signal }).catch((cause: unknown) => cause);
        await arrived.promise;
        controller.abort();
        const error = await pending;
        expect(error).toMatchObject({ code: 'MACHINE_RPC_ABORTED' });
        expect(readRpcRequestDisposition(error)).toBe('notSent');
        expect(directPosts).toBe(0);
        expect(home.calls).toHaveLength(0);
        expect(readMachineRequestReachabilityObservation(home.scope, 'machine-1', 'loopback_direct')).toBeNull();
    } finally {
        await closeHttp(direct);
        await home.close();
    }
});

it('spends the caller deadline through the real Home HTTP and Socket.IO transport', async () => {
    const deadlineMs = 4_000;
    const http = createHomeServer((request, response) => {
        response.setHeader('content-type', 'application/json');
        if (request.url === '/health' || request.url === '/v1/auth/ping') {
            response.end('{}');
        } else if (request.url === '/v1/account/encryption') {
            response.end(JSON.stringify({ mode: 'plain', updatedAt: 1 }));
        } else if (request.url === '/v1/machines/machine-1' || request.url === '/v1/machines/read-batch') {
            response.end(serializeMachineReadFixture(request, { id: 'machine-1', dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER }));
        } else if (request.url === '/v1/features') {
            response.statusCode = 404;
            response.end('{}');
        } else {
            response.statusCode = 404;
            response.end('{}');
        }
    });
    const server = new Server(http, { path: '/v1/updates/' });
    let observeRequest!: (value: unknown) => void;
    const received = new Promise<unknown>((resolve) => { observeRequest = resolve; });
    let calls = 0;
    server.on('connection', socket => {
        socket.on(SOCKET_RPC_EVENTS.CALL, (request: unknown) => {
            calls += 1;
            observeRequest(request);
            // The daemon has accepted the request but never returns an ACK.
        });
    });
    await new Promise<void>(resolve => { http.listen(0, '127.0.0.1', resolve); });
    const address = http.address();
    if (!address || typeof address === 'string') throw new Error('Missing loopback Home address');
    credentials.token = `header.${Buffer.from(JSON.stringify({ sub: 'account-a' })).toString('base64url')}.signature`;
    try {
        const home = await upsertServerProfile({ serverUrl: `http://127.0.0.1:${address.port}`, name: 'Loopback Home' });
        const pending = machineRpcWithServerScope({ serverId: home.id, machineId: 'machine-1',
            method: 'method-test', payload: { probe: true }, preferScoped: true, timeoutMs: deadlineMs })
            .catch((error: unknown) => error);
        const request = await Promise.race([
            received,
            pending.then(() => { throw new Error('Machine RPC settled before reaching the Socket.IO transport'); }),
        ]);
        expect(request).toMatchObject({ method: 'machine-1:method-test' });
        if (!request || typeof request !== 'object' || !('params' in request) || !('timeoutMs' in request)) {
            throw new Error('Missing RPC parameters or the propagated deadline');
        }
        expect(await socketRpcCodec.decodeRequestParams({ mode: 'plain' }, request.params, 'machine-1:method-test'))
            .toMatchObject({ params: { probe: true } });
        const transportTimeoutMs = SocketRpcTimeoutMsSchema.parse(request.timeoutMs);
        expect(transportTimeoutMs).toEqual(expect.any(Number));
        expect(transportTimeoutMs).toBeGreaterThan(0);
        expect(transportTimeoutMs).toBeLessThanOrEqual(deadlineMs);
        const error = await pending;
        expect(error).toMatchObject({ code: 'MACHINE_RPC_TIMEOUT', timeoutMs: deadlineMs });
        expect(readRpcRequestDisposition(error)).toBe('outcomeUnknown');
        expect(calls).toBe(1);
        expect(readMachineRequestReachabilityObservation({ serverId: home.id, accountId: 'account-a' }, 'machine-1')).toBeNull();
    } finally {
        await serverScopedRpcSocketPool.stopAll();
        await new Promise<void>(resolve => { server.close(() => resolve()); });
    }
});
