import { vi } from 'vitest';
import {
    MACHINE_PLAIN_DATA_KEY_MARKER, encodePlainMachineStoredContent,
    DirectRouteGrantRequestV2Schema, SignedDirectRouteGrantV2Schema, DIRECT_ROUTE_GRANT_AUDIENCE_V1,
    DIRECT_ROUTE_GRANT_TTL_MS, tryWriteServerEnabledBitInPlace,
    type PromptAssetTypeDescriptorV1, type PromptAssetDiscoveryItemV1,
    type PromptAssetReadResponseV1, type PromptRegistryFetchedItemV1,
    type PromptAssetWriteRequest, type PromptAssetExternalRefV1,
    PromptAssetWriteRequestSchema,
    PromptAssetWriteBundleRequestSchema,
    PromptAssetWriteDocRequestSchema,
} from '@happier-dev/protocol';
import { PROMPT_LIBRARY_ROWS_ROUTE_V1, PromptLibraryCatalogKeyV1Schema } from '@happier-dev/protocol/prompts/library/promptLibraryRowsV1';
import { createTransferManifestHasher } from '@/sync/domains/transfers/runtime/transferRuntime/plumbing/transferManifestHasher';
import { createEncryptedTransferChunkEnvelope, createTransferRecipientKeyPair, decryptEncryptedTransferChunkEnvelope } from '@/sync/domains/transfers/runtime/transferRuntime/plumbing/transferChunkEncryption';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from './homeGovernanceHarness';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from './serverAccountConnectionHarness';
import { createMachineFixture } from '../fixtures/machineFixtures';
import { createRootLayoutFeaturesResponse } from '../fixtures/featureFixtures';
import { createPlainAccountEncryptionCurrentnessFixture } from '../fixtures/accountEncryptionCurrentness';
import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';

/** Genuine native SDK boundary; carrier selection, grants and transfer codecs remain real. */
export async function createPromptNativeTransferModuleBoundary(importOriginal: <T>() => Promise<T>) {
    const actual = await importOriginal<typeof import('@happier-dev/iroh-native')>();
    const unexpected = async (): Promise<never> => { throw new Error('Unexpected native Home operation'); };
    const native = {
        getAvailability: () => ({ available: true }),
        createEndpoint: async () => ({ endpointHandle: 'prompt-screen-endpoint', endpointId: 'b'.repeat(64), relayPolicy: 'automatic' as const,
            relayMode: 'disabled' as const, capProfile: 'machineBulk', relayUrls: [] }),
        startMachineTunnel: async (input) => ({ machineTunnelId: 'prompt-screen-lease', endpointHandle: input.endpointHandle,
            localPort: 48123, connectionActive: true, remoteEndpointId: input.endpointId, observedPath: 'direct' as const,
            startedAtMs: Date.now(), lastErrorCode: null }),
        stopMachineTunnel: async () => {}, ensureHomeTunnel: unexpected, releaseHomeTunnel: unexpected,
        shutdownEndpoint: unexpected, getTunnelStatus: unexpected,
    } satisfies import('@happier-dev/iroh-native').NativeIrohModule;
    return { ...actual, getOptionalHappierIrohNativeModule: () => native };
}

type DaemonRequest = Readonly<{ method: string; params: unknown }>;
let receiveDaemonRequest: ((request: DaemonRequest) => Promise<unknown>) | undefined;
export function installPromptMachineSocketBoundary() {
    installDisconnectedServerSocketBoundary(socket => {
        socket.connected = true;
        socket.timeout = vi.fn<typeof socket.timeout>(() => socket);
        socket.emitWithAck = vi.fn<typeof socket.emitWithAck>(async (event, request: unknown) => {
            if (event !== SOCKET_RPC_EVENTS.CALL || !request || typeof request !== 'object'
                || !('method' in request) || typeof request.method !== 'string' || !('params' in request)) {
                throw new Error(`Unsupported prompt fixture Socket event ${String(event)}: ${JSON.stringify(request)}`);
            }
            const addressed: DaemonRequest = { method: request.method, params: request.params };
            if (!receiveDaemonRequest) throw new Error('Prompt daemon boundary is not installed');
            return { ok: true, result: await receiveDaemonRequest(addressed) };
        });
    });
}

