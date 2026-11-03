import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as React from 'react';
import { act, flushHookEffects, renderHook } from '@/dev/testkit';
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
    SessionMetadataInactiveModelIntentPatchV1Schema,
    ProviderBoundModelRefSchema,
    V2SessionRecordSchema,
    type ActionId,
    type ActionExecutorContext,
    type ApprovalRequest,
} from '@happier-dev/protocol';
import { RegistryFetchRequestV1Schema, RegistryFetchResponseV1Schema } from '@happier-dev/protocol/registries';
import { ExternalActionRequestEnvelopeV1Schema, ExternalActionResponseEnvelopeV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { installPromptRegistryItemInLibrary, projectLegacySkillRegistryInstallActionResultV1 } from '@happier-dev/protocol/prompts/library/promptLibraryActionOperations';
import { PromptRegistryInstallInputSchema } from '@happier-dev/protocol/actions/actionSpecs';
import { DEFAULT_CURATED_MARKETPLACE_SOURCE_URL } from '@happier-dev/protocol/marketplace';
import { createSkillActionExecuteV1 } from '@happier-dev/protocol/prompts/library/skills/skillActionOperations';
import { SKILL_ACTION_OUTPUT_SCHEMAS_V1 } from '@happier-dev/protocol/prompts/library/skills/skillActionSchemasV1';
import { SkillReadResultV1Schema } from '@happier-dev/protocol/prompts/library/skills/skillReadV1';
import { readSkillLibraryCatalog } from '@happier-dev/protocol/prompts/library/skills/readSkillLibraryCatalog';
import { createPromptLibraryCatalogBoundary } from '@/dev/testkit/harness/promptLibraryCatalogBoundary';
import { randomUUID } from '@/platform/randomUUID';
import { normalizeUsageQuery } from '@happier-dev/protocol/inputs/usageQuery';
import { UsageQueryBatchResultSchema } from '@happier-dev/protocol/usage/resolveUsagePageAggregation';
import { createSessionReadBatchHttpBoundary } from '@/dev/testkit/harness/sessionReadBatchHttpBoundary';
import { SessionReadBatchResponseV1Schema } from '@happier-dev/protocol/sessions/read/sessionReadBatchV1';
import { UsageCoachApplyResultSchema } from '@happier-dev/protocol/usage/coach/coachActions';
import { UsageAnalyticsQueryResponseSchema } from '@happier-dev/protocol/usage/usageAnalyticsContracts';
import { UsagePromptCompositionSchema } from '@happier-dev/protocol/usage/coach/usagePromptComposition';
import { buildSessionMessagesPath } from '@happier-dev/protocol/sessions/messages/sessionMessagesPageV1';
import {
    createSessionOwnerMetadataV1, createPlainSessionOwnerMetadataEnvelopeV1, projectSessionSharedMetadataV1,
    projectSessionOwnerCompatibilityViewV1, SessionOwnerMetadataEnvelopeV1Schema,
    SessionMetadataInactiveModelIntentOwnerPatchV1Schema, SessionMetadataOwnerPatchV1Schema, SessionMetadataTuplePatchSuccessV1Schema,
} from '@happier-dev/protocol/sessions/metadata/sessionMetadataSchemasV1';
import { MetadataSchema } from '@happier-dev/session-core/state';
import { settingsParse } from '@/sync/domains/settings/settings';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { configureConnectedServerSocketBoundary, installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { readSessionOwnerMetadataView } from '@/sync/domains/session/readSessionOwnerMetadataView';
import { SessionTeamCredentialBindingMetadataPatchV1Schema } from '@happier-dev/protocol/teams/credentials/sessionBindingV1';
import { createMachineFixture, createPlainMachineRowFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { createDeferred } from '@/dev/testkit/hooks/createDeferred';
import { projectNativeJsonValueForTransport } from '@happier-dev/protocol/json/strictJsonValue';
import { installWebLockManagerMock } from '@/auth/storage/tokenStorage.web.testHelpers';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { createPlainProjectAccountRowListFixture } from '@/dev/testkit/fixtures/projectAccountRows';
import { ProjectAccountRowMutationRequestV1Schema, ProjectAccountRowPayloadV1Schema, ProjectAccountOrganizationV1Schema, PROJECT_ACCOUNT_ROWS_ROUTE_V1 } from '@happier-dev/protocol/projects/projectAccountRowsV1';
import {
    PROMPT_LIBRARY_ROWS_ROUTE_V1,
    PromptLibraryCatalogKeyV1Schema,
    PromptLibraryRowMutationV1Schema,
    PromptLibraryRecordV1Schema,
    type PromptLibraryRecordV1,
} from '@happier-dev/protocol/prompts/library/promptLibraryRowsV1';

const rpc = vi.hoisted(() => ({ machine: vi.fn(), session: vi.fn() }));
vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock().module;
});
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
    configureConnectedServerSocketBoundary(socket);
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
const { createUiPromptLibraryArtifactStore } = await import('@/sync/ops/promptLibrary/promptLibraryArtifactStore');
const { captureLazyActionAccountContext } = await import('./actionAccountContext');
const { createUiRegistryHostV1 } = await import('@/registries/registryHostDeps');
const { sync } = await import('@/sync/sync');
const { setRuntimeFetch } = await import('@/utils/system/runtimeFetch');
const { createRootLayoutFeaturesResponse } = await import('@/dev/testkit/fixtures/featureFixtures');
const { createEncryptedTransferChunkEnvelope } = await import('@/sync/domains/transfers/runtime/transferRuntime/plumbing/transferChunkEncryption');
const { createTransferManifestHasher } = await import('@/sync/domains/transfers/runtime/transferRuntime/plumbing/transferManifestHasher');
const { createDefaultActionExecutor } = await import('./defaultActionExecutor');
const { Modal } = await import('@/modal');
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
    const ownerMetadataView = MetadataSchema.parse({ path: '/repo', host: 'host', homeDir: '/home', machineId: 'machine_1', flavor: 'claude', ...overrides });
    const session = createSessionFixture({ id: 'session_1', serverId, active,
        metadataLayoutVersion: 1, ownerMetadataView,
        metadata: MetadataSchema.parse(projectSessionSharedMetadataV1({ metadata: ownerMetadataView, agentState: null })) });
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
    const encodeCurrent = (metadata: NonNullable<Session['metadata']>) => {
        const owner = createSessionOwnerMetadataV1({ metadata });
        if (!owner.ok) throw new Error(`Invalid current Session fixture: ${owner.unsupportedFields.join(', ')}`);
        return { metadata: JSON.stringify(projectSessionSharedMetadataV1({ metadata, agentState: null })),
            ownerMetadata: createPlainSessionOwnerMetadataEnvelopeV1(owner.ownerMetadata) };
    };
    let row = V2SessionRecordSchema.parse({
        id: session.id, createdAt: 1, updatedAt: 1, seq: 1, active: session.active, activeAt: 1,
        encryptionMode: 'plain', dataEncryptionKey: null, metadataLayoutVersion: session.metadataLayoutVersion ?? 0,
        metadata: JSON.stringify(session.metadata), metadataVersion: session.metadataVersion,
        ...(session.metadataLayoutVersion === 1 && session.ownerMetadataView ? encodeCurrent(session.ownerMetadataView) : {}),
        agentState: null, agentStateVersion: 1, share: null,
        responsibleAccountId: null, responsibleAccount: null,
        effectiveAccess: { v: 1, level: 'owner', sources: [{ kind: 'owner' }], capabilities: session.access?.capabilities },
    });
    const writes: unknown[] = [];
    const read = { select: async () => {
        await beforeRead?.();
        return { body: { session: row } };
    } };
    homes.answer(serverId, `GET /v2/sessions/${session.id}`, read);
    homes.answer(serverId, `GET /v2/sessions/${session.id}?accessProjectionVersion=1`, read);
    const sessionBatch = createSessionReadBatchHttpBoundary(request => request.path === '/v2/sessions/read-batch' ? undefined
        : homes.request(request.url, { method: request.method, headers: request.headers, signal: request.signal }));
    homes.answer(serverId, 'POST /v2/sessions/read-batch', { select: async (body, request) => {
        const url = new URL(request.url);
        const response = await sessionBatch.handle({ url, path: url.pathname, home: serverId, accountId: 'account-a',
            method: 'POST', headers: new Headers(request.init?.headers), signal: request.signal, body });
        if (!response) throw new Error('Expected the canonical Session batch fixture to respond');
        return { status: response.status, body: await response.json() };
    } });
    homes.answer(serverId, `PATCH /v2/sessions/${session.id}`, { select: (input) => {
        writes.push(input);
        beforeWrite?.(input);
        const team = SessionTeamCredentialBindingMetadataPatchV1Schema.safeParse(input);
        if (row.active && (!team.success || team.data.sessionExpectation)) return { status: 409, body: { code: 'session_active' } };
        const owner = SessionMetadataOwnerPatchV1Schema.safeParse(input);
        const current = team.success ? team : owner.success
            ? owner
            : SessionMetadataInactiveModelIntentOwnerPatchV1Schema.safeParse(input);
        if (current.success) {
            const patch = current.data;
            if (patch.sharedMetadata.expectedVersion !== row.metadataVersion
                || patch.agentState.expectedVersion !== row.agentStateVersion
                || JSON.stringify(patch.expectedOwnerMetadata) !== JSON.stringify(row.ownerMetadata)) {
                return { status: 409, body: { code: 'session_metadata_version_conflict', metadataLayoutVersion: 1,
                    sharedMetadata: { version: row.metadataVersion }, agentState: { version: row.agentStateVersion } } };
            }
            row = { ...row, metadata: patch.sharedMetadata.ciphertext, ownerMetadata: patch.ownerMetadata,
                metadataVersion: row.metadataVersion + 1, agentState: patch.agentState.ciphertext,
                agentStateVersion: (row.agentStateVersion ?? 0) + 1, updatedAt: row.updatedAt + 1, seq: row.seq + 1 };
            return { body: SessionMetadataTuplePatchSuccessV1Schema.parse({ success: true, metadataLayoutVersion: 1,
                sharedMetadata: { version: row.metadataVersion }, agentState: { version: row.agentStateVersion } }) };
        }
        const patch = SessionMetadataInactiveModelIntentPatchV1Schema.parse(input).inactiveModelIntent.metadata;
        if (patch.expectedVersion !== row.metadataVersion) {
            return { body: { success: false, error: 'version-mismatch', metadata: { version: row.metadataVersion, value: row.metadata } } };
        }
        row = { ...row, metadata: patch.ciphertext, metadataVersion: row.metadataVersion + 1, updatedAt: row.updatedAt + 1, seq: row.seq + 1 };
        return { body: { success: true, metadata: { version: row.metadataVersion } } };
    } });
    return {
        writes,
        readMetadata: () => {
            if (row.metadataLayoutVersion !== 1) return MetadataSchema.parse(JSON.parse(row.metadata));
            const owner = SessionOwnerMetadataEnvelopeV1Schema.parse(row.ownerMetadata);
            if (owner.t !== 'plain') throw new Error('Current fixture requires plain owner metadata');
            return MetadataSchema.parse(projectSessionOwnerCompatibilityViewV1({ sharedMetadata: JSON.parse(row.metadata), ownerMetadata: owner.v }));
        },
        activate(metadata = readSessionOwnerMetadataView(session)) {
            if (!metadata) throw new Error('Activation requires Session owner metadata');
            row = { ...row, active: true, ...(row.metadataLayoutVersion === 1 ? encodeCurrent(metadata) : { metadata: JSON.stringify(metadata) }),
                metadataVersion: row.metadataVersion + 1, seq: row.seq + 1, updatedAt: row.updatedAt + 1 };
        },
        replaceMetadata(metadata: NonNullable<Session['metadata']>) {
            row = { ...row, ...(row.metadataLayoutVersion === 1 ? encodeCurrent(metadata) : { metadata: JSON.stringify(metadata) }),
                metadataVersion: row.metadataVersion + 1, seq: row.seq + 1, updatedAt: row.updatedAt + 1 };
        },
    };
}
async function seededApproval(request: ApprovalRequest) {
    return await sync.createArtifactWithHeader(buildApprovalRequestArtifactHeaderV1(request, { legacyServerId: serverId }), JSON.stringify(request));
}


