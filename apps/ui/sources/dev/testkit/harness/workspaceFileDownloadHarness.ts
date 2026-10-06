import type { NativeIrohModule } from '@happier-dev/iroh-native';
import { DirectRouteGrantRequestV2Schema, MACHINE_PLAIN_DATA_KEY_MARKER, SignedDirectRouteGrantV2Schema, tryWriteServerEnabledBitInPlace } from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { vi } from 'vitest';

import { createRootLayoutFeaturesResponse } from '../fixtures/featureFixtures';
import { createMachineFixture } from '../fixtures/machineFixtures';

type WorkspaceStatFileResponse = Awaited<ReturnType<typeof import('@/sync/domains/transfers/runtime/transferRuntime').callDaemonWorkspaceStatFileRpc>>;

type BoundaryOwner = {
    native: NativeIrohModule;
    machineRPC(machineId: string, method: string, payload: unknown, options?: { onIssued?: () => void }): Promise<unknown>;
};
const installed = vi.hoisted(() => ({ current: null as BoundaryOwner | null }));

// These are genuine native SDK and Socket.IO boundaries. Transfer policy,
// prepared publication, routing, encryption and destination owners stay real.
vi.mock('@happier-dev/iroh-native', async (importOriginal) => ({
    ...await importOriginal<typeof import('@happier-dev/iroh-native')>(),
    getOptionalHappierIrohNativeModule: () => installed.current?.native ?? null,
}));
vi.mock('@/sync/api/session/apiSocket', () => ({
    apiSocket: {
        machineRPC: (...args: Parameters<BoundaryOwner['machineRPC']>) => {
            if (!installed.current) throw new Error('Workspace download boundary is not installed');
            return installed.current.machineRPC(...args);
        },
    },
}));

vi.mock('socket.io-client', async (importOriginal) => {
    const actual = await importOriginal<typeof import('socket.io-client')>();
    const { createSocketIoBoundaryStub } = await import('../mocks/socketIo');
    return { ...actual, io: () => {
        const boundary = createSocketIoBoundaryStub();
        boundary.socket.connected = true;
        boundary.socket.emitWithAck.mockImplementation(async (_event, payload) => {
            if (!installed.current || !payload || typeof payload !== 'object') throw new Error('Unexpected scoped socket request');
            const request = payload as { method?: unknown; params?: unknown };
            if (typeof request.method !== 'string') throw new Error('Missing socket RPC method');
            const separator = request.method.indexOf(':');
            return { ok: true, result: await installed.current.machineRPC(request.method.slice(0, separator), request.method.slice(separator + 1), request.params) };
        });
        return boundary.socket;
    } };
});

