import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    ApprovalRequestSchema,
    FeaturesResponseSchema,
    MACHINE_PLAIN_DATA_KEY_MARKER,
    encodePlainMachineStoredContent,
    DIRECT_ROUTE_GRANT_AUDIENCE_V1,
    DIRECT_ROUTE_GRANT_TTL_MS,
    DirectRouteGrantRequestV2Schema,
    SignedDirectRouteGrantV2Schema,
    tryWriteServerEnabledBitInPlace,
    buildApprovalRequestArtifactHeaderV1,
    decodePlainArtifactStoredContent,
    REDACTED_LOCAL_SERVICE_PUBLIC_PREVIEW_URL,
    SessionMetadataInactiveModelIntentPatchV1Schema,
    ProviderBoundModelRefSchema,
    V2SessionRecordSchema,
    type ActionId,
    type ActionExecutorContext,
    type ApprovalRequest,
} from '@happier-dev/protocol';
import { normalizeUsageQuery } from '@happier-dev/protocol/inputs/usageQuery';
import { UsageQueryBatchResultSchema } from '@happier-dev/protocol/usage/resolveUsagePageAggregation';
import { UsageCoachApplyResultSchema } from '@happier-dev/protocol/usage/coach/coachActions';
import { UsageAnalyticsQueryResponseSchema } from '@happier-dev/protocol/usage/usageAnalyticsContracts';
import { UsagePromptCompositionSchema } from '@happier-dev/protocol/usage/coach/usagePromptComposition';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { createDeferred } from '@/dev/testkit/hooks/createDeferred';
import { installWebLockManagerMock } from '@/auth/storage/tokenStorage.web.testHelpers';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { createPlainProjectAccountRowListFixture } from '@/dev/testkit/fixtures/projectAccountRows';
import { ProjectAccountRowMutationRequestV1Schema, ProjectAccountOrganizationV1Schema, PROJECT_ACCOUNT_ROWS_ROUTE_V1 } from '@happier-dev/protocol/projects/projectAccountRowsV1';
import {
    PROMPT_LIBRARY_ROWS_ROUTE_V1,
    PromptLibraryCatalogKeyV1Schema,
    PromptLibraryRowMutationV1Schema,
    PromptLibraryRecordV1Schema,
    type PromptLibraryRecordV1,
} from '@happier-dev/protocol/prompts/library/promptLibraryRowsV1';

const rpc = vi.hoisted(() => ({ machine: vi.fn(), session: vi.fn() }));
// Library codecs, Sync, store, metadata CAS and scoped RPC owners stay real.
// The native SDK module and HTTP leaves are genuine external boundaries; carrier policy and lifecycle stay real.
vi.mock('@happier-dev/iroh-native', async (original) => {
    const actual = await original<typeof import('@happier-dev/iroh-native')>();
    const unexpected = async (): Promise<never> => { throw new Error('Unexpected native Home operation'); };
    const native = {
        getAvailability: () => ({ available: true }),
        createEndpoint: async () => ({ endpointHandle: 'fixture-endpoint', endpointId: 'b'.repeat(64), relayPolicy: 'automatic' as const, relayMode: 'disabled' as const, capProfile: 'machineBulk', relayUrls: [] }),
        startMachineTunnel: async (input) => ({ machineTunnelId: 'fixture-machine-lease', endpointHandle: input.endpointHandle,
            localPort: 48123, connectionActive: true, remoteEndpointId: input.endpointId, observedPath: 'direct' as const, startedAtMs: Date.now(), lastErrorCode: null }),
        stopMachineTunnel: async () => {},
        ensureHomeTunnel: unexpected, releaseHomeTunnel: unexpected, shutdownEndpoint: unexpected, getTunnelStatus: unexpected,
    } satisfies import('@happier-dev/iroh-native').NativeIrohModule;
    return { ...actual, getOptionalHappierIrohNativeModule: () => native };
});
installDisconnectedServerSocketBoundary((socket) => {
    socket.connected = true;
    // This connected network boundary has no real Socket.IO engine, including
    // the fire-and-forget human-presence leave emitted during Account disposal.
    vi.spyOn(socket, 'emit').mockReturnValue(socket);
    vi.spyOn(socket, 'timeout').mockReturnValue(socket);
    vi.spyOn(socket, 'emitWithAck').mockImplementation(async (_event: string, request: { method: string; params: unknown }) => {
        const separator = request.method.indexOf(':');
        const targetId = request.method.slice(0, separator);
        const method = request.method.slice(separator + 1);
        // Socket.IO keeps its external endpoint URI private; read only this network-boundary fact.
        const endpoint: unknown = Reflect.get(socket.io, 'uri');
        if (typeof endpoint !== 'string') throw new Error('Socket transport endpoint missing');
        const addressedHome = homes.findByServerUrl(endpoint);
        if (!addressedHome) throw new Error(`Unexpected Socket transport endpoint: ${endpoint}`);
        const result = await (targetId === 'session_1' ? rpc.session : rpc.machine)({
            [targetId === 'session_1' ? 'sessionId' : 'machineId']: targetId,
            serverId: addressedHome.serverId, method, payload: request.params,
        });
        return { ok: true, result };
    });
});
const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
await loadSyncSingletonForTests();
const { storage } = await import('@/sync/domains/state/storage');
const { sync } = await import('@/sync/sync');
const { setRuntimeFetch } = await import('@/utils/system/runtimeFetch');
const { createRootLayoutFeaturesResponse } = await import('@/dev/testkit/fixtures/featureFixtures');
const { createEncryptedTransferChunkEnvelope, createTransferRecipientKeyPair, decryptEncryptedTransferChunkEnvelope } = await import('@/sync/domains/transfers/runtime/transferRuntime/plumbing/transferChunkEncryption');
const { createTransferManifestHasher } = await import('@/sync/domains/transfers/runtime/transferRuntime/plumbing/transferManifestHasher');
const { createDefaultActionExecutor } = await import('./defaultActionExecutor');
type Executor = ReturnType<typeof createDefaultActionExecutor>;
type Session = ReturnType<typeof createSessionFixture>;
const baseline = storage.getState();
const machineRpcWithServerScopeMock = rpc.machine;
let serverId: string;
let connection: Awaited<ReturnType<typeof restoreServerAccountForTest>> | null = null;
let webLocks: ReturnType<typeof installWebLockManagerMock>;

function selection(modelId: string, providerConnectionId: string | null = null) {
    return ProviderBoundModelRefSchema.parse({ agentTargetKey: 'agent:happier.agent.claude/claude', providerConnectionId, modelId });
}
const binding = {
    v: 1, connectionId: 'pc_active', contributionKey: null, connectionRevision: 1,
    model: { id: 'active-model', name: 'Active model' }, protocol: 'anthropic', materialization: 'spawnEnv',
    compatibilityFingerprint: 'compatibility:v1:active', bindingSecurityFingerprint: 'binding-security:v1:active',
    displaySnapshot: { providerName: 'Provider', connectionName: 'Active', connectionRole: 'named', connectionDisplayNameMode: 'custom' },
} as const;
function seedSession(active: boolean, overrides: Partial<NonNullable<Session['metadata']>> = {}) {
    const session = createSessionFixture({ id: 'session_1', serverId, active,
        metadataLayoutVersion: 0, metadata: { path: '/repo', host: 'host', homeDir: '/home', machineId: 'machine_1', agent: 'claude', ...overrides } });
    storage.getState().applySessions([session]);
    serveSession(session);
    return session;
}
function modelInput(modelId: string, providerConnectionId?: string | null) {
    return { sessionId: 'session_1', modelId, ...(providerConnectionId !== undefined ? { providerConnectionId } : {}) };
}
function executeModel(input: ReturnType<typeof modelInput>) {
    return createDefaultActionExecutor().execute('session.model.set', input, { serverId, surface: 'ui' });
}
async function executeRuntime(executor: Executor, args: { actionId: ActionId; input: unknown; context: ActionExecutorContext }) {
    const result = await executor.execute(args.actionId, args.input, { ...args.context, serverId, surface: 'ui' });
    return result.ok ? result.result : result;
}

async function admitBrowserAutomation() {
    const { primeServerFeaturesSnapshot } = await import('@/sync/api/capabilities/serverFeaturesClient');
    primeServerFeaturesSnapshot({ serverId, snapshot: { status: 'ready', features: FeaturesResponseSchema.parse({ features: {
        browser: { enabled: true, viewTargets: { enabled: true }, internal: { enabled: true }, automation: { enabled: true } },
    } }) } });
}

/** Stateful Home Session HTTP boundary. The real Sync tuple owner handles retries/currentness. */
function serveSession(session: Session, beforeWrite?: (input: unknown) => void, beforeRead?: () => Promise<void>) {
    let row = V2SessionRecordSchema.parse({
        id: session.id, createdAt: 1, updatedAt: 1, seq: 1, active: session.active, activeAt: 1,
        encryptionMode: 'plain', dataEncryptionKey: null, metadataLayoutVersion: 0,
        metadata: JSON.stringify(session.metadata), metadataVersion: session.metadataVersion,
        agentState: null, agentStateVersion: 1, share: null,
        responsibleAccountId: null, responsibleAccount: null,
        effectiveAccess: { v: 1, level: 'owner', sources: [{ kind: 'owner' }], capabilities: session.access?.capabilities },
    });
    const writes: unknown[] = [];
    homes.answer(serverId, `GET /v2/sessions/${session.id}`, { select: async () => {
        await beforeRead?.();
        return { body: { session: row } };
    } });
    homes.answer(serverId, `PATCH /v2/sessions/${session.id}`, { select: (input) => {
        writes.push(input);
        beforeWrite?.(input);
        if (row.active) return { status: 409, body: { code: 'session_active' } };
        const patch = SessionMetadataInactiveModelIntentPatchV1Schema.parse(input).inactiveModelIntent.metadata;
        if (patch.expectedVersion !== row.metadataVersion) {
            return { body: { success: false, error: 'version-mismatch', metadata: { version: row.metadataVersion, value: row.metadata } } };
        }
        row = { ...row, metadata: patch.ciphertext, metadataVersion: row.metadataVersion + 1, updatedAt: row.updatedAt + 1, seq: row.seq + 1 };
        return { body: { success: true, metadata: { version: row.metadataVersion } } };
    } });
    return {
        writes,
        readMetadata: () => JSON.parse(row.metadata) as NonNullable<Session['metadata']>,
        activate(metadata = session.metadata) {
            row = { ...row, active: true, metadata: JSON.stringify(metadata), metadataVersion: row.metadataVersion + 1, seq: row.seq + 1, updatedAt: row.updatedAt + 1 };
        },
        replaceMetadata(metadata: NonNullable<Session['metadata']>) {
            row = { ...row, metadata: JSON.stringify(metadata), metadataVersion: row.metadataVersion + 1, seq: row.seq + 1, updatedAt: row.updatedAt + 1 };
        },
    };
}
async function seededApproval(request: ApprovalRequest) {
    return await sync.createArtifactWithHeader(buildApprovalRequestArtifactHeaderV1(request, { legacyServerId: serverId }), JSON.stringify(request));
}


