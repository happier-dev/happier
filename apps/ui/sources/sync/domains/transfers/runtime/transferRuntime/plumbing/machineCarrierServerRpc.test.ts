import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import 'fake-indexeddb/auto';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { FeaturesResponseSchema } from '@happier-dev/protocol/features/payload/featuresResponseSchema';
import { encodePlainMachineStoredContent, MACHINE_PLAIN_DATA_KEY_MARKER } from '@happier-dev/protocol/machines/machineStoredContent';
import { MachinePublishedDaemonStateV1Schema } from '@happier-dev/protocol/machines/machinePublishedContentV1';
import { FilesystemDownloadInputSchema, FilesystemUploadInputSchema } from '@happier-dev/protocol/actions/filesystemActionFamily';
import { createTargetedActionRpcRequestV1, TargetedActionRpcRequestV1Schema } from '@happier-dev/protocol/actions/actionRpcTransport';
import type { SocketRpcRequestPayload } from '@happier-dev/protocol/socketRpc';
import {
    PreparedTransferRpcRequestV1Schema,
    PreparedTransferRpcResponseV1Schema,
    resolvePreparedTransferRpcPhaseV1,
    type PreparedTransferRpcRequestV1,
} from '@happier-dev/protocol/machines/transfer/preparedTransferRpcV1';
import { createAccountTokenForTests, createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { configureConnectedServerSocketBoundary, installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { createMachineFixture, createPlainMachineRowFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { createDeferred } from '@/dev/testkit';
import { createExternalActionAccountHttpBoundary } from '@/dev/testkit/harness/externalActionAccountHttpBoundary';
import { parseBrowserIrohClientCommand, type BrowserIrohClientCommand, type BrowserIrohWorkerReply } from '@/sync/runtime/browserIroh/protocol';
import type { BrowserIrohMessagePort } from '@/sync/runtime/browserIroh/workerConnection';

// Only the physical Home network is replaced. Scoped RPC selection, its Account
// codec, prepared phase binding, byte encryption and both transfer drivers stay real.
vi.mock('socket.io-client', async (importOriginal) =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));
const hostPlatform = vi.hoisted(() => ({ os: 'web' }));
vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock({
    Platform: { get OS() { return hostPlatform.os; } },
}));
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock({ confirmResult: true }).module);

const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
const outgoing: SocketRpcRequestPayload[] = [];
let respond: (request: SocketRpcRequestPayload) => Promise<unknown>;
installDisconnectedServerSocketBoundary(socket => {
    configureConnectedServerSocketBoundary(socket);
    vi.spyOn(socket, 'timeout').mockReturnValue(socket);
    vi.spyOn(socket, 'emitWithAck').mockImplementation(async (event, payload: unknown) => {
        if (event !== 'rpc-call') return { ok: true };
        if (!payload || typeof payload !== 'object' || !('method' in payload) || typeof payload.method !== 'string') {
            throw new Error('Malformed test RPC');
        }
        const request: SocketRpcRequestPayload = { method: payload.method, params: 'params' in payload ? payload.params : undefined };
        outgoing.push(request);
        return await respond(request);
    });
});
// Import source wiring after boundary installation, outside the behavior hook.
await import('@/sync/syncEngine');

let serverId: string;
let connection: Awaited<ReturnType<typeof restoreServerAccountForTest>>;
let ownsBrowserEndpointBoundary = false;
const machineId = 'prepared-machine';
const expiresAt = () => Date.now() + 60_000;
const endpoint = (id: string) => `http://127.0.0.1:46001/machine-transfers/direct/${Buffer.from(id).toString('base64url')}`;
const importEndpoint = (id: string) => `http://127.0.0.1:46001/machine-transfers/direct/imports/${encodeURIComponent(id)}`;
const rpcResponse = (body: unknown, extra: Record<string, string> = {}) => PreparedTransferRpcResponseV1Schema.parse({
    status: 200, contentType: 'application/json', body: JSON.stringify(body), ...extra,
});

async function requester(operationId: string) {
    const { resolveMachineCarrierRoute } = await import('./machineCarrierHttpLease');
    const { captureActiveServerAccountScopeLifetime } = await import('@/sync/domains/scope/activeServerAccountScope');
    const accountLifetime = captureActiveServerAccountScopeLifetime();
    expect(accountLifetime?.isCurrent()).toBe(true);
    const route = await resolveMachineCarrierRoute(machineId, serverId);
    expect(route.kind).toBe('server_rpc');
    if (route.kind === 'unavailable') throw new Error(route.error);
    const carrier = await route.acquire({ operationId, accountLifetime: accountLifetime! });
    if (carrier.kind === 'native_http') throw new Error('Browser transfer must have a requester');
    return carrier.request;
}

function readPhase(request: SocketRpcRequestPayload): PreparedTransferRpcRequestV1 {
    const payload = PreparedTransferRpcRequestV1Schema.parse(request.params);
    expect(request.method).toBe(`${machineId}:${resolvePreparedTransferRpcPhaseV1(payload.path, payload.httpMethod, payload.body)}`);
    return payload;
}