/** Home/daemon HTTP and Socket boundaries shared by the real prompt screen owners. */
export async function createPromptMachineTransferFixture(options: Readonly<{
    serverUrl: string;
    serverIdentityId: string;
    selectionKey: string;
    types: readonly PromptAssetTypeDescriptorV1[];
    discoveries?: readonly PromptAssetDiscoveryItemV1[];
    asset?: Extract<PromptAssetReadResponseV1, { ok: true }>['item'];
    registryItem?: PromptRegistryFetchedItemV1;
    handleHomeRequest(path: string, init?: RequestInit): Promise<Response | null>;
    /** A saved library Account, independent of the displayed Machine Home. */
    libraryHome?: Readonly<{
        serverUrl: string;
        serverIdentityId: string;
        handleHomeRequest(path: string, init?: RequestInit): Promise<Response | null>;
    }>;
}>) {
    const homes = createHomeGovernanceHarness();
    await homes.reset();
    const serverId = await homes.addHome({ name: 'Prompt screen Home', serverUrl: options.serverUrl, publicServerUrl: options.serverUrl,
        serverIdentityId: options.serverIdentityId, accountId: 'account-a' });
    const libraryServerId = options.libraryHome ? await homes.addHome({ name: 'Saved prompt library Home',
        serverUrl: options.libraryHome.serverUrl, publicServerUrl: options.libraryHome.serverUrl,
        serverIdentityId: options.libraryHome.serverIdentityId, accountId: 'account-b', active: false }) : undefined;
    const connection = await restoreServerAccountForTest({ serverUrl: options.serverUrl, accountId: 'account-a' });
    installHomeGovernanceBoundaries(homes);
    try {
    // Scoped and active HTTP leaves in the existing Home harness must reach
    // the same catalog boundary, not only the runtime-fetch fallback below.
    const catalogRoutes: ReadonlyArray<readonly ['GET' | 'POST', string]> = [
        ['GET', '/v2/account/settings'], ['GET', PROMPT_LIBRARY_ROWS_ROUTE_V1],
        ...PromptLibraryCatalogKeyV1Schema.options.map(key => ['POST', `${PROMPT_LIBRARY_ROWS_ROUTE_V1}/${key}`] as const),
    ];
    const bindCatalogRoutes = (catalogServerId: string, handle: typeof options.handleHomeRequest) => {
        for (const [method, path] of catalogRoutes) {
            homes.answer(catalogServerId, `${method} ${path}`, { select: async input => {
                const response = await handle(path, { method,
                    ...(method === 'POST' ? { body: JSON.stringify(input) } : {}) });
                if (!response) throw new Error(`Unanswered prompt fixture catalog ${method} ${path}`);
                return { status: response.status, body: await response.json() };
            } });
        }
    };
    bindCatalogRoutes(serverId, options.handleHomeRequest);
    if (libraryServerId && options.libraryHome) bindCatalogRoutes(libraryServerId, options.libraryHome.handleHomeRequest);
    const features = createRootLayoutFeaturesResponse();
    for (const featureId of ['machines.transfer', 'machines.transfer.directPeer', 'machines.peerMediation'] as const) {
        if (!tryWriteServerEnabledBitInPlace(features, featureId, true)) throw new Error(`Missing feature ${featureId}`);
    }
    const machines = ['machine-1', 'machine-2'].map(id => createMachineFixture({ id, kind: 'persistent', activeAt: Date.now(),
        operationProtocolCapabilitiesRevision: 1,
        operationProtocolCapabilities: { irohMachineEndpoint: { protocolVersions: [1], endpointId: 'a'.repeat(64), directAddresses: ['127.0.0.1:48123'] } },
        daemonState: { status: 'running', transfer: { supported: { import: true, export: true },
            listenerClasses: { loopback_http: { enabled: true, configured: true, active: true },
                tailscale_serve_https: { enabled: false, configured: false, active: false } }, lifecycle: { mode: 'lazy_idle_shutdown', version: 1 } } } }));
    const published = machines.map(machine => ({ ...machine, dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER,
        metadata: encodePlainMachineStoredContent(machine.metadata), daemonState: encodePlainMachineStoredContent(machine.daemonState) }));
    const serveHome = (machineServerId: string, serverIdentityId: string) => {
    const homeFeatures = { ...features, capabilities: { ...features.capabilities, serverIdentity: { serverIdentityId } } };
    homes.answer(machineServerId, '/health', { body: { status: 'ok' } });
    // Cold scoped Machine reads use authenticated readiness, not /health.
    // registerAuthPingRoute's real successful response is JSON { ok: true }.
    homes.answer(machineServerId, '/v1/auth/ping', { body: { ok: true } });
    // Governance's baseline owns /encryption, but this narrower screen fixture
    // must also answer the current strict Account-storage admission route.
    homes.answer(machineServerId, '/v1/account/encryption/currentness', { body: createPlainAccountEncryptionCurrentnessFixture() });
    homes.answer(machineServerId, '/v1/features', { body: homeFeatures });
    homes.answer(machineServerId, '/v1/features/authenticated', { body: homeFeatures });
    };
    const serveMachineHome = (machineServerId: string, accountId: string, serverIdentityId: string) => {
    serveHome(machineServerId, serverIdentityId);
    homes.answer(machineServerId, '/v1/machines', { body: published });
    for (const machine of published) homes.answer(machineServerId, `/v1/machines/${machine.id}`, { body: { machine } });
    homes.answer(machineServerId, '/v1/machines/peer/mediation/route-grants', { select: input => {
        const request = DirectRouteGrantRequestV2Schema.parse(input), now = Date.now();
        return { body: { ok: true, grant: SignedDirectRouteGrantV2Schema.parse({ payload: { v: 2, grantId: 'prompt-screen-grant', accountId,
            machineId: request.machineId, flowKind: request.flowKind, routeKind: request.routeKind, scope: request.scope,
            iat: now, exp: now + request.ttlMs, aud: DIRECT_ROUTE_GRANT_AUDIENCE_V1, endpointFingerprint: request.endpointFingerprint,
            iroh: request.iroh, proofKind: request.kind, ephemeralPublicKeyBase64Url: request.ephemeralPublicKeyBase64Url },
            signature: { keyId: 'fixture-key', alg: 'Ed25519', valueBase64Url: Buffer.alloc(64, 2).toString('base64url') } }) } };
    } });
    };
    serveMachineHome(serverId, 'account-a', options.serverIdentityId);
    if (libraryServerId && options.libraryHome) serveHome(libraryServerId, options.libraryHome.serverIdentityId);
    const daemonRequests: DaemonRequest[] = [];
    const uploadedRequests: PromptAssetWriteRequest[] = [];
    const recipient = createTransferRecipientKeyPair();
    let uploadSize = 0;
    const types = [...options.types];
    let discoveries = [...(options.discoveries ?? [])];
    let asset = options.asset;
    let afterExport: (() => Promise<void>) | undefined;
    const transferBytes = () => new TextEncoder().encode(JSON.stringify(options.registryItem ?? asset));
    receiveDaemonRequest = async request => {
        daemonRequests.push(request);
        const method = request.method.slice(request.method.indexOf(':') + 1);
        if (method === 'daemon.promptAssets.listTypes') return { ok: true, types };
        if (method === 'daemon.promptAssets.discover') return { ok: true, items: discoveries };
        if (method === 'daemon.promptAssets.delete') return { ok: true, externalRef: {}, preview: { operation: 'delete', targetPath: 'review', fileCount: 1 } };
        if (method === 'daemon.directTransfer.import.prepare') {
            if (!request.params || typeof request.params !== 'object' || !('sizeBytes' in request.params)
                || typeof request.params.sizeBytes !== 'number') throw new Error('Missing direct import size');
            uploadSize = request.params.sizeBytes;
            return { success: true, uploadId: 'prompt-screen-import', destDisplayPath: 'review.md', expectedSizeBytes: uploadSize,
                chunkSizeBytes: uploadSize, recipientPublicKeyBase64: recipient.recipientPublicKeyBase64,
                expiresAt: Date.now() + DIRECT_ROUTE_GRANT_TTL_MS.finiteTransferCarrier,
                endpointCandidates: [{ kind: 'http', expiresAt: Date.now() + DIRECT_ROUTE_GRANT_TTL_MS.finiteTransferCarrier,
                    url: 'http://127.0.0.1:48123/machine-transfers/direct/imports/prompt-screen-import' }] };
        }
        if (method === 'daemon.directTransfer.import.abort') return { success: true, aborted: true };
        if (method === 'daemon.promptRegistry.install') return { ok: true, externalRef: { skillName: 'review' }, digest: 'digest-1',
            preview: { operation: 'write', targetPath: '.agents/skills/review', fileCount: 2 } };
        if (method === 'daemon.directTransfer.export.prepare') return { success: true, transferId: 'prompt-screen-export', name: 'prompt.json',
            sizeBytes: transferBytes().length, expiresAt: Date.now() + DIRECT_ROUTE_GRANT_TTL_MS.finiteTransferCarrier,
            endpointCandidates: [{ kind: 'http', expiresAt: Date.now() + DIRECT_ROUTE_GRANT_TTL_MS.finiteTransferCarrier,
                url: 'http://127.0.0.1:48123/machine-transfers/direct/prompt-screen-export' }] };
        if (method === 'daemon.directTransfer.export.release') {
            const callback = afterExport; afterExport = undefined;
            await callback?.();
            return { success: true };
        }
        throw new Error(`Unexpected prompt daemon method ${method}`);
    };
    const { setRuntimeFetch } = await import('@/utils/system/runtimeFetch');
    setRuntimeFetch(async (input, init) => {
        const url = new URL(String(input));
        if (url.origin !== 'http://127.0.0.1:48123') {
            const owned = url.origin === new URL(options.serverUrl).origin
                ? await options.handleHomeRequest(`${url.pathname}${url.search}`, init) : null;
            return owned ?? await homes.request(input, init);
        }
        if (url.pathname.endsWith('/chunks/0') && init?.method === 'PUT') {
            const envelope: unknown = JSON.parse(String(init.body));
            if (!envelope || typeof envelope !== 'object' || !('payloadBase64' in envelope) || typeof envelope.payloadBase64 !== 'string'
                || !('encryptedDataKeyEnvelopeBase64' in envelope) || typeof envelope.encryptedDataKeyEnvelopeBase64 !== 'string') {
                throw new Error('Invalid native upload envelope');
            }
            const bytes = await decryptEncryptedTransferChunkEnvelope({ transferId: 'prompt-screen-import', sequence: 0,
                payloadBase64: envelope.payloadBase64, encryptedDataKeyEnvelopeBase64: envelope.encryptedDataKeyEnvelopeBase64,
                recipientSecretKeySeed: recipient.recipientSecretKeySeed });
            uploadedRequests.push(PromptAssetWriteRequestSchema.parse(JSON.parse(new TextDecoder().decode(bytes))));
            return Response.json({ success: true });
        }
        if (url.pathname.endsWith('/finalize')) {
            const uploaded = uploadedRequests.at(-1);
            if (!uploaded) throw new Error('Native finalize without a consumed upload');
            const bundle = PromptAssetWriteBundleRequestSchema.safeParse(uploaded);
            const externalRef: PromptAssetExternalRefV1 = uploaded.externalRef ?? (bundle.success
                ? { skillName: bundle.data.targetName }
                : { relativePath: PromptAssetWriteDocRequestSchema.parse(uploaded).targetPath });
            const target = externalRef.relativePath ?? externalRef.skillName ?? externalRef.name;
            if (typeof target !== 'string') throw new Error('Missing external upload target');
            return Response.json({ success: true, finalized: { success: true, path: 'review.md', sizeBytes: uploadSize,
                result: { ok: true, externalRef, digest: 'digest-1', preview: { operation: 'write', targetPath: target,
                    fileCount: bundle.success ? bundle.data.bundleBody.entries.length : 1 } } }, sha256: 'digest-1' });
        }
        const bytes = transferBytes(), hash = createTransferManifestHasher(); hash.update(bytes);
        if (url.pathname.endsWith('/open')) return Response.json({ transferId: 'prompt-screen-export', totalChunks: 1, sizeBytes: bytes.length, manifestHash: hash.digestManifestHash() });
        if (url.pathname.endsWith('/chunks/0')) {
            const recipientPublicKeyBase64 = new Headers(init?.headers).get('x-happier-transfer-recipient-public-key');
            if (!recipientPublicKeyBase64) throw new Error('Missing transfer recipient');
            return Response.json({ kind: 'chunk', transferId: 'prompt-screen-export', sequence: 0,
                ...await createEncryptedTransferChunkEnvelope({ transferId: 'prompt-screen-export', sequence: 0, payload: bytes, recipientPublicKeyBase64 }) });
        }
        throw new Error(`Unexpected transfer request ${url}`);
    });
    const { storage } = await import('@/sync/domains/state/storage');
    const { fetchAndApplyMachines } = await import('@/sync/engine/machines/syncMachines');
    await fetchAndApplyMachines({ credentials: connection.credentials, expectedAccountMode: 'plain', encryption: null,
        machineDataKeys: new Map(), sourceServerId: serverId, throwOnError: true,
        request: (path, init) => homes.request(new URL(path, options.serverUrl), init),
        applyMachines: (rows, replace) => storage.getState().applyMachines(rows, replace, { sourceServerId: serverId }) });
    const { resolveServerProfileScopeIdForIdentifier } = await import('@/sync/domains/server/serverProfiles');
    const scope = { serverId: resolveServerProfileScopeIdForIdentifier(serverId), accountId: 'account-a' };
    const libraryHome = libraryServerId ? { serverId: libraryServerId,
        scope: { serverId: resolveServerProfileScopeIdForIdentifier(libraryServerId), accountId: 'account-b' },
        artifacts: homes.artifacts(libraryServerId) } : undefined;
    storage.getState().activateProfileScope(scope);
    storage.getState().applySettingsForScope(scope, storage.getState().settings, 7);
    storage.getState().applySettingsLocal({ machineAdministrationTargetsLocalV1: {
        [options.selectionKey]: { serverIdentityId: options.serverIdentityId, machineId: 'machine-1' },
    } });
    storage.setState({ isDataReady: true, machineListStatusByServerId: { [scope.serverId]: 'idle' } });
    const { getReadyServerFeatures } = await import('@/sync/api/capabilities/getReadyServerFeatures');
    if (!await getReadyServerFeatures({ serverId, force: true })) throw new Error('Prompt fixture original Home feature admission failed');
    const { resolveMachineCarrierRoute } = await import('@/sync/domains/transfers/runtime/transferRuntime/plumbing/machineCarrierHttpLease');
    const route = await resolveMachineCarrierRoute('machine-1', serverId);
    if (route.kind !== 'iroh_peer') throw new Error(`Prompt fixture carrier was not admitted: ${JSON.stringify({ route, serverId,
        machines: storage.getState().machines, machineListByServerId: storage.getState().machineListByServerId })}`);
    const { machinePromptAssetsListTypes } = await import('@/sync/ops/machinePromptAssets');
    const admittedTypes = await machinePromptAssetsListTypes('machine-1', { serverId });
    if (!admittedTypes.ok) throw new Error(`Prompt fixture daemon refused admission: ${JSON.stringify(admittedTypes)}`);
    daemonRequests.length = 0;
    // Mirror a live screen's subscription before refresh: an observer gap
    // correctly makes a previously visited Account require revalidation.
    const { observePromptLibraryCatalog } = await import('@/sync/engine/settings/promptLibraryCatalogEngine');
    const stopCatalogObservation = observePromptLibraryCatalog(scope);
    let machineHomeStage = 'not-started';
    return { homes, serverId, scope, libraryHome, daemonRequests, uploadedRequests, artifacts: homes.artifacts(serverId),
        diagnostic() { return { machineHomeStage, scope, settingsScope: storage.getState().settingsScope,
            advertisedTypes: types,
            selection: storage.getState().settings.machineAdministrationTargetsLocalV1,
            requests: homes.requests.map(({ serverId, path }) => ({ serverId, path })), daemonRequests }; },
        async addMachineHome(serverUrl: string, serverIdentityId: string) {
            machineHomeStage = 'save-independent-home';
            const machineServerId = await homes.addHome({ name: 'Independent Machine Home', serverUrl, publicServerUrl: serverUrl,
                serverIdentityId, accountId: 'account-b', active: false });
            serveMachineHome(machineServerId, 'account-b', serverIdentityId);
            machineHomeStage = 'read-independent-credentials';
            const { TokenStorage } = await import('@/auth/storage/tokenStorage');
            const credentials = await TokenStorage.getCredentialsForServerUrl(serverUrl, { serverId: machineServerId });
            if (!credentials) throw new Error('Independent Machine Home credentials unavailable');
            const { parseToken } = await import('@/utils/auth/parseToken');
            if (parseToken(credentials.token) !== 'account-b') throw new Error('Independent Machine Home Account binding is not account-b');
            machineHomeStage = 'fetch-independent-machine-inventory';
            await fetchAndApplyMachines({ credentials, expectedAccountMode: 'plain', encryption: null, machineDataKeys: new Map(), sourceServerId: machineServerId,
                throwOnError: true, request: (path, init) => homes.request(new URL(path, serverUrl), init),
                applyMachines: (rows, replace) => storage.getState().applyMachines(rows, replace, { sourceServerId: machineServerId }) });
            machineHomeStage = 'admit-independent-home-features';
            if (!await getReadyServerFeatures({ serverId: machineServerId, force: true })) throw new Error('Independent Machine Home feature admission failed');
            storage.setState(state => ({ machineListStatusByServerId: { ...state.machineListStatusByServerId,
                [resolveServerProfileScopeIdForIdentifier(machineServerId)]: 'idle' } }));
            storage.getState().applySettingsLocal({ machineAdministrationTargetsLocalV1: {
                [options.selectionKey]: { serverIdentityId, machineId: 'machine-1' },
            } });
            machineHomeStage = 'admit-independent-machine-carrier';
            const machineRoute = await resolveMachineCarrierRoute('machine-1', machineServerId);
            if (machineRoute.kind !== 'iroh_peer') throw new Error(`Independent Machine carrier unavailable: ${JSON.stringify(machineRoute)}`);
            machineHomeStage = 'admit-independent-plain-machine-rpc';
            try {
                const listed = await machinePromptAssetsListTypes('machine-1', { serverId: machineServerId });
                if (!listed.ok) throw new Error(JSON.stringify(listed));
            } catch (error) {
                throw new Error(`Independent Plain Machine RPC admission failed: ${error instanceof Error ? error.message : String(error)}; ${JSON.stringify(
                    homes.requests.map(({ serverId, path }) => ({ serverId, path })))}`, { cause: error });
            }
            if (storage.getState().settingsScope?.serverId !== scope.serverId || storage.getState().settingsScope?.accountId !== scope.accountId)
                throw new Error('Independent Machine admission replaced the displayed library Account');
            machineHomeStage = 'ready';
            return { serverId: machineServerId, artifacts: homes.artifacts(machineServerId) };
        },
        setAsset(next: typeof asset) { asset = next; }, setDiscoveries(next: typeof discoveries) { discoveries = next; },
        afterNextExport(callback: () => Promise<void>) { afterExport = callback; },
        setTypes(next: readonly PromptAssetTypeDescriptorV1[]) { types.splice(0, types.length, ...next); },
        selectMachine(machineId: string | null) { storage.getState().applySettingsLocal({
            machineAdministrationTargetsLocalV1: machineId ? { [options.selectionKey]: { serverIdentityId: options.serverIdentityId, machineId } } : {},
        }); },
        async dispose() { stopCatalogObservation(); receiveDaemonRequest = undefined; await connection.dispose();
            const { serverScopedRpcSocketPool } = await import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedRpcSocketPool');
            const { resetScopedMachineTransportCacheForTests } = await import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedRpcPool');
            await serverScopedRpcSocketPool.stopAll(); resetScopedMachineTransportCacheForTests(); await homes.reset(); },
    };
    } catch (error) {
        receiveDaemonRequest = undefined;
        await connection.dispose();
        await homes.reset();
        throw error;
    }
}