type DaemonRequest = Readonly<{ machineId?: string; sessionId?: string; serverId: string; method: string; payload: unknown }>;
const registryItem = {
    sourceId: 'skills_sh:featured', itemId: 'skills_sh:featured:item-1', title: 'Review skill', description: 'Review',
    bundleSchemaId: 'skills.skill_md_v1' as const,
    bundleBody: { v: 1 as const, entries: [{ path: 'SKILL.md', contentBase64: Buffer.from('# Review').toString('base64'), contentKind: 'utf8' as const }], createdAtMs: 1, updatedAtMs: 1 },
};
const externalResult = { ok: true as const, externalRef: { path: '.claude/commands/review.md' }, digest: 'digest-1' };

/** Stateful row HTTP/CAS boundary; Action policy, catalog loading and transfer logic remain real. */
function serveExternalLinksCatalog(outcome: 'updated' | 'conflict' | 'unavailable') {
    let record: Extract<PromptLibraryRecordV1, { key: 'external-links' }> = {
        key: 'external-links', value: { v: 1, links: [{ id: 'neighbor-link', artifactId: 'neighbor-doc',
            assetTypeId: 'claude.command', scope: 'user', machineId: 'machine_1', externalRef: { path: 'neighbor.md' } }] },
    };
    let revision = 4;
    const mutations: ReturnType<typeof PromptLibraryRowMutationV1Schema.parse>[] = [];
    const tombstones = PromptLibraryCatalogKeyV1Schema.options.filter(key => key !== record.key)
        .map(key => ({ key, revision: 1, content: null }));
    homes.answer(serverId, '/v1/account/encryption/currentness', { body: createPlainAccountEncryptionCurrentnessFixture() });
    homes.answer(serverId, 'GET /v2/account/settings', { body: { content: { t: 'plain', v: {} }, version: 7 } });
    homes.answer(serverId, 'POST /v2/account/settings', { body: { success: true, version: 8 } });
    homes.answer(serverId, PROMPT_LIBRARY_ROWS_ROUTE_V1, { select: () => outcome === 'unavailable'
        ? { status: 403, body: { error: 'forbidden' } }
        : { body: { status: 'listed', rows: [{ key: record.key, revision, content: { t: 'plain', v: record } }, ...tombstones] } } });
    homes.answer(serverId, `POST ${PROMPT_LIBRARY_ROWS_ROUTE_V1}/external-links`, { select: input => {
        const mutation = PromptLibraryRowMutationV1Schema.parse(input);
        mutations.push(mutation);
        if (outcome === 'conflict' || mutation.expectedRevision !== revision) return { body: { status: 'conflict', revision: revision + 1 } };
        if (mutation.content?.t !== 'plain' || mutation.content.v.key !== 'external-links') throw new Error('Unexpected external-link mutation');
        record = mutation.content.v;
        return { body: { status: 'updated', revision: ++revision, cursor: revision } };
    } });
    if (storage.getState().profileScope?.serverId === serverId) {
        storage.getState().applySettingsForScope({ serverId, accountId: 'account-a' }, baseline.settings, 7);
    }
    return { mutations, read: () => ({ record, revision }) };
}
/** Fake native daemon HTTP / Socket boundaries carry real encrypted finite-transfer bytes. */
async function servePromptTransfers() {
    const features = createRootLayoutFeaturesResponse();
    for (const featureId of ['machines.transfer', 'machines.transfer.directPeer', 'machines.peerMediation'] as const) {
        if (!tryWriteServerEnabledBitInPlace(features, featureId, true)) throw new Error(`Feature unavailable: ${featureId}`);
    }
    homes.answer(serverId, '/v1/features', { body: features });
    homes.answer(serverId, '/v1/features/authenticated', { body: features });
    const machine = createMachineFixture({ id: 'machine_1', kind: 'persistent', operationProtocolCapabilitiesRevision: 1,
        operationProtocolCapabilities: { irohMachineEndpoint: { protocolVersions: [1], endpointId: 'a'.repeat(64), directAddresses: ['127.0.0.1:48123'] } },
        daemonState: { status: 'running', transfer: { supported: { import: true, export: true },
            listenerClasses: { loopback_http: { enabled: true, configured: true, active: true }, tailscale_serve_https: { enabled: false, configured: false, active: false } },
            lifecycle: { mode: 'lazy_idle_shutdown', version: 1 } } } });
    const publishedMachine = { ...machine, dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER,
        metadata: encodePlainMachineStoredContent(machine.metadata), daemonState: encodePlainMachineStoredContent(machine.daemonState) };
    homes.answer(serverId, '/v1/machines', { body: [publishedMachine] });
    homes.answer(serverId, '/v1/machines/machine_1', { body: { machine: publishedMachine } });
    homes.answer(serverId, '/v1/machines/peer/mediation/route-grants', { select: (input) => {
        const request = DirectRouteGrantRequestV2Schema.parse(input);
        const now = Date.now();
        // The fake Home returns a schema-valid signed grant; the real client binds and signs its ephemeral proof.
        const grant = SignedDirectRouteGrantV2Schema.parse({ payload: { v: 2, grantId: 'fixture-grant', accountId: 'account-a',
            machineId: request.machineId, flowKind: request.flowKind, routeKind: request.routeKind, scope: request.scope,
            iat: now, exp: now + request.ttlMs, aud: DIRECT_ROUTE_GRANT_AUDIENCE_V1, endpointFingerprint: request.endpointFingerprint,
            iroh: request.iroh, proofKind: request.kind, ephemeralPublicKeyBase64Url: request.ephemeralPublicKeyBase64Url },
            signature: { keyId: 'fixture-key', alg: 'Ed25519', valueBase64Url: Buffer.alloc(64, 2).toString('base64url') } });
        return { body: { ok: true, grant } };
    } });
    const recipient = createTransferRecipientKeyPair();
    let uploaded: unknown;
    let sizeBytes = 0;
    const exportedBytes = new TextEncoder().encode(JSON.stringify(registryItem));
    const hash = createTransferManifestHasher(); hash.update(exportedBytes);
    const manifestHash = hash.digestManifestHash();
    rpc.machine.mockImplementation(async (request: DaemonRequest) => {
        if (request.method === 'daemon.directTransfer.import.prepare') {
            const payload = request.payload as { sizeBytes: number };
            sizeBytes = payload.sizeBytes;
            return { success: true, uploadId: 'upload-1', destDisplayPath: 'review.md', expectedSizeBytes: sizeBytes,
                chunkSizeBytes: sizeBytes, recipientPublicKeyBase64: recipient.recipientPublicKeyBase64,
                expiresAt: Date.now() + DIRECT_ROUTE_GRANT_TTL_MS.finiteTransferCarrier,
                endpointCandidates: [{ kind: 'http', expiresAt: Date.now() + DIRECT_ROUTE_GRANT_TTL_MS.finiteTransferCarrier,
                    url: 'http://127.0.0.1:48123/machine-transfers/direct/imports/upload-1' }] };
        }
        if (request.method === 'daemon.directTransfer.export.prepare') return { success: true, transferId: 'export-1',
            name: 'skill.json', sizeBytes: exportedBytes.length, expiresAt: Date.now() + DIRECT_ROUTE_GRANT_TTL_MS.finiteTransferCarrier,
            endpointCandidates: [{ kind: 'http', expiresAt: Date.now() + DIRECT_ROUTE_GRANT_TTL_MS.finiteTransferCarrier,
                url: 'http://127.0.0.1:48123/machine-transfers/direct/export-1' }] };
        if (request.method === 'daemon.directTransfer.import.abort') return { success: true, aborted: true };
        if (request.method === 'daemon.directTransfer.export.release') return { success: true };
        if (request.method === 'daemon.promptRegistry.install') {
            return { ok: true, externalRef: { skillName: 'review' }, digest: 'digest-1' };
        }
        throw new Error(`Unexpected daemon transport: ${request.method}`);
    });
    setRuntimeFetch(async (input, init) => {
        const url = new URL(String(input));
        // The native daemon and Home share this HTTP boundary, not a transport
        // owner. Keep real feature/grant/catalog requests addressed to the Home.
        if (url.origin !== 'http://127.0.0.1:48123') return await homes.request(input, init);
        if (url.pathname.endsWith('/chunks/0') && init?.method === 'PUT') {
            const envelope = JSON.parse(String(init.body)) as { payloadBase64: string; encryptedDataKeyEnvelopeBase64: string };
            const bytes = await decryptEncryptedTransferChunkEnvelope({ ...envelope, transferId: 'upload-1', sequence: 0, recipientSecretKeySeed: recipient.recipientSecretKeySeed });
            uploaded = JSON.parse(new TextDecoder().decode(bytes));
            return Response.json({ success: true });
        }
        if (url.pathname.endsWith('/finalize')) {
            return Response.json({ success: true, finalized: { success: true, path: 'review.md', sizeBytes, result: externalResult }, sha256: 'digest-1' });
        }
        if (url.pathname.endsWith('/open')) return Response.json({ transferId: 'export-1', totalChunks: 1, sizeBytes: exportedBytes.length, manifestHash });
        if (url.pathname.endsWith('/chunks/0')) {
            const recipientPublicKeyBase64 = new Headers(init?.headers).get('x-happier-transfer-recipient-public-key');
            if (!recipientPublicKeyBase64) throw new Error('Missing transfer recipient');
            return Response.json({ kind: 'chunk', transferId: 'export-1', sequence: 0,
                ...await createEncryptedTransferChunkEnvelope({ transferId: 'export-1', sequence: 0, payload: exportedBytes, recipientPublicKeyBase64 }) });
        }
        throw new Error(`Unexpected transfer HTTP: ${url}`);
    });
    // Home connection readiness may already have cached the baseline feature
    // projection. Refresh through the actual HTTP reader after changing it.
    const { getReadyServerFeatures } = await import('@/sync/api/capabilities/getReadyServerFeatures');
    expect(await getReadyServerFeatures({ serverId, force: true })).toMatchObject({ features: {
        machines: { transfer: { enabled: true, directPeer: { enabled: true } }, peerMediation: { enabled: true } },
    } });
    // The real Machine producer opens the published plain row and installs its
    // mode/context before Socket RPC; no synthetic E2EE material is necessary.
    const { TokenStorage } = await import('@/auth/storage/tokenStorage');
    const sourceCredentials = await TokenStorage.getCredentialsForServerUrl('https://prompt-actions.test', { serverId });
    if (!sourceCredentials) throw new Error('Missing admitted source Home credentials');
    const { fetchAndApplyMachines } = await import('@/sync/engine/machines/syncMachines');
    await fetchAndApplyMachines({ credentials: sourceCredentials, expectedAccountMode: 'plain', encryption: null,
        machineDataKeys: new Map(), sourceServerId: serverId, throwOnError: true,
        request: (path, init) => homes.request(new URL(path, 'https://prompt-actions.test'), init),
        applyMachines: (machines, replace) => storage.getState().applyMachines(machines, replace, { sourceServerId: serverId }) });
    const { resolveServerProfileScopeIdForIdentifier } = await import('@/sync/domains/server/serverProfiles');
    const machineScopeId = resolveServerProfileScopeIdForIdentifier(serverId);
    const currentMachine = storage.getState().machineListByServerId[machineScopeId]?.find(machine => machine.id === 'machine_1');
    expect(currentMachine, JSON.stringify({ requestedServerId: serverId, machineScopeId,
        machineListByServerId: storage.getState().machineListByServerId })).toMatchObject({ storageMode: 'plain', availability: { kind: 'available' } });
    const { resolveMachineCarrierRoute } = await import('@/sync/domains/transfers/runtime/transferRuntime/plumbing/machineCarrierHttpLease');
    const { resolveTargetServer } = await import('@/sync/domains/machines/peer/mediation/stream/productionRouteHttp');
    const { readPeerEndpointForServerScope } = await import('@/sync/domains/machines/peer/mediation/readPeerEndpointForServerScope');
    const { getAppliedActiveServerSnapshot } = await import('@/sync/runtime/orchestration/connectionManager');
    const { readCurrentMachineIrohEndpoint } = await import('@/sync/domains/transfers/runtime/transferRuntime/routing/resolveMachineCarrierPreselection');
    const { probeIrohMachineTransferLifecycleAvailability } = await import('@/sync/runtime/nativeIrohTunnels/machineTransferLifecycle');
    const { isBrowserIrohHost } = await import('@/sync/runtime/browserIroh/hostEligibility');
    expect(await resolveMachineCarrierRoute('machine_1', serverId), JSON.stringify({
        currentMachine,
        requestedServerId: serverId, resolvedServer: resolveTargetServer(serverId), appliedHome: getAppliedActiveServerSnapshot(),
        addressedMachine: readPeerEndpointForServerScope({ state: storage.getState(), serverId: resolveTargetServer(serverId)?.serverId ?? serverId,
            machineId: 'machine_1', select: machine => machine }),
        endpoint: readCurrentMachineIrohEndpoint({ capabilities: currentMachine?.operationProtocolCapabilities,
            revision: currentMachine?.operationProtocolCapabilitiesRevision, active: currentMachine?.active }),
        browserHost: isBrowserIrohHost(), nativeLifecycleAvailable: await probeIrohMachineTransferLifecycleAvailability(),
        applicationCarrierEligibility: storage.getState().localSettings.homeApplicationCarrierEligibility,
    })).toMatchObject({ kind: 'iroh_peer', carrierKind: 'native_http' });
    return { readUploaded: () => uploaded };
}