/** SharedWorker is the OS boundary; the packaged client and acquisition stay real. */
function installUnavailableBrowserEndpointBoundary(options: Readonly<{ hold?: Promise<void>; refuseRelease?: boolean }> = {}) {
    ownsBrowserEndpointBoundary = true;
    const attempted = createDeferred<void>();
    const commands: BrowserIrohClientCommand[] = [];
    vi.stubGlobal('location', { origin: 'https://prepared-transfer.test' });
    vi.stubGlobal('SharedWorker', class UnavailableSharedWorker {
        onerror: ((event: unknown) => void) | null = null;
        readonly port: BrowserIrohMessagePort;
        constructor(scriptUrl: string) {
            expect(new URL(scriptUrl).pathname).toBe('/vendor/iroh/happier-iroh-worker.js');
            let receive: ((event: { data: unknown }) => void) | undefined;
            this.port = {
                addEventListener: (_type, listener) => { receive = listener; },
                postMessage: message => {
                    const command = parseBrowserIrohClientCommand(message);
                    if (!command) throw new Error('Malformed browser endpoint command');
                    commands.push(command);
                    if (command.kind === 'acquireLease') attempted.resolve();
                    void Promise.resolve(command.kind === 'acquireLease' ? options.hold : undefined).then(() => {
                        const reply: BrowserIrohWorkerReply = command.kind === 'acquireLease' && options.refuseRelease
                            ? { v: 1, kind: 'leaseAcquired', requestId: command.requestId, leaseId: 'held-browser-lease',
                                endpointId: 'b'.repeat(64), appliedRelayUrls: command.relayUrls }
                            : command.kind === 'releaseClient'
                            ? { v: 1, kind: 'released', requestId: command.requestId }
                            : { v: 1, kind: 'error', requestId: command.requestId,
                                code: 'endpoint_unavailable', message: command.kind === 'releaseLease'
                                    ? 'Shared endpoint lease release failed' : 'Browser endpoint failed to become ready' };
                        receive?.({ data: reply });
                    });
                },
            };
        }
    });
    return { attempted: attempted.promise, commands };
}

async function preferredBrowserRoute() {
    const { storage } = await import('@/sync/domains/state/storage');
    const current = storage.getState().machines[machineId]!;
    const { readMachineDaemonTransferState } = await import('../availability/machineDaemonTransferState');
    const declared = readMachineDaemonTransferState({ daemonState: current.daemonState });
    if (!declared) throw new Error('Expected the current finite transfer declaration');
    const daemonState = { ...current.daemonState, transfer: { ...declared, listenerClasses: {
        ...declared.listenerClasses, loopback_http: { enabled: true, configured: true, active: false },
    } } };
    const { MachineOperationProtocolCapabilitiesV1Schema } = await import('@happier-dev/protocol/machines/operationProtocolCapabilitiesV1');
    const operationProtocolCapabilities = MachineOperationProtocolCapabilitiesV1Schema.parse({
        irohMachineEndpoint: { protocolVersions: [1], endpointId: 'a'.repeat(64), relayUrls: ['https://relay.example.test'] },
    });
    const row = { ...createPlainMachineRowFixture({ id: machineId, accountId: 'account-a' }),
        daemonState: encodePlainMachineStoredContent(daemonState), operationProtocolCapabilities, operationProtocolCapabilitiesRevision: 1 };
    homes.answer(serverId, `/v1/machines/${machineId}`, { body: { machine: row } });
    homes.answer(serverId, '/v1/machines', { body: [row] });
    homes.answer(serverId, '/v1/machines?includeRevoked=true', { body: [row] });
    homes.answer(serverId, '/v1/features', { body: FeaturesResponseSchema.parse({ features: {
        machines: { enabled: true, transfer: { enabled: true, directPeer: { enabled: true } }, peerMediation: { enabled: true } },
    }, capabilities: {} }) });
    const { getReadyServerFeatures } = await import('@/sync/api/capabilities/getReadyServerFeatures');
    await getReadyServerFeatures({ serverId, force: true });
    storage.getState().applyMachines([{ ...current, daemonState, operationProtocolCapabilities, operationProtocolCapabilitiesRevision: 1 }]);
    const { resolveMachineCarrierRoute } = await import('./machineCarrierHttpLease');
    const route = await resolveMachineCarrierRoute(machineId, serverId);
    expect(route).toMatchObject({ kind: 'iroh_peer', carrierKind: 'browser_stream' });
    if (route.kind === 'unavailable') throw new Error(route.error);
    const { captureActiveServerAccountScopeLifetime } = await import('@/sync/domains/scope/activeServerAccountScope');
    const accountLifetime = captureActiveServerAccountScopeLifetime();
    if (!accountLifetime) throw new Error('Expected a restored Account lifetime');
    return { route, accountLifetime };
}

