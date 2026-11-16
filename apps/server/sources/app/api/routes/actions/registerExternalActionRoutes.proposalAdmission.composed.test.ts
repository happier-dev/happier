import fastify, { type FastifyRequest } from 'fastify';
import { randomUUID } from 'node:crypto';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import tweetnacl from 'tweetnacl';
import * as privacyKit from 'privacy-kit';
import * as protocol from '@happier-dev/protocol';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { DeploymentPrepareInputV1Schema, encodeBase64, computeDeploymentTransitionRequestDigestV1, DEPLOYMENT_ENVIRONMENT_ARTIFACT_STORED_KIND_V1,
    DEPLOYMENT_ENVIRONMENT_ARTIFACT_KIND_V1, DEPLOYMENT_TARGET_LINK_ARTIFACT_KIND_V1, ArtifactJsonCreateHttpInputV1Schema,
    DEPLOYMENT_RECEIPT_ARTIFACT_STORED_KIND_V1, DeploymentEnvironmentDeployerPrincipalsV1Schema, type JsonValue } from '@happier-dev/protocol';
import { deriveArtifactStoredKindV1 } from '@happier-dev/protocol/artifacts/artifactKindV1';
import { ArtifactRecipientKeyEnvelopeCommitInputV1Schema } from '@happier-dev/protocol/artifacts/artifactAccessV1';
import { SESSION_DATA_KEY_ENVELOPE_BYTES_V1 } from '@happier-dev/protocol/sessions/encryption/sessionDataKeyEnvelopes';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, encodePlainArtifactStoredContent } from '@happier-dev/protocol/storage/artifactStoredContent';
import { computeEnvironmentSecretLaunchAdmissionDigestV1 } from '@happier-dev/deployment-protocol';
import { encodePlainMachineStoredContent, MACHINE_PLAIN_DATA_KEY_MARKER } from '@happier-dev/protocol/machines/machineStoredContent';
import {
    bindExternalActionExecutionAuthorizationHttpPathV1,
    bindExternalActionExecutionAuthorizationVerifyHttpPathV1,
    encodeExternalActionResolvedTargetV1,
    signExternalActionMachineRequestV1,
    signExternalActionMachineRpcRequestV1,
    computeExternalActionRequestEnvelopeDigestV1,
    ExternalActionExecutionAuthorizationV1Schema,
    externalActionExecutionAuthorizationRequestSchemaForActionV1,
    EXTERNAL_ACTION_HTTP_PATH_PREFIX_V1,
    EXTERNAL_ACTION_EFFECT_ACTION_HEADER,
    EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER,
    EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER,
    EXTERNAL_ACTION_RESOLVED_TARGET_HEADER,
    type ExternalActionExecutionAuthorizationV1,
} from '@happier-dev/protocol/actions';
import { signMachineInstallationProof, verifyMachineInstallationProof } from '@happier-dev/protocol/machines/identity/installationIdentity';
import { signExternalActionApprovalInputV1, verifyExternalActionApprovalInputV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { createActionExecutor, type ActionExecutorContext, type ActionExecutorDeps } from '@happier-dev/protocol/actions/actionExecutor';
import { ApprovalRequestV2Schema, type ApprovalRequest } from '@happier-dev/protocol/approvals/approvalRequestV1';
import { decideApprovalRequestTransition } from '@happier-dev/protocol/approvals/approvalRequestTransition';
import { auth } from '@/app/auth/auth';
import { verifyCurrentExternalActionPrincipal, verifyExternalActionExecutionAuthorizationCurrentness,
    verifyExternalActionDomainExecutionRequest } from '@/app/auth/externalActionExecutionAuthorization';
import { hasCurrentSessionActionRpcSourceBinding } from '@/app/api/socket/sessionScopedBinding';
import { createSessionPublisherPresence } from '@/app/presence/sessionPublisherPresence';
import { createAuthenticatedTestApp } from '../../testkit/sqliteFastify';
import { registerExternalActionRoutes } from './registerExternalActionRoutes';
import { enableAuthentication } from '../../utils/enableAuthentication';
import { bindHomeDomainActionHttpRequestV1, bindPublicProfilePreparedHttpRequestV1 } from '@happier-dev/protocol/actions/homeDomainActionFamily';
import { installedSessionExternalActionStorage as storage } from '../../testkit/installedSessionExternalActionStorage';
import { normalizeUsageQuery, usageQueryToAnalyticsRequest } from '@happier-dev/protocol/inputs/usageQuery';
import { resolveUsageComparisonQuery } from '@happier-dev/protocol/usage/resolveUsagePageAggregation';
import { projectNativeJsonValueForTransport } from '@happier-dev/protocol/json/strictJsonValue';
import { DEFAULT_PUBLIC_PROFILE_POLICY_V1 } from '@happier-dev/protocol/account/publicProfile';
import { DEFAULT_PUBLIC_PROFILE_APPEARANCE_V1, DEFAULT_PUBLIC_PROFILE_LAYOUT_V1 } from '@happier-dev/protocol/account/publicProfilePublication';
import type { Socket } from 'socket.io';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { RPC_ERROR_CODES } from '@happier-dev/protocol/rpcErrors';
import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';
import { rpcHandler } from '@/app/api/socket/rpcHandler';
import { createAuthenticatedFakeSocket, createSocketRoomDiscoveryHarness, getSocketHandler } from '../../testkit/socketHarness';
import { evaluateAccountStoredContentCompatibility } from '@/app/clientCompatibility/accountStoredContentCompatibility';
import { CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION } from '@happier-dev/protocol/clientCompatibility/accountStoredContentCompatibilityV1';
import { getActionSpec, projectSessionSpawnNewApiRequest, projectExternalActionMachineRuntimeDemandV1 } from '@happier-dev/protocol/actions/actionSpecs';
import { Server } from 'socket.io';
import { createExternalActionDaemonDispatcher } from '@/app/api/socket/externalActionDispatcher';
import { sealEncryptedDataKeyEnvelopeV1 } from '@happier-dev/protocol/crypto/encryptedDataKeyEnvelopeV1';
import { projectExternalActionDeploymentMetadataEnvironmentIdV1 } from '@happier-dev/protocol/actions/externalActionApi';
import { ExternalActionDaemonDispatchRequestSchema, createExternalActionDaemonDispatchResponse,
    prepareExternalActionResponseEnvelopeV1, prepareExternalActionResponseV2, sealExternalActionRequestV2,
    openExternalActionRequestV2, isExternalActionAuthorizationBoundToEnvelope } from '@happier-dev/protocol/actions';

// Database I/O is the only substitute: installation signatures, Machine and
// Session admission, credential policy, Home minting and currentness stay real.
vi.mock('@/storage/db', async importOriginal => ({
    ...await importOriginal<typeof import('@/storage/db')>(),
    db: (await import('../../testkit/installedSessionExternalActionStorage')).installedSessionExternalActionStorage.db,
}));

const installation = tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(29));
const shareableMachineMetadata = encodePlainMachineStoredContent({
    host: 'host', platform: 'linux', happyCliVersion: 'test',
    homeDir: '/home/test', happyHomeDir: '/home/test/.happier',
});

function proposal(actionId: string, actionInput?: JsonValue) {
    const origin = { v: 1 as const, caller: { kind: 'session' as const, sessionId: 'session', starterDepth: 0, turnDepth: 0 },
        sourceTurnId: 'turn', callerPermissionMode: null, requestId: `proposal-${actionId}` };
    const source = { machineId: 'machine', installationId: 'installation' };
    const input: JsonValue = actionInput ?? (actionId === 'teams.list' ? { v: 1, scope: 'member', archived: 'active' }
        : actionId === 'teams.invitations.create' ? { v: 1, teamId: 'team', role: 'member',
            historyAccess: 'from_membership', recipientEmail: null, requestKey: 'create-request' }
        : { v: 1, teamId: 'team', invitationId: 'invitation', recipientEmail: null, requestKey: 'reissue-request' });
    const envelope = { v: 1 as const, requestId: origin.requestId, target: { kind: 'machine' as const, machineId: 'machine' }, input };
    const installationProof = signMachineInstallationProof({ privateKey: installation.secretKey,
        payload: { version: 1, accountId: 'account', ...source, externalActionOrigin: {
            homeId: 'srv_proposal_admission', actionId, requestId: origin.requestId,
            requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope), origin } } });
    return { v: 1 as const, machineId: 'machine', envelope, sessionActionOrigin: origin, sessionActionSource: source, installationProof };
}

function createApp(kind: 'account' | 'terminal') {
    const app = createAuthenticatedTestApp();
    app.addHook('preHandler', async (request: FastifyRequest) => {
        request.authTokenLegacy = false;
        request.authTokenEpoch = 1;
    });
    app.decorate('resolveCurrentSessionMachine', async () => storage.state.bound ? 'machine' : null);
    const dispatch = vi.fn(async () => { throw new Error('Minting must not execute an Action'); });
    registerExternalActionRoutes(app, { dispatch });
    const mint = (actionId: string, body: unknown = proposal(actionId)) => app.inject({ method: 'POST',
        url: bindExternalActionExecutionAuthorizationHttpPathV1(actionId),
        headers: { 'x-test-user-id': 'account', 'x-test-auth-token-kind': kind }, payload: body });
    return { app, mint, dispatch };
}

function signedRequestProof(authorization: ExternalActionExecutionAuthorizationV1, path: string, body: unknown,
    effectActionId = authorization.binding.actionId, method = 'POST', routeInput?: unknown) {
    const request = { authorizationToken: authorization.token, effectActionId,
        target: authorization.binding.target, installationId: authorization.binding.installationId,
        requestId: authorization.binding.requestId, method, path, body };
    return { authorizationToken: request.authorizationToken, effectActionId: request.effectActionId,
        encodedTarget: encodeExternalActionResolvedTargetV1(request.target), method: request.method, path, body, routeInput,
        machineSignature: signExternalActionMachineRequestV1({ ...request, privateKey: installation.secretKey }),
        resolveCurrentSessionMachine: async () => storage.state.bound ? 'machine' : null };
}

function verifyProposalCurrentness(authorization: ExternalActionExecutionAuthorizationV1) {
    return verifyExternalActionExecutionAuthorizationCurrentness({
        ...signedRequestProof(authorization,
            bindExternalActionExecutionAuthorizationVerifyHttpPathV1(authorization.binding.actionId), {
                v: 1, ...(authorization.binding.admittedMachineRole === undefined ? {} : {
                    admittedMachineRole: authorization.binding.admittedMachineRole }),
            }),
        outerActionId: authorization.binding.actionId,
    });
}

