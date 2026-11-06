import { projectExternalActionMachineRuntimeDemandV1 } from '@happier-dev/protocol/actions/actionSpecs';
import { randomUUID } from 'node:crypto';
import type { FastifyRequest, FastifyReply } from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { symbols, type DestinationStream } from 'pino';
import { logger } from '@/utils/logging/log';
import nacl from 'tweetnacl';
import { Server } from 'socket.io';
import { io as ioClient } from 'socket.io-client';
import {
    AccountSettingsSchema, SessionPendingEnqueueByMachineRequestV1Schema, SessionPendingEnqueueByMachineResponseV1Schema,
    SESSION_PENDING_ENQUEUE_BY_MACHINE_EVENT_V1, signAccountContentKeyBindingV1,
    encodePlainMachineStoredContent, MACHINE_PLAIN_DATA_KEY_MARKER,
    API_TOKEN_FULL_GRANT_V1, WorkflowDefinitionV1Schema, AutomationStoredWorkflowDefinitionRecipeV2Schema,
    AutomationV3RunMutationResponseSchema,
    createActionExecutor,
} from '@happier-dev/protocol';
import { ApiTokenGrantV1Schema } from '@happier-dev/protocol/auth/apiTokenGrant';
import { sealAccountScopedBlobCiphertext } from '@happier-dev/protocol/crypto/accountScopedCipher';
import {
    EXTERNAL_ACTION_DAEMON_RPC_METHOD_V1, EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER, ExternalActionDaemonDispatchRequestSchema,
    createExternalActionDaemonDispatchResponse, sealExternalActionRequestV2, openExternalActionResponseV2,
    ExternalActionRequestEnvelopeV1Schema, ExternalActionResponseEnvelopeV1Schema,
    signExternalActionMachineRpcRequestV1, type ExternalActionExecutionAuthorizationV1,
} from '@happier-dev/protocol/actions';
import { SOCKET_RPC_EVENTS, type SocketRpcRequestPayload } from '@happier-dev/protocol/socketRpc';
import { createSessionOwnerMetadataV1, projectSessionSharedMetadataV1,
    encodeSessionOwnerMetadataEnvelopeV1 } from '@happier-dev/protocol/sessions/metadata/sessionMetadataSchemasV1';
import { sealSessionOwnerMetadataEnvelopeV1 } from '@happier-dev/protocol/sessions/metadata/sessionMetadataEnvelopesV1';
import { sealEncryptedDataKeyEnvelopeV1 } from '@happier-dev/protocol/crypto/encryptedDataKeyEnvelopeV1';
import { encodeBase64, decodeBase64, encrypt, decryptResult } from '../../../../../cli/src/api/encryption';
import { createAuthenticatedTestApp } from '@/app/api/testkit/sqliteFastify';
import { qualifyCurrentAccountStoredContentSocket, currentAccountStoredContentCompatibilityHeaders } from '@/app/api/testkit/accountStoredContentCompatibility';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';
import { db } from '@/storage/db';
import { auth } from '@/app/auth/auth';
import { getOrCreateServerIdentityId } from '@/app/serverIdentity/serverIdentity';
import { registerExternalActionRoutes } from '../routes/actions/registerExternalActionRoutes';
import { registerAccountEncryptionRoutes } from '../routes/account/registerAccountEncryptionRoutes';
import { registerAccountSettingsRoutes } from '../routes/account/registerAccountSettingsRoutes';
import { registerSessionListingRoutes } from '../routes/session/registerSessionListingRoutes';
import { registerSessionArchiveRoutes } from '../routes/session/registerSessionArchiveRoutes';
import { sessionPendingRoutes } from '../routes/session/pendingRoutes';
import { machinesRoutes } from '../routes/machines/machinesRoutes';
import { featuresRoutes } from '../routes/features/featuresRoutes';
import { registerAutomationV3Routes } from '../routes/automations/registerAutomationV3Routes';
import { artifactsRoutes } from '../routes/artifacts/artifactsRoutes';
import { registerStoredContentPublicShareRoutes } from '../routes/share/registerStoredContentPublicShareRoutes';
import { createExternalActionDaemonDispatcher, resolveCurrentSessionMachineFromServer } from './externalActionDispatcher';
import { buildRpcMethodRoom } from './rpc/rpcMethodRoom';
import { machineUpdateHandler } from './machineUpdateHandler';
import { createSessionPublisherPresence } from '@/app/presence/sessionPublisherPresence';
import { getAccountSessionSocketRoom } from '@/app/api/socketRooms';
import { createCliActionExecutorFromCredentials } from '../../../../../cli/src/session/actions/createCliActionExecutorFromCredentials';
import { createDaemonExternalActionTargetResolver } from '../../../../../cli/src/daemon/externalActions/daemonExternalActionTargetResolver';
import { executeExternalAction } from '../../../../../cli/src/daemon/externalActions/executeExternalAction';
import { verifyExternalActionExecutionAuthorizationCurrent, createExternalActionAuthorizedRequestHeaders,
    projectExternalActionRequesterHttpAuthorization,
    prepareExternalActionRequesterAccountAuthorization } from '../../../../../cli/src/api/externalActionExecutionAuthorization';