beforeEach(async context => {
    hostPlatform.os = context.task.name.includes('native_home') ? 'ios' : 'web';
    ownsBrowserEndpointBoundary = false;
    vi.stubGlobal('SharedWorker', class SharedWorker {});
    installHomeGovernanceBoundaries(homes);
    const { loadSyncSingletonForTests } = await import('@/dev/testkit/harness/syncSingletonLoader');
    await loadSyncSingletonForTests();
    serverId = await homes.addHome({ name: 'Prepared transfer Home', serverUrl: 'https://prepared-transfer.test', accountId: 'account-a',
        serverIdentityId: 'srv_prepared_transfer', currentAccount: true });
    homes.answer(serverId, '/v1/features', { body: FeaturesResponseSchema.parse({ features: {
        machines: { enabled: true, transfer: { enabled: true } },
    }, capabilities: {} }) });
    const daemonState = MachinePublishedDaemonStateV1Schema.parse({ status: 'running', transfer: { supported: { import: true, export: true }, listenerClasses: {
        loopback_http: { enabled: false, configured: false, active: false },
        tailscale_serve_https: { enabled: false, configured: false, active: false },
    }, lifecycle: { mode: 'lazy_idle_shutdown', version: 1 } } });
    const row = { ...createPlainMachineRowFixture({ id: machineId, accountId: 'account-a' }),
        daemonState: encodePlainMachineStoredContent(daemonState) };
    homes.answer(serverId, `/v1/machines/${machineId}`, { body: { machine: row } });
    homes.answer(serverId, '/v1/machines', { body: [row] });
    homes.answer(serverId, '/v1/machines?includeRevoked=true', { body: [row] });
    connection = await restoreServerAccountForTest({ serverUrl: 'https://prepared-transfer.test', accountId: 'account-a', serverIdentityId: 'srv_prepared_transfer',
        credentials: { token: createAccountTokenForTests('account-a', { currentAccount: true }) }, request: homes.request });
    const { storage } = await import('@/sync/domains/state/storage');
    storage.getState().applyMachines([createMachineFixture({ id: machineId, storageMode: 'plain', dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER,
        daemonState })]);
    const { getReadyServerFeatures } = await import('@/sync/api/capabilities/getReadyServerFeatures');
    const features = await getReadyServerFeatures({ serverId, force: true });
    expect(features?.features.machines.transfer.enabled).toBe(true);
    outgoing.length = 0;
    respond = async () => { throw new Error('Unexpected prepared transfer request'); };
});

afterEach(async () => {
    const { userRequestLeaseOwner } = await import('@/sync/runtime/connectivity/userRequestLease');
    userRequestLeaseOwner.cancelDeferredRoutineTeardown();
    const { setServerReachabilityNetworkAllowed } = await import('@/sync/runtime/connectivity/serverReachabilitySupervisorPool');
    setServerReachabilityNetworkAllowed(true);
    const { serverScopedRpcSocketPool } = await import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedRpcSocketPool');
    const { resetScopedMachineTransportCacheForTests } = await import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedRpcPool');
    serverScopedRpcSocketPool.resetForTests();
    resetScopedMachineTransportCacheForTests();
    // The replacement Account in the retirement case is also this fixture's
    // runtime; the original connection handle deliberately will not retire it.
    const { disconnectActiveServerConnection } = await import('@/sync/runtime/orchestration/connectionManager');
    await disconnectActiveServerConnection();
    await connection?.dispose();
    await homes.reset();
    const { resolvePackagedBrowserIrohEndpointClient, resetPackagedBrowserIrohEndpointClientForTests } = await import('@/sync/runtime/browserIroh/endpointClient');
    if (ownsBrowserEndpointBoundary) {
        const client = resolvePackagedBrowserIrohEndpointClient();
        await client.releaseAll();
        client.close();
    }
    resetPackagedBrowserIrohEndpointClientForTests();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
});