describe('installed Session proposal admission at the Home mint route', () => {
    it('names the refusing envelope admission projection instead of a bare invalid_envelope (COR6R-163)', async () => {
        // Live: a build-log read whose envelope the read-admission projection refused reached the person as a
        // bare invalid_envelope. The refusal keeps its code-only cause; no input content is disclosed.
        const { app, mint } = createApp('account');
        try {
            const input = projectNativeJsonValueForTransport({ serverId: storage.state.homeId, deploymentId: 'deployment',
                kind: 'build', privateMarker: 'never-disclosed' });
            const minted = await mint('deployments.logs.read', proposal('deployments.logs.read', input));
            expect(minted.statusCode, minted.body).toBe(400);
            expect(minted.json()).toMatchObject({ error: 'invalid_request', code: 'invalid_envelope',
                failureCause: { phase: 'external_action.envelope_admission', errorClass: expect.any(String) } });
            expect(minted.body).not.toContain('never-disclosed');
        } finally { await app.close(); }
    });

    it('keeps encrypted Group intent within signed Team preparation and the sealed mutation grammar', async () => {
        const previousMode = storage.account.encryptionMode;
        storage.account.encryptionMode = 'e2ee';
        const material = { type: 'dataKey' as const, machineKey: new Uint8Array(32).fill(7) };
        Object.assign(storage.state, { metadata: 'encrypted-controller-metadata',
            dataEncryptionKey: sealEncryptedDataKeyEnvelopeV1({ dataKey: material.machineKey,
                recipientPublicKey: tweetnacl.box.keyPair().publicKey, randomBytes: tweetnacl.randomBytes }) });
        const actionId = 'teams.groups.update';
        const intent = { v: 1 as const, teamId: 'team', groupId: 'group', name: 'Private builders', description: 'Private purpose' };
        const requested = proposal(actionId, intent);
        const binding = { serverIdentityId: storage.state.homeId, accountId: 'account',
            authentication: { kind: 'account' as const, tokenEpoch: 1 }, actionId,
            requestId: requested.envelope.requestId, target: requested.envelope.target } satisfies Parameters<typeof sealExternalActionRequestV2>[0]['binding'];
        const envelope = sealExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1,
            binding, material, input: intent, randomBytes: tweetnacl.randomBytes });
        const installationProof = signMachineInstallationProof({ privateKey: installation.secretKey,
            payload: { version: 1, accountId: 'account', ...requested.sessionActionSource, externalActionOrigin: {
                homeId: storage.state.homeId, actionId, requestId: binding.requestId,
                requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope), origin: requested.sessionActionOrigin } } });
        const { app, mint } = createApp('account');
        try {
            expect(JSON.stringify(envelope)).not.toContain(intent.name);
            expect(JSON.stringify(envelope)).not.toContain(intent.description);
            const minted = await mint(actionId, { ...requested, envelope, installationProof });
            expect(minted.statusCode, minted.body).toBe(200);
            const authorization = ExternalActionExecutionAuthorizationV1Schema.parse(minted.json());
            const censusBody = { owner: { kind: 'team', teamId: intent.teamId } };
            const censusProof = (body: unknown) => signedRequestProof(authorization, PRIVATE_LABEL_RECIPIENT_CENSUS_PATH, body);
            expect(await verifyExternalActionDomainExecutionRequest(censusProof(censusBody))).not.toBeNull();
            expect(await verifyExternalActionDomainExecutionRequest(censusProof({ owner: { kind: 'account', accountId: 'other' } }))).toBeNull();
            expect(await verifyExternalActionDomainExecutionRequest(signedRequestProof(authorization,
                '/v1/account/encryption/currentness', undefined, actionId, 'GET'))).not.toBeNull();
            const publicKey = tweetnacl.box.keyPair().publicKey;
            let censuses = 0;
            vi.stubGlobal('fetch', async (_url: unknown, init?: RequestInit) => {
                censuses++;
                expect(JSON.parse(String(init?.body))).toEqual(censusBody);
                return Response.json({ contentEncryptionMode: 'e2ee', recipients: [{
                account: { kind: 'account', accountId: 'account', firstName: null, lastName: null, username: null, avatarUrl: null },
                readiness: { status: 'available', contentPublicKey: encodeBase64(publicKey),
                    contentPublicKeyFingerprint: computeContentPublicKeyFingerprint(publicKey) }, envelopeStatus: 'missing',
                }] });
            });
            // The network census is substituted; semantic preparation and the CLI cipher owner stay real.
            const wire = await prepareTeamGroupUpdateActionInput(intent, async request => await prepareCliPrivateLabels({
                endpoint: 'http://home.test', token: 'captured-account-token', accountMode: 'e2ee',
                recipientCensusPath: PRIVATE_LABEL_RECIPIENT_CENSUS_PATH, owner: request.owner, labels: request.labels,
            }), { surface: 'agent' });
            const request = bindHomeDomainActionHttpRequestV1(actionId, wire);
            expect(censuses, 'one Team audience read for the name and description patch').toBe(1);
            expect(JSON.stringify(request.body)).not.toContain(intent.name);
            expect(JSON.stringify(request.body)).not.toContain(intent.description);
            expect(await verifyExternalActionDomainExecutionRequest(signedRequestProof(authorization,
                request.path, request.body, actionId, request.method))).not.toBeNull();
            expect(await verifyExternalActionDomainExecutionRequest(signedRequestProof(authorization,
                request.path, intent, actionId, request.method))).toBeNull();
            expect(await verifyExternalActionDomainExecutionRequest(signedRequestProof(authorization,
                request.path, wire, 'teams.groups.create', request.method))).toBeNull();
        } finally {
            vi.unstubAllGlobals();
            storage.account.encryptionMode = previousMode;
            await app.close();
        }
    });
    it('carries a code-only daemon refusal through real admission and the protected HTTP route', async () => {
        const previousMode = storage.account.encryptionMode;
        storage.account.encryptionMode = 'e2ee';
        Object.assign(storage.state, { metadata: 'encrypted-controller-metadata',
            dataEncryptionKey: sealEncryptedDataKeyEnvelopeV1({ dataKey: new Uint8Array(32).fill(7),
                recipientPublicKey: tweetnacl.box.keyPair().publicKey, randomBytes: tweetnacl.randomBytes }) });
        storage.state.operationProtocolCapabilities = { externalActionExecutionAuthorization: { protocolVersions: [1] } };
        storage.state.operationProtocolCapabilitiesRevision = 1;
        const app = createAuthenticatedTestApp({ authentication: 'real' });
        const io = new Server();
        // Only database I/O (the shared fixture above) and the daemon network are replaced.
        const forwardRpc = vi.fn(async () => ({ ok: true as const,
            result: { errorCode: 'RPC_FORBIDDEN', error: 'private-error-marker' } }));
        registerExternalActionRoutes(app, { dispatch: createExternalActionDaemonDispatcher({ io, forwardRpc }) });
        try {
            const token = await auth.createToken('account', undefined, { kind: 'account', authority: 'present_user' });
            const response = await app.inject({ method: 'POST', url: '/v1/actions/action.spec.get',
                headers: { authorization: `Bearer ${token}` },
                payload: { v: 2, requestId: 'protected-refused', target: { kind: 'machine', machineId: 'machine' },
                    payload: { t: 'encrypted', c: 'opaque' } } });
            expect(response.statusCode, response.body).toBe(403);
            expect(response.json()).toEqual({ error: 'credential_scope_denied', requestId: 'protected-refused',
                diagnostic: { admissionStage: 'daemon_rpc', errorCode: 'RPC_FORBIDDEN' } });
            expect(response.body).not.toContain('private-error-marker');
            expect(response.headers['cache-control']).toBe('no-store');
        } finally {
            storage.account.encryptionMode = previousMode;
            await app.close();
        }
    });

    it.each([
        { actionId: 'machines.services.list', extra: {}, allowed: true },
        { actionId: 'machines.services.detail', extra: { serviceId: 'staging/web' }, allowed: true },
        { actionId: 'machines.services.control', extra: { serviceId: 'staging/web', expectedGeneration: 'generation', operation: 'restart' }, allowed: true },
        { actionId: 'machines.services.exec', extra: { target: { kind: 'current', serviceId: 'staging/web', expectedGeneration: 'generation' },
            mode: 'exec', argv: ['true'] }, allowed: true },
        { actionId: 'machines.reboot', extra: { expectedInstallationId: 'installation' }, allowed: true },
        { actionId: 'machines.processes.list', extra: {}, allowed: true },
        { actionId: 'machines.processes.get', extra: { ref: 'container:current' }, allowed: true },
        { actionId: 'machines.processes.check', extra: { refs: ['container:current'] }, allowed: true },
        { actionId: 'machines.services.discovery', extra: {}, allowed: false },
    ])('keeps Environment access preparation within the original $actionId root', async ({ actionId, extra, allowed }) => {
        const serverId = storage.state.homeId;
        const { app, mint } = createApp('account');
        try {
            const requested = proposal(actionId, projectNativeJsonValueForTransport({ serverId, machineId: 'machine', ...extra }));
            const minted = await mint(actionId, requested);
            expect(minted.statusCode, minted.body).toBe(200);
            const authorization = ExternalActionExecutionAuthorizationV1Schema.parse(minted.json());
            const path = '/v1/deployments/environments/access';
            const body = { serverId, environmentIds: ['staging', 'another'] };
            const verify = (payload: unknown = body, effect = actionId, method = 'POST', requestPath = path, routeInput: unknown = payload) =>
                verifyExternalActionDomainExecutionRequest(signedRequestProof(authorization, requestPath, payload, effect, method, routeInput));
            expect(Boolean(await verify())).toBe(allowed);
            for (const invalid of [{ ...body, serverId: 'foreign' }, { ...body, extraAuthority: true }]) {
                expect(await verify(invalid)).toBeNull();
            }
            expect(await verify(body, 'deployments.environments.get')).toBeNull();
            expect(await verify(body, actionId, 'GET')).toBeNull();
            expect(await verify(body, actionId, 'POST', `${path}?extra=true`)).toBeNull();
            expect(await verify(body, actionId, 'POST', path, { ...body, environmentIds: ['substituted'] })).toBeNull();
            expect(await verify(body, actionId, 'PATCH', '/v1/deployments/environments/staging')).toBeNull();
            storage.state.revokedAt = new Date();
            expect(await verify(), 'retired Machine authority cannot prepare Environment access').toBeNull();
            storage.state.revokedAt = null;
            expect(Boolean(await verify()), 'restored Machine authority retains the original root').toBe(allowed);
        } finally { await app.close(); }
    });

    it.each([RPC_METHODS.BASH, 'ripgrep', RPC_METHODS.SESSION_LOG_TAIL])('admits the physical Machine custodian and refuses Use-only protected Session receivers (%s)', async rpcMethod => {
        storage.state.metadata = shareableMachineMetadata;
        const compatibility = evaluateAccountStoredContentCompatibility({ status: 'missing' });
        const emitWithAck = vi.fn(async (_event: string, request: Readonly<{ machineAdmission?: unknown; callerAuthority?: string }>) => ({
            admission: request.machineAdmission, authority: request.callerAuthority,
        }));
        const target = { id: 'retained-session', data: { clientType: 'session-scoped', userId: 'account', sessionId: 'session',
            sessionScopedBinding: { sessionId: 'session', machineId: 'machine', proof: 'machine-access-key' },
            accountStoredContentCompatibility: compatibility }, timeout: () => ({ emitWithAck }) };
        const io = createSocketRoomDiscoveryHarness(async room => room === target.id
            || room === `rpc:${target.data.userId}:${target.data.sessionId}:${rpcMethod}` ? [target] : []);
        const call = async (authAuthority: 'present_user' | 'account_automation', sessionOrigin = false, accountId = 'account') => {
            const kind = authAuthority === 'present_user' ? 'account' : 'terminal';
            const socket = Object.assign(createAuthenticatedFakeSocket({ data: { clientType: sessionOrigin ? 'session-scoped' : 'user-scoped',
                authAuthority, authTokenKind: kind, accountStoredContentCompatibility: compatibility,
                ...(sessionOrigin ? { sessionId: target.data.sessionId, sessionScopedBinding: target.data.sessionScopedBinding } : {}) } }),
            { handshake: { auth: { token: await auth.createToken(accountId, undefined, { kind, authority: authAuthority }) } } });
            rpcHandler(accountId, socket as unknown as Socket, { io });
            const reply = vi.fn();
            await getSocketHandler(socket, SOCKET_RPC_EVENTS.CALL)({ method: `${target.data.sessionId}:${rpcMethod}`, params: {} }, reply);
            return reply;
        };
        const receipt = { actorAccountId: 'account', custodianAccountId: 'account', machineId: 'machine',
            installationId: 'installation', role: 'manage', encryptionMode: 'plain' };
        for (const authority of ['present_user', 'account_automation'] as const) {
            expect(await call(authority)).toHaveBeenCalledWith({ ok: true, result: { admission: receipt, authority } });
        }
        expect(emitWithAck).toHaveBeenCalledTimes(2);
        expect(await call('present_user', true)).toHaveBeenCalledWith(expect.objectContaining({
            ok: false, errorCode: RPC_ERROR_CODES.FORBIDDEN,
        }));
        expect(emitWithAck).toHaveBeenCalledTimes(2);
        storage.state.accountGrants.push({ accountId: 'other-account', accessLevel: 'view', account: {
            id: 'other-account', status: 'active', name: null, firstName: null, lastName: null, username: null, avatar: null,
        } });
        storage.state.sessionIds.add('member-session');
        storage.state.sessionOwners.set('member-session', 'other-account');
        storage.state.sessionAccessKeyIds.add('member-session');
        storage.state.operationProtocolCapabilities = { requesterExecutionIsolation: { protocolVersions: [1] } };
        storage.state.operationProtocolCapabilitiesRevision = 1;
        target.data.userId = 'other-account';
        target.data.sessionId = 'member-session';
        target.data.sessionScopedBinding.sessionId = 'member-session';
        expect(await call('present_user', false, 'other-account')).toHaveBeenCalledWith(expect.objectContaining({
            ok: false, errorCode: rpcMethod === RPC_METHODS.SESSION_LOG_TAIL ? 'agent_isolation_unavailable' : RPC_ERROR_CODES.FORBIDDEN,
        }));
        expect(emitWithAck).toHaveBeenCalledTimes(2);
        target.data.userId = 'account';
        target.data.sessionId = 'session';
        target.data.sessionScopedBinding.sessionId = 'session';
        storage.state.bound = false;
        expect(await call('present_user')).toHaveBeenCalledWith(expect.objectContaining({
            ok: false, errorCode: RPC_ERROR_CODES.FORBIDDEN,
        }));
        expect(emitWithAck).toHaveBeenCalledTimes(2);
    });

    it.each([
        ['SCM', RPC_METHODS.SCM_DIFF_SUMMARY_RESULT_LIST, false],
        ['filesystem', RPC_METHODS.DAEMON_FILESYSTEM_READ_FILE, false],
        ['transfer', RPC_METHODS.DAEMON_TRANSFER_DOWNLOAD_INIT, false],
        ['MCP', RPC_METHODS.DAEMON_MCP_SERVERS_TEST, false],
        ['terminal', RPC_METHODS.DAEMON_TERMINAL_ENSURE, false],
        ['Session', RPC_METHODS.SESSION_SPAWN_NEW, false],
        ['raw execution', RPC_METHODS.BASH, false],
        ['LSP', RPC_METHODS.DAEMON_LSP_QUERY, false],
        ['capability invocation', RPC_METHODS.CAPABILITIES_INVOKE, true],
        ['capability detection', RPC_METHODS.CAPABILITIES_DETECT, true],
        ['diagnostic Session log', RPC_METHODS.DAEMON_SESSION_LOG_TAIL, true],
        ['diagnostic collector', RPC_METHODS.BUGREPORT_COLLECT_DIAGNOSTICS, true],
        // cli-v0.2.17 rpc.ts:182; the retained Session literal is exercised above
        // through today's exact Session route, not a fabricated Machine fallback.
        ['diagnostic bug-report log', RPC_METHODS.BUGREPORT_GET_LOG_TAIL, true],
    ] as const)('preserves owner %s Home routing while retaining non-owner enforcement', async (_family, method, reviewWithdrawal) => {
        storage.state.metadata = shareableMachineMetadata;
        storage.state.accountGrants.push({ accountId: 'other-account', accessLevel: 'admin', account: {
            id: 'other-account', status: 'active', name: null, firstName: null, lastName: null, username: null, avatar: null,
        } });
        const compatibility = evaluateAccountStoredContentCompatibility({ status: 'valid',
            declaration: CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION });
        const emitWithAck = vi.fn(async (_event: string, request: Readonly<{ callerAuthority?: string }>) => ({
            admissionAuthority: request.callerAuthority ?? 'present_user',
        }));
        const target = { id: 'owner-compat-daemon', connected: true, data: { clientType: 'machine-scoped', machineId: 'machine',
            verifiedMachineInstallationId: 'installation', accountStoredContentCompatibility: compatibility }, timeout: () => ({ emitWithAck }) };
        let withdrawBeforeDispatch = false;
        const io = createSocketRoomDiscoveryHarness(async room => {
            if (withdrawBeforeDispatch && room === target.id) {
                withdrawBeforeDispatch = false;
                storage.state.operationProtocolCapabilities = {};
                storage.state.operationProtocolCapabilitiesRevision += 1;
            }
            return room === target.id || room === `rpc:account:machine:${method}` ? [target] : [];
        });
        const call = async (accountId: string, authAuthority: 'present_user' | 'account_automation') => {
            const kind = authAuthority === 'present_user' ? 'account' : 'terminal';
            const socket = Object.assign(createAuthenticatedFakeSocket({ data: { clientType: 'user-scoped',
                accountStoredContentCompatibility: compatibility, authAuthority, authTokenKind: kind } }),
            { handshake: { auth: { token: await auth.createToken(accountId, undefined, { kind, authority: authAuthority }) } } });
            rpcHandler(accountId, socket as unknown as Socket, { io });
            const reply = vi.fn();
            await getSocketHandler(socket, SOCKET_RPC_EVENTS.CALL)({ method: `machine:${method}`, params: {} }, reply);
            return reply;
        };
        expect(await call('other-account', 'account_automation')).toHaveBeenCalledWith(expect.objectContaining({
            ok: false, errorCode: RPC_ERROR_CODES.FORBIDDEN,
        }));
        expect(emitWithAck).not.toHaveBeenCalled();
        if (reviewWithdrawal) {
            expect(await call('other-account', 'present_user')).toHaveBeenCalledWith(expect.objectContaining({
                ok: false, errorCode: RPC_ERROR_CODES.FORBIDDEN,
            }));
            expect(emitWithAck).not.toHaveBeenCalled();
            storage.state.accountGrants[0].accessLevel = 'view';
            expect(await call('other-account', 'present_user')).toHaveBeenCalledWith(expect.objectContaining({
                ok: false, errorCode: RPC_ERROR_CODES.FORBIDDEN,
            }));
            expect(emitWithAck).not.toHaveBeenCalled();
            storage.state.operationProtocolCapabilities = { requesterExecutionIsolation: { protocolVersions: [1] } };
            storage.state.operationProtocolCapabilitiesRevision = 1;
            expect(await call('other-account', 'present_user')).toHaveBeenCalledWith({ ok: true,
                result: { admissionAuthority: 'present_user' } });
            expect(emitWithAck).toHaveBeenCalledTimes(1);
            emitWithAck.mockClear();
            withdrawBeforeDispatch = true;
            // This dispatch was already admitted; withdrawal governs the next request.
            expect(await call('other-account', 'present_user')).toHaveBeenCalledWith({ ok: true,
                result: { admissionAuthority: 'present_user' } });
            expect(withdrawBeforeDispatch).toBe(false);
            expect(emitWithAck).toHaveBeenCalledTimes(1);
            emitWithAck.mockClear();
            expect(await call('other-account', 'present_user')).toHaveBeenCalledWith(expect.objectContaining({
                ok: false, errorCode: RPC_ERROR_CODES.FORBIDDEN,
            }));
            expect(emitWithAck).not.toHaveBeenCalled();
        }
        expect(await call('account', 'account_automation')).toHaveBeenCalledWith({ ok: true,
            result: { admissionAuthority: 'account_automation' } });
        expect(await call('account', 'present_user')).toHaveBeenCalledWith({ ok: true,
            result: { admissionAuthority: 'present_user' } });
        expect(emitWithAck).toHaveBeenCalledTimes(2);
    });

    it('refuses a genuine owner Session file deputy after its Machine loses requester enforcement', async () => {
        storage.state.operationProtocolCapabilities = { requesterExecutionIsolation: { protocolVersions: [1] } };
        storage.state.operationProtocolCapabilitiesRevision = 1;
        const actionId = 'daemon.filesystem.readFile';
        const input = { rootPath: '/fixture', path: 'private-source.txt' };
        const { app, mint } = createApp('account');
        const readSession = storage.db.session.findUnique;
        // Database-bound publisher facts; the real publisher/currentness owners
        // still decide whether this exact Session is a usable source.
        const publishedSession = vi.spyOn(storage.db.session, 'findUnique').mockImplementation(async args => {
            const row = await readSession(args);
            return row ? { ...row, active: true, archivedAt: null, lastActiveAt: new Date(2),
                publisherGeneration: 1n, publisherGenerationLastActiveAt: new Date(2) } : null;
        });
        let oldReceiverEffect = false;
        try {
            const minted = await mint(actionId, proposal(actionId, input));
            expect(minted.statusCode).toBe(200);
            const authorization = ExternalActionExecutionAuthorizationV1Schema.parse(minted.json());
            expect(authorization.binding.sessionActionOrigin?.caller.sessionId).toBe('session');
            // A retained root does not make a replacement/predecessor receiver
            // enforce Agent custody merely because its Account is the custodian.
            const compatibility = evaluateAccountStoredContentCompatibility({ status: 'valid',
                declaration: CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION });
            const emitWithAck = vi.fn(async () => {
                oldReceiverEffect = true;
                return { protectedEffect: true };
            });
            // Exact inspected predecessor rpc.ts/registerReadFileHandler wire.
            const method = `machine:${RPC_METHODS.READ_FILE}`;
            const params = { path: '/fixture/private-source.txt' };
            const target = { id: 'old-machine-file-receiver', connected: true,
                data: { clientType: 'machine-scoped', machineId: 'machine',
                    verifiedMachineInstallationId: 'installation', accountStoredContentCompatibility: compatibility },
                timeout: () => ({ emitWithAck }) };
            const publisher = { data: { sessionPublisherAuthority: { v: 1, accountId: 'account', sessionId: 'session',
                machineId: 'machine', committedFenceMs: 2, publisherGeneration: '1' } } };
            const io = createSocketRoomDiscoveryHarness(async room => room === 'session:session:account' ? [publisher]
                : room === target.id || room === `rpc:account:${method}` ? [target] : []);
            const socket = Object.assign(createAuthenticatedFakeSocket({ data: { clientType: 'machine-scoped', machineId: 'machine',
                verifiedMachineInstallationId: 'installation', authAuthority: 'account_automation', authTokenKind: 'account',
                authTokenEpoch: 1, accountStoredContentCompatibility: compatibility } }),
            { handshake: { auth: { token: await auth.createToken('account', undefined, { kind: 'account', authority: 'present_user' }) } } });
            rpcHandler('account', socket as unknown as Socket, { io, sessionPublisherPresence: createSessionPublisherPresence() });
            const requestId = 'owner-session-file-deputy';
            const execution = { v: 1 as const, authorization, effectActionId: actionId,
                target: authorization.binding.target, installationId: 'installation',
                machineSignature: signExternalActionMachineRpcRequestV1({ authorizationToken: authorization.token,
                    effectActionId: actionId, target: authorization.binding.target, installationId: 'installation',
                    method, requestId, params, privateKey: installation.secretKey }) };
            const admittedReply = vi.fn();
            await getSocketHandler(socket, SOCKET_RPC_EVENTS.CALL)({ method, requestId, params,
                externalActionExecution: execution }, admittedReply);
            expect(admittedReply).toHaveBeenCalledWith({ ok: true, result: { protectedEffect: true } });
            expect(oldReceiverEffect).toBe(true);
            oldReceiverEffect = false;
            emitWithAck.mockClear();
            storage.state.operationProtocolCapabilities = {};
            storage.state.operationProtocolCapabilitiesRevision = 2;
            const reply = vi.fn();
            await getSocketHandler(socket, SOCKET_RPC_EVENTS.CALL)({ method, requestId, params,
                externalActionExecution: execution }, reply);
            expect(oldReceiverEffect).toBe(false);
            expect(emitWithAck).not.toHaveBeenCalled();
            expect(reply).toHaveBeenCalledWith(expect.objectContaining({ ok: false, errorCode: RPC_ERROR_CODES.FORBIDDEN }));
        } finally { publishedSession.mockRestore(); await app.close(); }
    });

    it('preserves a genuine owner Session typed spawn mint and actual RPC without the non-owner leaf', async () => {
        const actionId = 'session.spawn_new';
        const rpcInput = getActionSpec(actionId).surfaceBindings?.rpc?.inputSchema;
        if (!rpcInput) throw new Error('Missing canonical Session spawn RPC schema');
        const params = rpcInput.parse({ executionTarget: { serverId: storage.state.homeId, machineId: 'machine' },
            creationKey: 'owner-session-typed-spawn',
            directory: { kind: 'path', path: '/fixture' },
            agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.test', localId: 'test' } } });
        const projected = projectSessionSpawnNewApiRequest(params);
        const { app, mint } = createApp('account');
        const readSession = storage.db.session.findUnique;
        const publishedSession = vi.spyOn(storage.db.session, 'findUnique').mockImplementation(async args => {
            const row = await readSession(args);
            return row ? { ...row, active: true, archivedAt: null, lastActiveAt: new Date(2),
                publisherGeneration: 1n, publisherGenerationLastActiveAt: new Date(2) } : null;
        });
        try {
            const minted = await mint(actionId, proposal(actionId, projectNativeJsonValueForTransport(projected.input)));
            expect(minted.statusCode, minted.body).toBe(200);
            const authorization = ExternalActionExecutionAuthorizationV1Schema.parse(minted.json());
            expect(authorization.binding.sessionActionOrigin?.caller.sessionId).toBe('session');
            const compatibility = evaluateAccountStoredContentCompatibility({ status: 'valid',
                declaration: CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION });
            const emitWithAck = vi.fn(async () => ({ nativeTypedRequestAccepted: true }));
            const method = `machine:${RPC_METHODS.SESSION_SPAWN_NEW}`;
            const target = { id: 'typed-session-spawn-receiver', connected: true,
                data: { clientType: 'machine-scoped', machineId: 'machine', verifiedMachineInstallationId: 'installation',
                    accountStoredContentCompatibility: compatibility }, timeout: () => ({ emitWithAck }) };
            const publisher = { data: { sessionPublisherAuthority: { v: 1, accountId: 'account', sessionId: 'session',
                machineId: 'machine', committedFenceMs: 2, publisherGeneration: '1' } } };
            const io = createSocketRoomDiscoveryHarness(async room => room === 'session:session:account' ? [publisher]
                : room === target.id || room === `rpc:account:${method}` ? [target] : []);
            const socket = Object.assign(createAuthenticatedFakeSocket({ data: { clientType: 'machine-scoped', machineId: 'machine',
                verifiedMachineInstallationId: 'installation', authAuthority: 'account_automation', authTokenKind: 'account',
                authTokenEpoch: 1, accountStoredContentCompatibility: compatibility } }),
            { handshake: { auth: { token: await auth.createToken('account', undefined, { kind: 'account', authority: 'present_user' }) } } });
            rpcHandler('account', socket as unknown as Socket, { io, sessionPublisherPresence: createSessionPublisherPresence() });
            const requestId = 'owner-session-typed-spawn';
            const execution = { v: 1 as const, authorization, effectActionId: actionId, target: authorization.binding.target,
                installationId: 'installation', machineSignature: signExternalActionMachineRpcRequestV1({ authorizationToken: authorization.token,
                    effectActionId: actionId, target: authorization.binding.target, installationId: 'installation',
                    method, requestId, params, privateKey: installation.secretKey }) };
            const reply = vi.fn();
            await getSocketHandler(socket, SOCKET_RPC_EVENTS.CALL)({ method, requestId, params, externalActionExecution: execution }, reply);
            expect(reply).toHaveBeenCalledWith({ ok: true, result: { nativeTypedRequestAccepted: true } });
            expect(emitWithAck).toHaveBeenCalledTimes(1);
        } finally { publishedSession.mockRestore(); await app.close(); }
    });

    it('reports only a bounded Machine refusal witness from the actual Home mint route', async () => {
        const { app } = createApp('terminal');
        const witness = vi.spyOn(app.log, 'warn');
        try {
            const response = await app.inject({ method: 'POST',
                url: bindExternalActionExecutionAuthorizationHttpPathV1('scm.diffSummary.result.list'),
                headers: { 'x-test-user-id': 'other-account', 'x-test-auth-token-kind': 'terminal' },
                payload: { v: 1, machineId: 'machine', envelope: { v: 1, requestId: 'refused-scm',
                    target: { kind: 'machine', machineId: 'machine' }, input: { cwd: '/repo' } } } });
            expect(response.statusCode).toBe(409);
            expect(witness).toHaveBeenCalledWith({ event: 'external_action_machine_admission_refused',
                actionId: 'scm.diffSummary.result.list', reasonCode: 'access_denied' });
        } finally { witness.mockRestore(); await app.close(); }
    });

    it('keeps owned SCM minting available without a member-enforcement advertisement', async () => {
        const { app, mint, dispatch } = createApp('terminal');
        try {
            for (const actionId of ['scm.diffSummary.result.list', 'scm.diffSummary.generate'] as const) {
                const input = actionId === 'scm.diffSummary.result.list' ? { cwd: '/repo' }
                    : { cwd: '/repo', source: { kind: 'workingTree' }, outputs: ['summary'] };
                const response = await mint(actionId, { v: 1, machineId: 'machine', envelope: { v: 1,
                    requestId: `owner-${actionId}`, target: { kind: 'machine', machineId: 'machine' }, input } });
                expect(response.statusCode, response.body).toBe(200);
                const authorization = ExternalActionExecutionAuthorizationV1Schema.parse(response.json());
                expect(await verifyCurrentExternalActionPrincipal(authorization.binding)).toMatchObject({
                    accountId: 'account', authority: 'account_automation',
                });
            }
            expect(dispatch).not.toHaveBeenCalled();
        } finally { await app.close(); }
    });

    it('prepares the own Account profile for a signed Session connected-service inventory root', async () => {
        const actionId = 'sessions.spawn.connected_services.list';
        const input = projectNativeJsonValueForTransport(getActionSpec(actionId).inputSchema.parse({ agentId: 'codex' }));
        const { app, mint, dispatch } = createApp('account');
        const domain = fastify().withTypeProvider<ZodTypeProvider>();
        domain.decorate('resolveCurrentSessionMachine', async () => storage.state.bound ? 'machine' : null);
        enableAuthentication(domain);
        // Stop at the authenticated HTTP handler boundary: profile projection and
        // linked-provider storage are downstream of the purpose under test.
        domain.get('/v1/account/profile', { preHandler: domain.authenticate }, async request => ({ accountId: request.userId }));
        const readSession = storage.db.session.findUnique;
        // Real publisher/currentness owners consume these database-bound facts.
        const publishedSession = vi.spyOn(storage.db.session, 'findUnique').mockImplementation(async args => {
            const row = await readSession(args);
            return row ? { ...row, active: true, archivedAt: null, lastActiveAt: new Date(2),
                publisherGeneration: 1n, publisherGenerationLastActiveAt: new Date(2) } : null;
        });
        try {
            const minted = await mint(actionId, proposal(actionId, input));
            expect(minted.statusCode, minted.body).toBe(200);
            const authorization = ExternalActionExecutionAuthorizationV1Schema.parse(minted.json());
            expect(authorization.binding.sessionActionOrigin?.caller.sessionId).toBe('session');
            const profile = getActionSpec('account.profile.get');
            if (!profile.serverTransport) throw new Error('Expected canonical profile HTTP transport');
            const { bindHomeDomainHttpRequestV1 } = await import('@happier-dev/protocol/actions/homeDomainHttpBinding');
            const request = bindHomeDomainHttpRequestV1({ transport: profile.serverTransport,
                inputSchema: profile.inputSchema, input: {} });
            const read = (effectActionId = actionId, privateKey = installation.secretKey, path = request.path) => {
                const signature = signExternalActionMachineRequestV1({ authorizationToken: authorization.token,
                    effectActionId, target: authorization.binding.target, installationId: authorization.binding.installationId,
                    requestId: authorization.binding.requestId, method: request.method, path, privateKey });
                return domain.inject({ method: 'GET', url: path, headers: {
                    [EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]: authorization.token,
                    [EXTERNAL_ACTION_EFFECT_ACTION_HEADER]: effectActionId,
                    [EXTERNAL_ACTION_RESOLVED_TARGET_HEADER]: encodeExternalActionResolvedTargetV1(authorization.binding.target),
                    [EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER]: signature,
                } });
            };
            expect((await read('account.profile.get')).statusCode).toBe(401);
            expect((await read(actionId, tweetnacl.sign.keyPair().secretKey)).statusCode).toBe(401);
            expect((await read(actionId, installation.secretKey, `${request.path}?accountId=other-account`)).statusCode).toBe(401);
            storage.state.sessionOwners.set('session', 'other-account');
            expect((await read()).statusCode).toBe(401);
            storage.state.sessionOwners.delete('session');
            const accepted = await read();
            expect(accepted.statusCode, accepted.body).toBe(200);
            expect(accepted.json()).toEqual({ accountId: 'account' });
            expect(dispatch).not.toHaveBeenCalled();
        } finally {
            storage.state.sessionOwners.delete('session');
            publishedSession.mockRestore();
            await domain.close();
            await app.close();
        }
    });

    it('admits captured setup app reads and the installed connector grant lifecycle through the signed original root', async () => {
        const rows = storage.state.deploymentRead;
        rows.enabled = true;
        rows.sourceReadable = true;
        Object.assign(rows.link, { revision: 1 });
        const actionId = 'machines.setup.apply';
        const serverId = storage.state.homeId;
        const source = { kind: 'direct', setup: { items: [{ kind: 'app', definition: {
            name: 'Setup app', project: { kind: 'existing', projectSourceId: 'source' }, bindings: [],
            definition: { from: 'compose', document: 'services: {}', profiles: [], services: [] },
        } }] } };
        const input = { homeId: serverId, machineId: 'machine', targets: [{ homeId: serverId, machineId: 'machine',
            desiredRevision: 0, recipePlans: [], sources: [source], appChildren: [{ sourceIndex: 0, itemIndex: 0,
                actionId: 'deployments.deploy', input: { serverId, environmentId: 'staging', expectedRevision: 1,
                    targetLinkId: 'runtime', expectedTargetLinkRevision: 1, requestKey: 'prepared-app',
                    contentArtifactId: 'candidate', contentHeaderVersion: 1, contentBodyVersion: 1 } }] }] };
        const { app, mint } = createApp('account');
        try {
            const minted = await mint(actionId, proposal(actionId, projectNativeJsonValueForTransport(input)));
            expect(minted.statusCode, minted.body).toBe(200);
            const authorization = ExternalActionExecutionAuthorizationV1Schema.parse(minted.json());
            const read = (path: string, effect = actionId, routeInput: unknown = {}) =>
                verifyExternalActionDomainExecutionRequest(signedRequestProof(authorization, path, undefined, effect, 'GET', routeInput));
            expect(await read(`/v1/deployments/environments/staging?serverId=${serverId}`, 'deployments.environments.get',
                { serverId, environmentId: 'staging' })).not.toBeNull();
            expect(await read('/v1/artifacts/candidate', actionId, { id: 'candidate' })).not.toBeNull();
            expect(await read('/v1/account/encryption/currentness')).not.toBeNull();
            expect(await read(`/v1/deployments/environments/another?serverId=${serverId}`, 'deployments.environments.get',
                { serverId, environmentId: 'another' })).toBeNull();
            expect(await read('/v1/artifacts/unreviewed', actionId, { id: 'unreviewed' })).toBeNull();
            const ordinaryInput = { ...input, targets: input.targets.map(({ appChildren: _children, ...target }) => target) };
            const ordinaryMint = await mint(actionId, proposal(actionId, projectNativeJsonValueForTransport(ordinaryInput)));
            expect(ordinaryMint.statusCode, ordinaryMint.body).toBe(200);
            const ordinary = ExternalActionExecutionAuthorizationV1Schema.parse(ordinaryMint.json());
            expect(ordinary.binding.deploymentPreparationAdmission).toEqual({ operation: 'setup', machineTargets: ['machine'], deployments: [] });
            const subject = { v: 1 as const, kind: 'connectorToken' as const, machineId: 'machine', installationId: 'installation',
                provider: { pluginId: 'example.network', localId: 'connector' }, connectorId: 'connector' };
            const connectorPath = '/v1/deployments/machines/machine/connector-secret-grant';
            const connectorBody = { serverId, hostMachineId: 'machine', hostInstallationId: 'installation', subject,
                operation: 'read' as const };
            const connectorRead = { ...connectorBody, proof: signMachineInstallationProof({ payload: { version: 1,
                accountId: ordinary.binding.accountId, machineId: 'machine', installationId: 'installation',
                deploymentSecretLaunch: { requestBodyDigest: computeEnvironmentSecretLaunchAdmissionDigestV1(connectorBody) } },
                privateKey: installation.secretKey }) };
            const connectorRequest = (body: unknown, path = connectorPath, effect = actionId, method = 'POST') =>
                verifyExternalActionDomainExecutionRequest(signedRequestProof(ordinary, path, body, effect, method, body));
            expect(await connectorRequest(connectorRead)).not.toBeNull();
            expect(await connectorRequest({ ...connectorRead, operation: 'remove' })).toBeNull();
            expect(await connectorRequest({ ...connectorRead, operation: 'set',
                grant: { ...subject, sealedContent: 'ciphertext' } })).toBeNull();
            for (const body of [
                { ...connectorRead, serverId: 'another-home' },
                { ...connectorRead, hostMachineId: 'another-machine' },
                { ...connectorRead, hostInstallationId: 'retired-installation' },
                { ...connectorRead, subject: { ...subject, machineId: 'another-machine' } },
                { ...connectorRead, subject: { ...subject, installationId: 'retired-installation' } },
                { ...connectorRead, extraAuthority: true },
            ]) expect(await connectorRequest(body)).toBeNull();
            expect(await connectorRequest(connectorRead, '/v1/deployments/machines/another-machine/connector-secret-grant')).toBeNull();
            expect(await connectorRequest(connectorRead, connectorPath, 'deployments.bindings.set')).toBeNull();
            expect(await connectorRequest(connectorRead, connectorPath, actionId, 'GET')).toBeNull();
            expect(await verifyExternalActionDomainExecutionRequest(signedRequestProof(ordinary,
                `/v1/deployments/environments/staging?serverId=${serverId}`, undefined, 'deployments.environments.get',
                'GET', { serverId, environmentId: 'staging' }))).toBeNull();
        } finally { await app.close(); }
    });

    it.each(['plain', 'e2ee'] satisfies Array<'plain' | 'e2ee'>)('retains app update demand through the %s Action dispatcher mint', async mode => {
        const previousMode = storage.account.encryptionMode;
        storage.account.encryptionMode = mode;
        storage.state.deploymentRead.enabled = true;
        storage.state.deploymentRead.sourceReadable = true;
        storage.state.operationProtocolCapabilities = { externalActionExecutionAuthorization: { protocolVersions: [1] } };
        storage.state.operationProtocolCapabilitiesRevision = 1;
        const material = { type: 'dataKey', machineKey: new Uint8Array(32).fill(7) } satisfies Parameters<typeof sealExternalActionRequestV2>[0]['material'];
        if (mode === 'e2ee') Object.assign(storage.state, { metadata: 'encrypted-controller-metadata',
            dataEncryptionKey: sealEncryptedDataKeyEnvelopeV1({ dataKey: material.machineKey,
                recipientPublicKey: tweetnacl.box.keyPair().publicKey, randomBytes: tweetnacl.randomBytes }) });
        const actionId = 'registries.updates.check';
        const input = { kind: 'app', environments: [{ environmentId: 'staging', expectedRevision: 1 }] };
        const binding = { serverIdentityId: storage.state.homeId, accountId: 'account',
            authentication: { kind: 'account', tokenEpoch: 1 }, actionId, requestId: `app-update-${mode}`,
            target: { kind: 'machine', machineId: 'machine' } } satisfies Parameters<typeof sealExternalActionRequestV2>[0]['binding'];
        const envelope = mode === 'e2ee'
            ? sealExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1,
                binding, material, input, randomBytes: tweetnacl.randomBytes })
            : protocol.ExternalActionRequestEnvelopeV1Schema.parse({ v: 1, requestId: binding.requestId, target: binding.target, input });
        const admitted: ExternalActionExecutionAuthorizationV1[] = [];
        const app = createAuthenticatedTestApp({ authentication: 'real' });
        const io = new Server();
        // Database I/O and the daemon network are the only substituted boundaries.
        registerExternalActionRoutes(app, { dispatch: createExternalActionDaemonDispatcher({ io, forwardRpc: async request => {
            const forwarded = ExternalActionDaemonDispatchRequestSchema.parse(request.callParams);
            if (!forwarded.executionAuthorization) throw new Error('Missing Home authorization');
            admitted.push(forwarded.executionAuthorization);
            expect(forwarded.envelope.v === 1 ? forwarded.envelope.input : openExternalActionRequestV2({
                projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1,
                binding, envelope: forwarded.envelope, material })?.input).toEqual(input);
            const execution = { ok: true, result: { checkedAt: 1, results: [] } };
            const prepared = envelope.v === 2 ? prepareExternalActionResponseV2({ binding, material, request: envelope,
                executedMachineId: 'machine', execution, randomBytes: tweetnacl.randomBytes })
                : prepareExternalActionResponseEnvelopeV1({ v: 1, actionId, requestId: binding.requestId, execution });
            return { ok: true, result: createExternalActionDaemonDispatchResponse(prepared) };
        } }) });
        try {
            const token = await auth.createToken('account', undefined, { kind: 'account', authority: 'present_user' });
            const response = await app.inject({ method: 'POST', url: `${EXTERNAL_ACTION_HTTP_PATH_PREFIX_V1}${actionId}`,
                headers: { authorization: `Bearer ${token}` }, payload: envelope });
            expect(response.statusCode, response.body).toBe(200);
            expect(admitted).toHaveLength(1);
            expect(admitted[0]?.binding.registryAppUpdateAdmission).toEqual({ environments: input.environments });
            expect(admitted[0] && isExternalActionAuthorizationBoundToEnvelope(admitted[0].binding,
                { actionId, machineId: 'machine', envelope })).toBe(true);
            storage.state.deploymentRead.environment.revision = 2;
            const stale = await app.inject({ method: 'POST', url: `${EXTERNAL_ACTION_HTTP_PATH_PREFIX_V1}${actionId}`,
                headers: { authorization: `Bearer ${token}` }, payload: envelope });
            expect(stale.statusCode, stale.body).toBe(403);
            expect(admitted).toHaveLength(1);
        } finally {
            storage.state.deploymentRead.environment.revision = 1;
            storage.account.encryptionMode = previousMode;
            await app.close();
        }
    });

    it('keeps an admitted app update within its selected Environment across revision and Source changes', async () => {
        const rows = storage.state.deploymentRead;
        rows.enabled = true;
        rows.sourceReadable = true;
        const actionId = 'registries.updates.check';
        const input = { kind: 'app', environments: [{ environmentId: 'staging', expectedRevision: 1 }] };
        const { app, mint, dispatch } = createApp('account');
        try {
            const requested = proposal(actionId, input);
            const minted = await mint(actionId, requested);
            expect(minted.statusCode, minted.body).toBe(200);
            const authorization = ExternalActionExecutionAuthorizationV1Schema.parse(minted.json());
            expect(authorization.binding.registryAppUpdateAdmission).toEqual({ environments: input.environments });
            const serverId = storage.state.homeId;
            const relayPath = `${EXTERNAL_ACTION_HTTP_PATH_PREFIX_V1}${actionId}`;
            const relay = () => verifyExternalActionDomainExecutionRequest(signedRequestProof(authorization, relayPath,
                { v: 1, machineId: 'machine', envelope: requested.envelope, executionAuthorization: authorization }));
            const metadata = () => verifyExternalActionDomainExecutionRequest(signedRequestProof(authorization,
                `/v1/deployments/environments/staging?serverId=${serverId}`, undefined, 'deployments.environments.get',
                'GET', { serverId, environmentId: 'staging' }));
            expect(await relay()).not.toBeNull();
            expect(await metadata()).not.toBeNull();
            expect(await verifyExternalActionDomainExecutionRequest(signedRequestProof(authorization,
                '/v1/artifacts/environment-content', undefined, actionId, 'GET', { id: 'environment-content' }))).not.toBeNull();
            for (const [path, effect, method, body, routeInput] of [
                [`/v1/deployments/environments/another?serverId=${serverId}`, 'deployments.environments.get', 'GET', undefined, { serverId, environmentId: 'another' }],
                ['/v1/artifacts/another', actionId, 'GET', undefined, { id: 'another' }],
                ['/v1/artifacts', actionId, 'GET', undefined, {}],
                ['/v1/artifacts/environment-content', actionId, 'PATCH', { body: 'replacement' }, { id: 'environment-content' }],
                ['/v1/deployments/environments/staging', 'deployments.environments.update', 'PATCH', {}, {}],
            ] as const) expect(await verifyExternalActionDomainExecutionRequest(signedRequestProof(authorization,
                path, body, effect, method, routeInput)), path).toBeNull();
            rows.environment.revision = 2;
            expect(await metadata()).not.toBeNull();
            expect(await relay()).not.toBeNull();
            expect((await mint(actionId, requested)).statusCode).toBe(403);
            rows.environment.revision = 1;
            rows.sourceReadable = false;
            expect(await metadata()).not.toBeNull();
            expect(await relay()).not.toBeNull();
            expect((await mint(actionId, requested)).statusCode).toBe(403);
            expect(dispatch).not.toHaveBeenCalled();
        } finally { rows.environment.revision = 1; rows.sourceReadable = true; await app.close(); }
    });

    it('seals deployment child eligibility once at mint and trusts it through signed reads', async () => {
        storage.state.deploymentRead.enabled = true;
        storage.state.deploymentRead.sourceReadable = true;
        const serverId = storage.state.homeId;
        const actionId = 'deployments.templates.instantiate';
        const input = { mode: 'apply', serverId, machineId: 'machine', projectSourceId: 'source',
            templateRef: { sourceId: 'apps', itemId: 'postgresql', version: '1',
                ref: { kind: 'content', digest: `sha256:${'a'.repeat(64)}` } },
            environment: { kind: 'existing', environmentId: 'staging', expectedRevision: 1 },
            target: { kind: 'existing', targetLinkId: 'runtime', expectedRevision: 1, installationId: 'installation' },
            destination: { kind: 'stored', contentRevision: 1, composeDigest: `sha256:${'b'.repeat(64)}` },
            bindings: [], deploy: { requestKey: 'deploy-template' } };
        const { app, mint } = createApp('account');
        const classification = vi.spyOn(protocol, 'isDeploymentChildRootActionIdV1');
        try {
            const minted = await mint(actionId, proposal(actionId, projectNativeJsonValueForTransport(input)));
            expect(minted.statusCode, minted.body).toBe(200);
            const authorization = ExternalActionExecutionAuthorizationV1Schema.parse(minted.json());
            expect(authorization.binding).toHaveProperty('deploymentChildRoot', true);
            expect(classification).toHaveBeenCalledTimes(1);
            classification.mockClear();
            for (const path of [`/v1/deployments/environments/staging?serverId=${serverId}`,
                `/v1/deployments/environments/staging/deployments?serverId=${serverId}`]) {
                const effect = path.includes('/deployments?') ? 'deployments.receipts.list' : 'deployments.environments.get';
                expect(await verifyExternalActionDomainExecutionRequest(signedRequestProof(authorization, path,
                    undefined, effect, 'GET', { serverId, environmentId: 'staging' }))).not.toBeNull();
            }
            expect(classification).not.toHaveBeenCalled();
            const { deploymentChildRoot: _sealed, ...unbound } = authorization.binding;
            await expect(auth.mintExternalActionExecutionAuthorization({ ...unbound, deploymentChildRoot: true }))
                .rejects.toMatchObject({ code: 'credential_scope_denied' });
        } finally { classification.mockRestore(); await app.close(); }
    });

    it.each(['preview', 'apply'] as const)('binds template %s to its exact Source, Environment and reviewed write purpose', async mode => {
        storage.state.deploymentRead.enabled = true;
        storage.state.deploymentRead.sourceReadable = true;
        const serverId = storage.state.homeId;
        const actionId = 'deployments.templates.instantiate';
        const input = { mode, serverId, machineId: 'machine', projectSourceId: 'source',
            templateRef: { sourceId: 'apps', itemId: 'postgresql', version: '1',
                ref: { kind: 'content', digest: `sha256:${'a'.repeat(64)}` } },
            environment: { kind: 'existing', environmentId: 'staging', expectedRevision: 1 },
            target: { kind: 'existing', targetLinkId: 'runtime', expectedRevision: 1, installationId: 'installation' },
            destination: { kind: 'stored', contentRevision: 1, composeDigest: `sha256:${'b'.repeat(64)}` }, bindings: [] };
        const { app, mint } = createApp('account');
        try {
            const minted = await mint(actionId, proposal(actionId, projectNativeJsonValueForTransport(input)));
            expect(minted.statusCode, minted.body).toBe(200);
            const authorization = ExternalActionExecutionAuthorizationV1Schema.parse(minted.json());
            expect(authorization.binding.deploymentPreparationAdmission).toEqual({ operation: 'template', mode,
                source: { id: 'source' }, machineId: 'machine', environment: input.environment, target: input.target });
            for (const kind of [DEPLOYMENT_ENVIRONMENT_ARTIFACT_KIND_V1, DEPLOYMENT_TARGET_LINK_ARTIFACT_KIND_V1]) {
                const header = { kind, title: 'Reviewed deployment content' };
                // The Artifact owner publishes its indexed stored kind, not
                // the private header discriminator, at this HTTP boundary.
                const artifact = ArtifactJsonCreateHttpInputV1Schema.parse({ id: randomUUID(),
                    header: encodePlainArtifactStoredContent(header), body: encodePlainArtifactStoredContent({ body: '{}' }),
                    dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER, kind: deriveArtifactStoredKindV1(header) });
                expect(Boolean(await verifyExternalActionDomainExecutionRequest(signedRequestProof(authorization,
                    '/v1/artifacts', artifact, actionId, 'POST', artifact))), `${mode}: ${kind}`).toBe(mode === 'apply');
            }
            const read = `/v1/deployments/environments/staging?serverId=${serverId}`;
            expect(await verifyExternalActionDomainExecutionRequest(signedRequestProof(authorization, read,
                undefined, 'deployments.environments.get', 'GET', { serverId, environmentId: 'staging' }))).not.toBeNull();
            const defaultsRead = `/v1/projects/source/deployment-defaults?serverId=${serverId}`;
            expect(await verifyExternalActionDomainExecutionRequest(signedRequestProof(authorization, defaultsRead,
                undefined, actionId, 'GET', { serverId, id: 'source' }))).not.toBeNull();
            expect(await verifyExternalActionDomainExecutionRequest(signedRequestProof(authorization,
                defaultsRead.replace('/source/', '/another/'), undefined, actionId, 'GET',
                { serverId, id: 'another' }))).toBeNull();
            const body = { serverId, environmentId: 'staging', expectedRevision: 1,
                contentArtifactId: 'candidate', contentHeaderVersion: 1, contentBodyVersion: 1 };
            for (const [path, effect, method] of [
                ['/v1/deployments/environments/staging', 'deployments.environments.update', 'PATCH'],
                ['/v1/deployments/environments/staging/template', actionId, 'POST'],
            ]) {
                const verified = await verifyExternalActionDomainExecutionRequest(signedRequestProof(authorization, path, body, effect, method, body));
                expect(Boolean(verified), `${mode}: ${path}`).toBe(mode === 'apply');
                expect(await verifyExternalActionDomainExecutionRequest(signedRequestProof(authorization,
                    path.replace('staging', 'another'), { ...body, environmentId: 'another' }, effect, method,
                    { ...body, environmentId: 'another' }))).toBeNull();
            }
            expect(await verifyExternalActionDomainExecutionRequest(signedRequestProof(authorization,
                '/v1/deployments/environments/staging/template', { ...body, patch: { buildMachineId: 'another' } }, actionId,
                'POST', { ...body, patch: { buildMachineId: 'another' } }))).toBeNull();
            storage.state.deploymentRead.sourceReadable = false;
            expect(await verifyExternalActionDomainExecutionRequest(signedRequestProof(authorization, read,
                undefined, 'deployments.environments.get', 'GET', { serverId, environmentId: 'staging' }))).not.toBeNull();
            expect(await verifyExternalActionDomainExecutionRequest(signedRequestProof(authorization,
                '/v1/deployments/environments/staging/template', body, actionId, 'POST', body))).toBeNull();
            expect((await mint(actionId, proposal(actionId, projectNativeJsonValueForTransport(input)))).statusCode).toBe(403);
        } finally { await app.close(); }
    });

    it('retains reviewed deployment preparation reads and refuses fresh admission after Source access loss', async () => {
        const actionId = 'deployments.prepare';
        storage.state.deploymentRead.enabled = true;
        storage.state.deploymentRead.sourceReadable = true;
        const serverId = storage.state.homeId;
        const source = { id: 'source', revision: 1 };
        const input = DeploymentPrepareInputV1Schema.parse({ projectSourceId: source.id, sourceRevision: source.revision,
            repository: { kind: 'github', deployment: 'https://github.com', repository: 'private/project' },
            baseCommit: 'a'.repeat(40), workspace: { kind: 'workspace-ref', serverId, id: 'workspace' }, environmentId: 'staging',
            sessionRef: { serverId, sessionId: 'session' } });
        const admission = { operation: 'prepare', source, environment: { id: 'staging' }, workspace: { kind: 'workspace-ref', id: 'workspace' } };
        const { app, mint } = createApp('account');
        try {
            const minted = await mint(actionId, proposal(actionId, projectNativeJsonValueForTransport(input)));
            expect(minted.statusCode, minted.body).toBe(200);
            const authorization = ExternalActionExecutionAuthorizationV1Schema.parse(minted.json());
            expect.soft(authorization.binding).toMatchObject({ deploymentPreparationAdmission: admission });
            const relayBody = { v: 1, machineId: authorization.binding.machineId,
                envelope: proposal(actionId, projectNativeJsonValueForTransport(input)).envelope,
                executionAuthorization: authorization };
            const relayPath = `${EXTERNAL_ACTION_HTTP_PATH_PREFIX_V1}${actionId}`;
            expect(Boolean(await verifyExternalActionDomainExecutionRequest(signedRequestProof(
                authorization, relayPath, relayBody)))).toBe(true);
            expect(await verifyExternalActionDomainExecutionRequest(signedRequestProof(authorization, relayPath,
                { ...relayBody, machineId: 'another' }))).toBeNull();
            const reads: readonly (readonly [string, string, string, unknown, unknown])[] = [
                [`/v1/projects/sources/source?serverId=${serverId}`, 'projects.sources.read', 'GET', undefined, { serverId, id: 'source' }],
                [`/v1/deployments/environments/staging?serverId=${serverId}`, 'deployments.environments.get', 'GET', undefined, { serverId, environmentId: 'staging' }],
                ['/v1/account/project-rows/read', actionId, 'POST', { key: { kind: 'workspace-ref', serverId, id: 'workspace' } },
                    { key: { kind: 'workspace-ref', serverId, id: 'workspace' } }],
                ['/v1/account/encryption/currentness', actionId, 'GET', undefined, {}],
            ];
            for (const [path, effect, method, body, routeInput] of reads) expect.soft(Boolean(
                await verifyExternalActionDomainExecutionRequest(signedRequestProof(authorization, path, body, effect, method, routeInput))), path).toBe(true);
            for (const [path, effect, method, body, routeInput] of [
                [`/v1/projects/sources/another?serverId=${serverId}`, 'projects.sources.read', 'GET', undefined, { serverId, id: 'another' }],
                [`/v1/deployments/environments/another?serverId=${serverId}`, 'deployments.environments.get', 'GET', undefined, { serverId, environmentId: 'another' }],
                ['/v1/artifacts/another', actionId, 'GET', undefined, { id: 'another' }],
                ['/v1/artifacts/candidate', actionId, 'PATCH', { header: 'replacement' }, { id: 'candidate' }],
                [`/v1/projects/sources/source?serverId=${serverId}`, 'projects.sources.read', 'PATCH', { revision: 2 }, { serverId, id: 'source' }],
                ['/v1/artifacts', actionId, 'GET', undefined, {}],
                ['/v3/automations/runs/workflow-storage', actionId, 'POST', { operation: 'admit', publisherMachineId: 'machine' }, {}],
                ['/v1/account/project-rows/read', actionId, 'POST', { key: { kind: 'workspace-ref', serverId, id: 'another' } }, { key: { kind: 'workspace-ref', serverId, id: 'another' } }],
            ] as const) expect.soft(await verifyExternalActionDomainExecutionRequest(signedRequestProof(
                authorization, path, body, effect, method, routeInput)), path).toBeNull();
            storage.state.deploymentRead.sourceReadable = false;
            expect(await verifyExternalActionDomainExecutionRequest(signedRequestProof(
                authorization, relayPath, relayBody))).not.toBeNull();
            expect(await verifyExternalActionDomainExecutionRequest(signedRequestProof(authorization,
                `/v1/projects/sources/source?serverId=${serverId}`, undefined, 'projects.sources.read', 'GET', { serverId, id: 'source' }))).not.toBeNull();
            expect((await mint(actionId, proposal(actionId, projectNativeJsonValueForTransport(input)))).statusCode).toBe(403);
        } finally { await app.close(); }
    });

    it.each(['manage', 'use'] as const)('admits %s deployment restart through its native handle without private deployment reads', async role => {
        const rows = storage.state.deploymentRead;
        rows.enabled = true; rows.sourceReadable = true;
        rows.source.owner = role === 'use' ? { kind: 'team', teamId: 'source-team' } : { kind: 'account', accountId: 'account' };
        rows.environment.deployerMode = 'members';
        if (role === 'use') {
            storage.state.creation.team = { id: 'source-team', name: 'Source Team', description: null, logo: null,
                sessionCreationPolicy: 'private_default', externalSharingPolicy: 'allowed',
                defaultSessionHistoryAccess: 'all_existing', admissionMode: 'invite_only',
                authenticationPolicy: null, archivedAt: null };
            storage.state.metadata = shareableMachineMetadata;
            storage.state.operationProtocolCapabilities = { requesterExecutionIsolation: { protocolVersions: [1] } };
            storage.state.accountGrants.push({ accountId: 'other-account', accessLevel: 'view', account: {
                id: 'other-account', status: 'active', name: null, firstName: null, lastName: null, username: null, avatar: null,
            } });
        }
        const { app } = createApp('account');
        const actionId = 'deployments.restart';
        const serverId = storage.state.homeId;
        const input = { serverId, environmentId: 'staging', deploymentId: 'active-receipt', targetLinkId: 'runtime',
            machineId: 'machine', installationId: 'installation', expectedGeneration: 'generation',
            service: { kind: 'deployment', machineId: 'machine', environmentId: 'staging',
                environmentInstanceId: 'staging-instance', composeService: 'web', serviceId: 'staging-instance/web' } };
        const request = (value: typeof input = input) => ({ v: 1, machineId: 'machine', envelope: {
            v: 1, requestId: 'restart-existing', target: { kind: 'machine', machineId: 'machine' }, input: value } });
        const mint = (value: typeof input = input) => app.inject({ method: 'POST',
            url: bindExternalActionExecutionAuthorizationHttpPathV1(actionId),
            headers: { 'x-test-user-id': role === 'use' ? 'other-account' : 'account', 'x-test-auth-token-kind': 'account' },
            payload: request(value) });
        try {
            const response = await mint();
            expect(response.statusCode, response.body).toBe(200);
            const authorization = ExternalActionExecutionAuthorizationV1Schema.parse(response.json());
            expect(authorization.binding).toMatchObject({ admittedMachineRole: role, environmentId: 'staging',
                deploymentNativeAdmission: { kind: 'restart', environmentId: 'staging', targetLinkId: 'runtime',
                    deploymentId: 'active-receipt', machineId: 'machine', installationId: 'installation' } });
            expect(authorization.binding.deploymentCandidatePublication).toBeUndefined();
            expect(await auth.verifyExternalActionExecutionAuthorization(authorization.token)).toEqual(authorization.binding);
            expect(await verifyProposalCurrentness(authorization)).not.toBeNull();
            const relayPath = `${EXTERNAL_ACTION_HTTP_PATH_PREFIX_V1}${actionId}`;
            const relayBody = { ...request(), executionAuthorization: authorization };
            expect.soft(await verifyExternalActionDomainExecutionRequest(signedRequestProof(authorization, relayPath, relayBody))).not.toBeNull();
            expect(await verifyExternalActionDomainExecutionRequest(signedRequestProof(authorization,
                '/v1/machines/machine', undefined, actionId, 'GET', { id: 'machine' }))).not.toBeNull();
            for (const [path, effect, routeInput] of [
                [`/v1/deployments/environments/staging?serverId=${serverId}`, 'deployments.environments.get', { serverId, environmentId: 'staging' }],
                [`/v1/deployments/receipts/active-receipt?serverId=${serverId}`, 'deployments.receipts.get', { serverId, deploymentId: 'active-receipt' }],
                ['/v1/artifacts/environment-content', actionId, { id: 'environment-content' }],
                ['/v1/artifacts/receipt-content', actionId, { id: 'receipt-content' }],
            ] as const) expect.soft(await verifyExternalActionDomainExecutionRequest(signedRequestProof(authorization,
                path, undefined, effect, 'GET', routeInput)), path).toBeNull();
            for (const [path, effect, routeInput] of [
                [`/v1/deployments/environments/foreign?serverId=${serverId}`, 'deployments.environments.get', { serverId, environmentId: 'foreign' }],
                [`/v1/deployments/receipts/foreign?serverId=${serverId}`, 'deployments.receipts.get', { serverId, deploymentId: 'foreign' }],
                ['/v1/artifacts/foreign', actionId, { id: 'foreign' }],
                [`/v1/projects/sources/source?serverId=${serverId}`, 'projects.sources.read', { serverId, id: 'source' }],
            ] as const) expect(await verifyExternalActionDomainExecutionRequest(signedRequestProof(authorization,
                path, undefined, effect, 'GET', routeInput)), path).toBeNull();
            rows.receipt.environmentId = 'foreign';
            expect((await mint()).statusCode).toBe(403);
            rows.receipt.environmentId = 'staging';
            rows.link.machines[0]!.installationId = 'foreign';
            expect((await mint()).statusCode).toBe(403);
            rows.link.machines[0]!.installationId = 'installation';
            if (role === 'use') {
                rows.environment.deployerMode = 'managers';
                const managersOnly = await mint();
                expect(managersOnly.statusCode, managersOnly.body).toBe(403);
                expect(managersOnly.json()).toMatchObject({ error: 'credential_scope_denied' });
                rows.environment.deployerMode = 'members';
            }
            rows.sourceReadable = false;
            expect((await mint()).statusCode).toBe(403);
        } finally {
            rows.receipt.environmentId = 'staging'; rows.link.machines[0]!.installationId = 'installation';
            rows.sourceReadable = true; await app.close();
            rows.environment.deployerMode = 'members';
        }
    });

    it.each(['deployments.health.read', 'deployments.drift.read', 'deployments.logs.read'] as const)(
        'binds the exact deployment read purpose for %s without granting another resource or mutation', async actionId => {
            storage.state.deploymentRead.enabled = true;
            storage.state.deploymentRead.sourceReadable = true;
            const { app, mint } = createApp('account');
            const serverId = 'srv_proposal_admission';
            const references = { serverId, environmentId: 'staging', deploymentId: 'active-receipt', targetLinkId: 'runtime',
                machineId: 'machine', installationId: 'installation' };
            const service = { kind: 'deployment', machineId: 'machine', environmentId: 'staging',
                environmentInstanceId: 'staging-instance', composeService: 'private-web', serviceId: 'staging-instance/private-web' };
            const input = { ...references, service,
                ...(actionId === 'deployments.drift.read' ? { expectedRevision: 1 } : {}),
                ...(actionId === 'deployments.logs.read' ? { kind: 'runtime' } : {}) };
            const { serverId: _serverId, ...routing } = references;
            const admission = { actionId, ...routing,
                ...(actionId === 'deployments.drift.read' ? { expectedRevision: 1 } : {}),
                ...(actionId === 'deployments.logs.read' ? { kind: 'runtime' } : {}) };
            try {
                const requested = proposal(actionId, projectNativeJsonValueForTransport(input));
                const minted = await mint(actionId, requested);
                expect(minted.statusCode, minted.body).toBe(200);
                const authorization = ExternalActionExecutionAuthorizationV1Schema.parse(minted.json());
                expect.soft(authorization.binding).toMatchObject({ deploymentReadAdmission: admission });
                expect.soft(JSON.stringify(authorization.binding)).not.toContain('private-web');
                expect.soft(await verifyProposalCurrentness(authorization)).not.toBeNull();
                if (actionId === 'deployments.logs.read') {
                    const path = '/v1/deployments/environments/access';
                    const body = { serverId, environmentIds: ['staging'] };
                    const access = (value: unknown = body, routeInput: unknown = value, requestPath = path) =>
                        verifyExternalActionDomainExecutionRequest(signedRequestProof(authorization,
                            requestPath, value, actionId, 'POST', routeInput));
                    expect.soft(await access(), 'the native logs root can prepare only its bound Environment access').not.toBeNull();
                    for (const invalid of [
                        { ...body, environmentIds: ['another'] }, { ...body, environmentIds: ['staging', 'another'] },
                        { ...body, environmentIds: [] }, { ...body, serverId: 'foreign' }, { ...body, extraAuthority: true },
                    ]) expect.soft(await access(invalid)).toBeNull();
                    expect.soft(await access(body, { ...body, environmentIds: ['another'] })).toBeNull();
                    expect.soft(await access(body, body, `${path}?broaden=true`)).toBeNull();
                    storage.state.deploymentRead.sourceReadable = false;
                    expect.soft(await access(), 'the bound native read retains current Source authority').toBeNull();
                    storage.state.deploymentRead.sourceReadable = true;
                    expect.soft(await access(), 'restored Source authority reaches the same signed root').not.toBeNull();
                }
                const relayPath = `${EXTERNAL_ACTION_HTTP_PATH_PREFIX_V1}${encodeURIComponent(actionId)}`;
                const relayBody = { v: 1 as const, machineId: requested.machineId, envelope: requested.envelope,
                    executionAuthorization: authorization };
                const readRelay = () => verifyExternalActionDomainExecutionRequest(signedRequestProof(authorization,
                    relayPath, relayBody, actionId, 'POST'));
                expect.soft(Boolean(await readRelay()), 'exact original Action relay').toBe(true);
                expect.soft(await verifyExternalActionDomainExecutionRequest(signedRequestProof(authorization,
                    relayPath, { ...relayBody, envelope: { ...requested.envelope, input: { ...input, deploymentId: 'another' } } },
                    actionId, 'POST'))).toBeNull();
                expect.soft(await verifyExternalActionDomainExecutionRequest(signedRequestProof(authorization,
                    relayPath, { ...relayBody, machineId: 'another-machine' }, actionId, 'POST'))).toBeNull();
                for (const [path, effect, routeInput] of [
                    [`/v1/deployments/environments/staging?serverId=${serverId}`, 'deployments.environments.get', { serverId, environmentId: 'staging' }],
                    [`/v1/deployments/receipts/active-receipt?serverId=${serverId}`, 'deployments.receipts.get', { serverId, deploymentId: 'active-receipt' }],
                    ['/v1/artifacts/environment-content', actionId, { id: 'environment-content' }],
                    [`/v1/projects/sources/source?serverId=${serverId}`, 'projects.sources.read', { serverId, id: 'source' }],
                    ['/v1/artifacts/runtime-content', actionId, { id: 'runtime-content' }],
                    ['/v1/artifacts/receipt-content', actionId, { id: 'receipt-content' }],
                ] as const) {
                    expect.soft(Boolean(await verifyExternalActionDomainExecutionRequest(signedRequestProof(authorization,
                        path, undefined, effect, 'GET', routeInput))), path).toBe(true);
                }
                for (const [path, effect, method, body, routeInput] of [
                    [`/v1/deployments/environments/another?serverId=${serverId}`, 'deployments.environments.get', 'GET', undefined, { serverId, environmentId: 'another' }],
                    [`/v1/deployments/receipts/another?serverId=${serverId}`, 'deployments.receipts.get', 'GET', undefined, { serverId, deploymentId: 'another' }],
                    [`/v1/deployments/environments/staging?serverId=foreign`, 'deployments.environments.get', 'GET', undefined, { serverId: 'foreign', environmentId: 'staging' }],
                    ['/v1/artifacts/another', actionId, 'GET', undefined, { id: 'another' }],
                    ['/v1/artifacts', actionId, 'POST', { id: 'new', header: 'sealed', body: 'sealed' }, undefined],
                    ['/v1/deployments/environments/staging/deploy', 'deployments.deploy', 'POST', input, input],
                    [`/v1/projects/sources/another?serverId=${serverId}`, 'projects.sources.read', 'GET', undefined, { serverId, id: 'another' }],
                ] as const) {
                    expect.soft(await verifyExternalActionDomainExecutionRequest(signedRequestProof(authorization,
                        path, body, effect, method, routeInput)), path).toBeNull();
                }
                const readEnvironment = () => verifyExternalActionDomainExecutionRequest(signedRequestProof(authorization,
                    `/v1/deployments/environments/staging?serverId=${serverId}`, undefined,
                    'deployments.environments.get', 'GET', { serverId, environmentId: 'staging' }));
                const rows = storage.state.deploymentRead;
                // Finite health/drift reads retain admission; open logs recheck access.
                const expectRetainedRead = async () => expect.soft(Boolean(await readEnvironment())).toBe(actionId !== 'deployments.logs.read');
                rows.sourceReadable = false;
                await expectRetainedRead();
                expect.soft(Boolean(await readRelay()), 'finite admitted transport continues; open logs stop').toBe(actionId !== 'deployments.logs.read');
                expect((await mint(actionId, requested)).statusCode).toBe(403);
                rows.sourceReadable = true;
                rows.receipt.environmentId = 'another-environment';
                await expectRetainedRead();
                rows.receipt.environmentId = 'staging';
                rows.receipt.targetLinkId = 'another-link';
                await expectRetainedRead();
                rows.receipt.targetLinkId = 'runtime';
                rows.environment.revision = 2;
                expect.soft(Boolean(await readEnvironment()), 'finite admission and current open-log authority survive an unrelated revision').toBe(true);
                rows.environment.revision = 1;
                rows.link.id = 'substituted-link';
                await expectRetainedRead();
                rows.link.id = 'runtime';
                rows.link.machines[0]!.installationId = 'substituted-installation';
                if (actionId !== 'deployments.logs.read') await expectRetainedRead();
                rows.link.machines[0]!.installationId = 'installation';
                rows.environment.deletedAt = new Date(1);
                rows.link.activeDeploymentId = 'newer-receipt';
                rows.environment.buildMachineId = 'replacement-builder';
                if (actionId === 'deployments.logs.read') {
                    const historicalInput = { ...references, kind: 'build' };
                    const historical = await mint(actionId, proposal(actionId, projectNativeJsonValueForTransport(historicalInput)));
                    expect(historical.statusCode, historical.body).toBe(200);
                    const historicalAuthorization = ExternalActionExecutionAuthorizationV1Schema.parse(historical.json());
                    expect.soft(Boolean(await verifyExternalActionDomainExecutionRequest(signedRequestProof(historicalAuthorization,
                        `/v1/deployments/receipts/active-receipt?serverId=${serverId}`, undefined, 'deployments.receipts.get',
                        'GET', { serverId, deploymentId: 'active-receipt' })))).toBe(true);
                } else await expectRetainedRead();
            } finally {
                const rows = storage.state.deploymentRead;
                rows.enabled = false; rows.sourceReadable = true; rows.link.id = 'runtime';
                rows.receipt.environmentId = 'staging'; rows.receipt.targetLinkId = 'runtime'; rows.environment.revision = 1;
                rows.link.machines[0]!.installationId = 'installation'; rows.environment.deletedAt = null;
                rows.link.activeDeploymentId = 'active-receipt'; rows.environment.buildMachineId = 'machine';
                await app.close();
            }
        });
    it.each([{ mode: 'preview', purpose: 'standard' }, { mode: 'apply', purpose: 'standard' },
        { mode: 'apply', purpose: 'preview' }] as const)('admits only the authored create Source and protected Artifact preparation under its original signed root ($mode/$purpose)', async ({ mode, purpose }) => {
        storage.state.deploymentRead.enabled = true;
        storage.state.deploymentRead.sourceReadable = true;
        const { app, mint } = createApp('account');
        const serverId = storage.state.homeId;
        const actionId = 'deployments.environments.create';
        const preview = purpose === 'preview' ? { templateEnvironmentId: 'staging', expectedTemplateRevision: 1,
            pullRequestId: '42', runtimeTargetLinkId: 'runtime' } : undefined;
        const input = { mode, serverId, projectSourceId: 'source', requestKey: 'authored-create', ...(preview ? { preview } : {}),
            name: 'Reviewed app', protection: 'nonProduction', purpose, deployerMode: 'chosen',
            deployerPrincipals: DeploymentEnvironmentDeployerPrincipalsV1Schema.parse([{ principalKind: 'account', principalId: 'account' }]),
            definition: { from: 'image', image: 'nginx:1', port: 80 },
            firstTargetLink: { machines: [{ machineId: 'machine', installationId: 'installation' }] } };
        try {
            const minted = await mint(actionId, proposal(actionId, projectNativeJsonValueForTransport(input)));
            expect(minted.statusCode, minted.body).toBe(200);
            const authorization = ExternalActionExecutionAuthorizationV1Schema.parse(minted.json());
            expect(authorization.binding.deploymentPreparationAdmission).toEqual({ operation: 'create', mode, source: { id: 'source' },
                requestKey: input.requestKey, protection: input.protection, purpose: input.purpose, deployerMode: input.deployerMode,
                deployerPrincipals: input.deployerPrincipals, ...(preview ? { preview } : {}) });
            const verify = (path: string, body: unknown, method = 'GET', routeInput?: unknown, effect = actionId) =>
                verifyExternalActionDomainExecutionRequest(signedRequestProof(authorization, path, body, effect, method, routeInput));
            const prepared = { serverId, projectSourceId: input.projectSourceId, requestKey: input.requestKey, ...(preview ? { preview } : {}),
                protection: input.protection, purpose: input.purpose, deployerMode: input.deployerMode, deployerPrincipals: input.deployerPrincipals,
                controllerMachineId: 'machine', contentArtifactId: 'candidate', contentHeaderVersion: 1, contentBodyVersion: 1 };
            expect(Boolean(await verify('/v1/deployments/environments', prepared, 'POST', prepared))).toBe(mode === 'apply');
            for (const altered of [{ ...prepared, requestKey: 'another' }, { ...prepared, protection: 'production' },
                { ...prepared, deployerMode: 'members' }, { ...prepared, projectSourceId: 'another' },
                { ...prepared, serverId: 'another-home' },
                { ...prepared, deployerPrincipals: DeploymentEnvironmentDeployerPrincipalsV1Schema.parse([{ principalKind: 'account', principalId: 'other-account' }]) }]) {
                expect.soft(await verify('/v1/deployments/environments', altered, 'POST', altered)).toBeNull();
            }
            const reads = [
                [`/v1/projects/sources/source?serverId=${serverId}`, { serverId, id: 'source' }],
                [`/v1/projects/source/deployment-defaults?serverId=${serverId}`, { serverId, id: 'source' }],
                ['/v1/account/encryption/currentness', {}],
            ] as const;
            for (const [path, routeInput] of reads) expect.soft(await verify(path, undefined, 'GET', routeInput), path).not.toBeNull();
            for (const kind of [DEPLOYMENT_ENVIRONMENT_ARTIFACT_KIND_V1, DEPLOYMENT_TARGET_LINK_ARTIFACT_KIND_V1]) {
                const header = { kind, title: 'Reviewed app' };
                const artifact = ArtifactJsonCreateHttpInputV1Schema.parse({ id: randomUUID(),
                    header: encodePlainArtifactStoredContent(header), body: encodePlainArtifactStoredContent({ body: '{}' }),
                    dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER, kind: deriveArtifactStoredKindV1(header) });
                expect.soft(await verify('/v1/artifacts', artifact, 'POST', artifact), kind).not.toBeNull();
                expect.soft(await verify('/v1/artifacts', { ...artifact, kind: DEPLOYMENT_RECEIPT_ARTIFACT_STORED_KIND_V1 },
                    'POST', { ...artifact, kind: DEPLOYMENT_RECEIPT_ARTIFACT_STORED_KIND_V1 })).toBeNull();
                expect.soft(await verify('/v1/artifacts', artifact, 'POST', { ...artifact, id: randomUUID() })).toBeNull();
                expect.soft(await verify('/v1/artifacts', artifact, 'POST', artifact, 'artifact.create')).toBeNull();
            }
            for (const path of [`/v1/projects/sources/another?serverId=${serverId}`,
                `/v1/projects/another/deployment-defaults?serverId=${serverId}`,
                '/v1/projects/sources/source?serverId=another-home', '/v1/artifacts/another']) {
                expect.soft(await verify(path, undefined), path).toBeNull();
            }
            expect(await verify('/v1/artifacts/another/access/grants', {
                artifactId: 'another', principal: { kind: 'team', teamId: 'unrelated' }, accessLevel: 'admin',
            }, 'PUT')).toBeNull();
            storage.state.deploymentRead.sourceReadable = false;
            for (const [path, routeInput] of reads) expect.soft(await verify(path, undefined, 'GET', routeInput), path).not.toBeNull();
            const refused = await mint(actionId, proposal(actionId, projectNativeJsonValueForTransport({
                ...input, requestKey: randomUUID(),
            })));
            expect(refused.statusCode, refused.body).toBe(403);
            expect(refused.json()).toMatchObject({ error: 'credential_scope_denied' });
        } finally {
            storage.state.deploymentRead.enabled = false;
            storage.state.deploymentRead.sourceReadable = true;
            await app.close();
        }
    });

    it('retains the Source Team audience and actual Artifact ownership for signed create grant and recipient preparation', async () => {
        const rows = storage.state.deploymentRead;
        const creation = storage.state.creation;
        const originalOwner = rows.source.owner;
        rows.enabled = true; rows.sourceReadable = true;
        rows.source.owner = { kind: 'team', teamId: 'source-team' };
        creation.team = { id: 'source-team', name: 'Source Team', description: null, logo: null,
            sessionCreationPolicy: 'private_default', externalSharingPolicy: 'allowed',
            defaultSessionHistoryAccess: 'all_existing', admissionMode: 'invite_only',
            authenticationPolicy: null, archivedAt: null };
        creation.membershipActive = true;
        creation.artifact.accountId = 'account'; creation.artifact.kind = null; creation.artifact.accountGrants = [];
        const { app, mint } = createApp('account');
        const serverId = storage.state.homeId;
        const actionId = 'deployments.environments.create';
        const input = { mode: 'preview', serverId, projectSourceId: 'source', requestKey: 'team-create',
            name: 'Team app', protection: 'nonProduction', purpose: 'standard', deployerMode: 'managers',
            definition: { from: 'image', image: 'nginx:1', port: 80 } };
        try {
            const minted = await mint(actionId, proposal(actionId, projectNativeJsonValueForTransport(input)));
            expect(minted.statusCode, minted.body).toBe(200);
            const authorization = ExternalActionExecutionAuthorizationV1Schema.parse(minted.json());
            const artifactId = creation.artifact.id;
            const base = `/v1/artifacts/${artifactId}`;
            const grant = { artifactId, principal: { kind: 'team', teamId: 'source-team' }, accessLevel: 'admin' };
            // This proves the signed HTTP purpose, not an E2EE Account or a
            // cryptographic commit. The real Artifact owner still validates
            // audience/key fences; CLI real-store coverage owns sealing.
            const envelope = encodeBase64(new Uint8Array(SESSION_DATA_KEY_ENVELOPE_BYTES_V1).fill(1));
            const commit = ArtifactRecipientKeyEnvelopeCommitInputV1Schema.parse({ artifactId, expectedDataEncryptionKey: envelope,
                recipientKeyEnvelopes: [{ recipientAccountId: 'other-account', encryptedDataKey: envelope,
                    recipientContentPublicKeyFingerprint: `content-public-key-sha256:${'a'.repeat(64)}` }] });
            const verify = (suffix: string, body: unknown = undefined, method = 'GET', effect = actionId) =>
                verifyExternalActionDomainExecutionRequest(signedRequestProof(authorization, `${base}${suffix}`, body, effect,
                    method, { id: artifactId, ...(body && typeof body === 'object' ? body : {}) }));
            for (const kind of [null, DEPLOYMENT_ENVIRONMENT_ARTIFACT_STORED_KIND_V1]) {
                creation.artifact.kind = kind;
                expect.soft(await verify('/access/grants', grant, 'PUT')).not.toBeNull();
                expect.soft(await verify('')).not.toBeNull();
                expect.soft(await verify('/access/recipients')).not.toBeNull();
                expect.soft(await verify('/access/key-envelopes', commit, 'POST')).not.toBeNull();
            }
            for (const wrong of [{ ...grant, principal: { kind: 'team', teamId: 'another-team' } },
                { ...grant, principal: { kind: 'account', accountId: 'other-account' } },
                { ...grant, accessLevel: 'view' }, { ...grant, artifactId: 'another-artifact' }]) {
                expect.soft(await verify('/access/grants', wrong, 'PUT')).toBeNull();
            }
            expect(await verify('/access/grants', grant, 'DELETE')).toBeNull();
            expect(await verify('/access/grants', grant, 'PUT', 'artifact.access.grants.set')).toBeNull();
            expect(await verify('/access/key-envelopes', { ...commit, artifactId: 'another-artifact' }, 'POST')).toBeNull();
            expect(await verify('/access/key-envelopes', commit, 'PUT')).toBeNull();
            creation.artifact.kind = DEPLOYMENT_RECEIPT_ARTIFACT_STORED_KIND_V1;
            expect(await verify('/access/grants', grant, 'PUT')).toBeNull();
            expect(await verify('/access/recipients')).toBeNull();
            creation.artifact.kind = null;
            creation.artifact.accountId = 'other-account';
            creation.artifact.accountGrants = [{ accountId: 'account', accessLevel: 'admin', account: { status: 'active' } }];
            expect(await verify('/access/grants', grant, 'PUT'), 'admin ACL is not candidate ownership').toBeNull();
            expect(await verify('/access/key-envelopes', commit, 'POST')).toBeNull();
            creation.artifact.accountId = 'account'; creation.artifact.accountGrants = [];
            creation.membershipActive = false;
            expect(await verify('/access/grants', grant, 'PUT')).not.toBeNull();
            expect(await verify('/access/recipients')).not.toBeNull();
            expect(await verify('/access/key-envelopes', commit, 'POST')).not.toBeNull();
            const refused = await mint(actionId, proposal(actionId, projectNativeJsonValueForTransport({
                ...input, requestKey: randomUUID(),
            })));
            expect(refused.statusCode, refused.body).toBe(403);
            expect(refused.json()).toMatchObject({ error: 'credential_scope_denied' });
        } finally {
            rows.enabled = false; rows.sourceReadable = true; rows.source.owner = originalOwner;
            creation.team = null; creation.membershipActive = true; creation.artifact.accountId = 'account';
            creation.artifact.kind = null; creation.artifact.accountGrants = [];
            await app.close();
        }
    });

    it.each(['deployments.environments.create', 'deployments.environments.update'] as const)(
        'admits private definition preparation under %s without granting another mutation', async actionId => {
            storage.state.deploymentRead.enabled = true;
            storage.state.deploymentRead.sourceReadable = true;
            const { app, mint } = createApp('account');
            const serverId = 'srv_proposal_admission';
            const content = { serverId, contentArtifactId: 'candidate', contentHeaderVersion: 1, contentBodyVersion: 1 };
            const input = actionId === 'deployments.environments.create'
                ? { ...content, requestKey: 'create', projectSourceId: 'source', protection: 'nonProduction',
                    purpose: 'standard', deployerMode: 'managers', controllerMachineId: 'machine' }
                : { ...content, environmentId: 'staging', expectedRevision: 1, patch: { buildMachineId: 'machine' } };
            try {
                const minted = await mint(actionId, proposal(actionId, projectNativeJsonValueForTransport(input)));
                expect(minted.statusCode, minted.body).toBe(200);
                const authorization = ExternalActionExecutionAuthorizationV1Schema.parse(minted.json());
                for (const [path, routeInput] of [['/v1/artifacts/candidate', { id: 'candidate' }],
                    ['/v1/account/encryption/currentness', {}]] as const) {
                    expect.soft(Boolean(await verifyExternalActionDomainExecutionRequest(signedRequestProof(authorization,
                        path, undefined, actionId, 'GET', routeInput))), path).toBe(true);
                }
                const readPath = `/v1/deployments/environments/staging?serverId=${serverId}`;
                const readInput = { serverId, environmentId: 'staging' };
                expect(Boolean(await verifyExternalActionDomainExecutionRequest(signedRequestProof(authorization,
                    readPath, undefined, actionId, 'GET', readInput)))).toBe(actionId === 'deployments.environments.update');
                expect(await verifyExternalActionDomainExecutionRequest(signedRequestProof(authorization,
                    '/v1/deployments/environments/staging?serverId=another-home', undefined, actionId, 'GET',
                    { ...readInput, serverId: 'another-home' }))).toBeNull();
                expect(await verifyExternalActionDomainExecutionRequest(signedRequestProof(authorization,
                    '/v1/artifacts', { id: crypto.randomUUID(), header: 'sealed', body: 'sealed', dataEncryptionKey: 'sealed' }))).toBeNull();
                expect(await verifyExternalActionDomainExecutionRequest(signedRequestProof(authorization,
                    '/v1/deployments/environments/staging/targets', input, actionId, 'POST', input))).toBeNull();
            } finally { await app.close(); }
        });
    it.each([
        ['deployments.bindings.set', false, 'plain', 1], ['deployments.environments.update', true, 'plain', 1],
        ['deployments.environments.update', false, 'plain', 1], ['deployments.environments.update', false, 'plain', 2],
        ['deployments.environments.update', false, 'e2ee', 1], ['deployments.environments.update', false, 'e2ee', 2],
    ] as const)(
        'admits binding preparation reads under %s with builder change %s in %s v%s without other writes', async (actionId, buildChanged, mode, version) => {
            storage.state.deploymentRead.enabled = true;
            storage.state.deploymentRead.sourceReadable = true;
        const { app, mint } = createApp('account');
        const previousMode = storage.account.encryptionMode;
        storage.account.encryptionMode = mode;
        if (mode === 'e2ee') Object.assign(storage.state, { metadata: 'encrypted-controller-metadata',
            dataEncryptionKey: sealEncryptedDataKeyEnvelopeV1({ dataKey: new Uint8Array(32).fill(7),
                recipientPublicKey: tweetnacl.box.keyPair().publicKey, randomBytes: tweetnacl.randomBytes }) });
        const serverId = 'srv_proposal_admission';
        const content = { serverId, environmentId: 'staging', expectedRevision: 1,
            contentArtifactId: 'candidate', contentHeaderVersion: 1, contentBodyVersion: 1 };
        const input = actionId === 'deployments.bindings.set'
            ? { ...content, referencedSavedSecretRevisions: [{ resourceId: 'credential', revision: 1 }] }
            : { ...content, patch: buildChanged ? { buildMachineId: 'future-builder' } : {} };
        try {
            const request = proposal(actionId, projectNativeJsonValueForTransport(input));
            const envelope = version === 1 ? request.envelope : { v: 2 as const, requestId: request.envelope.requestId,
                target: request.envelope.target, payload: { t: 'encrypted' as const, c: 'installation-sealed-command' },
                deploymentMetadataEnvironmentId: projectExternalActionDeploymentMetadataEnvironmentIdV1(actionId, input) };
            const installationProof = signMachineInstallationProof({ privateKey: installation.secretKey,
                payload: { version: 1, accountId: 'account', ...request.sessionActionSource, externalActionOrigin: {
                    homeId: 'srv_proposal_admission', actionId, requestId: envelope.requestId,
                    requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope), origin: request.sessionActionOrigin } } });
            const minted = await mint(actionId, { ...request, envelope, installationProof });
            if (mode === 'e2ee' && version === 1) {
                expect(minted.statusCode).toBe(400);
                expect(minted.json()).toMatchObject({ code: 'invalid_envelope' });
                return;
            }
            expect(minted.statusCode, minted.body).toBe(200);
            const authorization = ExternalActionExecutionAuthorizationV1Schema.parse(minted.json());
            expect(authorization.binding.environmentId).toBe('staging');
            const body = { serverId, environmentId: 'staging', targetLinkId: 'runtime', machineId: 'machine',
                installationId: 'installation', materialization: { kind: 'bindings' as const, expectedRevision: 1,
                    ...(buildChanged ? { buildMachineId: 'future-builder' } : {}) } };
            const preparation = { ...body, proof: signMachineInstallationProof({ privateKey: installation.secretKey,
                payload: { version: 1, accountId: 'account', machineId: 'machine', installationId: 'installation',
                    deploymentSecretLaunch: { requestBodyDigest: computeEnvironmentSecretLaunchAdmissionDigestV1(body) } } }) };
            for (const [method, path, value, routeInput] of [
                ['GET', `/v1/deployments/environments/staging?serverId=${serverId}`, undefined, { serverId, environmentId: 'staging' }],
                ['GET', '/v1/artifacts/candidate', undefined, { id: 'candidate' }],
                ['GET', '/v1/account/encryption/currentness', undefined, {}],
                ['POST', '/v1/deployments/environments/staging/secret-launch-admission', preparation, preparation],
            ] as const) {
                expect.soft(Boolean(await verifyExternalActionDomainExecutionRequest(signedRequestProof(authorization,
                    path, value, actionId, method, routeInput))), path).toBe(true);
            }
            const foreignBody = { ...body, environmentId: 'another-environment' };
            if (actionId === 'deployments.bindings.set') {
                expect(Boolean(await verifyExternalActionDomainExecutionRequest(signedRequestProof(authorization,
                    `/v1/deployments/environments/staging?serverId=${serverId}`, undefined,
                    'deployments.environments.get', 'GET', { serverId, environmentId: 'staging' })))).toBe(true);
            }
            const foreignPreparation = { ...foreignBody, proof: signMachineInstallationProof({ privateKey: installation.secretKey,
                payload: { version: 1, accountId: 'account', machineId: 'machine', installationId: 'installation',
                    deploymentSecretLaunch: { requestBodyDigest: computeEnvironmentSecretLaunchAdmissionDigestV1(foreignBody) } } }) };
            expect.soft(Boolean(await verifyExternalActionDomainExecutionRequest(signedRequestProof(authorization,
                `/v1/deployments/environments/another-environment?serverId=${serverId}`, undefined,
                actionId, 'GET', { serverId, environmentId: 'another-environment' })))).toBe(false);
            expect.soft(Boolean(await verifyExternalActionDomainExecutionRequest(signedRequestProof(authorization,
                `/v1/deployments/environments/another-environment?serverId=${serverId}`, undefined,
                'deployments.environments.get', 'GET', { serverId, environmentId: 'another-environment' })))).toBe(false);
            expect(await verifyExternalActionDomainExecutionRequest(signedRequestProof(authorization,
                '/v1/deployments/environments/another-environment/secret-launch-admission', foreignPreparation,
                actionId, 'POST', foreignPreparation))).toBeNull();
            const misplacedPurpose = { ...preparation, materialization: actionId === 'deployments.bindings.set'
                ? { kind: 'bindings', expectedRevision: 1, buildMachineId: 'future-builder' }
                : { kind: 'deployment', deploymentId: 'unrelated-deployment', actionOperationId: crypto.randomUUID() } };
            expect(await verifyExternalActionDomainExecutionRequest(signedRequestProof(authorization,
                '/v1/deployments/environments/staging/secret-launch-admission', misplacedPurpose))).toBeNull();
            if (actionId === 'deployments.environments.update') {
                const preparedUpdate = { ...input, preparedBindings: { grants: [], referencedSavedSecretRevisions: [] } };
                expect(Boolean(await verifyExternalActionDomainExecutionRequest(signedRequestProof(authorization,
                    '/v1/deployments/environments/staging', preparedUpdate, actionId, 'PATCH', preparedUpdate)))).toBe(true);
                expect(await verifyExternalActionDomainExecutionRequest(signedRequestProof(authorization,
                    '/v1/deployments/environments/staging', preparedUpdate, 'deployments.bindings.set', 'PATCH', preparedUpdate))).toBeNull();
            }
            expect(await verifyExternalActionDomainExecutionRequest(signedRequestProof(authorization,
                '/v1/artifacts', { id: crypto.randomUUID(), header: 'sealed', body: 'sealed', dataEncryptionKey: 'sealed' }))).toBeNull();
            expect(await verifyExternalActionDomainExecutionRequest(signedRequestProof(authorization,
                '/v1/deployments/environments/staging/secret-launch-admission', { ...preparation,
                    materialization: { kind: 'review', contentArtifactId: 'candidate' } }))).toBeNull();
        } finally { storage.account.encryptionMode = previousMode; await app.close(); }
    });
    it.each(['deployments.deploy', 'deployments.rollback', 'deployments.promote', 'deployments.teardown', 'machines.services.logs.read'] as const)(
        'admits only current Environment reads prepared by the installed %s owner', async actionId => {
            storage.state.deploymentRead.enabled = true;
            storage.state.deploymentRead.sourceReadable = true;
            const { app, mint } = createApp('account');
            const serverId = 'srv_proposal_admission';
            const deploymentInput = {
                serverId, environmentId: 'staging', expectedRevision: 1, requestKey: 'deploy',
                targetLinkId: 'runtime', expectedTargetLinkRevision: 1,
                contentArtifactId: 'candidate', contentHeaderVersion: 1, contentBodyVersion: 1,
            };
            const input = actionId === 'machines.services.logs.read' ? { serverId, machineId: 'machine', serviceId: 'staging/web' }
                : actionId === 'deployments.rollback' ? { ...deploymentInput, deploymentId: 'prior-receipt' }
                : actionId === 'deployments.promote' ? { ...deploymentInput, sourceEnvironmentId: 'source-environment',
                    sourceDeploymentId: 'source-receipt',
                    artifact: 'image', destinationContent: { contentArtifactId: 'destination-candidate', contentHeaderVersion: 1, contentBodyVersion: 1 } }
                : actionId === 'deployments.teardown' ? { ...deploymentInput, reason: 'manual' } : deploymentInput;
            try {
                const minted = await mint(actionId, proposal(actionId, projectNativeJsonValueForTransport(input)));
                expect(minted.statusCode, minted.body).toBe(200);
                const authorization = ExternalActionExecutionAuthorizationV1Schema.parse(minted.json());
                const path = `/v1/deployments/environments/staging?serverId=${serverId}`;
                if (actionId === 'machines.services.logs.read') {
                    const accessPath = '/v1/deployments/environments/access';
                    const body = { serverId, environmentIds: ['staging', 'another'] };
                    expect(await verifyExternalActionDomainExecutionRequest(signedRequestProof(authorization,
                        accessPath, body, actionId, 'POST', body))).not.toBeNull();
                    for (const [readPath, payload, effect, method, routeInput] of [
                        [accessPath, { ...body, serverId: 'foreign' }, actionId, 'POST', undefined],
                        [accessPath, { ...body, extraAuthority: true }, actionId, 'POST', undefined],
                        [accessPath, body, actionId, 'GET', body],
                        [`${accessPath}?broaden=true`, body, actionId, 'POST', body],
                        [accessPath, body, 'deployments.environments.get', 'POST', body],
                        [accessPath, body, actionId, 'POST', { ...body, environmentIds: ['substituted'] }],
                    ] as const) expect(await verifyExternalActionDomainExecutionRequest(signedRequestProof(authorization,
                        readPath, payload, effect, method, routeInput)), readPath).toBeNull();
                }
                expect(Boolean(await verifyExternalActionDomainExecutionRequest(signedRequestProof(authorization,
                    path, undefined, 'deployments.environments.get', 'GET', { serverId, environmentId: 'staging' })))).toBe(actionId !== 'machines.services.logs.read');
                if (actionId !== 'machines.services.logs.read') {
                    const rows = { kinds: ['workspace-ref'], serverId };
                    const candidateCreate = ArtifactJsonCreateHttpInputV1Schema.parse({
                        id: authorization.binding.deploymentCandidatePublication?.contentArtifactId ?? randomUUID(),
                        kind: DEPLOYMENT_RECEIPT_ARTIFACT_STORED_KIND_V1,
                        header: encodePlainArtifactStoredContent({ title: 'Reviewed receipt' }),
                        body: encodePlainArtifactStoredContent({ body: '{}' }), dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER });
                    const admission = { ...input, actionOperationId: 'deployment-operation' };
                    const transitionBody = { serverId, environmentId: 'staging', deploymentId: 'receipt', expectedRevision: 1,
                        actionOperationId: 'deployment-operation', machineId: 'machine', installationId: 'installation',
                        kind: 'stage' as const, state: 'running' as const };
                    const transition = { ...transitionBody, proof: signMachineInstallationProof({ privateKey: installation.secretKey,
                        payload: { version: 1, accountId: 'account', machineId: 'machine', installationId: 'installation',
                            deploymentTransition: { serverId, environmentId: 'staging', deploymentId: 'receipt',
                                actionOperationId: 'deployment-operation', expectedRevision: 1,
                                requestBodyDigest: computeDeploymentTransitionRequestDigestV1(transitionBody) } } }) };
                    for (const [readPath, body, effect, method, routeInput] of [
                        [`/v1/deployments/receipts/active-receipt?serverId=${serverId}`, undefined, 'deployments.receipts.get', 'GET',
                            { serverId, deploymentId: 'active-receipt' }],
                        ['/v1/artifacts/candidate', undefined, actionId, 'GET', { id: 'candidate' }],
                        ['/v1/account/encryption/currentness', undefined, actionId, 'GET', {}],
                        [`/v1/deployments/environments/staging/${actionId.slice('deployments.'.length)}`, admission, actionId, 'POST', admission],
                    ] as const) {
                        expect.soft(Boolean(await verifyExternalActionDomainExecutionRequest(signedRequestProof(authorization,
                            readPath, body, effect, method, routeInput))), readPath).toBe(true);
                    }
                    for (const [readPath, body, effect, method, routeInput] of [
                        // The registered Source route uses :id, not the Action's sourceId operand.
                        [`/v1/projects/sources/source?serverId=${serverId}`, undefined, 'projects.sources.read', 'GET', { serverId, id: 'source' }],
                        ['/v1/account/project-rows/list', rows, actionId, 'POST', rows],
                    ] as const) {
                        expect.soft(Boolean(await verifyExternalActionDomainExecutionRequest(signedRequestProof(authorization,
                            readPath, body, effect, method, routeInput))), readPath).toBe(actionId !== 'deployments.teardown');
                    }
                    // Every admitted native operation, including teardown, owns its canonical receipt candidate.
                    expect(await verifyExternalActionDomainExecutionRequest(signedRequestProof(authorization,
                        '/v1/artifacts', candidateCreate, actionId, 'POST', candidateCreate))).not.toBeNull();
                    // Native transitions require an accepted receipt, beyond this preparation mint.
                    expect(await verifyExternalActionDomainExecutionRequest(signedRequestProof(authorization,
                        '/v1/deployments/environments/staging/deployments/receipt/transitions', transition, actionId, 'POST', transition))).toBeNull();
                    for (const routeInput of [{ serverId, id: 'different-source' }, { serverId, sourceId: 'source' }]) {
                        expect(await verifyExternalActionDomainExecutionRequest(signedRequestProof(authorization,
                            `/v1/projects/sources/source?serverId=${serverId}`, undefined,
                            'projects.sources.read', 'GET', routeInput))).toBeNull();
                    }
                    expect(await verifyExternalActionDomainExecutionRequest(signedRequestProof(authorization,
                        `/v1/projects/sources/source?serverId=${serverId}&extra=1`, undefined,
                        'projects.sources.read', 'GET', { serverId, id: 'source', extra: '1' }))).toBeNull();
                    const unhintedCandidate = { id: candidateCreate.id, header: candidateCreate.header,
                        body: candidateCreate.body, dataEncryptionKey: candidateCreate.dataEncryptionKey };
                    expect(Boolean(await verifyExternalActionDomainExecutionRequest(signedRequestProof(authorization,
                        '/v1/artifacts', unhintedCandidate)))).toBe(true);
                    expect(Boolean(await verifyExternalActionDomainExecutionRequest(signedRequestProof(authorization,
                        '/v1/artifacts', { ...candidateCreate, id: authorization.binding.deploymentCandidatePublication?.environmentContentArtifactId ?? randomUUID(),
                            kind: DEPLOYMENT_ENVIRONMENT_ARTIFACT_STORED_KIND_V1 }))))
                        .toBe(actionId === 'deployments.promote');
                    expect(await verifyExternalActionDomainExecutionRequest(signedRequestProof(authorization,
                        '/v1/artifacts/candidate', { header: 'replacement' }))).toBeNull();
                    expect(await verifyExternalActionDomainExecutionRequest(signedRequestProof(authorization,
                        '/v1/deployments/environments/staging', deploymentInput, actionId, 'PATCH', deploymentInput))).toBeNull();
                    expect(await verifyExternalActionDomainExecutionRequest(signedRequestProof(authorization,
                        `/v1/deployments/environments/different-environment/${actionId.slice('deployments.'.length)}`,
                        admission, actionId, 'POST', admission))).toBeNull();
                    expect(await verifyExternalActionDomainExecutionRequest(signedRequestProof(authorization,
                        `/v1/deployments/environments/staging/${actionId.slice('deployments.'.length)}`,
                        admission, actionId, 'POST', { ...admission, requestKey: 'substituted-request' }))).toBeNull();
                    const foreignAdmission = { ...admission, serverId: 'different-home' };
                    expect(await verifyExternalActionDomainExecutionRequest(signedRequestProof(authorization,
                        `/v1/deployments/environments/staging/${actionId.slice('deployments.'.length)}`,
                        foreignAdmission, actionId, 'POST', foreignAdmission))).toBeNull();
                    expect(await verifyExternalActionDomainExecutionRequest(signedRequestProof(authorization,
                        '/v1/deployments/environments/staging/deployments/receipt/transitions',
                        { ...transition, installationId: 'different-installation' }))).toBeNull();
                    const mutateRows = { mutations: [], expectedRefs: [], topologyChange: false };
                    expect(await verifyExternalActionDomainExecutionRequest(signedRequestProof(authorization,
                        '/v1/account/project-rows/mutate', mutateRows))).toBeNull();
                    expect(await verifyExternalActionDomainExecutionRequest(signedRequestProof(authorization,
                        '/v1/artifacts', { ...candidateCreate, kind: 'v1:other:note.v1' }))).toBeNull();
                    expect(await verifyExternalActionDomainExecutionRequest(signedRequestProof(authorization,
                        '/v1/artifacts', { ...candidateCreate, approvalState: 'pending' }))).toBeNull();
                    expect(await verifyExternalActionDomainExecutionRequest(signedRequestProof(authorization,
                        '/v1/artifacts/candidate/access/key-envelopes', { envelopes: [] }))).toBeNull();
                }
                expect(await verifyExternalActionDomainExecutionRequest(signedRequestProof(authorization,
                    path, undefined, 'deployments.environments.get', 'POST', { serverId, environmentId: 'staging' }))).toBeNull();
                expect(await verifyExternalActionDomainExecutionRequest(signedRequestProof(authorization,
                    '/v1/deployments/environments', { serverId }, 'deployments.environments.create'))).toBeNull();
                storage.state.bound = false;
                expect(await verifyExternalActionDomainExecutionRequest(signedRequestProof(authorization,
                    path, undefined, 'deployments.environments.get', 'GET', { serverId, environmentId: 'staging' }))).toBeNull();
            } finally { await app.close(); }
        });
    const publicProfileQuery = normalizeUsageQuery({ period: { startMs: 100, endMs: 200 },
        population: 'public_eligible_personal', includeAccounting: true, includeActivity: true,
        activityResolution: 'both', includeSessionEvidence: true, includeWorkEvidence: true,
        includeQuotaHistory: false, includeTranscriptEvidence: false });
    const publicProfileSnapshot = { v: 1 as const, computedAtMs: 200,
        period: { startMs: 100, endMs: 200, timeZoneOffsetMinutes: 0 },
        coverage: { status: 'unknown' as const, method: 'unknown' as const }, fieldCoverage: {}, facts: {} };
    const publicProfileIntent = { policy: DEFAULT_PUBLIC_PROFILE_POLICY_V1, metadataSelection: {},
        query: publicProfileQuery, layout: DEFAULT_PUBLIC_PROFILE_LAYOUT_V1, appearance: DEFAULT_PUBLIC_PROFILE_APPEARANCE_V1 };

    it.each([
        ['account.public_profile.preview', publicProfileIntent],
        ['account.public_profile.publish', { ...publicProfileIntent, intent: 'publish' }],
        ['account.public_profile.resume', {}],
        ['account.public_profile.update', { layout: DEFAULT_PUBLIC_PROFILE_LAYOUT_V1 }],
        ['account.public_profile.refresh', {}],
    ] as const)('admits only the consumed public-profile owner read while preparing %s', async (actionId, input) => {
        const { app, mint } = createApp('account');
        try {
            const minted = await mint(actionId, proposal(actionId, projectNativeJsonValueForTransport(input)));
            expect(minted.statusCode, minted.body).toBe(200);
            const authorization = ExternalActionExecutionAuthorizationV1Schema.parse(minted.json());
            expect(Boolean(await verifyExternalActionDomainExecutionRequest(signedRequestProof(authorization,
                '/v1/account/public-profile', undefined, 'account.public_profile.get', 'GET', {})))).toBe(true);
            for (const request of [
                signedRequestProof(authorization, '/v1/account/public-profile/view', undefined, 'account.public_profile.get', 'GET', {}),
                signedRequestProof(authorization, '/v1/account/public-profile', {}, 'account.public_profile.get', 'POST', {}),
                signedRequestProof(authorization, '/v1/account/profile', undefined, 'account.profile.get', 'GET', {}),
            ]) expect(await verifyExternalActionDomainExecutionRequest(request)).toBeNull();
            storage.state.bound = false;
            expect(await verifyExternalActionDomainExecutionRequest(signedRequestProof(authorization,
                '/v1/account/public-profile', undefined, 'account.public_profile.get', 'GET', {}))).toBeNull();
        } finally { await app.close(); }
    });

    it.each([
        ['account.public_profile.preview', publicProfileIntent, true],
        ['account.public_profile.publish', { ...publicProfileIntent, intent: 'publish' }, true],
        ['account.public_profile.update', { layout: DEFAULT_PUBLIC_PROFILE_LAYOUT_V1 }, true],
        ['account.public_profile.resume', {}, false],
        ['account.public_profile.refresh', {}, false],
    ] as const)('keeps private widget-definition reads under artifact.get within the original %s root', async (actionId, input, allowed) => {
        const { app, mint } = createApp('account');
        try {
            const minted = await mint(actionId, proposal(actionId, projectNativeJsonValueForTransport(input)));
            expect(minted.statusCode, minted.body).toBe(200);
            const authorization = ExternalActionExecutionAuthorizationV1Schema.parse(minted.json());
            const artifactId = 'widget-definition';
            const path = `/v1/artifacts/${encodeURIComponent(artifactId)}`;
            const read = signedRequestProof(authorization, path, undefined, 'artifact.get', 'GET', { id: artifactId });
            const admitted = await verifyExternalActionDomainExecutionRequest(read);
            expect(Boolean(admitted)).toBe(allowed);
            if (allowed) expect(admitted).toMatchObject({ binding: { accountId: 'account', machineId: 'machine' } });
            expect(Boolean(await verifyExternalActionDomainExecutionRequest(signedRequestProof(authorization,
                '/v1/account/encryption/currentness', undefined, 'artifact.get', 'GET', {})))).toBe(allowed);
            for (const request of [
                signedRequestProof(authorization, `${path}?accountId=other-account`, undefined, 'artifact.get', 'GET', { id: artifactId }),
                signedRequestProof(authorization, `${path}/access/grants`, undefined, 'artifact.get', 'GET', { id: artifactId }),
                signedRequestProof(authorization, '/v1/account/encryption', undefined, 'artifact.get', 'GET', {}),
                signedRequestProof(authorization, path, {}, 'artifact.get', 'GET', { id: artifactId }),
                signedRequestProof(authorization, path, undefined, 'artifact.get', 'GET', { id: 'substituted' }),
                signedRequestProof(authorization, path, {}, 'artifact.get', 'PUT', { id: artifactId }),
                signedRequestProof(authorization, `${path}/access/grants`, {}, 'artifact.get', 'PUT', { id: artifactId }),
                signedRequestProof(authorization, `${path}/access/key-envelopes`, {}, 'artifact.get', 'POST', { id: artifactId }),
                signedRequestProof(authorization, path, undefined, actionId, 'GET', { id: artifactId }),
                { ...read, encodedTarget: encodeExternalActionResolvedTargetV1({ kind: 'machine', machineId: 'foreign-machine' }) },
            ]) expect(await verifyExternalActionDomainExecutionRequest(request)).toBeNull();
            storage.account.tokenEpoch = 2;
            expect(await verifyExternalActionDomainExecutionRequest(read)).toBeNull();
            storage.account.tokenEpoch = 1;
            storage.state.bound = false;
            expect(await verifyExternalActionDomainExecutionRequest(read)).toBeNull();
        } finally { await app.close(); }
    });

    it.each([
        ['account.public_profile.preview', publicProfileIntent],
        ['account.public_profile.publish', { ...publicProfileIntent, intent: 'publish' }],
        ['account.public_profile.resume', {}],
        ['account.public_profile.refresh', {}],
    ] as const)('admits only public-eligible Usage preparation for %s', async (actionId, input) => {
        const { app, mint } = createApp('account');
        try {
            const minted = await mint(actionId, proposal(actionId, projectNativeJsonValueForTransport(input)));
            expect(minted.statusCode, minted.body).toBe(200);
            const authorization = ExternalActionExecutionAuthorizationV1Schema.parse(minted.json());
            const body = projectNativeJsonValueForTransport(usageQueryToAnalyticsRequest(publicProfileQuery, 200));
            const comparisonQuery = resolveUsageComparisonQuery(publicProfileQuery);
            expect(comparisonQuery).not.toBeNull();
            const comparisonBody = projectNativeJsonValueForTransport(usageQueryToAnalyticsRequest(comparisonQuery!, 200));
            expect(Boolean(await verifyExternalActionDomainExecutionRequest(
                signedRequestProof(authorization, '/v2/usage/query', body, 'usage.query', 'POST', body)))).toBe(true);
            expect(Boolean(await verifyExternalActionDomainExecutionRequest(
                signedRequestProof(authorization, '/v2/usage/query', comparisonBody, 'usage.query', 'POST', comparisonBody)))).toBe(true);
            for (const path of ['/v1/account/encryption/currentness', '/v2/account/settings', '/v1/account/profile']) {
                expect(Boolean(await verifyExternalActionDomainExecutionRequest(
                    signedRequestProof(authorization, path, undefined, 'usage.query', 'GET', {}))), path).toBe(true);
            }
            const privateBody = projectNativeJsonValueForTransport(usageQueryToAnalyticsRequest(
                normalizeUsageQuery({ ...publicProfileQuery, population: 'all_personal_history' }), 200));
            for (const request of [
                signedRequestProof(authorization, '/v2/usage/query', privateBody, 'usage.query'),
                signedRequestProof(authorization, '/v2/usage/query', body, 'connectedServices.quota.get'),
                signedRequestProof(authorization, '/v2/account/settings', {}, 'usage.query', 'POST'),
                signedRequestProof(authorization, '/v2/usage/query', body, 'usage.query', 'POST', privateBody),
            ]) expect(await verifyExternalActionDomainExecutionRequest(request)).toBeNull();
        } finally { await app.close(); }
    });

    it('admits public-eligible Usage for Update and refuses a separate Refresh effect under its signed root', async () => {
        const { app, mint } = createApp('account');
        try {
            const minted = await mint('account.public_profile.update', proposal('account.public_profile.update',
                projectNativeJsonValueForTransport({ query: publicProfileQuery })));
            expect(minted.statusCode, minted.body).toBe(200);
            const authorization = ExternalActionExecutionAuthorizationV1Schema.parse(minted.json());
            const body = projectNativeJsonValueForTransport(usageQueryToAnalyticsRequest(publicProfileQuery, 200));
            const comparisonQuery = resolveUsageComparisonQuery(publicProfileQuery);
            expect(comparisonQuery).not.toBeNull();
            const comparisonBody = projectNativeJsonValueForTransport(usageQueryToAnalyticsRequest(comparisonQuery!, 200));
            for (const query of [body, comparisonBody]) {
                expect(Boolean(await verifyExternalActionDomainExecutionRequest(signedRequestProof(authorization,
                    '/v2/usage/query', query, 'usage.query', 'POST', query)))).toBe(true);
            }
            const refresh = bindPublicProfilePreparedHttpRequestV1('account.public_profile.refresh', {
                operation: 'refresh', body: { query: publicProfileQuery, snapshot: publicProfileSnapshot },
            });
            expect(Boolean(await verifyExternalActionDomainExecutionRequest(signedRequestProof(authorization,
                refresh.path, refresh.body, 'account.public_profile.refresh', refresh.method, refresh.body)))).toBe(false);
            const privateBody = projectNativeJsonValueForTransport(usageQueryToAnalyticsRequest(
                normalizeUsageQuery({ ...publicProfileQuery, population: 'all_personal_history' }), 200));
            for (const request of [
                signedRequestProof(authorization, '/v2/usage/query', privateBody, 'usage.query', 'POST', privateBody),
                signedRequestProof(authorization, refresh.path, { ...refresh.body as object, confirmed: true },
                    'account.public_profile.refresh', refresh.method),
                signedRequestProof(authorization, '/v1/account/public-profile/publish', refresh.body,
                    'account.public_profile.publish', 'POST', refresh.body),
            ]) expect(await verifyExternalActionDomainExecutionRequest(request)).toBeNull();
        } finally { await app.close(); }
    });

    it.each([
        ['account.public_profile.publish', { operation: 'publish' as const, body: {
            policy: DEFAULT_PUBLIC_PROFILE_POLICY_V1, metadata: {}, projectSelections: [], query: publicProfileQuery,
            snapshot: publicProfileSnapshot, layout: DEFAULT_PUBLIC_PROFILE_LAYOUT_V1, appearance: DEFAULT_PUBLIC_PROFILE_APPEARANCE_V1,
        } }],
        ['account.public_profile.resume', { operation: 'resume' as const,
            body: { query: publicProfileQuery, snapshot: publicProfileSnapshot } }],
        ['account.public_profile.update', { operation: 'update' as const,
            body: { metadata: { bio: 'Reviewed profile' }, projectSelections: [], query: publicProfileQuery, snapshot: publicProfileSnapshot } }],
        ['account.public_profile.refresh', { operation: 'refresh' as const,
            body: { query: publicProfileQuery, snapshot: publicProfileSnapshot } }],
    ] as const)('admits the strict prepared mutation body for %s', async (actionId, prepared) => {
        const { app, mint } = createApp('account');
        const rootInput = actionId === 'account.public_profile.publish' ? { ...publicProfileIntent, intent: 'publish' }
            : actionId === 'account.public_profile.update' ? { metadataSelection: { bio: 'Reviewed profile' } } : {};
        try {
            const minted = await mint(actionId, proposal(actionId, projectNativeJsonValueForTransport(rootInput)));
            expect(minted.statusCode, minted.body).toBe(200);
            const authorization = ExternalActionExecutionAuthorizationV1Schema.parse(minted.json());
            const request = bindPublicProfilePreparedHttpRequestV1(actionId, prepared);
            expect(Boolean(await verifyExternalActionDomainExecutionRequest(signedRequestProof(authorization,
                request.path, request.body, actionId, request.method, request.body)))).toBe(true);
            expect(await verifyExternalActionDomainExecutionRequest(signedRequestProof(authorization,
                request.path, { ...request.body as object, confirmed: true }, actionId, request.method))).toBeNull();
            expect(await verifyExternalActionDomainExecutionRequest(signedRequestProof(authorization,
                '/v1/account/public-profile', request.body, actionId, request.method))).toBeNull();
            expect(await verifyExternalActionDomainExecutionRequest(signedRequestProof(authorization,
                request.path, request.body, actionId, request.method,
                { ...request.body as object, confirmed: true }))).toBeNull();
        } finally { await app.close(); }
    });

    it.each([
        ['account.public_profile.get', {}],
        ['account.public_profile.pause', {}],
        ['account.public_profile.unpublish', {}],
        ['account.public_profile.report.get', { handle: 'ada' }],
        ['account.public_profile.embed.get', { kind: 'profile_link', theme: 'auto', syntax: 'url' }],
    ] as const)('retains the catalog-bound direct transport for %s', async (actionId, input) => {
        const { app, mint } = createApp('account');
        try {
            const minted = await mint(actionId, proposal(actionId, projectNativeJsonValueForTransport(input)));
            expect(minted.statusCode, minted.body).toBe(200);
            const authorization = ExternalActionExecutionAuthorizationV1Schema.parse(minted.json());
            const request = bindHomeDomainActionHttpRequestV1(actionId, input);
            expect(Boolean(await verifyExternalActionDomainExecutionRequest(signedRequestProof(authorization,
                request.path, request.body, actionId, request.method, input)))).toBe(true);
            expect(await verifyExternalActionDomainExecutionRequest(signedRequestProof(authorization,
                `${request.path}/other`, request.body, actionId, request.method, input))).toBeNull();
        } finally { await app.close(); }
    });

    it.each([
        ['settings.get', { anchor: 'appearance.atmosphereSource',
            target: { kind: 'public_profile_draft', serverId: 'home' } }],
        ['settings.set', { anchor: 'appearance.atmosphereSource', value: 'none',
            target: { kind: 'public_profile_draft', serverId: 'home' } }],
        ['widgets.area.layout.list', { surface: { serverId: 'home', accountId: 'account',
            owner: { kind: 'corePage', pageId: 'public-profile', area: 'main', layoutId: 'minimal' } } }],
        ['widgets.area.layout.select', { surface: { serverId: 'home', accountId: 'account',
            owner: { kind: 'corePage', pageId: 'public-profile', area: 'main', layoutId: 'minimal' } } }],
        ['widgets.area.layout.create', { surface: { serverId: 'home', accountId: 'account',
            owner: { kind: 'corePage', pageId: 'public-profile', area: 'main', layoutId: 'minimal' } }, layoutId: 'mine', name: 'Mine' }],
        ['widgets.area.layout.rename', { surface: { serverId: 'home', accountId: 'account',
            owner: { kind: 'corePage', pageId: 'public-profile', area: 'main', layoutId: 'mine' } }, expectedRevision: null, name: 'Renamed' }],
        ['widgets.area.layout.delete', { surface: { serverId: 'home', accountId: 'account',
            owner: { kind: 'corePage', pageId: 'public-profile', area: 'main', layoutId: 'mine' } }, expectedRevision: null }],
        ['widgets.area.layout.reorder', { surface: { serverId: 'home', accountId: 'account',
            owner: { kind: 'corePage', pageId: 'public-profile', area: 'main', layoutId: 'mine' } }, expectedRevision: null,
            position: { anchorId: 'minimal', placement: 'before' } }],
        ['widgets.area.layout.reset', { surface: { serverId: 'home', accountId: 'account',
            owner: { kind: 'corePage', pageId: 'public-profile', area: 'main', layoutId: 'minimal' } }, expectedRevision: null }],
        ['widgets.area.layout.undo', { capture: { surface: { serverId: 'home', accountId: 'account',
            owner: { kind: 'corePage', pageId: 'public-profile', area: 'main', layoutId: 'minimal' } },
            previousLayout: { v: 1, surface: { serverId: 'home', accountId: 'account',
                owner: { kind: 'corePage', pageId: 'public-profile', area: 'main', layoutId: 'minimal' } }, items: [] },
            expectedRevision: { headerVersion: 1, bodyVersion: 1 } } }],
    ] as const)('admits signed client-owned public-profile editing root %s without Account HTTP authority', async (actionId, input) => {
        const { app, mint } = createApp('account');
        try {
            const minted = await mint(actionId, proposal(actionId, projectNativeJsonValueForTransport(input)));
            expect(minted.statusCode, minted.body).toBe(200);
            const authorization = ExternalActionExecutionAuthorizationV1Schema.parse(minted.json());
            expect(Boolean(await verifyProposalCurrentness(authorization))).toBe(true);
            expect(await verifyExternalActionDomainExecutionRequest(signedRequestProof(authorization,
                '/v1/account/public-profile', undefined, actionId, 'GET'))).toBeNull();
        } finally { await app.close(); }
    });

    it.each(['usage.coach.dismiss', 'usage.coach.snooze', 'settings.set', 'settings.reset'] as const)('admits signed Coach KV state only for its dedicated roots and exact Account key (%s)', async actionId => {
        const { app, mint } = createApp('account');
        const query = normalizeUsageQuery({ period: { startMs: 100, endMs: 200 } });
        try {
            const input = actionId === 'settings.set' ? { anchor: 'usage.coachPreferences', value: {} }
                : actionId === 'settings.reset' ? { anchor: 'usage.coachPreferences' }
                : { query, evidenceKey: 'historical', ...(actionId === 'usage.coach.dismiss' ? { dismissed: true } : { untilMs: null }) };
            const minted = await mint(actionId, proposal(actionId, projectNativeJsonValueForTransport(input)));
            expect(minted.statusCode, minted.body).toBe(200);
            const authorization = ExternalActionExecutionAuthorizationV1Schema.parse(minted.json());
            const key = 'workspace:usage-coach:suppressions';
            const verify = (path: string, body: unknown, method = 'GET') => verifyExternalActionDomainExecutionRequest(
                signedRequestProof(authorization, path, body, actionId, method));
            const coachRoot = actionId === 'usage.coach.dismiss' || actionId === 'usage.coach.snooze';
            expect(Boolean(await verify(`/v1/kv/${encodeURIComponent(key)}`, undefined))).toBe(coachRoot);
            expect(Boolean(await verify('/v1/kv', { mutations: [{ key, value: JSON.stringify({ t: 'plain', v: { v: 1, suppressions: [] } }), version: -1 }] }, 'POST'))).toBe(coachRoot);
            expect(Boolean(await verify('/v2/account/settings', undefined))).toBe(coachRoot);
            expect(await verify('/v1/kv/todo.index', undefined)).toBeNull();
            expect(await verify('/v1/kv/workspace%3Atabs%3Av1', undefined)).toBeNull();
            expect(await verify('/v1/kv', { mutations: [{ key: 'workspace:tabs:v1', value: '{}', version: -1 }] }, 'POST')).toBeNull();
            expect(await verify('/v1/kv', { mutations: [{ key: 'todo.index', value: '{}', version: -1 }] }, 'POST')).toBeNull();
            expect(await verify('/v2/account/settings', {}, 'POST')).toBeNull();
        } finally { await app.close(); }
    });

    it('admits signed Usage query reads and their retained quota phase without granting other Account effects', async () => {
        const { app, mint } = createApp('account');
        const query = normalizeUsageQuery({ period: { startMs: 100, endMs: 200 } });
        try {
            const minted = await mint('usage.query', proposal('usage.query', projectNativeJsonValueForTransport({ queries: [query] })));
            expect(minted.statusCode, minted.body).toBe(200);
            const authorization = ExternalActionExecutionAuthorizationV1Schema.parse(minted.json());
            const body = projectNativeJsonValueForTransport(usageQueryToAnalyticsRequest(query, 200));
            const verify = (path: string, value: unknown, effect = 'usage.query', method = 'POST') =>
                verifyExternalActionDomainExecutionRequest(signedRequestProof(authorization, path, value, effect, method));
            expect(Boolean(await verify('/v2/usage/query', body))).toBe(true);
            for (const path of ['/v1/account/encryption/currentness', '/v2/account/settings', '/v1/account/profile']) {
                expect(Boolean(await verify(path, undefined, 'usage.query', 'GET')), path).toBe(true);
            }
            expect(Boolean(await verify('/v1/account/encryption/currentness', undefined, 'connectedServices.quota.get', 'GET'))).toBe(true);
            for (const proof of [
                signedRequestProof(authorization, '/v2/usage-events', body),
                signedRequestProof(authorization, '/v2/usage/query?accountId=other-account', body),
                signedRequestProof(authorization, '/v2/usage/query', body, 'usage.query', 'GET'),
                signedRequestProof(authorization, '/v2/usage/query', projectNativeJsonValueForTransport({
                    ...usageQueryToAnalyticsRequest(query, 200), credential: 'not-a-query-field' })),
                signedRequestProof(authorization, '/v2/account/settings', {}, 'usage.query', 'POST'),
                signedRequestProof(authorization, '/v1/account/profile', undefined, 'account.profile.get', 'GET'),
            ]) expect(await verifyExternalActionDomainExecutionRequest(proof)).toBeNull();
            const otherRoot = await mint('teams.list');
            const other = ExternalActionExecutionAuthorizationV1Schema.parse(otherRoot.json());
            expect(await verifyExternalActionDomainExecutionRequest(
                signedRequestProof(other, '/v2/usage/query', body, 'usage.query'))).toBeNull();
            storage.state.bound = false;
            expect(await verify('/v2/usage/query', body)).toBeNull();
        } finally { await app.close(); }
    });

    it.each(['usage.export', 'usage.calendar.export'] as const)('admits only the consumed private read for %s', async actionId => {
        const { app, mint } = createApp('account');
        const query = normalizeUsageQuery({ period: { startMs: 100, endMs: 200 } });
        const input = actionId === 'usage.export' ? { query, format: 'json', fields: ['totals'] }
            : { query, selectedEvents: [{ kind: 'renewal', account: {
                service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' }, accountId: 'connected-account',
            } }] };
        try {
            const minted = await mint(actionId, proposal(actionId, projectNativeJsonValueForTransport(input)));
            expect(minted.statusCode, minted.body).toBe(200);
            const authorization = ExternalActionExecutionAuthorizationV1Schema.parse(minted.json());
            const effect = actionId === 'usage.export' ? 'usage.query' : 'connectedServices.quota.get';
            const path = actionId === 'usage.export' ? '/v2/usage/query' : '/v1/account/encryption/currentness';
            const body = actionId === 'usage.export' ? projectNativeJsonValueForTransport(usageQueryToAnalyticsRequest(query, 200)) : undefined;
            const method = actionId === 'usage.export' ? 'POST' : 'GET';
            expect(Boolean(await verifyExternalActionDomainExecutionRequest(
                signedRequestProof(authorization, path, body, effect, method)))).toBe(true);
            if (actionId === 'usage.export') expect(Boolean(await verifyExternalActionDomainExecutionRequest(
                signedRequestProof(authorization, '/v1/account/encryption/currentness', undefined,
                    'connectedServices.quota.get', 'GET')))).toBe(true);
            expect(await verifyExternalActionDomainExecutionRequest(
                signedRequestProof(authorization, '/v2/account/settings', {}, effect, 'POST'))).toBeNull();
            if (actionId === 'usage.calendar.export') expect(await verifyExternalActionDomainExecutionRequest(
                signedRequestProof(authorization, '/v2/usage/query', projectNativeJsonValueForTransport(usageQueryToAnalyticsRequest(query, 200)), 'usage.query'))).toBeNull();
        } finally { await app.close(); }
    });

    it.each(['usage.coach.dismiss', 'usage.coach.snooze', 'usage.coach.apply', 'usage.coach.undo',
        'usage.recap.private.compose', 'usage.recap.private.export', 'usage.recap.private.deliver'] as const)('admits private Usage evidence for %s without granting mutation effects', async actionId => {
        const { app, mint } = createApp('account');
        const query = normalizeUsageQuery({ period: { startMs: 100, endMs: 200 } });
        const input = { query, ...(actionId.startsWith('usage.coach.') ? { evidenceKey: 'finding' } : {}),
            ...(actionId === 'usage.recap.private.deliver' ? { intent: 'copy' } : {}),
            ...(actionId === 'usage.coach.dismiss' ? { dismissed: true } : {}),
            ...(actionId === 'usage.coach.snooze' ? { untilMs: 300 } : {}),
            ...(actionId === 'usage.coach.undo' ? { reversal: { kind: 'setting', anchor: 'usage.coachPreferences', appliedValue: {},
                owner: { scope: { serverId: 'home', accountId: 'account' }, beforeVersion: 1, appliedVersion: 2,
                    before: { unset: true }, applied: { value: {} } } } } : {}) };
        try {
            const minted = await mint(actionId, proposal(actionId, projectNativeJsonValueForTransport(input)));
            expect(minted.statusCode, minted.body).toBe(200);
            const authorization = ExternalActionExecutionAuthorizationV1Schema.parse(minted.json());
            const body = projectNativeJsonValueForTransport(usageQueryToAnalyticsRequest(query, 200));
            expect(Boolean(await verifyExternalActionDomainExecutionRequest(
                signedRequestProof(authorization, '/v2/usage/query', body, 'usage.query')))).toBe(true);
            expect(Boolean(await verifyExternalActionDomainExecutionRequest(signedRequestProof(authorization,
                '/v1/account/encryption/currentness', undefined, 'connectedServices.quota.get', 'GET')))).toBe(true);
            expect(await verifyExternalActionDomainExecutionRequest(
                signedRequestProof(authorization, '/v2/account/settings', {}, 'usage.query', 'POST'))).toBeNull();
            expect(await verifyExternalActionDomainExecutionRequest(
                signedRequestProof(authorization, '/v2/account/settings', {}, 'settings.set', 'POST'))).toBeNull();
            storage.state.bound = false;
            expect(await verifyExternalActionDomainExecutionRequest(
                signedRequestProof(authorization, '/v2/usage/query', body, 'usage.query'))).toBeNull();
        } finally { await app.close(); }
    });

    it.each(['usage.recap.compose', 'usage.recap.export', 'usage.recap.deliver'])('binds %s public-source reads to the captured Account without a private-read grant', async actionId => {
        const { app, mint } = createApp('account');
        try {
            const input = { source: { kind: 'public_profile' }, ...(actionId.endsWith('.deliver') ? { intent: 'share' } : {}) };
            const response = await mint(actionId, proposal(actionId, input));
            expect(response.statusCode, response.body).toBe(200);
            const authorization = ExternalActionExecutionAuthorizationV1Schema.parse(response.json());
            const verify = (path: string, effect = actionId, method = 'GET', body?: unknown) =>
                verifyExternalActionDomainExecutionRequest(signedRequestProof(authorization, path, body, effect, method));
            expect(Boolean(await verify('/v1/account/public-profile/view'))).toBe(true);
            for (const path of ['/v1/account/public-profile/view?accountId=other-account', '/v1/account/public-profile', '/v1/usage/query']) {
                expect(await verify(path)).toBeNull();
            }
            expect(await verify('/v1/account/public-profile/view', 'usage.query')).toBeNull();
            expect(await verify('/v2/usage/query', 'usage.query', 'POST', projectNativeJsonValueForTransport(
                usageQueryToAnalyticsRequest(normalizeUsageQuery({ period: { startMs: 100, endMs: 200 } }), 200)))).toBeNull();
            expect(await verify('/v1/account/encryption/currentness', 'connectedServices.quota.get')).toBeNull();
            expect(await verify('/v1/account/public-profile/view', actionId, 'POST', {})).toBeNull();
            storage.state.bound = false;
            expect(await verify('/v1/account/public-profile/view')).toBeNull();
        } finally { await app.close(); }
    });
    beforeAll(async () => {
        // This database boundary implements PostgreSQL transaction control statements.
        vi.stubEnv('HAPPIER_DB_PROVIDER', 'postgres');
        vi.stubEnv('HANDY_MASTER_SECRET', 'proposal-admission-test-secret');
        vi.stubEnv('AUTH_REQUIRED_LOGIN_PROVIDERS', '');
        vi.stubEnv('AUTH_LOGIN_ELIGIBILITY_CACHE_TTL_MS', '0');
        await auth.init();
    });
    afterAll(() => vi.unstubAllEnvs());
    beforeEach(() => {
        storage.account.tokenEpoch = 1;
        storage.otherAccount.tokenEpoch = 1;
        storage.state.bound = true;
        storage.state.publisherBound = true;
        storage.state.revokedAt = null;
        storage.state.publicKey = new Uint8Array(installation.publicKey);
        storage.state.metadata = encodePlainMachineStoredContent({});
        storage.state.dataEncryptionKey = MACHINE_PLAIN_DATA_KEY_MARKER;
        storage.state.accountGrants.splice(0);
        storage.state.operationProtocolCapabilities = {};
        storage.state.operationProtocolCapabilitiesRevision = 0;
        storage.state.sessionOwners.clear();
        storage.state.sessionIds.delete('member-session');
        storage.state.sessionAccessKeyIds.delete('member-session');
        storage.state.creation.team = null;
        storage.state.creation.membershipActive = true;
        storage.state.creation.artifact.accountId = 'account';
        storage.state.creation.artifact.kind = null;
        storage.state.creation.artifact.accountGrants = [];
        storage.state.deploymentRead.enabled = false;
        storage.state.deploymentRead.sourceReadable = true;
        storage.state.deploymentRead.source.owner = { kind: 'account', accountId: 'account' };
    });

    it.each(['account', 'terminal'] as const)('admits only real signed predecessor %s installed-Session proposals', async kind => {
        storage.account.tokenEpoch = 0;
        storage.otherAccount.tokenEpoch = 0;
        // Exact ../0.2 createToken(accountId, extras?) payload and privacy-kit
        // signer: no epoch and no provenance marker are fabricated or upgraded.
        const generator = await privacyKit.createPersistentTokenGenerator({ service: 'handy', seed: 'proposal-admission-test-secret' });
        const token = await generator.new({ user: 'account', ...(kind === 'terminal' ? { extras: { session: 'paired-request' } } : {}) });
        const decoded = JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString('utf8')) as Record<string, unknown>;
        expect(decoded).not.toHaveProperty('tokenEpoch');
        expect(decoded).not.toHaveProperty('provenance');
        expect(await auth.verifyTokenForRoute(token)).toMatchObject({ userId: 'account',
            tokenEpoch: 0, authTokenKind: kind, legacy: true });
        const app = createAuthenticatedTestApp({ authentication: 'real' });
        app.decorate('resolveCurrentSessionMachine', async (input: { accountId: string; sessionId: string }) =>
            storage.state.publisherBound && input.accountId === 'account' && input.sessionId === 'session' ? 'machine' : null);
        const dispatch = vi.fn(async () => { throw new Error('Minting must not execute an Action'); });
        registerExternalActionRoutes(app, { dispatch });
        const actionId = 'teams.list';
        const body = proposal(actionId);
        const signed = (candidate: typeof body, accountId = 'account', homeId = 'srv_proposal_admission') => ({ ...candidate,
            installationProof: signMachineInstallationProof({ privateKey: installation.secretKey,
                payload: { version: 1, accountId, ...candidate.sessionActionSource, externalActionOrigin: {
                    homeId, actionId, requestId: candidate.envelope.requestId,
                    requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(candidate.envelope), origin: candidate.sessionActionOrigin } } }) });
        const mint = (payload: unknown, credential = token) => app.inject({ method: 'POST',
            url: bindExternalActionExecutionAuthorizationHttpPathV1(actionId), headers: { authorization: `Bearer ${credential}` }, payload });
        try {
            const accepted = await mint(body);
            expect(accepted.statusCode, accepted.body).toBe(200);
            const authorization = ExternalActionExecutionAuthorizationV1Schema.parse(accepted.json());
            if (!('authentication' in authorization.binding)) throw new Error('Expected original installed-Session authentication');
            expect(authorization.binding.authentication).toMatchObject({ kind, tokenEpoch: 0 });
            expect(await verifyCurrentExternalActionPrincipal(authorization.binding)).toMatchObject({ authority: 'account_automation' });
            expect(Boolean(await verifyProposalCurrentness(authorization))).toBe(true);
            expect(await verifyExternalActionExecutionAuthorizationCurrentness({
                ...signedRequestProof(authorization,
                    bindExternalActionExecutionAuthorizationVerifyHttpPathV1(actionId), { v: 1 }),
                outerActionId: actionId, machineSignature: '',
            })).toBeNull();
            const approval = ApprovalRequestV2Schema.parse({ v: 2, status: 'open', createdAtMs: 1, updatedAtMs: 1,
                createdBy: { surface: 'agent', sessionId: 'session' }, requestedSurface: 'agent', actionId,
                actionArgs: body.envelope.input, summary: 'Read Teams', executionOriginV1: {
                    v: 1, authority: 'account_automation', surface: 'agent', caller: body.sessionActionOrigin.caller,
                    serverId: 'profile', serverIdentityId: authorization.binding.serverIdentityId, accountId: 'account',
                    sessionId: 'session', machineId: 'machine', actionId, requestId: body.envelope.requestId,
                    callerPermissionMode: null,
                    sessionInputSource: { sourceSessionId: 'session', sourceTurnId: 'turn', via: 'action' },
                    target: body.envelope.target, externalActionExecutionAuthorization: authorization,
                    externalActionInputSignature: signExternalActionApprovalInputV1({ authorizationToken: authorization.token,
                        actionId, input: body.envelope.input, target: body.envelope.target, privateKey: installation.secretKey }),
                } });
            // The authenticated Artifact dependency is the I/O boundary. Home
            // minting, signature codecs and the public Action executor stay real.
            const publicReader = createActionExecutor({ approvalsGet: async () => approval } as unknown as ActionExecutorDeps);
            const observed = await publicReader.execute('approval.request.get', { artifactId: 'minted-approval' }, { surface: 'cli' });
            expect(observed).toMatchObject({ ok: true, result: { request: { actionId, status: 'open' } } });
            expect(JSON.stringify(observed).includes(authorization.token)).toBe(false);
            expect(JSON.stringify(observed)).not.toContain('externalActionInputSignature');
            for (const invalid of [
                { ...body, installationProof: undefined },
                { ...body, sessionActionSource: undefined },
                { ...body, sessionActionOrigin: undefined },
                { ...body, sessionActionOrigin: { ...body.sessionActionOrigin, caller: { ...body.sessionActionOrigin.caller, sessionId: 'foreign-session' } } },
                { ...body, sessionActionSource: { ...body.sessionActionSource, machineId: 'foreign-machine' } },
                { ...body, sessionActionSource: { ...body.sessionActionSource, installationId: 'foreign-installation' } },
                { ...body, sessionActionOrigin: { ...body.sessionActionOrigin, sourceTurnId: 'forged' } },
                { v: 1, machineId: body.machineId, envelope: body.envelope },
            ]) expect((await mint(invalid)).statusCode).toBe(403);
            // Valid installation signatures over wrong tuples still fail the
            // real Session/access/install binding owner, not only the codec.
            for (const invalid of [
                { ...body, sessionActionOrigin: { ...body.sessionActionOrigin, caller: { ...body.sessionActionOrigin.caller, sessionId: 'foreign-session' } } },
                { ...body, sessionActionSource: { ...body.sessionActionSource, machineId: 'foreign-machine' } },
                { ...body, sessionActionSource: { ...body.sessionActionSource, installationId: 'foreign-installation' } },
            ]) expect((await mint(signed(invalid))).statusCode).toBe(403);
            const foreignToken = await generator.new({ user: 'other-account', ...(kind === 'terminal' ? { extras: { session: 'paired-request' } } : {}) });
            expect((await mint(body, foreignToken)).statusCode).toBe(403);
            expect((await mint(signed(body, 'other-account'), foreignToken)).statusCode).toBe(403);
            const tampered = token.split('.');
            tampered[1] = Buffer.from(JSON.stringify({ ...decoded, sub: 'other-account' })).toString('base64url');
            expect((await mint(body, tampered.join('.'))).statusCode).toBe(401);
            expect((await mint(signed(body, 'account', 'srv_other_home'))).statusCode).toBe(403);
            storage.state.bound = false;
            expect((await mint(body)).statusCode).toBe(403);
            storage.state.bound = true;
            storage.state.publisherBound = false;
            expect((await mint(body)).statusCode).toBe(403);
            storage.state.publisherBound = true;
            storage.state.publicKey = tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(30)).publicKey;
            expect((await mint(body)).statusCode).toBe(403);
            storage.state.publicKey = installation.publicKey;
            storage.state.revokedAt = new Date();
            expect((await mint(body)).statusCode).toBe(403);
            expect(await verifyProposalCurrentness(authorization)).toBeNull();
            storage.state.revokedAt = null;
            storage.account.tokenEpoch = 1;
            expect((await mint(body)).statusCode).toBe(401);
            expect(await verifyProposalCurrentness(authorization)).toBeNull();
            expect(dispatch).not.toHaveBeenCalled();
        } finally {
            storage.state.homeId = 'srv_proposal_admission';
            await app.close();
        }
    });

    it.each(['account', 'terminal'] as const)('admits invitation proposals with %s credentials as ordinary host automation', async kind => {
        const { app, mint, dispatch } = createApp(kind);
        try {
            for (const actionId of ['teams.invitations.create', 'teams.invitations.reissue']) {
                const body = proposal(actionId);
                expect(externalActionExecutionAuthorizationRequestSchemaForActionV1(actionId).safeParse(body).success).toBe(true);
                const response = await mint(actionId, body);
                expect(response.statusCode, response.statusCode === 200 ? undefined : response.json().error).toBe(200);
                const authorization = ExternalActionExecutionAuthorizationV1Schema.parse(response.json());
                expect(authorization.binding).toMatchObject({ actionId, sessionActionOrigin: body.sessionActionOrigin,
                    sessionActionSource: body.sessionActionSource, authentication: { kind, tokenEpoch: 1 } });
                expect(await auth.verifyExternalActionExecutionAuthorization(authorization.token)).toEqual(authorization.binding);
                expect(await verifyCurrentExternalActionPrincipal(authorization.binding)).toMatchObject({
                    authority: 'account_automation', sessionActionOrigin: body.sessionActionOrigin });
                expect(Boolean(await verifyProposalCurrentness(authorization))).toBe(true);
                const path = actionId === 'teams.invitations.create'
                    ? '/v1/teams/invitations/create' : '/v1/teams/invitations/reissue';
                expect(await verifyExternalActionDomainExecutionRequest(
                    signedRequestProof(authorization, path, body.envelope.input))).toMatchObject({
                    effectiveAuthority: 'account_automation', principal: { authority: 'account_automation' },
                });
                storage.state.bound = false;
                expect(await verifyCurrentExternalActionPrincipal(authorization.binding)).toBeNull();
                expect(await verifyProposalCurrentness(authorization)).toBeNull();
                storage.state.bound = true;
            }
            expect(dispatch).not.toHaveBeenCalled();
        } finally { await app.close(); }
    });

    it('rejects missing, forged and unbound invitation proposal sources', async () => {
        const { app, mint, dispatch } = createApp('terminal');
        const actionId = 'teams.invitations.create';
        const body = proposal(actionId);
        try {
            for (const invalid of [
                { ...body, installationProof: undefined },
                { ...body, sessionActionSource: undefined },
                { ...body, sessionActionOrigin: { ...body.sessionActionOrigin, sourceTurnId: 'forged' } },
            ]) {
                // Malformed framing is 400; a valid frame with an unproved
                // source is 403. Neither rejects the authenticated credential.
                expect([400, 403]).toContain((await mint(actionId, invalid)).statusCode);
            }
            storage.state.bound = false;
            expect((await mint(actionId, body)).statusCode).toBe(403);
            storage.state.bound = true;
            storage.state.revokedAt = new Date();
            expect((await mint(actionId, body)).statusCode).toBe(403);
            expect(dispatch).not.toHaveBeenCalled();
        } finally { await app.close(); }
    });

    it.each(['account', 'terminal'] as const)('retains Account-placed owner Session reads with %s credentials', async kind => {
        const { app, mint, dispatch } = createApp(kind);
        try {
            const body = proposal('teams.list');
            expect(externalActionExecutionAuthorizationRequestSchemaForActionV1('teams.list').safeParse(body).success).toBe(true);
            expect(verifyMachineInstallationProof({ publicKey: storage.state.publicKey, proof: body.installationProof,
                payload: { version: 1, accountId: 'account', ...body.sessionActionSource, externalActionOrigin: {
                    homeId: 'srv_proposal_admission', actionId: 'teams.list', requestId: body.envelope.requestId,
                    requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(body.envelope), origin: body.sessionActionOrigin } } })).toBe(true);
            expect(await hasCurrentSessionActionRpcSourceBinding({ accountId: 'account', ...body.sessionActionSource,
                sourceSessionId: 'session', resolveCurrentSessionMachine: async () => 'machine' })).toBe(true);
            const response = await mint('teams.list');
            expect(response.statusCode).toBe(200);
            const authorization: ExternalActionExecutionAuthorizationV1 = ExternalActionExecutionAuthorizationV1Schema.parse(response.json());
            expect(await verifyCurrentExternalActionPrincipal(authorization.binding)).toMatchObject({ authority: 'account_automation' });
            const request = bindHomeDomainActionHttpRequestV1('teams.list', body.envelope.input);
            expect(Boolean(await verifyExternalActionDomainExecutionRequest(
                signedRequestProof(authorization, request.path, request.body)))).toBe(true);
            expect(await verifyExternalActionDomainExecutionRequest(
                signedRequestProof(authorization, '/v1/teams/archive', request.body))).toBeNull();
            expect(await verifyExternalActionDomainExecutionRequest(
                signedRequestProof(authorization, request.path, request.body, 'teams.archive'))).toBeNull();
            expect(await verifyExternalActionDomainExecutionRequest(
                signedRequestProof(authorization, request.path, request.body, 'teams.list', 'GET'))).toBeNull();
            expect(dispatch).not.toHaveBeenCalled();
        } finally { await app.close(); }
    });

    it.each(['account', 'terminal'] as const)('admits the installed Session Home runtime read with %s credentials', async kind => {
        const { app, mint } = createApp(kind);
        try {
            const body = proposal('home.runtime.get', { force: true });
            const response = await mint('home.runtime.get', body);
            expect(response.statusCode).toBe(200);
            const authorization = ExternalActionExecutionAuthorizationV1Schema.parse(response.json());
            expect(Boolean(await verifyProposalCurrentness(authorization))).toBe(true);
            storage.state.bound = false;
            expect((await mint('home.runtime.get', body)).statusCode).toBe(403);
        } finally { await app.close(); }
    });

    it('keeps a public self-name creator carrier as authoring provenance without granting the profile effect', async () => {
        const { app, mint, dispatch } = createApp('account');
        try {
            const input = { actionId: 'account.name.set', actionArgs: { name: 'Captain' },
                summary: 'Set my name', createdBy: { surface: 'agent' } };
            const response = await mint('approval.request.create', proposal('approval.request.create', input));
            expect(response.statusCode).toBe(200);
            const authorization = ExternalActionExecutionAuthorizationV1Schema.parse(response.json());
            expect(authorization.binding.actionId).toBe('approval.request.create');
            expect(Boolean(await verifyProposalCurrentness(authorization))).toBe(true);
            expect(await verifyExternalActionDomainExecutionRequest(signedRequestProof(authorization,
                '/v1/account/profile', input.actionArgs, 'account.name.set'))).toBeNull();
            expect(dispatch).not.toHaveBeenCalled();
        } finally { await app.close(); }
    });

    it.each(['approval.request.create', 'memory.remember'] as const)(
        'admits only signed read-only Artifact exposure preparation for %s', async rootActionId => {
            const { app, mint } = createApp('account');
            const artifactId = '11111111-1111-4111-8111-111111111111';
            try {
                const actionArgs = { ref: { kind: 'doc' as const, artifactId },
                    expectedRevision: { headerVersion: 1, bodyVersion: 1 }, text: 'A reviewed memory fact' };
                const response = await mint(rootActionId, proposal(rootActionId, rootActionId === 'memory.remember' ? actionArgs : {
                    actionId: 'memory.remember', actionArgs,
                    summary: 'Remember a fact', createdBy: { surface: 'agent' },
                }));
                expect(response.statusCode).toBe(200);
                const authorization = ExternalActionExecutionAuthorizationV1Schema.parse(response.json());
                const read = (path: string, effectActionId = 'artifact.access.grants.list', method = 'GET', body?: unknown) =>
                    verifyExternalActionDomainExecutionRequest(signedRequestProof(authorization, path, body, effectActionId, method));
                const grants = `/v1/artifacts/${artifactId}/access/grants`;
                const publications = `/v1/public-shares?subjectKind=artifact&subjectId=${artifactId}`;
                expect(await read(grants)).not.toBeNull();
                expect(await read(publications)).not.toBeNull();
                // Exposure inspection opens no content and grants no repair or mutation authority.
                for (const path of [`/v1/artifacts/${artifactId}`, '/v1/account/encryption/currentness',
                    `/v1/artifacts/${artifactId}/access/recipients`, `${grants}?other=1`, `${publications}&other=1`,
                    `${publications}&subjectId=other`, publications.replace('subjectKind=artifact', 'subjectKind=session')]) {
                    expect(await read(path)).toBeNull();
                }
                expect(await read(`/v1/artifacts/${artifactId}`, 'artifact.update', 'POST', {})).toBeNull();
                expect(await read(grants, 'artifact.access.grants.set', 'PUT', {})).toBeNull();
                expect(await read(`/v1/artifacts/${artifactId}/access/key-envelopes`, undefined, 'POST', {})).toBeNull();
                expect(await read(publications, undefined, 'POST', {})).toBeNull();
                storage.state.bound = false;
                expect(await read(grants)).toBeNull();
                expect(await read(publications)).toBeNull();
            } finally { await app.close(); }
        },
    );

    it('authenticates the original receipt-list root only for its schema-bound Home read', async () => {
        storage.state.deploymentRead.enabled = true;
        storage.state.deploymentRead.sourceReadable = true;
        const { app, mint } = createApp('account');
        const domain = fastify().withTypeProvider<ZodTypeProvider>();
        enableAuthentication(domain);
        domain.get('/v1/deployments/environments/:environmentId/deployments', {
            preHandler: domain.authenticate,
            schema: { querystring: { type: 'object', properties: { serverId: { type: 'string' } }, additionalProperties: false } },
        }, async request => ({ accountId: request.userId }));
        const actionId = 'deployments.receipts.list';
        const input = { serverId: storage.state.homeId, environmentId: storage.state.deploymentRead.environment.id };
        try {
            const minted = await mint(actionId, { v: 1, machineId: 'machine', envelope: {
                v: 1, requestId: 'original-account-receipt-read', target: { kind: 'machine', machineId: 'machine' }, input,
            } });
            expect(minted.statusCode, minted.body).toBe(200);
            const authorization = ExternalActionExecutionAuthorizationV1Schema.parse(minted.json());
            const spec = getActionSpec(actionId);
            if (!spec.serverTransport) throw new Error('Expected canonical receipt read transport');
            const { bindHomeDomainHttpRequestV1 } = await import('@happier-dev/protocol/actions/homeDomainHttpBinding');
            const request = bindHomeDomainHttpRequestV1({ transport: spec.serverTransport, inputSchema: spec.inputSchema, input });
            const proof = signedRequestProof(authorization, request.path, request.body, actionId, request.method, input);
            expect(await verifyExternalActionDomainExecutionRequest(proof)).toMatchObject({ binding: { actionId } });
            expect(await verifyExternalActionDomainExecutionRequest(signedRequestProof(authorization,
                `${request.path}&other=1`, request.body, actionId, request.method, input))).toBeNull();
            expect(await verifyExternalActionDomainExecutionRequest(signedRequestProof(authorization,
                request.path, request.body, 'deployments.receipts.get', request.method, input))).toBeNull();
            expect(await verifyProposalCurrentness(authorization)).not.toBeNull();
            // Server tests use the protocol's real signing boundary; the CLI projection
            // is covered in its own package, whose @ alias is intentionally distinct.
            const headers = {
                [EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]: authorization.token,
                [EXTERNAL_ACTION_EFFECT_ACTION_HEADER]: actionId,
                [EXTERNAL_ACTION_RESOLVED_TARGET_HEADER]: proof.encodedTarget,
                [EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER]: proof.machineSignature,
            };
            const accepted = await domain.inject({ method: 'GET', url: request.path, headers });
            expect(accepted.statusCode, accepted.body).toBe(200);
            expect(accepted.json()).toEqual({ accountId: 'account' });
            expect((await domain.inject({ method: 'GET', url: `${request.path}&other=1`, headers })).statusCode).toBe(401);
        } finally { await domain.close(); await app.close(); }
    });

    it('authenticates a declared parameterized GET without admitting another operation or caller query shape', async () => {
        const { app, mint } = createApp('terminal');
        const domain = fastify().withTypeProvider<ZodTypeProvider>();
        domain.decorate('resolveCurrentSessionMachine', async () => 'machine');
        enableAuthentication(domain);
        const path = '/v1/teams/team/directory-sources';
        domain.get('/v1/teams/:teamId/directory-sources', {
            preHandler: domain.authenticate,
            schema: { querystring: { type: 'object', properties: { limit: { type: 'integer' } }, additionalProperties: false } },
        }, async request => ({ accountId: request.userId, authority: request.authAuthority }));
        try {
            const actionId = 'teams.directory.sources.list';
            const minted = await mint(actionId, proposal(actionId, { v: 1, teamId: 'team', limit: 25 }));
            expect(minted.statusCode).toBe(200);
            const authorization = ExternalActionExecutionAuthorizationV1Schema.parse(minted.json());
            const read = (requestPath: string, effectActionId = actionId) => {
                const proof = signedRequestProof(authorization, requestPath, undefined, effectActionId, 'GET');
                return domain.inject({ method: 'GET', url: requestPath, headers: {
                    [EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]: authorization.token,
                    [EXTERNAL_ACTION_EFFECT_ACTION_HEADER]: effectActionId,
                    [EXTERNAL_ACTION_RESOLVED_TARGET_HEADER]: proof.encodedTarget,
                    [EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER]: proof.machineSignature,
                } });
            };
            const accepted = await read(`${path}?limit=25`);
            expect(accepted.statusCode).toBe(200);
            expect(accepted.json()).toEqual({ accountId: 'account', authority: 'account_automation' });
            expect((await read(`${path}?limit=25`, 'teams.archive')).statusCode).toBe(401);
            expect((await read(`${path}?limit=25&view=census`)).statusCode).toBe(401);
        } finally { await domain.close(); await app.close(); }
    });

    it.each(['account', 'terminal'] as const)('admits only the Team export root\'s canonical usage read with %s credentials', async kind => {
        const { app, mint } = createApp(kind);
        const actionId = 'teams.credentials.usage.export';
        const query = { resourceId: 'resource', startMs: 0, endMs: 1000, granularity: 'day', costMode: 'auto' };
        try {
            const minted = await mint(actionId, proposal(actionId, { query }));
            expect(minted.statusCode).toBe(200);
            const authorization = ExternalActionExecutionAuthorizationV1Schema.parse(minted.json());
            const read = bindHomeDomainActionHttpRequestV1('teams.credentials.usage.query', query);
            expect(Boolean(await verifyExternalActionDomainExecutionRequest(
                signedRequestProof(authorization, read.path, read.body, 'teams.credentials.usage.query')))).toBe(true);
            for (const proof of [
                signedRequestProof(authorization, '/v1/teams/archive', read.body, 'teams.credentials.usage.query'),
                signedRequestProof(authorization, read.path, read.body, 'teams.credentials.get'),
                signedRequestProof(authorization, read.path, read.body, 'teams.credentials.usage.query', 'GET'),
                signedRequestProof(authorization, read.path, { ...query, credential: 'not-a-query-field' }, 'teams.credentials.usage.query'),
            ]) expect(await verifyExternalActionDomainExecutionRequest(proof)).toBeNull();
            const otherRoot = await mint('teams.list');
            const other = ExternalActionExecutionAuthorizationV1Schema.parse(otherRoot.json());
            expect(await verifyExternalActionDomainExecutionRequest(
                signedRequestProof(other, read.path, read.body, 'teams.credentials.usage.query'))).toBeNull();
            storage.state.bound = false;
            expect(await verifyExternalActionDomainExecutionRequest(
                signedRequestProof(authorization, read.path, read.body, 'teams.credentials.usage.query'))).toBeNull();
        } finally { await app.close(); }
    });

    it.each(['teams.invitations.create', 'teams.invitations.reissue'] as const)(
        'executes admitted %s once after human approval with safe Agent results', async actionId => {
            const { app, mint } = createApp('terminal');
            const domain = fastify().withTypeProvider<ZodTypeProvider>();
            enableAuthentication(domain);
            try {
                const body = proposal(actionId);
                const minted = await mint(actionId, body);
                expect(minted.statusCode).toBe(200);
                const authorization = ExternalActionExecutionAuthorizationV1Schema.parse(minted.json());
                const principal = await verifyCurrentExternalActionPrincipal(authorization.binding);
                expect(principal?.authority).toBe('account_automation');
                if (!principal || principal.authority !== 'account_automation') throw new Error('Expected the admitted automation principal');
                let stored: ApprovalRequest | null = null;
                const persisted: ApprovalRequest[] = [];
                const invitation = { id: 'invitation', teamId: 'team', state: 'active', role: 'member',
                    historyAccess: 'from_membership', recipientEmailMask: null, expiresAt: 2, createdAt: 1,
                    createdByAccountId: 'account', acceptedByAccountId: null, lastEmailDelivery: null };
                const bearer = 'human-custody-sentinel';
                const output = actionId === 'teams.invitations.create'
                    ? { invitation, joinUrl: `https://home.invalid/join/${bearer}` }
                    : { previous: { ...invitation, state: 'revoked' }, replacement: invitation,
                        joinUrl: `https://home.invalid/join/${bearer}` };
                let effects = 0;
                const sessionDeliveries: unknown[] = [];
                const path = actionId === 'teams.invitations.create'
                    ? '/v1/teams/invitations/create' : '/v1/teams/invitations/reissue';
                domain.post(path, { preHandler: domain.authenticate }, async (request, reply) => {
                    if (request.userId !== 'account' || request.authAuthority !== 'present_user') {
                        return reply.code(403).send({ error: 'present_user_required' });
                    }
                    expect(request.body).toEqual(body.envelope.input);
                    effects += 1;
                    return output;
                });
                const humanCredential = await auth.createToken('account', undefined, {
                    kind: 'account', authority: 'present_user',
                });
                // Signed native host automation reaches the ordinary approval policy;
                // verification never upgrades it to present-user authority.
                expect(await verifyExternalActionDomainExecutionRequest(
                    signedRequestProof(authorization, path, body.envelope.input))).toMatchObject({
                    effectiveAuthority: 'account_automation', principal: { authority: 'account_automation' },
                });
                // Artifact persistence and the Home domain HTTP effect are
                // boundaries; the approval, signature and egress owners are real.
                const deps = {
                    sessionSendMessage: async (args: Parameters<NonNullable<ActionExecutorDeps['sessionSendMessage']>>[0]) => {
                        sessionDeliveries.push(args);
                        expect(args.sessionId).toBe('session');
                        expect(args.context).toMatchObject({ authority: 'account_automation', serverIdentityId: 'srv_proposal_admission' });
                        expect(JSON.stringify(args).includes(bearer)).toBe(false);
                        return { status: 'accepted' as const, localId: args.localId };
                    },
                    homeDomainAction: async (args: Parameters<NonNullable<ActionExecutorDeps['homeDomainAction']>>[0]) => {
                        // Account replay executes the validated proposal as the
                        // deciding person; immutable authoring proof stays on the Artifact.
                        expect(args.context).toMatchObject({ surface: 'ui', authority: 'present_user',
                            actionCaller: { kind: 'host' } });
                        expect(args.context.externalActionExecutionAuthorization).toBeUndefined();
                        expect(args.context.externalActionCredential === undefined).toBe(true);
                        expect(args.context.rpcSessionAuthorization === undefined).toBe(true);
                        const response = await domain.inject({ method: 'POST', url: path,
                            headers: { authorization: `Bearer ${humanCredential}`, 'content-type': 'application/json' },
                            payload: JSON.stringify(args.input) });
                        expect(response.statusCode).toBe(200);
                        return response.json();
                    },
                    approvalsCreate: async ({ request }: { request: ApprovalRequest }) => {
                        stored = ApprovalRequestV2Schema.parse(request); persisted.push(stored);
                        return { artifactId: 'proposal-approval' };
                    },
                    approvalsGet: async () => stored,
                    approvalsUpdate: async ({ request }: { request: ApprovalRequest }) => {
                        if (!stored) throw new Error('Missing approval');
                        const transition = decideApprovalRequestTransition(stored, request);
                        if (!transition.ok) return transition;
                        stored = ApprovalRequestV2Schema.parse(request); persisted.push(stored);
                        return { ok: true as const };
                    },
                    isApprovalExecutionOriginCurrent: async ({ request }: Parameters<NonNullable<ActionExecutorDeps['isApprovalExecutionOriginCurrent']>>[0]) =>
                        request.v === 2 && Boolean(await verifyProposalCurrentness(authorization))
                        && verifyExternalActionApprovalInputV1({ authorizationToken: authorization.token,
                            actionId: request.actionId, input: request.actionArgs, target: authorization.binding.target,
                            signature: request.executionOriginV1.externalActionInputSignature!, publicKey: installation.publicKey }),
                    isActionApprovalRequired: () => true,
                };
                // Unused transport arms are absent from this boundary fixture.
                const executor = createActionExecutor(deps as unknown as ActionExecutorDeps);
                const context = { surface: 'agent' as const, authority: principal?.authority,
                    serverId: 'profile', serverIdentityId: 'srv_proposal_admission', runtimeAccountId: 'account',
                    actionRequestId: body.envelope.requestId, actionCaller: body.sessionActionOrigin.caller,
                    defaultSessionId: 'session', callerPermissionMode: null,
                    sessionInputSource: { sourceSessionId: 'session', sourceTurnId: 'turn', via: 'action' as const },
                    externalActionExecutionAuthorization: authorization, externalActionTarget: body.envelope.target,
                    signExternalActionApprovalInput: (args: Parameters<NonNullable<ActionExecutorContext['signExternalActionApprovalInput']>>[0]) =>
                        signExternalActionApprovalInputV1({ authorizationToken: args.authorization.token,
                            actionId: args.actionId, input: args.input, target: args.target, privateKey: installation.secretKey }),
                };
                const original = await executor.execute(actionId, body.envelope.input, context);
                expect(original).toMatchObject({ ok: true, result: {
                    kind: 'approval_request_created', artifactId: 'proposal-approval',
                } });
                expect(JSON.stringify(original).includes(bearer)).toBe(false);
                expect(effects).toBe(0);
                const request = ApprovalRequestV2Schema.parse(stored);
                expect(request.executionOriginV1.authority).toBe('account_automation');
                expect(request.executionOriginV1.externalActionExecutionAuthorization).toEqual(authorization);
                expect(verifyExternalActionApprovalInputV1({ authorizationToken: authorization.token,
                    actionId, target: body.envelope.target, input: request.actionArgs,
                    signature: request.executionOriginV1.externalActionInputSignature!, publicKey: installation.publicKey })).toBe(true);
                const decide = (authority: 'account_automation' | 'present_user', surface: 'ui' | 'api' = 'ui') => executor.execute(
                    'approval.request.decide', { artifactId: 'proposal-approval', decision: 'approve' },
                    { surface, authority, serverId: 'profile', serverIdentityId: 'srv_proposal_admission', runtimeAccountId: 'account', actionCaller: { kind: 'host' },
                        actionRequestId: `human-${actionId}` });
                // API automation retains the credential decision floor. Native host automation
                // follows the ordinary approval preference rather than a blanket human floor.
                expect(await decide('account_automation', 'api')).toMatchObject({ ok: false, errorCode: 'present_user_required' });
                expect(effects).toBe(0);
                const human = await decide('present_user');
                expect(human.ok, JSON.stringify(human)).toBe(true);
                expect(human, JSON.stringify(human)).toMatchObject({ result: { status: 'executed', liveExecution: { ok: true, result: output } } });
                expect(JSON.stringify(human).includes(bearer)).toBe(true);
                expect(effects).toBe(1);
                const repeated = await decide('present_user');
                expect(repeated.ok).toBe(true);
                expect(effects).toBe(1);
                expect(JSON.stringify(repeated).includes(bearer)).toBe(false);
                const observed = await executor.execute('approval.request.get', { artifactId: 'proposal-approval' },
                    // Status is a new request, not a child effect spending the invitation's signed root.
                    { ...context, surface: 'rpc', actionCaller: { kind: 'host' }, actionRequestId: `${body.envelope.requestId}-status`,
                        externalActionExecutionAuthorization: undefined, externalActionTarget: undefined });
                expect(observed.ok, observed.ok ? undefined : observed.errorCode).toBe(true);
                expect(JSON.stringify(observed).includes(bearer)).toBe(false);
                expect(JSON.stringify(persisted).includes(bearer)).toBe(false);
                expect(sessionDeliveries.length).toBeGreaterThan(0);
            } finally { await domain.close(); await app.close(); }
        },
    );
});