import { createActionSettingsProvider } from '../../../../../cli/src/settings/actionsSettingsProvider';
import { createCliApprovalsArtifactStore } from '../../../../../cli/src/session/actions/approvals/artifactStore';
import { runWithServerHttpBaseUrl } from '../../../../../cli/src/api/client/serverHttpBaseUrl';
import { createCliActionDeps } from '../../../../../cli/src/session/actions/createCliActionDeps';
import { createMemoryDocInLibrary } from '@happier-dev/protocol/prompts/library/promptLibraryActionOperations';
import { signMachineInstallationProof } from '@happier-dev/protocol/machines/identity/installationIdentity';
import { bindExternalActionExecutionAuthorizationHttpPathV1, ExternalActionExecutionAuthorizationV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { computeExternalActionRequestEnvelopeDigestV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';

describe('original external Session Action currentness composition', () => {
    let harness: LightSqliteHarness;
    beforeAll(async () => {
        harness = await createLightSqliteHarness({ tempDirPrefix: 'happier-session-currentness-', initAuth: true, initEncrypt: true,
            env: { HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: 'optional' } });
    }, 120_000);
    afterAll(async () => { await harness.close(); });

    it.each([
        { kind: 'account', accountMode: 'e2ee', sessionMode: 'e2ee', runConsent: 'waived' },
        { kind: 'account', accountMode: 'e2ee', sessionMode: 'e2ee', runConsent: 'ask' },
        { kind: 'terminal', accountMode: 'e2ee', sessionMode: 'plain', runConsent: 'waived' },
        { kind: 'account', accountMode: 'plain', sessionMode: 'plain', runConsent: 'waived' },
        { kind: 'terminal', accountMode: 'e2ee', sessionMode: 'e2ee', runConsent: 'waived', publisherGap: true },
        { kind: 'account', accountMode: 'plain', sessionMode: 'plain', runConsent: 'waived', memoryExposure: true },
        { kind: 'account', accountMode: 'e2ee', sessionMode: 'e2ee', runConsent: 'waived', memoryExposure: true },
        { kind: 'account', accountMode: 'e2ee', sessionMode: 'e2ee', runConsent: 'waived', selfArchive: true },
    ] as const)('sends through real daemon execution for $kind, $accountMode Account, $sessionMode Session, $runConsent Run consent, publisher gap $publisherGap, memory exposure $memoryExposure, self archive $selfArchive', async scenario => {
        const { kind, accountMode, sessionMode, runConsent } = scenario;
        const publisherGap = 'publisherGap' in scenario && scenario.publisherGap;
        const memoryExposure = 'memoryExposure' in scenario && scenario.memoryExposure;
        const selfArchive = 'selfArchive' in scenario && scenario.selfArchive;
        const material = { type: 'dataKey' as const, machineKey: new Uint8Array(32).fill(17) };
        const contentKey = nacl.box.keyPair.fromSecretKey(material.machineKey).publicKey;
        const signing = nacl.sign.keyPair();
        const account = await db.account.create({ data: {
            encryptionMode: accountMode, publicKey: Buffer.from(signing.publicKey).toString('hex'),
            contentPublicKey: contentKey, contentPublicKeySig: signAccountContentKeyBindingV1({
                accountSigningSecretKey: signing.secretKey, contentPublicKey: contentKey,
            }),
        } });
        const installation = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(19));
        const installationId = randomUUID();
        const machineId = randomUUID();
        await db.machine.create({ data: { id: machineId, accountId: account.id, installationId,
            installationPublicKey: installation.publicKey,
            metadata: accountMode === 'plain' ? encodePlainMachineStoredContent({ host: 'qa8', platform: 'linux', happyCliVersion: 'test' }) : 'opaque',
            ...(accountMode === 'plain' ? { dataEncryptionKey: decodeBase64(MACHINE_PLAIN_DATA_KEY_MARKER) } : {}), active: true,
            lastActiveAt: new Date(), operationProtocolCapabilitiesRevision: 1,
            operationProtocolCapabilities: { externalActionExecutionAuthorization: { protocolVersions: [1] },
                sessionInputAdmission: { protocolVersions: [1, 2] } },
        } });
        const metadata = { machineId, path: '/workspace', host: 'qa8', homeDir: '/home/qa8', permissionMode: 'default',
            ...(publisherGap ? { flavor: 'codex', codexSessionId: 'gap-vendor-session' } : {}) };
        const owner = createSessionOwnerMetadataV1({ metadata });
        if (!owner.ok) throw new Error('Canonical owner metadata fixture refused');
        const sessionKey = new Uint8Array(32).fill(24);
        const shared = projectSessionSharedMetadataV1({ metadata });
        const session = await db.session.create({ data: { accountId: account.id, tag: randomUUID(),
            encryptionMode: sessionMode, metadataLayoutVersion: 1,
            metadata: sessionMode === 'plain' ? JSON.stringify(shared) : encodeBase64(encrypt(sessionKey, 'dataKey', shared)),
            ownerMetadata: encodeSessionOwnerMetadataEnvelopeV1(accountMode === 'plain'
                ? { t: 'plain', v: owner.ownerMetadata } : sealSessionOwnerMetadataEnvelopeV1({
                material, ownerMetadata: owner.ownerMetadata, randomBytes: length => new Uint8Array(length).fill(20),
            })), active: true, lastActiveAt: new Date(),
        } });
        if (sessionMode === 'e2ee') await db.sessionDataKeyEnvelope.create({ data: { sessionId: session.id,
            recipientAccountId: account.id, encryptedDataKey: sealEncryptedDataKeyEnvelopeV1({ dataKey: sessionKey,
                recipientPublicKey: contentKey, randomBytes: length => new Uint8Array(length).fill(25) }),
        } });
        await db.accessKey.create({ data: { accountId: account.id, machineId, sessionId: session.id, data: 'opaque' } });
        const token = await auth.createToken(account.id, undefined, { kind,
            authority: kind === 'account' ? 'present_user' : 'account_automation' });
        // The installed daemon bearer differs from the external caller. Signed
        // effect reads below must never carry this ambient credential.
        const daemonToken = await auth.createToken(account.id, undefined, { kind: 'terminal', authority: 'account_automation' });
        const credentials = { token: daemonToken, encryption: accountMode === 'plain' ? null : { ...material, publicKey: contentKey } };
        const homeId = await getOrCreateServerIdentityId();
        const app = createAuthenticatedTestApp({ authentication: 'real' });
        const httpReads: Array<{ path: string; status: number; signed: boolean; bearer: boolean }> = [];
        const runEffects: Array<{ path: string; status: number; signed: boolean; bearer: boolean }> = [];
        const runFailures: Array<{ requestId: string | undefined; status: number; error: unknown }> = [];
        app.addHook('onSend', async (request: FastifyRequest, reply: FastifyReply, payload: unknown) => {
            if (request.url.endsWith('/run-now') && reply.statusCode >= 400 && typeof payload === 'string') {
                const body: unknown = JSON.parse(payload);
                runFailures.push({ requestId: request.externalActionExecutionAuthorizationBinding?.requestId,
                    status: reply.statusCode, error: body && typeof body === 'object' && 'error' in body ? body.error : undefined });
            }
            return payload;
        });
        app.addHook('onResponse', async (request: FastifyRequest, reply: FastifyReply) => {
            if (request.url.startsWith('/v1/account/encryption/currentness') || request.url.startsWith('/v2/sessions/')
                || request.url.startsWith('/v1/artifacts/') || request.url.startsWith('/v1/public-shares?')) {
                httpReads.push({ path: request.url, status: reply.statusCode,
                    signed: typeof request.headers[EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER] === 'string',
                    bearer: request.headers.authorization !== undefined });
            }
            if (request.url.endsWith('/run-now')) runEffects.push({ path: request.url, status: reply.statusCode,
                signed: typeof request.headers[EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER] === 'string',
                bearer: request.headers.authorization !== undefined });
        });
        registerAccountEncryptionRoutes(app);
        registerAccountSettingsRoutes(app);
        registerSessionListingRoutes(app);
        registerSessionArchiveRoutes(app);
        sessionPendingRoutes(app);
        machinesRoutes(app);
        app.get('/v2/sessions/:sessionId/qa8-unbound', { preHandler: app.authenticate,
            config: { apiTokenSessionAction: 'session.transcript.get' } }, async () => ({ exposed: true }));
        featuresRoutes(app);
        registerAutomationV3Routes(app);
        artifactsRoutes(app);
        registerStoredContentPublicShareRoutes(app);
        const io = new Server(app.server, { path: '/v1/updates', transports: ['websocket'] });
        // Admit real credential facts at the socket transport boundary, as startSocket does.
        io.use(async (socket, next) => {
            const verified = await auth.verifyTokenForRoute(socket.handshake.auth.token);
            if (!verified || verified.userId !== account.id) return next(new Error('invalid_token'));
            socket.data.authTokenKind = verified.authTokenKind;
            socket.data.authAuthority = verified.authority;
            socket.data.authTokenAuthenticationEvidence = verified.authenticationEvidence;
            next();
        });
        const presence = createSessionPublisherPresence();
        let receivingSocket: import('socket.io').Socket | undefined;
        let publisherSocket: import('socket.io').Socket | undefined;
        let lastAuthorization: ExternalActionExecutionAuthorizationV1 | undefined;
        let received = 0;
        let refusalCorrelation: 'original' | 'omitted' | 'mismatched' = 'original';
        let admittedSockets = 0;
        const ready = new Promise<void>((resolve, reject) => io.on('connection', socket => {
            void (async () => {
                qualifyCurrentAccountStoredContentSocket(socket);
                if (socket.handshake.auth.role === 'session') {
                    publisherSocket = socket;
                    socket.data.clientType = 'session-scoped'; socket.data.userId = account.id; socket.data.sessionId = session.id;
                    expect((await presence.registerPublisher({ socket, binding: { accountId: account.id, machineId, sessionId: session.id },
                        completeActivitySnapshot: { state: 'active', activeCount: 1 } })).status).toBe('registered');
                    await socket.join(getAccountSessionSocketRoom(account.id, session.id));
                } else {
                    receivingSocket = socket;
                    socket.data.clientType = 'machine-scoped'; socket.data.userId = account.id;
                    socket.data.machineId = machineId; socket.data.verifiedMachineInstallationId = installationId;
                    machineUpdateHandler(account.id, socket, { operationSocketBatchLimits: {
                        ok: true, limits: { maxItems: 200, maxSerializedBytes: 524_288 },
                    } });
                    await socket.join(buildRpcMethodRoom({ userId: account.id, method: `${machineId}:${EXTERNAL_ACTION_DAEMON_RPC_METHOD_V1}` }));
                }
                admittedSockets += 1;
                if (admittedSockets === 2) resolve();
            })().catch(reject);
        }));
        app.decorate('resolveCurrentSessionMachine', (input: Readonly<{ accountId: string; sessionId: string }>) =>
            resolveCurrentSessionMachineFromServer({ io, presence, ...input }));
        registerExternalActionRoutes(app, { dispatch: createExternalActionDaemonDispatcher({ io, sessionPublisherPresence: presence }) });
        const serverHttpBaseUrl = await app.listen({ port: 0, host: '127.0.0.1' });
        const daemon = ioClient(serverHttpBaseUrl, { path: '/v1/updates', transports: ['websocket'], autoConnect: false,
            reconnection: false, auth: { token: daemonToken } });
        const publisher = ioClient(serverHttpBaseUrl, { path: '/v1/updates', transports: ['websocket'], autoConnect: false,
            reconnection: false, auth: { role: 'session', token: daemonToken } });
        const executorParams = { credentials, readCredentials: async () => credentials,
            serverId: 'qa8-profile', serverApiUrl: serverHttpBaseUrl, serverIdentityId: homeId, machineId,
            externalActionMachineRequestPrivateKey: installation.secretKey, externalActionMachineInstallationId: installationId,
            ...(publisherGap ? { machineActionDirectTargetTransport: { machineId,
                // Physical runner launch is the boundary; real Action, signed
                // admission, encryption and Pending custody remain composed.
                invoke: async (_method: string, request: unknown) => {
                    expect(request).toMatchObject({ type: 'resume-session', sessionId: session.id, resume: 'gap-vendor-session' });
                    return { type: 'success', sessionId: session.id };
                },
            } } : {}),
            // This composition owns its policy; ambient Account snapshots and
            // standalone CLI environment overrides must not alter its approval path.
            actionsSettingsProvider: createActionSettingsProvider({ allowEnvironmentOverride: false, getAccountSettings: () => AccountSettingsSchema.parse({
                actionsSettingsV1: { v: 1, actions: {}, approvalWaivedSurfaces: runConsent === 'waived'
                    ? { 'workflow.trigger.run_now': ['api'] } : {} },
            }) }),
            // Installed Machine identity is the runtime boundary. Durable Artifact
            // decoding, requester projection and signed HTTP verification stay real.
            isApprovalExecutionOriginCurrent: async () => true,
            prepareApprovalExecutionAuthorization: async ({ authorization, signal }) => {
                const projected = await projectExternalActionRequesterHttpAuthorization({ authorization,
                    serverId: 'qa8-profile', serverIdentityId: homeId, serverHttpBaseUrl,
                    target: authorization.binding.target, installationId, privateKey: installation.secretKey,
                    ...(signal ? { signal } : {}) });
                return projected ? { authorization: projected } : null;
            },
            // This adapter represents only the Machine socket network edge. The
            // actual signed enqueue handler and durable Pending owner stay real.
            machineAdmissionTransport: async (request, options) => {
                if (request.v !== 1 || !options?.callerInputAuthorization) throw new Error('Signed Session input required');
                const authorization = options.callerInputAuthorization;
                const parsed = SessionPendingEnqueueByMachineRequestV1Schema.parse(request);
                const { externalAction: _incomingProof, ...unsignedRequest } = parsed;
                const target = { kind: 'session' as const, sessionId: unsignedRequest.sessionId };
                const event = SESSION_PENDING_ENQUEUE_BY_MACHINE_EVENT_V1;
                const payload = { ...unsignedRequest, externalAction: { v: 1, authorization, target,
                    effectActionId: 'session.message.send', installationId,
                    machineSignature: signExternalActionMachineRpcRequestV1({ authorizationToken: authorization.token,
                        effectActionId: 'session.message.send', target, installationId, event, method: event,
                        requestId: authorization.binding.requestId, params: unsignedRequest, privateKey: installation.secretKey }),
                } };
                const response: unknown = await daemon.emitWithAck(event, payload);
                return SessionPendingEnqueueByMachineResponseV1Schema.parse(response).result;
            },
        } satisfies Parameters<typeof createCliActionExecutorFromCredentials>[0];
        const executor = createCliActionExecutorFromCredentials(executorParams);
        const approverCredentials = { ...credentials, token, credentialProvenance: 'stored_session' as const };
        const approverStore = runWithServerHttpBaseUrl(serverHttpBaseUrl, () => createCliApprovalsArtifactStore({
            credentials: approverCredentials, serverId: 'qa8-profile', serverHttpBaseUrl,
        }));
        // The app's real decision owner forwards its authenticated decision to
        // the original daemon. Substitute only that transport edge in-process.
        const approver = createActionExecutor({ ...approverStore, isApprovalExecutionOriginCurrent: async () => true,
            approvalRequestApprovedReplay: async ({ artifactId }) => executor.replayApprovedApprovalRequest({
                artifactId, callerAuthority: 'present_user',
            }),
        });
        const resolveTarget = createDaemonExternalActionTargetResolver({ credentials, serverApiUrl: serverHttpBaseUrl });
        daemon.on(SOCKET_RPC_EVENTS.REQUEST, async (raw: SocketRpcRequestPayload, acknowledge: (response: unknown) => void) => {
            received += 1;
            const request = ExternalActionDaemonDispatchRequestSchema.parse(raw.params);
            lastAuthorization = request.executionAuthorization;
            const result = await executeExternalAction({ actionId: request.actionId, envelope: request.envelope,
                principal: request.principal, executionAuthorization: request.executionAuthorization,
                currentMachineId: machineId, currentAccountId: account.id, currentServerId: 'qa8-profile',
                currentInstallationId: installationId, currentServerHttpBaseUrl: serverHttpBaseUrl,
                externalActionMachineRequestPrivateKey: installation.secretKey,
                verifyExecutionAuthorization: input => verifyExternalActionExecutionAuthorizationCurrent({ ...input,
                    privateKey: installation.secretKey, installationId, serverHttpBaseUrl }),
                resolveEncryption: async () => {
                    if (accountMode === 'plain') throw new Error('Plain Action must not request encryption material');
                    return { serverIdentityId: homeId, material };
                }, resolveTarget, executor,
            });
            if (result.kind !== 'response') {
                // Exercise the actual daemon admission producer, including the
                // legacy uncorrelated shape and a corrupted network response.
                const { requestId, ...refusal } = result;
                acknowledge({ ...refusal, ...(refusalCorrelation === 'omitted' ? {}
                    : { requestId: refusalCorrelation === 'mismatched' ? 'different-request' : requestId }) });
                return;
            }
            acknowledge(createExternalActionDaemonDispatchResponse(result.prepared));
        });
        const binding = { serverIdentityId: homeId, accountId: account.id,
            authentication: { kind, tokenEpoch: account.tokenEpoch }, actionId: 'session.message.send',
            requestId: 'qa8-send', target: publisherGap ? { kind: 'session' as const, sessionId: session.id }
                : { kind: 'machine' as const, machineId } };
        const input = { sessionId: session.id, message: 'QA8', localId: 'qa8-input', permissionModeOverride: 'read_only', wait: false };
        const envelope = accountMode === 'e2ee'
            ? sealExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1, binding, material, randomBytes: length => new Uint8Array(length).fill(21), input })
            : ExternalActionRequestEnvelopeV1Schema.parse({ v: 1, requestId: binding.requestId,
                target: { kind: 'session', sessionId: session.id }, input });
        const relay = () => app.inject({ method: 'POST', url: '/v1/actions/session.message.send',
            headers: { authorization: `Bearer ${token}`, 'x-happier-authority-ceiling': 'account_automation' }, payload: envelope });
        try {
            const connected = new Promise<void>((resolve, reject) => { daemon.once('connect', resolve); daemon.once('connect_error', reject); });
            daemon.connect(); publisher.connect(); await connected; await ready;
            expect(await resolveCurrentSessionMachineFromServer({ io, presence, accountId: account.id, sessionId: session.id }))
                .toBe(machineId);
            if (selfArchive) {
                const actionId = 'session.archive';
                const requestId = randomUUID();
                const target = { kind: 'machine' as const, machineId };
                const authorization = await prepareExternalActionRequesterAccountAuthorization({
                    actionId, input: { sessionId: session.id }, requestId, target, machineId,
                    sourceMachineId: machineId, accountId: account.id, accountEncryptionMode: accountMode,
                    tokenEpochHint: account.tokenEpoch, token, material,
                    serverId: 'qa8-profile', serverIdentityId: homeId, serverHttpBaseUrl,
                    installationId, privateKey: installation.secretKey,
                    sessionActionOrigin: { v: 1, caller: { kind: 'session', sessionId: session.id,
                        starterDepth: 0, turnDepth: 0 }, sourceTurnId: 'self-archive-turn',
                        callerPermissionMode: 'default', requestId },
                });
                expect(authorization).not.toBeNull();
                if (!authorization) throw new Error('Own Session root must pass the real publisher resolver');
                expect((await presence.registerPublisher({ socket: publisherSocket!,
                    binding: { accountId: account.id, machineId, sessionId: session.id },
                    completeActivitySnapshot: { state: 'active', activeCount: 1 } })).status).toBe('registered');
                expect((await presence.touchPublisher({ socket: publisherSocket! })).status).toBe('touched');
                expect(await verifyExternalActionExecutionAuthorizationCurrent({ authorization, effectActionId: actionId,
                    target, installationId, privateKey: installation.secretKey, serverHttpBaseUrl })).toBe(true);
                const path = `/v2/sessions/${session.id}/archive`;
                const response = await app.inject({ method: 'POST', url: path, payload: {}, headers:
                    createExternalActionAuthorizedRequestHeaders({ authorization, effectActionId: actionId,
                        target, installationId, privateKey: installation.secretKey, method: 'POST', path, body: {} }) });
                expect(response.statusCode, response.body).toBe(409);
                expect((await db.session.findUniqueOrThrow({ where: { id: session.id } })).active).toBe(true);
                expect((await presence.closePublisher({ socket: publisherSocket! })).status).toBe('closed');
                const records: unknown[] = [];
                // Capture only the external logging sink; authorization and publisher resolution remain real.
                const stream = Reflect.get(logger, symbols.streamSym) as DestinationStream;
                const sink = vi.spyOn(stream, 'write').mockImplementation(chunk => { records.push(JSON.parse(String(chunk))); });
                try {
                    expect(await verifyExternalActionExecutionAuthorizationCurrent({ authorization, effectActionId: actionId,
                        target, installationId, privateKey: installation.secretKey, serverHttpBaseUrl })).toBe(false);
                    const refusals = records.filter(record => record && typeof record === 'object'
                        && 'module' in record && record.module === 'external-action-authorization-refusal');
                    expect(refusals).toEqual([expect.objectContaining({ phase: 'source_before_principal' })]);
                    const serialized = JSON.stringify(refusals);
                    for (const privateValue of [authorization.token, token, account.id, session.id, machineId, requestId]) {
                        expect(serialized).not.toContain(privateValue);
                    }
                } finally { sink.mockRestore(); }
                return;
            }
            if (memoryExposure) {
                const created = await runWithServerHttpBaseUrl(serverHttpBaseUrl, () => createMemoryDocInLibrary({
                    store: approverStore.promptLibraryStore, randomId: randomUUID, sourceSessionRef: null,
                    request: { title: 'Private proposal memory', text: 'Retained seed' },
                }));
                const actionId = 'approval.request.create';
                const origin = { v: 1 as const, caller: { kind: 'session' as const, sessionId: session.id, starterDepth: 0, turnDepth: 0 },
                    sourceTurnId: 'memory-proposal-turn', callerPermissionMode: null, requestId: 'private-memory-proposal' };
                const source = { machineId, installationId };
                const proposalInput = { actionId: 'memory.remember',
                        actionArgs: { ref: { kind: 'doc', artifactId: created.artifactId },
                            expectedRevision: { headerVersion: 1, bodyVersion: 1 }, text: 'Proposed fact' },
                        summary: 'Remember a fact', createdBy: { surface: 'agent' } };
                const proposalTarget = { kind: 'machine' as const, machineId };
                const proposal = accountMode === 'e2ee' ? sealExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1, material, randomBytes: nacl.randomBytes,
                    binding: { serverIdentityId: homeId, accountId: account.id, actionId, requestId: origin.requestId,
                        target: proposalTarget, authentication: { kind, tokenEpoch: account.tokenEpoch } }, input: proposalInput })
                    : ExternalActionRequestEnvelopeV1Schema.parse({ v: 1, requestId: origin.requestId,
                        target: proposalTarget, input: proposalInput });
                const minted = await app.inject({ method: 'POST', url: bindExternalActionExecutionAuthorizationHttpPathV1(actionId),
                    headers: { authorization: `Bearer ${token}` }, payload: { v: 1, machineId, envelope: proposal,
                        sessionActionOrigin: origin, sessionActionSource: source,
                        installationProof: signMachineInstallationProof({ privateKey: installation.secretKey,
                            payload: { version: 1, accountId: account.id, ...source, externalActionOrigin: {
                                homeId, actionId, requestId: origin.requestId,
                                requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(proposal), origin } } }) } });
                expect(minted.statusCode, minted.body).toBe(200);
                const authorization = ExternalActionExecutionAuthorizationV1Schema.parse(minted.json());
                const host = createCliActionDeps({ token: daemonToken, credentials, sessionId: session.id, mode: 'plain', ctx: null,
                    serverId: 'qa8-profile', serverIdentityId: homeId, serverHttpBaseUrl,
                    externalActionMachineRequestPrivateKey: installation.secretKey, externalActionMachineInstallationId: installationId });
                const before = httpReads.length;
                const beforeArtifact = await db.artifact.findUniqueOrThrow({ where: { id: created.artifactId } });
                expect(await host.memoryLibrary!.readExposure(created.artifactId, { surface: 'agent', authority: 'account_automation',
                    serverId: homeId, externalActionExecutionAuthorization: authorization, externalActionTarget: authorization.binding.target }))
                    .toMatchObject({ grants: { artifactId: created.artifactId, access: 'owner', grants: [] }, publicShares: { publicShares: [] } });
                expect(httpReads.slice(before)).toEqual([
                    { path: `/v1/artifacts/${created.artifactId}/access/grants`, status: 200, signed: true, bearer: false },
                    { path: `/v1/public-shares?subjectKind=artifact&subjectId=${created.artifactId}`, status: 200, signed: true, bearer: false },
                ]);
                const afterArtifact = await db.artifact.findUniqueOrThrow({ where: { id: created.artifactId } });
                expect({ header: afterArtifact.header, body: afterArtifact.body, headerVersion: afterArtifact.headerVersion, bodyVersion: afterArtifact.bodyVersion })
                    .toEqual({ header: beforeArtifact.header, body: beforeArtifact.body, headerVersion: beforeArtifact.headerVersion, bodyVersion: beforeArtifact.bodyVersion });
                return;
            }
            if (publisherGap) {
                expect((await presence.closePublisher({ socket: publisherSocket! })).status).toBe('closed');
                publisher.disconnect();
                expect(await resolveCurrentSessionMachineFromServer({ io, presence, accountId: account.id, sessionId: session.id })).toBeNull();
            }
            if (runConsent === 'waived') {
                const response = await relay();
                expect(response.statusCode, response.body).toBe(200);
                const opened = envelope.v === 2
                    ? openExternalActionResponseV2({ envelope: response.json(), binding, material, request: envelope })
                    : ExternalActionResponseEnvelopeV1Schema.parse(response.json()).execution;
                expect(opened, JSON.stringify({ opened, httpReads, received })).toMatchObject({ ok: true, result: { status: 'accepted', localId: 'qa8-input' } });
                expect(httpReads).toContainEqual({ path: '/v1/account/encryption/currentness', status: 200, signed: true, bearer: false });
                const pending = await db.sessionPendingMessage.findMany({ where: { sessionId: session.id } });
                expect(pending).toHaveLength(1);
                const content = pending[0]?.content;
                if (sessionMode === 'plain') expect(content).toMatchObject({ t: 'plain', v: { meta: { permissionMode: 'read-only' } } });
                else {
                    if (!content || typeof content !== 'object' || Array.isArray(content) || content.t !== 'encrypted' || typeof content.c !== 'string') {
                        throw new Error('Expected encrypted Pending content');
                    }
                    expect(decryptResult(sessionKey, 'dataKey', decodeBase64(content.c))).toMatchObject({ status: 'authenticated',
                        value: { meta: { permissionMode: 'read-only' } } });
                }
                expect((await db.session.findUniqueOrThrow({ where: { id: session.id } })).ownerMetadata).toBe(session.ownerMetadata);
                if (publisherGap && envelope.v === 2) {
                    const replay = await relay();
                    expect(replay.statusCode).toBe(200);
                    expect(openExternalActionResponseV2({ envelope: replay.json(), binding, material, request: envelope }))
                        .toMatchObject({ ok: true, result: { status: 'alreadyAccepted', localId: 'qa8-input' } });
                    expect(await db.sessionPendingMessage.count({ where: { sessionId: session.id } })).toBe(1);
                    return;
                }
                const target = { kind: 'session' as const, sessionId: session.id };
                const signed = (path: string, body?: unknown) => app.inject({ method: 'GET', url: path,
                    ...(body === undefined ? {} : { payload: body }), headers: { ...currentAccountStoredContentCompatibilityHeaders,
                        ...createExternalActionAuthorizedRequestHeaders({
                        authorization: lastAuthorization!, effectActionId: 'session.message.send', target,
                        method: 'GET', path, ...(body === undefined ? {} : { body }),
                        installationId, privateKey: installation.secretKey,
                    }) } });
                for (const path of ['/v1/account/encryption/currentness?accountId=other', '/v1/account/encryption', '/v2/account/settings']) {
                    expect((await signed(path)).statusCode, path).toBe(401);
                }
                expect((await signed(`/v1/machines/${machineId}`)).statusCode).toBe(200);
                expect((await signed('/v1/machines/another-machine')).statusCode).toBe(401);
                expect((await signed('/v2/sessions/foreign-session?accessProjectionVersion=1')).statusCode).toBe(401);
                expect((await signed(`/v2/sessions/${session.id}/qa8-unbound`)).statusCode).toBe(401);
                const foreign = await db.account.create({ data: { publicKey: null, encryptionMode: 'plain' } });
                const foreignToken = await auth.createToken(foreign.id, undefined, { kind: 'account', authority: 'present_user' });
                const foreignResponse = await app.inject({ method: 'POST', url: '/v1/actions/session.message.send',
                    headers: { authorization: `Bearer ${foreignToken}` }, payload: ExternalActionRequestEnvelopeV1Schema.parse({
                        v: 1, requestId: 'qa8-foreign', target: binding.target, input,
                    }) });
                expect(foreignResponse.statusCode).toBe(200);
                expect(ExternalActionResponseEnvelopeV1Schema.parse(foreignResponse.json()).execution)
                    .toMatchObject({ ok: false, errorCode: 'target_not_local' });
                expect(received).toBe(1);
                if (accountMode === 'e2ee') {
                    const invalidPlainRequest = () => app.inject({ method: 'POST', url: '/v1/actions/session.message.send',
                        headers: { authorization: `Bearer ${token}` }, payload: ExternalActionRequestEnvelopeV1Schema.parse({
                            v: 1, requestId: 'qa8-invalid-plain', target: binding.target, input,
                        }) });
                    for (const correlation of ['original', 'omitted', 'mismatched'] as const) {
                        refusalCorrelation = correlation;
                        const refused = await invalidPlainRequest();
                        if (correlation === 'mismatched') {
                            expect(refused.statusCode, refused.body).toBe(200);
                            expect(refused.json()).toMatchObject({ execution: { ok: false, errorCode: 'target_unavailable' } });
                        } else {
                            expect(refused.statusCode, refused.body).toBe(400);
                            expect(refused.json()).toMatchObject({ error: 'invalid_request', code: 'invalid_envelope' });
                        }
                    }
                    expect(await db.sessionPendingMessage.count({ where: { sessionId: session.id } })).toBe(1);
                }
                const receivedBeforeMisbound = received;
                receivingSocket!.data.verifiedMachineInstallationId = 'misbound-installation';
                const misbound = await relay();
                if (envelope.v === 2) expect(misbound.statusCode).toBe(409);
                else {
                    expect(misbound.statusCode).toBe(200);
                    expect(ExternalActionResponseEnvelopeV1Schema.parse(misbound.json()).execution)
                        .toMatchObject({ ok: false, errorCode: 'target_unavailable' });
                }
                expect(received).toBe(receivedBeforeMisbound);
                receivingSocket!.data.verifiedMachineInstallationId = installationId;
                refusalCorrelation = 'original';
            }
            if (accountMode === 'e2ee' && kind === 'account') {
                const automationIds = [randomUUID(), randomUUID()];
                const definition = WorkflowDefinitionV1Schema.parse({ version: 1, blocks: [{ kind: 'wait', id: 'wait',
                    document: { text: 'Wait for QA', references: [], attachments: [] } }] });
                const recipe = AutomationStoredWorkflowDefinitionRecipeV2Schema.parse({ v: 2, templateVersion: 1,
                    workflow: { t: 'encrypted', c: sealAccountScopedBlobCiphertext({ kind: 'automation_template_payload', material,
                        randomBytes: nacl.randomBytes,
                        payload: { workspace: { directory: '/workspace' }, executionTarget: { kind: 'session' }, inlineDefinition: definition } }) },
                    triggerEvidence: null });
                for (const id of automationIds) await db.automation.create({ data: { id, accountId: account.id,
                    name: 'QA wait', enabled: true, targetType: null, templateVersion: 1, templateCiphertext: JSON.stringify(recipe),
                    assignments: { create: { machineId, enabled: true, priority: 0 } } } });
                const grant = ApiTokenGrantV1Schema.parse({ ...API_TOKEN_FULL_GRANT_V1,
                    actions: { families: [], ids: ['workflow.trigger.run_now'] },
                    targets: { machines: [machineId], sessions: [] }, automationIds: [automationIds[0]] });
                const pat = await auth.createApiToken({ accountId: account.id, tokenId: randomUUID(), label: 'QA exact wait', grant });
                const prepareRun = (automationId: string | undefined, idempotencyKey?: string,
                    signedKey = idempotencyKey, credential = pat) => {
                    const root = { serverIdentityId: homeId, accountId: account.id, credentialId: credential.tokenId,
                        actionId: 'workflow.trigger.run_now', requestId: randomUUID(), target: { kind: 'machine' as const, machineId } };
                    const sealed = sealExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1, binding: root, material, randomBytes: nacl.randomBytes,
                        input: { ...(automationId === undefined ? {} : { automationId }),
                            ...(idempotencyKey === undefined ? {} : { idempotencyKey }) } });
                    const request = { ...sealed, ...(signedKey === undefined ? {} : { idempotencyKey: signedKey }) };
                    return { root, request, credential };
                };
                const sendRun = async ({ root, request, credential }: ReturnType<typeof prepareRun>, headerKey?: string) => {
                    const runEffectsBefore = runEffects.length;
                    const response = await app.inject({ method: 'POST', url: '/v1/actions/workflow.trigger.run_now',
                        headers: { authorization: `Bearer ${credential.token}`,
                            ...(headerKey === undefined ? {} : { 'idempotency-key': headerKey }) }, payload: request });
                    return { response, requestId: root.requestId, runEffectsBefore, execution: response.statusCode === 200
                        ? openExternalActionResponseV2({ envelope: response.json(), binding: root, material, request }) : undefined };
                };
                const approveRun = async (sent: Awaited<ReturnType<typeof sendRun>>) => {
                    if (runConsent === 'waived') return sent.execution;
                    expect(sent.execution).toMatchObject({ ok: true, result: { kind: 'approval_request_created' } });
                    expect(runEffects).toHaveLength(sent.runEffectsBefore);
                    const result = sent.execution?.ok ? sent.execution.result : undefined;
                    if (!result || typeof result !== 'object' || !('artifactId' in result) || typeof result.artifactId !== 'string') {
                        throw new Error('Expected durable Run approval');
                    }
                    const decided = await runWithServerHttpBaseUrl(serverHttpBaseUrl, () => approver.execute('approval.request.decide', { artifactId: result.artifactId, decision: 'approve' }, {
                        surface: 'ui', authority: 'present_user', serverId: 'qa8-profile', runtimeAccountId: account.id,
                    }));
                    expect(decided, JSON.stringify({ requestId: sent.requestId, decided, runFailures }))
                        .toMatchObject({ ok: true, result: { status: 'executed', execution: { ok: true } } });
                    const decision = decided.ok ? decided.result : undefined;
                    if (!decision || typeof decision !== 'object' || !('execution' in decision)) throw new Error('Expected approved execution');
                    return decision.execution;
                };
                const invoke = (automationId: string | undefined) => sendRun(prepareRun(automationId));
                const runReceipt = (execution: unknown) => {
                    if (!execution || typeof execution !== 'object' || !('result' in execution)) throw new Error('Expected Run receipt');
                    return AutomationV3RunMutationResponseSchema.parse(execution.result);
                };
                const parkedRunReceipt = async (execution: unknown) => {
                    const receipt = runReceipt(execution);
                    // The real worker parks a wait-only Workflow in this physical
                    // state before the person approves a later request. Seed that
                    // persisted worker output; admission and receipt reads stay real.
                    await db.automationRun.update({ where: { id: receipt.run.id }, data: { state: 'waiting_for_review' } });
                    return { ok: true, result: { run: { id: receipt.run.id, automationId: receipt.run.automationId, state: 'running' } } };
                };
                const original = prepareRun(automationIds[0]);
                const allowed = await sendRun(original);
                expect(allowed.response.statusCode, allowed.response.body).toBe(200);
                const originalExecution = await approveRun(allowed);
                expect(originalExecution, JSON.stringify({ execution: originalExecution, runEffects, runFailures }))
                    .toMatchObject({ ok: true, result: { run: { automationId: automationIds[0], state: 'queued' } } });
                expect(runEffects).toEqual([{ path: `/v3/automations/${automationIds[0]}/run-now`, status: 200, signed: true, bearer: false }]);
                const admittedAuthorization = lastAuthorization!;
                const originalRejoined = runConsent === 'ask' ? await parkedRunReceipt(originalExecution) : originalExecution;
                expect(await approveRun(await sendRun(original))).toMatchObject(originalRejoined!);
                const keyed = await sendRun(prepareRun(automationIds[0], 'qa-manual-key'));
                const keyedExecution = await approveRun(keyed);
                expect(keyedExecution).toMatchObject({ ok: true });
                const keyedAuthorization = lastAuthorization!;
                const keyedRejoined = runConsent === 'ask' ? await parkedRunReceipt(keyedExecution) : keyedExecution;
                expect(await approveRun(await sendRun(prepareRun(automationIds[0], 'qa-manual-key')))).toMatchObject(keyedRejoined!);
                expect(runReceipt(keyedExecution).run.id).not.toBe(runReceipt(originalExecution).run.id);
                const differentKey = await approveRun(await sendRun(prepareRun(automationIds[0], 'qa-different-key')));
                expect(runReceipt(differentKey).run.id).not.toBe(runReceipt(keyedExecution).run.id);
                const secondPat = await auth.createApiToken({ accountId: account.id, tokenId: randomUUID(), label: 'QA second', grant });
                try {
                    const separate = await sendRun(prepareRun(automationIds[0], 'qa-manual-key', 'qa-manual-key', secondPat));
                    const separateExecution = await approveRun(separate);
                    expect(separateExecution).toMatchObject({ ok: true });
                    expect(runReceipt(separateExecution).run.id).not.toBe(runReceipt(keyedExecution).run.id);
                } finally { await auth.revokeApiToken({ accountId: account.id, tokenId: secondPat.tokenId }); }
                const mismatchedInput = await sendRun(prepareRun(automationIds[0], 'qa-body-key', 'qa-signed-key'));
                expect(mismatchedInput.response.statusCode).toBe(400);
                expect(mismatchedInput.response.json()).toMatchObject({ code: 'invalid_encrypted_envelope' });
                const headerMismatch = await sendRun(prepareRun(automationIds[0], 'qa-manual-key'), 'qa-altered-header');
                expect(headerMismatch.response.statusCode).toBe(400);
                expect(headerMismatch.response.json()).toMatchObject({ code: 'invalid_envelope' });
                const missingSignedKey = prepareRun(automationIds[0], 'qa-manual-key');
                delete missingSignedKey.request.idempotencyKey;
                expect((await sendRun(missingSignedKey)).response.statusCode).toBe(400);
                for (const id of [automationIds[1], undefined]) {
                    const denied = await invoke(id);
                    expect(denied.response.statusCode, denied.response.body).toBe(200);
                    expect(denied.execution).toMatchObject({ ok: false });
                }
                expect(await db.automationRun.count({ where: { automationId: { in: automationIds } } })).toBe(4);
                const listed = await app.inject({ method: 'GET', url: `/v3/automations/${automationIds[0]}/runs`,
                    headers: { authorization: `Bearer ${token}` } });
                expect(listed.statusCode, listed.body).toBe(200);
                expect(listed.json().runs).toHaveLength(4);
                if (runConsent === 'ask') {
                    const parkedIds = [runReceipt(originalExecution).run.id, runReceipt(keyedExecution).run.id];
                    expect(listed.json().runs).toEqual(expect.arrayContaining(parkedIds.map(id =>
                        expect.objectContaining({ id, state: 'running' }))));
                    expect(await db.automationRun.findMany({ where: { id: { in: parkedIds } }, select: { state: true } }))
                        .toEqual([{ state: 'waiting_for_review' }, { state: 'waiting_for_review' }]);
                }
                const signedRun = (id: string, authorization = admittedAuthorization, headerKey?: string) => {
                    const path = `/v3/automations/${id}/run-now`;
                    return app.inject({ method: 'POST', url: path, headers: createExternalActionAuthorizedRequestHeaders({
                        authorization, effectActionId: 'workflow.trigger.run_now', target: binding.target,
                        method: 'POST', path, installationId, privateKey: installation.secretKey,
                        ...(headerKey === undefined ? {} : { idempotencyKey: headerKey }) }) });
                };
                expect((await signedRun(automationIds[1]!)).statusCode).toBe(401);
                expect((await signedRun(automationIds[0]!, keyedAuthorization, 'qa-altered-header')).statusCode).toBe(401);
                expect((await signedRun(automationIds[0]!, keyedAuthorization)).statusCode).toBe(401);
                expect((await signedRun(automationIds[0]!)).statusCode).toBe(200);
                const rawTokenEffect = await app.inject({ method: 'POST', url: `/v3/automations/${automationIds[0]}/run-now`,
                    headers: { authorization: `Bearer ${pat.token}` } });
                expect(rawTokenEffect.statusCode).toBe(403);
                // Ordinary PATs retain Home-readable V1 transport even for E2EE Accounts.
                // Account credentials above still require V2, and direct PAT effects remain forbidden.
                const plainRequestId = randomUUID();
                const plainRunEffectsBefore = runEffects.length;
                const plainTokenRequest = await app.inject({ method: 'POST', url: '/v1/actions/workflow.trigger.run_now',
                    headers: { authorization: `Bearer ${pat.token}` }, payload: { v: 1, requestId: plainRequestId,
                        target: { kind: 'machine', machineId }, input: { automationId: automationIds[0] } } });
                expect(plainTokenRequest.statusCode, plainTokenRequest.body).toBe(200);
                const plainExecution = await approveRun({ response: plainTokenRequest, requestId: plainRequestId,
                    runEffectsBefore: plainRunEffectsBefore,
                    execution: ExternalActionResponseEnvelopeV1Schema.parse(plainTokenRequest.json()).execution });
                expect(plainExecution).toMatchObject({ ok: true, result: { run: { automationId: automationIds[0], state: 'queued' } } });
                expect(runReceipt(plainExecution).run.id).not.toBe(runReceipt(originalExecution).run.id);
                const appManualRun = () => app.inject({ method: 'POST', url: `/v3/automations/${automationIds[0]}/run-now`,
                    headers: { authorization: `Bearer ${token}`, 'idempotency-key': 'qa-app-key' } });
                const appOccurrence = await appManualRun();
                expect(appOccurrence.statusCode).toBe(200);
                expect((await appManualRun()).json()).toEqual(appOccurrence.json());
                await auth.revokeApiToken({ accountId: account.id, tokenId: pat.tokenId });
                expect((await signedRun(automationIds[0]!)).statusCode).toBe(401);
                expect((await invoke(automationIds[0])).response.statusCode).toBe(401);
                expect(await db.automationRun.count({ where: { automationId: { in: automationIds } } })).toBe(6);
            }
            await db.account.update({ where: { id: account.id }, data: { tokenEpoch: { increment: 1 } } });
            if (runConsent === 'waived') {
                const path = '/v1/account/encryption/currentness';
                const staleCurrentness = await app.inject({ method: 'GET', url: path, headers: createExternalActionAuthorizedRequestHeaders({
                    authorization: lastAuthorization!, effectActionId: 'session.message.send',
                    target: { kind: 'session', sessionId: session.id }, method: 'GET', path,
                    installationId, privateKey: installation.secretKey,
                }) });
                expect(staleCurrentness.statusCode).toBe(401);
                expect((await relay()).statusCode).toBe(401);
                expect(await db.sessionPendingMessage.count({ where: { sessionId: session.id } })).toBe(1);
            }
        } finally { daemon.disconnect(); publisher.disconnect(); await io.close(); await app.close(); }
    });
});