type DaemonRequest = Readonly<{ machineId?: string; sessionId?: string; serverId: string; method: string; payload: unknown }>;
const { createPromptRegistrySkillFixture } = await import('@/dev/testkit/harness/promptMachineTransferBoundary');
const registryFixture = createPromptRegistrySkillFixture({ sourceId: 'catalog-source', itemId: 'review', title: 'Review skill',
    files: [{ path: 'SKILL.md', content: '---\nname: review\ndescription: Review changes\n---\n# Review' },
        { path: 'scripts/review.sh', content: '#!/bin/sh\nexit 0\n', unixMode: 0o755 }] });
const registryItem = registryFixture.item;
const registryPointer = { sourceId: registryItem.summary.sourceId, itemId: registryItem.summary.itemId };

/** Stateful row HTTP/CAS boundary; Action policy, catalog loading and transfer logic remain real. */
function servePromptLibraryCatalog(outcome: 'updated' | 'unavailable', options?: Readonly<{
    publicSource?: boolean; refuseSkillRules?: boolean;
}>) {
    const record: Extract<PromptLibraryRecordV1, { key: 'external-links' }> = {
        key: 'external-links', value: { v: 1, links: [{ id: 'neighbor-link', artifactId: 'neighbor-doc',
            assetTypeId: 'claude.command', scope: 'user', machineId: 'machine_1', externalRef: { path: 'neighbor.md' } }] },
    };
    const mutations: ReturnType<typeof PromptLibraryRowMutationV1Schema.parse>[] = [];
    const sources = PromptLibraryRecordV1Schema.parse({ key: 'registry-sources', value: { v: 2, disabledSourceIds: [],
        sources: [{ id: registryPointer.sourceId, title: 'Private skills', format: 'git', kinds: ['skill'],
            url: 'https://catalog.test/skills.git', enabled: true, addedAt: 1,
            ...(options?.publicSource ? {} : { token: { secretRef: 'registry-token' } }) }] } });
    const catalog = createPromptLibraryCatalogBoundary({ records: [record, sources], revision: 4 });
    homes.answer(serverId, '/v1/account/encryption/currentness', { body: createPlainAccountEncryptionCurrentnessFixture() });
    homes.answer(serverId, 'GET /v2/account/settings', { body: { content: { t: 'plain', v: {} }, version: 7 } });
    homes.answer(serverId, 'POST /v2/account/settings', { body: { success: true, version: 8 } });
    homes.answer(serverId, PROMPT_LIBRARY_ROWS_ROUTE_V1, { select: () => outcome === 'unavailable'
        ? { status: 403, body: { error: 'forbidden' } }
        : { body: { status: 'listed', rows: PromptLibraryCatalogKeyV1Schema.options.map(key => ({ key,
            revision: catalog.revision(key), content: { t: 'plain', v: catalog.read(key) } })) } } });
    for (const key of PromptLibraryCatalogKeyV1Schema.options) homes.answer(serverId, `POST ${PROMPT_LIBRARY_ROWS_ROUTE_V1}/${key}`, { select: async input => {
        if (key === 'external-links') mutations.push(PromptLibraryRowMutationV1Schema.parse(input));
        if (key === 'skill-rules' && options?.refuseSkillRules) return { body: { status: 'account-inconsistent' } };
        const response = await catalog.handle(`${PROMPT_LIBRARY_ROWS_ROUTE_V1}/${key}`, { method: 'POST', body: JSON.stringify(input) });
        if (!response) throw new Error('Canonical row boundary did not accept its owned path');
        return { status: response.status, body: await response.json() };
    } });
    if (storage.getState().profileScope?.serverId === serverId) {
        storage.getState().applySettingsForScope({ serverId, accountId: 'account-a' }, baseline.settings, 7);
    }
    return { mutations, read: () => {
        const record = catalog.read('external-links');
        if (record.key !== 'external-links') throw new Error('Wrong fixture row');
        return { record, revision: catalog.revision('external-links') };
    } };
}
/** Fake native daemon HTTP / Socket boundaries carry real encrypted finite-transfer bytes. */
async function servePromptTransfers() {
    const features = createRootLayoutFeaturesResponse();
    for (const featureId of ['machines.transfer', 'machines.transfer.directPeer', 'machines.peerMediation'] as const) {
        if (!tryWriteServerEnabledBitInPlace(features, featureId, true)) throw new Error(`Feature unavailable: ${featureId}`);
    }
    homes.answer(serverId, '/v1/features', { body: features });
    homes.answer(serverId, '/v1/features/authenticated', { body: features });
    const machine = createMachineFixture({ id: 'machine_1', kind: 'persistent', activeAt: Date.now(), operationProtocolCapabilitiesRevision: 1,
        operationProtocolCapabilities: { irohMachineEndpoint: { protocolVersions: [1], endpointId: 'a'.repeat(64), directAddresses: ['127.0.0.1:48123'] } },
        daemonState: { status: 'running', transfer: { supported: { import: true, export: true },
            listenerClasses: { loopback_http: { enabled: true, configured: true, active: true }, tailscale_serve_https: { enabled: false, configured: false, active: false } },
            lifecycle: { mode: 'lazy_idle_shutdown', version: 1 } } } });
    const publishedMachine = { ...createPlainMachineRowFixture({ id: machine.id, accountId: 'account-a' }),
        installationId: 'prompt-fixture-installation',
        metadata: encodePlainMachineStoredContent(machine.metadata), daemonState: encodePlainMachineStoredContent(machine.daemonState),
        operationProtocolCapabilities: machine.operationProtocolCapabilities,
        operationProtocolCapabilitiesRevision: machine.operationProtocolCapabilitiesRevision };
    homes.answer(serverId, '/v1/machines', { body: [publishedMachine] });
    homes.answer(serverId, '/v1/machines/machine_1', { body: { machine: publishedMachine } });
    homes.answer(serverId, 'POST /v1/actions/registries.items.read', { select: input => {
        const envelope = ExternalActionRequestEnvelopeV1Schema.parse(input);
        return { body: ExternalActionResponseEnvelopeV1Schema.parse({ v: 1, actionId: 'registries.items.read', requestId: envelope.requestId,
            execution: { ok: true, result: { item: registryItem } } }) };
    } });
    // This is a simulated remote network adapter, not the real Node receiver
    // proof. Shared domain owners, Artifact/row transports and native bytes stay
    // real; the separate signed-Home/CLI composed case proves Node ingress.
    homes.answer(serverId, 'POST /v1/actions/prompt_registry.install', { select: async (input, request) => {
        const envelope = ExternalActionRequestEnvelopeV1Schema.parse(input);
        const actionInput = PromptRegistryInstallInputSchema.parse(envelope.input);
        const account = await captureLazyActionAccountContext(serverId, request.signal ?? undefined);
        try {
            const store = createUiPromptLibraryArtifactStore(account.workflowArtifacts, account);
            if (!store.organization) throw new Error('Remote fixture Account is unavailable');
            const registry = await createUiRegistryHostV1(account, store.organization, { surface: 'ui', signal: request.signal ?? undefined });
            const skills = createSkillActionExecuteV1({ store, skillRules: { ...store.organization,
                listSkills: signal => readSkillLibraryCatalog({ list: options => account.listArtifacts(options) }, signal),
                ruleWriteContext: () => ({ nowMs: Date.now(), newId: randomUUID }) }, randomId: randomUUID,
                readRegistryItem: registry.readRegistryItem, readRegistrySource: registry.readRegistrySource,
                fetchRegistrySkillFiles: registry.filesForPointer,
                includeInSession: async () => { throw new Error('UI default registry reach must not request Session inclusion'); } });
            const result = await installPromptRegistryItemInLibrary({ request: actionInput,
                signal: request.signal ?? undefined,
                fetchItem: async () => registryItem,
                installLibrary: pointer => skills('skills.install', { source: { kind: 'registry', ...pointer } }, { surface: 'ui' }, request.signal ?? undefined),
            });
            const projected = projectLegacySkillRegistryInstallActionResultV1(result);
            const failure = (await import('@happier-dev/protocol/actions/actionExecutionResult')).ActionExecuteFailureSchema.safeParse(projected);
            return { body: ExternalActionResponseEnvelopeV1Schema.parse({ v: 1, actionId: 'prompt_registry.install', requestId: envelope.requestId,
                execution: failure.success ? failure.data : { ok: true, result: projected } }) };
        } finally { account.dispose(); }
    } });
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
    const exportedBytes = new TextEncoder().encode(JSON.stringify(registryFixture.files));
    const hash = createTransferManifestHasher(); hash.update(exportedBytes);
    const manifestHash = hash.digestManifestHash();
    rpc.machine.mockImplementation(async (request: DaemonRequest) => {
        if (request.method === 'daemon.directTransfer.export.prepare') return { success: true, transferId: 'export-1',
            name: 'skill.json', sizeBytes: exportedBytes.length, expiresAt: Date.now() + DIRECT_ROUTE_GRANT_TTL_MS.finiteTransferCarrier,
            endpointCandidates: [{ kind: 'http', expiresAt: Date.now() + DIRECT_ROUTE_GRANT_TTL_MS.finiteTransferCarrier,
                url: 'http://127.0.0.1:48123/machine-transfers/direct/export-1' }] };
        if (request.method === 'daemon.directTransfer.export.release') return { success: true };
        if (request.method === 'daemon.registries.fetch') {
            const input = RegistryFetchRequestV1Schema.parse(request.payload);
            if (input.op !== 'read' || input.sourceId !== registryPointer.sourceId || input.itemId !== registryPointer.itemId
                || input.version !== undefined && input.version !== registryItem.summary.version) throw new Error('Unexpected registry pointer');
            return RegistryFetchResponseV1Schema.parse({ op: 'read', item: registryItem });
        }
        throw new Error(`Unexpected daemon transport: ${request.method}`);
    });
    setRuntimeFetch(async (input, init) => {
        const url = new URL(String(input));
        // The native daemon and Home share this HTTP boundary, not a transport
        // owner. Keep real feature/grant/catalog requests addressed to the Home.
        if (url.origin !== 'http://127.0.0.1:48123') return await homes.request(input, init);
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
    // Connection hydration may have read the initial empty row before this
    // fixture replaced its HTTP response. Reload through the real catalog owner.
    const { refreshPromptLibraryCatalog } = await import('@/sync/engine/settings/promptLibraryCatalogEngine');
    await refreshPromptLibraryCatalog({ serverId, accountId: 'account-a' });
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
}

describe('createDefaultActionExecutor (prompt library routing)', () => {
    beforeEach(async () => {
        vi.mocked(Modal.confirm).mockReset().mockResolvedValue(false);
        webLocks = installWebLockManagerMock();
        const { resetPromptLibraryCatalogEngineForTests } = await import('@/sync/engine/settings/promptLibraryCatalogEngine');
        const { resetPromptLibraryCatalogSnapshotsForTests } = await import('@/sync/store/settings/promptLibraryCatalogSnapshot');
        resetPromptLibraryCatalogEngineForTests();
        resetPromptLibraryCatalogSnapshotsForTests();
        await homes.reset();
        storage.setState(baseline, true);
        for (const boundary of Object.values(rpc)) boundary.mockReset();
        serverId = await homes.addHome({ name: 'Prompt Home', serverUrl: 'https://prompt-actions.test', serverIdentityId: 'srv_prompt-actions', accountId: 'account-a', currentAccount: true });
        homes.answer(serverId, '/v1/account/encryption/currentness', { body: createPlainAccountEncryptionCurrentnessFixture() });
        connection = await restoreServerAccountForTest({ serverUrl: 'https://prompt-actions.test', accountId: 'account-a',
            credentials: { token: homes.findByServerUrl('https://prompt-actions.test')!.token! } });
        installHomeGovernanceBoundaries(homes);
        const { resolveServerProfileScopeIdForIdentifier } = await import('@/sync/domains/server/serverProfiles');
        const scopeServerId = resolveServerProfileScopeIdForIdentifier(connection.home.id);
        storage.getState().applySettingsForScope({ serverId: scopeServerId, accountId: 'account-a' }, storage.getState().settings, 1);
        storage.getState().activateProfileScope({ serverId: scopeServerId, accountId: 'account-a' });
        vi.stubGlobal('fetch', async (url: RequestInfo | URL, init?: RequestInit) => {
            const path = new URL(String(url)).pathname;
            if (path.startsWith('/v1/machines/')) return Response.json({ machine: createPlainMachineRowFixture({
                id: path.split('/').at(-1)!, accountId: 'account-a',
            }) });
            return homes.request(url, init);
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

    it.each(['completed', 'cancelled_after_ack'] as const)('lists registries without a Machine and retains the acknowledged Account CAS receipt: %s', async outcome => {
        const { resetPromptLibraryCatalogEngineForTests } = await import('@/sync/engine/settings/promptLibraryCatalogEngine');
        const { resetPromptLibraryCatalogSnapshotsForTests } = await import('@/sync/store/settings/promptLibraryCatalogSnapshot');
        resetPromptLibraryCatalogEngineForTests();
        resetPromptLibraryCatalogSnapshotsForTests();
        setRuntimeFetch(async (input, init) => String(input) === DEFAULT_CURATED_MARKETPLACE_SOURCE_URL
            ? new Response(null, { status: 503 }) : homes.request(new URL(String(input)), init));
        homes.answer(serverId, '/v1/account/encryption/currentness', { body: createPlainAccountEncryptionCurrentnessFixture() });
        homes.answer(serverId, 'GET /v2/account/settings', { body: { content: { t: 'plain', v: {} }, version: 1 } });
        let record: PromptLibraryRecordV1 = { key: 'registry-sources', value: { v: 2, sources: [], disabledSourceIds: [] } };
        let revision = 4;
        homes.answer(serverId, PROMPT_LIBRARY_ROWS_ROUTE_V1, { select: () => ({ body: { status: 'listed', rows: [
            { key: record.key, revision, content: { t: 'plain', v: record } },
            ...PromptLibraryCatalogKeyV1Schema.options.filter(key => key !== record.key).map(key => ({ key, revision: 1, content: null })),
        ] } }) });
        homes.answer(serverId, `POST ${PROMPT_LIBRARY_ROWS_ROUTE_V1}/registry-sources`, { select: input => {
            const mutation = PromptLibraryRowMutationV1Schema.parse(input);
            if (mutation.expectedRevision !== revision) return { body: { status: 'conflict', revision } };
            if (mutation.content?.t !== 'plain') throw new Error('Expected plain registry-sources row');
            record = PromptLibraryRecordV1Schema.parse(mutation.content.v);
            return { body: { status: 'updated', revision: ++revision, cursor: revision } };
        } });
        const executor = createDefaultActionExecutor();
        const context = { surface: 'ui', authority: 'present_user', serverId } as const;
        const listed = await executor.execute('registries.sources.list', { kind: 'skill' }, context);
        expect(listed, JSON.stringify(listed)).toMatchObject({ ok: true, result: {
            sources: expect.arrayContaining([expect.objectContaining({ id: 'builtin:skills-sh', enabled: true })]),
        } });
        const { subscribePromptLibraryCatalogSnapshots, getPromptLibraryCatalogValue } = await import('@/sync/store/settings/promptLibraryCatalogSnapshot');
        const { captureLazyActionAccountContext } = await import('./actionAccountContext');
        const observedAccount = await captureLazyActionAccountContext(serverId);
        const scope = { serverId: observedAccount.serverId, accountId: observedAccount.accountId };
        const cancellation = new AbortController();
        const stop = subscribePromptLibraryCatalogSnapshots(() => {
            if (outcome === 'cancelled_after_ack' && getPromptLibraryCatalogValue(scope, 'registry-sources').revision === 5) cancellation.abort();
        });
        try {
            const changed = await executor.execute('registries.sources.update', { sourceId: 'builtin:skills-sh', enabled: false },
                { ...context, signal: cancellation.signal });
            expect(changed).toMatchObject({ ok: true, result: { source: { id: 'builtin:skills-sh', enabled: false } } });
            expect(cancellation.signal.aborted).toBe(outcome === 'cancelled_after_ack');
        } finally { stop(); observedAccount.dispose(); }
        expect(record).toMatchObject({ key: 'registry-sources', value: { disabledSourceIds: ['builtin:skills-sh'] } });
        expect(rpc.machine).not.toHaveBeenCalled();
    });

    it('changes skill rules by frontmatter name through the captured Account row and returns an Undo value', async () => {
        homes.answer(serverId, '/v1/account/encryption/currentness', { body: createPlainAccountEncryptionCurrentnessFixture() });
        homes.answer(serverId, 'GET /v2/account/settings', { body: { content: { t: 'plain', v: {} }, version: 1 } });
        let record: PromptLibraryRecordV1 = { key: 'skill-rules', value: { v: 1, rules: [] } };
        let revision = 4;
        homes.answer(serverId, `POST ${PROMPT_LIBRARY_ROWS_ROUTE_V1}/skill-rules`, { select: input => {
            const mutation = PromptLibraryRowMutationV1Schema.parse(input);
            if (mutation.expectedRevision !== revision) return { status: 409, body: { status: 'conflict', revision } };
            if (mutation.content?.t !== 'plain') throw new Error('Expected plain skill-rules row');
            record = PromptLibraryRecordV1Schema.parse(mutation.content.v);
            return { body: { status: 'updated', revision: ++revision, cursor: revision } };
        } });
        homes.answer(serverId, PROMPT_LIBRARY_ROWS_ROUTE_V1, { select: () => ({ body: { status: 'listed', rows: [
            { key: record.key, revision, content: { t: 'plain', v: record } },
            ...PromptLibraryCatalogKeyV1Schema.options.filter(key => key !== record.key).map(key => ({ key, revision: 1, content: null })),
        ] } }) });
        const skillId = await sync.createArtifactWithHeader({ v: 1, kind: 'prompt_bundle.v2', title: 'Display title', bundleSchemaId: 'skills.skill_md_v1' },
            JSON.stringify({ v: 1, createdAtMs: 1, updatedAtMs: 1, entries: [{ path: 'SKILL.md', contentKind: 'utf8',
                contentBase64: Buffer.from('---\nname: lint\ndescription: Checks changes\n---\nUse it.').toString('base64') }] }));
        const result = await createDefaultActionExecutor().execute('skills.rules.set', { items: [{ name: 'lint' }],
            change: { kind: 'write', write: { place: { t: 'allMachines' }, state: 'on' } } },
            { surface: 'ui', authority: 'present_user', serverId });
        expect(result, JSON.stringify(result)).toMatchObject({ ok: true, result: { ok: true, revision: 5,
            items: [{ skillId, previous: [], rules: [{ target: { t: 'allMachines' }, enabled: true }] }] } });
        expect(record).toMatchObject({ key: 'skill-rules', value: { rules: [{ skillId, enabled: true }] } });
        expect(homes.requestsFor('/v2/account/settings').filter(request => request.input !== null)).toEqual([]);
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

    it.each([false, true])('migrates a workspace label from its organization owner without retiring a newer label (renamed: %s)', async (renamed) => {
        const { buildSessionOrganizationLabelKey } = await import('@/sync/domains/session/organization/keys');
        const scope = storage.getState().settingsScope;
        if (!scope) throw new Error('Expected captured Account scope');
        const legacyKey = `server:${scope.serverId}:workspace:/repo`;
        const labelKey = buildSessionOrganizationLabelKey({ serverId: scope.serverId, labelKind: 'workspace', scopeKey: legacyKey });
        const recordId = storage.getState().upsertSessionOrganizationLabelOptimistic(scope.serverId, {
            labelKind: 'workspace', scopeKey: legacyKey, display: { t: 'plain', v: { label: 'My checkout' } },
            displayState: { status: 'available', value: { label: 'My checkout' } },
            archivedAt: null, createdAt: 1, updatedAt: 1,
        });
        storage.getState().commitSessionOrganizationOptimistic(recordId);
        const ref = { id: 'label-checkout', serverId: scope.serverId, machineId: 'machine', rootPath: '/repo', createdAtMs: 1 };
        let label: string | null = null;
        homes.answer(serverId, `POST ${PROJECT_ACCOUNT_ROWS_ROUTE_V1}/list`, { select: () => ({ body:
            createPlainProjectAccountRowListFixture({ workspaceRefs: [{ ...ref, label }] }) }) });
        homes.answer(serverId, `POST ${PROJECT_ACCOUNT_ROWS_ROUTE_V1}/mutate`, { select: input => {
            const request = ProjectAccountRowMutationRequestV1Schema.parse(input);
            const mutation = request.mutations[0];
            if (!mutation || mutation.content?.t !== 'plain') throw new Error('Expected workspace label mutation');
            const payload = ProjectAccountRowPayloadV1Schema.parse(mutation.content.v);
            if (!('id' in payload.value)) throw new Error('Expected workspace ref');
            label = payload.value.label ?? null;
            if (renamed) {
                const current = storage.getState().sessionOrganizationLabelsByLabelKey[labelKey];
                if (!current) throw new Error('Expected retained source label');
                const updated = storage.getState().upsertSessionOrganizationLabelOptimistic(scope.serverId, {
                    ...current, display: { t: 'plain', v: { label: 'New label' } },
                    displayState: { status: 'available', value: { label: 'New label' } },
                });
                storage.getState().commitSessionOrganizationOptimistic(updated);
            }
            return { body: { status: 'updated', rows: [{ key: mutation.key, content: mutation.content, revision: 1 }], cursor: 1 } };
        } });
        homes.answer(serverId, 'DELETE /v2/session-organization/labels', { body: {
            labelKind: 'workspace', scopeKey: legacyKey, archived: true,
        } });

        const result = await sync.mutateProjectWorkspaceRef({
            kind: 'migrate_label',
            scope: { serverId: scope.serverId, machineId: ref.machineId, rootPath: ref.rootPath },
            legacyKey, label: 'My checkout', nowMs: 2,
        }, scope);

        expect(result).toMatchObject({ ok: true, migrated: true, workspaceRefId: ref.id });
        expect(label).toBe('My checkout');
        const retained = storage.getState().sessionOrganizationLabelsByLabelKey[labelKey];
        if (renamed) expect(retained?.displayState).toEqual({ status: 'available', value: { label: 'New label' } });
        else expect(retained).toBeUndefined();
        expect(homes.requestsFor('/v2/account/settings').filter(request => request.input !== null)).toEqual([]);
    });

    it('lists external plugin skills through executor B while retaining supplier A provenance for read and local copy', async () => {
        const { normalizePluginUiProjection } = await import('@/sync/domains/plugins/ui/projection');
        const { createPluginUiExecutionOriginCandidatePublication, unionPluginUiProjections, readPluginUiContributionSupplies } = await import('@/sync/domains/plugins/ui/projectionUnion');
        const { publishCommittedAppShellPluginUiProjection } = await import('@/components/appShell/plugins/committedPluginUiProjection');
        const { readSkillInLibrary } = await import('@happier-dev/protocol/prompts/library/promptLibraryActionOperations');
        const { SkillReadInputV1Schema } = await import('@happier-dev/protocol/prompts/library/skills/skillReadV1');
        const { readSkillZipFilesV1 } = await import('@happier-dev/protocol/prompts/library/skills/skillZipV1');
        const { useSkillsLibrary } = await import('@/sync/domains/skills/useSkillsLibrary');
        const { AppShellPluginUiProjectionValueProvider, useAppShellPluginUiDeclarationSources } = await import('@/components/appShell/plugins/AppShellPluginUiProjection');
        const { captureActiveServerAccountScopeLifetime } = await import('@/sync/domains/scope/activeServerAccountScope');
        const { PluginProjectionV2Schema } = await import('@happier-dev/protocol/daemon/contributionRegistryProjection');
        const pluginId = 'com.acme.skills';
        const pluginSkills = ['check', 'review'].map(name => ({ skillId: `plugin:${pluginId}/${name}`,
            provenance: { kind: 'plugin' as const, pluginId, occurrenceId: 'acme-runtime' },
            files: [{ path: 'SKILL.md', contentKind: 'utf8' as const,
                contentBase64: Buffer.from(`---\nname: acme-${name}\ndescription: From the plugin\n---\nInstructions`).toString('base64') },
                { path: 'scripts/check.bin', contentKind: 'binary' as const, contentBase64: 'AAEC/w==', unixMode: 0o755 as const }] }));
        const catalog = createPromptLibraryCatalogBoundary();
        homes.answer(serverId, PROMPT_LIBRARY_ROWS_ROUTE_V1, { select: () => ({ body: { status: 'listed', rows:
            PromptLibraryCatalogKeyV1Schema.options.map(key => ({ key, revision: catalog.revision(key), content: { t: 'plain', v: catalog.read(key) } })) } }) });
        for (const key of PromptLibraryCatalogKeyV1Schema.options) homes.answer(serverId, `POST ${PROMPT_LIBRARY_ROWS_ROUTE_V1}/${key}`, {
            select: async input => {
                const response = await catalog.handle(`${PROMPT_LIBRARY_ROWS_ROUTE_V1}/${key}`, { method: 'POST', body: JSON.stringify(input) });
                if (!response) throw new Error('Expected row mutation');
                return { status: response.status, body: await response.json() };
            },
        });
        const account = await captureLazyActionAccountContext(serverId);
        const store = createUiPromptLibraryArtifactStore(account.workflowArtifacts, account);
        if (!store.organization) throw new Error('Expected Account catalog');
        const producer = createSkillActionExecuteV1({ store, skillRules: { ...store.organization,
            listSkills: signal => readSkillLibraryCatalog({ list: options => account.listArtifacts(options), readPluginSkills: async () => pluginSkills }, signal),
            ruleWriteContext: () => ({ nowMs: Date.now(), newId: randomUUID }) },
            readPluginSkills: async () => pluginSkills, randomId: randomUUID, includeInSession: async () => ({ ok: true }) });
        const sourceMachineId = 'plugin-supplier-a';
        const machine = createMachineFixture({ id: 'plugin-executor-b', active: true, activeAt: Date.now() });
        const originFor = (machineId: string) => ({ serverIdentityId: account.serverIdentityId!,
            materializationRef: { machineId, pluginId, materializationId: machineId } });
        const published = { ...createPlainMachineRowFixture({ id: machine.id, accountId: 'account-a' }),
            installationId: 'plugin-installation',
            metadata: encodePlainMachineStoredContent(machine.metadata), daemonState: encodePlainMachineStoredContent(machine.daemonState) };
        homes.answer(serverId, '/v1/machines', { body: [published] });
        storage.setState({ machines: { [machine.id]: machine }, machineListByServerId: { [account.serverId]: [machine] } });
        const projection = normalizePluginUiProjection(PluginProjectionV2Schema.parse({ v: 2, generation: 1,
            installedPackagesById: { [pluginId]: { id: pluginId, displayName: 'Acme Skills', version: '1.0.0', enabled: true, occurrenceId: 'acme-runtime', executionOrigin: originFor(sourceMachineId), source: { kind: 'path', locator: '/plugins/acme' } } },
            agentsById: {}, actionsById: {},   resourcesById: {}, settingsById: {}, diagnostics: [],
            familiesById: { skills: { family: 'skills', entriesById: Object.fromEntries(pluginSkills.map((skill, index) => {
                const id = skill.skillId.slice('plugin:'.length);
                return [id, { id, pluginId, pluginVersion: '1.0.0', occurrenceId: 'acme-runtime', executionOrigin: originFor(sourceMachineId), definition: { id: ['check', 'review'][index], directory: `./skills/${index}` } }];
            })) } } }));
        const installedProjection = unionPluginUiProjections([{ machineId: sourceMachineId, serverId: account.serverId, projection,
            phase: 'current', interactionEnabled: true }]).pluginUiProjection;
        let projected = installedProjection;
        const candidates = createPluginUiExecutionOriginCandidatePublication();
        candidates.publish(installedProjection, [], [pluginId]);
        const stop = publishCommittedAppShellPluginUiProjection(() => projected,
            id => projected ? candidates.getSnapshot().get(id) ?? null : null);
        let miswired = false;
        let missingSkill = false;
        let sourceUnavailable = false;
        let staleOccurrence = false;
        let wrongSkill = false;
        let holdListResponses = false;
        const heldListResponses: Array<ReturnType<typeof createDeferred<void>>> = [];
        for (const actionId of ['skills.list', 'skills.read', 'skills.duplicate'] as const) homes.answer(serverId, `POST /v1/actions/${actionId}`, {
            select: async input => {
                const envelope = ExternalActionRequestEnvelopeV1Schema.parse(input);
                expect(envelope.target).toEqual({ kind: 'machine', machineId: machine.id });
                if (sourceUnavailable) return { body: ExternalActionResponseEnvelopeV1Schema.parse({ v: 1, actionId, requestId: envelope.requestId,
                    execution: { ok: false, errorCode: 'admission_unavailable', error: 'admission_unavailable' } }) };
                let result = actionId === 'skills.read'
                    ? await readSkillInLibrary({ store, request: wrongSkill ? { skillId: pluginSkills[1]!.skillId } : SkillReadInputV1Schema.parse(envelope.input), pluginSkills })
                    : await producer(actionId, envelope.input, { surface: 'ui' });
                if (actionId === 'skills.list') {
                    const list = SKILL_ACTION_OUTPUT_SCHEMAS_V1[actionId].parse(result);
                    result = { ...list, items: list.items.filter(item => !missingSkill || item.skillId !== pluginSkills[0]!.skillId)
                        .map(item => staleOccurrence && item.skillId === pluginSkills[0]!.skillId && item.provenance.kind === 'plugin'
                            ? { ...item, provenance: { ...item.provenance, occurrenceId: 'retired-occurrence' } } : item) };
                    if (holdListResponses) {
                        const held = createDeferred<void>();
                        heldListResponses.push(held);
                        await held.promise;
                    }
                }
                return { body: ExternalActionResponseEnvelopeV1Schema.parse({ v: 1, actionId, requestId: envelope.requestId,
                    execution: { ok: true, result: miswired ? {} : result } }) };
            },
        });
        try {
            const context = { surface: 'ui', authority: 'present_user', serverId } as const;
            const executor = createDefaultActionExecutor();
            const listed = await executor.execute('skills.list', {}, context);
            expect(listed).toMatchObject({ ok: true, result: { items: expect.arrayContaining(pluginSkills.map(skill => expect.objectContaining({ skillId: skill.skillId, provenance: skill.provenance }))) } });
            expect(homes.requestsFor('/v1/actions/skills.list')).toHaveLength(1);
            expect(homes.requestsFor('/v1/actions/skills.read')).toHaveLength(0);
            expect(await executor.execute('skills.read', { skillId: pluginSkills[0]!.skillId }, context)).toMatchObject({ ok: true, result: { name: 'acme-check' } });
            wrongSkill = true;
            expect(await executor.execute('skills.read', { skillId: pluginSkills[0]!.skillId }, context)).toMatchObject({ ok: false });
            wrongSkill = false;
            const copied = await executor.execute('skills.duplicate', { skillId: pluginSkills[0]!.skillId }, context);
            expect(copied).toMatchObject({ ok: true, result: { ok: true, skillId: expect.any(String) } });
            expect(homes.requestsFor('/v1/actions/skills.duplicate')).toHaveLength(0);
            const copiedId = copied.ok && copied.result && typeof copied.result === 'object' && 'skillId' in copied.result ? copied.result.skillId : null;
            expect(catalog.read('skill-rules')).toMatchObject({ value: { rules: expect.arrayContaining([expect.objectContaining({ skillId: copiedId, enabled: true, target: { t: 'allMachines' } })]) } });
            const rule = await executor.execute('skills.rules.set', { items: [{ name: 'acme-review' }], change: { kind: 'write', write: { place: { t: 'allMachines' }, state: 'on' } } }, context);
            expect(rule).toMatchObject({ ok: true, result: { ok: true, items: [{ skillId: pluginSkills[1]!.skillId }] } });
            seedSession(false);
            const sessionChange = await executor.execute('session.capabilities.set', { sessionId: 'session_1', kind: 'skill', id: 'acme-review', state: 'on' }, context);
            expect(sessionChange, JSON.stringify(sessionChange)).toMatchObject({ ok: true, result: { ok: true, state: 'on' } });
            missingSkill = true;
            expect(await executor.execute('skills.list', {}, context)).toMatchObject({ ok: true, result: { items: expect.arrayContaining([
                expect.objectContaining({ skillId: 'happier:happier' }), expect.objectContaining({ skillId: copiedId }),
                expect.objectContaining({ skillId: pluginSkills[1]!.skillId }),
            ]) } });
            expect(await executor.execute('skills.list', { query: '  ' }, context)).toMatchObject({ ok: true });
            expect(await executor.execute('skills.list', { query: 'acme-review' }, context)).toMatchObject({ ok: true, result: { items: [expect.objectContaining({ skillId: pluginSkills[1]!.skillId })] } });
            missingSkill = false;
            sourceUnavailable = true;
            expect(await executor.execute('skills.list', {}, context)).toMatchObject({ ok: true, result: { items: expect.arrayContaining([
                expect.objectContaining({ skillId: 'happier:happier' }), expect.objectContaining({ skillId: copiedId }),
            ]) } });
            expect(await executor.execute('skills.read', { skillId: pluginSkills[0]!.skillId }, context)).toMatchObject({ ok: false });
            sourceUnavailable = false;
            staleOccurrence = true;
            expect(await executor.execute('skills.list', {}, context)).toMatchObject({ ok: true, result: { items: expect.not.arrayContaining([
                expect.objectContaining({ skillId: pluginSkills[0]!.skillId }),
            ]) } });
            staleOccurrence = false;
            const exported = await executor.execute('skills.export', { skillIds: pluginSkills.map(skill => skill.skillId) }, context);
            expect(exported).toMatchObject({ ok: true });
            if (!exported.ok) throw new Error('Expected plugin skill export');
            const archive = SKILL_ACTION_OUTPUT_SCHEMAS_V1['skills.export'].parse(exported.result);
            expect(await readSkillZipFilesV1(new Uint8Array(Buffer.from(archive.bytes, 'base64')))).toEqual(expect.arrayContaining([
                expect.objectContaining({ path: 'acme-check/scripts/check.bin', contentBase64: 'AAEC/w==', unixMode: 0o755 }),
                expect.objectContaining({ path: 'acme-review/scripts/check.bin', contentBase64: 'AAEC/w==', unixMode: 0o755 }),
            ]));
            miswired = true;
            expect(await executor.execute('skills.list', {}, context)).toMatchObject({ ok: false });
            projected = null;
            expect(await executor.execute('skills.list', {}, context)).toMatchObject({ ok: true, result: { items: expect.not.arrayContaining([expect.objectContaining({ skillId: pluginSkills[0]!.skillId })]) } });
            const beforeRetiredRead = homes.requestsFor(`/v1/artifacts/${pluginSkills[0]!.skillId}`).length;
            expect(await executor.execute('skills.read', { skillId: pluginSkills[0]!.skillId }, context)).toMatchObject({ ok: false, errorCode: 'not_found' });
            expect(await executor.execute('skills.duplicate', { skillId: pluginSkills[0]!.skillId }, context)).toMatchObject({ ok: false, errorCode: 'not_found' });
            expect(homes.requestsFor(`/v1/artifacts/${pluginSkills[0]!.skillId}`)).toHaveLength(beforeRetiredRead);
            miswired = false;
            storage.setState({ isDataReady: true, artifactsLoaded: true });
            const lifetime = captureActiveServerAccountScopeLifetime();
            const sourceObservations: Array<ReturnType<typeof useAppShellPluginUiDeclarationSources>> = [];
            function DeclarationProbe() {
                const source = useAppShellPluginUiDeclarationSources();
                React.useLayoutEffect(() => { sourceObservations.push(source); });
                return null;
            }
            function Wrapper(props: React.PropsWithChildren) {
                return React.createElement(AppShellPluginUiProjectionValueProvider, { value: { pluginUiProjection: projected,
                    pluginBrowserProjection: null, phase: 'current', interactionEnabled: true, machineId: machine.id,
                    serverId: account.serverId, platform: 'web', accountLifetime: lifetime,
                    reloadConnectedAccountProjection: () => {}, reloadClientExecutables: () => {},
                    clientExecutableActivation: { status: 'ready' } }, children: React.createElement(React.Fragment, null,
                        React.createElement(DeclarationProbe), props.children) });
            }
            const hook = await renderHook(() => useSkillsLibrary(), { wrapper: Wrapper });
            try {
                await vi.waitFor(() => expect(hook.getCurrent().status).toBe('ready'));
                expect(hook.getCurrent().items.some(item => item.skillId === pluginSkills[0]!.skillId)).toBe(false);
                projected = installedProjection;
                await hook.rerender();
                await vi.waitFor(() => expect(hook.getCurrent().items).toEqual(expect.arrayContaining([expect.objectContaining({ skillId: pluginSkills[0]!.skillId })])));
                staleOccurrence = true;
                await act(async () => hook.getCurrent().retry());
                await vi.waitFor(() => expect(hook.getCurrent()).toMatchObject({ status: 'ready', stale: false, errorCode: null,
                    items: expect.not.arrayContaining([expect.objectContaining({ skillId: pluginSkills[0]!.skillId })]) }));
                staleOccurrence = false;
                await act(async () => hook.getCurrent().retry());
                await vi.waitFor(() => expect(hook.getCurrent()).toMatchObject({ status: 'ready', stale: false }));
                const publishVersion = (version: string) => installedProjection ? { ...installedProjection,
                    skillsById: Object.fromEntries(Object.entries(installedProjection.skillsById).map(([id, entry]) => [id, {
                        ...entry, pluginVersion: version, definition: { ...entry.definition, directory: `./skills/${version}/${entry.definition.id}` },
                        hostSupplies: readPluginUiContributionSupplies(entry).map(supply => ({ ...supply, pluginVersion: version })),
                    }])) } : null;
                holdListResponses = true;
                projected = publishVersion('2.0.0');
                await hook.rerender();
                await vi.waitFor(() => expect(heldListResponses).toHaveLength(1));
                expect(hook.getCurrent()).toMatchObject({ status: 'ready', stale: true });
                const pendingIdentity = sourceObservations.at(-1)?.skillSourceIdentity;
                sourceObservations.length = 0;
                projected = projected ? { ...projected, generation: 998,
                    skillsById: Object.fromEntries(Object.entries(projected.skillsById).map(([id, entry]) => [id, {
                        ...entry, hostSupplies: readPluginUiContributionSupplies(entry).map(supply => ({ ...supply, generation: 998 })),
                    }])) } : null;
                await hook.rerender();
                expect(heldListResponses).toHaveLength(1);
                expect(sourceObservations.length).toBeGreaterThan(0);
                expect(sourceObservations.every(source => source.ready && source.skillSourceIdentity === pendingIdentity)).toBe(true);
                const previousDescription = hook.getCurrent().items.find(item => item.skillId === pluginSkills[0]!.skillId)?.description;
                pluginSkills[0]!.files[0]!.contentBase64 = Buffer.from('---\nname: acme-check\ndescription: Current plugin source\n---\nUpdated instructions').toString('base64');
                projected = publishVersion('3.0.0');
                await hook.rerender();
                // One Account list read is in flight and joined by this newer publication; its answer predates
                // the publication, so the follow-up read starts only once it settles.
                expect(heldListResponses).toHaveLength(1);
                await act(async () => { heldListResponses[0]!.resolve(); });
                await vi.waitFor(() => expect(heldListResponses).toHaveLength(2));
                await flushHookEffects();
                expect(hook.getCurrent()).toMatchObject({ status: 'ready', stale: true });
                expect(hook.getCurrent().items.find(item => item.skillId === pluginSkills[0]!.skillId)?.description).toBe(previousDescription);
                await act(async () => { heldListResponses[1]!.resolve(); });
                await vi.waitFor(() => expect(hook.getCurrent()).toMatchObject({ status: 'ready', stale: false,
                    items: expect.arrayContaining([expect.objectContaining({ skillId: pluginSkills[0]!.skillId, description: 'Current plugin source' })]) }));
                holdListResponses = false;
                const requests = homes.requestsFor('/v1/actions/skills.list').length;
                projected = projected ? { ...projected, generation: 999,
                    skillsById: Object.fromEntries(Object.entries(projected.skillsById).map(([id, entry]) => [id, {
                        ...entry, hostSupplies: readPluginUiContributionSupplies(entry).map(supply => ({ ...supply, generation: 999 })),
                    }])) } : null;
                await hook.rerender();
                expect(homes.requestsFor('/v1/actions/skills.list')).toHaveLength(requests);
                projected = null;
                await hook.rerender();
                await vi.waitFor(() => expect(hook.getCurrent().items.some(item => item.skillId === pluginSkills[0]!.skillId)).toBe(false));
            } finally { holdListResponses = false; for (const held of heldListResponses) held.resolve(); await hook.unmount(); }
        } finally { stop(); account.dispose(); }
    });

    it('reads skill bodies from the Account Artifact owner and session names from the owning runner', async () => {
        const skillMd = '---\nname: review\ndescription: Review the change\n---\nFull review instructions';
        const artifactId = await sync.createArtifactWithHeader({ v: 1, kind: 'prompt_bundle.v2', title: 'Review', bundleSchemaId: 'skills.skill_md_v1' },
            JSON.stringify({ v: 1, entries: [
                { path: 'SKILL.md', contentBase64: Buffer.from(skillMd).toString('base64'), contentKind: 'utf8' },
                { path: 'references/note.bin', contentBase64: 'AAEC/w==', contentKind: 'binary', unixMode: 0o755 },
            ], createdAtMs: 1, updatedAtMs: 1 }));
        const usage = PromptLibraryRecordV1Schema.parse({ key: 'skill-usage', value: { v: 1, lastUsedAt: { [artifactId]: 123 } } });
        homes.answer(serverId, PROMPT_LIBRARY_ROWS_ROUTE_V1, { body: { status: 'listed', rows: [
            { key: usage.key, revision: 2, content: { t: 'plain', v: usage } },
            ...PromptLibraryCatalogKeyV1Schema.options.filter(key => key !== usage.key).map(key => ({ key, revision: 1, content: null })),
        ] } });
        const executor = createDefaultActionExecutor();
        const direct = await executor.execute('skills.read', { skillId: artifactId, file: 'references/note.bin' }, { surface: 'ui', serverId });
        expect(direct, JSON.stringify(direct)).toMatchObject({ ok: true, result: { skillId: artifactId, name: 'review', skillMd, lastUsedAt: 123,
            file: { contentBase64: 'AAEC/w==', unixMode: 0o755 } } });
        seedSession(true);
        const output = direct.ok ? direct.result : null;
        rpc.session.mockResolvedValue(output);
        expect(await executor.execute('skills.read', { name: 'review', sessionId: 'session_1' }, { surface: 'ui', serverId }))
            .toMatchObject({ ok: true, result: { skillId: artifactId, skillMd } });
        expect(rpc.session).toHaveBeenCalledWith(expect.objectContaining({ method: 'skills.read', sessionId: 'session_1',
            payload: { name: 'review', sessionId: 'session_1' } }));
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
            const result = await executeModel(modelInput(modelId, providerConnectionId));
            expect(result, JSON.stringify(result)).toMatchObject({ ok: true, result: {
                status: 'intent_updated', sessionId: 'session_1', modelId, updatedAt: expect.any(Number) } });
            expect(remote.readMetadata().modelSelectionIntentV1).toMatchObject({ v: 1, updatedAt: expect.any(Number), selection: selection(modelId, providerConnectionId) });
        }
        expect(remote.writes.map((input) => SessionMetadataInactiveModelIntentOwnerPatchV1Schema.parse(input).sessionExpectation))
            .toEqual([{ kind: 'inactive_model_intent' }, { kind: 'inactive_model_intent' }]);
        expect(rpc.session).not.toHaveBeenCalled();
    });

    it.each(['brokered', 'direct'] as const)('commits an inactive %s Team model with its binding and explicit visibility consent', async deliveryMode => {
        const remote = serveSession(seedSession(false));
        const teamCredentialModel = { kind: 'team_credential_provider_model', teamId: 'team-1', resourceId: 'resource-1',
            expectedResourceRevision: 7, deliveryMode, agentTargetKey: 'agent:happier.agent.claude/claude', modelId: 'team-model' } as const;
        const result = await createDefaultActionExecutor().execute('session.model.set', {
            sessionId: 'session_1', teamCredentialModel, teamVisibilityGrantConsent: { teamId: 'team-1' },
        }, { serverId, surface: 'ui' });
        expect(result).toMatchObject({ ok: true, result: { status: 'intent_updated', sessionId: 'session_1',
            selection: { v: 2, updatedAt: expect.any(Number), ref: { source: 'team_resource', deliveryMode, modelId: 'team-model' } } } });
        const persisted = remote.readMetadata();
        expect(persisted.modelSelectionIntentV2).toMatchObject({ v: 2, ref: { source: 'team_resource',
            teamId: 'team-1', resourceId: 'resource-1', deliveryMode, modelId: 'team-model' } });
        expect(persisted).not.toHaveProperty('modelSelectionIntentV1');
        expect(remote.writes.map(input => SessionTeamCredentialBindingMetadataPatchV1Schema.parse(input))).toEqual([
            expect.objectContaining({ operation: 'session.model.set', sessionExpectation: { kind: 'inactive_model_intent' },
                teamVisibilityGrantConsent: { teamId: 'team-1' }, teamCredentialBindings: [expect.objectContaining({ deliveryMode, slot: { kind: 'provider_model' } })] }),
        ]);
        expect(rpc.session).not.toHaveBeenCalled();
    });

    it('rejects a Team model for a different Agent without mutating the Session', async () => {
        const remote = serveSession(seedSession(true));
        const result = await createDefaultActionExecutor().execute('session.model.set', { sessionId: 'session_1',
            teamCredentialModel: { kind: 'team_credential_provider_model', teamId: 'team-1', resourceId: 'resource-1',
                expectedResourceRevision: 7, deliveryMode: 'brokered', agentTargetKey: 'agent:happier.agent.codex/codex', modelId: 'team-model' },
        }, { serverId, surface: 'ui' });
        expect(result).toMatchObject({ ok: false, errorCode: 'model_selection_agent_target_unknown' });
        expect(remote.writes).toEqual([]);
        expect(rpc.session).not.toHaveBeenCalled();
    });

    it('composes retained completed-model evidence through usage query, exact Apply/Undo and intervening-edit refusal', async () => {
        vi.stubGlobal('fetch', homes.request);
        const { resolveServerProfileScopeIdForIdentifier, areServerProfileIdentifiersEquivalent } = await import('@/sync/domains/server/serverProfiles');
        const { loadAccountSettings } = await import('@/sync/domains/state/accountSettingsPersistence');
        const accountScope = { serverId: resolveServerProfileScopeIdForIdentifier(serverId), accountId: 'account-a' };
        expect(areServerProfileIdentifiersEquivalent(accountScope.serverId, serverId)).toBe(true);
        let settingsVersion = (loadAccountSettings(accountScope).version ?? 0) + 1;
        const accountSettings = settingsParse({ ...storage.getState().settings, actionsSettingsV1: { v: 1, approvalWaivedSurfaces: {
            'usage.coach.apply': ['ui' as const],
            'usage.coach.undo': ['ui' as const],
        } } });
        // An explicit Account policy waiver reaches the real owner; this journey
        // tests conditional mutation rather than the separate approval workflow.
        homes.answer(serverId, 'GET /v2/account/settings', { body: { content: { t: 'plain', v: accountSettings }, version: settingsVersion } });
        storage.getState().applySettingsForScope(accountScope, accountSettings, settingsVersion);
        const heavy = selection('heavy-model');
        const ownerMetadataView = MetadataSchema.parse({ path: '/repo', host: 'host', homeDir: '/home', machineId: 'machine_1',
            flavor: 'claude', modelSelectionIntentV1: { v: 1, updatedAt: 250, selection: heavy } });
        const session = createSessionFixture({ id: 'session_1', serverId: accountScope.serverId, active: false, metadataLayoutVersion: 1,
            ownerMetadataView, metadata: MetadataSchema.parse(projectSessionSharedMetadataV1({ metadata: ownerMetadataView, agentState: null })) });
        storage.getState().applySessions([session]);
        let race = false;
        const remote = serveSession(session, undefined, async () => {
            if (!race) return;
            race = false;
            remote.replaceMetadata({ ...remote.readMetadata(),
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
                    sessionId: 'session_1', agentId: 'claude', machineId: 'machine_1',
                    projectKey: null, workspaceId: null, source: 'native', tokens,
                    cost: { reportedUsd: row.amount, estimatedUsd: 0, currency: 'USD', costSource: 'provider_reported' },
                })),
            coverage: { status: 'partial', reasons: [], sources: [{ source: 'native', path: 'native', status: 'partial',
                eventCount: 2, historyComplete: false, asOfMs: 200 }], missingDimensions: [], ranked: [],
                range: { startMs: 0, endMs: 1000, complete: false } },
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
        homes.answer(serverId, buildSessionMessagesPath({ sessionId: 'session_1', scope: 'all', roles: ['user', 'agent', 'event'] }),
            { body: { messages, hasMore: false } });
        const query = normalizeUsageQuery({ session: 'session_1', period: { startMs: 0, endMs: 1000 } });
        const { getUsageQueryResourceStore } = await import('@/sync/api/account/usageQueryResource');
        const account = await captureLazyActionAccountContext(serverId);
        const resource = getUsageQueryResourceStore(account).getEntry({ hostRead: 'usage.query',
            input: projectNativeJsonValueForTransport({ queries: [query] }) });
        const release = resource.subscribe(() => {}, true);
        try {
        // The mounted query owner finishes optional evidence before this one-shot
        // Action reads its current snapshot; Apply/Undo keep the real owner path.
        await resource.refresh();
        const executor = createDefaultActionExecutor();
        const read = async () => {
            const queried = await executor.execute('usage.query', { queries: [query] }, { serverId, surface: 'ui' });
            expect(queried, JSON.stringify(queried)).toMatchObject({ ok: true });
            const batch = UsageQueryBatchResultSchema.parse(queried.ok ? queried.result : null);
            expect(JSON.stringify(batch)).not.toContain('PRIVATE matched work');
            const finding = batch.results[0]?.coach?.findings.find(finding => finding.detectorId === 'model_misfit');
            expect(finding, JSON.stringify({ coverage: batch.results[0]?.accounting?.coverage,
                howYouWork: batch.results[0]?.howYouWork?.detailStatus, coach: batch.results[0]?.coach?.evaluations,
                resourceFreshness: resource.getSnapshot().freshness, resourcePending: resource.getSnapshot().pending,
                authorityScope: account.accountLifetime.scope, storedProfileScope: storage.getState().profileScope,
                storedSessionServerId: storage.getState().sessions.session_1?.serverId,
                requests: homes.requests.map(row => row.path) })).toBeDefined();
            if (!finding) throw new Error('Expected witnessed model proposal');
            return finding;
        };
        let finding = await read();
        expect(finding).toMatchObject({ coverage: 'partial', modelComparison: { costCoverage: 'partial', providerAttribution: 'unknown' },
            remedy: { kind: 'model', modelId: 'light-model', expected: { owner: 'inactive', updatedAt: 250 } } });
        const apply = () => executor.execute('usage.coach.apply', { query, evidenceKey: finding.evidenceKey }, { serverId, surface: 'ui' });
        const applied = await apply();
        expect(applied, JSON.stringify(applied)).toMatchObject({ ok: true, result: { kind: 'applied' } });
        const receipt = UsageCoachApplyResultSchema.parse(applied.ok ? applied.result : null);
        expect(receipt.reversal).toMatchObject({ kind: 'model', owner: { before: heavy, applied: selection('light-model') } });
        expect(remote.readMetadata().modelSelectionIntentV1?.selection).toEqual(selection('light-model'));
        const exactResponse = await account.request('/v2/sessions/session_1?accessProjectionVersion=1', { method: 'GET' }, { includeAuth: true });
        const exactBody: unknown = await exactResponse.json();
        const exact = V2SessionRecordSchema.parse(exactBody && typeof exactBody === 'object' ? Reflect.get(exactBody, 'session') : null);
        const batchResponse = await account.request('/v2/sessions/read-batch', { method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sessionIds: ['session_1'], accessProjectionVersion: 1, includeSnapshot: true, includeTurns: false, includeMessages: false }) },
            { includeAuth: true });
        const batched = SessionReadBatchResponseV1Schema.parse(await batchResponse.json()).results[0]?.detail;
        if (!batched || batched.status !== 200 || !batched.body.session) throw new Error('Expected the updated Session in the real batch fixture');
        expect(batched.body.session.metadataVersion).toBe(exact.metadataVersion);
        expect(batched.body.session.metadata).toBe(exact.metadata);
        expect(batched.body.session.ownerMetadata).toEqual(exact.ownerMetadata);
        expect(exact.metadataVersion).toBeGreaterThan(session.metadataVersion);
        const undo = () => executor.execute('usage.coach.undo', { query, evidenceKey: finding.evidenceKey, reversal: receipt.reversal }, { serverId, surface: 'ui' });
        // Apply invalidated the mounted query owner; its refreshed snapshot admits the one-shot Undo query.
        await resource.refresh();
        const undone = await undo();
        expect(undone, JSON.stringify(undone)).toMatchObject({ ok: true, result: { kind: 'undone' } });
        expect(remote.readMetadata().modelSelectionIntentV1?.selection).toEqual(heavy);
        const modelOff = { ...accountSettings, usageCoachPreferencesV1: { ...accountSettings.usageCoachPreferencesV1, modelSuggestion: 'off' as const } };
        homes.answer(serverId, 'GET /v2/account/settings', { body: { content: { t: 'plain', v: modelOff }, version: ++settingsVersion } });
        storage.getState().applySettingsForScope(accountScope, modelOff, settingsVersion);
        expect(settingsParse(loadAccountSettings(accountScope).settings).usageCoachPreferencesV1).toMatchObject({ modelSuggestion: 'off' });
        const beforeDisabledApply = remote.writes.length;
        expect(await apply()).toMatchObject({ ok: false, errorCode: 'coach_evidence_not_current' });
        expect(remote.writes).toHaveLength(beforeDisabledApply);
        homes.answer(serverId, 'GET /v2/account/settings', { body: { content: { t: 'plain', v: accountSettings }, version: ++settingsVersion } });
        storage.getState().applySettingsForScope(accountScope, accountSettings, settingsVersion);
        await resource.refresh();
        finding = await read();
        const second = await apply();
        expect(second, JSON.stringify(second)).toMatchObject({ ok: true });
        const secondReceipt = UsageCoachApplyResultSchema.parse(second.ok ? second.result : null);
        remote.replaceMetadata({ ...remote.readMetadata(), modelSelectionIntentV1: { v: 1, updatedAt: 800, selection: selection('intervening-model') } });
        expect(await executor.execute('usage.coach.undo', { query, evidenceKey: finding.evidenceKey, reversal: secondReceipt.reversal }, { serverId, surface: 'ui' }))
            .toMatchObject({ ok: false });
        expect(remote.readMetadata().modelSelectionIntentV1?.selection?.modelId).toBe('intervening-model');
        remote.replaceMetadata({ ...remote.readMetadata(), modelSelectionIntentV1: { v: 1, updatedAt: 850, selection: heavy } });
        // Model advice reads the synced Session. Deliver the external edit
        // through its real reader before reviewing a remedy for that version.
        await sync.ensureSessionVisibleForMessageRoute('session_1', { serverId, forceRefresh: true, hydrateMessages: false });
        await resource.refresh();
        finding = await read();
        expect(finding.remedy).toMatchObject({ kind: 'model', expected: { owner: 'inactive', updatedAt: 850 } });
        const beforeRace = remote.writes.length;
        race = true;
        expect(await apply()).toMatchObject({ ok: false });
        expect(remote.writes).toHaveLength(beforeRace);
        expect(remote.readMetadata().modelSelectionIntentV1?.selection?.modelId).toBe('intervening-model');
        } finally {
            release();
            account.dispose();
        }
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
        expect(remote.readMetadata().modelSelectionIntentV1).toEqual(readSessionOwnerMetadataView(session)?.modelSelectionIntentV1);
    });

    it('refuses an omitted-connection model selection when Session Provider state is unreadable', async () => {
        for (const active of [true, false]) {
            // Corrupt persisted bytes enter at the Home/store boundary; production parsing remains real.
            const unreadable = active ? { ...binding, connectionRevision: 'not-a-number' } : { selection: { providerConnectionId: 'pc_work' } };
            const session = seedSession(active);
            const metadata = { ...readSessionOwnerMetadataView(session), [active ? 'providerBindingV1' : 'modelSelectionIntentV1']: unreadable };
            storage.getState().applySessions([{ ...session, ownerMetadataView: metadata as Session['metadata'] }]);
            expect(await executeModel(modelInput('next-model'))).toEqual({ ok: false, errorCode: 'model_selection_session_provider_state_unreadable', error: 'model_selection_session_provider_state_unreadable' });
        }
        expect(rpc.session).not.toHaveBeenCalled();
        expect(homes.requests.some(({ path, input }) => path.startsWith('/v2/sessions') && input !== null)).toBe(false);
    });

    it('reroutes an inactive snapshot through the live transition owner after the conditioned metadata CAS observes activation', async () => {
        const session = seedSession(false, { modelSelectionIntentV1: { v: 1, updatedAt: 10, selection: selection('pending-model', 'pc_pending') } });
        const remote = serveSession(session, () => remote.activate({ ...remote.readMetadata(), providerBindingV1: binding }));
        rpc.session.mockResolvedValueOnce({ ok: true, status: 'applied', activeSelection: selection('provider-next', 'pc_active') });
        const result = await executeModel(modelInput('provider-next'));
        expect(result, JSON.stringify(result)).toMatchObject({ ok: true, result: { status: 'applied', activeSelection: selection('provider-next', 'pc_active') } });
        expect(remote.writes).toHaveLength(1);
        expect(rpc.session).toHaveBeenLastCalledWith({ sessionId: 'session_1', serverId, method: 'session.model.transition', payload: { v: 1, selection: selection('provider-next', 'pc_active') } });
    });

    it('does not retry metadata or invoke an unproven owner after an active conflict', async () => {
        const session = seedSession(false);
        const remote = serveSession(session);
        homes.answer(serverId, 'PATCH /v2/sessions/session_1', { body: { code: 'session_active' }, status: 409 });
        const result = await executeModel(modelInput('provider-next'));
        expect(result, JSON.stringify(result)).toMatchObject({ ok: false, errorCode: 'owner_unavailable', details: { reason: 'session_model_transition_owner_unproven', requestedSelection: selection('provider-next') } });
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
            remote.replaceMetadata({ ...remote.readMetadata(), modelSelectionIntentV1: { v: 1, updatedAt: Number.MAX_SAFE_INTEGER, selection: selection('newer-model') } });
        });
        expect(await executeModel(modelInput('provider-model', 'pc_work'))).toMatchObject({ ok: false, errorCode: 'superseded', details: {
            status: 'superseded', requestedSelection: selection('provider-model', 'pc_work'), reason: 'accepted_intent_was_superseded' } });
        expect(remote.readMetadata().modelSelectionIntentV1?.selection?.modelId).toBe('newer-model');
        expect(rpc.session).not.toHaveBeenCalled();
    });



    it('prompt catalog public registry install preserves acknowledged library content when its rule write is refused', async () => {
        const catalog = servePromptLibraryCatalog('updated', { publicSource: true, refuseSkillRules: true });
        await servePromptTransfers();
        const result = await createDefaultActionExecutor().execute('prompt_registry.install', {
            machineId: 'machine_1', ...registryPointer,
            installTarget: { assetTypeId: 'agents.skill', scope: 'user', targetName: 'review' },
        }, { serverId, surface: 'ui' });
        expect(result).toMatchObject({ ok: true, result: { artifactId: expect.any(String), exported: false,
            skillIds: [expect.any(String)], includedInSessionId: null,
            incomplete: [{ skillId: expect.any(String), step: 'rules' }] } });
        if (!result.ok) throw new Error(result.error);
        const receipt = result.result as Readonly<{ artifactId: string; skillIds: string[] }>;
        expect(receipt.skillIds).toEqual([receipt.artifactId]);
        expect(homes.artifacts(serverId).readPlainBody(receipt.artifactId)).not.toBeNull();
        expect(catalog.read().record.value.links.map(link => link.id)).toEqual(['neighbor-link']);
        expect(catalog.mutations).toEqual([]);
    });

    it('installs pinned registry files through the real skills Action and reads the produced library item without a native install', async () => {
        const catalog = servePromptLibraryCatalog('updated', { publicSource: true });
        await servePromptTransfers();
        const executor = createDefaultActionExecutor();
        const installed = await executor.execute('skills.install', { source: { kind: 'registry', ...registryPointer,
            version: registryItem.summary.version } }, { serverId, surface: 'ui' });
        expect(installed, JSON.stringify(installed)).toMatchObject({ ok: true, result: { skillIds: [expect.any(String)] } });
        if (!installed.ok) throw new Error(installed.error);
        const receipt = SKILL_ACTION_OUTPUT_SCHEMAS_V1['skills.install'].parse(installed.result);
        if (!('skillIds' in receipt)) throw new Error('Expected committed skill receipt');
        const read = await executor.execute('skills.read', { skillId: receipt.skillIds[0], file: 'scripts/review.sh' }, { serverId, surface: 'ui' });
        if (!read.ok) throw new Error(read.error);
        expect(SkillReadResultV1Schema.parse(read.result)).toMatchObject({
            skillId: receipt.skillIds[0], files: registryFixture.files.map(file => ({ path: file.path, unixMode: file.unixMode })),
            file: registryFixture.files[1], trust: 'runs_scripts',
            provenance: { kind: 'registry', registry: { ...registryPointer, ref: { commit: registryItem.summary.version } } },
        });
        expect(rpc.machine).toHaveBeenCalledWith(expect.objectContaining({ serverId, machineId: 'machine_1',
            method: 'daemon.directTransfer.export.prepare', payload: { t: 'prompt_registry_download_v1', kind: 'skill',
                ...registryPointer, version: registryItem.summary.version } }));
        expect(rpc.machine.mock.calls.map(([request]) => request).filter((request: DaemonRequest) =>
            request.method === 'daemon.directTransfer.import.prepare')).toEqual([]);
        expect(catalog.mutations).toEqual([]);
    });


    it('awaits cold registry preparation for the first Skills Updates diff without a second request', async () => {
        servePromptLibraryCatalog('updated', { publicSource: true });
        await servePromptTransfers();
        const executor = createDefaultActionExecutor();
        const installed = await executor.execute('skills.install', { source: { kind: 'registry', ...registryPointer,
            version: registryItem.summary.version } }, { serverId, surface: 'ui' });
        if (!installed.ok) throw new Error(installed.error);
        const receipt = SKILL_ACTION_OUTPUT_SCHEMAS_V1['skills.install'].parse(installed.result);
        if (!('skillIds' in receipt)) throw new Error('Expected committed skill receipt');
        // The checker has observed this source. Use the canonical stored lock
        // schema and real Artifact CAS; no public edit accepts upstream authority.
        const account = await captureLazyActionAccountContext(serverId);
        try {
            const store = createUiPromptLibraryArtifactStore(account.workflowArtifacts, account);
            const artifact = await store.read(receipt.skillIds[0]!);
            if (!artifact?.body || registryItem.payload.kind !== 'skill') throw new Error('Expected the installed registry skill');
            const { SkillLockV1Schema, readSkillLockV1 } = await import('@happier-dev/protocol/prompts/library/skills/skillLibraryItemV1');
            await store.update({ artifactId: artifact.id, expectedRevision: artifact.revision, body: artifact.body,
                header: { ...artifact.header, skillLock: SkillLockV1Schema.parse({ ...readSkillLockV1(artifact.header),
                    upstream: { state: 'current', latest: registryItem.payload.skill.ref } }) } });
        } finally { account.dispose(); }
        const transport = rpc.machine.getMockImplementation();
        if (!transport) throw new Error('Expected the real registry transport boundary');
        const release = createDeferred<void>();
        let preparations = 0;
        rpc.machine.mockImplementation(async (request: DaemonRequest) => {
            if (request.method === 'daemon.directTransfer.export.prepare') {
                preparations += 1;
                await release.promise;
            }
            return await transport(request);
        });
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        let settled = false;
        const pending = executor.execute('skills.updates.diff', { skillId: receipt.skillIds[0] }, { serverId, surface: 'ui' })
            .then(result => { settled = true; return result; });
        try {
            await vi.waitFor(() => expect(preparations).toBe(1));
            // Export preparation can fetch the pinned Git tree; the byte-phase
            // request deadline must not retire that containing operation.
            await vi.advanceTimersByTimeAsync(5_001);
            expect(settled).toBe(false);
            release.resolve();
            const result = await pending;
            expect(result.ok).toBe(true);
            if (!result.ok) throw new Error(result.error);
            const diff = SKILL_ACTION_OUTPUT_SCHEMAS_V1['skills.updates.diff'].parse(result.result);
            expect(diff.files.map(file => file.path)).toEqual(registryFixture.files.map(file => file.path));
            expect(preparations).toBe(1);
        } finally {
            release.resolve();
            vi.useRealTimers();
            await pending;
        }
    });

    it('does not create library content after cancellation during the registry download', async () => {
        const catalog = servePromptLibraryCatalog('updated');
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
            machineId: 'machine_1', ...registryPointer,
            installTarget: { assetTypeId: 'agents.skill', scope: 'user', targetName: 'review' },
        }, { serverId, surface: 'ui', signal: controller.signal }).then(
            result => ({ kind: 'returned' as const, result }),
            (error: unknown) => ({ kind: 'rejected' as const, error }),
        );
        expect(controller.signal.aborted).toBe(true);
        // The UI Account wrapper can reject cancellation while the Protocol
        // executor can return its failure envelope; neither permits a later effect.
        if (disposition.kind === 'rejected') expect(disposition.error).toMatchObject({ name: 'AbortError' });
        else {
            expect(disposition.result).toMatchObject({ ok: false });
            expect(disposition.result.ok ? undefined : disposition.result.details).not.toEqual(expect.objectContaining({ exported: true }));
        }
        expect(rpc.machine.mock.calls.map(([request]) => request).filter((request: DaemonRequest) => request.method === 'daemon.directTransfer.import.prepare')).toEqual([]);
        expect(homes.artifacts(serverId).list()).toEqual([]);
        expect(catalog.mutations).toEqual([]);
    });


    it('refuses an unavailable registry source row before creating library content', async () => {
        const catalog = servePromptLibraryCatalog('unavailable');
        await servePromptTransfers();
        const result = await createDefaultActionExecutor().execute('prompt_registry.install', { machineId: 'machine_1', ...registryPointer,
            installTarget: { assetTypeId: 'agents.skill', scope: 'user', targetName: 'review' } }, { serverId, surface: 'ui' });
        expect(result).toMatchObject({ ok: false });
        expect(rpc.machine).not.toHaveBeenCalled();
        expect(catalog.mutations).toEqual([]);
        expect(homes.requestsFor('/v2/account/settings').filter(request => request.input !== null)).toEqual([]);
    });

    it('keeps a retained registry install on its captured Home and ignores the old native target', async () => {
        const catalog = servePromptLibraryCatalog('updated');
        const displayedUrl = 'https://displayed-registry-install.test';
        const displayedServerId = await homes.addHome({ name: 'Displayed Home', serverUrl: displayedUrl, accountId: 'account-b' });
        await connection?.dispose();
        connection = await restoreServerAccountForTest({ serverUrl: displayedUrl, accountId: 'account-b' });
        installHomeGovernanceBoundaries(homes);
        const displayedScope = { serverId: displayedServerId, accountId: 'account-b' };
        storage.getState().activateProfileScope(displayedScope);
        await storage.getState().activateSettingsScope(displayedScope);
        storage.getState().applySettingsForScope(displayedScope, baseline.settings, 11);
        const displayedPreferences = storage.getState().settings;
        await servePromptTransfers();
        const result = await createDefaultActionExecutor().execute('prompt_registry.install', { machineId: 'machine_1', ...registryPointer,
            installTarget: { assetTypeId: 'agents.skill', scope: 'user', targetName: 'review' } }, { serverId, surface: 'ui' });
        expect(result, JSON.stringify(result)).toMatchObject({ ok: true, result: { exported: false, artifactId: expect.any(String) } });
        if (!result.ok) throw new Error(result.error);
        const receipt = result.result as Readonly<{ artifactId: string }>;
        expect(homes.artifacts(serverId).readPlainBody(receipt.artifactId)).not.toBeNull();
        expect(homes.artifacts(displayedServerId).list()).toEqual([]);
        expect(catalog.read().record.value.links.map(link => link.id)).toEqual(['neighbor-link']);
        expect(catalog.mutations).toEqual([]);
        expect(homes.requestsFor(`${PROMPT_LIBRARY_ROWS_ROUTE_V1}/external-links`).filter(request => request.input !== null))
            .toEqual([]);
        expect(rpc.machine.mock.calls.map(([request]) => request).filter((request: DaemonRequest) =>
            request.method === 'daemon.directTransfer.import.prepare')).toEqual([]);
        expect(storage.getState().settingsScope).toEqual(displayedScope);
        expect(storage.getState().settings).toEqual(displayedPreferences);
        const { getPromptLibraryCatalogValue } = await import('@/sync/store/settings/promptLibraryCatalogSnapshot');
        expect(getPromptLibraryCatalogValue(displayedScope, 'external-links').value?.links ?? []).toEqual([]);
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
        const machineRow = { ...createPlainMachineRowFixture({ id: 'machine_1', accountId: 'account-a' }), runnerContentKeyBinding: null };
        homes.answer(serverId, '/v1/machines', { body: [machineRow] });
        homes.answer(serverId, '/v1/machines/machine_1', { body: { machine: machineRow } });
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
            previews: [],
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
        const responses = new Map<string, unknown>([
            ['daemon.devices.simulator.preview.snapshot', { protocolVersion: 1, snapshot }],
            ['daemon.localServices.preview.snapshot', { protocolVersion: 1, snapshot: localServicePreviewSnapshot }],
            ['daemon.localServices.inventory.snapshot', { protocolVersion: 1, snapshot: localServiceInventorySnapshot }],
            ['daemon.localServices.launcher.snapshot', { protocolVersion: 1, snapshot: localServiceLauncherSnapshot }],
            ['daemon.localServices.launcher.start', localServiceLauncherStartResponse],
            ['daemon.localServices.actions.execute', { protocolVersion: 1, result: localServiceActionResult }],
            ['daemon.localServices.publicPreview.status', { protocolVersion: 1, snapshot: publicPreviewSnapshot }],
            ['daemon.localServices.publicPreview.create', publicPreviewCreateResponse],
            ['daemon.localServices.publicPreview.copyUrl', publicPreviewCopyUrlResponse],
        ]);
        machineRpcWithServerScopeMock.mockImplementation(async ({ method }: DaemonRequest) => {
            if (!responses.has(method)) throw new Error(`Unexpected native Machine RPC: ${method}`);
            return responses.get(method);
        });

        // Answer the human UI boundary while retaining real Action admission and confirmation presentation.
        vi.mocked(Modal.confirm).mockResolvedValue(true);
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
        })).resolves.toEqual(localServicePreviewSnapshot);
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
        })).resolves.toEqual(publicPreviewSnapshot);
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
        })).resolves.toEqual(publicPreviewCreateResponse);
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

    it('opens a managed Browser on the captured Machine before any Browser surface mounts', async () => {
        await admitBrowserAutomation();
        const { BrowserCommandDispatchResultV1Schema } = await import('@happier-dev/protocol/browser/control/v1');
        const input = { kind: 'openView' as const, commandId: 'managed-cold-open', browserSessionId: 'session_1',
            viewId: 'managed-view', target: { kind: 'externalUrl' as const, targetId: 'owned-page',
                url: 'http://127.0.0.1:35967/' }, platform: 'web' as const, focus: true };
        const output = BrowserCommandDispatchResultV1Schema.parse({ v: 1, commandId: input.commandId,
            status: 'dispatched', adapterKind: 'chromiumSidecar', events: [] });
        const machineRow = { ...createPlainMachineRowFixture({ id: 'browser-machine', accountId: 'account-a' }), runnerContentKeyBinding: null };
        homes.answer(serverId, '/v1/machines', { body: [machineRow] });
        homes.answer(serverId, '/v1/machines/browser-machine', { body: { machine: machineRow } });
        homes.answer(serverId, 'POST /v1/actions/browser.view.open', { select: request => {
            const envelope = ExternalActionRequestEnvelopeV1Schema.parse(request);
            expect(envelope).toMatchObject({ target: { kind: 'machine', machineId: 'browser-machine' }, input });
            return { body: ExternalActionResponseEnvelopeV1Schema.parse({ v: 1, actionId: 'browser.view.open',
                requestId: envelope.requestId, execution: { ok: true, result: output } }) };
        } });
        const executor = createDefaultActionExecutor();
        expect(await executor.execute('browser.view.open', input, { surface: 'ui', authority: 'present_user',
            actionCaller: { kind: 'host' }, presentUserConfirmation: { actionId: 'browser.view.open' },
            serverId, expectedAccountId: 'account-a', defaultSessionId: 'session_1',
            externalActionTarget: { kind: 'machine', machineId: 'browser-machine' },
        })).toEqual({ ok: true, result: output });
        expect(homes.requestsFor('/v1/actions/browser.view.open')).toHaveLength(1);
    });

    it('dispatches a daemon Browser observation to the captured Account and exact mounted Machine', async () => {
        await admitBrowserAutomation();
        const { applyBrowserControlEvent, createBrowserControlState } = await import('@/sync/domains/browser/control');
        const { buildBrowserAdapterCapabilities } = await import('@/sync/domains/browser/adapters/capabilities');
        const { BrowserAutomationActionResultV1Schema } = await import('@happier-dev/protocol/browser/automation/v1');
        const target = { kind: 'externalUrl' as const, targetId: 'external', url: 'https://browser.example.test/',
            display: { title: 'Browser', addressLabel: 'browser.example.test' } };
        const state = applyBrowserControlEvent(applyBrowserControlEvent(createBrowserControlState(), {
            kind: 'sessionCreated', eventId: 'session', browserSessionId: 'browser_session_1', profileId: 'profile', occurredAt: 1,
        }), {
            kind: 'viewOpened', eventId: 'view', browserSessionId: 'browser_session_1', viewId: 'view_1', target,
            platform: 'desktop', currentUrl: target.url, adapterKind: 'chromiumSidecar', engineKind: 'desktopWebView',
            adapterCapabilities: buildBrowserAdapterCapabilities({ adapterKind: 'chromiumSidecar',
                supportedTargetKinds: ['externalUrl'], supportedRenderEngines: ['desktopWebView'] }), occurredAt: 2,
        });
        const input = { v: 1, automationRequestId: 'observe', browserSessionId: 'browser_session_1', viewId: 'view_1',
            navigationGeneration: 0, requestedBy: 'user', requesterRef: { kind: 'session', id: 'session_1' },
            actionKind: 'snapshot', payload: {}, timeoutMs: 1000 };
        const output = BrowserAutomationActionResultV1Schema.parse({ v: 1, automationRequestId: 'observe', status: 'succeeded',
            durationMs: 1, adapterKind: 'chromiumSidecar', fidelity: 'cdp', trustedInput: true,
            navigationGenerationBefore: 0, navigationGenerationAfter: 0, controlEpochBefore: 0, controlEpochAfter: 0 });
        const machineRow = { ...createPlainMachineRowFixture({ id: 'browser-machine', accountId: 'account-a' }), runnerContentKeyBinding: null };
        homes.answer(serverId, '/v1/machines', { body: [machineRow] });
        homes.answer(serverId, '/v1/machines/browser-machine', { body: { machine: machineRow } });
        homes.answer(serverId, 'POST /v1/actions/browser.automation.snapshot', { select: request => {
            const envelope = ExternalActionRequestEnvelopeV1Schema.parse(request);
            expect(envelope).toMatchObject({ target: { kind: 'machine', machineId: 'browser-machine' }, input });
            return { body: ExternalActionResponseEnvelopeV1Schema.parse({ v: 1, actionId: 'browser.automation.snapshot',
                requestId: envelope.requestId, execution: { ok: true, result: output } }) };
        } });
        const executor = createDefaultActionExecutor({ runtimeActions: { browserControl: {
            readState: () => state, applyDispatchResult: () => {},
        } } });
        expect(await executor.execute('browser.automation.snapshot', input, { surface: 'ui', serverId,
            expectedAccountId: 'account-a', defaultSessionMachineId: 'other-machine',
            externalActionTarget: { kind: 'machine', machineId: 'browser-machine' },
        })).toEqual({ ok: true, result: output });
        expect(homes.requestsFor('/v1/actions/browser.automation.snapshot')).toHaveLength(1);
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
            // Navigation may require the present user's confirmation before reaching the surface adapter.
            vi.mocked(Modal.confirm).mockResolvedValue(true);
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
