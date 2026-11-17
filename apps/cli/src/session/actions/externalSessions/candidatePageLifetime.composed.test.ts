import { createServer } from 'node:http';
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Server } from 'socket.io';
import { io } from 'socket.io-client';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';

// The publication fixture imports fs; load it before replacing that OS boundary.
const { createBundledPluginPublicationFsFixture } = await vi.hoisted(async () => (
    import('@/plugins/projection/registry/builtIn/locators.testkit')
));
import { SOCKET_RPC_EVENTS, type SocketRpcRequestPayload } from '@happier-dev/protocol/socketRpc';
import { ExternalSessionsCandidatesListRequestSchema, ExternalSessionsCandidatesListResponseSchema } from '@happier-dev/protocol/sessions/external/daemonRpcV1';
import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { registerMachineExternalSessionsRpcHandlers } from '@/api/machine/rpcHandlers.externalSessions';
import { createResolvedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import { resolveBuiltInContributions } from '@/plugins/projection/registry/resolveBuiltInContributions';
import { machineExternalSessionsCandidatesList } from '../../../../../ui/sources/sync/ops/machineExternalSessions';
import { upsertServerProfile } from '../../../../../ui/sources/sync/domains/server/serverProfiles';
import { getStorage } from '../../../../../ui/sources/sync/domains/state/storageStore';
import { createMachineFixture, createPlainMachineReadHttpResponseFixture } from '../../../../../ui/sources/dev/testkit/fixtures/machineFixtures';
import { serverScopedRpcSocketPool } from '../../../../../ui/sources/sync/runtime/orchestration/serverScopedRpc/serverScopedRpcSocketPool';
import { resetScopedMachineTransportCacheForTests } from '../../../../../ui/sources/sync/runtime/orchestration/serverScopedRpc/serverScopedRpcPool';

const boundary = vi.hoisted(() => ({ activeServerDir: '', token: '', slowPath: '',
    finalizationMs: 0, scanEntered: () => {}, scanWaitMs: 0, receiptAdmissionMs: 0 }));
await vi.hoisted(async () => {
    vi.stubGlobal('__DEV__', true);
    vi.stubGlobal('self', globalThis);
    const path = new URL('../../../../../ui/sources/dev/vitestRnShim.ts', import.meta.url).href;
    const { installVitestRnShim } = await import(path);
    installVitestRnShim();
});
vi.mock('../../../../../ui/sources/dev/reactNativeStub.ts', async () => {
    const factoryPath = new URL('../../../../../ui/sources/dev/testkit/runtime/reactNativeRuntime.ts', import.meta.url).href;
    const stubPath = new URL('../../../../../ui/sources/dev/reactNativeStub.ts', import.meta.url).href;
    const { createReactNativeWebRuntime } = await import(factoryPath);
    return createReactNativeWebRuntime(undefined, () => vi.importActual(stubPath));
});
// Match the package boundary; its installed export path changes with the toolchain.
vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('../../../../../ui/sources/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});
vi.mock('expo-updates', async () => {
    const { createExpoUpdatesMock } = await import('../../../../../ui/sources/dev/testkit/mocks/expoUpdates');
    return createExpoUpdatesMock();
});
vi.mock('@shopify/react-native-skia', async () => {
    const { createReactNativeSkiaMock } = await import('../../../../../ui/sources/dev/testkit/mocks/reactNativeSkia');
    return createReactNativeSkiaMock();
});
// This transport composition renders no native images or filesystem views.
vi.mock('expo-image', () => ({ Image: 'Image' }));
vi.mock('expo-file-system', async () => {
    const { createExpoFileSystemFileMock } = await import('../../../../../ui/sources/dev/testkit/mocks/expoFileSystem');
    return createExpoFileSystemFileMock().module;
});
// Device credentials and filesystem latency are genuine external boundaries.
// The UI caller, Home HTTP/Socket.IO, RPC registration, bundled Agent and codecs remain real.
vi.mock('../../../../../ui/sources/auth/storage/tokenStorage', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../../../../../ui/sources/auth/storage/tokenStorage')>();
    const { createTokenStorageModuleMock } = await import('../../../../../ui/sources/dev/testkit/mocks/tokenStorage');
    return await createTokenStorageModuleMock({ importOriginal,
        subscribeHomeCredentialMutations: actual.subscribeHomeCredentialMutations,
        tokenStorage: { getCredentialsForServerUrl: async () => ({ token: boundary.token }) } });
});
vi.mock('@/configuration', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/configuration')>();
    return { ...actual, configuration: { ...actual.configuration,
        get activeServerDir() { return boundary.activeServerDir; } } };
});
vi.mock('node:fs/promises', async (importOriginal) => {
    const actual = await importOriginal<typeof import('node:fs/promises')>();
    return { ...actual, open: async (...args: Parameters<typeof actual.open>) => {
        const handle = await actual.open(...args);
        if (args[0] === boundary.slowPath) {
            boundary.scanEntered();
            if (boundary.scanWaitMs) await new Promise(resolve => setTimeout(resolve, boundary.scanWaitMs));
        }
        return handle;
    } };
});
vi.mock('@/persistence', async (importOriginal) => ({
    ...await importOriginal<typeof import('@/persistence')>(),
    readSettings: async () => {
        // Device settings IO occurs after RPC receipt, before source admission.
        // The admitted Agent runs across the native module boundary and has its
        // own clock. Model actual receiving IO time so both clocks observe it.
        if (boundary.receiptAdmissionMs) await new Promise(resolve => setTimeout(resolve, boundary.receiptAdmissionMs));
        return { memory: { v: 1, enabledAtMs: 1 } };
    },
    readStoredCredentials: async () => ({ token: 'fixture-token', encryption: null }),
}));
vi.mock('@/api/client/connectedServiceCredentialApi', async (importOriginal) => ({
    ...await importOriginal<typeof import('@/api/client/connectedServiceCredentialApi')>(),
    fetchAccountEncryptionCurrentness: async () => {
        await new Promise(resolve => setTimeout(resolve, boundary.finalizationMs));
        return { mode: 'plain' as const };
    },
}));
vi.mock('@/session/transport/http/sessionsHttp', async (importOriginal) => ({
    ...await importOriginal<typeof import('@/session/transport/http/sessionsHttp')>(),
    lookupSessionsByTags: async ({ tags }: { tags: readonly string[] }) => ({ state: 'available' as const, tags, sessions: [] }),
}));
vi.mock('node:fs', async (importOriginal) => {
    const actual = await importOriginal<typeof import('node:fs')>();
    return createBundledPluginPublicationFsFixture(actual);
});