describe('createDefaultActionExecutor (prompt library routing)', () => {
    beforeEach(async () => {
        webLocks = installWebLockManagerMock();
        await homes.reset();
        storage.setState(baseline, true);
        for (const boundary of Object.values(rpc)) boundary.mockReset();
        serverId = await homes.addHome({ name: 'Prompt Home', serverUrl: 'https://prompt-actions.test', serverIdentityId: 'srv_prompt-actions', accountId: 'account-a' });
        connection = await restoreServerAccountForTest({ serverUrl: 'https://prompt-actions.test', accountId: 'account-a' });
        installHomeGovernanceBoundaries(homes);
        storage.getState().applySettingsForScope({ serverId, accountId: 'account-a' }, storage.getState().settings, 1);
        storage.getState().activateProfileScope({ serverId, accountId: 'account-a' });
        vi.stubGlobal('fetch', async (url: RequestInfo | URL) => {
            const path = new URL(String(url)).pathname;
            if (path.startsWith('/v1/machines/')) return Response.json({ machine: { id: path.split('/').at(-1), kind: 'persistent', dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER } });
            return Response.json({ error: 'not_found' }, { status: 404 });
        });
    });
    afterEach(async () => {
        await connection?.dispose();
        connection = null;
        const { serverScopedRpcSocketPool } = await import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedRpcSocketPool');
        const { resetScopedMachineTransportCacheForTests } = await import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedRpcPool');
        await serverScopedRpcSocketPool.stopAll();
        resetScopedMachineTransportCacheForTests();
        vi.unstubAllGlobals();
        standardCleanup();
        webLocks.restore();
        installHomeGovernanceBoundaries(homes);
    });

    it('creates Account memory without a Session through the captured coding row', async () => {
        const { resolveServerProfileScopeIdForIdentifier } = await import('@/sync/domains/server/serverProfiles');
        const accountServerId = resolveServerProfileScopeIdForIdentifier(serverId);
        homes.answer(serverId, '/v1/account/encryption/currentness', { body: createPlainAccountEncryptionCurrentnessFixture() });
        homes.answer(serverId, 'GET /v2/account/settings', { body: { content: { t: 'plain', v: {} }, version: 1 } });
        let record: PromptLibraryRecordV1 = { key: 'coding', value: { v: 1, scope: { kind: 'coding' }, entries: [
            { id: 'instructions', ref: { kind: 'doc', artifactId: 'instructions' }, enabled: true, placement: 'system_append' },
        ] } };
        let revision = 4;
        homes.answer(serverId, `POST ${PROMPT_LIBRARY_ROWS_ROUTE_V1}/coding`, { select: input => {
            const mutation = PromptLibraryRowMutationV1Schema.parse(input);
            if (mutation.expectedRevision !== revision) return { status: 409, body: { status: 'conflict', revision } };
            if (mutation.content?.t !== 'plain') throw new Error('Expected plain coding row');
            record = PromptLibraryRecordV1Schema.parse(mutation.content.v);
            revision += 1;
            return { body: { status: 'updated', revision, cursor: revision } };
        } });
        homes.answer(serverId, PROMPT_LIBRARY_ROWS_ROUTE_V1, { select: () => ({ body: { status: 'listed', rows: [
            { key: 'coding', revision, content: { t: 'plain', v: record } },
            ...PromptLibraryCatalogKeyV1Schema.options.filter(key => key !== 'coding')
                .map(key => ({ key, revision: 1, content: null })),
        ] } }) });
        const result = await createDefaultActionExecutor().execute('memory.remember', { scope: 'account', text: 'Prefer tea' },
            { surface: 'ui', serverId });
        expect(result, JSON.stringify(result)).toMatchObject({ ok: true, result: { artifactId: expect.any(String) } });
        if (!result.ok || typeof result.result !== 'object' || result.result === null || !('artifactId' in result.result)
            || typeof result.result.artifactId !== 'string') throw new Error('Missing memory receipt');
        expect(record).toMatchObject({ value: { entries: [{ id: 'instructions' }, { id: 'account.memory',
            ref: { artifactId: result.result.artifactId, serverId: accountServerId } }] } });
        expect(JSON.parse(homes.artifacts(serverId).readPlainBody(result.result.artifactId)!)).toMatchObject({
            index: [{ text: 'Prefer tea', sourceSessionRef: null }], topics: [],
        });
    });

    it('creates personal Project memory without a Session and preserves the captured row siblings', async () => {
        const { resolveServerProfileScopeIdForIdentifier } = await import('@/sync/domains/server/serverProfiles');
        const projectServerId = resolveServerProfileScopeIdForIdentifier(serverId);
        const key = { kind: 'project-organization' as const, serverId: projectServerId, projectKey: 'project' };
        let value = ProjectAccountOrganizationV1Schema.parse({ pinned: true, hidden: true, promptStack: [
            { id: 'instructions', ref: { kind: 'doc', artifactId: 'instructions' }, enabled: true, placement: 'system_append' },
        ] });
        let revision = 4;
        homes.answer(serverId, `POST ${PROJECT_ACCOUNT_ROWS_ROUTE_V1}/list`, { select: () => ({ body:
            createPlainProjectAccountRowListFixture({ organizations: [{ key, value, revision }] }) }) });
        homes.answer(serverId, `POST ${PROJECT_ACCOUNT_ROWS_ROUTE_V1}/mutate`, { select: input => {
            const request = ProjectAccountRowMutationRequestV1Schema.parse(input);
            const mutation = request.mutations[0]!;
            expect(mutation.expectedRevision).toBe(4);
            if (mutation.expectedRevision !== revision) return { status: 409, body: { status: 'conflict', key, revision } };
            if (mutation.content?.t !== 'plain' || !mutation.content.v || typeof mutation.content.v !== 'object'
                || !('value' in mutation.content.v)) throw new Error('Missing plain organization value');
            value = ProjectAccountOrganizationV1Schema.parse(mutation.content.v.value);
            revision += 1;
            return { body: { status: 'updated', rows: [{ key, content: mutation.content, revision }], cursor: revision } };
        } });
        const result = await createDefaultActionExecutor().execute('memory.remember', {
            scope: 'project', projectRef: { serverId: projectServerId, projectKey: 'project' }, text: 'Project convention',
        }, { surface: 'ui' });
        expect(result, JSON.stringify(result)).toMatchObject({ ok: true, result: { attachment: 'attached' } });
        expect(value).toMatchObject({ pinned: true, hidden: true,
            promptStack: [{ id: 'instructions' }, { id: 'project.memory', ref: { serverId: projectServerId } }] });
    });

    it('projects only Source memory context when its Project also retains a personal row', async () => {
        const { resolveServerProfileScopeIdForIdentifier } = await import('@/sync/domains/server/serverProfiles');
        const projectServerId = resolveServerProfileScopeIdForIdentifier(serverId);
        const key = { kind: 'project-organization' as const, serverId: projectServerId, projectKey: 'project' };
        const entry = (id: string) => ({ id, ref: { kind: 'doc' as const, artifactId: id }, enabled: true, placement: 'system_append' as const });
        homes.answer(serverId, `POST ${PROJECT_ACCOUNT_ROWS_ROUTE_V1}/list`, { body: createPlainProjectAccountRowListFixture({
            workspaceRefs: [{ id: 'checkout', serverId: projectServerId, machineId: 'machine', rootPath: '/repo', projectKey: 'project', createdAtMs: 1,
                source: { sourceId: 'source', revision: 1 } }],
            organizations: [{ key, revision: 4, value: { pinned: true, promptStack: [entry('personal.memory')] } }],
        }) });
        homes.answer(serverId, `/v1/projects/sources/source?serverId=${encodeURIComponent(projectServerId)}`, { body: {
            ok: true, canManage: false, source: { id: 'source', revision: 2, name: 'Shared project', createdByAccountId: 'account-a', audience: [],
                repository: { provider: { id: 'github', kind: 'github', displayName: 'GitHub', baseUrl: 'https://github.com' },
                    repository: { nameWithOwner: 'happier-dev/happier', cloneUrl: 'https://github.com/happier-dev/happier.git', visibility: 'public' }, protocol: 'https' },
                attachments: [{ purpose: 'context', entry: entry('source.memory') }, { purpose: 'dashboard', ref: { kind: 'doc', artifactId: 'dashboard' } }],
            },
        } });
        const { captureLazyActionAccountContext } = await import('./actionAccountContext');
        const { readUiMemoryInheritedContext } = await import('./readUiMemoryInheritedContext');
        const account = await captureLazyActionAccountContext(serverId);
        try {
            const inherited = await readUiMemoryInheritedContext(account, { revision: 1,
                metadata: { machineId: 'machine', workspaceId: 'checkout', projectId: 'project', path: '/repo' },
            }, { surface: 'ui' });
            expect(inherited.projectEntries).toEqual([{ ...entry('source.memory'), ref: { kind: 'doc', artifactId: 'source.memory', serverId: projectServerId } }]);
        } finally { account.dispose(); }
    });

    it('routes qualified memory reads to their Home and writes private facts through real Artifact CAS', async () => {
        const artifactId = await sync.createArtifactWithHeader({ v: 1, kind: 'memory_doc.v1', title: 'Memory' },
            JSON.stringify({ v: 1, facts: [], archive: [] }));
        homes.answer(serverId, `/v1/artifacts/${artifactId}/access/grants`, { body: { artifactId, ownerAccountId: 'account-a', access: 'owner', grants: [] } });
        homes.answer(serverId, `/v1/public-shares?${new URLSearchParams({ subjectKind: 'artifact', subjectId: artifactId })}`, { body: { publicShares: [] } });
        const executor = createDefaultActionExecutor();
        const ref = { kind: 'doc' as const, artifactId, serverId };
        const row = homes.artifacts(serverId).read(artifactId)!;
        const write = await executor.execute('memory.remember', { ref, expectedRevision: { headerVersion: row.headerVersion, bodyVersion: row.bodyVersion },
            text: 'Prefer tea; password=secret' }, { surface: 'ui', serverId });
        expect(write).toEqual(expect.objectContaining({ ok: true, result: expect.objectContaining({ artifactId }) }));
        expect(JSON.parse(homes.artifacts(serverId).readPlainBody(artifactId)!)).toMatchObject({ v: 1,
            index: [{ text: 'Prefer tea; password: [REDACTED]', sourceSessionRef: null }], topics: [] });
        await connection?.dispose();
        const focusedServerId = await homes.addHome({ name: 'Focused Home', serverUrl: 'https://focused-memory-actions.test', accountId: 'account-b' });
        connection = await restoreServerAccountForTest({ serverUrl: 'https://focused-memory-actions.test', accountId: 'account-b' });
        installHomeGovernanceBoundaries(homes);
        storage.getState().activateProfileScope({ serverId: focusedServerId, accountId: 'account-b' });
        const { getActiveServerAccountScope } = await import('@/sync/domains/scope/activeServerAccountScope');
        expect(getActiveServerAccountScope()).toEqual({ serverId: focusedServerId, accountId: 'account-b' });
        const read = await executor.execute('memory.read', { ref }, { surface: 'ui' });
        expect(read).toEqual(expect.objectContaining({ ok: true, result: expect.objectContaining({ artifactId,
            body: expect.objectContaining({ index: [expect.objectContaining({ text: 'Prefer tea; password: [REDACTED]' })], topics: [] }) }) }));
        expect(homes.artifacts(focusedServerId).read(artifactId)).toBeNull();
    });

    it('routes exact existing-session model selections to the session-host private transition owner', async () => {
        seedSession(true);
        const denied = { ok: false, status: 'owner_unavailable', activeSelection: selection('native-model'),
            requestedSelection: selection('provider-model', 'pc_work'), reason: 'session_host_unavailable' };
        rpc.session.mockResolvedValueOnce(denied).mockResolvedValueOnce({ ok: true, status: 'applied', activeSelection: selection('default') })
            .mockResolvedValueOnce({ ok: true, status: 'applied', activeSelection: selection('provider-next', 'pc_active') });
        expect(await executeModel(modelInput('provider-model', 'pc_work'))).toEqual({ ok: false, errorCode: 'owner_unavailable', error: 'owner_unavailable',
            details: { status: denied.status, activeSelection: denied.activeSelection, requestedSelection: denied.requestedSelection, reason: denied.reason } });
        expect(rpc.session).toHaveBeenLastCalledWith({ sessionId: 'session_1', serverId, method: 'session.model.transition', payload: { v: 1, selection: selection('provider-model', 'pc_work') } });
        expect(await executeModel(modelInput('default', null))).toMatchObject({ ok: true, result: { status: 'applied', activeSelection: selection('default'), sessionId: 'session_1' } });
        seedSession(true, { providerBindingV1: binding, modelSelectionIntentV1: { v: 1, updatedAt: 10, selection: selection('pending-restart-model', 'pc_pending') } });
        expect(await executeModel(modelInput('provider-next'))).toMatchObject({ ok: true, result: { activeSelection: selection('provider-next', 'pc_active') } });
        expect(rpc.session).toHaveBeenLastCalledWith({ sessionId: 'session_1', serverId, method: 'session.model.transition', payload: { v: 1, selection: selection('provider-next', 'pc_active') } });
    });

    it('returns owner_unavailable when the active session transition owner transport rejects', async () => {
        seedSession(true);
        const sentinels = ['raw-model-transition-token-sentinel', 'raw-model-transition-url-sentinel', 'raw-model-transition-path-sentinel'];
        rpc.session.mockRejectedValueOnce(new Error(`client_secret=${sentinels[0]} https://alice:${sentinels[1]}@example.test/model?access_token=${sentinels[0]} /Users/alice/${sentinels[2]}/settings.json`));
        const result = await executeModel(modelInput('provider-model', 'pc_work'));
        expect(result).toMatchObject({ ok: false, errorCode: 'owner_unavailable', error: 'owner_unavailable',
            details: { status: 'owner_unavailable', activeSelection: null, requestedSelection: selection('provider-model', 'pc_work') } });
        for (const sentinel of sentinels) expect(JSON.stringify(result)).not.toContain(sentinel);
        expect(homes.requests.some(({ path, input }) => path.startsWith('/v2/sessions') && input !== null)).toBe(false);
    });

    it('records inactive-session model intent through the existing structured metadata-CAS owner', async () => {
        const remote = serveSession(seedSession(false));
        for (const [modelId, providerConnectionId] of [['provider-model', 'pc_work'], ['default', null]] as const) {
            expect(await executeModel(modelInput(modelId, providerConnectionId))).toMatchObject({ ok: true, result: {
                status: 'intent_updated', sessionId: 'session_1', modelId, updatedAt: expect.any(Number) } });
            expect(remote.readMetadata().modelSelectionIntentV1).toMatchObject({ v: 1, updatedAt: expect.any(Number), selection: selection(modelId, providerConnectionId) });
        }
        expect(remote.writes.map((input) => SessionMetadataInactiveModelIntentPatchV1Schema.parse(input).inactiveModelIntent.sessionExpectation))
            .toEqual([{ kind: 'inactive_model_intent' }, { kind: 'inactive_model_intent' }]);
        expect(rpc.session).not.toHaveBeenCalled();
    });

    it('composes retained completed-model evidence through usage query, exact Apply/Undo and intervening-edit refusal', async () => {
        vi.stubGlobal('fetch', homes.request);
        const heavy = selection('heavy-model');
        const session = seedSession(false, { modelSelectionIntentV1: { v: 1, updatedAt: 250, selection: heavy } });
        let race = false;
        let reads = 0;
        const remote = serveSession(session, undefined, async () => {
            if (race && ++reads === 2) remote.replaceMetadata({ ...remote.readMetadata(),
                modelSelectionIntentV1: { v: 1, updatedAt: 900, selection: selection('intervening-model') } });
        });
        const tokens = { input: 10, output: 5, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 15 };
        const accounting = UsageAnalyticsQueryResponseSchema.parse({ v: 1,
            priceCatalog: { v: 1, models: {
                'light-model': { inputUsdPerMillion: 1, outputUsdPerMillion: 1 },
                'heavy-model': { inputUsdPerMillion: 4, outputUsdPerMillion: 4 },
            }, provenance: { source: 'litellm', origin: 'cached', asOfMs: 200, revision: 'fixture-catalog', fetchStatus: 'ready' } },
            totals: { tokens: { ...tokens, input: 20, output: 10, total: 30 }, eventCount: 2,
                cost: { reportedUsd: 5, estimatedUsd: 0, currency: 'USD', costSource: 'provider_reported' } },
            contributions: [{ id: 'light-cost', observedAtMs: 90, turnId: 'light-turn', modelId: 'light-model', amount: 1 },
                { id: 'heavy-cost', observedAtMs: 190, turnId: 'heavy-turn', modelId: 'heavy-model', amount: 4 }].map(row => ({
                    id: row.id, observedAtMs: row.observedAtMs, turnId: row.turnId, modelId: row.modelId,
                    sessionId: 'session_1', agentId: 'claude', providerConnectionId: null, providerAttribution: 'known', machineId: 'machine_1',
                    projectKey: null, workspaceId: null, source: 'native', tokens,
                    cost: { reportedUsd: row.amount, estimatedUsd: 0, currency: 'USD', costSource: 'provider_reported' },
                })),
            coverage: { status: 'complete', reasons: [], sources: [{ source: 'native', path: 'native', status: 'available',
                eventCount: 2, historyComplete: true, asOfMs: 200 }], missingDimensions: [], ranked: [],
                range: { startMs: 0, endMs: 1000, complete: true } },
        });
        homes.answer(serverId, '/v1/account/encryption/currentness', { body: createPlainAccountEncryptionCurrentnessFixture() });
        homes.answer(serverId, '/v2/usage/query', { body: accounting });
        homes.answer(serverId, '/v1/sessions/session_1/turns', { body: { v: 1, sessionId: 'session_1', updatedAt: 200,
            turns: [{ turnId: 'light-turn', startedAt: 50, terminalAt: 100, updatedAt: 100, status: 'completed', agentId: 'claude' },
                { turnId: 'heavy-turn', startedAt: 150, terminalAt: 200, updatedAt: 200, status: 'completed', agentId: 'claude' }] } });
        const messages = ['light', 'heavy'].flatMap((kind, index) => {
            const startedAt = index === 0 ? 50 : 150;
            const composition = UsagePromptCompositionSchema.parse({ v: 1, evidenceId: `${kind}-request`, sessionId: 'session_1',
                turnId: null, inputId: `${kind}-input`, observedAtMs: startedAt, boundary: 'host_pre_dispatch',
                deliveryKind: 'newTurn', coverage: 'host_only', components: [], nativePrefix: null, contextWindowTokens: null,
                requestIdentity: { scopeKey: 'a'.repeat(64), digest: 'b'.repeat(64), selection: selection(`${kind}-model`) } });
            return [{ id: `${kind}-input-row`, seq: index * 2, localId: `${kind}-input`, createdAt: startedAt,
                content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'PRIVATE matched work' } } },
                deliveryResolution: { v: 1, kind: 'provider_accepted', content: { t: 'plain', v: { v: 1,
                    acceptedAtMs: startedAt, delivery: { kind: 'newTurn', turnId: `${kind}-turn` } } } } },
            { id: `${kind}-composition-row`, seq: index * 2 + 1, localId: null, createdAt: startedAt,
                content: { t: 'plain', v: { role: 'agent', content: { type: 'event', id: `${kind}-event`,
                    data: { type: 'prompt-composition', composition } } } } }];
        });
        homes.answer(serverId, '/v1/sessions/session_1/messages', { body: { messages, hasMore: false } });
        const query = normalizeUsageQuery({ session: 'session_1', period: { startMs: 0, endMs: 1000 } });
        const executor = createDefaultActionExecutor();
        const read = async () => {
            const queried = await executor.execute('usage.query', { queries: [query] }, { serverId, surface: 'ui' });
            expect(queried, JSON.stringify(queried)).toMatchObject({ ok: true });
            const batch = UsageQueryBatchResultSchema.parse(queried.ok ? queried.result : null);
            expect(JSON.stringify(batch)).not.toContain('PRIVATE matched work');
            const finding = batch.results[0]?.coach?.findings.find(finding => finding.detectorId === 'model_misfit');
            expect(finding, JSON.stringify({ coverage: batch.results[0]?.accounting?.coverage,
                howYouWork: batch.results[0]?.howYouWork?.detailStatus, coach: batch.results[0]?.coach?.evaluations,
                requests: homes.requests.map(row => row.path) })).toBeDefined();
            return finding;
        };
        const finding = await read();
        expect(finding).toMatchObject({ remedy: { kind: 'model', modelId: 'light-model', expected: { owner: 'inactive', updatedAt: 250 } } });
        if (!finding) throw new Error('Expected witnessed model proposal');
        const apply = () => executor.execute('usage.coach.apply', { query, evidenceKey: finding.evidenceKey }, { serverId, surface: 'ui' });
        const applied = await apply();
        expect(applied, JSON.stringify(applied)).toMatchObject({ ok: true });
        const receipt = UsageCoachApplyResultSchema.parse(applied.ok ? applied.result : null);
        expect(receipt.reversal).toMatchObject({ kind: 'model', owner: { before: heavy, applied: selection('light-model') } });
        expect(remote.readMetadata().modelSelectionIntentV1?.selection).toEqual(selection('light-model'));
        const undo = () => executor.execute('usage.coach.undo', { query, evidenceKey: finding.evidenceKey, reversal: receipt.reversal }, { serverId, surface: 'ui' });
        expect(await undo()).toMatchObject({ ok: true, result: { kind: 'undone' } });
        expect(remote.readMetadata().modelSelectionIntentV1?.selection).toEqual(heavy);
        const second = await apply();
        expect(second).toMatchObject({ ok: true });
        const secondReceipt = UsageCoachApplyResultSchema.parse(second.ok ? second.result : null);
        remote.replaceMetadata({ ...remote.readMetadata(), modelSelectionIntentV1: { v: 1, updatedAt: 800, selection: selection('intervening-model') } });
        expect(await executor.execute('usage.coach.undo', { query, evidenceKey: finding.evidenceKey, reversal: secondReceipt.reversal }, { serverId, surface: 'ui' }))
            .toMatchObject({ ok: false });
        expect(remote.readMetadata().modelSelectionIntentV1?.selection?.modelId).toBe('intervening-model');
        remote.replaceMetadata({ ...remote.readMetadata(), modelSelectionIntentV1: { v: 1, updatedAt: 850, selection: heavy } });
        const beforeRace = remote.writes.length;
        race = true;
        expect(await apply()).toMatchObject({ ok: false });
        expect(remote.writes).toHaveLength(beforeRace);
        expect(remote.readMetadata().modelSelectionIntentV1?.selection?.modelId).toBe('intervening-model');
    });

    it('refuses captured inactive model mutation when its Account retires during the actual metadata read', async () => {
        vi.stubGlobal('fetch', homes.request);
        const readEntered = createDeferred<void>();
        const releaseRead = createDeferred<void>();
        const session = seedSession(false, { modelSelectionIntentV1: { v: 1, updatedAt: 10, selection: selection('before-model') } });
        const remote = serveSession(session, undefined, async () => {
            readEntered.resolve();
            await releaseRead.promise;
        });
        const mutation = createDefaultActionExecutor().execute('session.model.set', {
            ...modelInput('after-model', null), captureBefore: true,
        }, { serverId, surface: 'ui' });
        try {
            const admission = await Promise.race([
                readEntered.promise.then(() => ({ kind: 'read' as const })),
                mutation.then(result => ({ kind: 'settled' as const, result })),
            ]);
            expect(admission, JSON.stringify(homes.requests.map(({ path }) => path))).toEqual({ kind: 'read' });
            await homes.switchAccount(serverId, 'replacement-account');
        } finally {
            releaseRead.resolve();
        }
        expect(await mutation).toMatchObject({ ok: false });
        expect(remote.writes).toEqual([]);
        expect(remote.readMetadata().modelSelectionIntentV1).toEqual(session.metadata?.modelSelectionIntentV1);
    });

    it('refuses an omitted-connection model selection when Session Provider state is unreadable', async () => {
        for (const active of [true, false]) {
            // Corrupt persisted bytes enter at the Home/store boundary; production parsing remains real.
            const unreadable = active ? { ...binding, connectionRevision: 'not-a-number' } : { selection: { providerConnectionId: 'pc_work' } };
            const session = seedSession(active);
            const metadata = { ...session.metadata, [active ? 'providerBindingV1' : 'modelSelectionIntentV1']: unreadable };
            storage.getState().applySessions([{ ...session, metadata: metadata as Session['metadata'] }]);
            expect(await executeModel(modelInput('next-model'))).toEqual({ ok: false, errorCode: 'model_selection_session_provider_state_unreadable', error: 'model_selection_session_provider_state_unreadable' });
        }
        expect(rpc.session).not.toHaveBeenCalled();
        expect(homes.requests.some(({ path, input }) => path.startsWith('/v2/sessions') && input !== null)).toBe(false);
    });

    it('reroutes an inactive snapshot through the live transition owner after the conditioned metadata CAS observes activation', async () => {
        const session = seedSession(false, { modelSelectionIntentV1: { v: 1, updatedAt: 10, selection: selection('pending-model', 'pc_pending') } });
        const remote = serveSession(session, () => remote.activate({ ...session.metadata!, providerBindingV1: binding }));
        rpc.session.mockResolvedValueOnce({ ok: true, status: 'applied', activeSelection: selection('provider-next', 'pc_active') });
        expect(await executeModel(modelInput('provider-next'))).toMatchObject({ ok: true, result: { status: 'applied', activeSelection: selection('provider-next', 'pc_active') } });
        expect(remote.writes).toHaveLength(1);
        expect(rpc.session).toHaveBeenLastCalledWith({ sessionId: 'session_1', serverId, method: 'session.model.transition', payload: { v: 1, selection: selection('provider-next', 'pc_active') } });
    });

    it('does not retry metadata or invoke an unproven owner after an active conflict', async () => {
        const session = seedSession(false);
        const remote = serveSession(session);
        homes.answer(serverId, 'PATCH /v2/sessions/session_1', { body: { code: 'session_active' }, status: 409 });
        expect(await executeModel(modelInput('provider-next'))).toMatchObject({ ok: false, errorCode: 'owner_unavailable', details: { reason: 'session_model_transition_owner_unproven', requestedSelection: selection('provider-next') } });
        expect(homes.requestsFor('/v2/sessions/session_1').filter(({ input }) => input !== null)).toHaveLength(1);
        expect(remote.readMetadata().modelSelectionIntentV1).toBeUndefined();
        expect(rpc.session).not.toHaveBeenCalled();
    });

    it('reports an inactive model intent as superseded when a newer CAS winner is observed', async () => {
        const session = seedSession(false);
        let first = true;
        const remote = serveSession(session, () => {
            if (!first) return;
            first = false;
            remote.replaceMetadata({ ...session.metadata!, modelSelectionIntentV1: { v: 1, updatedAt: Number.MAX_SAFE_INTEGER, selection: selection('newer-model') } });
        });
        expect(await executeModel(modelInput('provider-model', 'pc_work'))).toMatchObject({ ok: false, errorCode: 'superseded', details: {
            status: 'superseded', requestedSelection: selection('provider-model', 'pc_work'), reason: 'accepted_intent_was_superseded' } });
        expect(remote.readMetadata().modelSelectionIntentV1?.selection?.modelId).toBe('newer-model');
        expect(rpc.session).not.toHaveBeenCalled();
    });

    it.each(['updated', 'conflict'] as const)('prompt catalog export preserves row neighbors and requires the captured row acknowledgement: %s', async outcome => {
        const artifactId = await sync.createArtifactWithHeader({ v: 1, kind: 'prompt_doc.v2', title: 'Review', tags: [], folderId: null, origin: 'user', locked: false },
            JSON.stringify({ v: 1, markdown: '# Review', createdAtMs: 1, updatedAtMs: 1 }));
        const catalog = serveExternalLinksCatalog(outcome);
        const settings = storage.getState().settings;
        await servePromptTransfers();
        const input = { artifactId, machineId: 'machine_1', assetTypeId: 'claude.command', scope: 'user', targetPath: 'review.md' };
        const result = await createDefaultActionExecutor().execute('prompt_asset.export', input, { serverId, surface: 'ui' });
        if (outcome === 'updated') {
            expect(result, JSON.stringify(result)).toMatchObject({ ok: true, result: { artifactId, exported: true } });
            expect(catalog.read().record.value.links).toEqual(expect.arrayContaining([
                expect.objectContaining({ id: 'neighbor-link' }), expect.objectContaining({ artifactId, machineId: 'machine_1' }),
            ]));
            expect(catalog.read().revision).toBe(5);
        } else {
            expect(result).toMatchObject({ ok: false, errorCode: 'conflict', details: { artifactId, exported: true } });
            expect(catalog.read().record.value.links.map(link => link.id)).toEqual(['neighbor-link']);
        }
        expect(catalog.mutations, JSON.stringify(result)).toHaveLength(1);
        expect(catalog.mutations[0]).toMatchObject({ expectedRevision: 4 });
        expect(rpc.machine).toHaveBeenCalledWith(expect.objectContaining({ serverId, machineId: 'machine_1', method: 'daemon.directTransfer.import.prepare' }));
        expect(homes.requestsFor('/v2/account/settings').filter(request => request.input !== null)).toEqual([]);
        expect(storage.getState().settings).toBe(settings);
    });

    it.each(['updated', 'conflict'] as const)('prompt catalog registry install preserves row neighbors and requires the captured row acknowledgement: %s', async outcome => {
        const catalog = serveExternalLinksCatalog(outcome);
        const settings = storage.getState().settings;
        await servePromptTransfers();
        const result = await createDefaultActionExecutor().execute('prompt_registry.install', {
            machineId: 'machine_1', sourceId: registryItem.sourceId, itemId: registryItem.itemId, configuredSources: [],
            installTarget: { assetTypeId: 'agents.skill', scope: 'user', targetName: 'review' },
        }, { serverId, surface: 'ui' });
        if (outcome === 'updated') {
            expect(result, JSON.stringify(result)).toMatchObject({ ok: true, result: { exported: true, artifactId: expect.any(String) } });
            if (!result.ok) throw new Error(result.error);
            const artifactId = (result.result as { artifactId: string }).artifactId;
            expect(JSON.parse(homes.artifacts(serverId).readPlainBody(artifactId) ?? 'null')).toMatchObject({ entries: registryItem.bundleBody.entries });
            expect(catalog.read().record.value.links).toEqual(expect.arrayContaining([
                expect.objectContaining({ id: 'neighbor-link' }), expect.objectContaining({ artifactId, machineId: 'machine_1' }),
            ]));
            expect(catalog.read().revision).toBe(5);
        } else {
            expect(result).toMatchObject({ ok: false, errorCode: 'conflict', details: { artifactId: expect.any(String), exported: true,
                response: { ok: true, externalRef: { skillName: 'review' }, digest: 'digest-1' } } });
            expect(catalog.read().record.value.links.map(link => link.id)).toEqual(['neighbor-link']);
        }
        expect(catalog.mutations, JSON.stringify(result)).toHaveLength(1);
        expect(catalog.mutations[0]).toMatchObject({ expectedRevision: 4 });
        expect(rpc.machine).toHaveBeenCalledWith(expect.objectContaining({ serverId, machineId: 'machine_1', method: 'daemon.directTransfer.export.prepare', payload: expect.objectContaining({ sourceId: registryItem.sourceId, itemId: registryItem.itemId }) }));
        expect(rpc.machine).toHaveBeenCalledWith(expect.objectContaining({ serverId, machineId: 'machine_1', method: 'daemon.promptRegistry.install' }));
        expect(homes.requestsFor('/v2/account/settings').filter(request => request.input !== null)).toEqual([]);
        expect(storage.getState().settings).toBe(settings);
    });

    it('prompt catalog registry install does not begin external installation after cancellation during the Machine download', async () => {
        const catalog = serveExternalLinksCatalog('updated');
        await servePromptTransfers();
        const controller = new AbortController();
        const daemon = rpc.machine.getMockImplementation();
        if (!daemon) throw new Error('Missing genuine daemon transport boundary');
        rpc.machine.mockImplementation(async (request: DaemonRequest) => {
            const response = await daemon(request);
            if (request.method === 'daemon.directTransfer.export.release') controller.abort();
            return response;
        });
        const disposition = await createDefaultActionExecutor().execute('prompt_registry.install', {
            machineId: 'machine_1', sourceId: registryItem.sourceId, itemId: registryItem.itemId, configuredSources: [],
            installTarget: { assetTypeId: 'agents.skill', scope: 'user', targetName: 'review' },
        }, { serverId, surface: 'ui', signal: controller.signal }).then(
            result => ({ kind: 'returned' as const, result }),
            (error: unknown) => ({ kind: 'rejected' as const, error }),
        );
        // The UI Account wrapper can reject cancellation while the Protocol
        // executor can return its failure envelope; neither permits a later effect.
        if (disposition.kind === 'rejected') expect(disposition.error).toMatchObject({ name: 'AbortError' });
        else {
            expect(disposition.result).toMatchObject({ ok: false });
            expect(disposition.result.ok ? undefined : disposition.result.details).not.toEqual(expect.objectContaining({ exported: true }));
        }
        expect(rpc.machine.mock.calls.map(([request]) => request).filter((request: DaemonRequest) => request.method === 'daemon.promptRegistry.install')).toEqual([]);
        expect(homes.artifacts(serverId).list()).toEqual([]);
        expect(catalog.mutations).toEqual([]);
    });

    it('prompt catalog registry install retains its acknowledged Machine effect when Account Artifact creation is refused', async () => {
        const catalog = serveExternalLinksCatalog('updated');
        await servePromptTransfers();
        homes.answer(serverId, 'POST /v1/artifacts', { status: 503, body: { error: 'artifact_write_unavailable' } });
        const result = await createDefaultActionExecutor().execute('prompt_registry.install', {
            machineId: 'machine_1', sourceId: registryItem.sourceId, itemId: registryItem.itemId, configuredSources: [],
            installTarget: { assetTypeId: 'agents.skill', scope: 'user', targetName: 'review' },
        }, { serverId, surface: 'ui' });
        expect(result, JSON.stringify(result)).toMatchObject({ ok: false, details: { exported: true,
            response: { ok: true, externalRef: { skillName: 'review' }, digest: 'digest-1' } } });
        expect(JSON.stringify(result)).not.toContain(registryItem.bundleBody.entries[0]!.contentBase64);
        expect(JSON.stringify(result)).not.toContain(registryItem.title);
        expect(homes.artifacts(serverId).list()).toEqual([]);
        expect(catalog.mutations).toEqual([]);
        expect(homes.requestsFor('/v2/account/settings').filter(request => request.input !== null)).toEqual([]);
    });

    it.each(['prompt_asset.export', 'prompt_registry.install'] as const)('prompt catalog %s refuses an unavailable row before external effects', async actionId => {
        const artifactId = await sync.createArtifactWithHeader({ v: 1, kind: 'prompt_doc.v2', title: 'Review', tags: [], folderId: null, origin: 'user', locked: false },
            JSON.stringify({ v: 1, markdown: '# Review', createdAtMs: 1, updatedAtMs: 1 }));
        const catalog = serveExternalLinksCatalog('unavailable');
        await servePromptTransfers();
        const input = actionId === 'prompt_asset.export'
            ? { artifactId, machineId: 'machine_1', assetTypeId: 'claude.command', scope: 'user', targetPath: 'review.md' }
            : { machineId: 'machine_1', sourceId: registryItem.sourceId, itemId: registryItem.itemId, configuredSources: [],
                installTarget: { assetTypeId: 'agents.skill', scope: 'user', targetName: 'review' } };
        const result = await createDefaultActionExecutor().execute(actionId, input, { serverId, surface: 'ui' });
        expect(result).toMatchObject({ ok: false });
        expect(rpc.machine).not.toHaveBeenCalled();
        expect(catalog.mutations).toEqual([]);
        expect(homes.requestsFor('/v2/account/settings').filter(request => request.input !== null)).toEqual([]);
    });

    it.each(['prompt_asset.export', 'prompt_registry.install'] as const)('prompt catalog %s keeps an explicit inactive source Account row while an independent Home is displayed', async actionId => {
        const artifactId = await sync.createArtifactWithHeader({ v: 1, kind: 'prompt_doc.v2', title: 'Review', tags: [], folderId: null, origin: 'user', locked: false },
            JSON.stringify({ v: 1, markdown: '# Review', createdAtMs: 1, updatedAtMs: 1 }));
        const catalog = serveExternalLinksCatalog('updated');
        const displayedUrl = `https://displayed-${actionId.replaceAll('_', '-')}.test`;
        const displayedServerId = await homes.addHome({ name: 'Displayed Home', serverUrl: displayedUrl, accountId: 'account-b' });
        await connection?.dispose();
        connection = await restoreServerAccountForTest({ serverUrl: displayedUrl, accountId: 'account-b' });
        installHomeGovernanceBoundaries(homes);
        const displayedScope = { serverId: displayedServerId, accountId: 'account-b' };
        storage.getState().activateProfileScope(displayedScope);
        storage.getState().applySettingsForScope(displayedScope, baseline.settings, 11);
        const displayedPreferences = storage.getState().settings;
        await servePromptTransfers();
        const input = actionId === 'prompt_asset.export'
            ? { artifactId, machineId: 'machine_1', assetTypeId: 'claude.command', scope: 'user', targetPath: 'review.md' }
            : { machineId: 'machine_1', sourceId: registryItem.sourceId, itemId: registryItem.itemId, configuredSources: [],
                installTarget: { assetTypeId: 'agents.skill', scope: 'user', targetName: 'review' } };
        const result = await createDefaultActionExecutor().execute(actionId, input, { serverId, surface: 'ui' });
        expect(result, JSON.stringify(result)).toMatchObject({ ok: true, result: { exported: true } });
        expect(catalog.read().record.value.links).toHaveLength(2);
        expect(catalog.mutations[0]).toMatchObject({ expectedRevision: 4 });
        expect(homes.requestsFor(`${PROMPT_LIBRARY_ROWS_ROUTE_V1}/external-links`).filter(request => request.input !== null))
            .toEqual([expect.objectContaining({ serverId })]);
        expect(storage.getState().settingsScope).toEqual(displayedScope);
        expect(storage.getState().settings).toEqual(displayedPreferences);
        expect(storage.getState().settings.promptExternalLinksV1?.links ?? []).toEqual([]);
        expect(homes.requestsFor('/v2/account/settings').filter(request => request.input !== null)).toEqual([]);
        expect(homes.requestsFor(`${PROMPT_LIBRARY_ROWS_ROUTE_V1}/external-links`).filter(request => request.serverId === displayedServerId)).toEqual([]);
    });

    it.each([1, 2] as const)('preserves the immutable origin Home when approval version %s is decided through Artifact CAS', async (version) => {
        seedSession(true);
        rpc.session.mockResolvedValue({ ok: true, status: 'applied', activeSelection: selection('default') });
        const common = { status: 'open', createdAtMs: 1, updatedAtMs: 1, createdBy: { surface: 'system', sessionId: 'session_1' },
            actionId: 'session.model.set', actionArgs: modelInput('default', null), summary: 'Change model' };
        const request = ApprovalRequestSchema.parse(version === 1 ? { ...common, v: 1, serverId } : {
            ...common, v: 2, requestedSurface: 'ui', executionOriginV1: {
                v: 1, authority: 'present_user', surface: 'ui', caller: { kind: 'host' }, serverId,
                serverIdentityId: 'srv_prompt-actions', accountId: 'account-a', principalId: 'account-a',
                credentialId: 'credential-1', actionId: 'session.model.set', requestId: 'request-1',
            },
        });
        const artifactId = await seededApproval(request);
        const focusedServerId = await homes.addHome({ name: 'Focused Home', serverUrl: 'https://focused-prompt-actions.test', accountId: 'account-b' });
        const result = await createDefaultActionExecutor().execute('approval.request.decide', { artifactId, decision: 'approve' }, { serverId, surface: 'ui' });
        const status = version === 1 ? 'failed' : 'executed';
        expect(result).toMatchObject({ ok: true, result: { status } });
        if (version === 1) {
            expect(JSON.parse(homes.artifacts(serverId).readPlainBody(artifactId) ?? 'null')).toMatchObject({ execution: { ok: false, errorCode: 'approval_stale' } });
            expect(rpc.session).not.toHaveBeenCalled();
        }
        const row = homes.artifacts(serverId).read(artifactId);
        expect(row?.headerVersion).toBeGreaterThan(1);
        const header = decodePlainArtifactStoredContent(row!.header);
        expect(header).toMatchObject({ kind: 'approval_request.v1', serverId, approvalStatus: status,
            ...(version === 2 ? { serverIdentityId: 'srv_prompt-actions' } : {}) });
        expect(JSON.parse(homes.artifacts(serverId).readPlainBody(artifactId) ?? 'null')).toMatchObject({ status });
        const updates = homes.requestsFor(`/v1/artifacts/${artifactId}`).filter(({ input }) => input !== null);
        expect(updates.length).toBeGreaterThan(0);
        expect(updates.every(({ serverId: addressedHome }) => addressedHome === serverId)).toBe(true);
        expect(homes.artifacts(focusedServerId).read(artifactId)).toBeNull();
        for (const { input } of updates) expect(input).toMatchObject({ expectedHeaderVersion: expect.any(Number), expectedBodyVersion: expect.any(Number) });
    });
    it('routes simulator runtime actions through the canonical host bridge and keeps other families fail-closed', async () => {
        seedSession(true);
        const machine = createMachineFixture({ id: 'machine_1', active: true });
        storage.setState({ machines: { machine_1: machine }, machineListByServerId: { [serverId]: [machine] } });
        const snapshot = {
            v: 1 as const,
            machineId: 'machine_1',
            generatedAt: 2_000,
            refreshState: 'idle' as const,
            resources: [],
            diagnostics: [],
        };
        const localServicePreviewSnapshot = {
            v: 1 as const,
            machineId: 'machine_1',
            generatedAt: 2_500,
            refreshState: 'idle' as const,
            resources: [],
            diagnostics: [],
        };
        const localServiceInventorySnapshot = {
            v: 1 as const,
            machineId: 'machine_1',
            generatedAt: 3_000,
            refreshState: 'idle' as const,
            entries: [],
            diagnostics: [],
        };
        const localServiceLauncherSnapshot = {
            v: 1 as const,
            machineId: 'machine_1',
            sessionId: 'session_1',
            updatedAt: 4_000,
            targets: [],
        };
        const localServiceLauncherStartResponse = {
            protocolVersion: 1 as const,
            machineId: 'machine_1',
            targetId: 'target_1',
            status: 'succeeded' as const,
            snapshot: localServiceLauncherSnapshot,
        };
        const publicExposure = {
            exposureId: 'public_preview_1',
            previewId: 'preview_1',
            sessionId: 'session_1',
            machineId: 'machine_1',
            mode: 'secret_link' as const,
            state: 'active' as const,
            publicUrl: 'https://preview.example.test/s/public_preview_1',
            issuedAt: 1_000,
            expiresAt: 601_000,
            auditEventIds: ['audit_1'],
            rateLimitProfileId: 'default',
        };
        const publicPreviewSnapshot = {
            v: 1 as const,
            machineId: 'machine_1',
            sessionId: 'session_1',
            previewId: 'preview_1',
            generatedAt: 6_000,
            refreshState: 'idle' as const,
            policy: {
                enabled: true,
                allowedModes: ['secret_link' as const],
                maxTtlMs: 600_000,
                maxConcurrentExposures: 1,
                dnsTlsRequired: true,
                auditRequired: true,
                rateLimitProfileIds: ['default'],
            },
            exposures: [publicExposure],
            diagnostics: [],
        };
        const publicPreviewCreateResponse = {
            protocolVersion: 1 as const,
            exposure: publicExposure,
            snapshot: publicPreviewSnapshot,
        };
        const redactedPublicExposure = {
            ...publicExposure,
            publicUrl: REDACTED_LOCAL_SERVICE_PUBLIC_PREVIEW_URL,
        };
        const redactedPublicPreviewSnapshot = {
            ...publicPreviewSnapshot,
            exposures: [redactedPublicExposure],
        };
        const redactedPublicPreviewCreateResponse = {
            ...publicPreviewCreateResponse,
            exposure: redactedPublicExposure,
            snapshot: redactedPublicPreviewSnapshot,
        };
        const publicPreviewCopyUrlResponse = {
            protocolVersion: 1 as const,
            machineId: 'machine_1',
            sessionId: 'session_1',
            previewId: 'preview_1',
            exposureId: 'public_preview_1',
            publicUrl: publicExposure.publicUrl,
        };
        const localServiceActionResult = {
            v: 1 as const,
            requestId: 'request_1',
            action: 'copy_url' as const,
            status: 'succeeded' as const,
            auditEvents: [{
                v: 1 as const,
                eventId: 'request_1:0:succeeded',
                requestId: 'request_1',
                machineId: 'machine_1',
                action: 'copy_url' as const,
                result: 'succeeded' as const,
                recordedAt: 5_000,
            }],
        };
        machineRpcWithServerScopeMock.mockResolvedValueOnce({
            protocolVersion: 1,
            snapshot,
        }).mockResolvedValueOnce({
            protocolVersion: 1,
            snapshot: localServicePreviewSnapshot,
        }).mockResolvedValueOnce({
            protocolVersion: 1,
            snapshot: localServiceInventorySnapshot,
        }).mockResolvedValueOnce({
            protocolVersion: 1,
            snapshot: localServiceLauncherSnapshot,
        }).mockResolvedValueOnce(localServiceLauncherStartResponse).mockResolvedValueOnce({
            protocolVersion: 1,
            result: localServiceActionResult,
        }).mockResolvedValueOnce({
            protocolVersion: 1,
            snapshot: publicPreviewSnapshot,
        }).mockResolvedValueOnce(publicPreviewCreateResponse).mockResolvedValueOnce(publicPreviewCopyUrlResponse);

        const executor = createDefaultActionExecutor();


        await expect(executeRuntime(executor, {
            actionId: 'devices.simulator.list',
            input: { type: 'simulator.devices.list' },
            context: {
                defaultSessionId: 'session_1',
                serverId,
            },
        })).resolves.toEqual(snapshot);
        expect(machineRpcWithServerScopeMock).toHaveBeenCalledWith(expect.objectContaining({
            machineId: 'machine_1',
            serverId,
        }));

        await expect(executeRuntime(executor, {
            actionId: 'localServices.preview.status',
            input: {},
            context: {
                defaultSessionId: 'session_1',
                serverId,
            },
        })).resolves.toEqual({
            generatedAt: 2_500,
            refreshState: 'idle',
            previews: [],
            diagnostics: [],
        });
        expect(machineRpcWithServerScopeMock).toHaveBeenCalledWith(expect.objectContaining({
            machineId: 'machine_1',
            serverId,
        }));

        await expect(executeRuntime(executor, {
            actionId: 'localServices.inventory.list',
            input: {},
            context: {
                defaultSessionId: 'session_1',
                serverId,
            },
        })).resolves.toEqual(localServiceInventorySnapshot);
        await expect(executeRuntime(executor, {
            actionId: 'localServices.launcher.snapshot',
            input: { sessionId: 'session_1' },
            context: {
                defaultSessionId: 'session_1',
                serverId,
            },
        })).resolves.toEqual(localServiceLauncherSnapshot);
        await expect(executeRuntime(executor, {
            actionId: 'localServices.launcher.start',
            input: {
                machineId: 'machine_1',
                targetId: 'target_1',
                sessionId: 'session_1',
            },
            context: {
                defaultSessionId: 'session_1',
                serverId,
            },
        })).resolves.toEqual(localServiceLauncherStartResponse);
        await expect(executeRuntime(executor, {
            actionId: 'localServices.actions.copyUrl',
            input: {
                requestId: 'request_1',
                target: { kind: 'inventory_entry', inventoryEntryId: 'entry_1', machineId: 'machine_1' },
                action: 'copy_url',
                force: false,
            },
            context: {
                defaultSessionId: 'session_1',
                serverId,
            },
        })).resolves.toEqual(localServiceActionResult);
        await expect(executeRuntime(executor, {
            actionId: 'localServices.publicPreview.status',
            input: {
                sessionId: 'session_1',
                previewId: 'preview_1',
            },
            context: {
                defaultSessionId: 'session_1',
                serverId,
            },
        })).resolves.toEqual(redactedPublicPreviewSnapshot);
        await expect(executeRuntime(executor, {
            actionId: 'localServices.publicPreview.create',
            input: {
                machineId: 'machine_1',
                sessionId: 'session_1',
                previewId: 'preview_1',
                mode: 'secret_link',
                ttlMs: 600_000,
            },
            context: {
                defaultSessionId: 'session_1',
                serverId,
            },
        })).resolves.toEqual(redactedPublicPreviewCreateResponse);
        await expect(executeRuntime(executor, {
            actionId: 'localServices.publicPreview.copyUrl',
            input: {
                machineId: 'machine_1',
                sessionId: 'session_1',
                previewId: 'preview_1',
                exposureId: 'public_preview_1',
            },
            context: {
                defaultSessionId: 'session_1',
                serverId,
            },
        })).resolves.toEqual(publicPreviewCopyUrlResponse);
        expect(machineRpcWithServerScopeMock.mock.calls.map(([input]) => (input as { method: string }).method)).toContain(
            'daemon.localServices.inventory.snapshot',
        );
        expect(machineRpcWithServerScopeMock.mock.calls.map(([input]) => (input as { method: string }).method)).toContain(
            'daemon.localServices.launcher.snapshot',
        );
        expect(machineRpcWithServerScopeMock.mock.calls.map(([input]) => (input as { method: string }).method)).toContain(
            'daemon.localServices.launcher.start',
        );
        expect(machineRpcWithServerScopeMock.mock.calls.map(([input]) => (input as { method: string }).method)).toContain(
            'daemon.localServices.actions.execute',
        );
        expect(machineRpcWithServerScopeMock.mock.calls.map(([input]) => (input as { method: string }).method)).toContain(
            'daemon.localServices.publicPreview.status',
        );
        expect(machineRpcWithServerScopeMock.mock.calls.map(([input]) => (input as { method: string }).method)).toContain(
            'daemon.localServices.publicPreview.create',
        );
        expect(machineRpcWithServerScopeMock.mock.calls.map(([input]) => (input as { method: string }).method)).toContain(
            'daemon.localServices.publicPreview.copyUrl',
        );

        await expect(executeRuntime(executor, {
            actionId: 'localServices.launcher.snapshot',
            input: {},
            context: {},
        })).resolves.toEqual({
            ok: false,
            errorCode: 'runtime_action_disabled',
            error: 'runtime_action_disabled:localServices:local_services_machine_unavailable',
        });
        await admitBrowserAutomation();
        await expect(executeRuntime(executor, {
            actionId: 'browser.navigate',
            input: {
                kind: 'navigate',
                commandId: 'command_missing_browser_host',
                browserSessionId: 'browser_session_1',
                viewId: 'browser_view_1',
                url: 'https://browser.example.test/',
            },
            context: {},
        })).resolves.toEqual({
            ok: false,
            errorCode: 'runtime_action_disabled',
            error: 'runtime_action_disabled:browser:browser_control_unavailable',
        });
        await expect(executeRuntime(executor, {
            actionId: 'peerMediation.observability.snapshot',
            input: {},
            context: {},
        })).resolves.toEqual({
            ok: false,
            errorCode: 'runtime_action_disabled',
            error: 'runtime_action_disabled:peerMediation:runtime_family_unimplemented',
        });
    });

    it('routes browser.navigate through a registered browser surface adapter', async () => {
        await admitBrowserAutomation();
        const {
            applyBrowserControlEvent,
            createBrowserControlState,
        } = await import('@/sync/domains/browser/control');
        const { buildBrowserAdapterCapabilities } = await import('@/sync/domains/browser/adapters/capabilities');
        const { registerBrowserRuntimeControlAdapter } = await import('@/sync/domains/browser/actions/runtimeControlRegistry');

        const browserSessionId = 'browser_session_registered';
        const viewId = 'view_registered';
        const capabilities = buildBrowserAdapterCapabilities({
            adapterKind: 'localPreview',
            supportedTargetKinds: ['localServicePreview'],
            supportedRenderEngines: ['webIframe'],
        });
        let state = [
            {
                kind: 'sessionCreated' as const,
                eventId: 'event_session',
                browserSessionId,
                profileId: 'profile_1',
                occurredAt: 1_000,
            },
            {
                kind: 'viewOpened' as const,
                eventId: 'event_view',
                browserSessionId,
                viewId,
                target: {
                    kind: 'localServicePreview' as const,
                    targetId: 'preview_1',
                    sessionId: 'session_1',
                    machineId: 'machine_1',
                    display: {
                        title: 'Preview',
                        addressLabel: 'localhost:5173',
                    },
                },
                platform: 'web' as const,
                currentUrl: 'https://preview.happier.test/',
                adapterKind: 'localPreview' as const,
                engineKind: 'webIframe' as const,
                adapterCapabilities: {
                    ...capabilities,
                    navigation: {
                        canNavigate: true,
                        canGoBack: false,
                        canGoForward: false,
                        canReload: true,
                        canStop: true,
                    },
                },
                occurredAt: 1_001,
            },
            {
                kind: 'viewFocused' as const,
                eventId: 'event_focus',
                browserSessionId,
                viewId,
                occurredAt: 1_002,
            },
        ].reduce(
            (nextState, event) => applyBrowserControlEvent(nextState, event),
            createBrowserControlState(),
        );
        const cleanup = registerBrowserRuntimeControlAdapter({
            browserSessionId,
            control: {
                readState: () => state,
                applyDispatchResult: (result) => {
                    state = result.state;
                },
            },
        });

        try {
            const executor = createDefaultActionExecutor();

            await expect(executeRuntime(executor, {
                actionId: 'browser.navigate',
                input: {
                    kind: 'navigate',
                    commandId: 'command_registered_browser_host',
                    browserSessionId,
                    viewId,
                    url: 'https://preview.happier.test/registered',
                },
                context: {},
            })).resolves.toMatchObject({
                v: 1,
                status: 'dispatched',
            });
            expect(state.viewsById[viewId]?.pendingUrl).toBe('https://preview.happier.test/registered');
        } finally {
            cleanup();
        }
    });
});
