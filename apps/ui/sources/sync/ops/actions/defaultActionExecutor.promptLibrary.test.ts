import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    ApprovalRequestSchema,
    MACHINE_PLAIN_DATA_KEY_MARKER,
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
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { installWebLockManagerMock } from '@/auth/storage/tokenStorage.web.testHelpers';

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

/** Stateful Home Session HTTP boundary. The real Sync tuple owner handles retries/currentness. */
function serveSession(session: Session, beforeWrite?: (input: unknown) => void) {
    let row = V2SessionRecordSchema.parse({
        id: session.id, createdAt: 1, updatedAt: 1, seq: 1, active: session.active, activeAt: 1,
        encryptionMode: 'plain', dataEncryptionKey: null, metadataLayoutVersion: 0,
        metadata: JSON.stringify(session.metadata), metadataVersion: session.metadataVersion,
        agentState: null, agentStateVersion: 1, share: null,
    });
    const writes: unknown[] = [];
    homes.answer(serverId, `GET /v2/sessions/${session.id}`, { select: () => ({ body: { session: row } }) });
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
/** Fake native daemon HTTP / Socket boundaries carry real encrypted finite-transfer bytes. */
function servePromptTransfers(onCommitted?: () => void) {
    const features = createRootLayoutFeaturesResponse();
    for (const featureId of ['machines.transfer', 'machines.transfer.directPeer', 'machines.peerMediation'] as const) {
        if (!tryWriteServerEnabledBitInPlace(features, featureId, true)) throw new Error(`Feature unavailable: ${featureId}`);
    }
    homes.answer(serverId, '/v1/features', { body: features });
    homes.answer(serverId, '/v1/features/authenticated', { body: features });
    const machine = createMachineFixture({ id: 'machine_1', kind: 'persistent', operationProtocolCapabilitiesRevision: 1,
        operationProtocolCapabilities: { irohMachineEndpoint: { protocolVersions: [1], endpointId: 'a'.repeat(64), directAddresses: ['127.0.0.1:48123'], relayUrls: [] } },
        daemonState: { transfer: { supported: { import: true, export: true },
            listenerClasses: { loopback_http: { enabled: true, configured: true, active: true }, tailscale_serve_https: { enabled: false, configured: false, active: false } },
            lifecycle: { mode: 'lazy_idle_shutdown', version: 1 } } } });
    storage.setState({ machines: { machine_1: machine }, machineListByServerId: { [serverId]: [machine] } });
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
                endpointCandidates: [{ kind: 'loopback_http', url: 'http://127.0.0.1:48123/machine-transfers/direct/imports/upload-1?grant=fixture' }] };
        }
        if (request.method === 'daemon.directTransfer.export.prepare') return { success: true, transferId: 'export-1',
            name: 'skill.json', sizeBytes: exportedBytes.length, expiresAt: Date.now() + DIRECT_ROUTE_GRANT_TTL_MS.finiteTransferCarrier,
            endpointCandidates: [{ kind: 'loopback_http', url: 'http://127.0.0.1:48123/machine-transfers/direct/transfers/export-1?grant=fixture' }] };
        if (request.method === 'daemon.directTransfer.export.release') return { success: true };
        if (request.method === 'daemon.promptRegistry.install') {
            onCommitted?.();
            return { ok: true, externalRef: { skillName: 'review' }, digest: 'digest-1' };
        }
        throw new Error(`Unexpected daemon transport: ${request.method}`);
    });
    setRuntimeFetch(async (input, init) => {
        const url = new URL(String(input));
        if (url.pathname === '/health' || url.pathname === '/v1/auth/ping') return Response.json({});
        if (url.origin !== 'http://127.0.0.1:48123') throw new Error(`Unexpected transfer HTTP: ${url}`);
        if (url.pathname.endsWith('/chunks/0') && init?.method === 'PUT') {
            const envelope = JSON.parse(String(init.body)) as { payloadBase64: string; encryptedDataKeyEnvelopeBase64: string };
            const bytes = await decryptEncryptedTransferChunkEnvelope({ ...envelope, transferId: 'upload-1', sequence: 0, recipientSecretKeySeed: recipient.recipientSecretKeySeed });
            uploaded = JSON.parse(new TextDecoder().decode(bytes));
            return Response.json({ success: true });
        }
        if (url.pathname.endsWith('/finalize')) {
            onCommitted?.();
            return Response.json({ success: true, finalized: { success: true, path: 'review.md', sizeBytes, result: externalResult }, sha256: 'digest-1' });
        }
        if (url.pathname.endsWith('/open')) return Response.json({ transferId: 'export-1', totalChunks: 1, sizeBytes: exportedBytes.length, manifestHash });
        if (url.pathname.endsWith('/chunks/0')) {
            const recipientPublicKeyBase64 = new Headers(init?.headers).get('x-happier-transfer-recipient-public-key');
            if (!recipientPublicKeyBase64) throw new Error('Missing transfer recipient');
            return Response.json({ transferId: 'export-1', sequence: 0,
                ...await createEncryptedTransferChunkEnvelope({ transferId: 'export-1', sequence: 0, payload: exportedBytes, recipientPublicKeyBase64 }) });
        }
        throw new Error(`Unexpected transfer HTTP: ${url}`);
    });
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

    it('passes serverId through prompt asset export operations and preserves the captured settings scope', async () => {
        const artifactId = await sync.createArtifactWithHeader({ v: 1, kind: 'prompt_doc.v2', title: 'Review', tags: [], folderId: null, origin: 'user', locked: false },
            JSON.stringify({ v: 1, markdown: '# Review', createdAtMs: 1, updatedAtMs: 1 }));
        servePromptTransfers();
        const input = { artifactId, machineId: 'machine_1', assetTypeId: 'claude.command', scope: 'user', targetPath: 'review.md' };
        expect(await createDefaultActionExecutor().execute('prompt_asset.export', input, { serverId, surface: 'ui' }))
            .toMatchObject({ ok: true, result: { artifactId, exported: true } });
        expect(storage.getState().settings.promptExternalLinksV1?.links).toEqual(expect.arrayContaining([expect.objectContaining({ artifactId, machineId: 'machine_1' })]));
        const transfer = servePromptTransfers(() => {
            storage.getState().applySettingsForScope({ serverId: 'other-home', accountId: 'account-b' }, baseline.settings, 1);
        });
        const result = await createDefaultActionExecutor().execute('prompt_asset.export', input, { serverId, surface: 'ui' });
        expect(result).toMatchObject({ ok: true, result: { artifactId, exported: true } });
        expect(transfer.readUploaded()).toMatchObject({ assetTypeId: 'claude.command', scope: 'user', targetPath: 'review.md' });
        expect(rpc.machine).toHaveBeenCalledWith(expect.objectContaining({ serverId, machineId: 'machine_1', method: 'daemon.directTransfer.import.prepare' }));
        expect(storage.getState().settingsScope).toEqual({ serverId: 'other-home', accountId: 'account-b' });
        expect(storage.getState().settings.promptExternalLinksV1?.links ?? []).toEqual([]);
    });

    it('passes serverId through prompt registry install operations and preserves the captured settings scope', async () => {
        servePromptTransfers(() => {
            storage.getState().applySettingsForScope({ serverId: 'other-home', accountId: 'account-b' }, storage.getState().settings, 1);
        });
        const result = await createDefaultActionExecutor().execute('prompt_registry.install', {
            machineId: 'machine_1', sourceId: registryItem.sourceId, itemId: registryItem.itemId, configuredSources: [],
            installTarget: { assetTypeId: 'agents.skill', scope: 'user', targetName: 'review' },
        }, { serverId, surface: 'ui' });
        expect(result).toMatchObject({ ok: true, result: { exported: true, artifactId: expect.any(String) } });
        if (!result.ok) throw new Error(result.error);
        const artifactId = (result.result as { artifactId: string }).artifactId;
        expect(JSON.parse(homes.artifacts(serverId).readPlainBody(artifactId) ?? 'null')).toMatchObject({ entries: registryItem.bundleBody.entries });
        expect(rpc.machine).toHaveBeenCalledWith(expect.objectContaining({ serverId, machineId: 'machine_1', method: 'daemon.directTransfer.export.prepare', payload: expect.objectContaining({ sourceId: registryItem.sourceId, itemId: registryItem.itemId }) }));
        expect(rpc.machine).toHaveBeenCalledWith(expect.objectContaining({ serverId, machineId: 'machine_1', method: 'daemon.promptRegistry.install' }));
        expect(storage.getState().settings.promptExternalLinksV1?.links ?? []).toEqual([]);
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