describe('prepared transfer Home RPC carrier', () => {
    it('projects causal OS codes without reading transfer prose or retaining cyclic causes', async () => {
        const { readPluginSurfaceTransferFailureCodes } = await import('@/components/plugins/shared/pluginSurfaceDiagnosticLog');
        const prose = vi.fn(() => '/private/transfer token=private-value');
        const cause = { code: 'EADDRINUSE', cause: {} };
        const failure = { errorCode: 'machine_carrier_transport_failed', cause };
        cause.cause = failure;
        Object.defineProperty(cause, 'message', { get: prose });
        Object.defineProperty(failure, 'stack', { get: prose });
        expect(readPluginSurfaceTransferFailureCodes(failure)).toEqual({
            outcomeCode: 'machine_carrier_transport_failed', osCode: 'EADDRINUSE',
        });
        expect(prose).not.toHaveBeenCalled();
    });

    it.each([
        { code: 'EADDRINUSE', outcomeCode: null, osCode: 'EADDRINUSE' },
        { code: 'machine_carrier_transport_failed', outcomeCode: 'machine_carrier_transport_failed', osCode: null },
        { code: '/private/transfer token=private-value', outcomeCode: null, osCode: null },
    ])('retains only typed Artifact transfer failure codes at the diagnostic sink ($code)', async ({ code, outcomeCode, osCode }) => {
        const { createPluginArtifactDaemonSource } = await import('@/sync/domains/plugins/availability/artifactDaemonSource');
        const { log } = await import('@/log');
        // The diagnostic sink and Home RPC are physical boundaries; all transfer/Artifact owners stay real.
        const sink = vi.spyOn(log, 'log').mockImplementation(() => {});
        respond = async request => {
            expect(request.method).toBe(`${machineId}:${RPC_METHODS.DAEMON_DIRECT_TRANSFER_EXPORT_PREPARE}`);
            return { ok: true, result: { success: false, code, error: '/private/transfer token=private-value body=private-body' } };
        };
        const digest = `sha256:${'c'.repeat(64)}` as const;
        const source = createPluginArtifactDaemonSource({ family: 'reactNative', transport: { machineId, serverId } });
        await expect(source.fetch({ artifact: { pluginId: 'diagnostic.plugin', contributionId: 'panel', artifactId: 'panel',
            tier: 'reactNative', platform: 'web', digest, hostUiApiRange: '^1.0.0', releaseVersion: '1.0.0' } }))
            .rejects.toMatchObject({ code: 'artifact_bytes_fetch_failed' });
        const failures = sink.mock.calls.map(([message]) => message)
            .filter(message => message.includes('"artifactFailure":"artifact_bytes_fetch_failed"'));
        expect(failures).toHaveLength(1);
        expect(JSON.parse(failures[0]!.replace(/^\[plugin-ui-host-api\] /, ''))).toEqual({
            pluginId: null, contributionId: null, surfaceId: null,
            diagnostic: { artifactFailure: 'artifact_bytes_fetch_failed', artifactDigest: digest,
                artifactFamily: 'reactNative', transferFailure: { outcomeCode, osCode } },
        });
        expect(failures[0]).not.toMatch(/private|token|body=/);
        expect(outgoing.filter(request => request.method.endsWith(RPC_METHODS.DAEMON_DIRECT_TRANSFER_EXPORT_PREPARE))).toHaveLength(1);
    });

    it.each([
        { artifactFamily: 'hostedWeb', payloadKind: 'valid' },
        { artifactFamily: 'reactNative', payloadKind: 'valid' },
        { artifactFamily: 'hostedWeb', payloadKind: 'invalid_json' },
        { artifactFamily: 'hostedWeb', payloadKind: 'invalid_schema' },
        { artifactFamily: 'hostedWeb', payloadKind: 'cancelled' },
        { artifactFamily: 'reactNative', payloadKind: 'native_home' },
    ] as const)('reads a multi-megabyte Artifact or rejects invalid bytes through bounded encrypted Home phases ($artifactFamily/$payloadKind)', async ({ artifactFamily, payloadKind }) => {
        const { DaemonPluginUiArtifactBytesReadResponseSchema } = await import('@happier-dev/protocol/daemon/contributionRegistryProjection');
        const { createPluginArtifactDaemonSource } = await import('@/sync/domains/plugins/availability/artifactDaemonSource');
        const { createEncryptedTransferChunkEnvelope } = await import('./transferChunkEncryption');
        const { createTransferManifestHasher } = await import('./transferManifestHasher');
        const expectsFiles = payloadKind === 'valid' || payloadKind === 'native_home';
        const fileBytes = new Uint8Array(expectsFiles || payloadKind === 'cancelled' ? 4 * 1024 * 1024 : 1).fill(97);
        // The platform boundary was set before restoring Account custody.
        // No endpoint/native Iroh module is available in this Home-only case.
        const digest = `sha256:${'a'.repeat(64)}` as const;
        const artifact = { pluginId: 'large.plugin', contributionId: 'panel', artifactId: 'panel',
            tier: artifactFamily, platform: 'web' as const, digest, hostUiApiRange: '^1.0.0', releaseVersion: '1.0.0' };
        const response = DaemonPluginUiArtifactBytesReadResponseSchema.parse({ ok: true, artifactFamily,
            cacheIdentity: { artifactDigest: digest }, artifact: artifactFamily === 'hostedWeb'
                ? { artifactKind: 'hostedWebAsset', digest, byteSize: fileBytes.length }
                : { artifactKind: 'reactNativeBundle', digest, format: 'plainJs', byteSize: fileBytes.length },
            files: [{ relativePath: 'panel.js', digest, byteSize: fileBytes.length, bytesBase64: Buffer.from(fileBytes).toString('base64') }] });
        const payload = new TextEncoder().encode(payloadKind === 'invalid_json' ? '{invalid'
            : JSON.stringify(payloadKind === 'invalid_schema' ? { ok: true, unexpected: true } : response));
        const manifest = createTransferManifestHasher(); manifest.update(payload);
        const manifestHash = manifest.digestManifestHash();
        const transferId = `plugin-ui-${artifactFamily}`;
        // This is the incumbent producer's default plaintext chunk size. No Artifact-specific frame budget.
        const chunkBytes = 256 * 1024;
        const controller = new AbortController();
        const preferredBoundary = artifactFamily === 'reactNative' && payloadKind === 'valid'
            ? installUnavailableBrowserEndpointBoundary() : null;
        if (preferredBoundary) await preferredBrowserRoute();
        let recipientPublicKeyBase64 = '';
        const phaseBodies: number[] = [];
        respond = async request => {
            if (request.method === `${machineId}:${RPC_METHODS.DAEMON_DIRECT_TRANSFER_EXPORT_PREPARE}`) {
                expect(request.params).toEqual({ t: 'plugin_ui_artifact_download_v1', request: {
                    artifactFamily, machineId, cacheIdentity: { artifactDigest: digest },
                } });
                return { ok: true, result: { success: true, transferId, name: 'plugin-ui-artifact.json',
                    sizeBytes: payload.length, manifestHash, expiresAt: expiresAt(),
                    endpointCandidates: [{ kind: 'http', url: endpoint(transferId), authorizationToken: 'artifact-token', expiresAt: expiresAt() }] } };
            }
            if (request.method === `${machineId}:${RPC_METHODS.DAEMON_DIRECT_TRANSFER_EXPORT_RELEASE}`) return { ok: true, result: { success: true } };
            const phase = readPhase(request);
            expect(phase.authorizationToken).toBe('artifact-token');
            let body: unknown;
            if (phase.path.endsWith('/open')) {
                recipientPublicKeyBase64 = phase.recipientPublicKeyBase64!;
                body = { transferId, totalChunks: Math.ceil(payload.length / chunkBytes), sizeBytes: payload.length, manifestHash };
            } else if (phase.path.includes('/chunks/')) {
                const sequence = Number(phase.path.split('/').at(-1));
                body = { transferId, kind: 'chunk', sequence, ...await createEncryptedTransferChunkEnvelope({ transferId,
                    sequence, payload: payload.subarray(sequence * chunkBytes, (sequence + 1) * chunkBytes), recipientPublicKeyBase64 }) };
                phaseBodies.push(new TextEncoder().encode(JSON.stringify(body)).byteLength);
                if (payloadKind === 'cancelled') controller.abort();
            } else {
                expect(phase.body).toMatchObject({ success: payloadKind !== 'cancelled' });
                body = { success: true };
            }
            return { ok: true, result: rpcResponse(body) };
        };
        const source = createPluginArtifactDaemonSource({ family: artifactFamily, transport: { machineId, serverId } });
        if (expectsFiles) {
            const downloaded = await source.fetch({ artifact, signal: controller.signal });
            if (!downloaded || 'artifactGraph' in downloaded) throw new Error('expected the daemon source to return a file set');
            const file = downloaded.get('panel.js');
            expect(file?.byteLength).toBe(fileBytes.length);
            expect(Buffer.compare(Buffer.from(file!), Buffer.from(fileBytes))).toBe(0);
            expect(payload.length).toBeGreaterThan(5_000_000);
        } else if (payloadKind === 'cancelled') {
            await expect(source.fetch({ artifact, signal: controller.signal })).resolves.toBeNull();
        } else {
            await expect(source.fetch({ artifact, signal: controller.signal })).rejects.toMatchObject({ code: 'artifact_bytes_response_invalid' });
        }
        expect(phaseBodies).toHaveLength(payloadKind === 'cancelled' ? 1 : Math.ceil(payload.length / chunkBytes));
        expect(Math.max(...phaseBodies)).toBeLessThan(1024 * 1024);
        expect(outgoing.filter(request => request.method.endsWith(RPC_METHODS.DAEMON_DIRECT_TRANSFER_EXPORT_RELEASE))).toHaveLength(1);
        if (preferredBoundary) expect(preferredBoundary.commands.map(command => command.kind)).toEqual(['acquireLease']);
        expect(outgoing.some(request => request.method.endsWith(RPC_METHODS.DAEMON_PLUGIN_UI_ARTIFACT_BYTES_READ))).toBe(false);
    });

    it('uses Home when the preferred browser endpoint fails before any transfer request', async () => {
        const boundary = installUnavailableBrowserEndpointBoundary();
        const { route, accountLifetime } = await preferredBrowserRoute();
        respond = async request => { readPhase(request); return { ok: true, result: rpcResponse({ success: true }) }; };
        const carrier = await route.acquire({ operationId: 'readiness-import', accountLifetime });
        expect(carrier.kind).toBe('server_rpc');
        expect(boundary.commands.map(command => command.kind)).toEqual(['acquireLease']);
        if (carrier.kind === 'native_http') throw new Error('Expected the Home requester');
        expect(await (await carrier.request(`${importEndpoint('readiness-import')}/finalize`, { method: 'POST' })).json()).toEqual({ success: true });
        expect(outgoing).toHaveLength(1);
        await carrier.release();
    });

    it.each(['cancelled', 'Account retired'] as const)('refuses fallback when acquisition fails after the operation is %s', async retirement => {
        const hold = createDeferred<void>();
        const boundary = installUnavailableBrowserEndpointBoundary({ hold: hold.promise });
        const { route, accountLifetime } = await preferredBrowserRoute();
        const controller = new AbortController();
        const pending = route.acquire({ operationId: 'retired-readiness-import', accountLifetime, signal: controller.signal });
        const refused = expect(pending).rejects.toBeInstanceOf(Error);
        await boundary.attempted;
        if (retirement === 'cancelled') controller.abort();
        else {
            await homes.switchAccount(serverId, 'replacement-account');
            const { switchConnectionToActiveServer } = await import('@/sync/runtime/orchestration/connectionManager');
            await switchConnectionToActiveServer();
            expect(accountLifetime.isCurrent()).toBe(false);
        }
        hold.resolve();
        await refused;
        expect(outgoing).toEqual([]);
        expect(boundary.commands.map(command => command.kind)).toEqual(['acquireLease']);
    });

    it('refuses Home fallback when a failed acquisition cannot release its shared endpoint custody', async () => {
        const boundary = installUnavailableBrowserEndpointBoundary({ refuseRelease: true });
        const { route, accountLifetime } = await preferredBrowserRoute();
        homes.answer(serverId, '/v1/machines/peer/mediation/route-grants', { status: 403, body: { ok: false, reasonCode: 'grant_missing' } });
        await expect(route.acquire({ operationId: 'unreleased-readiness-import', accountLifetime })).rejects.toBeInstanceOf(Error);
        expect(boundary.commands.map(command => command.kind)).toEqual(['acquireLease', 'releaseLease']);
        expect(outgoing).toEqual([]);
    });

    it.each(['preview', 'download', 'hidden-download', 'hidden-preview', 'cold-preview', 'opening-preview'] as const)('reads a workspace %s through real Action admission and strict Home transfer framing', async surface => {
        const hidden = surface.startsWith('hidden-');
        const downloading = surface === 'download' || surface === 'hidden-download';
        const { userRequestLeaseOwner } = await import('@/sync/runtime/connectivity/userRequestLease');
        const { setServerReachabilityNetworkAllowed } = await import('@/sync/runtime/connectivity/serverReachabilitySupervisorPool');
        const teardown = vi.fn(() => setServerReachabilityNetworkAllowed(false));
        let teardownDeferred: boolean | undefined;
        const bytes = new Uint8Array([0, 255, 128, 10]);
        const transferId = 'export / unicode-λ';
        const manifestHash = `sha256:${Buffer.from(await crypto.subtle.digest('SHA-256', bytes.buffer)).toString('hex')}`;
        let closed = false;
        let recipientPublicKeyBase64 = '';
        const { createEncryptedTransferChunkEnvelope } = await import('./transferChunkEncryption');
        respond = async request => {
            if (request.method === `${machineId}:${RPC_METHODS.STAT_FILE}`) {
                return { ok: true, result: { success: true, exists: true, kind: 'file', sizeBytes: bytes.length } };
            }
            if (request.method === `${machineId}:daemon.filesystem.download`) {
                // Exact daemon ingress schema, including the version and target;
                // inspecting only .input previously hid the live framing defect.
                const envelope = TargetedActionRpcRequestV1Schema.parse(request.params);
                expect(envelope.target).toEqual({ kind: 'machine', machineId });
                const input = FilesystemDownloadInputSchema.parse(envelope.input);
                expect(input).toMatchObject({ rootPath: '/repo', path: '/repo/binary' });
                return { ok: true, result: { success: true, status: 'accepted', operationId: 'download-operation', destinationId: input.destination.destinationId,
                    prepared: { transferId, name: 'binary', sizeBytes: bytes.length, manifestHash, expiresAt: expiresAt(),
                        endpointCandidates: [{ kind: 'http', url: endpoint(transferId), authorizationToken: 'prepared-export-token', expiresAt: expiresAt() }] } } };
            }
            const phase = readPhase(request);
            expect(phase.authorizationToken).toBe('prepared-export-token');
            let body: unknown;
            if (phase.path.endsWith('/open')) {
                recipientPublicKeyBase64 = phase.recipientPublicKeyBase64!;
                body = { transferId, totalChunks: 1, sizeBytes: bytes.length, manifestHash };
            } else if (phase.path.endsWith('/chunks/0')) {
                body = { transferId, kind: 'chunk', sequence: 0, ...await createEncryptedTransferChunkEnvelope({
                    transferId, sequence: 0, payload: bytes, recipientPublicKeyBase64,
                }) };
            } else {
                if (downloading) expect(closed).toBe(true);
                expect(phase.body).toMatchObject({ success: true, sizeBytes: bytes.length, manifestHash });
                body = { success: true };
            }
            return { ok: true, result: rpcResponse(body) };
        };
        // Filesystem Actions are admitted through the Account external-Action HTTP carrier; the physical prepared-transfer
        // phases then travel over the Home RPC carrier below.
        const actionId = 'daemon.filesystem.download' as const;
        const admittedActions: string[] = [];
        const external = await createExternalActionAccountHttpBoundary({ serverUrl: 'https://prepared-transfer.test',
            serverIdentityId: 'srv_prepared_transfer', accountId: 'account-a', machineId, actionId, tokenEpoch: 0,
            execute: async (input, context) => {
                admittedActions.push(actionId);
                const result = await respond({ method: `${machineId}:${actionId}`,
                    params: createTargetedActionRpcRequestV1(input, context.target) } as SocketRpcRequestPayload);
                return (result as { result: unknown }).result;
            } });
        const preparedRow = { ...external.machine, daemonState: encodePlainMachineStoredContent(MachinePublishedDaemonStateV1Schema.parse({
            status: 'running', transfer: { supported: { import: true, export: true }, listenerClasses: {
                loopback_http: { enabled: false, configured: false, active: false },
                tailscale_serve_https: { enabled: false, configured: false, active: false },
            }, lifecycle: { mode: 'lazy_idle_shutdown', version: 1 } } })) };
        homes.answer(serverId, `/v1/machines/${machineId}`, { body: { machine: preparedRow } });
        homes.answer(serverId, '/v1/machines', { body: [preparedRow] });
        homes.answer(serverId, '/v1/machines?includeRevoked=true', { body: [preparedRow] });
        for (const path of [`/v1/actions/${actionId}/execution-authorization`, `/v1/actions/${actionId}`]) {
            homes.answer(serverId, path, { select: async (_input, request) => {
                const response = await external.handle(new URL(request.url), request.init);
                if (!response) throw new Error(`Unhandled external Action boundary: ${request.url}`);
                const body = await response.json();
                if (hidden && new URL(request.url).pathname === `/v1/actions/${actionId}`) {
                    // The real visibility owner defers this exact connectivity teardown.
                    teardownDeferred = userRequestLeaseOwner.deferRoutineTeardown(teardown);
                }
                return { status: response.status, body };
            } });
        }
        const received: number[] = [];
        const target = { machineId, serverId, rootPath: '/repo' };
        if (surface === 'cold-preview') {
            const { storage } = await import('@/sync/domains/state/storage');
            storage.setState({ machines: {}, machineListByServerId: {}, machineRecordsByServerId: {}, machineListStatusByServerId: {} });
        }
        if (surface === 'opening-preview') {
            const { storage } = await import('@/sync/domains/state/storage');
            const current = storage.getState().machines[machineId]!;
            storage.getState().applyMachines([{ ...current, daemonState: null, daemonStateVersion: 0,
                keyBasis: { dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER,
                    metadataVersion: current.metadataVersion, daemonStateVersion: current.daemonStateVersion } }]);
        }
        const { resolveMachineCarrierRoute } = await import('./machineCarrierHttpLease');
        expect(await resolveMachineCarrierRoute(machineId, serverId)).toMatchObject({ kind: 'server_rpc' });
        if (!downloading) {
            vi.stubEnv('EXPO_PUBLIC_HAPPIER_SESSION_FILE_INLINE_MAX_BYTES', '1');
            const { workspaceReadFile } = await import('@/sync/ops/workspaceFileSystem/fileReadWrite');
            // This file exceeds the configured inline ceiling, independently
            // of the caller's preview budget, and must use prepared delivery.
            expect(await workspaceReadFile(target, 'binary', { maxBytes: 1024 * 1024 }))
                .toEqual({ success: true, content: Buffer.from(bytes).toString('base64') });
        } else {
            const { downloadDaemonWorkspaceFileToDestination } = await import('../families/workspaceFileTransfers');
            expect(await downloadDaemonWorkspaceFileToDestination({ ...target,
                request: { path: 'binary', asZip: false },
                destination: { writeBytes: async chunk => { received.push(...chunk); }, close: async () => { closed = true; }, cleanup: async () => {} },
            })).toEqual({ ok: true, name: 'binary', sizeBytes: bytes.length });
            expect(received).toEqual([...bytes]);
        }
        // Preview selection and the bounded byte reader each admit the file
        // size; the accepted publication and byte phases must still run once.
        expect(admittedActions).toEqual([actionId]);
        if (hidden) {
            expect(teardownDeferred).toBe(true);
            expect(teardown).toHaveBeenCalledTimes(1);
            expect(userRequestLeaseOwner.hasActiveLease()).toBe(false);
        }
        expect(outgoing.map(value => value.method)).toEqual([...(!downloading ? [RPC_METHODS.STAT_FILE, RPC_METHODS.STAT_FILE] : []),
            RPC_METHODS.DAEMON_TRANSFER_DOWNLOAD_INIT,
            RPC_METHODS.DAEMON_TRANSFER_DOWNLOAD_CHUNK, RPC_METHODS.DAEMON_TRANSFER_DOWNLOAD_FINALIZE].map(method => `${machineId}:${method}`));
        const { getSyncSingleton } = await import('@/sync/runtime/getSyncSingleton');
        expect(getSyncSingleton().encryption).toBeNull();
    });

    it.each([false, true])('encrypts imports on a plain Account and returns the typed terminal file result (hidden=%s)', async hidden => {
        const { userRequestLeaseOwner } = await import('@/sync/runtime/connectivity/userRequestLease');
        const teardown = vi.fn();
        const uploadId = 'import / unicode-λ';
        const bytes = new Uint8Array([0, 255, 128, 10]);
        const { createTransferRecipientKeyPair, decryptEncryptedTransferChunkEnvelope } = await import('./transferChunkEncryption');
        const recipient = createTransferRecipientKeyPair();
        const received: number[] = [];
        respond = async request => {
            if (request.method === `${machineId}:daemon.filesystem.upload`) {
                const envelope = TargetedActionRpcRequestV1Schema.parse(request.params);
                expect(envelope.target).toEqual({ kind: 'machine', machineId });
                const input = FilesystemUploadInputSchema.parse(envelope.input);
                return { ok: true, result: { success: true, status: 'accepted', operationId: 'upload-operation', sourceId: input.source.sourceId,
                    prepared: { uploadId, destDisplayPath: '/repo/binary', expectedSizeBytes: bytes.length, chunkSizeBytes: bytes.length,
                        recipientPublicKeyBase64: recipient.recipientPublicKeyBase64, expiresAt: expiresAt(),
                        endpointCandidates: [{ kind: 'http', url: importEndpoint(uploadId), expiresAt: expiresAt() }] } } };
            }
            const phase = readPhase(request);
            if (phase.path.endsWith('/chunks/0')) {
                const { z } = await import('zod/mini');
                const chunk = z.strictObject({ payloadBase64: z.string(), encryptedDataKeyEnvelopeBase64: z.string() }).parse(phase.body);
                received.push(...await decryptEncryptedTransferChunkEnvelope({ ...chunk, transferId: uploadId, sequence: 0,
                    recipientSecretKeySeed: recipient.recipientSecretKeySeed }));
                return { ok: true, result: rpcResponse({ success: true }) };
            }
            return { ok: true, result: rpcResponse({ success: true, finalized: { success: true, path: '/repo/binary', sizeBytes: bytes.length }, sha256: 'binary-digest' }) };
        };
        const { uploadBulkPayloadFromFileViaMachineCarrier } = await import('./uploadBulkPayloadFromFileViaMachineCarrier');
        const { callAdmittedFilesystemTransferActionRpc } = await import('./filesystemTransferActionClient');
        const result = await uploadBulkPayloadFromFileViaMachineCarrier({ machineId, serverId,
            callAdmittedAction: callAdmittedFilesystemTransferActionRpc,
            directImportRequest: { t: 'session_file_upload_v1', workingDirectory: '/repo', path: 'binary', sizeBytes: bytes.length, overwrite: false },
            fileReader: { sizeBytes: bytes.length, readBytes: async (offset, length) => {
                if (hidden) {
                    expect(userRequestLeaseOwner.deferRoutineTeardown(teardown)).toBe(true);
                    expect(teardown).not.toHaveBeenCalled();
                }
                return bytes.slice(offset, offset + length);
            }, close: async () => {} },
        });
        expect(result).toEqual({ success: true, path: '/repo/binary', sizeBytes: bytes.length, sha256: 'binary-digest' });
        expect(received).toEqual([...bytes]);
        if (hidden) {
            expect(teardown).toHaveBeenCalledTimes(1);
            expect(userRequestLeaseOwner.hasActiveLease()).toBe(false);
        }
        expect(outgoing.filter(value => value.method.endsWith(RPC_METHODS.DAEMON_TRANSFER_UPLOAD_FINALIZE))).toHaveLength(1);
    });

    it('refuses a misbound operation and malformed phase before dispatch', async () => {
        const request = await requester('held-operation');
        await expect(request(`${endpoint('other-operation')}/open`, { method: 'POST', headers: { authorization: 'Bearer held-token' } })).rejects.toThrow();
        await expect(request(`${endpoint('held-operation')}/open?grant=other`, { method: 'POST', headers: { authorization: 'Bearer held-token' } })).rejects.toThrow();
        await expect(request(`${endpoint('held-operation')}/open`, { method: 'POST' })).rejects.toThrow();
        await expect(request(`${importEndpoint('held-operation')}/chunks/0`, { method: 'PUT', body: 'not-json' })).rejects.toThrow();
        await expect(request(`${importEndpoint('held-operation')}/chunks/0`, { method: 'PATCH', body: '{}' })).rejects.toThrow();
        expect(outgoing).toEqual([]);
    });

    it('cancels an issued phase without another delivery and rejects a late acknowledgement', async () => {
        const controller = new AbortController();
        const issued = createDeferred<void>();
        const reply = createDeferred<unknown>();
        respond = async request => { readPhase(request); issued.resolve(); return await reply.promise; };
        const request = await requester('cancelled-import');
        const pending = request(`${importEndpoint('cancelled-import')}/finalize`, { method: 'POST', signal: controller.signal });
        const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
        await issued.promise;
        controller.abort();
        await rejected;
        reply.resolve({ ok: true, result: rpcResponse({ success: true }) });
        expect(outgoing).toHaveLength(1);
    });

    it('does not replay a terminal phase after delivery with an unknown acknowledgement', async () => {
        respond = async request => { readPhase(request); throw new TypeError('Home acknowledgement lost after dispatch'); };
        const request = await requester('uncertain-import');
        await expect(request(`${importEndpoint('uncertain-import')}/finalize`, { method: 'POST' })).rejects.toThrow();
        expect(outgoing).toHaveLength(1);
    });

    it('refuses an RPC frame outside the strict prepared response schema', async () => {
        respond = async request => { readPhase(request); return { ok: true, result: {
            ...rpcResponse({ success: true }), unexpected: 'not-a-published-field',
        } }; };
        const request = await requester('strict-import');
        await expect(request(`${importEndpoint('strict-import')}/finalize`, { method: 'POST' })).rejects.toThrow();
        expect(outgoing).toHaveLength(1);
    });

    it('retains the terminal committed-but-unusable result when the finalize body violates its owner contract', async () => {
        respond = async request => { readPhase(request); return { ok: true, result: rpcResponse({ success: true,
            finalized: { success: true, path: '/repo/binary', sizeBytes: 4, unexpected: true }, sha256: 'digest' }) }; };
        const request = await requester('strict-finalize');
        const { finalizeDirectImportSession, DIRECT_IMPORT_REMOTE_COMMITTED_RESULT_UNUSABLE_ERROR_CODE } = await import('./directTransferImportClient');
        await expect(finalizeDirectImportSession({ baseUrl: importEndpoint('strict-finalize'), request })).resolves.toMatchObject({
            success: false, errorCode: DIRECT_IMPORT_REMOTE_COMMITTED_RESULT_UNUSABLE_ERROR_CODE,
        });
        expect(outgoing).toHaveLength(1);
    });

    it('refuses a held capability after its real Account lifetime retires', async () => {
        const request = await requester('retired-import');
        await homes.switchAccount(serverId, 'replacement-account');
        const { switchConnectionToActiveServer } = await import('@/sync/runtime/orchestration/connectionManager');
        await switchConnectionToActiveServer();
        await expect(request(`${importEndpoint('retired-import')}/finalize`, { method: 'POST' })).rejects.toThrow('action_account_scope_changed');
        expect(outgoing).toEqual([]);
    });

});
