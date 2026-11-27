import { onTestFinished, expect } from 'vitest';
import { ACTION_API_SERVER_ORIGIN } from '@happier-dev/protocol/rpc';
import { readAuthTokenProvenance } from '@happier-dev/protocol/auth/authToken';
import { decodeBase64 } from '@happier-dev/protocol/crypto/base64';
import { ExternalActionServerPrincipalV1Schema, ExternalActionRequestEnvelopeSchema, ExternalActionExecutionAuthorizationRequestV1Schema, ExternalActionHttpErrorSchema,
    ExternalActionExecutionAuthorizationV1Schema, ExternalActionExecutionAuthorizationVerifyRequestV1Schema,
    ExternalActionExecutionAuthorizationVerifyResponseV1Schema, EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER,
    EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER, EXTERNAL_ACTION_DAEMON_RPC_METHOD_V1,
    bindExternalActionExecutionAuthorizationHttpPathV1, bindExternalActionExecutionAuthorizationVerifyHttpPathV1,
    projectExternalActionApprovalDecisionEnvelopeAdmissionV1, parseExternalActionDaemonDispatchResult } from '@happier-dev/protocol/actions/externalActionApi';
import { computeExternalActionRequestEnvelopeDigestV1, verifyExternalActionMachineRequestV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { authorizeMachineRpcRequest, verifyMachineRpcAdmissionCurrent } from '@/api/machine/machineRpcAuthorization';
import { verifyExternalActionExecutionAuthorizationCurrent } from '@/api/externalActionExecutionAuthorization';
import { decodeJwtPayload, readAccountIdFromToken, readCredentialEpochFromToken } from '@/cloud/decodeJwtPayload';
import { createDaemonExternalActionTargetResolver } from '@/daemon/externalActions/daemonExternalActionTargetResolver';
import type { PrepareExternalActionRequesterAccountContext, VerifyExternalActionExecutionAuthorization } from '@/daemon/externalActions/executeExternalAction';
import { createDaemonApprovalExecutionAuthorizationPreparer } from '@/daemon/externalActions/approvalExecutionAuthorization';
import { createCurrentMachineExecutionOriginContextResolver } from '@/api/machine/resolveCurrentMachineExecutionOriginContext';
import type { readOrCreateInstallationIdentity } from '@/daemon/identity/store';
import { prepareRequesterAccountActionContext } from '@/daemon/sessionEncryption/requesterAccountActionProjection';
import type { StoredCredentials } from '@/persistence';
import { registerApprovalRpcHandlers } from '@/rpc/handlers/approvals';
import { registerExternalActionRpcHandler } from '@/rpc/handlers/externalAction';
import { createRequesterCurrentnessSocketHarness } from '@/testkit/backends/requesterCurrentnessSocketHarness';
import type { Server } from 'socket.io';
import type { createCliActionExecutorHarness } from './createCliActionExecutorHarness';
import { QualifiedConnectedAccountCredentialHealthPatchV4Schema, QualifiedConnectedAccountCredentialMutationSuccessV4Schema, QualifiedConnectedAccountCredentialMutationSupersededV4Schema, type QualifiedConnectedAccountCredentialSnapshotV4 } from '@happier-dev/protocol/connect/qualifiedConnectedAccountsV4';
import { QualifiedConnectedAccountCredentialSnapshotV4Schema } from '@happier-dev/protocol/connect/qualified-connected-account-projections';
import { sameQualifiedConnectedAccountRef } from '@happier-dev/protocol/connect/qualified-connected-account-persistence';
import Fastify, { type FastifyInstance } from 'fastify';
import { z } from 'zod/mini';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, ArtifactJsonCreateHttpInputV1Schema, FeaturesResponseSchema, decodePlainArtifactStoredContent, isPlainArtifactDataKeyMarker, type AccountSettings } from '@happier-dev/protocol';
import { deriveArtifactKindV1 } from '@happier-dev/protocol/artifacts/artifactKindV1';
import { PluginProjectionV2Schema, type PluginProjectionV2 } from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import { normalizePluginUiInlineSurfaceBindingV1 } from '@happier-dev/protocol/plugins/ui';
import { createResolvedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import type { ResolvedContributionRegistry } from '@/plugins/projection/registry/types';
import type { ResolvedExecutablePluginRuntimeRegistry } from '@/plugins/runtime/resolveExecutablePluginRuntimeRegistry';
import { createPluginRuntimeOccurrenceId } from '@/plugins/runtime/runtimeSlots';
import { artifactKindListResponse, artifactReadResponse } from '@/testkit/http/artifactHome';
import { SERVER_HTTP_REQUEST_MAX_BODY_UTF8_BYTES_V1 } from '@happier-dev/protocol/server/http/requestBodyBoundsV1';
import type { ArtifactCallerAccessV1 } from '@happier-dev/protocol/artifacts/artifactAccessV1';
import { decodeExternalActionHttpBodyV1, EXTERNAL_ACTION_HTTP_BODY_HEADER_V1,
    EXTERNAL_ACTION_HTTP_PROOF_HEADERS_V1, EXTERNAL_ACTION_HTTP_READ_BODY_MARKER_V1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { ActionAutomationIndexV1Schema, AUTOMATION_ACTION_INDEX_HTTP_PATH_V1 } from '@happier-dev/protocol/automations/automationActionTriggerV1';

export type CounterWidgetFixture = Readonly<{
    pluginId: string;
    inputType: Readonly<{ pluginId: string; localId: string }>;
    projection: PluginProjectionV2;
    registry: ResolvedContributionRegistry;
    readUiResource: NonNullable<ResolvedExecutablePluginRuntimeRegistry['readUiResource']>;
    definition: Readonly<{ kind: 'installed'; surface: Readonly<{ pluginId: string; localId: string }> }>;
}>;

/** One installed App-target widget with a contributed input type, as the daemon projects it. */
export function createCounterWidgetFixture(): CounterWidgetFixture {
    const pluginId = 'example.widgets';
    const inputType = { pluginId, localId: 'count-kind' };
    const occurrenceId = createPluginRuntimeOccurrenceId(pluginId);
    const type = { id: inputType.localId, title: 'Count', semantic: 'count-kind',
        valueSchema: { type: 'string' as const, enum: ['files', 'folders'] }, options: { resource: 'count-kinds' } };
    const binding = normalizePluginUiInlineSurfaceBindingV1({ pluginId, surfaceId: 'counter', rendererId: 'counter', role: 'widget', target: { kind: 'app' } });
    if (!binding) throw new Error('Expected widget binding');
    const projection = PluginProjectionV2Schema.parse({ v: 2, generation: 1, familiesById: {
        pluginUi: { family: 'pluginUi', entriesById: { counter: { id: 'counter', pluginId, contributionKind: 'surfacePlacement',
            descriptorId: 'counter', occurrenceId, binding, target: binding.target, display: { title: 'Directory count' },
            sizeDeclaration: { sizes: ['medium'], defaultSize: 'medium' },
            inputs: { fields: [{ path: 'filter', title: 'Count', widget: 'select', required: true, inputType }] },
            inputSchema: { type: 'object', properties: { filter: type.valueSchema }, required: ['filter'], additionalProperties: false },
        } } }, inputTypes: { family: 'inputTypes', entriesById: { [`${pluginId}/count-kind`]: {
            id: `${pluginId}/count-kind`, pluginId, pluginVersion: '1.0.0', occurrenceId, definition: type,
        } } },
    } });
    const registry = createResolvedContributionRegistry({ occurrenceIdsByPluginId: { [pluginId]: occurrenceId },
        inputTypes: [{ provenance: 'external', source: { kind: 'path' }, pluginId, identity: inputType,
            manifestPath: '/plugins/widgets/plugin.json', definition: type }],
        resources: [{ provenance: 'external', source: { kind: 'path' }, pluginId,
            definition: { kindVersion: 1, id: 'count-kinds', source: 'dynamic', type: 'config', scope: 'global', contentType: 'application/json' } }],
    });
    const readUiResource = async () => ({ resource: { pluginId, localId: 'count-kinds' }, kind: 'config' as const,
        contentType: 'application/json', digest: `sha256:${'a'.repeat(64)}`,
        bytes: new TextEncoder().encode(JSON.stringify([{ value: 'files', label: 'Files' }, { value: 'folders', label: 'Folders' }])) });
    return { pluginId, inputType, projection, registry, readUiResource,
        definition: { kind: 'installed' as const, surface: { pluginId, localId: 'counter' } } };
}

/** Model the Home's HTTP proof framing at the substituted transport boundary. */
export function registerActionHttpBodyBoundary(app: FastifyInstance) {
    app.addConstraintStrategy({
        name: 'externalActionRead', mustMatchWhenDerived: true,
        storage() {
            type Storage = ReturnType<Parameters<typeof app.addConstraintStrategy>[0]['storage']>;
            const handlers = new Map<unknown, Parameters<Storage['set']>[1]>();
            return { get: value => handlers.get(value) ?? null, set: (value, handler) => { handlers.set(value, handler); } };
        },
        deriveConstraint: request => request.method === 'POST'
            && request.headers[EXTERNAL_ACTION_HTTP_BODY_HEADER_V1] === EXTERNAL_ACTION_HTTP_READ_BODY_MARKER_V1 ? 'v1' : undefined,
    });
    app.addHook('onRoute', function (route) {
        if (!(Array.isArray(route.method) ? route.method : [route.method]).includes('GET')) return;
        this.route({ ...route, method: 'POST', url: route.url.slice(this.prefix.length) || '/',
            constraints: { ...route.constraints, externalActionRead: 'v1' } });
    });
    app.addHook('preValidation', async (request, reply) => {
        const marker = request.headers[EXTERNAL_ACTION_HTTP_BODY_HEADER_V1];
        if (marker === undefined) return;
        const isRead = marker === EXTERNAL_ACTION_HTTP_READ_BODY_MARKER_V1;
        const decoded = decodeExternalActionHttpBodyV1(request.body);
        if ((marker !== 'v1' && !isRead) || (isRead && request.method !== 'POST')
            || EXTERNAL_ACTION_HTTP_PROOF_HEADERS_V1.some(header => request.headers[header] !== undefined)
            || decoded === null || (isRead && decoded.body !== undefined)) {
            return reply.code(400).send({ error: 'invalid_request' });
        }
        if (isRead) request.raw.method = 'GET';
        Object.assign(request.headers, decoded.headers);
        request.body = decoded.body;
    });
}

/** The Home features and Account facts every CLI Action composition reads before an Artifact write. */
export function registerAccountHomeHttp(app: FastifyInstance, input: Readonly<{ accountId: string; serverId: string;
    settings?: Pick<AccountSettings, 'actionsSettingsV1'>; encryptionMode?: 'plain' | 'e2ee';
    actionHttpBodyAlreadyEnabled?: boolean;
    qualifiedCredential?: Readonly<{
        read(): QualifiedConnectedAccountCredentialSnapshotV4;
        write(snapshot: QualifiedConnectedAccountCredentialSnapshotV4): void;
    }>;
}>) {
    if (!input.actionHttpBodyAlreadyEnabled) registerActionHttpBodyBoundary(app);
    app.get(AUTOMATION_ACTION_INDEX_HTTP_PATH_V1, async () => ActionAutomationIndexV1Schema.parse({ v: 1, rows: [] }));
    const mode = input.encryptionMode ?? 'plain';
    app.get('/v1/account/encryption', async () => ({ mode, updatedAt: 1 }));
    app.get('/v1/account/encryption/currentness', async () => ({ mode, version: 1,
        signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 }));
    app.get('/v1/account/profile', async () => ({ id: input.accountId }));
    app.get('/v2/account/settings', async () => ({ content: { t: 'plain', v: input.settings ?? {} }, version: 1 }));
    const credentialStore = input.qualifiedCredential;
    if (credentialStore) app.patch('/v4/connect/qualified/credential/health', async (request, reply) => {
        const parsed = QualifiedConnectedAccountCredentialHealthPatchV4Schema.safeParse(request.body);
        if (!parsed.success) return reply.code(400).send({ error: 'invalid-params' });
        const patch = parsed.data;
        const credential = credentialStore.read();
        if (!sameQualifiedConnectedAccountRef(patch.ref, credential.ref)) return reply.code(404).send({ error: 'connect_credential_not_found' });
        if (patch.expectedCredentialRevision !== credential.credentialRevision
            || patch.expectedConfigurationRevision !== credential.configurationRevision) {
            return reply.code(409).send(QualifiedConnectedAccountCredentialMutationSupersededV4Schema.parse({
                error: 'connect_credential_mutation_superseded',
                reason: patch.expectedCredentialRevision !== credential.credentialRevision
                    ? 'credential_revision_mismatch' : 'configuration_revision_mismatch',
                credentialRevision: credential.credentialRevision, configurationRevision: credential.configurationRevision,
            }));
        }
        credentialStore.write(QualifiedConnectedAccountCredentialSnapshotV4Schema.parse({ ...credential,
            health: patch.health, ...(patch.exportProjection ? { exportProjection: patch.exportProjection } : {}) }));
        return QualifiedConnectedAccountCredentialMutationSuccessV4Schema.parse({ success: true,
            credentialRevision: credential.credentialRevision, configurationRevision: credential.configurationRevision });
    });
    return FeaturesResponseSchema.parse({ features: { sessions: { enabled: true, board: { enabled: true } } },
        capabilities: { serverIdentity: { serverIdentityId: input.serverId } } });
}

type MachineReceiverFixtureInput = Readonly<{
    machineId: string; serverId: string; serverIdentityId: string; serverHttpBaseUrl: string;
    credentials: StoredCredentials;
    installation: Awaited<ReturnType<typeof readOrCreateInstallationIdentity>>;
}>;
type MachineReceiverExecutor = ReturnType<typeof createCliActionExecutorHarness>['executor'];

function createFixtureExecutionAuthorizationVerifier(input: MachineReceiverFixtureInput): VerifyExternalActionExecutionAuthorization {
    const privateKey = decodeBase64(input.installation.privateKey, 'base64url');
    return request => verifyExternalActionExecutionAuthorizationCurrent({ ...request, privateKey,
        installationId: input.installation.installationId, serverHttpBaseUrl: input.serverHttpBaseUrl });
}

/** The receiver's own private custody owner, as the daemon composes it for this installation. */
function createFixtureRequesterAccountContextPreparer(input: MachineReceiverFixtureInput,
    executor: () => MachineReceiverExecutor, custody: AbortSignal): PrepareExternalActionRequesterAccountContext {
    const verifyExecutionAuthorization = createFixtureExecutionAuthorizationVerifier(input);
    const installationPrivateKey = decodeBase64(input.installation.privateKey, 'base64url');
    return request => prepareRequesterAccountActionContext({ ...request,
        purpose: request.purpose ?? { kind: 'external_action' }, machineId: input.machineId,
        installationId: input.installation.installationId, installationPrivateKey,
        ownCredentials: input.credentials, serverId: input.serverId, serverIdentityId: input.serverIdentityId,
        serverHttpBaseUrl: input.serverHttpBaseUrl,
        isCurrent: () => verifyExecutionAuthorization({ authorization: request.authorization,
            effectActionId: request.authorization.binding.actionId, target: request.authorization.binding.target,
            ...(request.signal ? { signal: request.signal } : {}) }),
        isCustodyCurrent: async () => !custody.aborted, createExecutor: executor,
    });
}

/**
 * The replay preparer production composes into the receiving daemon executor:
 * stored approvals drop private ports, and replay rebuilds them for this Machine.
 * `executor` is read lazily because the receiving executor is built with this preparer.
 */
export function createMachineApprovalReplayPreparer(input: MachineReceiverFixtureInput & Readonly<{
    executor: () => MachineReceiverExecutor;
}>) {
    const daemonWork = new AbortController();
    onTestFinished(() => daemonWork.abort());
    return createDaemonApprovalExecutionAuthorizationPreparer({
        machineId: input.machineId, serverId: input.serverId, serverBaseUrl: input.serverHttpBaseUrl,
        daemonWorkSignal: daemonWork.signal,
        resolveCurrentMachineExecutionOriginContext: createCurrentMachineExecutionOriginContextResolver({
            serverUrl: input.serverHttpBaseUrl, resolveCurrentMachineId: () => input.machineId }),
        prepareRequesterAccountContext: createFixtureRequesterAccountContextPreparer(input, input.executor, daemonWork.signal),
    });
}

type MachineActionHomeFixtureInput = MachineReceiverFixtureInput & Readonly<{
    accountId: string;
    retainedAction?: ReturnType<typeof ExternalActionExecutionAuthorizationV1Schema.parse>;
    actionId?: string;
    accountEncryptionMode?: 'plain' | 'e2ee';
    /** Explicit Home admission responses for other authenticated bearers; no authority is issued. */
    executionAuthorizationRefusals?: ReadonlyArray<Readonly<{
        token: string;
        statusCode: number;
        body: ReturnType<typeof ExternalActionHttpErrorSchema.parse>;
    }>>;
}>;

/** Authenticated Home issuance and verification at the substituted HTTP boundary. */
export function registerMachineActionAuthorizationHomeHttp(app: FastifyInstance, input: MachineActionHomeFixtureInput) {
    const provenance = readAuthTokenProvenance(decodeJwtPayload(input.credentials.token), { allowLegacyHome: false });
    if (provenance?.provenance.kind !== 'account') throw new Error('Expected the fixture Account credential');
    const principal = ExternalActionServerPrincipalV1Schema.parse({
        accountId: readAccountIdFromToken(input.credentials.token), authority: provenance.provenance.authority,
        authentication: { kind: provenance.provenance.kind, tokenEpoch: readCredentialEpochFromToken(input.credentials.token) },
    });
    expect(principal.accountId).toBe(input.accountId);
    const publicKey = decodeBase64(input.installation.publicKey, 'base64url');
    const actionId = input.actionId ?? 'approval.request.decide';
    const issued = new Map<string, ReturnType<typeof ExternalActionExecutionAuthorizationV1Schema.parse>>();
    const mintPath = bindExternalActionExecutionAuthorizationHttpPathV1(actionId);
    const issue = (envelope: ReturnType<typeof ExternalActionRequestEnvelopeSchema.parse>) => {
        expect(envelope.target).toEqual({ kind: 'machine', machineId: input.machineId });
        const approvalDecisionAdmission = projectExternalActionApprovalDecisionEnvelopeAdmissionV1({ actionId, envelope });
        const authorization = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1,
            token: `fixture-decision-admission-${computeExternalActionRequestEnvelopeDigestV1(envelope)}`, binding: {
                serverIdentityId: input.serverIdentityId, accountId: principal.accountId, custodianAccountId: input.accountId,
                authentication: principal.authentication, accountEncryptionMode: input.accountEncryptionMode ?? 'plain',
                machineId: input.machineId, installationId: input.installation.installationId,
                actionId, requestId: envelope.requestId, target: envelope.target,
                requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope),
                ...(envelope.v === 2 && envelope.machineRuntimeDemand ? { machineRuntimeDemand: envelope.machineRuntimeDemand } : {}),
                ...(approvalDecisionAdmission ? { approvalDecisionAdmission } : {}),
            } });
        issued.set(authorization.token, authorization);
        return authorization;
    };
    // Other named bearers may receive an explicit Home refusal, never this principal's authority.
    const mintRefusals = new Map(input.executionAuthorizationRefusals?.map(refusal => [
        `Bearer ${refusal.token}`, { statusCode: refusal.statusCode, body: ExternalActionHttpErrorSchema.parse(refusal.body) },
    ]));
    app.post(mintPath, async (request, reply) => {
        const refusal = mintRefusals.get(String(request.headers.authorization));
        if (refusal) return reply.code(refusal.statusCode).send(refusal.body);
        expect(request.headers.authorization === `Bearer ${input.credentials.token}`, 'Unexpected fixture authorization bearer').toBe(true);
        const body = ExternalActionExecutionAuthorizationRequestV1Schema.parse(request.body);
        expect(body.machineId).toBe(input.machineId);
        return issue(body.envelope);
    });
    const registerVerify = (verifiedActionId: string) => {
        const path = bindExternalActionExecutionAuthorizationVerifyHttpPathV1(verifiedActionId);
        app.post(path, async request => {
            const token = String(request.headers[EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]);
            const authorization = input.retainedAction?.token === token ? input.retainedAction : issued.get(token);
            if (authorization?.binding.actionId !== verifiedActionId) throw new Error('Unknown fixture admission');
            const body = ExternalActionExecutionAuthorizationVerifyRequestV1Schema.parse(request.body);
            expect(body.binding).toEqual(authorization.binding);
            expect(verifyExternalActionMachineRequestV1({ authorizationToken: authorization.token,
                effectActionId: authorization.binding.actionId, target: authorization.binding.target,
                installationId: input.installation.installationId, requestId: authorization.binding.requestId,
                method: 'POST', path, body, publicKey,
                signature: String(request.headers[EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER]),
            })).toBe(true);
            return ExternalActionExecutionAuthorizationVerifyResponseV1Schema.parse({ ok: true });
        });
    };
    registerVerify(actionId);
    if (input.retainedAction && input.retainedAction.binding.actionId !== actionId) {
        registerVerify(input.retainedAction.binding.actionId);
    }
    return { actionId, principal, issue, issued };
}