export async function createWorkspaceFileDownloadHarness(options: Readonly<{
    name?: string;
    bytes?: Uint8Array;
}> = {}) {
    const { TokenStorage } = await import('@/auth/storage/tokenStorage');
    const { upsertAndActivateServer } = await import('@/sync/domains/server/serverRuntime');
    const { storage } = await import('@/sync/domains/state/storage');
    const { primeServerFeaturesSnapshot, resetServerFeaturesClientForTests } = await import('@/sync/api/capabilities/serverFeaturesClient');
    const { setRuntimeFetch, resetRuntimeFetch } = await import('@/utils/system/runtimeFetch');
    const { createEncryptedTransferChunkEnvelope } = await import('@/sync/domains/transfers/runtime/transferRuntime/plumbing/transferChunkEncryption');
    const { createTransferManifestHasher } = await import('@/sync/domains/transfers/runtime/transferRuntime/plumbing/transferManifestHasher');

    const name = options.name ?? 'clip.mp4';
    const bytes = options.bytes ?? new Uint8Array([1, 2, 3]);
    const accountId = 'workspace-download-account';
    const token = `e30.${btoa(JSON.stringify({ sub: accountId })).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')}.signature`;
    // The device credential-store adapter is a genuine persistence boundary.
    const credentialSpies = [
        vi.spyOn(TokenStorage, 'getCredentials').mockResolvedValue({ token }),
        vi.spyOn(TokenStorage, 'getCredentialsForServerUrl').mockResolvedValue({ token }),
    ];
    const profile = await upsertAndActivateServer({ serverUrl: 'https://workspace-download.example.test', scope: 'device' });
    const scope = { serverId: profile.id, machineId: 'workspace-download-machine', rootPath: '/repo' };
    const features = createRootLayoutFeaturesResponse();
    for (const id of ['machines.transfer', 'machines.transfer.directPeer', 'machines.peerMediation'] as const) {
        if (!tryWriteServerEnabledBitInPlace(features, id, true)) throw new Error(`Unable to seed ${id}`);
    }
    primeServerFeaturesSnapshot({ serverId: scope.serverId, snapshot: { status: 'ready', features } });
    const previousState = storage.getState();
    const machine = createMachineFixture({
        id: scope.machineId,
        kind: 'persistent',
        operationProtocolCapabilitiesRevision: 1,
        operationProtocolCapabilities: { irohMachineEndpoint: {
            protocolVersions: [1], endpointId: 'a'.repeat(64), directAddresses: ['127.0.0.1:41101'],
        } },
        daemonState: { transfer: {
            supported: { import: true, export: true },
            listenerClasses: {
                loopback_http: { enabled: false, configured: false, active: false },
                tailscale_serve_https: { enabled: false, configured: false, active: false },
            },
            lifecycle: { mode: 'lazy_idle_shutdown', version: 1 },
        } },
    });
    storage.setState({ machines: { [machine.id]: machine }, machineListByServerId: { [scope.serverId]: [machine] } });
    const requests: { url: string; signal: AbortSignal | null | undefined }[] = [];
    const rpcRequests: { machineId: string; method: string; payload: unknown }[] = [];
    const nativeTunnelStarts: unknown[] = [];
    const nativeTunnelStops: string[] = [];
    let statResponse: WorkspaceStatFileResponse = { success: true, exists: true, kind: 'file', sizeBytes: bytes.byteLength, modifiedMs: 1 };
    let transferCount = 0;
    let failChunk = false;
    let deferredChunk: { enter(): void; wait: Promise<void> } | null = null;
    const publications = new Map<string, string>();
    const manifestHasher = createTransferManifestHasher();
    manifestHasher.update(bytes);
    const manifestHash = manifestHasher.digestManifestHash();
    const native: NativeIrohModule = {
        getAvailability: () => ({ available: true }),
        createEndpoint: async () => ({ endpointHandle: 'workspace-download-endpoint', endpointId: 'b'.repeat(64), relayPolicy: 'automatic', relayMode: 'custom', capProfile: 'machineBulk', relayUrls: [] }),
        shutdownEndpoint: async () => {},
        ensureHomeTunnel: async () => { throw new Error('Unexpected Home tunnel'); },
        releaseHomeTunnel: async () => {},
        getTunnelStatus: async () => null,
        startMachineTunnel: async (input) => {
            nativeTunnelStarts.push(input);
            return { machineTunnelId: `workspace-download-lease-${nativeTunnelStarts.length}`, endpointHandle: input.endpointHandle, localPort: 48126, connectionActive: true, remoteEndpointId: input.endpointId, observedPath: 'direct', startedAtMs: Date.now(), lastErrorCode: null };
        },
        stopMachineTunnel: async (id) => { nativeTunnelStops.push(id); },
    };
    const owner: BoundaryOwner = {
        native,
        async machineRPC(machineId, method, payload, rpcOptions) {
            rpcOptions?.onIssued?.();
            rpcRequests.push({ machineId, method, payload });
            if (method === RPC_METHODS.STAT_FILE) return statResponse;
            if (method === RPC_METHODS.DAEMON_DIRECT_TRANSFER_EXPORT_PREPARE) {
                const transferId = `workspace-download-${++transferCount}`;
                publications.set(transferId, name);
                return { success: true, transferId, name, sizeBytes: bytes.byteLength, expiresAt: Date.now() + 60_000, endpointCandidates: [{ kind: 'http', url: `http://10.44.0.8:46001/machine-transfers/direct/${transferId}`, authorizationToken: 'prepared-file-token', expiresAt: Date.now() + 60_000 }] };
            }
            if (method === RPC_METHODS.DAEMON_DIRECT_TRANSFER_EXPORT_RELEASE) return { success: true };
            throw new Error(`Unexpected machine RPC: ${method}`);
        },
    };
    installed.current = owner;
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    setRuntimeFetch(async (input, init) => {
        const url = new URL(String(input));
        requests.push({ url: url.toString(), signal: init?.signal });
        if (url.pathname === `/v1/machines/${scope.machineId}`) return json({ machine: { id: scope.machineId, kind: 'persistent', dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER } });
        if (url.pathname === '/v1/auth/ping') return json({});
        if (url.pathname === '/v1/features' || url.pathname === '/v1/features/authenticated') return json(features);
        if (url.pathname === '/v1/machines/peer/mediation/route-grants') {
            const request = DirectRouteGrantRequestV2Schema.parse(JSON.parse(String(init?.body)));
            const issuedAt = Date.now();
            const grant = SignedDirectRouteGrantV2Schema.parse({
                payload: { v: 2, grantId: `workspace-download-grant-${nativeTunnelStarts.length}`, accountId, machineId: request.machineId, flowKind: request.flowKind, routeKind: request.routeKind, scope: request.scope, iat: issuedAt, exp: issuedAt + request.ttlMs, aud: 'happier-daemon-route-grant', endpointFingerprint: request.endpointFingerprint, proofKind: 'ephemeral_ed25519', ephemeralPublicKeyBase64Url: request.ephemeralPublicKeyBase64Url, iroh: request.iroh },
                signature: { keyId: 'workspace-download-key', alg: 'Ed25519', valueBase64Url: btoa(String.fromCharCode(...new Uint8Array(64).fill(4))).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '') },
            });
            return json({ ok: true, grant });
        }
        const match = /^\/machine-transfers\/direct\/(workspace-download-\d+)\/(open|chunks\/0)$/.exec(url.pathname);
        if (!match || !publications.has(match[1]!)) throw new Error(`Unexpected transfer HTTP: ${url}`);
        const transferId = match[1]!;
        if (match[2] === 'open') return json({ transferId, manifestHash, totalChunks: 1, sizeBytes: bytes.byteLength });
        const deferred = deferredChunk;
        deferredChunk = null;
        if (deferred) { deferred.enter(); await deferred.wait; }
        if (failChunk) { failChunk = false; return json({ error: 'read_failed' }, 500); }
        const envelope = await createEncryptedTransferChunkEnvelope({ transferId, sequence: 0, payload: bytes, recipientPublicKeyBase64: new Headers(init?.headers).get('x-happier-transfer-recipient-public-key') ?? '' });
        return json({ transferId, kind: 'chunk', sequence: 0, ...envelope });
    });
    return {
        scope, requests, rpcRequests, nativeTunnelStarts, nativeTunnelStops,
        setStatResponse(response: WorkspaceStatFileResponse) { statResponse = response; },
        failNextChunk() { failChunk = true; },
        deferNextChunk() {
            let enter!: () => void;
            let release!: () => void;
            const entered = new Promise<void>((resolve) => { enter = resolve; });
            const wait = new Promise<void>((resolve) => { release = resolve; });
            deferredChunk = { enter, wait };
            return { entered, release };
        },
        async reset() {
            if (installed.current === owner) installed.current = null;
            await import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedRpcSocketPool').then(({ serverScopedRpcSocketPool }) => serverScopedRpcSocketPool.stopAll());
            resetRuntimeFetch();
            resetServerFeaturesClientForTests();
            for (const spy of credentialSpies) spy.mockRestore();
            storage.setState({ machines: previousState.machines, machineListByServerId: previousState.machineListByServerId });
        },
    };
}
