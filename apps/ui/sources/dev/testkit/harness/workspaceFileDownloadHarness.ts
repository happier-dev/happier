import type { NativeIrohModule } from '@happier-dev/iroh-native';
import { DirectRouteGrantRequestV2Schema, SignedDirectRouteGrantV2Schema } from '@happier-dev/protocol/machines/peer/mediation/directRouteGrantV2';
import { tryWriteServerEnabledBitInPlace } from '@happier-dev/protocol/features/serverEnabledBit';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { FilesystemDownloadInputSchema, FilesystemUploadInputSchema, FilesystemUploadOutputSchema, type FilesystemUploadInput } from '@happier-dev/protocol/actions/filesystemActionFamily';
import { createTargetedActionRpcRequestV1, TargetedActionRpcRequestV1Schema } from '@happier-dev/protocol/actions/actionRpcTransport';
import { encodePlainMachineStoredContent } from '@happier-dev/protocol/machines/machineStoredContent';
import { MachinePublishedDaemonStateV1Schema } from '@happier-dev/protocol/machines/machinePublishedContentV1';
import { PreparedTransferRpcRequestV1Schema, PreparedTransferRpcResponseV1Schema, resolvePreparedTransferRpcPhaseV1 } from '@happier-dev/protocol/machines/transfer/preparedTransferRpcV1';
import { ComposerContentHandleV1Schema, ComposerContentInspectRequestV1Schema } from '@happier-dev/protocol/runtime/input/composerContentV1';
import { vi } from 'vitest';

import { createRootLayoutFeaturesResponse } from '../fixtures/featureFixtures';
import { createMachineFixture, createPlainMachineRowFixture } from '../fixtures/machineFixtures';
import { configureConnectedServerSocketBoundary, installDisconnectedServerSocketBoundary } from './serverAccountConnectionHarness';
import { encodeBase64 } from '@/encryption/base64';
import { createExternalActionAccountHttpBoundary } from './externalActionAccountHttpBoundary';
import type { RuntimeFetch } from '@/utils/system/runtimeFetch';

type WorkspaceStatFileResponse = Awaited<ReturnType<typeof import('@/sync/domains/transfers/runtime/transferRuntime').callDaemonWorkspaceStatFileRpc>>;

type BoundaryOwner = {
    native: NativeIrohModule;
    machineRPC(machineId: string, method: string, payload: unknown, options?: { onIssued?: () => void }): Promise<unknown>;
};
type DeferredChunkBoundary = { enter(): void; wait: Promise<void>; settle(): void };
const installed = vi.hoisted(() => ({ current: null as BoundaryOwner | null }));

// This fixture represents the user's accepted file-transfer dialog. Action policy,
// including approval requirements, remains in the real shared front door.
vi.mock('@/modal', async () => (await import('../mocks/modal')).createModalModuleMock({ confirmResult: true }).module);