/** Home HTTP/socket substitutions from remoteDecider; registered receiver and private custody stay real. */
export async function registerMachineActionHomeHttp(app: FastifyInstance, input: MachineActionHomeFixtureInput & Readonly<{
    executor: ReturnType<typeof createCliActionExecutorHarness>['executor'];
    /** Add the fixture's genuine scoped RPC network peer beside Account updates. */
    configureScopedRpcNetwork?: (input: Readonly<{
        server: Server;
        issued: ReadonlyMap<string, ReturnType<typeof ExternalActionExecutionAuthorizationV1Schema.parse>>;
        prepareRequesterAccountContext: PrepareExternalActionRequesterAccountContext;
    }>) => void;
}>) {
    const { actionId, principal, issue, issued } = registerMachineActionAuthorizationHomeHttp(app, input);
    const privateKey = decodeBase64(input.installation.privateKey, 'base64url');
    const lifetime = new AbortController();
    const currentnessChannel = await createRequesterCurrentnessSocketHarness({ preserveScopedRpcOrigin: !input.configureScopedRpcNetwork });
    onTestFinished(async () => { lifetime.abort(); await currentnessChannel.close(); });
    const prepareRequesterAccountContext = createFixtureRequesterAccountContextPreparer(input, () => input.executor, lifetime.signal);
    input.configureScopedRpcNetwork?.({ server: currentnessChannel.server, issued, prepareRequesterAccountContext });
    const rpc = new RpcHandlerManager({ scopePrefix: input.machineId, encryptionMode: 'plain', logger: () => {},
        authorizeRequest: request => authorizeMachineRpcRequest(request, {
            machineId: input.machineId,
            resolveHomeServerIdentityId: async () => input.serverIdentityId,
            resolveCustodianAccountId: async () => input.accountId,
            resolveInstallationId: () => input.installation.installationId,
            verifyMachineAdmission: request => verifyMachineRpcAdmissionCurrent({ ...request,
                privateKey, daemonToken: input.credentials.token, serverHttpBaseUrl: input.serverHttpBaseUrl }),
        }),
    });
    registerApprovalRpcHandlers({ rpcHandlerManager: rpc, actionExecutor: input.executor });
    const verifyExecutionAuthorization = createFixtureExecutionAuthorizationVerifier(input);
    registerExternalActionRpcHandler(rpc, {
        machineId: input.machineId, currentServerId: input.serverId, currentServerHttpBaseUrl: input.serverHttpBaseUrl,
        resolveAccountId: async () => input.accountId, resolveInstallationId: () => input.installation.installationId,
        externalActionMachineRequestPrivateKey: privateKey, verifyExecutionAuthorization,
        resolveTarget: createDaemonExternalActionTargetResolver({ credentials: input.credentials, serverApiUrl: input.serverHttpBaseUrl }),
        executor: input.executor,
        prepareRequesterAccountContext,
    });
    app.post(`/v1/actions/${actionId}`, async request => {
        expect(request.headers.authorization === `Bearer ${input.credentials.token}`, 'Unexpected fixture authorization bearer').toBe(true);
        const carrier = ExternalActionExecutionAuthorizationRequestV1Schema.safeParse(request.body);
        const body = carrier.success ? carrier.data : { machineId: input.machineId,
            envelope: ExternalActionRequestEnvelopeSchema.parse(request.body), executionAuthorization: undefined };
        expect(body.machineId).toBe(input.machineId);
        expect(body.envelope.target).toEqual({ kind: 'machine', machineId: input.machineId });
        const authorization = body.executionAuthorization ?? issue(body.envelope);
        expect(issued.get(authorization.token)?.binding).toEqual(authorization.binding);
        const encryptionMode = authorization.binding.accountEncryptionMode;
        if (!encryptionMode) throw new Error('Home admission omitted Account encryption mode');
        const relayed = parseExternalActionDaemonDispatchResult(await rpc.handleRequest({
            method: `${input.machineId}:${EXTERNAL_ACTION_DAEMON_RPC_METHOD_V1}`,
            authorization: ACTION_API_SERVER_ORIGIN,
            callerAuthority: principal.authority,
            machineAdmission: {
                actorAccountId: principal.accountId,
                custodianAccountId: authorization.binding.custodianAccountId,
                machineId: authorization.binding.machineId,
                installationId: authorization.binding.installationId,
                role: 'manage',
                encryptionMode,
            },
            params: { actionId, envelope: body.envelope, executionAuthorization: authorization, principal,
                placement: { machineId: input.machineId, target: { kind: 'machine', machineId: input.machineId } } },
        }, undefined, 'authenticated_home_socket'));
        if (!relayed || relayed.kind !== 'response') throw new Error('Invalid daemon dispatch response kind');
        return relayed.prepared.response;
    });
    return rpc;
}