const disposeRuntimes: Array<() => Promise<void>> = [];
afterAll(async () => {
    // Each fixture releases its lease; only suite retirement shuts down the
    // shared real controller used by the host's source-resolution owner.
    for (const dispose of disposeRuntimes) await dispose();
    vi.unstubAllGlobals();
});

afterEach(async () => {
    vi.restoreAllMocks();
    boundary.finalizationMs = 0;
    boundary.receiptAdmissionMs = 0;
    boundary.scanWaitMs = 0;
    boundary.scanEntered = () => {};
    await serverScopedRpcSocketPool.stopAll();
    serverScopedRpcSocketPool.resetForTests();
    resetScopedMachineTransportCacheForTests();
});

async function createCandidateHome(schedule: Readonly<{ ingressMs: number; returnMs: number; finalizationMs: number }>) {
    const root = await mkdtemp(join(tmpdir(), 'candidate-page-lifetime-'));
    const previousConfig = process.env.CLAUDE_CONFIG_DIR;
    const configDir = join(root, 'claude');
    boundary.activeServerDir = join(root, 'server');
    boundary.finalizationMs = schedule.finalizationMs;
    const project = join(configDir, 'projects', 'project');
    await mkdir(project, { recursive: true });
    // A one-row transcript reaches verified EOF in its first indivisible unit,
    // which is allowed to finish after the scan deadline. Keep an older row so
    // expiry must checkpoint before it can publish a hit from this transcript.
    await writeFile(join(project, 'recent.jsonl'), [
        { type: 'user', uuid: 'recent', parentUuid: null, message: { role: 'user', content: 'lifetime needle' } },
        { type: 'assistant', uuid: 'recent-reply', parentUuid: 'recent', message: { role: 'assistant', content: 'ordinary reply' } },
    ].map(row => JSON.stringify(row)).join('\n') + '\n');
    await utimes(join(project, 'recent.jsonl'), new Date('2026-10-01'), new Date('2026-10-01'));
    boundary.slowPath = join(project, 'slow.jsonl');
    await writeFile(boundary.slowPath, Array.from({ length: 1500 }, (_, index) => JSON.stringify({
        type: 'user', uuid: `slow-${index}`, parentUuid: index ? `slow-${index - 1}` : null,
        message: { role: 'user', content: index === 1499 ? 'lifetime needle' : 'ordinary \\text '.repeat(40) },
    })).join('\n') + '\n');
    await utimes(boundary.slowPath, new Date('2026-01-01'), new Date('2026-01-01'));
    process.env.CLAUDE_CONFIG_DIR = configDir;
    const { pluginReloadController } = await import('@/plugins/runtime/reload/singleton');
    const { createAdmittedPluginRuntimeFixture } = await import('@/plugins/testkit/admittedRuntime');
    const runtime = await createAdmittedPluginRuntimeFixture({ happyHomeDir: join(root, 'happier'), controller: pluginReloadController,
        runtimeOptions: { contributes: createResolvedContributionRegistry(resolveBuiltInContributions()), pluginIds: ['happier.agent.claude'] } });
    disposeRuntimes.push(() => runtime.dispose());
    const manager = new RpcHandlerManager({ scopePrefix: 'machine-1', encryptionMode: 'plain' });
    const registration = registerMachineExternalSessionsRpcHandlers({ rpcHandlerManager: manager });
    const http = createServer(async (request, response) => {
        response.setHeader('content-type', 'application/json');
        if (request.url?.startsWith('/v1/machines/')) {
            const chunks: Buffer[] = [];
            for await (const chunk of request) chunks.push(Buffer.from(chunk));
            const machineResponse = createPlainMachineReadHttpResponseFixture(request.url, {
                method: request.method, ...(chunks.length ? { body: Buffer.concat(chunks).toString('utf8') } : {}),
            }, 'account-a');
            if (machineResponse) {
                response.statusCode = machineResponse.status;
                response.end(await machineResponse.text());
                return;
            }
        }
        if (request.url === '/health' || request.url === '/v1/auth/ping') response.end('{}');
        else if (request.url === '/v1/account/encryption') response.end(JSON.stringify({ mode: 'plain', updatedAt: 1 }));
        else { response.statusCode = 404; response.end('{}'); }
    });
    const relay = new Server(http, { path: '/v1/updates/' });
    const packets: SocketRpcRequestPayload[] = [];
    const responses: unknown[] = [];
    const pendingRequests = new Set<Promise<void>>();
    let cancellationReceived!: () => void;
    const cancelled = new Promise<void>(resolve => { cancellationReceived = resolve; });
    relay.on('connection', socket => {
        socket.on(SOCKET_RPC_EVENTS.CALL, (packet: SocketRpcRequestPayload, ack: (value: unknown) => void) => {
            packets.push(packet);
            const pending = (async () => {
                try {
                    await new Promise(resolve => setTimeout(resolve, schedule.ingressMs));
                    const result = await manager.handleRequest(packet);
                    responses.push(result);
                    await new Promise(resolve => setTimeout(resolve, schedule.returnMs));
                    ack({ ok: true, result });
                } catch (error) {
                    ack({ ok: false, error: String(error) });
                }
            })();
            pendingRequests.add(pending);
            void pending.finally(() => pendingRequests.delete(pending));
        });
        socket.on(SOCKET_RPC_EVENTS.CANCEL, (packet) => {
            relay.emit(SOCKET_RPC_EVENTS.CANCEL, packet);
            cancellationReceived();
        });
    });
    await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
    const address = http.address();
    if (!address || typeof address === 'string') throw new Error('Missing fixture address');
    const daemonSocket = io(`http://127.0.0.1:${address.port}`, { path: '/v1/updates/', transports: ['websocket'], reconnection: false });
    await new Promise<void>((resolve, reject) => {
        daemonSocket.once('connect', resolve);
        daemonSocket.once('connect_error', reject);
    });
    manager.onSocketConnect(daemonSocket);
    boundary.token = `header.${Buffer.from(JSON.stringify({ sub: 'account-a' })).toString('base64url')}.signature`;
    const home = await upsertServerProfile({ serverUrl: `http://127.0.0.1:${address.port}`, name: 'Candidate lifetime' });
    getStorage().setState({ machineListByServerId: { [home.id]: [createMachineFixture()] } });
    const close = async () => {
        await Promise.all(pendingRequests);
        await serverScopedRpcSocketPool.stopAll();
        daemonSocket.disconnect();
        await new Promise<void>(resolve => relay.close(() => resolve()));
        await registration.dispose();
        await runtime.lease.release();
        if (previousConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR;
        else process.env.CLAUDE_CONFIG_DIR = previousConfig;
        await rm(root, { recursive: true, force: true });
    };
    // Warm the real caller's HTTP, socket and native-source setup with an
    // independent call, so the regression's short budget starts before emission.
    try {
        const warmed = await machineExternalSessionsCandidatesList({ machineId: 'machine-1', agentId: 'claude',
            source: { kind: 'claudeConfig' }, searchTarget: 'content', searchTerm: 'lifetime needle' },
        { serverId: home.id, accountId: 'account-a', timeoutMs: 5_000 });
        if (!warmed.ok || warmed.candidates.length !== 2) throw new Error('Fixture failed to warm the real caller and native Agent');
    } catch (error) { await close(); throw error; }
    packets.length = 0;
    responses.length = 0;
    return {
        packets, responses, cancelled,
        settle: async () => { await Promise.all(pendingRequests); },
        call: (signal?: AbortSignal, budgetMs?: number, limit = 1) => machineExternalSessionsCandidatesList({ machineId: 'machine-1', agentId: 'claude',
            source: { kind: 'claudeConfig' }, searchTarget: 'content', searchTerm: 'lifetime needle', limit },
        { serverId: home.id, accountId: 'account-a', timeoutMs: budgetMs ?? 500, ...(signal ? { signal } : {}) }),
        metadata: () => machineExternalSessionsCandidatesList({ machineId: 'machine-1', agentId: 'claude',
            source: { kind: 'claudeConfig' }, searchTarget: 'metadata', limit: 1 },
        { serverId: home.id, accountId: 'account-a', timeoutMs: 500 }),
        close,
    };
}

describe('candidate page operation lifetime through the real caller and receiver', () => {
    it('keeps metadata listing on its finite invocation lifetime', async () => {
        const home = await createCandidateHome({ ingressMs: 0, finalizationMs: 0, returnMs: 650 });
        try {
            await expect(home.metadata()).rejects.toMatchObject({ code: 'MACHINE_RPC_TIMEOUT' });
            expect(home.packets[0]?.timeoutMs).toBeGreaterThan(0);
        } finally { await home.close(); }
    });

    it.each([
        { ingressMs: 650, finalizationMs: 0, returnMs: 0 },
        { ingressMs: 0, finalizationMs: 650, returnMs: 0 },
        { ingressMs: 100, finalizationMs: 100, returnMs: 650 },
    ])('keeps the scanned page across variable transit and finalization: %j', async schedule => {
        const home = await createCandidateHome(schedule);
        try {
            const response = home.call().catch(error => {
                // A failing lifetime regression must have reached the relay;
                // setup-only timeouts are not evidence for this contract.
                expect(home.packets).toHaveLength(1);
                throw error;
            });
            const page = ExternalSessionsCandidatesListResponseSchema.parse(await response);
            expect(page).toMatchObject({ ok: true, candidates: [{ remoteSessionId: 'recent' }],
                contentCoverage: 'partial', nextCursor: expect.any(String) });
            expect(home.packets[0]?.timeoutMs).toBeNull();
            const { socketRpcCodec } = await import('@happier-dev/sync-client');
            const packet = home.packets[0]!;
            const decoded = await socketRpcCodec.decodeRequestParams({ mode: 'plain' }, packet.params, packet.method);
            const request = ExternalSessionsCandidatesListRequestSchema.parse(decoded.params);
            expect(request.budgetMs).toBeGreaterThan(0);
            expect(request.budgetMs).toBeLessThanOrEqual(500);
        } finally { await home.close(); }
    });

    it('includes receiving preparation in the scan budget and preserves caller cancellation with a fresh retry', async () => {
        const home = await createCandidateHome({ ingressMs: 0, returnMs: 0, finalizationMs: 0 });
        const controller = new AbortController();
        boundary.scanWaitMs = 100;
        boundary.scanEntered = () => controller.abort();
        try {
            await expect(home.call(controller.signal, undefined, 50)).rejects.toMatchObject({ code: 'MACHINE_RPC_ABORTED' });
            await home.cancelled;
            await home.settle();
            // A local AbortError alone would pass if the target never received
            // cancellation. The target must publish its cancelled transport result.
            expect(home.responses[0]).toMatchObject({ error: expect.any(String) });
            expect(ExternalSessionsCandidatesListResponseSchema.parse(home.responses[0])).toMatchObject({ ok: false });
            boundary.scanEntered = () => {};
            boundary.scanWaitMs = 0;
            boundary.receiptAdmissionMs = 500;
            const expired = ExternalSessionsCandidatesListResponseSchema.parse(await home.call());
            expect(expired).toMatchObject({ ok: true, candidates: [], contentCoverage: 'partial', nextCursor: expect.any(String) });
            boundary.receiptAdmissionMs = 0;
            const retry = ExternalSessionsCandidatesListResponseSchema.parse(await home.call(undefined, 5_000, 50));
            expect(retry).toMatchObject({ ok: true, contentCoverage: 'complete', nextCursor: null });
            if (!retry.ok) throw new Error('Expected fresh retry success');
            expect(retry.candidates.map(candidate => candidate.remoteSessionId)).toEqual(['recent', 'slow']);
        } finally { await home.close(); }
    });
});