// These are genuine native SDK and Socket.IO boundaries. Transfer policy,
// prepared publication, routing, encryption and destination owners stay real.
vi.mock('@happier-dev/iroh-native', async (importOriginal) => ({
    ...await importOriginal<typeof import('@happier-dev/iroh-native')>(),
    getOptionalHappierIrohNativeModule: () => installed.current?.native ?? null,
}));
vi.mock('socket.io-client', async (importOriginal) =>
    (await import('./serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));

function configureWorkspaceDownloadSocketBoundary() {
    installDisconnectedServerSocketBoundary(socket => {
        configureConnectedServerSocketBoundary(socket);
        socket.emitWithAck = vi.fn<typeof socket.emitWithAck>(async (_event, payload) => {
            if (!installed.current || !payload || typeof payload !== 'object') throw new Error('Unexpected scoped socket request');
            const request = payload as { method?: unknown; params?: unknown };
            if (typeof request.method !== 'string') throw new Error('Missing socket RPC method');
            const separator = request.method.indexOf(':');
            return { ok: true, result: await installed.current.machineRPC(request.method.slice(0, separator), request.method.slice(separator + 1), request.params) };
        });
    });
}

export async function createWorkspaceFileDownloadHarness(options: Readonly<{
    name?: string;
    bytes?: Uint8Array;
    advertisedDownloadSizeBytes?: number;
    downloadEndpointPorts?: readonly number[];
    preparedHttpResponse?: (request: Readonly<{ path: string; signal?: AbortSignal | null }>, response: Response) => Response | Promise<Response>;
    composerInspection?: Readonly<{ id: string; sizeBytes?: number }>;
    onCompleted?: () => void;
    /** Provider Action schemas at the genuine daemon transport boundary. */
    downloadActionInputSchema?: object;
}> = {}) {
    configureWorkspaceDownloadSocketBoundary();
    const { createHomeGovernanceHarness } = await import('./homeGovernanceHarness');
    const { storage } = await import('@/sync/domains/state/storage');
    const { primeServerFeaturesSnapshot, resetServerFeaturesClientForTests } = await import('@/sync/api/capabilities/serverFeaturesClient');
    const { setRuntimeFetch, resetRuntimeFetch } = await import('@/utils/system/runtimeFetch');
    const { createEncryptedTransferChunkEnvelope, createTransferRecipientKeyPair, decryptEncryptedTransferChunkEnvelope } = await import('@/sync/domains/transfers/runtime/transferRuntime/plumbing/transferChunkEncryption');
    const { createTransferManifestHasher } = await import('@/sync/domains/transfers/runtime/transferRuntime/plumbing/transferManifestHasher');

    const name = options.name ?? 'clip.mp4';
    const bytes = options.bytes ?? new Uint8Array([1, 2, 3]);
    const advertisedSizeBytes = options.advertisedDownloadSizeBytes ?? bytes.byteLength;
    const accountId = 'workspace-download-account';
    const homes = createHomeGovernanceHarness();
    const serverId = await homes.addHome({ name: 'Workspace download', serverUrl: 'https://workspace-download.example.test',
        serverIdentityId: 'srv_workspace_download', accountId, currentAccount: true });
    const scope = { serverId, machineId: 'workspace-download-machine', rootPath: '/repo' };
    const features = createRootLayoutFeaturesResponse();
    for (const id of ['machines.transfer', 'machines.transfer.directPeer', 'machines.peerMediation'] as const) {
        if (!tryWriteServerEnabledBitInPlace(features, id, true)) throw new Error(`Unable to seed ${id}`);
    }
    primeServerFeaturesSnapshot({ serverId: scope.serverId, snapshot: { status: 'ready', features } });
    homes.answer(serverId, '/v1/features', { body: features });
    homes.answer(serverId, '/v1/features/authenticated', { body: features });
    const previousState = storage.getState();
    const machine = createMachineFixture({
        id: scope.machineId,
        kind: 'persistent',
        operationProtocolCapabilitiesRevision: 1,
        operationProtocolCapabilities: { irohMachineEndpoint: {
            protocolVersions: [1], endpointId: 'a'.repeat(64), directAddresses: ['127.0.0.1:41101'],
        } },
        daemonState: MachinePublishedDaemonStateV1Schema.parse({ status: 'running', transfer: {
            supported: { import: true, export: true },
            listenerClasses: {
                loopback_http: { enabled: true, configured: true, active: false },
                tailscale_serve_https: { enabled: false, configured: false, active: false },
            },
            lifecycle: { mode: 'lazy_idle_shutdown', version: 1 },
        } }),
    });
    const machineRow = { ...createPlainMachineRowFixture({ id: machine.id, accountId }),
        operationProtocolCapabilities: machine.operationProtocolCapabilities,
        operationProtocolCapabilitiesRevision: machine.operationProtocolCapabilitiesRevision,
        daemonState: encodePlainMachineStoredContent(machine.daemonState) };
    homes.answer(serverId, `/v1/machines/${machine.id}`, { body: { machine: machineRow } });
    homes.answer(serverId, '/v1/machines', { body: [machineRow] });
    homes.answer(serverId, '/v1/machines?includeRevoked=true', { body: [machineRow] });
    storage.setState({ machines: { [machine.id]: machine }, machineListByServerId: { [scope.serverId]: [machine] } });
    const requests: { method: string; url: string; signal: AbortSignal | null | undefined }[] = [];
    const rpcRequests: { machineId: string; method: string; payload: unknown }[] = [];
    const nativeTunnelStarts: unknown[] = [];
    const nativeTunnelStops: string[] = [];
    let statResponse: WorkspaceStatFileResponse = { success: true, exists: true, kind: 'file', sizeBytes: bytes.byteLength, modifiedMs: 1 };
    let transferCount = 0;
    let failChunk = false;
    let deferredChunk: DeferredChunkBoundary | null = null;
    let deferredUploadChunk: DeferredChunkBoundary | null = null;
    let deferredUploadPreparation: DeferredChunkBoundary | null = null;
    let deferredDownloadPreparation: DeferredChunkBoundary | null = null;
    let nextUploadFinalizeResponse: { body: unknown; status: number } | null = null;
    const uploads: {
        uploadId: string;
        input: FilesystemUploadInput;
        bytes: Uint8Array;
        finalized: boolean;
        aborted: boolean;
        finalizeAttempts: number;
    }[] = [];
    const importRecipients = new Map<string, ReturnType<typeof createTransferRecipientKeyPair>>();
    const publications = new Map<string, string>();
    const manifestHasher = createTransferManifestHasher();
    manifestHasher.update(bytes);
    const manifestHash = manifestHasher.digestManifestHash();
    const composerHandle = options.composerInspection ? ComposerContentHandleV1Schema.parse({
        v: 1, id: options.composerInspection.id, executionTarget: { serverId, machineId: machine.id },
        owner: { pluginId: 'acme.images', localId: 'image' }, mediaKind: 'image', mimeType: 'image/png',
        name, sizeBytes: options.composerInspection.sizeBytes ?? bytes.byteLength, sha256: manifestHash.slice('sha256:'.length),
    }) : null;
    function preparePublication() {
        const transferId = `workspace-download-${++transferCount}`;
        const encodedTransferId = encodeBase64(new TextEncoder().encode(transferId), 'base64url');
        publications.set(encodedTransferId, transferId);
        return { transferId, name, manifestHash, sizeBytes: advertisedSizeBytes, expiresAt: Date.now() + 60_000,
            endpointCandidates: (options.downloadEndpointPorts ?? [46001]).map(port => ({ kind: 'http' as const,
                url: `http://127.0.0.1:${port}/machine-transfers/direct/${encodedTransferId}`,
                authorizationToken: 'prepared-file-token', expiresAt: Date.now() + 60_000 })) };
    }
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    async function preparedResponse(path: string, recipientPublicKeyBase64: string, body?: unknown): Promise<Response> {
        const importMatch = /^\/machine-transfers\/direct\/imports\/([^/]+)\/(chunks\/(0|[1-9]\d*)|finalize|abort)$/.exec(path);
        if (importMatch) {
            const upload = uploads.find(candidate => candidate.uploadId === importMatch[1]);
            const recipient = importRecipients.get(importMatch[1]!);
            if (!upload || !recipient) throw new Error(`Unknown prepared import: ${path}`);
            if (importMatch[2] === 'abort') {
                upload.aborted = true;
                return json({ success: true, aborted: true });
            }
            if (importMatch[2] === 'finalize') {
                upload.finalizeAttempts += 1;
                const failure = nextUploadFinalizeResponse;
                nextUploadFinalizeResponse = null;
                if (failure) return json(failure.body, failure.status);
                if (upload.aborted || upload.bytes.byteLength !== upload.input.source.sizeBytes) {
                    return json({ success: false, error: 'Upload size or custody mismatch' }, 409);
                }
                const hasher = createTransferManifestHasher();
                hasher.update(upload.bytes);
                upload.finalized = true;
                return json({ success: true, finalized: { success: true, path: upload.input.path,
                    sizeBytes: upload.bytes.byteLength }, sha256: hasher.digestManifestHash().slice('sha256:'.length) });
            }
            const deferred = deferredUploadChunk;
            deferredUploadChunk = null;
            if (deferred) { deferred.enter(); await deferred.wait; }
            try {
                if (upload.aborted) return json({ success: false, error: 'Upload is no longer available' }, 404);
                if (!body || typeof body !== 'object' || !('payloadBase64' in body)
                    || typeof body.payloadBase64 !== 'string' || !('encryptedDataKeyEnvelopeBase64' in body)
                    || typeof body.encryptedDataKeyEnvelopeBase64 !== 'string') throw new Error('Invalid encrypted import chunk');
                const chunk = await decryptEncryptedTransferChunkEnvelope({ transferId: upload.uploadId,
                    sequence: Number(importMatch[3]), payloadBase64: body.payloadBase64,
                    encryptedDataKeyEnvelopeBase64: body.encryptedDataKeyEnvelopeBase64,
                    recipientSecretKeySeed: recipient.recipientSecretKeySeed });
                const combined = new Uint8Array(upload.bytes.byteLength + chunk.byteLength);
                combined.set(upload.bytes);
                combined.set(chunk, upload.bytes.byteLength);
                upload.bytes = combined;
                return json({ success: true });
            } finally { deferred?.settle(); }
        }
        const match = /^\/machine-transfers\/direct\/([^/]+)\/(open|chunks\/0|complete)$/.exec(path);
        if (!match || !publications.has(match[1]!)) throw new Error(`Unexpected prepared transfer path: ${path}`);
        const transferId = publications.get(match[1]!)!;
        if (match[2] === 'open') return json({ transferId, manifestHash, totalChunks: 1, sizeBytes: advertisedSizeBytes });
        if (match[2] === 'complete') {
            if (!body || typeof body !== 'object' || !('success' in body) || body.success !== false) options.onCompleted?.();
            return json({ success: true });
        }
        const deferred = deferredChunk;
        deferredChunk = null;
        if (deferred) { deferred.enter(); await deferred.wait; }
        try {
            if (failChunk) { failChunk = false; return json({ error: 'read_failed' }, 500); }
            const envelope = await createEncryptedTransferChunkEnvelope({ transferId, sequence: 0, payload: bytes, recipientPublicKeyBase64 });
            return json({ transferId, kind: 'chunk', sequence: 0, ...envelope });
        } finally { deferred?.settle(); }
    }
    // Fault injection stays at the actual HTTP response boundary, after the
    // real publication/encryption producer, for both native and Socket carriers.
    async function respondPrepared(path: string, recipientPublicKeyBase64: string, body?: unknown, signal?: AbortSignal | null) {
        const response = await preparedResponse(path, recipientPublicKeyBase64, body);
        return options.preparedHttpResponse ? await options.preparedHttpResponse({ path, signal }, response) : response;
    }
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
            if (method === RPC_METHODS.DAEMON_PLUGIN_ACTION_SCHEMAS_READ && options.downloadActionInputSchema) {
                return { ok: true, inputSchema: options.downloadActionInputSchema };
            }
            if (method === RPC_METHODS.STAT_FILE) return statResponse;
            if (method === 'daemon.filesystem.upload') {
                const envelope = TargetedActionRpcRequestV1Schema.parse(payload);
                if (envelope.target.kind !== 'machine' || envelope.target.machineId !== machineId) throw new Error('Wrong upload Machine target');
                const input = FilesystemUploadInputSchema.parse(envelope.input);
                const deferred = deferredUploadPreparation;
                deferredUploadPreparation = null;
                if (deferred) { deferred.enter(); await deferred.wait; }
                try {
                    const uploadId = `workspace-upload-${uploads.length + 1}`;
                    const recipient = createTransferRecipientKeyPair();
                    importRecipients.set(uploadId, recipient);
                    uploads.push({ uploadId, input, bytes: new Uint8Array(), finalized: false, aborted: false, finalizeAttempts: 0 });
                    return FilesystemUploadOutputSchema.parse({ success: true, status: 'accepted',
                        operationId: `workspace-upload-operation-${uploads.length}`, sourceId: input.source.sourceId,
                        prepared: { uploadId, destDisplayPath: input.path, expectedSizeBytes: input.source.sizeBytes,
                            chunkSizeBytes: 64 * 1024, recipientPublicKeyBase64: recipient.recipientPublicKeyBase64,
                            expiresAt: Date.now() + 60_000,
                            endpointCandidates: [{ kind: 'http', url: `http://127.0.0.1:46001/machine-transfers/direct/imports/${uploadId}`,
                                expiresAt: Date.now() + 60_000 }] } });
                } finally { deferred?.settle(); }
            }
            if (method === 'daemon.filesystem.download') {
                const envelope = TargetedActionRpcRequestV1Schema.parse(payload);
                if (envelope.target.kind !== 'machine' || envelope.target.machineId !== machineId) throw new Error('Wrong download Machine target');
                const input = FilesystemDownloadInputSchema.parse(envelope.input);
                const deferred = deferredDownloadPreparation;
                deferredDownloadPreparation = null;
                if (deferred) { deferred.enter(); await deferred.wait; }
                try {
                    const prepared = preparePublication();
                    return { success: true, status: 'accepted', operationId: `workspace-download-operation-${transferCount}`,
                        destinationId: input.destination.destinationId,
                        prepared };
                } finally { deferred?.settle(); }
            }
            if (method === RPC_METHODS.DAEMON_DIRECT_TRANSFER_EXPORT_PREPARE && composerHandle) {
                if (!payload || typeof payload !== 'object' || !('t' in payload)
                    || payload.t !== 'composer_media_stage_inspect_v1' || !('handle' in payload)
                    || !('offset' in payload) || !('maxBytes' in payload)) throw new Error('Unexpected Composer export request');
                const handle = ComposerContentHandleV1Schema.parse(payload.handle);
                ComposerContentInspectRequestV1Schema.parse({ offset: payload.offset, maxBytes: payload.maxBytes });
                if (JSON.stringify(handle) !== JSON.stringify(composerHandle)) throw new Error('Wrong Composer stage custody');
                return { success: true, ...preparePublication() };
            }
            if (method === RPC_METHODS.DAEMON_DIRECT_TRANSFER_EXPORT_RELEASE && composerHandle) {
                return { success: true };
            }
            if ([RPC_METHODS.DAEMON_TRANSFER_DOWNLOAD_INIT, RPC_METHODS.DAEMON_TRANSFER_DOWNLOAD_CHUNK,
                RPC_METHODS.DAEMON_TRANSFER_DOWNLOAD_FINALIZE, RPC_METHODS.DAEMON_TRANSFER_DOWNLOAD_ABORT,
                RPC_METHODS.DAEMON_TRANSFER_UPLOAD_CHUNK, RPC_METHODS.DAEMON_TRANSFER_UPLOAD_FINALIZE,
                RPC_METHODS.DAEMON_TRANSFER_UPLOAD_ABORT].some(phase => phase === method)) {
                const request = PreparedTransferRpcRequestV1Schema.parse(payload);
                if (resolvePreparedTransferRpcPhaseV1(request.path, request.httpMethod, request.body) !== method
                    || (!request.path.startsWith('/machine-transfers/direct/imports/')
                        && request.authorizationToken !== 'prepared-file-token')) throw new Error('Wrong prepared transfer capability or phase');
                const response = await respondPrepared(request.path, request.recipientPublicKeyBase64 ?? '', request.body);
                return PreparedTransferRpcResponseV1Schema.parse({ status: response.status,
                    contentType: 'application/json', body: await response.text() });
            }
            throw new Error(`Unexpected machine RPC: ${method}`);
        },
    };
    const actionBoundaries = await Promise.all((['daemon.filesystem.upload', 'daemon.filesystem.download'] as const).map(actionId =>
        createExternalActionAccountHttpBoundary({ serverUrl: 'https://workspace-download.example.test',
            serverIdentityId: 'srv_workspace_download', accountId, machineId: machine.id, actionId, tokenEpoch: 0,
            execute: (input, { target }) => owner.machineRPC(machine.id, actionId, createTargetedActionRpcRequestV1(input, target)),
        })));
    const admittedMachineRow = { ...machineRow, installationPublicKey: actionBoundaries[0]!.machine.installationPublicKey };
    homes.answer(serverId, `/v1/machines/${machine.id}`, { body: { machine: admittedMachineRow } });
    homes.answer(serverId, '/v1/machines', { body: [admittedMachineRow] });
    homes.answer(serverId, '/v1/machines?includeRevoked=true', { body: [admittedMachineRow] });
    installed.current = owner;
    const request: RuntimeFetch = async (input, init) => {
        const url = new URL(String(input));
        requests.push({ method: (init?.method ?? 'GET').toUpperCase(), url: url.toString(), signal: init?.signal });
        if (url.pathname.startsWith('/v1/actions/')) {
            for (const boundary of actionBoundaries) {
                const response = await boundary.handle(url, init);
                if (response) return response;
            }
        }
        if (url.pathname === '/v1/machines/peer/mediation/route-grants') {
            const request = DirectRouteGrantRequestV2Schema.parse(JSON.parse(String(init?.body)));
            const issuedAt = Date.now();
            const grant = SignedDirectRouteGrantV2Schema.parse({
                payload: { v: 2, grantId: `workspace-download-grant-${nativeTunnelStarts.length}`, accountId, machineId: request.machineId, flowKind: request.flowKind, routeKind: request.routeKind, scope: request.scope, iat: issuedAt, exp: issuedAt + request.ttlMs, aud: 'happier-daemon-route-grant', endpointFingerprint: request.endpointFingerprint, proofKind: 'ephemeral_ed25519', ephemeralPublicKeyBase64Url: request.ephemeralPublicKeyBase64Url, iroh: request.iroh },
                signature: { keyId: 'workspace-download-key', alg: 'Ed25519', valueBase64Url: btoa(String.fromCharCode(...new Uint8Array(64).fill(4))).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '') },
            });
            return json({ ok: true, grant });
        }
        if (!url.pathname.startsWith('/machine-transfers/direct/')) {
            if (url.origin === 'https://workspace-download.example.test') return await homes.request(input, init);
            throw new Error(`Unexpected transfer HTTP: ${url}`);
        }
        return await respondPrepared(url.pathname, new Headers(init?.headers).get('x-happier-transfer-recipient-public-key') ?? '',
            typeof init?.body === 'string' && init.body.length > 0 ? JSON.parse(init.body) : undefined, init?.signal);
    };
    setRuntimeFetch(request);
    return {
        scope, composerHandle, request, requests, rpcRequests, nativeTunnelStarts, nativeTunnelStops, uploads,
        /** Models the provider's accepted publication after real client Action admission. */
        prepareDownloadReceipt(destinationId: string) {
            return { success: true as const, status: 'accepted' as const, operationId: 'provider-download', destinationId,
                prepared: preparePublication() };
        },
        switchAccount: async () => { await homes.switchAccount(serverId, 'replacement-download-account', { currentAccount: true }); },
        setStatResponse(response: WorkspaceStatFileResponse) { statResponse = response; },
        failNextChunk() { failChunk = true; },
        failNextUploadFinalize() {
            nextUploadFinalizeResponse = { status: 409, body: { success: false, error: 'Upload finalize failed' } };
        },
        interruptNextUploadFinalize() {
            nextUploadFinalizeResponse = { status: 502, body: { success: false, error: 'Upload finalize response interrupted' } };
        },
        deferNextDownloadPreparation() {
            let enter!: () => void;
            let release!: () => void;
            let settle!: () => void;
            const entered = new Promise<void>((resolve) => { enter = resolve; });
            const wait = new Promise<void>((resolve) => { release = resolve; });
            const settled = new Promise<void>((resolve) => { settle = resolve; });
            deferredDownloadPreparation = { enter, wait, settle };
            return { entered, release, settled };
        },
        deferNextUploadPreparation() {
            let enter!: () => void;
            let release!: () => void;
            let settle!: () => void;
            const entered = new Promise<void>((resolve) => { enter = resolve; });
            const wait = new Promise<void>((resolve) => { release = resolve; });
            const settled = new Promise<void>((resolve) => { settle = resolve; });
            deferredUploadPreparation = { enter, wait, settle };
            return { entered, release, settled };
        },
        requireNextUploadFinalizeRecovery() {
            nextUploadFinalizeResponse = { status: 500, body: { success: false,
                error: 'Finalize recovery is required', errorCode: 'TRANSFER_FINALIZE_RECOVERY_REQUIRED', keepSession: true } };
        },
        deferNextUploadChunk() {
            let enter!: () => void;
            let release!: () => void;
            let settle!: () => void;
            const entered = new Promise<void>((resolve) => { enter = resolve; });
            const wait = new Promise<void>((resolve) => { release = resolve; });
            const settled = new Promise<void>((resolve) => { settle = resolve; });
            deferredUploadChunk = { enter, wait, settle };
            return { entered, release, settled };
        },
        deferNextChunk() {
            let enter!: () => void;
            let release!: () => void;
            let settle!: () => void;
            const entered = new Promise<void>((resolve) => { enter = resolve; });
            const wait = new Promise<void>((resolve) => { release = resolve; });
            const settled = new Promise<void>((resolve) => { settle = resolve; });
            deferredChunk = { enter, wait, settle };
            return { entered, release, settled };
        },
        async reset() {
            if (installed.current === owner) installed.current = null;
            await import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedRpcSocketPool').then(({ serverScopedRpcSocketPool }) => serverScopedRpcSocketPool.stopAll());
            await homes.reset();
            resetRuntimeFetch();
            resetServerFeaturesClientForTests();
            storage.setState({ machines: previousState.machines, machineListByServerId: previousState.machineListByServerId });
        },
    };
}