export { registerMachineActionHomeHttp as registerMachineApprovalDecisionHomeHttp };

type ArtifactRow<Mode extends 'plain' | 'e2ee'> = {
    id: string; ownerAccountId: string; access: ArtifactCallerAccessV1; encryptionMode: Mode; publicAudience: 'none';
    header: string; body: string; dataEncryptionKey: string;
    provenance?: string; provenanceDataEncryptionKey?: string;
    headerVersion: number; bodyVersion: number; seq: number; createdAt: number; updatedAt: number;
};

/** The Account Artifact HTTP surface; content remains opaque on the encrypted branch. */
export function registerAccountArtifactRoutes<const Mode extends 'plain' | 'e2ee'>(app: FastifyInstance, accountId: string,
    { encryptionMode }: Readonly<{ encryptionMode: Mode }>) {
    const rows = new Map<string, ArtifactRow<Mode>>();
    const seed = (id: string, header: string, body: string, dataEncryptionKey = ARTIFACT_PLAIN_DATA_KEY_MARKER,
        ownership: Readonly<{ ownerAccountId: string; access: ArtifactCallerAccessV1 }> = { ownerAccountId: accountId, access: 'owner' }) => {
        if (isPlainArtifactDataKeyMarker(dataEncryptionKey) !== (encryptionMode === 'plain')) throw new Error('artifact_mode_mismatch');
        rows.set(id, { id, ...ownership, encryptionMode, publicAudience: 'none', header, body,
            dataEncryptionKey, headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 });
    };
    const idOf = (params: unknown) => String((params as { id: string }).id);
    app.get('/v1/artifacts', async (request, reply) => {
        const query = new URL(request.url, 'http://fixture.test').searchParams;
        const kind = query.get('kind');
        const exactKinds = query.get('kinds');
        const indexedKinds = query.get('indexedKinds');
        const unclassified = query.get('unclassified');
        if ([kind, exactKinds, indexedKinds, unclassified].filter(value => value !== null).length > 1) {
            return reply.code(400).send({ error: 'Failed to get artifacts' });
        }
        let selectedKinds: string[] | undefined;
        if (exactKinds !== null || indexedKinds !== null) {
            try {
                selectedKinds = z.array(z.string().check(z.minLength(1))).parse(JSON.parse((exactKinds ?? indexedKinds)!));
            } catch {
                return reply.code(400).send({ error: 'Failed to get artifacts' });
            }
        }
        const items = [...rows.values()];
        if (kind === null && selectedKinds === undefined && unclassified === null) return items;
        if (encryptionMode === 'e2ee') return {
            items: unclassified !== null ? items : [], hasUnclassified: items.length > 0,
            coverage: items.length > 0 ? { status: 'partial', unclassifiedCount: items.length, reason: 'unclassified_legacy_rows' }
                : { status: 'complete', unclassifiedCount: 0 },
        };
        return artifactKindListResponse(unclassified !== null ? [] : items.filter(row => {
            const classification = deriveArtifactKindV1(z.looseObject({}).parse(decodePlainArtifactStoredContent(row.header)));
            return kind !== null ? classification.kind === kind
                : classification.kindHint !== null && selectedKinds?.includes(classification.kindHint) === true;
        }));
    });
    app.post('/v1/artifacts/read', async request => artifactReadResponse(request.body, id => rows.get(id) ?? null).data);
    app.get('/v1/artifacts/:id', async (request, reply) => rows.get(idOf(request.params)) ?? reply.code(404).send({ error: 'not_found' }));
    app.get('/v1/artifacts/:id/access/recipients', async (request, reply) => {
        const row = rows.get(idOf(request.params));
        return row ? { artifactId: row.id, ownerAccountId: row.ownerAccountId, access: row.access, encryptionMode,
            dataEncryptionKey: row.dataEncryptionKey, callerDataEncryptionKey: row.dataEncryptionKey,
            provenanceDataEncryptionKey: row.provenanceDataEncryptionKey ?? null,
            callerProvenanceDataEncryptionKey: row.provenanceDataEncryptionKey ?? null, recipients: [] } : reply.code(404).send({ error: 'not_found' });
    });
    app.get('/v1/artifacts/:id/access/grants', async (request, reply) => {
        const row = rows.get(idOf(request.params));
        return row ? { artifactId: row.id, ownerAccountId: row.ownerAccountId, access: row.access, grants: [] } : reply.code(404).send({ error: 'not_found' });
    });
    app.post('/v1/artifacts', { bodyLimit: SERVER_HTTP_REQUEST_MAX_BODY_UTF8_BYTES_V1 }, async (request, reply) => {
        const parsed = ArtifactJsonCreateHttpInputV1Schema.safeParse(request.body);
        if (!parsed.success) return reply.code(400).send({ error: 'invalid-params' });
        const create = parsed.data;
        const incumbent = rows.get(create.id);
        if (incumbent) return incumbent;
        seed(create.id, create.header, create.body, create.dataEncryptionKey);
        const row = rows.get(create.id)!;
        if (create.provenance != null) row.provenance = create.provenance;
        if (create.provenanceDataEncryptionKey != null) row.provenanceDataEncryptionKey = create.provenanceDataEncryptionKey;
        return row;
    });
    app.post('/v1/artifacts/:id', { bodyLimit: SERVER_HTTP_REQUEST_MAX_BODY_UTF8_BYTES_V1 }, async request => {
        const row = rows.get(idOf(request.params));
        if (!row) throw new Error('artifact_missing');
        const update = z.looseObject({ header: z.string(), body: z.string(), expectedHeaderVersion: z.number(), expectedBodyVersion: z.number(),
            provenance: z.optional(z.string()), provenanceDataEncryptionKey: z.optional(z.string()) }).parse(request.body);
        if (update.expectedHeaderVersion !== row.headerVersion || update.expectedBodyVersion !== row.bodyVersion) return { success: false, error: 'version-mismatch' };
        const next = { ...row, header: update.header, body: update.body, headerVersion: row.headerVersion + 1, bodyVersion: row.bodyVersion + 1,
            ...(update.provenance === undefined ? {} : { provenance: update.provenance }),
            ...(update.provenanceDataEncryptionKey === undefined ? {} : { provenanceDataEncryptionKey: update.provenanceDataEncryptionKey }) };
        rows.set(row.id, next);
        return { success: true, headerVersion: next.headerVersion, bodyVersion: next.bodyVersion };
    });
    app.delete<{ Params: { id: string; headerVersion: string; bodyVersion: string } }>(
        '/v1/artifacts/:id/revision/:headerVersion/:bodyVersion', async ({ params }, reply) => {
            const row = rows.get(params.id);
            if (!row) return reply.code(404).send({ error: 'not_found' });
            if (row.headerVersion !== Number(params.headerVersion) || row.bodyVersion !== Number(params.bodyVersion)) {
                return reply.code(409).send({ error: 'version-mismatch' });
            }
            rows.delete(params.id);
            return { success: true };
        });
    return { seed, read: (id: string) => rows.get(id) };
}

/** Existing keyless callers retain their original storage boundary and defaults. */
export function registerPlainArtifactRoutes(app: FastifyInstance, accountId: string) {
    return registerAccountArtifactRoutes(app, accountId, { encryptionMode: 'plain' });
}

/** Preserve the published list envelope when an HTTP-boundary fixture has no Artifacts. */
export async function readEmptyPlainArtifactListFixture(url: string, accountId: string) {
    const app = Fastify();
    registerPlainArtifactRoutes(app, accountId);
    try {
        const requestUrl = new URL(url);
        const response = await app.inject({ method: 'GET', url: requestUrl.pathname + requestUrl.search });
        return { status: response.statusCode, data: response.json() };
    } finally { await app.close(); }
}
