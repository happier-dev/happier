import Fastify from "fastify";
import type { FastifyRequest } from 'fastify';
import { serializerCompiler, validatorCompiler, type ZodTypeProvider } from "fastify-type-provider-zod";
import tweetnacl from "tweetnacl";
import { decodeBase64 } from 'privacy-kit';
import type { Server, Socket } from "socket.io";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import {
    EXTERNAL_ACTION_EFFECT_ACTION_HEADER,
    EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER,
    EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER,
    EXTERNAL_ACTION_RESOLVED_TARGET_HEADER,
    ExternalActionExecutionAuthorizationV1Schema,
    ExternalActionRequestEnvelopeV1Schema,
    computeExternalActionRequestEnvelopeDigestV1,
    bindExternalActionExecutionAuthorizationHttpPathV1,
    bindExternalActionExecutionAuthorizationVerifyHttpPathV1,
    getActionSpec,
    encodeExternalActionResolvedTargetV1,
    signExternalActionMachineRequestV1,
    signExternalActionMachineRpcRequestV1,
    createExternalActionDaemonDispatchResponseV1,
    prepareExternalActionResponseEnvelopeV1,
    EXTERNAL_ACTION_HTTP_BODY_LIMIT_BYTES_V2,
    type ExternalActionRequestEnvelopeV1,
    type ExternalActionServerPrincipalV1,
} from "@happier-dev/protocol/actions";
import { API_TOKEN_FULL_GRANT_V1, MACHINE_PLAIN_DATA_KEY_MARKER, SESSION_PENDING_ENQUEUE_BY_MACHINE_EVENT_V1, ACCOUNT_API_TOKENS_CREATE_HTTP_PATH_V1, encodePlainMachineStoredContent, encodePasswordCredentialFieldV1, type AccountPasswordCredentialV1 } from "@happier-dev/protocol";
import { SOCKET_RPC_EVENTS, SessionActionRpcOriginV1Schema, WorkspaceSyncSourceContextV1Schema, WorkspaceSyncSourceRoutingV1Schema, WorkspaceSyncSourceWriterTargetRoutingV1Schema } from "@happier-dev/protocol/socketRpc";
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { MachineInstallationProofPayloadV1Schema, signMachineInstallationProof } from '@happier-dev/protocol/machines/identity/installationIdentity';
import { registerMachineAdmissionRoutes } from '@/app/api/routes/machines/registerMachineAdmissionRoutes';
import { SessionRequesterHandoffBootstrapRpcRequestV1Schema } from '@happier-dev/protocol/sessions/creation/sessionRequesterBootstrapV1';
import { HandoffTargetReplacementPreflightV1Schema } from '@happier-dev/protocol/sessions/control/handoff/workspaceSyncSchemas';
import { OpenProjectInputV1Schema } from '@happier-dev/protocol/projects/openProjectV1';
import { sealExternalActionRequestV2, openExternalActionRequestV2 } from '@happier-dev/protocol/actions/externalActionEncryption';
import { sealAccountScopedBlobCiphertext } from '@happier-dev/protocol/crypto/accountScopedCipher';

import { enableAuthentication } from "@/app/api/utils/enableAuthentication";
import { requirePresentUser } from "@/app/api/utils/requirePresentUser";
import { registerAccountEncryptionRoutes } from "@/app/api/routes/account/registerAccountEncryptionRoutes";
import { registerAccountSettingsRoutes } from "@/app/api/routes/account/registerAccountSettingsRoutes";
import { homeGovernanceRoutes } from "@/app/api/routes/home/homeGovernanceRoutes";
import { featuresRoutes } from "@/app/api/routes/features/featuresRoutes";
import { registerSessionListingRoutes } from "@/app/api/routes/session/registerSessionListingRoutes";
import { registerSessionMessageRoutes } from "@/app/api/routes/session/registerSessionMessageRoutes";
import { registerSessionFollowSourceRoutes } from "@/app/api/routes/session/registerSessionFollowSourceRoutes";
import { registerProjectAccountRowRoutes } from '@/app/api/routes/projects/registerProjectAccountRowRoutes';
import { projectSourceRoutes } from '@/app/api/routes/projects/projectSourceRoutes';
import { buildProjectAccountRowPhysicalKeyV1 } from '@happier-dev/protocol/projects/projectAccountRowsV1';
import { hasCurrentSessionScopedMachineAccessInTx } from '@/app/api/socket/sessionScopedBinding';
import { auth } from "@/app/auth/auth";
import { verifyExternalActionMachineRpcExecution, verifyCurrentExternalActionPrincipal } from "@/app/auth/externalActionExecutionAuthorization";
import { qualifyTeamAuthenticationInTx } from "@/app/auth/entry/qualifyTeamAuthentication";
import { db } from "@/storage/db";
import { inTx } from "@/storage/inTx";
import { registerTeamRoutes } from "@/app/teams/registerTeamRoutes";
import { registerAccountApiTokenManagementRoutes } from '@/app/api/routes/auth/registerAccountApiTokenManagementRoutes';
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";
import { applyEnvValues, restoreEnv, snapshotEnv } from '@/testkit/env';
import { encryptString } from '@/modules/encrypt';
import { currentAccountStoredContentCompatibilityHeaders, currentAccountStoredContentCompatibilitySocketAuth,
    qualifyCurrentAccountStoredContentSocket } from "@/app/api/testkit/accountStoredContentCompatibility";
import { createExternalActionDaemonDispatcher, resolveCurrentSessionMachineFromServer } from "@/app/api/socket/externalActionDispatcher";
import { createSessionPublisherPresence } from "@/app/presence/sessionPublisherPresence";
import { getAccountSessionSocketRoom } from "@/app/api/socketRooms";
import { registerSocketRpcHandlers } from '@/app/api/socket/rpc/registerSocketRpcHandlers';
import { machineUpdateHandler } from "@/app/api/socket/machineUpdateHandler";
import { createFakeSocket, getSocketHandler, createSocketRoomDiscoveryHarness } from "@/app/api/testkit/socketHarness";
import { getOrCreateServerIdentityId } from "@/app/serverIdentity/serverIdentity";
import { resolveMachineAccess, resolveMachineAdmission, setMachineAccessGrantInTx, removeMachineAccessGrantInTx } from '@/app/machines/machineAccess';
import { readMachineDevcontainerWorkspaceSyncRouteInTx } from '@/app/machines/managed/managedRows';
import { enqueuePendingMessage, deletePendingMessage } from '@/app/session/pending/pendingMessageService';
import { createPresentUserSessionAccessAuthentication } from '@/app/session/access/sessionAccessAuthentication.testkit';
import { readSessionAccessAuthenticationFromRequest } from '@/app/session/access/sessionAccessAuthentication';
import { admitManagedAcquire } from '@/app/machines/managed/managedAcquire';
import { cancelManagedCreation } from '@/app/machines/managed/managedRead';
import { registerManagedMachineRoutes } from '@/app/machines/managed/managedRoutes';
import { reportManagedAcquire, submitManagedAcquire } from '@/app/machines/managed/managedMutations';
import { createReleaseLessDeclarationV1 } from '@/app/plugins/availability/currentDeclaration';
import { PluginManifestV2Schema } from '@happier-dev/protocol';
import { defineProtocolObject, defineProtocolString } from '@happier-dev/protocol/plugins/actions/protocol-composable-schema';
import { defineMachineProvisionerSchemas, defineMachineProvisionerReconciliationSchemas, MachineProvisionerCheckResultProtocolV1Schema,
    MachineProvisionerBootstrapCarrierV1Schema, MachineProvisionerObservationV1Schema, MachineProvisionerPowerResultV1Schema } from '@happier-dev/protocol/plugins/contributions/machineProvisioners';

import { registerExternalActionRoutes } from "./registerExternalActionRoutes";
import { registerSessionArchiveRoutes } from '@/app/api/routes/session/registerSessionArchiveRoutes';
import { serializeAutomationStoredWorkflowDefinitionRecipeV2 } from '@happier-dev/protocol';
import { encodeAutomationSessionLifecycleConfiguration } from '@/app/automations/automationSessionLifecycleConfigurationCodec';
import { deleteAutomationTrigger } from '@/app/automations/automationCrudService';

const ACTION_ID = "teams.policy.set" as const;
const authorizationRequests = new Map<string, Readonly<{
    target: NonNullable<ExternalActionRequestEnvelopeV1["target"]>;
    installationId: string;
    requestId: string;
}>>();

describe("external Action execution authorization", () => {
    let harness: LightSqliteHarness;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-external-action-execution-authorization-",
            initAuth: true,
            initEncrypt: true,
            env: {
                AUTH_REQUIRED_LOGIN_PROVIDERS: "",
                AUTH_LOGIN_ELIGIBILITY_CACHE_TTL_MS: "0",
                HAPPIER_FEATURE_AUTH_EMAIL_PASSWORD__ENABLED: "true",
                HAPPIER_FEATURE_E2EE__KEYLESS_ACCOUNTS_ENABLED: "true",
                HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "optional",
                HAPPIER_FEATURE_SESSIONS_FILTERED_LISTING__ENABLED: "1",
                HAPPIER_FEATURE_SESSIONS_FOLLOWING__ENABLED: "1",
            },
        });
    }, 300_000);

    afterEach(async () => {
        await db.accountApiToken.deleteMany();
        await db.accessKey.deleteMany();
        await db.automationRun.deleteMany();
        await db.automation.deleteMany();
        await db.projectSource.deleteMany();
        await db.managedMachine.deleteMany();
        await db.pluginMachineMaterialization.deleteMany();
        await db.accountPluginIntent.deleteMany();
        await db.machine.deleteMany();
        await db.teamMembership.deleteMany();
        await db.team.deleteMany();
        await db.sessionMessage.deleteMany();
        await db.session.deleteMany();
        await db.account.deleteMany();
    });

    afterAll(async () => {
        if (harness) await harness.close();
    });

    async function createFixture(input: Readonly<{ qualifiedPat: boolean }>) {
        const account = await db.account.create({
            data: { publicKey: null, encryptionMode: "plain" },
        });
        const passwordCredential: AccountPasswordCredentialV1 = {
            v: 1,
            kind: "plain_password_hash",
            hash: {
                v: 1,
                algorithm: "scrypt",
                parameters: { n: 16_384, r: 8, p: 5, keyLength: 32 },
                salt: encodePasswordCredentialFieldV1(new Uint8Array(16).fill(3)),
                digest: encodePasswordCredentialFieldV1(new Uint8Array(32).fill(5)),
            },
        };
        await db.accountIdentity.create({
            data: {
                accountId: account.id,
                provider: "email",
                providerUserId: `${account.id}@external-action.test`,
                profile: {},
            },
        });
        await db.accountPasswordCredential.create({
            data: { accountId: account.id, credential: passwordCredential },
        });
        const keyPair = tweetnacl.sign.keyPair();
        const machine = await db.machine.create({
            data: {
                id: crypto.randomUUID(),
                accountId: account.id,
                metadata: encodePlainMachineStoredContent({ host: 'controller', platform: 'linux', happyCliVersion: 'test',
                    homeDir: '/home/controller', happyHomeDir: '/home/controller/.happier' }),
                dataEncryptionKey: decodeBase64(MACHINE_PLAIN_DATA_KEY_MARKER, 'base64'),
                metadataVersion: 1,
                daemonState: null,
                daemonStateVersion: 0,
                installationId: crypto.randomUUID(),
                installationPublicKey: new Uint8Array(keyPair.publicKey),
            },
        });
        expect(await resolveMachineAccess({ actorAccountId: account.id, machineId: machine.id }),
            'Auth fixture must be ready under the real persisted Machine-mode owner').toMatchObject({
            owned: true, role: 'manage', encryptionMode: 'plain', accessState: 'ready', installationId: machine.installationId,
        });
        const pat = await auth.createApiToken({
            accountId: account.id,
            tokenId: crypto.randomUUID(),
            label: input.qualifiedPat ? "qualified" : "ordinary",
            ...(input.qualifiedPat
                ? {
                    authenticationEvidence: [{ kind: "home_method" as const, methodId: "email_password" }],
                }
                : {}),
        });
        const team = await db.team.create({
            data: {
                name: "Restricted Team",
                authenticationPolicy: {
                    v: 1,
                    mode: "restricted",
                    accepted: [{ kind: "home_method", methodId: "email_password" }],
                },
            },
        });
        await db.teamMembership.create({
            data: { teamId: team.id, accountId: account.id, role: "owner" },
        });
        const envelope: ExternalActionRequestEnvelopeV1 = {
            v: 1,
            requestId: crypto.randomUUID(),
            target: { kind: "machine", machineId: machine.id },
            input: { teamId: team.id },
        };
        return { account, machine, pat, team, envelope, keyPair };
    }

    async function createApp(teamId: string, semanticWithdraw = false,
        resolveCurrentSessionMachine?: (input: Readonly<{ accountId: string; sessionId: string }>) => Promise<string | null>) {
        const app = Fastify({ logger: false }).withTypeProvider<ZodTypeProvider>() as any;
        app.setValidatorCompiler(validatorCompiler);
        app.setSerializerCompiler(serializerCompiler);
        if (resolveCurrentSessionMachine) app.decorate('resolveCurrentSessionMachine', resolveCurrentSessionMachine);
        enableAuthentication(app);
        const dispatchedPrincipals: ExternalActionServerPrincipalV1[] = [];
        registerExternalActionRoutes(app, {
            dispatch: async request => {
                // The daemon network transport is external; ingress and root projection stay real.
                dispatchedPrincipals.push(request.principal);
                return { kind: "placement_error", code: "target_unavailable" };
            },
        });
        featuresRoutes(app);
        registerAccountEncryptionRoutes(app);
        registerAccountSettingsRoutes(app);
        registerSessionListingRoutes(app);
        registerSessionMessageRoutes(app);
        registerSessionFollowSourceRoutes(app);
        registerSessionArchiveRoutes(app);
        registerProjectAccountRowRoutes(app);
        projectSourceRoutes(app);
        registerMachineAdmissionRoutes(app);
        if (semanticWithdraw) {
            // HTTP authentication is the boundary under test; accepted custody/removal use their real domain owner.
            app.post('/v2/sessions/:sessionId/pending/:localId/withdraw', {
                preHandler: app.authenticate,
                config: { apiTokenSessionAction: 'session.pending.withdraw',
                    requiredExternalActionEffectActionId: 'session.pending.withdraw',
                    restrictedCredentialBinding: { scope: 'session', session: 'params.sessionId' } },
            }, async (request: FastifyRequest<{ Params: { sessionId: string; localId: string } }>) => deletePendingMessage({
                actorUserId: request.userId, authentication: readSessionAccessAuthenticationFromRequest(request),
                sessionId: request.params.sessionId, localId: request.params.localId, withdraw: true,
            }));
        }

        const transport = getActionSpec(ACTION_ID).serverTransport;
        if (!transport) throw new Error("test Action has no server transport");
        app.post(transport.path, { preHandler: app.authenticate, config: { allowApiToken: true } }, async (request: any) => {
            const qualification = await inTx((tx) => qualifyTeamAuthenticationInTx(tx, {
                env: process.env,
                team: {
                    id: teamId,
                    authenticationPolicy: {
                        v: 1,
                        mode: "restricted",
                        accepted: [{ kind: "home_method", methodId: "email_password" }],
                    },
                },
                accountId: request.userId,
                verifiedCredentialEvidence: request.authTokenAuthenticationEvidence,
                operationContext: { kind: request.authAuthority },
            }));
            return {
                qualification: qualification.status,
                principal: request.apiTokenPrincipal,
                rootActionId: request.externalActionRootActionId,
                effectActionId: request.externalActionEffectActionId,
                target: request.externalActionExecutionTarget,
            };
        });
        app.post("/v1/sessions/:sessionId/discussions", { preHandler: app.authenticate }, async () => ({ ok: true }));
        app.post("/test/present-user-only", { preHandler: [app.authenticate, requirePresentUser] }, async () => ({ ok: true }));
        await app.ready();
        return { app, transport, dispatchedPrincipals };
    }

    async function createRealTeamApp() {
        const app = Fastify({ logger: false }).withTypeProvider<ZodTypeProvider>() as any;
        app.setValidatorCompiler(validatorCompiler);
        app.setSerializerCompiler(serializerCompiler);
        enableAuthentication(app);
        registerExternalActionRoutes(app, {
            dispatch: async () => ({ kind: "placement_error", code: "target_unavailable" }),
        });
        registerTeamRoutes(app);
        await app.ready();
        return app;
    }

    async function createRealLane03App() {
        const app = Fastify({ logger: false }).withTypeProvider<ZodTypeProvider>() as any;
        const duplicateExternalActionAdmissionRoutes: string[] = [];
        app.addHook("onRoute", (routeOptions: {
            method: string | readonly string[];
            url: string;
            config?: Readonly<Record<string, unknown>>;
        }) => {
            if (!("allowExternalActionApiTokenForActionIds" in (routeOptions.config ?? {}))) return;
            const methods = Array.isArray(routeOptions.method) ? routeOptions.method : [routeOptions.method];
            for (const method of methods) {
                duplicateExternalActionAdmissionRoutes.push(`${method} ${routeOptions.url}`);
            }
        });
        app.setValidatorCompiler(validatorCompiler);
        app.setSerializerCompiler(serializerCompiler);
        enableAuthentication(app);
        registerExternalActionRoutes(app, {
            dispatch: async () => ({ kind: "placement_error", code: "target_unavailable" }),
        });
        homeGovernanceRoutes(app);
        registerTeamRoutes(app, {
            ...process.env,
            HAPPIER_FEATURE_TEAMS__ENABLED: "1",
        });
        await app.ready();
        return { app, duplicateExternalActionAdmissionRoutes };
    }

    async function mint(
        app: Awaited<ReturnType<typeof createApp>>["app"],
        fixture: Awaited<ReturnType<typeof createFixture>>,
        actionId: string = ACTION_ID,
        envelope: ExternalActionRequestEnvelopeV1 = fixture.envelope,
    ) {
        const response = await app.inject({
            method: "POST",
            url: bindExternalActionExecutionAuthorizationHttpPathV1(actionId),
            headers: { authorization: `Bearer ${fixture.pat.token}` },
            payload: { v: 1, machineId: fixture.machine.id, envelope },
        });
        expect(response.statusCode).toBe(200);
        const authorization = ExternalActionExecutionAuthorizationV1Schema.parse(response.json());
        authorizationRequests.set(authorization.token, {
            target: authorization.binding.target,
            installationId: fixture.machine.installationId!,
            requestId: authorization.binding.requestId,
        });
        return authorization;
    }

    function machineHeaders(input: Readonly<{
        authorizationToken: string;
        method: string;
        path: string;
        body: unknown;
        privateKey: Uint8Array;
        effectActionId?: string;
        target?: ExternalActionRequestEnvelopeV1["target"];
    }>): Record<string, string> {
        const effectActionId = input.effectActionId ?? ACTION_ID;
        const request = authorizationRequests.get(input.authorizationToken);
        const target = input.target ?? request?.target;
        if (!target) throw new Error("test machine request requires a target");
        if (!request) throw new Error("test machine request requires authorization identity");
        return {
            // The production CLI declares its current stored-content reader on every
            // Session request. Without this declaration the server correctly projects
            // the legacy-compatible corpus and omits current metadata-layout rows.
            ...currentAccountStoredContentCompatibilityHeaders,
            [EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]: input.authorizationToken,
            [EXTERNAL_ACTION_EFFECT_ACTION_HEADER]: effectActionId,
            [EXTERNAL_ACTION_RESOLVED_TARGET_HEADER]: encodeExternalActionResolvedTargetV1(target),
            [EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER]: signExternalActionMachineRequestV1({
                ...input,
                effectActionId,
                target,
                installationId: request.installationId,
                requestId: request.requestId,
            }),
        };
    }

    it.each(['settings.list', 'settings.get', 'settings.set', 'settings.invoke'] as const)(
        'admits %s through the exact signed Account ingress and retains its credential authority', async actionId => {
        const fixture = await createFixture({ qualifiedPat: false });
        const token = await auth.createToken(fixture.account.id, undefined, { kind: 'account', authority: 'present_user' });
        const { app, dispatchedPrincipals } = await createApp(fixture.team.id);
        const envelope = { ...fixture.envelope, input: actionId === 'settings.list' ? {}
            : actionId === 'settings.set' ? { anchor: 'workDepthLimit', value: 3 } : { anchor: 'workDepthLimit' } };
        try {
            const response = await app.inject({ method: 'POST', url: bindExternalActionExecutionAuthorizationHttpPathV1(actionId),
                headers: { authorization: `Bearer ${token}` }, payload: { v: 1, machineId: fixture.machine.id, envelope } });
            expect(response.statusCode, response.body).toBe(200);
            const authorization = ExternalActionExecutionAuthorizationV1Schema.parse(response.json());
            expect(await verifyCurrentExternalActionPrincipal(authorization.binding)).toMatchObject({
                accountId: fixture.account.id, authority: 'present_user',
                authentication: { kind: 'account', tokenEpoch: fixture.account.tokenEpoch },
            });
            const relay = await app.inject({ method: 'POST', url: `/v1/actions/${actionId}`,
                headers: { authorization: `Bearer ${token}` }, payload: envelope });
            expect(relay.statusCode, relay.body).toBe(200);
            expect(dispatchedPrincipals).toEqual([expect.objectContaining({
                accountId: fixture.account.id, authority: 'present_user', authentication: { kind: 'account', tokenEpoch: fixture.account.tokenEpoch },
            })]);
            const otherAccount = await db.account.create({ data: { publicKey: null, encryptionMode: 'plain' } });
            const otherToken = await auth.createToken(otherAccount.id, undefined, { kind: 'account', authority: 'present_user' });
            const substituted = await app.inject({ method: 'POST', url: `/v1/actions/${actionId}`,
                headers: { authorization: `Bearer ${otherToken}` },
                payload: { v: 1, machineId: fixture.machine.id, envelope, executionAuthorization: authorization } });
            expect(substituted.statusCode).toBe(401);
            expect(dispatchedPrincipals).toHaveLength(1);
            const terminal = await auth.createToken(fixture.account.id, undefined, { kind: 'terminal', authority: 'account_automation' });
            expect((await app.inject({ method: 'POST', url: `/v1/actions/${actionId}`,
                headers: { authorization: `Bearer ${terminal}` }, payload: envelope })).statusCode).toBe(401);
            await db.account.update({ where: { id: fixture.account.id }, data: { tokenEpoch: { increment: 1 } } });
            expect(await verifyCurrentExternalActionPrincipal(authorization.binding)).toBeNull();
        } finally { await app.close(); }
    });

    it('retains Settings session-agent authority through signed Account issuance and relay', async () => {
        const fixture = await createFixture({ qualifiedPat: false });
        const session = await db.session.create({ data: { accountId: fixture.account.id, tag: crypto.randomUUID(),
            encryptionMode: 'plain', metadata: '{}' } });
        await db.accessKey.create({ data: { accountId: fixture.account.id, machineId: fixture.machine.id,
            sessionId: session.id, data: 'opaque-source-key' } });
        const { app, dispatchedPrincipals } = await createApp(fixture.team.id, false, async () => fixture.machine.id);
        const token = await auth.createToken(fixture.account.id, undefined, { kind: 'account', authority: 'present_user' });
        const actionId = 'settings.set';
        const origin = SessionActionRpcOriginV1Schema.parse({ v: 1,
            caller: { kind: 'session', sessionId: session.id, starterDepth: 1, turnDepth: 2 }, sourceTurnId: 'settings-turn',
            callerPermissionMode: 'default', causalPermissionAuthority: { kind: 'admittedSessionInputV1', admittedPermissionCeiling: 'default' },
            requestId: crypto.randomUUID() });
        const envelope = { ...fixture.envelope, requestId: origin.requestId, input: { anchor: 'workDepthLimit', value: 3 } };
        const source = { machineId: fixture.machine.id, installationId: fixture.machine.installationId! };
        const installationProof = signMachineInstallationProof({ privateKey: fixture.keyPair.secretKey,
            payload: { version: 1, accountId: fixture.account.id, ...source, externalActionOrigin: {
                homeId: await getOrCreateServerIdentityId(), actionId, requestId: origin.requestId,
                requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope), origin } } });
        const payload = { v: 1, machineId: fixture.machine.id, envelope, sessionActionOrigin: origin,
            sessionActionSource: source, installationProof };
        try {
            const response = await app.inject({ method: 'POST', url: bindExternalActionExecutionAuthorizationHttpPathV1(actionId),
                headers: { authorization: `Bearer ${token}` }, payload });
            expect(response.statusCode, response.body).toBe(200);
            const authorization = ExternalActionExecutionAuthorizationV1Schema.parse(response.json());
            expect(await verifyCurrentExternalActionPrincipal(authorization.binding)).toMatchObject({
                accountId: fixture.account.id, authority: 'account_automation', sessionActionOrigin: origin,
            });
            const relay = await app.inject({ method: 'POST', url: `/v1/actions/${actionId}`,
                headers: { authorization: `Bearer ${token}` }, payload });
            expect(relay.statusCode, relay.body).toBe(200);
            expect(dispatchedPrincipals).toEqual([expect.objectContaining({
                accountId: fixture.account.id, authority: 'account_automation', sessionActionOrigin: origin,
            })]);
            const forged = await app.inject({ method: 'POST', url: `/v1/actions/${actionId}`,
                headers: { authorization: `Bearer ${token}` },
                payload: { ...payload, sessionActionOrigin: { ...origin, sourceTurnId: 'forged-turn' } } });
            expect(forged.statusCode).toBe(401);
            expect(dispatchedPrincipals).toHaveLength(1);
        } finally { await app.close(); }
    });

    it.each(['account', 'terminal'] as const)('admits only a signed assigned FIN scope origin with %s provenance and retires its accepted authority on unarchive and clear', async kind => {
        const fixture = await createFixture({ qualifiedPat: true });
        const token = await auth.createToken(fixture.account.id, undefined,
            kind === 'account' ? { kind, authority: 'present_user' } : { kind, authority: 'account_automation' });
        const homeId = await getOrCreateServerIdentityId();
        const session = await db.session.create({ data: { accountId: fixture.account.id, tag: crypto.randomUUID(), encryptionMode: 'plain', metadata: '{}' } });
        const recipe = serializeAutomationStoredWorkflowDefinitionRecipeV2({ v: 2, templateVersion: 1, triggerEvidence: null,
            workflow: { t: 'plain', v: { workspace: { directory: '~' }, executionTarget: { kind: 'detached_run' }, inputs: {},
                inlineDefinition: { version: 1, inputs: [], defaults: {}, blocks: [{ kind: 'action', id: 'managed-scope-end',
                    actionId: 'machines.managed.delete', input: { homeId: { kind: 'literal', value: homeId },
                        managedId: { kind: 'literal', value: 'managed' }, intent: { kind: 'literal', value: 'delete' },
                        when: { kind: 'literal', value: 'after-idle' }, reviewedDependencies: { kind: 'literal', value: true } } }] } } } });
        if (recipe.kind !== 'available') throw new Error('Scope recipe unavailable');
        const automation = await db.automation.create({ data: { accountId: fixture.account.id, name: 'Managed scope', enabled: true,
            targetType: null, scopeSessionId: session.id, templateVersion: 1, templateCiphertext: recipe.serialized } });
        await db.automationAssignment.create({ data: { automationId: automation.id, machineId: fixture.machine.id, enabled: true } });
        const trigger = await db.automationTrigger.create({ data: { automationId: automation.id, revision: 1, enabled: true,
            ...encodeAutomationSessionLifecycleConfiguration({ kind: 'sessionLifecycle', sourceSessionId: session.id,
                events: ['sessionArchived'], policy: { kind: 'everyMatch' } }), kind: 'sessionLifecycle' } });
        const { app, dispatchedPrincipals } = await createApp(fixture.team.id);
        try {
            const archive = (action: 'archive' | 'unarchive') => app.inject({ method: 'POST', url: `/v2/sessions/${session.id}/${action}`,
                headers: { authorization: `Bearer ${token}`, ...currentAccountStoredContentCompatibilityHeaders } });
            expect((await archive('archive')).statusCode).toBe(200);
            const run = await db.automationRun.findFirstOrThrow({ where: { triggerId: trigger.id } });
            await db.automationRun.update({ where: { id: run.id }, data: { state: 'succeeded', workflowCustodyState: 'settled', workflowAcceptedSnapshotEnvelope: '{}' } });
            const actionId = 'machines.managed.delete';
            const envelope: ExternalActionRequestEnvelopeV1 = { v: 1, requestId: 'scope-effect', target: { kind: 'machine', machineId: fixture.machine.id },
                input: { homeId, managedId: 'managed', intent: 'delete', when: 'after-idle', reviewedDependencies: true } };
            const workflowActionOrigin = { runId: run.id, requestId: envelope.requestId! };
            const installationProof = signMachineInstallationProof({ privateKey: fixture.keyPair.secretKey,
                payload: { version: 1, accountId: fixture.account.id, machineId: fixture.machine.id, installationId: fixture.machine.installationId!,
                    externalActionOrigin: { homeId, actionId, requestId: envelope.requestId!,
                        requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope), origin: workflowActionOrigin } } });
            const request = { v: 1, machineId: fixture.machine.id, envelope, workflowActionOrigin, installationProof };
            const mintOrigin = (payload = request) => app.inject({ method: 'POST', url: bindExternalActionExecutionAuthorizationHttpPathV1(actionId),
                headers: { authorization: `Bearer ${token}` }, payload });
            const minted = await mintOrigin();
            expect(minted.statusCode, minted.body).toBe(200);
            const authorization = ExternalActionExecutionAuthorizationV1Schema.parse(minted.json());
            if (!('authentication' in authorization.binding)) throw new Error('Signed credential provenance was not retained');
            expect(authorization.binding.authentication).toMatchObject({ kind, tokenEpoch: fixture.account.tokenEpoch });
            authorizationRequests.set(authorization.token, { target: envelope.target!, installationId: fixture.machine.installationId!, requestId: envelope.requestId! });
            const path = bindExternalActionExecutionAuthorizationVerifyHttpPathV1(actionId);
            const body = { v: 1 };
            const verify = () => app.inject({ method: 'POST', url: path, payload: body,
                headers: machineHeaders({ authorizationToken: authorization.token, effectActionId: actionId, path, method: 'POST', body,
                    privateKey: fixture.keyPair.secretKey }) });
            expect((await verify()).statusCode).toBe(200);
            const relayPath = `/v1/actions/${actionId}`;
            const relayBody = { v: 1, machineId: fixture.machine.id, envelope, executionAuthorization: authorization };
            const relay = await app.inject({ method: 'POST', url: relayPath, payload: relayBody,
                headers: machineHeaders({ authorizationToken: authorization.token, effectActionId: actionId,
                    path: relayPath, method: 'POST', body: relayBody, privateKey: fixture.keyPair.secretKey }) });
            expect(relay.statusCode, relay.body).toBe(200);
            expect(dispatchedPrincipals).toEqual([{ accountId: fixture.account.id, authentication: authorization.binding.authentication,
                authority: 'account_automation', workflowActionOrigin }]);
            expect((await mintOrigin({ ...request, workflowActionOrigin: { ...workflowActionOrigin, runId: 'substituted-run' } })).statusCode).toBe(401);
            const unassignedOrigin = { ...workflowActionOrigin, runId: 'unassigned-run' };
            const unassignedProof = signMachineInstallationProof({ privateKey: fixture.keyPair.secretKey,
                payload: { version: 1, accountId: fixture.account.id, machineId: fixture.machine.id, installationId: fixture.machine.installationId!,
                    externalActionOrigin: { homeId, actionId, requestId: envelope.requestId!,
                        requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope), origin: unassignedOrigin } } });
            expect((await mintOrigin({ ...request, workflowActionOrigin: unassignedOrigin, installationProof: unassignedProof })).statusCode).toBe(401);
            expect((await archive('unarchive')).statusCode).toBe(200);
            expect((await verify()).statusCode).toBe(401);
            expect((await mintOrigin()).statusCode).toBe(401);
            await db.session.update({ where: { id: session.id }, data: { archivedAt: run.causeOccurredAt } });
            expect((await verify()).statusCode).toBe(200);
            await db.account.update({ where: { id: fixture.account.id }, data: { tokenEpoch: { increment: 1 } } });
            expect((await verify()).statusCode).toBe(401);
            // Restore the independent credential fixture to discriminate trigger retirement below.
            await db.account.update({ where: { id: fixture.account.id }, data: { tokenEpoch: fixture.account.tokenEpoch } });
            expect((await verify()).statusCode).toBe(200);
            await deleteAutomationTrigger({ accountId: fixture.account.id, automationId: automation.id, triggerId: trigger.id, expectedRevision: trigger.revision });
            expect((await verify()).statusCode).toBe(401);
        } finally { await app.close(); }
    });

    it.each(['account', 'pat'] as const)('does not let a %s Project Trust list authorization mutate private Project rows', async credential => {
        const fixture = await createFixture({ qualifiedPat: false });
        const token = credential === 'pat' ? fixture.pat.token
            : await auth.createToken(fixture.account.id, undefined, { kind: 'account', authority: 'present_user' });
        const { app } = await createApp(fixture.team.id);
        try {
            const actionId = 'projects.trust.list';
            const envelope = ExternalActionRequestEnvelopeV1Schema.parse({ v: 1, requestId: crypto.randomUUID(),
                target: { kind: 'machine', machineId: fixture.machine.id }, input: {} });
            const minted = await app.inject({ method: 'POST', url: bindExternalActionExecutionAuthorizationHttpPathV1(actionId),
                headers: { authorization: `Bearer ${token}` }, payload: { v: 1, machineId: fixture.machine.id, envelope } });
            expect(minted.statusCode, minted.body).toBe(200);
            const authorization = ExternalActionExecutionAuthorizationV1Schema.parse(minted.json());
            authorizationRequests.set(authorization.token, { target: authorization.binding.target,
                installationId: fixture.machine.installationId!, requestId: authorization.binding.requestId });
            const key = { kind: 'project-organization', serverId: await getOrCreateServerIdentityId(), projectKey: 'read-only-root' } as const;
            const path = '/v1/account/project-rows/mutate';
            const body = { mutations: [{ key, expectedRevision: 'absent', content: { t: 'plain', v: { key, value: { pinned: true } } } }],
                expectedRefs: [], topologyChange: false };
            const response = await app.inject({ method: 'POST', url: path,
                headers: machineHeaders({ authorizationToken: authorization.token, effectActionId: actionId,
                    method: 'POST', path, body, privateKey: fixture.keyPair.secretKey }), payload: body });
            expect(response.statusCode, response.body).toBe(401);
            expect(await db.userKVStore.findUnique({ where: { accountId_key: { accountId: fixture.account.id,
                key: buildProjectAccountRowPhysicalKeyV1(key) } } })).toBeNull();
        } finally { await app.close(); }
    });

    it.each([[1, 'Home'], [2, 'Home'], [1, 'Socket'], [2, 'Socket']] as const)(
        'verifies genuine Project Open v%s SOURCE custody without a Session or changing its D-bound Root through %s', async (version, boundary) => {
        const fixture = await createFixture({ qualifiedPat: false });
        const material = version === 2 ? { type: 'dataKey' as const, machineKey: tweetnacl.randomBytes(32) } : undefined;
        if (version === 2) await db.account.update({ where: { id: fixture.account.id }, data: { encryptionMode: 'e2ee' } });
        const sourceCustodian = await db.account.create({ data: { publicKey: null, encryptionMode: 'plain' } });
        const targetCustodian = await db.account.create({ data: { publicKey: null, encryptionMode: 'plain' } });
        const childKey = tweetnacl.sign.keyPair();
        const writerKey = tweetnacl.sign.keyPair();
        const targetKey = tweetnacl.sign.keyPair();
        const parentKey = tweetnacl.sign.keyPair();
        const createMachine = (accountId: string, key: ReturnType<typeof tweetnacl.sign.keyPair>) => db.machine.create({ data: {
            id: crypto.randomUUID(), accountId, active: true, metadata: fixture.machine.metadata, dataEncryptionKey: fixture.machine.dataEncryptionKey,
            installationId: crypto.randomUUID(), installationPublicKey: new Uint8Array(key.publicKey),
        } });
        const child = await createMachine(sourceCustodian.id, childKey);
        const writer = await createMachine(sourceCustodian.id, writerKey);
        const target = await createMachine(targetCustodian.id, targetKey);
        const parent = await createMachine(targetCustodian.id, parentKey);
        for (const [machine, custodian] of [[child, sourceCustodian], [target, targetCustodian]] as const) await inTx(tx => setMachineAccessGrantInTx(tx, {
            actorAccountId: custodian.id, machineId: machine.id, principal: { kind: 'account', accountId: fixture.account.id }, level: 'view' }));
        const sourceAdmission = await resolveMachineAdmission({ actorAccountId: fixture.account.id, machineId: child.id, requiredRole: 'use' });
        expect(sourceAdmission).toMatchObject({ kind: 'admitted', role: 'use' });
        if (sourceAdmission.kind !== 'admitted') throw new Error('Project SOURCE must be genuinely admitted independently of Root target');
        const { kind: _sourceKind, ...context } = sourceAdmission;
        expect(await resolveMachineAdmission({ actorAccountId: fixture.account.id, machineId: writer.id })).toMatchObject({ kind: 'denied' });
        expect(await resolveMachineAdmission({ actorAccountId: fixture.account.id, machineId: parent.id })).toMatchObject({ kind: 'denied' });
        const homeId = await getOrCreateServerIdentityId();
        const createRow = (machine: typeof child, controller: typeof writer, custodianAccountId: string, childPath: string, hostPath: string) => db.managedMachine.create({ data: {
            homeId, custodianAccountId, controllerMachineId: controller.id, controllerInstallationId: controller.installationId!, enrolledMachineId: machine.id,
            admittedActionRequestId: crypto.randomUUID(), admittedInput: {}, allocation: 'bound', creationState: 'active',
            launch: { provider: { pluginId: 'happier.devcontainer', localId: 'devcontainer' }, schemaVersion: 1, name: 'Project Sync child', choices: {} },
            retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false,
            resource: { contributionRef: { pluginId: 'happier.devcontainer', localId: 'devcontainer' }, schemaVersion: 1, value: {},
                devcontainerObservation: { nativeResourceId: machine.id, user: 'coder', workspaceFolder: childPath,
                    storage: { kind: 'bind', hostPath, childPath } } },
        } });
        const sourceRow = await createRow(child, writer, sourceCustodian.id, '/child/source', '/parent/source');
        await createRow(target, parent, targetCustodian.id, '/child/target', '/parent/target');
        const method = `${writer.id}:${RPC_METHODS.DAEMON_WORKSPACE_SYNC_MATERIALIZE_FOR_OPEN}`;
        // Only the remote daemon network is simulated; no internal verifier or
        // materialization owner is mocked and this test claims no copy effect.
        const delivered = vi.fn(async (_event: string, _request: unknown) => ({ kind: 'materialized' }));
        const receiver = { id: 'project-source-physical-writer', data: { clientType: 'machine-scoped', machineId: writer.id,
            verifiedMachineInstallationId: writer.installationId }, timeout: () => ({ emitWithAck: delivered }) };
        qualifyCurrentAccountStoredContentSocket(receiver);
        const io = createSocketRoomDiscoveryHarness(async room => room === `rpc:${sourceCustodian.id}:${method}`
            || room === receiver.id ? [receiver] : []);
        const { app } = await createApp(fixture.team.id);
        try {
            const token = await auth.createToken(fixture.account.id, undefined, { kind: 'account', authority: 'present_user' });
            const sourceRef = { id: crypto.randomUUID(), serverId: homeId, machineId: child.id, rootPath: '/child/source', createdAtMs: 1 };
            const targetRef = { id: crypto.randomUUID(), serverId: homeId, machineId: target.id, rootPath: '/child/target', createdAtMs: 1 };
            const rowPayloads = [
                { key: { kind: 'workspace-ref' as const, serverId: homeId, id: sourceRef.id }, value: sourceRef },
                { key: { kind: 'workspace-ref' as const, serverId: homeId, id: targetRef.id }, value: targetRef },
                { key: { kind: 'relationship-graph' as const }, value: { relationships: [] } },
            ];
            const rows = await app.inject({ method: 'POST', url: '/v1/account/project-rows/mutate',
                headers: { authorization: `Bearer ${token}`, ...currentAccountStoredContentCompatibilityHeaders },
                payload: { mutations: rowPayloads.map(payload => ({ key: payload.key, expectedRevision: 'absent', content: material
                    ? { t: 'encrypted', c: sealAccountScopedBlobCiphertext({ kind: 'project_account_row', payload, material, randomBytes: tweetnacl.randomBytes }) }
                    : { t: 'plain', v: payload } })), expectedRefs: [], topologyChange: true } });
            expect(rows.statusCode, rows.body).toBe(200);
            expect(rows.json()).toMatchObject({ status: 'updated' });
            const input = OpenProjectInputV1Schema.parse({ serverId: homeId, machineId: target.id,
                source: { kind: 'workspace', workspaceId: sourceRef.id,
                    checkout: { serverId: homeId, workspaceId: sourceRef.id, machineId: child.id, rootPath: sourceRef.rootPath } },
                materialization: { kind: 'sync', targetPath: targetRef.rootPath, workspaceAction: { kind: 'copy_once' } } });
            const requestId = crypto.randomUUID();
            const selectedTarget = { kind: 'machine' as const, machineId: target.id };
            const encryptionBinding = { serverIdentityId: homeId, accountId: fixture.account.id, actionId: 'projects.open', requestId,
                target: selectedTarget, authentication: { kind: 'account' as const, tokenEpoch: fixture.account.tokenEpoch } };
            const originalActionEnvelope = material ? sealExternalActionRequestV2({ binding: encryptionBinding, input, material, randomBytes: tweetnacl.randomBytes })
                : ExternalActionRequestEnvelopeV1Schema.parse({ v: 1, requestId, target: selectedTarget, input });
            const minted = await app.inject({ method: 'POST', url: bindExternalActionExecutionAuthorizationHttpPathV1('projects.open'),
                headers: { authorization: `Bearer ${token}` }, payload: { v: 1, machineId: target.id, envelope: originalActionEnvelope } });
            expect(minted.statusCode, minted.body).toBe(200);
            const root = ExternalActionExecutionAuthorizationV1Schema.parse(minted.json());
            expect(root.binding).toMatchObject({ accountId: fixture.account.id, machineId: target.id,
                installationId: target.installationId, target: selectedTarget,
                requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(originalActionEnvelope) });
            expect(root.binding).not.toHaveProperty('sessionActionOrigin');
            expect(root.binding).not.toHaveProperty('handoffAdmission');
            if (material) {
                // The actual installed-D owner verifies the whole envelope before
                // this canonical V2 open; no plaintext/ciphertext digest substitution.
                expect(openExternalActionRequestV2({ envelope: originalActionEnvelope, binding: encryptionBinding, material })?.input).toEqual(input);
                expect(computeExternalActionRequestEnvelopeDigestV1({ v: 1, requestId, target: selectedTarget, input }))
                    .not.toBe(root.binding.requestEnvelopeDigest);
            }
            const workspaceSyncSourceRouting = { v: 1 as const, phase: 'prepare' as const, operationId: crypto.randomUUID(),
                accountServerId: homeId, sourceMachineId: child.id, sourceRootPath: sourceRef.rootPath,
                sourceContext: { machineAdmission: context, callerAuthority: 'present_user' as const }, originalActionEnvelope };
            expect(workspaceSyncSourceRouting.operationId).not.toBe(root.binding.requestId);
            expect(workspaceSyncSourceRouting).not.toHaveProperty('sourceSessionId');
            const originalTransportRequestId = crypto.randomUUID();
            const signedRequest = { authorizationToken: root.token, effectActionId: 'projects.open', target: root.binding.target,
                installationId: target.installationId!, method, requestId: originalTransportRequestId, params: input,
                workspaceSyncSourceRouting };
            const execution = { v: 1 as const, authorization: root, effectActionId: 'projects.open', target: root.binding.target,
                installationId: target.installationId!,
                machineSignature: signExternalActionMachineRpcRequestV1({ ...signedRequest, privateKey: targetKey.secretKey }) };
            const workspaceSyncSourceExecution = { method, requestId: originalTransportRequestId, params: input,
                externalActionExecution: execution };
            expect(originalTransportRequestId).not.toBe(root.binding.requestId);
            if (boundary === 'Socket') {
                const targetToken = await auth.createToken(targetCustodian.id, undefined, { kind: 'account', authority: 'present_user' });
                const makeSocket = (machine: typeof target, id: string, token: string) => Object.assign(createFakeSocket({ id,
                    data: { clientType: 'machine-scoped', machineId: machine.id, verifiedMachineInstallationId: machine.installationId,
                        authTokenKind: 'account', authAuthority: 'present_user' } }), { handshake: { auth: { token } } });
                const socket = makeSocket(target, 'actual-installed-project-target', targetToken);
                qualifyCurrentAccountStoredContentSocket(socket);
                registerSocketRpcHandlers({ userId: targetCustodian.id, socket: socket as unknown as Socket, io });
                const callback = vi.fn();
                const call = (selectedSocket = socket, externalActionExecution = execution, routing = workspaceSyncSourceRouting) =>
                    getSocketHandler(selectedSocket, SOCKET_RPC_EVENTS.CALL)({ method, requestId: originalTransportRequestId,
                        params: input, externalActionExecution, workspaceSyncSourceRouting: routing }, callback);
                await call();
                expect(callback).toHaveBeenCalledWith({ ok: true, result: { kind: 'materialized' } });
                expect(delivered.mock.calls[0]?.[1]).toMatchObject({ machineAdmission: context, callerAuthority: 'present_user',
                    callerInputAuthorization: root, workspaceSyncSourceRouting, workspaceSyncSourceExecution });
                const forwarded = delivered.mock.calls[0]?.[1];
                expect(forwarded).toHaveProperty('requestId');
                if (!forwarded || typeof forwarded !== 'object' || !('requestId' in forwarded)) throw new Error('Relay request correlation required');
                expect(forwarded.requestId).not.toBe(originalTransportRequestId);
                callback.mockClear();
                await call(socket, { ...execution, machineSignature: signExternalActionMachineRpcRequestV1({ ...signedRequest, privateKey: childKey.secretKey }) });
                expect(callback).toHaveBeenCalledWith(expect.objectContaining({ ok: false }));
                callback.mockClear();
                await call(socket, execution, { ...workspaceSyncSourceRouting, sourceRootPath: '/child/unreviewed' });
                expect(callback).toHaveBeenCalledWith(expect.objectContaining({ ok: false }));
                const writerToken = await auth.createToken(sourceCustodian.id, undefined, { kind: 'account', authority: 'present_user' });
                const writerSocket = makeSocket(writer, 'writer-cannot-claim-target-decryption', writerToken);
                qualifyCurrentAccountStoredContentSocket(writerSocket);
                registerSocketRpcHandlers({ userId: sourceCustodian.id, socket: writerSocket as unknown as Socket, io });
                callback.mockClear();
                await call(writerSocket);
                expect(callback).toHaveBeenCalledWith(expect.objectContaining({ ok: false }));
                socket.data!.clientType = 'user-scoped';
                callback.mockClear();
                await call();
                expect(callback).toHaveBeenCalledWith(expect.objectContaining({ ok: false }));
                expect(delivered).toHaveBeenCalledTimes(1);
                return;
            }
            const writerToken = await auth.createToken(sourceCustodian.id, undefined, { kind: 'account', authority: 'present_user' });
            // Independent Home input: the existing public signer and real D
            // installation create this packet. Socket capture is proved above,
            // not inferred from this boundary fixture.
            const verify = (routing = workspaceSyncSourceRouting, authorization = root, privateKey = writerKey.secretKey,
                sourceExecution = workspaceSyncSourceExecution) => {
                const rpcAdmission = { context, method, workspaceSyncSourceRouting: routing, callerInputAuthorization: authorization,
                    workspaceSyncSourceExecution: sourceExecution };
                const payload = MachineInstallationProofPayloadV1Schema.parse({ version: 1, machineId: writer.id,
                    installationId: writer.installationId!, accountId: sourceCustodian.id, rpcAdmission });
                return app.inject({ method: 'POST', url: `/v1/machines/${writer.id}/admission/verify`,
                    headers: { authorization: `Bearer ${writerToken}`, ...currentAccountStoredContentCompatibilityHeaders },
                    payload: { v: 1, ...rpcAdmission, proof: signMachineInstallationProof({ payload, privateKey }) } });
            };
            const verified = await verify();
            expect(verified.statusCode, verified.body).toBe(200);
            expect(verified.json()).toEqual({ v: 1, ok: true });
            expect((await verify(workspaceSyncSourceRouting, root, targetKey.secretKey)).statusCode).toBe(403);
            expect((await verify({ ...workspaceSyncSourceRouting, sourceRootPath: '/child/other' })).statusCode).toBe(403);
            expect((await verify(workspaceSyncSourceRouting, { ...root, token: 'not-a-home-issued-root' })).statusCode).toBe(403);
            expect((await verify(workspaceSyncSourceRouting, root, writerKey.secretKey, { ...workspaceSyncSourceExecution,
                requestId: root.binding.requestId })).statusCode).toBe(403);
            expect((await verify(workspaceSyncSourceRouting, root, writerKey.secretKey, { ...workspaceSyncSourceExecution,
                externalActionExecution: { ...execution, machineSignature: signExternalActionMachineRpcRequestV1({ ...signedRequest, privateKey: childKey.secretKey }) } })).statusCode).toBe(403);
            expect((await verify({ ...workspaceSyncSourceRouting, sourceContext: { ...workspaceSyncSourceRouting.sourceContext,
                machineAdmission: { ...context, role: 'manage' } } })).statusCode).toBe(403);
            await db.managedMachine.update({ where: { id: sourceRow.id }, data: { resource: {
                contributionRef: { pluginId: 'happier.devcontainer', localId: 'devcontainer' }, schemaVersion: 1, value: {} } } });
            expect((await verify()).statusCode).toBe(403);
            await db.managedMachine.update({ where: { id: sourceRow.id }, data: { resource: {
                contributionRef: { pluginId: 'happier.devcontainer', localId: 'devcontainer' }, schemaVersion: 1, value: {},
                devcontainerObservation: { nativeResourceId: child.id, user: 'coder', workspaceFolder: '/child/source',
                    storage: { kind: 'bind', hostPath: '/parent/source', childPath: '/child/source' } } } } });
            await inTx(tx => removeMachineAccessGrantInTx(tx, { actorAccountId: sourceCustodian.id, machineId: child.id,
                principal: { kind: 'account', accountId: fixture.account.id } }));
            expect((await verify()).statusCode).toBe(403);
            await inTx(tx => setMachineAccessGrantInTx(tx, { actorAccountId: sourceCustodian.id, machineId: child.id,
                principal: { kind: 'account', accountId: fixture.account.id }, level: 'view' }));
            await db.machine.update({ where: { id: target.id }, data: { installationId: crypto.randomUUID() } });
            expect((await verify()).statusCode).toBe(403);
        } finally { await app.close(); }
    });

    it.each(['projects.open', 'projects.trust.list'] as const)('permits only the original projects.open purpose to read a Source with %s', async actionId => {
        const fixture = await createFixture({ qualifiedPat: false });
        const custodian = await db.account.create({ data: { publicKey: null, encryptionMode: 'plain' } });
        const source = await db.projectSource.create({ data: { id: crypto.randomUUID(), name: 'Requester Source', revision: 1,
            createdByAccountId: fixture.account.id, audience: [], attachments: [], repository: {
                provider: { id: 'github', kind: 'github', displayName: 'GitHub', baseUrl: 'https://github.com' },
                repository: { nameWithOwner: 'requester/project', cloneUrl: 'https://github.com/requester/project.git', visibility: 'private' },
                protocol: 'https' } } });
        const { app } = await createApp(fixture.team.id);
        try {
            const token = await auth.createToken(fixture.account.id, undefined, { kind: 'account', authority: 'present_user' });
            const envelope = ExternalActionRequestEnvelopeV1Schema.parse({ v: 1, requestId: crypto.randomUUID(),
                target: { kind: 'machine', machineId: fixture.machine.id }, input: { source: { kind: 'source', sourceId: source.id } } });
            const minted = await app.inject({ method: 'POST', url: bindExternalActionExecutionAuthorizationHttpPathV1(actionId),
                headers: { authorization: `Bearer ${token}` }, payload: { v: 1, machineId: fixture.machine.id, envelope } });
            expect(minted.statusCode, minted.body).toBe(200);
            const authorization = ExternalActionExecutionAuthorizationV1Schema.parse(minted.json());
            authorizationRequests.set(authorization.token, { target: authorization.binding.target,
                installationId: fixture.machine.installationId!, requestId: authorization.binding.requestId });
            const homeId = await getOrCreateServerIdentityId();
            const path = `/v1/projects/sources/${encodeURIComponent(source.id)}?serverId=${encodeURIComponent(homeId)}`;
            const read = await app.inject({ method: 'GET', url: path, headers: machineHeaders({ authorizationToken: authorization.token,
                effectActionId: actionId, method: 'GET', path, body: undefined, privateKey: fixture.keyPair.secretKey }) });
            expect(read.statusCode, read.body).toBe(actionId === 'projects.open' ? 200 : 401);
            if (actionId === 'projects.open') {
                expect(read.json()).toMatchObject({ ok: true, source: { id: source.id, createdByAccountId: fixture.account.id }, canManage: true });
                // Source visibility still belongs to the original requester, never the installed custodian.
                await db.projectSource.update({ where: { id: source.id }, data: { createdByAccountId: custodian.id } });
                const hidden = await app.inject({ method: 'GET', url: path, headers: machineHeaders({ authorizationToken: authorization.token,
                    effectActionId: actionId, method: 'GET', path, body: undefined, privateKey: fixture.keyPair.secretKey }) });
                expect(hidden.statusCode, hidden.body).toBe(404);
                const mutationPath = `/v1/projects/sources/${encodeURIComponent(source.id)}`;
                const body = { serverId: homeId, sourceId: source.id, expectedRevision: 1, patch: { name: 'Must not mutate' } };
                const mutation = await app.inject({ method: 'PATCH', url: mutationPath, payload: body,
                    headers: machineHeaders({ authorizationToken: authorization.token, effectActionId: actionId,
                        method: 'PATCH', path: mutationPath, body, privateKey: fixture.keyPair.secretKey }) });
                expect(mutation.statusCode, mutation.body).toBe(401);
                expect((await db.projectSource.findUniqueOrThrow({ where: { id: source.id } })).name).toBe('Requester Source');
            }
        } finally { await app.close(); }
    });

    it.each(['grant', 'installation', 'epoch', 'publisher-during-eligibility'] as const)('refuses a Project mutation after final awaited %s loss', async loss => {
        const envBefore = snapshotEnv();
        let restoreFetch: (() => void) | undefined;
        const fixture = await createFixture({ qualifiedPat: false });
        const custodian = await db.account.create({ data: { publicKey: null, encryptionMode: 'plain' } });
        const destinationKey = tweetnacl.sign.keyPair();
        const destination = await db.machine.create({ data: { id: crypto.randomUUID(), accountId: custodian.id,
            metadata: fixture.machine.metadata, dataEncryptionKey: fixture.machine.dataEncryptionKey,
            installationId: crypto.randomUUID(), installationPublicKey: new Uint8Array(destinationKey.publicKey) } });
        await inTx(tx => setMachineAccessGrantInTx(tx, { actorAccountId: custodian.id, machineId: destination.id,
            principal: { kind: 'account', accountId: fixture.account.id }, level: 'view' }));
        const fence = new Date();
        const session = await db.session.create({ data: { accountId: fixture.account.id, tag: crypto.randomUUID(),
            metadata: '{}', encryptionMode: 'plain', active: true, lastActiveAt: fence } });
        await db.accessKey.create({ data: { accountId: fixture.account.id, machineId: fixture.machine.id,
            sessionId: session.id, data: 'opaque-source-key' } });
        const presence = createSessionPublisherPresence();
        const publisher = { data: {} };
        expect((await presence.registerPublisher({ socket: publisher,
            binding: { accountId: fixture.account.id, machineId: fixture.machine.id, sessionId: session.id },
            completeActivitySnapshot: { state: 'active', activeCount: 1 } })).status).toBe('registered');
        let discoveryReads = 0;
        let retireOnFinalRead = false;
        let publisherVisible = true;
        let eligibilityRead = false;
        // Socket discovery alone is external; source binding and destination admission use real SQLite owners.
        const io = { in: (room: string) => ({ fetchSockets: async () => {
            if (retireOnFinalRead && ++discoveryReads === 2 && loss !== 'publisher-during-eligibility') {
                if (loss === 'grant') await inTx(tx => removeMachineAccessGrantInTx(tx, { actorAccountId: custodian.id,
                    machineId: destination.id, principal: { kind: 'account', accountId: fixture.account.id } }));
                else if (loss === 'epoch') await db.account.update({ where: { id: fixture.account.id }, data: { tokenEpoch: { increment: 1 } } });
                else await db.machine.update({ where: { id: destination.id }, data: { installationId: 'replacement-installation' } });
            }
            return publisherVisible && room === getAccountSessionSocketRoom(fixture.account.id, session.id) ? [publisher] : [];
        } }) } as unknown as Server;
        const resolvePublisher = (input: Readonly<{ accountId: string; sessionId: string }>) => resolveCurrentSessionMachineFromServer({ io, presence, ...input });
        const { app } = await createApp(fixture.team.id, false, resolvePublisher);
        const token = await auth.createToken(fixture.account.id, undefined, { kind: 'account', authority: 'present_user' });
        const homeId = await getOrCreateServerIdentityId();
        const origin = SessionActionRpcOriginV1Schema.parse({ v: 1,
            caller: { kind: 'session', sessionId: session.id, starterDepth: 0, turnDepth: 0 }, sourceTurnId: 'source-turn',
            callerPermissionMode: 'yolo', causalPermissionAuthority: null, requestId: crypto.randomUUID() });
        const actionId = 'projects.open';
        const envelope = ExternalActionRequestEnvelopeV1Schema.parse({ v: 1, requestId: origin.requestId,
            target: { kind: 'machine', machineId: destination.id }, input: { serverId: homeId, machineId: destination.id,
                source: { kind: 'folder', path: '/workspace/project' }, materialization: { kind: 'attach' } } });
        const source = { machineId: fixture.machine.id, installationId: fixture.machine.installationId! };
        const installationProof = signMachineInstallationProof({ privateKey: fixture.keyPair.secretKey,
            payload: { version: 1, accountId: fixture.account.id, ...source, externalActionOrigin: { homeId, actionId,
                requestId: origin.requestId, requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope), origin } } });
        try {
            const minted = await app.inject({ method: 'POST', url: bindExternalActionExecutionAuthorizationHttpPathV1(actionId),
                headers: { authorization: `Bearer ${token}` }, payload: { v: 1, machineId: destination.id, envelope,
                    sessionActionOrigin: origin, sessionActionSource: source, installationProof } });
            expect(minted.statusCode, minted.body).toBe(200);
            const authorization = ExternalActionExecutionAuthorizationV1Schema.parse(minted.json());
            authorizationRequests.set(authorization.token, { target: authorization.binding.target,
                installationId: destination.installationId!, requestId: authorization.binding.requestId });
            const key = { kind: 'project-organization', serverId: homeId, projectKey: 'destination-currentness' } as const;
            const path = '/v1/account/project-rows/mutate';
            const body = { mutations: [{ key, expectedRevision: 'absent', content: { t: 'plain', v: { key, value: { pinned: true } } } }],
                expectedRefs: [], topologyChange: false };
            if (loss === 'publisher-during-eligibility') {
                await db.accountIdentity.create({ data: { accountId: fixture.account.id, provider: 'github',
                    providerUserId: 'project-requester', providerLogin: 'project-requester', profile: {},
                    token: encryptString(['user', fixture.account.id, 'github', 'token'], 'github-oauth-boundary-token') } });
                applyEnvValues({ AUTH_REQUIRED_LOGIN_PROVIDERS: 'github', AUTH_GITHUB_ALLOWED_USERS: '',
                    AUTH_GITHUB_ALLOWED_ORGS: 'requester-projects', AUTH_GITHUB_ORG_MEMBERSHIP_SOURCE: 'oauth_user_token',
                    AUTH_OFFBOARDING_ENABLED: 'false' });
                // Only GitHub's actual HTTP boundary is replaced. The real eligibility
                // owner remains eligible while the live source publisher retires.
                const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async url => {
                    expect(String(url)).toBe('https://api.github.com/orgs/requester-projects/members/project-requester');
                    eligibilityRead = true;
                    publisherVisible = false;
                    return new Response(null, { status: 204 });
                });
                restoreFetch = () => fetchSpy.mockRestore();
            }
            retireOnFinalRead = true;
            const response = await app.inject({ method: 'POST', url: path, headers: machineHeaders({ authorizationToken: authorization.token,
                effectActionId: actionId, method: 'POST', path, body, privateKey: destinationKey.secretKey }), payload: body });
            if (loss === 'publisher-during-eligibility') {
                expect(eligibilityRead).toBe(true);
                expect(publisherVisible).toBe(false);
                expect((await db.account.findUniqueOrThrow({ where: { id: fixture.account.id } })).tokenEpoch).toBe(fixture.account.tokenEpoch);
                expect((await db.machine.findUniqueOrThrow({ where: { id: destination.id } })).installationId).toBe(destination.installationId);
                expect(await db.accessKey.findUnique({ where: { accountId_machineId_sessionId: {
                    accountId: fixture.account.id, machineId: fixture.machine.id, sessionId: session.id } } })).not.toBeNull();
            } else expect(discoveryReads).toBe(2);
            expect(response.statusCode, response.body).toBe(401);
            expect(await resolvePublisher({ accountId: fixture.account.id, sessionId: session.id }))
                .toBe(loss === 'publisher-during-eligibility' ? null : fixture.machine.id);
            expect(await db.userKVStore.findUnique({ where: { accountId_key: { accountId: fixture.account.id,
                key: buildProjectAccountRowPhysicalKeyV1(key) } } })).toBeNull();
        } finally { restoreFetch?.(); restoreEnv(envBefore); await app.close(); }
    });

    it.each(['full', 'scoped'] as const)('verifies the genuine %s original SOURCE root under the physical writer installation proof before effects', async scope => {
        const fixture = await createFixture({ qualifiedPat: false });
        const callerInputConstraints = { models: [{ agentTargetKey: 'agent:codex', providerConnectionId: null,
            modelId: 'allowed-model' }], permissionModes: ['default' as const] };
        const pat = await auth.createApiToken({ accountId: fixture.account.id, tokenId: crypto.randomUUID(), label: 'source-root-home-proof',
            grant: { ...API_TOKEN_FULL_GRANT_V1,
                ...(scope === 'scoped' ? { actions: { families: [], ids: ['session.handoff'] } } : {}), ...callerInputConstraints } });
        const custodian = await db.account.create({ data: { publicKey: null, encryptionMode: 'plain' } });
        const anotherActor = await db.account.create({ data: { publicKey: null, encryptionMode: 'plain' } });
        const childKey = tweetnacl.sign.keyPair();
        const parentKey = tweetnacl.sign.keyPair();
        const createMachine = (key: ReturnType<typeof tweetnacl.sign.keyPair>) => db.machine.create({ data: {
            id: crypto.randomUUID(), accountId: custodian.id, active: true, metadata: fixture.machine.metadata,
            dataEncryptionKey: fixture.machine.dataEncryptionKey, installationId: crypto.randomUUID(), installationPublicKey: new Uint8Array(key.publicKey),
        } });
        const child = await createMachine(childKey);
        const parent = await createMachine(parentKey);
        for (const actorAccountId of [fixture.account.id, anotherActor.id]) await inTx(tx => setMachineAccessGrantInTx(tx, {
            actorAccountId: custodian.id, machineId: child.id, principal: { kind: 'account', accountId: actorAccountId }, level: 'view' }));
        expect(await resolveMachineAdmission({ actorAccountId: fixture.account.id, machineId: parent.id })).toMatchObject({ kind: 'denied' });
        const admitted = await resolveMachineAdmission({ actorAccountId: fixture.account.id, machineId: child.id, requiredRole: 'use' });
        expect(admitted).toMatchObject({ kind: 'admitted', role: 'use' });
        if (admitted.kind !== 'admitted') throw new Error('Real original shared-child admission required');
        const { kind: _kind, ...context } = admitted;
        const homeId = await getOrCreateServerIdentityId();
        const sourceRow = await db.managedMachine.create({ data: { homeId, custodianAccountId: custodian.id,
            controllerMachineId: parent.id, controllerInstallationId: parent.installationId!, enrolledMachineId: child.id,
            admittedActionRequestId: crypto.randomUUID(), admittedInput: {}, allocation: 'bound', creationState: 'active',
            launch: { provider: { pluginId: 'happier.devcontainer', localId: 'devcontainer' }, schemaVersion: 1, name: 'SOURCE proof child', choices: {} },
            retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false,
            resource: { contributionRef: { pluginId: 'happier.devcontainer', localId: 'devcontainer' }, schemaVersion: 1, value: {},
                devcontainerObservation: { nativeResourceId: child.id, user: 'coder', workspaceFolder: '/child/source',
                    storage: { kind: 'bind', hostPath: '/parent/source', childPath: '/child/source' } } },
        } });
        const session = await db.session.create({ data: { accountId: fixture.account.id, tag: crypto.randomUUID(), metadata: '{}', encryptionMode: 'plain' } });
        await db.accessKey.create({ data: { accountId: fixture.account.id, machineId: child.id, sessionId: session.id, data: 'source-key' } });
        const presence = createSessionPublisherPresence();
        const publisher = { data: {} };
        expect((await presence.registerPublisher({ socket: publisher,
            binding: { accountId: fixture.account.id, machineId: child.id, sessionId: session.id },
            completeActivitySnapshot: { state: 'active', activeCount: 1 } })).status).toBe('registered');
        const method = `${parent.id}:${RPC_METHODS.DAEMON_WORKSPACE_SYNC_HANDOFF_SOURCE_PHASE}`;
        // These are only the network delivery/result boundary. The receiver's
        // existing prepared-entry tests, not a server fixture map, prove custody.
        const delivered = vi.fn(async (_event: string, _request: unknown) => ({ success: true }));
        const parentSocket = { id: 'source-proof-parent-receiver', data: { clientType: 'machine-scoped', machineId: parent.id,
            verifiedMachineInstallationId: parent.installationId }, timeout: () => ({ emitWithAck: delivered }) };
        qualifyCurrentAccountStoredContentSocket(parentSocket);
        const io = createSocketRoomDiscoveryHarness(async room => room === getAccountSessionSocketRoom(fixture.account.id, session.id) ? [publisher]
            : room === `rpc:${custodian.id}:${method}` || room === parentSocket.id ? [parentSocket] : []);
        const resolvePublisher = (input: Readonly<{ accountId: string; sessionId: string }>) => resolveCurrentSessionMachineFromServer({ io, presence, ...input });
        const { app } = await createApp(fixture.team.id, false, resolvePublisher);
        try {
            const envelope = ExternalActionRequestEnvelopeV1Schema.parse({ v: 1, requestId: crypto.randomUUID(),
                target: { kind: 'machine', machineId: child.id },
                handoffAdmission: { sessionId: session.id, sourceMachineId: child.id, targetMachineId: fixture.machine.id },
                input: { sessionId: session.id, targetMachineId: fixture.machine.id, targetPath: '/target', accountServerId: homeId,
                    workspaceAction: { kind: 'copy_once' } } });
            const minted = await app.inject({ method: 'POST', url: bindExternalActionExecutionAuthorizationHttpPathV1('session.handoff'),
                headers: { authorization: `Bearer ${pat.token}` }, payload: { v: 1, machineId: child.id, envelope } });
            expect(minted.statusCode, minted.body).toBe(200);
            const root = ExternalActionExecutionAuthorizationV1Schema.parse(minted.json());
            const routing = WorkspaceSyncSourceRoutingV1Schema.parse({ v: 1, phase: 'prepare', operationId: crypto.randomUUID(), accountServerId: homeId,
                sourceMachineId: child.id, sourceRootPath: '/child/source', sourceSessionId: session.id,
                sourceContext: { machineAdmission: context, callerAuthority: 'account_automation', callerInputConstraints } });
            const accountToken = await auth.createToken(custodian.id, undefined, { kind: 'account', authority: 'present_user' });
            const verify = (callerInputAuthorization: typeof root | null = root, workspaceSyncSourceRouting = routing, privateKey = parentKey.secretKey) => {
                const rpcAdmission = { context: workspaceSyncSourceRouting.sourceContext?.machineAdmission ?? context, method,
                    workspaceSyncSourceRouting, ...(callerInputAuthorization ? { callerInputAuthorization } : {}) };
                const payload = MachineInstallationProofPayloadV1Schema.parse({ version: 1, machineId: parent.id,
                    installationId: parent.installationId!, accountId: custodian.id, rpcAdmission });
                return app.inject({ method: 'POST', url: `/v1/machines/${parent.id}/admission/verify`,
                    headers: { authorization: `Bearer ${accountToken}`, ...currentAccountStoredContentCompatibilityHeaders },
                    payload: { v: 1, ...rpcAdmission, proof: signMachineInstallationProof({ payload, privateKey }) } });
            };
            const response = await verify();
            expect(response.statusCode, response.body).toBe(200);
            expect(response.json()).toEqual({ v: 1, ok: true });
            expect((await verify({ ...root, token: 'forged-root-token' })).statusCode).toBe(403);
            expect((await verify({ ...root, binding: { ...root.binding, requestEnvelopeDigest: 'a'.repeat(43) } })).statusCode).toBe(403);
            expect((await verify(root, { ...routing, sourceSessionId: 'substituted-session' })).statusCode).toBe(403);
            expect((await verify(root, { ...routing, sourceRootPath: '/child/other' })).statusCode).toBe(403);
            if (!routing.sourceContext) throw new Error('Original SOURCE context required');
            expect((await verify(root, { ...routing, sourceContext: { ...routing.sourceContext,
                machineAdmission: { ...context, actorAccountId: anotherActor.id } } })).statusCode).toBe(403);
            expect((await verify(root, { ...routing, sourceContext: { ...routing.sourceContext,
                callerInputConstraints: { models: null, permissionModes: null } } })).statusCode).toBe(403);
            expect((await verify(root, routing, childKey.secretKey)).statusCode).toBe(403);
            const sourceSocket = Object.assign(createFakeSocket({ id: 'still-installed-source-guest', data: {
                clientType: 'machine-scoped', machineId: child.id, verifiedMachineInstallationId: child.installationId,
                authTokenKind: 'account', authAuthority: 'present_user' } }), { handshake: { auth: { token: accountToken } } });
            qualifyCurrentAccountStoredContentSocket(sourceSocket);
            registerSocketRpcHandlers({ userId: custodian.id, socket: sourceSocket as unknown as Socket, io, sessionPublisherPresence: presence });
            const params = 'opaque-retained-source-prepare';
            const execution = { v: 1 as const, authorization: root, effectActionId: 'session.handoff', target: root.binding.target,
                installationId: child.installationId!, machineSignature: signExternalActionMachineRpcRequestV1({ authorizationToken: root.token,
                    effectActionId: 'session.handoff', target: root.binding.target, installationId: child.installationId!, event: SOCKET_RPC_EVENTS.CALL,
                    method, requestId: root.binding.requestId, params, privateKey: childKey.secretKey }) };
            const callback = vi.fn();
            await getSocketHandler(sourceSocket, SOCKET_RPC_EVENTS.CALL)({ method, requestId: root.binding.requestId, params,
                externalActionExecution: execution, workspaceSyncSourceRouting: routing }, callback);
            expect(callback).toHaveBeenCalledWith({ ok: true, result: { success: true } });
            expect(delivered.mock.calls[0]?.[1]).toMatchObject({ callerInputAuthorization: root, workspaceSyncSourceRouting: routing });
            await auth.revokeApiToken({ accountId: fixture.account.id, tokenId: pat.tokenId });
            expect((await verify()).statusCode).toBe(403);
            await inTx(tx => removeMachineAccessGrantInTx(tx, { actorAccountId: custodian.id, machineId: child.id,
                principal: { kind: 'account', accountId: fixture.account.id } }));
            // The real replacement writer clears this inverse/native observation
            // while the original installed guest and controller still exist.
            await db.managedMachine.update({ where: { id: sourceRow.id }, data: { enrolledMachineId: null,
                resource: { contributionRef: { pluginId: 'happier.devcontainer', localId: 'devcontainer' }, schemaVersion: 1, value: {} } } });
            // Only the current custodian's retained release purpose survives:
            // no retired borrower bearer or restored effect permission.
            const releaseRouting = { ...routing, phase: 'abort' as const };
            expect((await verify(null, releaseRouting)).statusCode).toBe(200);
            callback.mockClear();
            await getSocketHandler(sourceSocket, SOCKET_RPC_EVENTS.CALL)({ method, params: 'opaque-retained-source-abort',
                workspaceSyncSourceRouting: releaseRouting }, callback);
            expect(callback).toHaveBeenCalledWith({ ok: true, result: { success: true } });
            expect(delivered.mock.calls[1]?.[1]).toMatchObject({ machineAdmission: context, workspaceSyncSourceRouting: releaseRouting });
            expect(delivered.mock.calls[1]?.[1]).not.toHaveProperty('callerInputAuthorization');
            callback.mockClear();
            await getSocketHandler(sourceSocket, SOCKET_RPC_EVENTS.CALL)({ method, params,
                workspaceSyncSourceRouting: routing }, callback);
            expect(callback).toHaveBeenCalledWith(expect.objectContaining({ ok: false }));
            sourceSocket.data!.verifiedMachineInstallationId = crypto.randomUUID();
            callback.mockClear();
            await getSocketHandler(sourceSocket, SOCKET_RPC_EVENTS.CALL)({ method, params: 'opaque-retained-source-abort',
                workspaceSyncSourceRouting: releaseRouting }, callback);
            expect(callback).toHaveBeenCalledWith(expect.objectContaining({ ok: false }));
            expect(delivered).toHaveBeenCalledTimes(2);
        } finally { await app.close(); }
    });

    it.each(['Home', 'Socket'] as const)('authenticates B-only physical writer release across custodians after the chosen child retires without a Root bearer through %s', async boundary => {
        const fixture = await createFixture({ qualifiedPat: false });
        const callerInputConstraints = { models: [{ agentTargetKey: 'agent:codex', providerConnectionId: null, modelId: 'allowed-model' }],
            permissionModes: ['default' as const] };
        const pat = await auth.createApiToken({ accountId: fixture.account.id, tokenId: crypto.randomUUID(), label: 'retained-target-release',
            grant: { ...API_TOKEN_FULL_GRANT_V1, ...callerInputConstraints } });
        const sourceCustodian = await db.account.create({ data: { publicKey: null, encryptionMode: 'plain' } });
        const targetCustodian = await db.account.create({ data: { publicKey: null, encryptionMode: 'plain' } });
        const childKey = tweetnacl.sign.keyPair();
        const writerKey = tweetnacl.sign.keyPair();
        const targetKey = tweetnacl.sign.keyPair();
        const parentKey = tweetnacl.sign.keyPair();
        const strangerKey = tweetnacl.sign.keyPair();
        const createMachine = (accountId: string, key: ReturnType<typeof tweetnacl.sign.keyPair>) => db.machine.create({ data: {
            id: crypto.randomUUID(), accountId, active: true, metadata: fixture.machine.metadata, dataEncryptionKey: fixture.machine.dataEncryptionKey,
            installationId: crypto.randomUUID(), installationPublicKey: new Uint8Array(key.publicKey),
        } });
        const child = await createMachine(sourceCustodian.id, childKey);
        const writer = await createMachine(sourceCustodian.id, writerKey);
        const target = await createMachine(targetCustodian.id, targetKey);
        const parent = await createMachine(targetCustodian.id, parentKey);
        const stranger = await createMachine(sourceCustodian.id, strangerKey);
        for (const [machine, custodian] of [[child, sourceCustodian], [target, targetCustodian]] as const) await inTx(tx => setMachineAccessGrantInTx(tx, {
            actorAccountId: custodian.id, machineId: machine.id, principal: { kind: 'account', accountId: fixture.account.id }, level: 'view' }));
        const sourceAdmission = await resolveMachineAdmission({ actorAccountId: fixture.account.id, machineId: child.id, requiredRole: 'use' });
        const writerAdmission = await resolveMachineAdmission({ actorAccountId: sourceCustodian.id, machineId: writer.id });
        if (sourceAdmission.kind !== 'admitted' || writerAdmission.kind !== 'admitted') throw new Error('Current source snapshot and installed writer required');
        const { kind: _sourceKind, ...originalSourceAdmission } = sourceAdmission;
        const { kind: _writerKind, ...transportAdmission } = writerAdmission;
        expect(await resolveMachineAdmission({ actorAccountId: sourceCustodian.id, machineId: parent.id })).toMatchObject({ kind: 'denied' });
        const homeId = await getOrCreateServerIdentityId();
        const createRow = (machine: typeof child, controller: typeof writer, custodianAccountId: string, rootPath: string, hostPath: string) => db.managedMachine.create({ data: {
            homeId, custodianAccountId, controllerMachineId: controller.id, controllerInstallationId: controller.installationId!, enrolledMachineId: machine.id,
            admittedActionRequestId: crypto.randomUUID(), admittedInput: {}, allocation: 'bound', creationState: 'active',
            launch: { provider: { pluginId: 'happier.devcontainer', localId: 'devcontainer' }, schemaVersion: 1, name: 'Retained cleanup child', choices: {} },
            retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false,
            resource: { contributionRef: { pluginId: 'happier.devcontainer', localId: 'devcontainer' }, schemaVersion: 1, value: {},
                devcontainerObservation: { nativeResourceId: machine.id, user: 'coder', workspaceFolder: rootPath,
                    storage: { kind: 'bind', hostPath, childPath: rootPath } } },
        } });
        await createRow(child, writer, sourceCustodian.id, '/child/source', '/parent/source');
        const targetRow = await createRow(target, parent, targetCustodian.id, '/child/target', '/parent/target');
        const retainedTarget = await readMachineDevcontainerWorkspaceSyncRouteInTx(db, { accountServerId: homeId,
            childMachineId: target.id, childRootPath: '/child/target', parentMachineId: parent.id });
        expect(retainedTarget).toMatchObject({ parentInstallationId: parent.installationId });
        if (!retainedTarget) throw new Error('Canonical physical target must be captured before retirement');
        const session = await db.session.create({ data: { accountId: fixture.account.id, tag: crypto.randomUUID(), metadata: '{}', encryptionMode: 'plain' } });
        await db.accessKey.create({ data: { accountId: fixture.account.id, machineId: child.id, sessionId: session.id, data: 'source-key' } });
        const presence = createSessionPublisherPresence();
        const publisher = { data: {} };
        expect((await presence.registerPublisher({ socket: publisher, binding: { accountId: fixture.account.id, machineId: child.id, sessionId: session.id },
            completeActivitySnapshot: { state: 'active', activeCount: 1 } })).status).toBe('registered');
        const method = `${parent.id}:${RPC_METHODS.DAEMON_WORKSPACE_SYNC_TARGET_BOOTSTRAP_RELEASE}`;
        // Home/socket own authentication and forwarding, not the receiver's loan.
        // The real RetainedBootstrap tests decide exact snapshot/op matching and
        // root-fence release; this mock replaces only network delivery/reply.
        const delivered = vi.fn(async (_event: string, _request: unknown) => 'sealed-release-delivery-response');
        const receiver = { id: 'retained-physical-target-receiver', data: { clientType: 'machine-scoped', machineId: parent.id,
            verifiedMachineInstallationId: parent.installationId }, timeout: () => ({ emitWithAck: delivered }) };
        qualifyCurrentAccountStoredContentSocket(receiver);
        const io = createSocketRoomDiscoveryHarness(async room => room === getAccountSessionSocketRoom(fixture.account.id, session.id) ? [publisher]
            : room === `rpc:${targetCustodian.id}:${method}` || room === receiver.id ? [receiver] : []);
        const { app } = await createApp(fixture.team.id, false, input => resolveCurrentSessionMachineFromServer({ io, presence, ...input }));
        try {
            const envelope = ExternalActionRequestEnvelopeV1Schema.parse({ v: 1, requestId: crypto.randomUUID(), target: { kind: 'machine', machineId: child.id },
                handoffAdmission: { sessionId: session.id, sourceMachineId: child.id, targetMachineId: target.id },
                input: { sessionId: session.id, targetMachineId: target.id, targetPath: '/child/target', accountServerId: homeId, workspaceAction: { kind: 'copy_once' } } });
            const minted = await app.inject({ method: 'POST', url: bindExternalActionExecutionAuthorizationHttpPathV1('session.handoff'),
                headers: { authorization: `Bearer ${pat.token}` }, payload: { v: 1, machineId: child.id, envelope } });
            expect(minted.statusCode, minted.body).toBe(200);
            const root = ExternalActionExecutionAuthorizationV1Schema.parse(minted.json());
            expect(root.binding).toMatchObject({ accountId: fixture.account.id, machineId: child.id, custodianAccountId: sourceCustodian.id });
            const routing = WorkspaceSyncSourceWriterTargetRoutingV1Schema.parse({ v: 1,
                source: { v: 1, phase: 'prepare', operationId: crypto.randomUUID(), accountServerId: homeId,
                    sourceMachineId: child.id, sourceSessionId: session.id, sourceRootPath: '/child/source',
                    sourceContext: { machineAdmission: originalSourceAdmission, callerAuthority: 'account_automation', callerInputConstraints } },
                sourceWriter: { machineId: writer.id, installationId: writer.installationId! },
                target: { v: 1, phase: 'release', operationId: crypto.randomUUID(), accountServerId: homeId,
                    targetMachineId: target.id, targetRootPath: '/child/target' } });
            await db.managedMachine.update({ where: { id: targetRow.id }, data: { enrolledMachineId: null,
                resource: { contributionRef: { pluginId: 'happier.devcontainer', localId: 'devcontainer' }, schemaVersion: 1, value: {} } } });
            await db.machine.update({ where: { id: target.id }, data: { revokedAt: new Date(), active: false, installationId: crypto.randomUUID() } });
            for (const [machine, custodian] of [[child, sourceCustodian], [target, targetCustodian]] as const) await inTx(tx => removeMachineAccessGrantInTx(tx, {
                actorAccountId: custodian.id, machineId: machine.id, principal: { kind: 'account', accountId: fixture.account.id } }));
            await auth.revokeApiToken({ accountId: fixture.account.id, tokenId: pat.tokenId });
            const receiverToken = await auth.createToken(targetCustodian.id, undefined, { kind: 'account', authority: 'present_user' });
            const verify = (workspaceSyncSourceWriterTargetRouting = routing, privateKey = parentKey.secretKey) => {
                const rpcAdmission = { context: transportAdmission, method, workspaceSyncSourceWriterTargetRouting };
                const payload = MachineInstallationProofPayloadV1Schema.parse({ version: 1, machineId: parent.id,
                    installationId: retainedTarget.parentInstallationId, accountId: targetCustodian.id, rpcAdmission });
                return app.inject({ method: 'POST', url: `/v1/machines/${parent.id}/admission/verify`,
                    headers: { authorization: `Bearer ${receiverToken}`, ...currentAccountStoredContentCompatibilityHeaders },
                    payload: { v: 1, ...rpcAdmission, proof: signMachineInstallationProof({ payload, privateKey }) } });
            };
            if (boundary === 'Home') {
                const verified = await verify();
                expect(verified.statusCode, verified.body).toBe(200);
                expect(verified.json()).toEqual({ v: 1, ok: true });
                expect((await verify(routing, writerKey.secretKey)).statusCode).toBe(403);
                expect((await verify({ ...routing, sourceWriter: { machineId: stranger.id, installationId: stranger.installationId! } })).statusCode).toBe(403);
                const rpcAdmission = { context: transportAdmission, method, workspaceSyncSourceWriterTargetRouting: routing };
                const payload = MachineInstallationProofPayloadV1Schema.parse({ version: 1, machineId: parent.id,
                    installationId: retainedTarget.parentInstallationId, accountId: targetCustodian.id, rpcAdmission });
                const malformed = await app.inject({ method: 'POST', url: `/v1/machines/${parent.id}/admission/verify`,
                    headers: { authorization: `Bearer ${receiverToken}`, ...currentAccountStoredContentCompatibilityHeaders },
                    payload: { v: 1, ...rpcAdmission, workspaceSyncSourceWriterTargetRouting: { ...routing,
                        source: { ...routing.source, sourceMachineId: stranger.id } },
                        proof: signMachineInstallationProof({ payload, privateKey: parentKey.secretKey }) } });
                expect(malformed.statusCode).toBe(400);
                return;
            }
            const writerToken = await auth.createToken(sourceCustodian.id, undefined, { kind: 'account', authority: 'present_user' });
            const makeSocket = (machine: typeof writer, id: string) => Object.assign(createFakeSocket({ id, data: {
                clientType: 'machine-scoped', machineId: machine.id, verifiedMachineInstallationId: machine.installationId,
                authTokenKind: 'account', authAuthority: 'present_user' } }), { handshake: { auth: { token: writerToken } } });
            const socket = makeSocket(writer, 'current-source-writer-release');
            qualifyCurrentAccountStoredContentSocket(socket);
            registerSocketRpcHandlers({ userId: sourceCustodian.id, socket: socket as unknown as Socket, io, sessionPublisherPresence: presence });
            const callback = vi.fn();
            const call = (selectedSocket = socket, workspaceSyncSourceWriterTargetRouting = routing) => getSocketHandler(selectedSocket, SOCKET_RPC_EVENTS.CALL)({
                method, params: 'sealed-retained-target-release', workspaceSyncSourceWriterTargetRouting }, callback);
            await call();
            expect(callback).toHaveBeenCalledWith({ ok: true, result: 'sealed-release-delivery-response' });
            expect(delivered.mock.calls[0]?.[1]).toMatchObject({ machineAdmission: transportAdmission,
                callerAuthority: 'present_user', workspaceSyncSourceWriterTargetRouting: routing });
            expect(delivered.mock.calls[0]?.[1]).not.toHaveProperty('callerInputAuthorization');
            expect(delivered.mock.calls[0]?.[1]).not.toHaveProperty('workspaceSyncTargetRouting');
            const strangerSocket = makeSocket(stranger, 'wrong-source-writer-release');
            qualifyCurrentAccountStoredContentSocket(strangerSocket);
            registerSocketRpcHandlers({ userId: sourceCustodian.id, socket: strangerSocket as unknown as Socket, io, sessionPublisherPresence: presence });
            callback.mockClear();
            await call(strangerSocket);
            expect(callback).toHaveBeenCalledWith(expect.objectContaining({ ok: false }));
            callback.mockClear();
            await call(socket, { ...routing, source: { ...routing.source, sourceMachineId: stranger.id } });
            expect(callback).toHaveBeenCalledWith(expect.objectContaining({ ok: false }));
            socket.data!.clientType = 'user-scoped';
            callback.mockClear();
            await call();
            expect(callback).toHaveBeenCalledWith(expect.objectContaining({ ok: false }));
            expect(delivered).toHaveBeenCalledTimes(1);
        } finally { await app.close(); }
    });

    it('verifies an ordinary HOST source writer handoff root and discovers only its chosen TARGET installation', async () => {
        const fixture = await createFixture({ qualifiedPat: false });
        const callerInputConstraints = { models: [{ agentTargetKey: 'agent:codex', providerConnectionId: null, modelId: 'allowed-model' }],
            permissionModes: ['default' as const] };
        const pat = await auth.createApiToken({ accountId: fixture.account.id, tokenId: crypto.randomUUID(), label: 'ordinary-source-writer',
            grant: { ...API_TOKEN_FULL_GRANT_V1, ...callerInputConstraints } });
        const sourceCustodian = await db.account.create({ data: { publicKey: null, encryptionMode: 'plain' } });
        const targetCustodian = await db.account.create({ data: { publicKey: null, encryptionMode: 'plain' } });
        const sourceKey = tweetnacl.sign.keyPair();
        const targetKey = tweetnacl.sign.keyPair();
        const parentKey = tweetnacl.sign.keyPair();
        const createMachine = (accountId: string, key: ReturnType<typeof tweetnacl.sign.keyPair>) => db.machine.create({ data: {
            id: crypto.randomUUID(), accountId, active: true, metadata: fixture.machine.metadata, dataEncryptionKey: fixture.machine.dataEncryptionKey,
            installationId: crypto.randomUUID(), installationPublicKey: new Uint8Array(key.publicKey),
        } });
        const source = await createMachine(sourceCustodian.id, sourceKey);
        const target = await createMachine(targetCustodian.id, targetKey);
        const targetParent = await createMachine(targetCustodian.id, parentKey);
        for (const [machine, custodian] of [[source, sourceCustodian], [target, targetCustodian]] as const) await inTx(tx => setMachineAccessGrantInTx(tx, {
            actorAccountId: custodian.id, machineId: machine.id, principal: { kind: 'account', accountId: fixture.account.id }, level: 'view' }));
        const sourceAdmission = await resolveMachineAdmission({ actorAccountId: fixture.account.id, machineId: source.id, requiredRole: 'use' });
        const targetAdmission = await resolveMachineAdmission({ actorAccountId: fixture.account.id, machineId: target.id, requiredRole: 'use' });
        if (sourceAdmission.kind !== 'admitted' || targetAdmission.kind !== 'admitted') throw new Error('Current ordinary SOURCE and shared TARGET required');
        const { kind: _sourceKind, ...sourceContextAdmission } = sourceAdmission;
        const { kind: _targetKind, ...targetContextAdmission } = targetAdmission;
        expect(await resolveMachineAdmission({ actorAccountId: fixture.account.id, machineId: targetParent.id })).toMatchObject({ kind: 'denied' });
        const homeId = await getOrCreateServerIdentityId();
        // Only TARGET is a managed child. An ordinary SOURCE must not need a
        // fabricated enrollment/native observation to prove its own writer.
        await db.managedMachine.create({ data: { homeId, custodianAccountId: targetCustodian.id,
            controllerMachineId: targetParent.id, controllerInstallationId: targetParent.installationId!, enrolledMachineId: target.id,
            admittedActionRequestId: crypto.randomUUID(), admittedInput: {}, allocation: 'bound', creationState: 'active',
            launch: { provider: { pluginId: 'happier.devcontainer', localId: 'devcontainer' }, schemaVersion: 1, name: 'HOST handoff target', choices: {} },
            retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false,
            resource: { contributionRef: { pluginId: 'happier.devcontainer', localId: 'devcontainer' }, schemaVersion: 1, value: {},
                devcontainerObservation: { nativeResourceId: target.id, user: 'coder', workspaceFolder: '/child/target',
                    storage: { kind: 'bind', hostPath: '/parent/target', childPath: '/child/target' } } },
        } });
        const session = await db.session.create({ data: { accountId: fixture.account.id, tag: crypto.randomUUID(), metadata: '{}', encryptionMode: 'plain' } });
        await db.accessKey.create({ data: { accountId: fixture.account.id, machineId: source.id, sessionId: session.id, data: 'ordinary-source-key' } });
        const presence = createSessionPublisherPresence();
        const publisher = { data: {} };
        expect((await presence.registerPublisher({ socket: publisher, binding: { accountId: fixture.account.id, machineId: source.id, sessionId: session.id },
            completeActivitySnapshot: { state: 'active', activeCount: 1 } })).status).toBe('registered');
        const method = `${target.id}:${RPC_METHODS.DAEMON_WORKSPACE_SYNC_TARGET_REPLACEMENT_PREFLIGHT}`;
        const effect = vi.fn(async (_event: string, _request: unknown) => ({ type: 'not_required' }));
        const receiver = { id: 'ordinary-source-chosen-target', data: { clientType: 'machine-scoped', machineId: target.id,
            verifiedMachineInstallationId: target.installationId }, timeout: () => ({ emitWithAck: effect }) };
        qualifyCurrentAccountStoredContentSocket(receiver);
        const io = createSocketRoomDiscoveryHarness(async room => room === getAccountSessionSocketRoom(fixture.account.id, session.id) ? [publisher]
            : room === `rpc:${targetCustodian.id}:${method}` || room === receiver.id ? [receiver] : []);
        const { app } = await createApp(fixture.team.id, false, input => resolveCurrentSessionMachineFromServer({ io, presence, ...input }));
        try {
            const envelope = ExternalActionRequestEnvelopeV1Schema.parse({ v: 1, requestId: crypto.randomUUID(), target: { kind: 'machine', machineId: source.id },
                handoffAdmission: { sessionId: session.id, sourceMachineId: source.id, targetMachineId: target.id },
                input: { sessionId: session.id, targetMachineId: target.id, targetPath: '/child/target', accountServerId: homeId, workspaceAction: { kind: 'copy_once' } } });
            const minted = await app.inject({ method: 'POST', url: bindExternalActionExecutionAuthorizationHttpPathV1('session.handoff'),
                headers: { authorization: `Bearer ${pat.token}` }, payload: { v: 1, machineId: source.id, envelope } });
            expect(minted.statusCode, minted.body).toBe(200);
            const root = ExternalActionExecutionAuthorizationV1Schema.parse(minted.json());
            const sourceRouting = WorkspaceSyncSourceRoutingV1Schema.parse({ v: 1, phase: 'prepare', operationId: crypto.randomUUID(), accountServerId: homeId,
                sourceMachineId: source.id, sourceSessionId: session.id, sourceRootPath: '/source',
                sourceContext: { machineAdmission: sourceContextAdmission, callerAuthority: 'account_automation', callerInputConstraints } });
            const routing = WorkspaceSyncSourceWriterTargetRoutingV1Schema.parse({ v: 1, source: sourceRouting, sourceWriter: { machineId: source.id, installationId: source.installationId! },
                target: { v: 1 as const, phase: 'preflight' as const, operationId: crypto.randomUUID(), accountServerId: homeId,
                    targetMachineId: target.id, targetRootPath: '/child/target' } });
            const token = await auth.createToken(sourceCustodian.id, undefined, { kind: 'account', authority: 'present_user' });
            const verify = (workspaceSyncSourceWriterTargetRouting = routing, callerInputAuthorization = root) => {
                const rpcAdmission = { context: sourceContextAdmission, method, workspaceSyncSourceWriterTargetRouting, callerInputAuthorization };
                const payload = MachineInstallationProofPayloadV1Schema.parse({ version: 1, machineId: source.id, installationId: source.installationId!,
                    accountId: sourceCustodian.id, rpcAdmission });
                return app.inject({ method: 'POST', url: `/v1/machines/${source.id}/admission/verify`,
                    headers: { authorization: `Bearer ${token}`, ...currentAccountStoredContentCompatibilityHeaders },
                    payload: { v: 1, ...rpcAdmission, proof: signMachineInstallationProof({ payload, privateKey: sourceKey.secretKey }) } });
            };
            const verified = await verify();
            expect(verified.statusCode, verified.body).toBe(200);
            expect(verified.json()).toEqual({ v: 1, ok: true, destinationInstallation: { machineId: target.id,
                installationId: target.installationId, installationPublicKey: Buffer.from(targetKey.publicKey).toString('base64url') } });
            expect((await verify({ ...routing, sourceWriter: { machineId: fixture.machine.id, installationId: fixture.machine.installationId! } })).statusCode).toBe(403);
            expect((await verify({ ...routing, target: { ...routing.target, phase: 'prepare' } })).statusCode).toBe(403);
            expect((await verify(routing, { ...root, token: 'forged-root' })).statusCode).toBe(403);
            const params = HandoffTargetReplacementPreflightV1Schema.parse({ v: 1, serverId: homeId, machineId: target.id,
                targetPath: routing.target.targetRootPath, operationId: routing.target.operationId });
            const execution = { v: 1 as const, authorization: root, effectActionId: 'session.handoff', target: root.binding.target,
                installationId: source.installationId!, machineSignature: signExternalActionMachineRpcRequestV1({ authorizationToken: root.token,
                    effectActionId: 'session.handoff', target: root.binding.target, installationId: source.installationId!, event: SOCKET_RPC_EVENTS.CALL,
                    method, requestId: root.binding.requestId, params, workspaceSyncSourceWriterTargetRouting: routing, privateKey: sourceKey.secretKey }) };
            const socket = Object.assign(createFakeSocket({ id: 'ordinary-source-writer', data: { clientType: 'machine-scoped', machineId: source.id,
                verifiedMachineInstallationId: source.installationId, authTokenKind: 'account', authAuthority: 'present_user' } }), { handshake: { auth: { token } } });
            qualifyCurrentAccountStoredContentSocket(socket);
            registerSocketRpcHandlers({ userId: sourceCustodian.id, socket: socket as unknown as Socket, io, sessionPublisherPresence: presence });
            const callback = vi.fn();
            await getSocketHandler(socket, SOCKET_RPC_EVENTS.CALL)({ method, requestId: root.binding.requestId, params,
                externalActionExecution: execution, workspaceSyncSourceWriterTargetRouting: routing }, callback);
            expect(callback).toHaveBeenCalledWith({ ok: true, result: { type: 'not_required' } });
            expect(effect.mock.calls[0]?.[1]).toMatchObject({ machineAdmission: targetContextAdmission,
                callerAuthority: 'account_automation', callerInputConstraints, workspaceSyncSourceWriterTargetRouting: routing });
        } finally { await app.close(); }
    });

    it.each(['full', 'scoped'] as const)('relays the %s original shared-child handoff root from its physical SOURCE writer to the chosen TARGET', async scope => {
        const fixture = await createFixture({ qualifiedPat: false });
        const callerInputConstraints = { models: [{ agentTargetKey: 'agent:codex', providerConnectionId: null,
            modelId: 'allowed-model' }], permissionModes: ['default' as const] };
        const pat = await auth.createApiToken({ accountId: fixture.account.id, tokenId: crypto.randomUUID(), label: 'source-writer-target',
            grant: { ...API_TOKEN_FULL_GRANT_V1,
                ...(scope === 'scoped' ? { actions: { families: [], ids: ['session.handoff'] } } : {}), ...callerInputConstraints } });
        const sourceCustodian = await db.account.create({ data: { publicKey: null, encryptionMode: 'plain' } });
        const targetCustodian = await db.account.create({ data: { publicKey: null, encryptionMode: 'plain' } });
        const childKey = tweetnacl.sign.keyPair();
        const writerKey = tweetnacl.sign.keyPair();
        const targetKey = tweetnacl.sign.keyPair();
        const targetParentKey = tweetnacl.sign.keyPair();
        const createMachine = (accountId: string, key: ReturnType<typeof tweetnacl.sign.keyPair>) => db.machine.create({ data: {
            id: crypto.randomUUID(), accountId, active: true, metadata: fixture.machine.metadata,
            dataEncryptionKey: fixture.machine.dataEncryptionKey, installationId: crypto.randomUUID(), installationPublicKey: new Uint8Array(key.publicKey),
        } });
        const child = await createMachine(sourceCustodian.id, childKey);
        const writer = await createMachine(sourceCustodian.id, writerKey);
        const chosenTarget = await createMachine(targetCustodian.id, targetKey);
        const targetParent = await createMachine(targetCustodian.id, targetParentKey);
        for (const [machine, custodian] of [[child, sourceCustodian], [chosenTarget, targetCustodian]] as const) {
            await inTx(tx => setMachineAccessGrantInTx(tx, { actorAccountId: custodian.id, machineId: machine.id,
                principal: { kind: 'account', accountId: fixture.account.id }, level: 'view' }));
        }
        expect(await resolveMachineAdmission({ actorAccountId: fixture.account.id, machineId: writer.id })).toMatchObject({ kind: 'denied' });
        expect(await resolveMachineAdmission({ actorAccountId: fixture.account.id, machineId: targetParent.id })).toMatchObject({ kind: 'denied' });
        const sourceAdmission = await resolveMachineAdmission({ actorAccountId: fixture.account.id, machineId: child.id, requiredRole: 'use' });
        const targetAdmission = await resolveMachineAdmission({ actorAccountId: fixture.account.id, machineId: chosenTarget.id, requiredRole: 'use' });
        expect(sourceAdmission).toMatchObject({ kind: 'admitted', role: 'use' });
        expect(targetAdmission).toMatchObject({ kind: 'admitted', role: 'use' });
        if (sourceAdmission.kind !== 'admitted' || targetAdmission.kind !== 'admitted') throw new Error('Current shared children required');
        const { kind: _sourceKind, ...originalSourceAdmission } = sourceAdmission;
        const { kind: _targetKind, ...originalTargetAdmission } = targetAdmission;
        const homeId = await getOrCreateServerIdentityId();
        const createChildRow = (machine: typeof child, controller: typeof writer, custodianAccountId: string, rootPath: string, hostPath: string) => db.managedMachine.create({ data: {
            homeId, custodianAccountId, controllerMachineId: controller.id, controllerInstallationId: controller.installationId!, enrolledMachineId: machine.id,
            admittedActionRequestId: crypto.randomUUID(), admittedInput: {}, allocation: 'bound', creationState: 'active',
            launch: { provider: { pluginId: 'happier.devcontainer', localId: 'devcontainer' }, schemaVersion: 1,
                name: 'Handoff child', choices: {} }, retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false,
            resource: { contributionRef: { pluginId: 'happier.devcontainer', localId: 'devcontainer' }, schemaVersion: 1, value: {},
                devcontainerObservation: { nativeResourceId: machine.id, user: 'coder', workspaceFolder: rootPath,
                    storage: { kind: 'bind', hostPath, childPath: rootPath } } },
        } });
        const sourceRow = await createChildRow(child, writer, sourceCustodian.id, '/child/source', '/parent/source');
        await createChildRow(chosenTarget, targetParent, targetCustodian.id, '/child/target', '/parent/target');
        const session = await db.session.create({ data: { accountId: fixture.account.id, tag: crypto.randomUUID(), metadata: '{}', encryptionMode: 'plain' } });
        await db.accessKey.create({ data: { accountId: fixture.account.id, machineId: child.id, sessionId: session.id, data: 'source-key' } });
        const presence = createSessionPublisherPresence();
        const publisher = { data: {} };
        expect((await presence.registerPublisher({ socket: publisher,
            binding: { accountId: fixture.account.id, machineId: child.id, sessionId: session.id },
            completeActivitySnapshot: { state: 'active', activeCount: 1 } })).status).toBe('registered');
        const sourceMethod = `${writer.id}:${RPC_METHODS.DAEMON_WORKSPACE_SYNC_HANDOFF_SOURCE_PHASE}`;
        const targetMethod = `${chosenTarget.id}:${RPC_METHODS.DAEMON_WORKSPACE_SYNC_TARGET_REPLACEMENT_PREFLIGHT}`;
        const sourceEffect = vi.fn(async (_event: string, _request: unknown) => ({ prepared: true }));
        const targetEffect = vi.fn(async (_event: string, _request: unknown) => ({ type: 'not_required' }));
        const physicalReceiver = { id: 'physical-source-receiver', data: { clientType: 'machine-scoped', machineId: writer.id,
            verifiedMachineInstallationId: writer.installationId }, timeout: () => ({ emitWithAck: sourceEffect }) };
        const targetReceiver = { id: 'chosen-target-receiver', data: { clientType: 'machine-scoped', machineId: chosenTarget.id,
            verifiedMachineInstallationId: chosenTarget.installationId }, timeout: () => ({ emitWithAck: targetEffect }) };
        qualifyCurrentAccountStoredContentSocket(physicalReceiver);
        qualifyCurrentAccountStoredContentSocket(targetReceiver);
        // Network discovery/delivery alone are simulated; both RPC ingress paths,
        // Home-issued root, canonical child relations, C41 and signatures are real.
        const io = createSocketRoomDiscoveryHarness(async room => room === getAccountSessionSocketRoom(fixture.account.id, session.id)
            ? [publisher] : room === `rpc:${sourceCustodian.id}:${sourceMethod}` || room === physicalReceiver.id ? [physicalReceiver]
                : room === `rpc:${targetCustodian.id}:${targetMethod}` || room === targetReceiver.id ? [targetReceiver] : []);
        const resolvePublisher = (input: Readonly<{ accountId: string; sessionId: string }>) => resolveCurrentSessionMachineFromServer({ io, presence, ...input });
        const { app } = await createApp(fixture.team.id, false, resolvePublisher);
        try {
            const envelope = ExternalActionRequestEnvelopeV1Schema.parse({ v: 1, requestId: crypto.randomUUID(),
                target: { kind: 'machine', machineId: child.id },
                handoffAdmission: { sessionId: session.id, sourceMachineId: child.id, targetMachineId: chosenTarget.id },
                input: { sessionId: session.id, targetMachineId: chosenTarget.id, targetPath: '/child/target', accountServerId: homeId,
                    workspaceAction: { kind: 'copy_once' } } });
            const minted = await app.inject({ method: 'POST', url: bindExternalActionExecutionAuthorizationHttpPathV1('session.handoff'),
                headers: { authorization: `Bearer ${pat.token}` }, payload: { v: 1, machineId: child.id, envelope } });
            expect(minted.statusCode, minted.body).toBe(200);
            const root = ExternalActionExecutionAuthorizationV1Schema.parse(minted.json());
            const sourceContext = WorkspaceSyncSourceContextV1Schema.parse({ machineAdmission: originalSourceAdmission,
                callerAuthority: 'account_automation', callerInputConstraints });
            const sourceRouting = { ...WorkspaceSyncSourceRoutingV1Schema.parse({ v: 1, phase: 'prepare', operationId: crypto.randomUUID(),
                accountServerId: homeId, sourceMachineId: child.id, sourceSessionId: session.id, sourceRootPath: '/child/source' }), sourceContext };
            const custodianToken = await auth.createToken(sourceCustodian.id, undefined, { kind: 'account', authority: 'present_user' });
            const createInstalledSocket = (machine: typeof child, id: string) => Object.assign(createFakeSocket({ id,
                data: { clientType: 'machine-scoped', machineId: machine.id, verifiedMachineInstallationId: machine.installationId,
                    authTokenKind: 'account', authAuthority: 'present_user' } }), { handshake: { auth: { token: custodianToken } } });
            const childSocket = createInstalledSocket(child, 'original-child-sender');
            qualifyCurrentAccountStoredContentSocket(childSocket);
            registerSocketRpcHandlers({ userId: sourceCustodian.id, socket: childSocket as unknown as Socket, io, sessionPublisherPresence: presence });
            const sourceParams = 'sealed-source-prepare';
            const sourceExecution = { v: 1 as const, authorization: root, effectActionId: 'session.handoff', target: root.binding.target,
                installationId: child.installationId!, machineSignature: signExternalActionMachineRpcRequestV1({ authorizationToken: root.token,
                    effectActionId: 'session.handoff', target: root.binding.target, installationId: child.installationId!, event: SOCKET_RPC_EVENTS.CALL,
                    method: sourceMethod, requestId: root.binding.requestId, params: sourceParams, privateKey: childKey.secretKey }) };
            const sourceAck = vi.fn();
            await getSocketHandler(childSocket, SOCKET_RPC_EVENTS.CALL)({ method: sourceMethod, requestId: root.binding.requestId,
                params: sourceParams, externalActionExecution: sourceExecution, workspaceSyncSourceRouting: sourceRouting }, sourceAck);
            expect(sourceAck).toHaveBeenCalledWith({ ok: true, result: { prepared: true } });
            const sourceRequest = sourceEffect.mock.calls[0]?.[1];
            expect(sourceRequest).toMatchObject({ callerInputAuthorization: root, workspaceSyncSourceRouting: sourceRouting });
            if (!sourceRequest || typeof sourceRequest !== 'object') throw new Error('Actual physical SOURCE ingress required');
            const retainedRoot = ExternalActionExecutionAuthorizationV1Schema.parse(Reflect.get(sourceRequest, 'callerInputAuthorization'));
            const parsedSource = WorkspaceSyncSourceRoutingV1Schema.parse(Reflect.get(sourceRequest, 'workspaceSyncSourceRouting'));
            const retainedSource = { ...parsedSource, sourceContext: WorkspaceSyncSourceContextV1Schema.parse(parsedSource.sourceContext) };
            const target = { v: 1 as const, phase: 'preflight' as const, operationId: crypto.randomUUID(), accountServerId: homeId,
                targetMachineId: chosenTarget.id, targetRootPath: '/child/target' };
            const workspaceSyncSourceWriterTargetRouting = { v: 1 as const, source: retainedSource, target,
                sourceWriter: { machineId: writer.id, installationId: writer.installationId! } };
            const targetParams = HandoffTargetReplacementPreflightV1Schema.parse({ v: 1, serverId: homeId, machineId: chosenTarget.id,
                operationId: target.operationId, targetPath: target.targetRootPath });
            const request = { authorizationToken: retainedRoot.token, effectActionId: 'session.handoff', target: retainedRoot.binding.target,
                installationId: writer.installationId!, event: SOCKET_RPC_EVENTS.CALL, method: targetMethod,
                requestId: retainedRoot.binding.requestId, params: targetParams, workspaceSyncSourceWriterTargetRouting };
            const execution = { v: 1 as const, authorization: retainedRoot, effectActionId: 'session.handoff', target: retainedRoot.binding.target,
                installationId: writer.installationId!, machineSignature: signExternalActionMachineRpcRequestV1({ ...request, privateKey: writerKey.secretKey }) };
            const writerSocket = createInstalledSocket(writer, 'actual-source-writer');
            qualifyCurrentAccountStoredContentSocket(writerSocket);
            registerSocketRpcHandlers({ userId: sourceCustodian.id, socket: writerSocket as unknown as Socket, io, sessionPublisherPresence: presence });
            const callback = vi.fn();
            const call = (routing: unknown = workspaceSyncSourceWriterTargetRouting, carrier: unknown = execution) => getSocketHandler(writerSocket, SOCKET_RPC_EVENTS.CALL)({
                method: targetMethod, requestId: retainedRoot.binding.requestId, params: targetParams,
                externalActionExecution: carrier, workspaceSyncSourceWriterTargetRouting: routing }, callback);
            await call();
            expect(callback).toHaveBeenCalledWith({ ok: true, result: { type: 'not_required' } });
            expect(targetEffect.mock.calls[0]?.[1]).toMatchObject({ machineAdmission: originalTargetAdmission,
                callerAuthority: 'account_automation', callerInputConstraints, workspaceSyncSourceWriterTargetRouting });
            expect(targetEffect.mock.calls[0]?.[1]).not.toHaveProperty('sessionActionOrigin');
            callback.mockClear();
            await call({ ...workspaceSyncSourceWriterTargetRouting, target: { ...target, operationId: 'substituted-target-operation' } });
            expect(callback).toHaveBeenCalledWith(expect.objectContaining({ ok: false }));
            // A valid P1 signature does not authorize a different native bind root:
            // Home must still derive both endpoints from the unchanged handoff tuple.
            for (const routing of [
                { ...workspaceSyncSourceWriterTargetRouting, source: { ...retainedSource, sourceRootPath: '/child/other-source' } },
                { ...workspaceSyncSourceWriterTargetRouting, target: { ...target, targetRootPath: '/child/other-target' } },
            ]) {
                callback.mockClear();
                await call(routing, { ...execution, machineSignature: signExternalActionMachineRpcRequestV1({
                    ...request, workspaceSyncSourceWriterTargetRouting: routing, privateKey: writerKey.secretKey,
                }) });
                expect(callback).toHaveBeenCalledWith(expect.objectContaining({ ok: false }));
            }
            callback.mockClear();
            await call(workspaceSyncSourceWriterTargetRouting, { ...execution,
                machineSignature: signExternalActionMachineRpcRequestV1({ ...request, privateKey: childKey.secretKey }) });
            expect(callback).toHaveBeenCalledWith(expect.objectContaining({ ok: false }));
            writerSocket.data!.clientType = 'user-scoped';
            callback.mockClear();
            await call();
            expect(callback).toHaveBeenCalledWith(expect.objectContaining({ ok: false }));
            writerSocket.data!.clientType = 'machine-scoped';
            await db.managedMachine.update({ where: { id: sourceRow.id }, data: { controllerInstallationId: crypto.randomUUID() } });
            callback.mockClear();
            await call();
            expect(callback).toHaveBeenCalledWith(expect.objectContaining({ ok: false }));
            expect(targetEffect).toHaveBeenCalledTimes(1);
            expect(sourceEffect).toHaveBeenCalledTimes(1);
        } finally { await app.close(); }
    });

    it.each(['full', 'scoped'] as const)('relays a genuine Home-minted %s PAT continuation to a shared TARGET without parent authority', async scope => {
        const fixture = await createFixture({ qualifiedPat: false });
        const callerInputConstraints = { models: [{ agentTargetKey: 'agent:codex', providerConnectionId: null,
            modelId: 'allowed-model' }], permissionModes: ['default' as const] };
        const pat = await auth.createApiToken({ accountId: fixture.account.id, tokenId: crypto.randomUUID(), label: 'shared-target',
            grant: { ...API_TOKEN_FULL_GRANT_V1,
                ...(scope === 'scoped' ? { actions: { families: [], ids: ['session.handoff'] } } : {}), ...callerInputConstraints } });
        const custodian = await db.account.create({ data: { publicKey: null, encryptionMode: 'plain' } });
        const targetKey = tweetnacl.sign.keyPair();
        const parentKey = tweetnacl.sign.keyPair();
        const createCustodianMachine = (key: ReturnType<typeof tweetnacl.sign.keyPair>) => db.machine.create({ data: {
            id: crypto.randomUUID(), accountId: custodian.id, active: true,
            metadata: fixture.machine.metadata, dataEncryptionKey: fixture.machine.dataEncryptionKey,
            installationId: crypto.randomUUID(), installationPublicKey: new Uint8Array(key.publicKey),
        } });
        const child = await createCustodianMachine(targetKey);
        const parent = await createCustodianMachine(parentKey);
        await inTx(tx => setMachineAccessGrantInTx(tx, { actorAccountId: custodian.id, machineId: child.id,
            principal: { kind: 'account', accountId: fixture.account.id }, level: 'view' }));
        expect(await resolveMachineAdmission({ actorAccountId: fixture.account.id, machineId: parent.id })).toMatchObject({ kind: 'denied' });
        const admitted = await resolveMachineAdmission({ actorAccountId: fixture.account.id, machineId: child.id, requiredRole: 'use' });
        expect(admitted).toMatchObject({ kind: 'admitted', role: 'use' });
        if (admitted.kind !== 'admitted') throw new Error('Real shared TARGET admission required');
        const { kind: _kind, ...machineAdmission } = admitted;
        const session = await db.session.create({ data: { accountId: fixture.account.id, tag: crypto.randomUUID(), metadata: '{}', encryptionMode: 'plain' } });
        await db.accessKey.create({ data: { accountId: fixture.account.id, machineId: fixture.machine.id,
            sessionId: session.id, data: 'original-source-key' } });
        const presence = createSessionPublisherPresence();
        const publisher = { data: {} };
        expect((await presence.registerPublisher({ socket: publisher,
            binding: { accountId: fixture.account.id, machineId: fixture.machine.id, sessionId: session.id },
            completeActivitySnapshot: { state: 'active', activeCount: 1 } })).status).toBe('registered');
        const method = `${child.id}:${RPC_METHODS.DAEMON_WORKSPACE_SYNC_TARGET_REPLACEMENT_PREFLIGHT}`;
        const effect = vi.fn(async (_event: string, _request: unknown) => ({ type: 'not_required' }));
        const target = { id: 'shared-target-daemon', data: { clientType: 'machine-scoped', machineId: child.id,
            verifiedMachineInstallationId: child.installationId }, timeout: () => ({ emitWithAck: effect }) };
        qualifyCurrentAccountStoredContentSocket(target);
        // Only Socket.IO discovery/delivery are simulated. Home issuance, tuple,
        // requester grants, original source signatures and RPC admission remain real.
        const io = createSocketRoomDiscoveryHarness(async room => room === getAccountSessionSocketRoom(fixture.account.id, session.id)
            ? [publisher] : room === `rpc:${custodian.id}:${method}` || room === target.id ? [target] : []);
        const resolvePublisher = (input: Readonly<{ accountId: string; sessionId: string }>) => resolveCurrentSessionMachineFromServer({ io, presence, ...input });
        const { app } = await createApp(fixture.team.id, false, resolvePublisher);
        try {
            const homeId = await getOrCreateServerIdentityId();
            await db.managedMachine.create({ data: { homeId, custodianAccountId: custodian.id,
                controllerMachineId: parent.id, controllerInstallationId: parent.installationId!, enrolledMachineId: child.id,
                admittedActionRequestId: crypto.randomUUID(), admittedInput: {}, allocation: 'bound', creationState: 'active',
                launch: { provider: { pluginId: 'happier.devcontainer', localId: 'devcontainer' }, schemaVersion: 1,
                    name: 'Shared TARGET child', choices: {} }, retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false,
                resource: { contributionRef: { pluginId: 'happier.devcontainer', localId: 'devcontainer' }, schemaVersion: 1, value: {},
                    devcontainerObservation: { nativeResourceId: 'shared-target-container', user: 'coder', workspaceFolder: '/child/target',
                        storage: { kind: 'bind', hostPath: '/parent/target', childPath: '/child/target' } } },
            } });
            const handoffAdmission = { sessionId: session.id, sourceMachineId: fixture.machine.id, targetMachineId: child.id };
            const envelope = ExternalActionRequestEnvelopeV1Schema.parse({ v: 1, requestId: crypto.randomUUID(),
                target: { kind: 'machine', machineId: fixture.machine.id }, handoffAdmission,
                input: { sessionId: session.id, targetMachineId: child.id, targetPath: '/child/target', accountServerId: homeId,
                    workspaceAction: { kind: 'copy_once' } } });
            const rootResponse = await app.inject({ method: 'POST', url: bindExternalActionExecutionAuthorizationHttpPathV1('session.handoff'),
                headers: { authorization: `Bearer ${pat.token}` }, payload: { v: 1, machineId: fixture.machine.id, envelope } });
            expect(rootResponse.statusCode, rootResponse.body).toBe(200);
            const root = ExternalActionExecutionAuthorizationV1Schema.parse(rootResponse.json());
            const handoffId = 'shared-target-handoff';
            const path = bindExternalActionExecutionAuthorizationHttpPathV1('session.handoff.prepare_target');
            const accountToken = await auth.createToken(fixture.account.id, undefined, { kind: 'account', authority: 'present_user' });
            const privatePrepare = SessionRequesterHandoffBootstrapRpcRequestV1Schema.parse({
                kind: 'requester_session_handoff_bootstrap_v1',
                input: { ...handoffAdmission, handoffId, targetPath: '/child/target',
                    negotiatedTransportStrategy: 'server_routed_stream', sourceSessionStorageMode: 'persisted', endpointCandidates: [] },
                requesterBootstrap: { v: 1, disposition: 'ordinary_requester', credentials: { token: accountToken } },
            });
            const body = { v: 1, machineId: child.id, envelope: { v: 1, requestId: root.binding.requestId,
                target: { kind: 'machine', machineId: child.id }, handoffAdmission, input: privatePrepare },
                handoffContinuation: { authorization: root, handoffId } };
            const issue = (payload: unknown = body) => app.inject({ method: 'POST', url: path, payload,
                headers: { [EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]: root.token,
                    [EXTERNAL_ACTION_EFFECT_ACTION_HEADER]: 'session.handoff',
                    [EXTERNAL_ACTION_RESOLVED_TARGET_HEADER]: encodeExternalActionResolvedTargetV1(root.binding.target),
                    [EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER]: signExternalActionMachineRequestV1({ authorizationToken: root.token,
                        effectActionId: 'session.handoff', target: root.binding.target, installationId: root.binding.installationId,
                        requestId: root.binding.requestId, method: 'POST', path, body: payload, privateKey: fixture.keyPair.secretKey }) } });
            const continuationResponse = await issue();
            expect(continuationResponse.statusCode, continuationResponse.body).toBe(200);
            const authorization = ExternalActionExecutionAuthorizationV1Schema.parse(continuationResponse.json());
            expect(await verifyCurrentExternalActionPrincipal(authorization.binding)).toMatchObject({
                accountId: fixture.account.id, credentialId: pat.tokenId, authority: 'account_automation' });
            expect(authorization.binding).toMatchObject({ machineId: child.id, installationId: child.installationId,
                custodianAccountId: custodian.id, handoffContinuation: { handoffId } });
            const params = HandoffTargetReplacementPreflightV1Schema.parse({ v: 1, serverId: homeId, machineId: child.id,
                operationId: handoffId, targetPath: '/child/target' });
            const execution = { v: 1 as const, authorization, effectActionId: 'session.handoff.prepare_target',
                target: authorization.binding.target, installationId: authorization.binding.installationId,
                machineSignature: signExternalActionMachineRpcRequestV1({ authorizationToken: authorization.token,
                    effectActionId: 'session.handoff.prepare_target', target: authorization.binding.target,
                    installationId: authorization.binding.installationId, event: SOCKET_RPC_EVENTS.CALL,
                    method, requestId: authorization.binding.requestId, params, privateKey: fixture.keyPair.secretKey }) };
            const socket = Object.assign(createFakeSocket({ id: 'original-requester', data: { clientType: 'user-scoped',
                authTokenKind: 'account', authAuthority: 'present_user' } }), { handshake: { auth: { token: accountToken } } });
            qualifyCurrentAccountStoredContentSocket(socket);
            registerSocketRpcHandlers({ userId: fixture.account.id, socket: socket as unknown as Socket, io, sessionPublisherPresence: presence });
            const callback = vi.fn();
            const call = (carrier: unknown = execution, selectedMethod = method) => getSocketHandler(socket, SOCKET_RPC_EVENTS.CALL)({
                method: selectedMethod, requestId: authorization.binding.requestId, params, externalActionExecution: carrier }, callback);
            await call();
            expect(callback).toHaveBeenCalledWith({ ok: true, result: { type: 'not_required' } });
            expect(effect.mock.calls[0]?.[1]).toMatchObject({ machineAdmission, callerAuthority: 'account_automation', callerInputConstraints });
            expect(effect.mock.calls[0]?.[1]).not.toHaveProperty('sessionActionOrigin');
            callback.mockClear();
            await call({ ...execution, machineSignature: signExternalActionMachineRpcRequestV1({ authorizationToken: authorization.token,
                effectActionId: 'session.handoff.prepare_target', target: authorization.binding.target,
                installationId: authorization.binding.installationId, event: SOCKET_RPC_EVENTS.CALL, method,
                requestId: authorization.binding.requestId, params, privateKey: targetKey.secretKey }) });
            expect(callback).toHaveBeenCalledWith(expect.objectContaining({ ok: false }));
            callback.mockClear();
            await call({ ...execution, target: { kind: 'machine', machineId: parent.id } });
            expect(callback).toHaveBeenCalledWith(expect.objectContaining({ ok: false }));
            if (!('grant' in authorization.binding)) throw new Error('Genuine PAT continuation grant required');
            callback.mockClear();
            await call({ ...execution, authorization: { ...authorization, binding: { ...authorization.binding,
                grant: { ...authorization.binding.grant, models: null, permissionModes: null } } } });
            expect(callback).toHaveBeenCalledWith(expect.objectContaining({ ok: false }));
            expect((await issue({ ...body, envelope: { ...body.envelope, handoffAdmission: {
                ...handoffAdmission, sourceMachineId: parent.id } } })).statusCode).toBe(401);
            await inTx(tx => removeMachineAccessGrantInTx(tx, { actorAccountId: custodian.id, machineId: child.id,
                principal: { kind: 'account', accountId: fixture.account.id } }));
            callback.mockClear();
            await call();
            expect(callback).toHaveBeenCalledWith(expect.objectContaining({ ok: false }));
            expect(effect).toHaveBeenCalledTimes(1);
        } finally { await app.close(); }
    });

    it.each(['full', 'scoped'] as const)('relays a genuine Home-minted %s PAT handoff SOURCE carrier without widening original child authority', async scope => {
        const fixture = await createFixture({ qualifiedPat: false });
        const callerInputConstraints = { models: [{ agentTargetKey: 'agent:codex', providerConnectionId: null,
            modelId: 'allowed-model' }], permissionModes: ['default' as const] };
        const pat = await auth.createApiToken({ accountId: fixture.account.id, tokenId: crypto.randomUUID(), label: 'source-scoped',
            grant: { ...API_TOKEN_FULL_GRANT_V1,
                ...(scope === 'scoped' ? { actions: { families: [], ids: ['session.handoff'] } } : {}), ...callerInputConstraints } });
        const custodian = fixture.account;
        const otherActor = await db.account.create({ data: { publicKey: null, encryptionMode: 'plain' } });
        const childKey = tweetnacl.sign.keyPair();
        const parentKey = tweetnacl.sign.keyPair();
        const createMachine = (key: ReturnType<typeof tweetnacl.sign.keyPair>) => db.machine.create({ data: {
            id: crypto.randomUUID(), accountId: custodian.id, active: true,
            metadata: fixture.machine.metadata, dataEncryptionKey: fixture.machine.dataEncryptionKey,
            installationId: crypto.randomUUID(), installationPublicKey: new Uint8Array(key.publicKey),
        } });
        const child = await createMachine(childKey);
        const parent = await createMachine(parentKey);
        await inTx(tx => setMachineAccessGrantInTx(tx, { actorAccountId: custodian.id, machineId: child.id,
            principal: { kind: 'account', accountId: otherActor.id }, level: 'view' }));
        expect(await resolveMachineAdmission({ actorAccountId: otherActor.id, machineId: parent.id })).toMatchObject({ kind: 'denied' });
        const admitted = await resolveMachineAdmission({ actorAccountId: fixture.account.id, machineId: child.id, requiredRole: 'use' });
        expect(admitted).toMatchObject({ kind: 'admitted' });
        if (admitted.kind !== 'admitted') throw new Error('Genuine current child admission required');
        const { kind: _kind, ...currentAdmission } = admitted;
        const machineAdmission = { ...currentAdmission, role: 'use' as const };
        const homeId = await getOrCreateServerIdentityId();
        await db.managedMachine.create({ data: { homeId, custodianAccountId: custodian.id,
            controllerMachineId: parent.id, controllerInstallationId: parent.installationId!, enrolledMachineId: child.id,
            admittedActionRequestId: crypto.randomUUID(), admittedInput: {}, allocation: 'bound', creationState: 'active',
            launch: { provider: { pluginId: 'happier.devcontainer', localId: 'devcontainer' }, schemaVersion: 1, name: 'Signed source', choices: {} },
            retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false,
            resource: { contributionRef: { pluginId: 'happier.devcontainer', localId: 'devcontainer' }, schemaVersion: 1, value: {},
                devcontainerObservation: { nativeResourceId: 'signed-source', user: 'coder', workspaceFolder: '/child/source',
                    storage: { kind: 'bind', hostPath: '/parent/source', childPath: '/child/source' } } },
        } });
        const session = await db.session.create({ data: { accountId: fixture.account.id, tag: crypto.randomUUID(),
            metadata: '{}', encryptionMode: 'plain' } });
        await db.accessKey.create({ data: { accountId: fixture.account.id, machineId: child.id, sessionId: session.id, data: 'source-key' } });
        const presence = createSessionPublisherPresence();
        const publisher = { data: {} };
        expect((await presence.registerPublisher({ socket: publisher,
            binding: { accountId: fixture.account.id, machineId: child.id, sessionId: session.id },
            completeActivitySnapshot: { state: 'active', activeCount: 1 } })).status).toBe('registered');
        const method = `${parent.id}:${RPC_METHODS.DAEMON_WORKSPACE_SYNC_HANDOFF_SOURCE_PHASE}`;
        const effect = vi.fn(async (_event: string, _request: unknown) => ({ success: true }));
        const target = { id: 'signed-source-parent', data: { clientType: 'machine-scoped', machineId: parent.id,
            verifiedMachineInstallationId: parent.installationId }, timeout: () => ({ emitWithAck: effect }) };
        qualifyCurrentAccountStoredContentSocket(target);
        // Only Socket.IO discovery/delivery are simulated; Home mint, signatures, C41 and source binding are real.
        const io = createSocketRoomDiscoveryHarness(async room => room === getAccountSessionSocketRoom(fixture.account.id, session.id)
            ? [publisher] : room === `rpc:${custodian.id}:${method}` || room === target.id ? [target] : []);
        const resolvePublisher = (input: Readonly<{ accountId: string; sessionId: string }>) => resolveCurrentSessionMachineFromServer({ io, presence, ...input });
        const { app } = await createApp(fixture.team.id, false, resolvePublisher);
        try {
            const input = { sessionId: session.id, targetMachineId: fixture.machine.id, targetPath: '/target', accountServerId: homeId,
                workspaceAction: { kind: 'copy_once' } };
            const envelope = ExternalActionRequestEnvelopeV1Schema.parse({ v: 1, requestId: crypto.randomUUID(),
                target: { kind: 'machine', machineId: child.id }, input,
                handoffAdmission: { sessionId: session.id, sourceMachineId: child.id, targetMachineId: fixture.machine.id } });
            const minted = await app.inject({ method: 'POST', url: bindExternalActionExecutionAuthorizationHttpPathV1('session.handoff'),
                headers: { authorization: `Bearer ${pat.token}` }, payload: { v: 1, machineId: child.id, envelope } });
            expect(minted.statusCode, minted.body).toBe(200);
            const authorization = ExternalActionExecutionAuthorizationV1Schema.parse(minted.json());
            if (!('grant' in authorization.binding)) throw new Error('Original scoped PAT grant required');
            const params = 'sealed-original-source-phase';
            const requestId = authorization.binding.requestId;
            const sign = (privateKey: Uint8Array, signedParams: unknown = params) => signExternalActionMachineRpcRequestV1({
                authorizationToken: authorization.token, effectActionId: 'session.handoff', target: authorization.binding.target,
                installationId: child.installationId!, event: SOCKET_RPC_EVENTS.CALL, method, requestId, params: signedParams, privateKey });
            const execution = { v: 1 as const, authorization, effectActionId: 'session.handoff', target: authorization.binding.target,
                installationId: child.installationId!, machineSignature: sign(childKey.secretKey) };
            expect(await verifyExternalActionMachineRpcExecution(execution, { method, requestId, params,
                resolveCurrentSessionMachine: resolvePublisher })).toMatchObject({ principal: { accountId: fixture.account.id,
                credentialId: pat.tokenId, authority: 'account_automation' }, binding: { machineId: child.id } });
            expect(await verifyExternalActionMachineRpcExecution({ ...execution, machineSignature: sign(parentKey.secretKey) },
                { method, requestId, params, resolveCurrentSessionMachine: resolvePublisher })).toBeNull();
            const childAction = 'session.handoff.status.get';
            const childPath = bindExternalActionExecutionAuthorizationHttpPathV1(childAction);
            const childBody = { v: 1, machineId: fixture.machine.id, envelope: { v: 1, requestId,
                target: { kind: 'machine', machineId: fixture.machine.id }, input: { handoffId: 'scoped-pat-handoff' },
                handoffAdmission: envelope.handoffAdmission },
                handoffContinuation: { authorization, handoffId: 'scoped-pat-handoff' } };
            const childResponse = await app.inject({ method: 'POST', url: childPath, payload: childBody,
                headers: { [EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]: authorization.token,
                    [EXTERNAL_ACTION_EFFECT_ACTION_HEADER]: 'session.handoff',
                    [EXTERNAL_ACTION_RESOLVED_TARGET_HEADER]: encodeExternalActionResolvedTargetV1(authorization.binding.target),
                    [EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER]: signExternalActionMachineRequestV1({ authorizationToken: authorization.token,
                        effectActionId: 'session.handoff', target: authorization.binding.target, installationId: child.installationId!,
                        requestId, method: 'POST', path: childPath, body: childBody, privateKey: childKey.secretKey }) } });
            expect(childResponse.statusCode, childResponse.body).toBe(200);
            const childAuthorization = ExternalActionExecutionAuthorizationV1Schema.parse(childResponse.json());
            expect(childAuthorization.binding).toMatchObject({ grant: authorization.binding.grant,
                handoffContinuation: { handoffId: 'scoped-pat-handoff' } });
            expect(await verifyCurrentExternalActionPrincipal(childAuthorization.binding)).toMatchObject({
                accountId: fixture.account.id, credentialId: pat.tokenId, grant: authorization.binding.grant });
            const preparePath = bindExternalActionExecutionAuthorizationHttpPathV1('session.handoff.prepare_target');
            const requesterToken = await auth.createToken(fixture.account.id, undefined, { kind: 'account', authority: 'present_user' });
            const privatePrepare = { kind: 'requester_session_handoff_bootstrap_v1',
                input: { ...envelope.handoffAdmission, handoffId: 'scoped-pat-handoff', targetPath: '/target',
                    negotiatedTransportStrategy: 'server_routed_stream', sourceSessionStorageMode: 'persisted', endpointCandidates: [] },
                requesterBootstrap: { v: 1, disposition: 'ordinary_requester', credentials: { token: requesterToken } } };
            const parsedPrepare = SessionRequesterHandoffBootstrapRpcRequestV1Schema.safeParse(privatePrepare);
            expect(parsedPrepare.success, parsedPrepare.success ? undefined : parsedPrepare.error.message).toBe(true);
            const prepareBody = { ...childBody, envelope: { ...childBody.envelope, input: privatePrepare } };
            const issuePrepare = (payload: unknown = prepareBody) => app.inject({ method: 'POST', url: preparePath, payload,
                headers: { [EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]: authorization.token,
                    [EXTERNAL_ACTION_EFFECT_ACTION_HEADER]: 'session.handoff',
                    [EXTERNAL_ACTION_RESOLVED_TARGET_HEADER]: encodeExternalActionResolvedTargetV1(authorization.binding.target),
                    [EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER]: signExternalActionMachineRequestV1({ authorizationToken: authorization.token,
                        effectActionId: 'session.handoff', target: authorization.binding.target, installationId: child.installationId!,
                        requestId, method: 'POST', path: preparePath, body: payload, privateKey: childKey.secretKey }) } });
            const prepared = await issuePrepare();
            expect(prepared.statusCode, prepared.body).toBe(200);
            const preparedAuthorization = ExternalActionExecutionAuthorizationV1Schema.parse(prepared.json());
            expect(preparedAuthorization.binding).toMatchObject({
                actionId: 'session.handoff.prepare_target', grant: authorization.binding.grant });
            const prepareMethod = `${fixture.machine.id}:${RPC_METHODS.DAEMON_SESSION_HANDOFF_PREPARE_TARGET_V3}`;
            const prepareRpc = (privateKey: Uint8Array) => ({ v: 1 as const, authorization: preparedAuthorization,
                effectActionId: 'session.handoff.prepare_target', target: preparedAuthorization.binding.target,
                installationId: preparedAuthorization.binding.installationId,
                machineSignature: signExternalActionMachineRpcRequestV1({ authorizationToken: preparedAuthorization.token,
                    effectActionId: 'session.handoff.prepare_target', target: preparedAuthorization.binding.target,
                    installationId: preparedAuthorization.binding.installationId, event: SOCKET_RPC_EVENTS.CALL,
                    method: prepareMethod, requestId, params: privatePrepare, privateKey }) });
            expect(await verifyExternalActionMachineRpcExecution(prepareRpc(childKey.secretKey), {
                method: prepareMethod, requestId, params: privatePrepare, resolveCurrentSessionMachine: resolvePublisher })).toMatchObject({
                principal: { accountId: fixture.account.id, credentialId: pat.tokenId }, binding: { actionId: 'session.handoff.prepare_target' } });
            expect(await verifyExternalActionMachineRpcExecution(prepareRpc(fixture.keyPair.secretKey), {
                method: prepareMethod, requestId, params: privatePrepare, resolveCurrentSessionMachine: resolvePublisher })).toBeNull();
            const preparedVerifyPath = bindExternalActionExecutionAuthorizationVerifyHttpPathV1('session.handoff.prepare_target');
            const verifyPrepared = (privateKey: Uint8Array) => app.inject({ method: 'POST', url: preparedVerifyPath, payload: { v: 1 }, headers: {
                [EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]: preparedAuthorization.token,
                [EXTERNAL_ACTION_EFFECT_ACTION_HEADER]: 'session.handoff.prepare_target',
                [EXTERNAL_ACTION_RESOLVED_TARGET_HEADER]: encodeExternalActionResolvedTargetV1(preparedAuthorization.binding.target),
                [EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER]: signExternalActionMachineRequestV1({ authorizationToken: preparedAuthorization.token,
                    effectActionId: 'session.handoff.prepare_target', target: preparedAuthorization.binding.target,
                    installationId: preparedAuthorization.binding.installationId, requestId, method: 'POST',
                    path: preparedVerifyPath, body: { v: 1 }, privateKey }),
            } });
            expect((await verifyPrepared(childKey.secretKey)).statusCode).toBe(200);
            expect((await verifyPrepared(fixture.keyPair.secretKey)).statusCode).toBe(200);
            expect((await app.inject({ method: 'POST', url: preparePath, headers: { authorization: `Bearer ${pat.token}` },
                payload: { v: 1, machineId: fixture.machine.id, envelope: prepareBody.envelope } })).statusCode).toBe(401);
            expect((await issuePrepare({ ...prepareBody, envelope: { ...prepareBody.envelope, input: {
                ...privatePrepare, input: { ...privatePrepare.input, sessionId: 'unrelated-session' } } } })).statusCode).toBe(401);
            if (scope === 'full') {
            // The envelope keeps its entire protected-input budget; the original
            // proof is additional transport framing, not a cut from that input.
            const sealedEnvelope = { v: 2 as const, requestId, target: childBody.envelope.target,
                payload: { t: 'encrypted' as const, c: '' }, handoffAdmission: envelope.handoffAdmission };
            sealedEnvelope.payload.c = 'a'.repeat(EXTERNAL_ACTION_HTTP_BODY_LIMIT_BYTES_V2
                - Buffer.byteLength(JSON.stringify(sealedEnvelope), 'utf8'));
            const sealedBody = { ...childBody, envelope: sealedEnvelope };
            const sealedResponse = await app.inject({ method: 'POST', url: childPath, payload: sealedBody,
                headers: { [EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]: authorization.token,
                    [EXTERNAL_ACTION_EFFECT_ACTION_HEADER]: 'session.handoff',
                    [EXTERNAL_ACTION_RESOLVED_TARGET_HEADER]: encodeExternalActionResolvedTargetV1(authorization.binding.target),
                    [EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER]: signExternalActionMachineRequestV1({ authorizationToken: authorization.token,
                        effectActionId: 'session.handoff', target: authorization.binding.target, installationId: child.installationId!,
                        requestId, method: 'POST', path: childPath, body: sealedBody, privateKey: childKey.secretKey }) } });
            expect(sealedResponse.statusCode, sealedResponse.body).toBe(200);
            }
            const token = await auth.createToken(custodian.id, undefined, { kind: 'account', authority: 'present_user' });
            const socket = Object.assign(createFakeSocket({ id: 'signed-child-source', data: { clientType: 'machine-scoped',
                machineId: child.id, verifiedMachineInstallationId: child.installationId, authTokenKind: 'account', authAuthority: 'present_user' } }),
            { handshake: { auth: { token } } });
            qualifyCurrentAccountStoredContentSocket(socket);
            registerSocketRpcHandlers({ userId: custodian.id, socket: socket as unknown as Socket, io, sessionPublisherPresence: presence });
            const workspaceSyncSourceRouting = { v: 1, phase: 'prepare', operationId: crypto.randomUUID(), accountServerId: homeId,
                sourceMachineId: child.id, sourceRootPath: '/child/source', sourceSessionId: session.id,
                sourceContext: { machineAdmission, callerAuthority: 'account_automation',
                    callerInputConstraints } };
            const call = (callParams: unknown = params, sourceRouting: unknown = workspaceSyncSourceRouting) => getSocketHandler(socket, SOCKET_RPC_EVENTS.CALL)({ method, requestId,
                params: callParams, externalActionExecution: execution, workspaceSyncSourceRouting: sourceRouting }, callback);
            const callback = vi.fn();
            await call();
            expect(callback).toHaveBeenCalledWith({ ok: true, result: { success: true } });
            expect(effect.mock.calls[0]?.[1]).toMatchObject({ machineAdmission, callerAuthority: 'account_automation',
                workspaceSyncSourceRouting, callerInputConstraints, callerInputAuthorization: authorization });
            const unboundOrigin = SessionActionRpcOriginV1Schema.parse({ v: 1,
                caller: { kind: 'session', sessionId: session.id, starterDepth: 0, turnDepth: 0 },
                sourceTurnId: 'unbound-turn', requestId, callerPermissionMode: 'default',
                causalPermissionAuthority: { kind: 'admittedSessionInputV1', admittedPermissionCeiling: 'default' } });
            callback.mockClear();
            await call(params, { ...workspaceSyncSourceRouting, sourceContext: { ...workspaceSyncSourceRouting.sourceContext,
                sessionActionOrigin: unboundOrigin } });
            expect(callback).toHaveBeenCalledWith(expect.objectContaining({ ok: false }));
            expect(effect).toHaveBeenCalledTimes(1);
            callback.mockClear();
            await call(params, { ...workspaceSyncSourceRouting, sourceMachineId: fixture.machine.id });
            expect(callback).toHaveBeenCalledWith(expect.objectContaining({ ok: false }));
            callback.mockClear();
            await call(params, { ...workspaceSyncSourceRouting, sourceSessionId: 'substituted-source-session' });
            expect(callback).toHaveBeenCalledWith(expect.objectContaining({ ok: false }));
            callback.mockClear();
            await call(params, { ...workspaceSyncSourceRouting, sourceContext: { ...workspaceSyncSourceRouting.sourceContext,
                machineAdmission: { ...machineAdmission, actorAccountId: otherActor.id } } });
            expect(callback).toHaveBeenCalledWith(expect.objectContaining({ ok: false }));
            callback.mockClear();
            await call(params, { ...workspaceSyncSourceRouting, sourceContext: { ...workspaceSyncSourceRouting.sourceContext,
                callerAuthority: 'present_user' } });
            expect(callback).toHaveBeenCalledWith(expect.objectContaining({ ok: false }));
            callback.mockClear();
            await call(params, { ...workspaceSyncSourceRouting, sourceContext: { ...workspaceSyncSourceRouting.sourceContext,
                callerInputConstraints: { models: null, permissionModes: null } } });
            expect(callback).toHaveBeenCalledWith(expect.objectContaining({ ok: false }));
            callback.mockClear();
            await call('substituted-source-phase');
            expect(callback).toHaveBeenCalledWith(expect.objectContaining({ ok: false }));
            callback.mockClear();
            await getSocketHandler(socket, SOCKET_RPC_EVENTS.CALL)({
                method: `${parent.id}:${RPC_METHODS.DAEMON_SESSION_HANDOFF_PREPARE_TARGET_V3}`, requestId, params,
                externalActionExecution: execution, workspaceSyncSourceRouting }, callback);
            expect(callback).toHaveBeenCalledWith(expect.objectContaining({ ok: false }));
            expect(effect).toHaveBeenCalledTimes(1);
            await auth.revokeApiToken({ accountId: fixture.account.id, tokenId: pat.tokenId });
            callback.mockClear();
            await call();
            expect(callback).toHaveBeenCalledWith(expect.objectContaining({ ok: false }));
            const releaseRouting = { ...workspaceSyncSourceRouting, phase: 'abort' };
            callback.mockClear();
            // Release uses the installed custodian's existing SOURCE attestation,
            // never the retired borrower bearer and never an unsigned fresh effect.
            await getSocketHandler(socket, SOCKET_RPC_EVENTS.CALL)({ method, params: 'sealed-retained-source-abort',
                workspaceSyncSourceRouting: releaseRouting }, callback);
            expect(callback).toHaveBeenCalledWith({ ok: true, result: { success: true } });
            expect(effect.mock.calls[1]?.[1]).toMatchObject({ machineAdmission,
                workspaceSyncSourceRouting: releaseRouting, callerAuthority: 'account_automation', callerInputConstraints });
            expect(effect.mock.calls[1]?.[1]).not.toHaveProperty('callerInputAuthorization');
            expect(effect).toHaveBeenCalledTimes(2);
        } finally { await app.close(); }
    });

    it('admits an original Account catalog Machine Action only under its current named Manage policy', async () => {
        const fixture = await createFixture({ qualifiedPat: false });
        const custodian = await db.account.create({ data: { publicKey: null, encryptionMode: 'plain' } });
        const keys = tweetnacl.sign.keyPair();
        const machine = await db.machine.create({ data: { id: crypto.randomUUID(), accountId: custodian.id,
            metadata: fixture.machine.metadata, dataEncryptionKey: fixture.machine.dataEncryptionKey,
            installationId: crypto.randomUUID(), installationPublicKey: new Uint8Array(keys.publicKey) } });
        await inTx(tx => setMachineAccessGrantInTx(tx, { actorAccountId: custodian.id, machineId: machine.id,
            principal: { kind: 'account', accountId: fixture.account.id }, level: 'admin' }));
        const actionId = 'machines.work.summary.get';
        const homeId = await getOrCreateServerIdentityId();
        const envelope = { v: 1 as const, requestId: crypto.randomUUID(), target: { kind: 'machine' as const, machineId: machine.id },
            input: { serverId: homeId, machineId: machine.id } };
        const token = await auth.createToken(fixture.account.id, undefined, { kind: 'account', authority: 'present_user' });
        const { app } = await createApp(fixture.team.id);
        const issue = () => app.inject({ method: 'POST', url: bindExternalActionExecutionAuthorizationHttpPathV1(actionId),
            headers: { authorization: `Bearer ${token}` }, payload: { v: 1, machineId: machine.id, envelope } });
        try {
            const issued = await issue();
            expect(issued.statusCode, issued.body).toBe(200);
            const root = ExternalActionExecutionAuthorizationV1Schema.parse(issued.json());
            expect(root.binding).toMatchObject({ accountId: fixture.account.id, custodianAccountId: custodian.id,
                accountEncryptionMode: 'plain', actionId, machineId: machine.id, installationId: machine.installationId });
            const path = bindExternalActionExecutionAuthorizationVerifyHttpPathV1(actionId);
            const verify = () => app.inject({ method: 'POST', url: path, payload: { v: 1 }, headers: {
                [EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]: root.token,
                [EXTERNAL_ACTION_EFFECT_ACTION_HEADER]: actionId,
                [EXTERNAL_ACTION_RESOLVED_TARGET_HEADER]: encodeExternalActionResolvedTargetV1(root.binding.target),
                [EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER]: signExternalActionMachineRequestV1({ authorizationToken: root.token,
                    effectActionId: actionId, target: root.binding.target, installationId: root.binding.installationId,
                    requestId: root.binding.requestId, method: 'POST', path, body: { v: 1 }, privateKey: keys.secretKey }),
            } });
            expect((await verify()).statusCode).toBe(200);
            await inTx(tx => setMachineAccessGrantInTx(tx, { actorAccountId: custodian.id, machineId: machine.id,
                principal: { kind: 'account', accountId: fixture.account.id }, level: 'view' }));
            expect((await verify()).statusCode).toBe(401);
            const denied = await issue();
            expect(denied.statusCode, denied.body).toBe(409);
            expect(denied.json()).toMatchObject({ error: 'invalid_request', code: 'target_unavailable' });
        } finally { await app.close(); }
    });

    it.each(['owned', 'shared-use'] as const)('admits only a fresh reviewer approval root and preserves its exact decision replay with %s access', async access => {
        const fixture = await createFixture({ qualifiedPat: false });
        const custodian = access === 'owned' ? fixture.account
            : await db.account.create({ data: { publicKey: null, encryptionMode: 'plain' } });
        const targetKeys = access === 'owned' ? fixture.keyPair : tweetnacl.sign.keyPair();
        const targetMachine = access === 'owned' ? fixture.machine : await db.machine.create({ data: {
            id: crypto.randomUUID(), accountId: custodian.id, metadata: fixture.machine.metadata,
            dataEncryptionKey: fixture.machine.dataEncryptionKey, installationId: crypto.randomUUID(),
            installationPublicKey: new Uint8Array(targetKeys.publicKey),
        } });
        if (access === 'shared-use') await inTx(tx => setMachineAccessGrantInTx(tx, { actorAccountId: custodian.id,
            machineId: targetMachine.id, principal: { kind: 'account', accountId: fixture.account.id }, level: 'view' }));
        const session = await db.session.create({ data: { accountId: fixture.account.id, tag: crypto.randomUUID(),
            metadata: '{}', encryptionMode: 'plain' } });
        await db.accessKey.create({ data: { accountId: fixture.account.id, machineId: fixture.machine.id,
            sessionId: session.id, data: 'opaque-approval-source' } });
        const presence = createSessionPublisherPresence();
        const publisher = { data: {} };
        expect((await presence.registerPublisher({ socket: publisher,
            binding: { accountId: fixture.account.id, machineId: fixture.machine.id, sessionId: session.id },
            completeActivitySnapshot: { state: 'active', activeCount: 1 } })).status).toBe('registered');
        const io = createSocketRoomDiscoveryHarness(async room => room === getAccountSessionSocketRoom(fixture.account.id, session.id) ? [publisher] : []);
        const resolvePublisher = (input: Readonly<{ accountId: string; sessionId: string }>) => resolveCurrentSessionMachineFromServer({ io, presence, ...input });
        const { app, dispatchedPrincipals } = await createApp(fixture.team.id, false, resolvePublisher);
        const token = await auth.createToken(fixture.account.id, undefined, { kind: 'account', authority: 'present_user' });
        const actionId = 'approval.request.decide';
        const homeId = await getOrCreateServerIdentityId();
        const envelope = { v: 1 as const, requestId: crypto.randomUUID(),
            target: { kind: 'machine' as const, machineId: targetMachine.id },
            input: { artifactId: 'private-requester-approval', decision: 'approve', serverIdentityId: homeId } };
        const body = { v: 1, machineId: targetMachine.id, envelope };
        const issue = (credential: string, payload: unknown = body) => app.inject({ method: 'POST',
            url: bindExternalActionExecutionAuthorizationHttpPathV1(actionId), headers: { authorization: `Bearer ${credential}` }, payload });
        try {
            const issued = await issue(token);
            expect(issued.statusCode, issued.body).toBe(200);
            const root = ExternalActionExecutionAuthorizationV1Schema.parse(issued.json());
            expect(root.binding).toMatchObject({ actionId, accountId: fixture.account.id,
                machineId: targetMachine.id, custodianAccountId: custodian.id,
                requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope) });
            expect(await verifyCurrentExternalActionPrincipal(root.binding)).toMatchObject({ accountId: fixture.account.id, authority: 'present_user' });
            const verifyPath = bindExternalActionExecutionAuthorizationVerifyHttpPathV1(actionId);
            const signed = (path: string, payload: unknown) => ({
                [EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]: root.token,
                [EXTERNAL_ACTION_EFFECT_ACTION_HEADER]: actionId,
                [EXTERNAL_ACTION_RESOLVED_TARGET_HEADER]: encodeExternalActionResolvedTargetV1(root.binding.target),
                [EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER]: signExternalActionMachineRequestV1({ authorizationToken: root.token,
                    effectActionId: actionId, target: root.binding.target, installationId: root.binding.installationId,
                    requestId: root.binding.requestId, method: 'POST', path, body: payload, privateKey: targetKeys.secretKey }),
            });
            expect((await app.inject({ method: 'POST', url: verifyPath, payload: { v: 1 }, headers: signed(verifyPath, { v: 1 }) })).statusCode).toBe(200);
            const relayPath = `/v1/actions/${actionId}`;
            const relayBody = { ...body, executionAuthorization: root };
            expect((await app.inject({ method: 'POST', url: relayPath, payload: relayBody, headers: signed(relayPath, relayBody) })).statusCode).toBe(200);
            expect(dispatchedPrincipals).toEqual([expect.objectContaining({ accountId: fixture.account.id, authority: 'present_user' })]);
            const substituted = { ...relayBody, envelope: { ...envelope, input: { ...envelope.input, artifactId: 'another-approval' } } };
            expect((await app.inject({ method: 'POST', url: relayPath, payload: substituted, headers: signed(relayPath, substituted) })).statusCode).toBe(401);
            expect((await issue(fixture.pat.token)).statusCode).toBe(403);
            const approvalPat = await auth.createApiToken({ accountId: fixture.account.id, tokenId: crypto.randomUUID(), label: 'explicit-reviewer',
                grant: { ...API_TOKEN_FULL_GRANT_V1, approve: true, actions: { families: [], ids: [actionId] } } });
            expect((await issue(approvalPat.token)).statusCode).toBe(200);
            const origin = SessionActionRpcOriginV1Schema.parse({ v: 1,
                caller: { kind: 'session', sessionId: session.id, starterDepth: 1, turnDepth: 2 }, sourceTurnId: 'original-agent-turn',
                requestId: envelope.requestId, callerPermissionMode: 'default' });
            const source = { machineId: fixture.machine.id, installationId: fixture.machine.installationId! };
            const installationProof = signMachineInstallationProof({ privateKey: fixture.keyPair.secretKey,
                payload: { version: 1, accountId: fixture.account.id, ...source,
                    externalActionOrigin: { homeId, actionId, requestId: envelope.requestId,
                        requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope), origin } } });
            expect((await issue(token, { ...body, sessionActionOrigin: origin, sessionActionSource: source, installationProof })).statusCode).toBe(403);
            await db.machine.update({ where: { id: targetMachine.id }, data: { installationId: 'retired-reviewer-target' } });
            expect((await app.inject({ method: 'POST', url: verifyPath, payload: { v: 1 }, headers: signed(verifyPath, { v: 1 }) })).statusCode).toBe(401);
            await db.machine.update({ where: { id: targetMachine.id }, data: { installationId: targetMachine.installationId } });
            if (access === 'shared-use') {
                await inTx(tx => removeMachineAccessGrantInTx(tx, { actorAccountId: custodian.id, machineId: targetMachine.id,
                    principal: { kind: 'account', accountId: fixture.account.id } }));
                expect((await app.inject({ method: 'POST', url: verifyPath, payload: { v: 1 }, headers: signed(verifyPath, { v: 1 }) })).statusCode).toBe(401);
                await inTx(tx => setMachineAccessGrantInTx(tx, { actorAccountId: custodian.id, machineId: targetMachine.id,
                    principal: { kind: 'account', accountId: fixture.account.id }, level: 'view' }));
            }
            await db.account.update({ where: { id: fixture.account.id }, data: { tokenEpoch: { increment: 1 } } });
            expect((await app.inject({ method: 'POST', url: verifyPath, payload: { v: 1 }, headers: signed(verifyPath, { v: 1 }) })).statusCode).toBe(401);
        } finally { await app.close(); }
    });

    it('rechecks signed requester Session custody without enabling foreign raw Session creation', async () => {
        const fixture = await createFixture({ qualifiedPat: false });
        const custodian = await db.account.create({ data: { publicKey: null, encryptionMode: 'plain' } });
        const keys = tweetnacl.sign.keyPair();
        const machine = await db.machine.create({ data: { id: crypto.randomUUID(), accountId: custodian.id,
            metadata: fixture.machine.metadata, dataEncryptionKey: fixture.machine.dataEncryptionKey,
            installationId: crypto.randomUUID(), installationPublicKey: new Uint8Array(keys.publicKey) } });
        await inTx(tx => setMachineAccessGrantInTx(tx, { actorAccountId: custodian.id, machineId: machine.id,
            principal: { kind: 'account', accountId: fixture.account.id }, level: 'view' }));
        const session = await db.session.create({ data: { accountId: fixture.account.id, tag: crypto.randomUUID(),
            metadata: '{}', encryptionMode: 'plain' } });
        await db.accessKey.create({ data: { accountId: fixture.account.id, machineId: machine.id,
            sessionId: session.id, data: 'opaque-requester-custody' } });
        const admitted = await resolveMachineAdmission({ actorAccountId: fixture.account.id, machineId: machine.id, requiredRole: 'use' });
        expect(admitted.kind).toBe('admitted');
        if (admitted.kind !== 'admitted') throw new Error('Current generic C41 Use is required by the fixture');
        const context = { actorAccountId: fixture.account.id, custodianAccountId: custodian.id, machineId: machine.id,
            installationId: machine.installationId!, role: admitted.role, encryptionMode: admitted.encryptionMode };
        const purpose = { kind: 'requester_session_currentness', sessionId: session.id };
        const daemonToken = await auth.createToken(custodian.id, undefined, { kind: 'account', authority: 'present_user' });
        const { app } = await createApp(fixture.team.id);
        const verify = (selectedPurpose: unknown = purpose, selectedContext = context) => {
            const payload = MachineInstallationProofPayloadV1Schema.parse({ version: 1, machineId: machine.id,
                installationId: machine.installationId!, accountId: custodian.id, rpcAdmission: { context: selectedContext, purpose: selectedPurpose } });
            return app.inject({ method: 'POST', url: `/v1/machines/${machine.id}/admission/verify`,
                headers: { authorization: `Bearer ${daemonToken}` }, payload: { v: 1, context: selectedContext,
                    purpose: selectedPurpose, proof: signMachineInstallationProof({ payload, privateKey: keys.secretKey }) } });
        };
        try {
            const current = await verify();
            expect(current.statusCode, current.body).toBe(200);
            const method = `${machine.id}:${RPC_METHODS.SPAWN_HAPPY_SESSION}`;
            const raw = await app.inject({ method: 'POST', url: `/v1/machines/${machine.id}/admission/verify`,
                headers: { authorization: `Bearer ${daemonToken}` }, payload: { v: 1, context, method,
                    proof: signMachineInstallationProof({ privateKey: keys.secretKey, payload: { version: 1,
                        machineId: machine.id, installationId: machine.installationId!, accountId: custodian.id,
                        rpcAdmission: { context, method } } }) } });
            expect(raw.statusCode).toBe(403);
            expect((await verify({ ...purpose, sessionId: 'another-session' })).statusCode).toBe(403);
            expect((await verify(purpose, { ...context, actorAccountId: custodian.id })).statusCode).toBe(403);
            expect((await verify(purpose, { ...context, role: 'manage' })).statusCode).toBe(403);
            await db.machine.update({ where: { id: machine.id }, data: { installationId: 'replacement' } });
            expect((await verify()).statusCode).toBe(403);
            await db.machine.update({ where: { id: machine.id }, data: { installationId: machine.installationId } });
            await inTx(tx => removeMachineAccessGrantInTx(tx, { actorAccountId: custodian.id, machineId: machine.id,
                principal: { kind: 'account', accountId: fixture.account.id } }));
            expect((await verify()).statusCode).toBe(403);
            await inTx(tx => setMachineAccessGrantInTx(tx, { actorAccountId: custodian.id, machineId: machine.id,
                principal: { kind: 'account', accountId: fixture.account.id }, level: 'view' }));
            await db.accessKey.deleteMany({ where: { accountId: fixture.account.id, machineId: machine.id, sessionId: session.id } });
            expect((await verify()).statusCode).toBe(403);
        } finally { await app.close(); }
    });

    it('continues only the exact Home-issued Session handoff after its original publisher quiesces', async () => {
        const fixture = await createFixture({ qualifiedPat: false });
        const custodian = await db.account.create({ data: { publicKey: null, encryptionMode: 'plain' } });
        const destinationKeys = tweetnacl.sign.keyPair();
        const destination = await db.machine.create({ data: { id: crypto.randomUUID(), accountId: custodian.id,
            metadata: fixture.machine.metadata, dataEncryptionKey: fixture.machine.dataEncryptionKey,
            installationId: crypto.randomUUID(), installationPublicKey: new Uint8Array(destinationKeys.publicKey) } });
        await inTx(tx => setMachineAccessGrantInTx(tx, { actorAccountId: custodian.id, machineId: destination.id,
            principal: { kind: 'account', accountId: fixture.account.id }, level: 'view' }));
        const session = await db.session.create({ data: { accountId: fixture.account.id, tag: crypto.randomUUID(),
            metadata: '{}', encryptionMode: 'plain' } });
        await db.accessKey.create({ data: { accountId: fixture.account.id, machineId: fixture.machine.id,
            sessionId: session.id, data: 'opaque-handoff-key' } });
        const presence = createSessionPublisherPresence();
        const publisher = { data: {} };
        expect((await presence.registerPublisher({ socket: publisher,
            binding: { accountId: fixture.account.id, machineId: fixture.machine.id, sessionId: session.id },
            completeActivitySnapshot: { state: 'active', activeCount: 1 } })).status).toBe('registered');
        let publisherVisible = true;
        const io = { in: (room: string) => ({ fetchSockets: async () => publisherVisible
            && room === getAccountSessionSocketRoom(fixture.account.id, session.id) ? [publisher] : [] }) } as unknown as Server;
        const resolvePublisher = (input: Readonly<{ accountId: string; sessionId: string }>) => resolveCurrentSessionMachineFromServer({ io, presence, ...input });
        const { app } = await createApp(fixture.team.id, false, resolvePublisher);
        const token = await auth.createToken(fixture.account.id, undefined, { kind: 'account', authority: 'present_user' });
        const homeId = await getOrCreateServerIdentityId();
        const origin = SessionActionRpcOriginV1Schema.parse({ v: 1, caller: { kind: 'session', sessionId: session.id, starterDepth: 1, turnDepth: 2 },
            sourceTurnId: 'handoff-turn', callerPermissionMode: 'default',
            causalPermissionAuthority: { kind: 'admittedSessionInputV1', admittedPermissionCeiling: 'default' }, requestId: crypto.randomUUID() });
        const admission = { sessionId: session.id, sourceMachineId: fixture.machine.id, targetMachineId: destination.id };
        const source = { machineId: fixture.machine.id, installationId: fixture.machine.installationId! };
        const rootEnvelope = { v: 1 as const, requestId: origin.requestId, target: { kind: 'machine' as const, machineId: fixture.machine.id },
            input: { ...admission, targetPath: '/workspace/project' }, handoffAdmission: admission };
        const installationProof = signMachineInstallationProof({ privateKey: fixture.keyPair.secretKey,
            payload: { version: 1, accountId: fixture.account.id, ...source, externalActionOrigin: { homeId, actionId: 'session.handoff',
                requestId: origin.requestId, requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(rootEnvelope), origin } } });
        try {
            const rootResponse = await app.inject({ method: 'POST', url: bindExternalActionExecutionAuthorizationHttpPathV1('session.handoff'),
                headers: { authorization: `Bearer ${token}` }, payload: { v: 1, machineId: fixture.machine.id, envelope: rootEnvelope,
                    sessionActionOrigin: origin, sessionActionSource: source, installationProof } });
            expect(rootResponse.statusCode, rootResponse.body).toBe(200);
            const root = ExternalActionExecutionAuthorizationV1Schema.parse(rootResponse.json());
            expect(root.binding).toMatchObject({ handoffAdmission: { ...admission,
                sourceInstallationId: source.installationId, targetInstallationId: destination.installationId }, sessionActionOrigin: origin });
            publisherVisible = false;
            expect(await resolvePublisher({ accountId: fixture.account.id, sessionId: session.id })).toBeNull();
            const actionId = 'session.handoff.status.get';
            const handoffId = 'accepted-handoff';
            const envelope = { v: 1, requestId: root.binding.requestId, target: { kind: 'machine', machineId: destination.id },
                input: { handoffId }, handoffAdmission: admission };
            const path = bindExternalActionExecutionAuthorizationHttpPathV1(actionId);
            const body = { v: 1, machineId: destination.id, envelope, handoffContinuation: { authorization: root, handoffId } };
            const issueChild = (payload: unknown = body) => app.inject({ method: 'POST', url: path, payload,
                headers: { [EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]: root.token,
                    [EXTERNAL_ACTION_EFFECT_ACTION_HEADER]: 'session.handoff',
                    [EXTERNAL_ACTION_RESOLVED_TARGET_HEADER]: encodeExternalActionResolvedTargetV1(root.binding.target),
                    [EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER]: signExternalActionMachineRequestV1({ authorizationToken: root.token,
                        effectActionId: 'session.handoff', target: root.binding.target, installationId: root.binding.installationId,
                        requestId: root.binding.requestId, method: 'POST', path, body: payload, privateKey: fixture.keyPair.secretKey }) } });
            const childResponse = await issueChild();
            expect(childResponse.statusCode, childResponse.body).toBe(200);
            const child = ExternalActionExecutionAuthorizationV1Schema.parse(childResponse.json());
            expect(child.binding).toMatchObject({ actionId, machineId: destination.id, installationId: destination.installationId,
                requestId: root.binding.requestId, sessionActionOrigin: origin, handoffAdmission: { ...admission,
                    sourceInstallationId: source.installationId, targetInstallationId: destination.installationId },
                handoffContinuation: { rootRequestId: root.binding.requestId,
                    rootRequestEnvelopeDigest: root.binding.requestEnvelopeDigest, handoffId } });
            expect(await verifyCurrentExternalActionPrincipal(child.binding)).toMatchObject({ authority: 'account_automation', sessionActionOrigin: origin });
            const rpcMethod = `${destination.id}:${RPC_METHODS.DAEMON_SESSION_HANDOFF_STATUS_GET_V3}`;
            const rpcRequestId = crypto.randomUUID();
            const rpcParams = 'sealed-exact-handoff-status';
            const rpcSignature = (privateKey: Uint8Array) => signExternalActionMachineRpcRequestV1({
                authorizationToken: child.token, effectActionId: actionId, target: child.binding.target,
                installationId: child.binding.installationId, event: SOCKET_RPC_EVENTS.CALL, method: rpcMethod,
                requestId: rpcRequestId, params: rpcParams, privateKey });
            const execution = { v: 1 as const, authorization: child, effectActionId: actionId, target: child.binding.target,
                installationId: child.binding.installationId, machineSignature: rpcSignature(fixture.keyPair.secretKey) };
            expect(await verifyExternalActionMachineRpcExecution(execution, { method: rpcMethod, requestId: rpcRequestId,
                params: rpcParams, resolveCurrentSessionMachine: resolvePublisher })).toMatchObject({
                principal: { accountId: fixture.account.id, authority: 'account_automation', sessionActionOrigin: origin },
                binding: { machineId: destination.id, handoffContinuation: { handoffId } } });
            expect(await verifyExternalActionMachineRpcExecution({ ...execution,
                machineSignature: rpcSignature(destinationKeys.secretKey) }, { method: rpcMethod, requestId: rpcRequestId,
                params: rpcParams, resolveCurrentSessionMachine: resolvePublisher })).toBeNull();
            const resumePath = bindExternalActionExecutionAuthorizationHttpPathV1('session.spawn_new');
            const resumeBody = { ...body, envelope: { ...envelope, input: { type: 'resume-session', sessionId: session.id } } };
            const issueResume = (payload: unknown = resumeBody) => app.inject({ method: 'POST', url: resumePath, payload,
                headers: { [EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]: root.token,
                    [EXTERNAL_ACTION_EFFECT_ACTION_HEADER]: 'session.handoff',
                    [EXTERNAL_ACTION_RESOLVED_TARGET_HEADER]: encodeExternalActionResolvedTargetV1(root.binding.target),
                    [EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER]: signExternalActionMachineRequestV1({ authorizationToken: root.token,
                        effectActionId: 'session.handoff', target: root.binding.target, installationId: root.binding.installationId,
                        requestId: root.binding.requestId, method: 'POST', path: resumePath, body: payload, privateKey: fixture.keyPair.secretKey }) } });
            const resumed = await issueResume();
            expect(resumed.statusCode, resumed.body).toBe(200);
            const resume = ExternalActionExecutionAuthorizationV1Schema.parse(resumed.json());
            expect(resume.binding).toMatchObject({ actionId: 'session.spawn_new', sessionActionOrigin: origin, handoffAdmission: child.binding.handoffAdmission });
            for (const methodId of [RPC_METHODS.SPAWN_HAPPY_SESSION, RPC_METHODS.DAEMON_SPAWN_SESSION_RESOLVE]) {
                const method = `${destination.id}:${methodId}`;
                const params = 'sealed-resume-or-original-nonce';
                const resumeExecution = { ...execution, authorization: resume, effectActionId: 'session.spawn_new',
                    machineSignature: signExternalActionMachineRpcRequestV1({ authorizationToken: resume.token,
                        effectActionId: 'session.spawn_new', target: resume.binding.target, installationId: resume.binding.installationId,
                        event: SOCKET_RPC_EVENTS.CALL, method, requestId: rpcRequestId, params, privateKey: fixture.keyPair.secretKey }) };
                expect(await verifyExternalActionMachineRpcExecution(resumeExecution, { method, requestId: rpcRequestId,
                    params, resolveCurrentSessionMachine: resolvePublisher })).toMatchObject({ principal: { authority: 'account_automation', sessionActionOrigin: origin } });
            }
            expect((await issueResume({ ...resumeBody, envelope: { ...envelope, input: { type: 'resume-session', sessionId: 'different-session' } } })).statusCode).toBe(401);
            expect((await issueResume({ ...resumeBody, envelope: { ...envelope, input: { type: 'new-session' } } })).statusCode).toBe(401);
            expect((await issueResume({ ...resumeBody, machineId: fixture.machine.id,
                envelope: { ...resumeBody.envelope, target: root.binding.target } })).statusCode).toBe(401);
            expect((await issueChild({ ...body, envelope: { ...envelope, input: { handoffId: 'substituted-handoff' } } })).statusCode).toBe(401);
            expect((await issueChild({ ...body, envelope: { ...envelope, handoffAdmission: { ...admission, sessionId: 'another-session' } } })).statusCode).toBe(401);
            expect((await issueChild({ ...body, handoffContinuation: { authorization: { ...root,
                binding: { ...root.binding, actionId: 'projects.open' } }, handoffId } })).statusCode).toBe(401);
            await db.machine.update({ where: { id: destination.id }, data: { installationId: 'replacement-target-installation' } });
            expect((await issueChild()).statusCode).toBe(401);
            await db.machine.update({ where: { id: destination.id }, data: { installationId: destination.installationId } });
            await db.machine.update({ where: { id: fixture.machine.id }, data: { installationId: 'replacement-source-installation' } });
            expect((await issueChild()).statusCode).toBe(401);
            await db.machine.update({ where: { id: fixture.machine.id }, data: { installationId: fixture.machine.installationId } });
            await inTx(tx => removeMachineAccessGrantInTx(tx, { actorAccountId: custodian.id, machineId: destination.id,
                principal: { kind: 'account', accountId: fixture.account.id } }));
            expect((await issueChild()).statusCode).toBe(401);
            await inTx(tx => setMachineAccessGrantInTx(tx, { actorAccountId: custodian.id, machineId: destination.id,
                principal: { kind: 'account', accountId: fixture.account.id }, level: 'view' }));
            await db.account.update({ where: { id: fixture.account.id }, data: { tokenEpoch: { increment: 1 } } });
            expect((await issueChild()).statusCode).toBe(401);
            await db.account.update({ where: { id: fixture.account.id }, data: { tokenEpoch: fixture.account.tokenEpoch } });
            await db.accessKey.deleteMany({ where: { accountId: fixture.account.id, machineId: fixture.machine.id, sessionId: session.id } });
            expect((await issueChild()).statusCode).toBe(401);
        } finally { await app.close(); }
    });

    it.each(['projects.open', 'machines.managed.acquire'] as const)('verifies and relays the original Session source proof to a different admitted Machine for %s', async actionId => {
        const fixture = await createFixture({ qualifiedPat: false });
        const custodian = await db.account.create({ data: { publicKey: null, encryptionMode: 'plain' } });
        const destinationKeys = tweetnacl.sign.keyPair();
        const destination = await db.machine.create({ data: { id: crypto.randomUUID(), accountId: custodian.id,
            metadata: fixture.machine.metadata, dataEncryptionKey: fixture.machine.dataEncryptionKey, active: true,
            installationId: crypto.randomUUID(), installationPublicKey: new Uint8Array(destinationKeys.publicKey) } });
        await inTx(tx => setMachineAccessGrantInTx(tx, { actorAccountId: custodian.id, machineId: destination.id,
            principal: { kind: 'account', accountId: fixture.account.id }, level: actionId === 'machines.managed.acquire' ? 'admin' : 'view' }));
        const session = await db.session.create({ data: { accountId: fixture.account.id, tag: crypto.randomUUID(),
            metadata: '{}', encryptionMode: 'plain' } });
        await db.accessKey.create({ data: { accountId: fixture.account.id, machineId: fixture.machine.id,
            sessionId: session.id, data: 'opaque-source-key' } });
        const presence = createSessionPublisherPresence();
        const publisher = { data: {} };
        expect((await presence.registerPublisher({ socket: publisher,
            binding: { accountId: fixture.account.id, machineId: fixture.machine.id, sessionId: session.id },
            completeActivitySnapshot: { state: 'active', activeCount: 1 } })).status).toBe('registered');
        let visible = true;
        let sourceReads = 0;
        let retireSourceOnFinalRead = false;
        const effect = vi.fn(async (_event: string, _request: unknown) => ({ success: true }));
        const target = { id: 'destination-socket', data: { clientType: 'machine-scoped', machineId: destination.id,
            verifiedMachineInstallationId: destination.installationId }, timeout: () => ({ emitWithAck: effect }) };
        qualifyCurrentAccountStoredContentSocket(target);
        const method = `${destination.id}:${actionId === 'projects.open' ? RPC_METHODS.PROJECTS_OPEN : actionId}`;
        // Only Socket.IO discovery/delivery are simulated; signing, Home auth, source/publisher and C41 are real.
        const io = createSocketRoomDiscoveryHarness(async room => {
            if (room === getAccountSessionSocketRoom(fixture.account.id, session.id)) {
                if (retireSourceOnFinalRead && ++sourceReads === 2) {
                    await db.accessKey.deleteMany({ where: { accountId: fixture.account.id, machineId: fixture.machine.id, sessionId: session.id } });
                }
                return visible ? [publisher] : [];
            }
            return room === `rpc:${custodian.id}:${method}` || room === target.id ? [target] : [];
        });
        const resolvePublisher = (input: Readonly<{ accountId: string; sessionId: string }>) => resolveCurrentSessionMachineFromServer({ io, presence, ...input });
        const { app } = await createApp(fixture.team.id, false, resolvePublisher);
        const token = await auth.createToken(fixture.account.id, undefined, { kind: 'account', authority: 'present_user' });
        const origin = SessionActionRpcOriginV1Schema.parse({ v: 1,
            caller: { kind: 'session', sessionId: session.id, starterDepth: 1, turnDepth: 2 }, sourceTurnId: 'original-turn',
            callerPermissionMode: 'default', causalPermissionAuthority: { kind: 'admittedSessionInputV1', admittedPermissionCeiling: 'default' },
            requestId: crypto.randomUUID() });
        const homeId = await getOrCreateServerIdentityId();
        const params = actionId === 'projects.open'
            ? { serverId: homeId, machineId: destination.id, source: { kind: 'folder', path: '/workspace/project' },
                materialization: { kind: 'attach' } }
            : { selection: { kind: 'one-off', homeId,
                controller: { machineId: destination.id, installationId: destination.installationId! },
                launch: { provider: { pluginId: 'fixture.compute', localId: 'vm' }, schemaVersion: 1,
                    name: 'Reviewed', choices: {} }, retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false } };
        const envelope = ExternalActionRequestEnvelopeV1Schema.parse({ v: 1, requestId: origin.requestId,
            target: { kind: 'machine', machineId: destination.id }, input: params });
        const source = { machineId: fixture.machine.id, installationId: fixture.machine.installationId! };
        const installationProof = signMachineInstallationProof({ privateKey: fixture.keyPair.secretKey,
            payload: { version: 1, accountId: fixture.account.id, ...source, externalActionOrigin: { homeId, actionId,
                requestId: origin.requestId, requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope), origin } } });
        try {
            const minted = await app.inject({ method: 'POST', url: bindExternalActionExecutionAuthorizationHttpPathV1(actionId),
                headers: { authorization: `Bearer ${token}` }, payload: { v: 1, machineId: destination.id, envelope,
                    sessionActionOrigin: origin, sessionActionSource: source, installationProof } });
            expect(minted.statusCode, minted.body).toBe(200);
            const authorization = ExternalActionExecutionAuthorizationV1Schema.parse(minted.json());
            authorizationRequests.set(authorization.token, { target: authorization.binding.target,
                installationId: destination.installationId!, requestId: authorization.binding.requestId });
            const verifyPath = bindExternalActionExecutionAuthorizationVerifyHttpPathV1(actionId);
            const verifyBody = { v: 1 };
            const verifyHttp = (privateKey: Uint8Array, body: unknown = verifyBody) => app.inject({ method: 'POST', url: verifyPath,
                payload: body, headers: machineHeaders({ authorizationToken: authorization.token, effectActionId: actionId,
                    method: 'POST', path: verifyPath, body, privateKey }) });
            // The receiver signs with its installation; the Home-bound original
            // source may also obtain this exact root's qualified currentness.
            expect((await verifyHttp(destinationKeys.secretKey)).statusCode).toBe(200);
            const sourceSignedHttp = await verifyHttp(fixture.keyPair.secretKey);
            expect(sourceSignedHttp.statusCode, sourceSignedHttp.body).toBe(200);
            expect(sourceSignedHttp.json()).toEqual({ ok: true });
            expect((await verifyHttp(tweetnacl.sign.keyPair().secretKey)).statusCode).toBe(401);
            await db.machine.update({ where: { id: fixture.machine.id }, data: { installationId: 'replaced-original-source' } });
            expect((await verifyHttp(destinationKeys.secretKey)).statusCode).toBe(401);
            await db.machine.update({ where: { id: fixture.machine.id }, data: { installationId: fixture.machine.installationId } });
            expect((await verifyHttp(destinationKeys.secretKey)).statusCode).toBe(200);
            const signingInput = { authorizationToken: authorization.token, effectActionId: actionId,
                target: authorization.binding.target, installationId: destination.installationId!, event: SOCKET_RPC_EVENTS.CALL,
                method, requestId: origin.requestId, params };
            const execution = { v: 1 as const, authorization, effectActionId: actionId, target: authorization.binding.target,
                installationId: destination.installationId!, machineSignature: signExternalActionMachineRpcRequestV1({ ...signingInput,
                    privateKey: fixture.keyPair.secretKey }) };
            const request = { method, requestId: origin.requestId, params, resolveCurrentSessionMachine: resolvePublisher };
            expect(await verifyExternalActionMachineRpcExecution(execution, request)).toMatchObject({
                principal: { accountId: fixture.account.id, authority: 'account_automation', sessionActionOrigin: origin } });
            expect(await verifyExternalActionMachineRpcExecution({ ...execution,
                machineSignature: signExternalActionMachineRpcRequestV1({ ...signingInput, privateKey: destinationKeys.secretKey }) }, request)).toBeNull();
            expect(await verifyExternalActionMachineRpcExecution(execution, { ...request, params: { ...params, machineId: fixture.machine.id } })).toBeNull();
            expect(await verifyExternalActionMachineRpcExecution({ ...execution, authorization: { ...authorization,
                binding: { ...authorization.binding, sessionActionOrigin: { ...origin, sourceTurnId: 'forged-turn' } } } }, request)).toBeNull();
            const socket = Object.assign(createFakeSocket({ id: 'requester-source', data: { clientType: 'machine-scoped',
                machineId: fixture.machine.id, verifiedMachineInstallationId: fixture.machine.installationId,
                authTokenKind: 'account', authAuthority: 'present_user' } }), {
                    handshake: { auth: { token, ...currentAccountStoredContentCompatibilitySocketAuth } },
                });
            qualifyCurrentAccountStoredContentSocket(socket);
            registerSocketRpcHandlers({ userId: fixture.account.id, socket: socket as unknown as Socket, io, sessionPublisherPresence: presence });
            const callback = vi.fn();
            await getSocketHandler(socket, SOCKET_RPC_EVENTS.CALL)({ method, requestId: origin.requestId, params,
                externalActionExecution: execution }, callback);
            expect(callback).toHaveBeenCalledWith({ ok: true, result: { success: true } });
            expect(effect).toHaveBeenCalledWith(SOCKET_RPC_EVENTS.REQUEST, expect.objectContaining({
                callerAuthority: 'account_automation', sessionActionOrigin: origin, callerInputAuthorization: authorization }));
            expect(authorization.binding).toMatchObject({ machineId: destination.id, installationId: destination.installationId,
                accountId: fixture.account.id, custodianAccountId: custodian.id, sessionActionSource: source });
            const forged = vi.fn();
            await getSocketHandler(socket, SOCKET_RPC_EVENTS.CALL)({ method, requestId: origin.requestId, params,
                externalActionExecution: { ...execution, machineSignature: signExternalActionMachineRpcRequestV1({
                    ...signingInput, privateKey: destinationKeys.secretKey }) } }, forged);
            expect(forged).toHaveBeenCalledWith(expect.objectContaining({ ok: false, error: 'Forbidden' }));
            expect(effect).toHaveBeenCalledOnce();
            visible = false;
            expect((await verifyHttp(fixture.keyPair.secretKey)).statusCode).toBe(401);
            expect((await verifyHttp(destinationKeys.secretKey)).statusCode).toBe(401);
            expect(await verifyExternalActionMachineRpcExecution(execution, request)).toBeNull();
            const retired = vi.fn();
            await getSocketHandler(socket, SOCKET_RPC_EVENTS.CALL)({ method, requestId: origin.requestId, params,
                externalActionExecution: execution }, retired);
            expect(retired).toHaveBeenCalledWith(expect.objectContaining({ ok: false, error: 'Forbidden' }));
            expect(effect).toHaveBeenCalledOnce();
            visible = true;
            retireSourceOnFinalRead = true;
            expect(await verifyExternalActionMachineRpcExecution(execution, request)).toBeNull();
            expect(sourceReads).toBe(2);
        } finally { await app.close(); }
    });

    it.each(['view', 'admin'] as const)('admits original requester Project Open with proved Session origin for %s and retires it with its exact AccessKey', async level => {
        const fixture = await createFixture({ qualifiedPat: false });
        const custodian = await db.account.create({ data: { publicKey: null, encryptionMode: 'plain' } });
        await db.machine.update({ where: { id: fixture.machine.id }, data: { accountId: custodian.id } });
        await inTx(tx => setMachineAccessGrantInTx(tx, { actorAccountId: custodian.id, machineId: fixture.machine.id,
            principal: { kind: 'account', accountId: fixture.account.id }, level }));
        const fence = new Date();
        const session = await db.session.create({ data: { accountId: fixture.account.id, tag: crypto.randomUUID(),
            metadata: '{}', encryptionMode: 'plain', active: true, lastActiveAt: fence } });
        await db.accessKey.create({ data: { accountId: fixture.account.id, machineId: fixture.machine.id,
            sessionId: session.id, data: 'opaque-requester-key' } });
        expect(await resolveMachineAccess({ actorAccountId: fixture.account.id, machineId: fixture.machine.id }))
            .toMatchObject({ owned: false, role: level === 'admin' ? 'manage' : 'use', custodianAccountId: custodian.id, accessState: 'ready' });
        const ungranted = await db.account.create({ data: { publicKey: null, encryptionMode: 'plain' } });
        expect(await resolveMachineAdmission({ actorAccountId: ungranted.id, machineId: fixture.machine.id, actionId: 'projects.open' }))
            .toMatchObject({ kind: 'denied', code: 'access_denied' });
        expect(await inTx(tx => hasCurrentSessionScopedMachineAccessInTx({ tx, accountId: fixture.account.id,
            machineId: fixture.machine.id, sessionId: session.id }))).toBe(true);
        const token = await auth.createToken(fixture.account.id, undefined, { kind: 'account', authority: 'present_user' });
        const homeId = await getOrCreateServerIdentityId();
        const origin = SessionActionRpcOriginV1Schema.parse({ v: 1,
            caller: { kind: 'session', sessionId: session.id, starterDepth: 1, turnDepth: 2 },
            sourceTurnId: 'turn-2', callerPermissionMode: 'yolo', causalPermissionAuthority: null,
            requestId: crypto.randomUUID() });
        const actionId = 'projects.open';
        const envelope = ExternalActionRequestEnvelopeV1Schema.parse({ v: 1, requestId: origin.requestId,
            target: { kind: 'machine', machineId: fixture.machine.id }, input: { serverId: homeId,
                machineId: fixture.machine.id, source: { kind: 'folder', path: '/workspace/project' },
                materialization: { kind: 'attach' } } });
        const proof = signMachineInstallationProof({ privateKey: fixture.keyPair.secretKey,
            payload: { version: 1, accountId: fixture.account.id, machineId: fixture.machine.id,
                installationId: fixture.machine.installationId!, externalActionOrigin: { homeId, actionId,
                    requestId: origin.requestId, requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope), origin } } });
        const presence = createSessionPublisherPresence();
        let publisherVisible = true;
        let revokeGrantDuringDiscovery = false;
        // Only socket discovery is simulated: AccessKey, publisher freshness and Account/Machine admission are real.
        const io = { in: (room: string) => ({ fetchSockets: async () => {
            if (revokeGrantDuringDiscovery) {
                revokeGrantDuringDiscovery = false;
                await inTx(tx => removeMachineAccessGrantInTx(tx, { actorAccountId: custodian.id, machineId: fixture.machine.id,
                    principal: { kind: 'account', accountId: fixture.account.id } }));
            }
            return publisherVisible && room === getAccountSessionSocketRoom(fixture.account.id, session.id)
                ? [{ data: { sessionPublisherAuthority: { v: 1, accountId: fixture.account.id,
                    machineId: fixture.machine.id, sessionId: session.id, committedFenceMs: fence.getTime() } } }] : [];
        } }) } as unknown as Server;
        const resolvePublisher = (input: Readonly<{ accountId: string; sessionId: string }>) => resolveCurrentSessionMachineFromServer({ io, presence, ...input });
        expect(await resolvePublisher({ accountId: fixture.account.id, sessionId: session.id })).toBe(fixture.machine.id);
        const { app } = await createApp(fixture.team.id, false, resolvePublisher);
        const sessionActionSource = { machineId: fixture.machine.id, installationId: fixture.machine.installationId! };
        const request = { v: 1, machineId: fixture.machine.id, envelope, sessionActionOrigin: origin, sessionActionSource, installationProof: proof };
        try {
            const minted = await app.inject({ method: 'POST', url: bindExternalActionExecutionAuthorizationHttpPathV1(actionId),
                headers: { authorization: `Bearer ${token}` }, payload: request });
            expect(minted.statusCode, minted.body).toBe(200);
            const authorization = ExternalActionExecutionAuthorizationV1Schema.parse(minted.json());
            expect(authorization.binding).toMatchObject({ accountId: fixture.account.id, custodianAccountId: custodian.id,
                sessionActionOrigin: origin, sessionActionSource, accountEncryptionMode: 'plain' });
            expect(await verifyCurrentExternalActionPrincipal(authorization.binding)).toMatchObject({
                accountId: fixture.account.id, authority: 'account_automation' });
            authorizationRequests.set(authorization.token, { target: authorization.binding.target,
                installationId: fixture.machine.installationId!, requestId: origin.requestId });
            const forged = await app.inject({ method: 'POST', url: bindExternalActionExecutionAuthorizationHttpPathV1(actionId),
                headers: { authorization: `Bearer ${token}` }, payload: { ...request,
                    sessionActionOrigin: { ...origin, sourceTurnId: 'substituted-turn' } } });
            expect(forged.statusCode).toBe(401);
            const path = bindExternalActionExecutionAuthorizationVerifyHttpPathV1(actionId);
            const body = { v: 1 };
            const headers = machineHeaders({ authorizationToken: authorization.token, effectActionId: actionId,
                method: 'POST', path, body, privateKey: fixture.keyPair.secretKey });
            expect((await app.inject({ method: 'POST', url: path, headers, payload: body })).statusCode).toBe(200);
            const key = { kind: 'project-organization', serverId: homeId, projectKey: 'requester-private' } as const;
            const mutationPath = '/v1/account/project-rows/mutate';
            const mutationBody = { mutations: [{ key, expectedRevision: 'absent',
                content: { t: 'plain', v: { key, value: { hidden: true, pinned: true } } } }], expectedRefs: [], topologyChange: false };
            const mutationHeaders = machineHeaders({ authorizationToken: authorization.token, effectActionId: actionId,
                method: 'POST', path: mutationPath, body: mutationBody, privateKey: fixture.keyPair.secretKey });
            const mutated = await app.inject({ method: 'POST', url: mutationPath, headers: mutationHeaders, payload: mutationBody });
            expect(mutated.statusCode, mutated.body).toBe(200);
            expect(mutated.json()).toMatchObject({ status: 'updated' });
            const physicalKey = buildProjectAccountRowPhysicalKeyV1(key);
            expect(await db.userKVStore.findUnique({ where: { accountId_key: { accountId: custodian.id, key: physicalKey } } })).toBeNull();
            const requesterRow = await db.userKVStore.findUniqueOrThrow({ where: { accountId_key: { accountId: fixture.account.id, key: physicalKey } } });
            expect(requesterRow.version).toBe(0);
            await db.session.update({ where: { id: session.id }, data: { accountId: ungranted.id } });
            expect(await db.accessKey.count({ where: { accountId: fixture.account.id, machineId: fixture.machine.id, sessionId: session.id } })).toBe(1);
            expect((await app.inject({ method: 'POST', url: path, headers, payload: body })).statusCode).toBe(401);
            expect((await app.inject({ method: 'POST', url: mutationPath, headers: mutationHeaders, payload: mutationBody })).statusCode).toBe(401);
            expect(await db.userKVStore.findUniqueOrThrow({ where: { accountId_key: { accountId: fixture.account.id, key: physicalKey } } })).toEqual(requesterRow);
            await db.session.update({ where: { id: session.id }, data: { accountId: fixture.account.id } });
            publisherVisible = false;
            expect((await app.inject({ method: 'POST', url: path, headers, payload: body })).statusCode).toBe(401);
            expect((await app.inject({ method: 'POST', url: mutationPath, headers: mutationHeaders, payload: mutationBody })).statusCode).toBe(401);
            expect(await db.userKVStore.findUniqueOrThrow({ where: { accountId_key: { accountId: fixture.account.id, key: physicalKey } } })).toEqual(requesterRow);
            publisherVisible = true;
            revokeGrantDuringDiscovery = true;
            expect((await app.inject({ method: 'POST', url: path, headers, payload: body })).statusCode).toBe(401);
            expect(await db.accessKey.count({ where: { accountId: fixture.account.id, machineId: fixture.machine.id, sessionId: session.id } })).toBe(1);
            expect((await app.inject({ method: 'POST', url: mutationPath, headers: mutationHeaders, payload: mutationBody })).statusCode).toBe(401);
            expect(await db.userKVStore.findUniqueOrThrow({ where: { accountId_key: { accountId: fixture.account.id, key: physicalKey } } })).toEqual(requesterRow);
            await inTx(tx => setMachineAccessGrantInTx(tx, { actorAccountId: custodian.id, machineId: fixture.machine.id,
                principal: { kind: 'account', accountId: fixture.account.id }, level }));
            await db.accessKey.deleteMany({ where: { accountId: fixture.account.id, machineId: fixture.machine.id, sessionId: session.id } });
            expect((await app.inject({ method: 'POST', url: path, headers, payload: body })).statusCode).toBe(401);
            expect((await app.inject({ method: 'POST', url: mutationPath, headers: mutationHeaders, payload: mutationBody })).statusCode).toBe(401);
            expect(await db.userKVStore.findUniqueOrThrow({ where: { accountId_key: { accountId: fixture.account.id, key: physicalKey } } })).toEqual(requesterRow);
            const retiredMint = await app.inject({ method: 'POST', url: bindExternalActionExecutionAuthorizationHttpPathV1(actionId),
                headers: { authorization: `Bearer ${token}` }, payload: request });
            expect(retiredMint.statusCode).toBe(401);
        } finally { await app.close(); }
    });

    it('requires the semantic withdrawal effect while allowing a composite outer Action to invoke that exact effect', async () => {
        const fixture = await createFixture({ qualifiedPat: true });
        const session = await db.session.create({ data: { tag: crypto.randomUUID(), accountId: fixture.account.id,
            metadata: '{}', encryptionMode: 'plain' } });
        const localId = `effect-${crypto.randomUUID()}`;
        await expect(enqueuePendingMessage({ actorUserId: fixture.account.id, sessionId: session.id, localId,
            authentication: createPresentUserSessionAccessAuthentication(), requestedAction: { v: 1, kind: 'enqueue' },
            content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'Keep original custody' } } } }))
            .resolves.toMatchObject({ ok: true });
        const { app } = await createApp(fixture.team.id, true);
        const path = `/v2/sessions/${session.id}/pending/${localId}/withdraw`;
        const body = {};
        const envelope = { ...fixture.envelope, target: { kind: 'session' as const, sessionId: session.id } };
        try {
            const wrong = await mint(app, fixture, 'session.message.send', envelope);
            const denied = await app.inject({ method: 'POST', url: path, payload: body,
                headers: machineHeaders({ authorizationToken: wrong.token, effectActionId: 'session.message.send',
                    method: 'POST', path, body, privateKey: fixture.keyPair.secretKey }) });
            expect(denied.statusCode).toBe(403);
            expect(denied.json()).toMatchObject({ error: 'credential_scope_denied' });
            expect(await db.sessionPendingMessage.count({ where: { sessionId: session.id, localId } })).toBe(1);
            // The effect is exact; its originating Action is intentionally composite rather than withdrawal itself.
            const composite = await mint(app, fixture, 'approval.request.create', envelope);
            const removed = await app.inject({ method: 'POST', url: path, payload: body,
                headers: machineHeaders({ authorizationToken: composite.token, effectActionId: 'session.pending.withdraw',
                    method: 'POST', path, body, privateKey: fixture.keyPair.secretKey }) });
            expect(removed.statusCode, removed.body).toBe(200);
            expect(removed.json()).toMatchObject({ ok: true, outcome: 'removed' });
            expect(await db.sessionPendingMessage.count({ where: { sessionId: session.id, localId } })).toBe(0);
        } finally { await app.close(); }
    });

    it("refuses shared launch even with Manage until requester-owned private execution ports exist", async () => {
        const fixture = await createFixture({ qualifiedPat: false });
        const custodian = await db.account.create({ data: { publicKey: null, encryptionMode: "plain" } });
        await db.machine.update({ where: { id: fixture.machine.id }, data: {
            accountId: custodian.id,
            metadata: encodePlainMachineStoredContent({ host: 'shared', platform: 'linux', happyCliVersion: 'test',
                homeDir: '/home/shared', happyHomeDir: '/home/shared/.happier' }),
            dataEncryptionKey: decodeBase64(MACHINE_PLAIN_DATA_KEY_MARKER, 'base64'),
            active: true,
        } });
        await db.machineAccountGrant.create({ data: {
            machineId: fixture.machine.id, accountId: fixture.account.id,
            accessLevel: "view", createdByAccountId: custodian.id,
        } });
        const { app } = await createApp(fixture.team.id);
        try {
            const envelope: ExternalActionRequestEnvelopeV1 = { v: 1, requestId: crypto.randomUUID(),
                target: { kind: "machine", machineId: fixture.machine.id }, input: {} };
            const mintLaunch = () => app.inject({ method: 'POST',
                url: bindExternalActionExecutionAuthorizationHttpPathV1('session.spawn_new'),
                headers: { authorization: `Bearer ${fixture.pat.token}` },
                payload: { v: 1, machineId: fixture.machine.id, envelope } });
            expect((await mintLaunch()).statusCode).toBe(409);
            await db.machineAccountGrant.update({ where: { machineId_accountId: {
                machineId: fixture.machine.id, accountId: fixture.account.id,
            } }, data: { accessLevel: 'admin' } });
            expect((await mintLaunch()).statusCode).toBe(409);
        } finally { await app.close(); }
    });

    it("originates managed execution from the actual ordinary Account credential and rechecks its epoch", async () => {
        const fixture = await createFixture({ qualifiedPat: false });
        const token = await auth.createToken(fixture.account.id, undefined, {
            kind: 'account', authority: 'present_user',
            authenticationEvidence: [{ kind: 'home_method', methodId: 'email_password' }],
        });
        const actionId = 'machines.managed.acquire';
        const envelope = { ...fixture.envelope, input: {} };
        const app = Fastify({ logger: false }).withTypeProvider<ZodTypeProvider>() as unknown as import('@/app/api/types').Fastify;
        app.setValidatorCompiler(validatorCompiler);
        app.setSerializerCompiler(serializerCompiler);
        enableAuthentication(app);
        registerExternalActionRoutes(app, { dispatch: async () => ({ kind: 'placement_error', code: 'target_unavailable' }) });
        registerAccountApiTokenManagementRoutes(app);
        app.post('/v1/machines/managed/controller/test-effect', { preHandler: app.authenticate }, async request => ({
            accountId: request.userId, authority: request.authAuthority,
            tokenKind: request.authTokenKind, evidence: request.authTokenAuthenticationEvidence,
            custodianAccountId: request.externalActionExecutionCustodianAccountId,
            requestId: request.externalActionExecutionRequestId,
            hasPat: request.apiTokenPrincipal !== undefined,
        }));
        await app.ready();
        try {
            const minted = await app.inject({ method: 'POST',
                url: bindExternalActionExecutionAuthorizationHttpPathV1(actionId),
                headers: { authorization: `Bearer ${token}` },
                payload: { v: 1, machineId: fixture.machine.id, envelope } });
            expect(minted.statusCode).toBe(200);
            const authorization = ExternalActionExecutionAuthorizationV1Schema.parse(minted.json());
            expect(authorization.binding).toMatchObject({ accountId: fixture.account.id,
                custodianAccountId: fixture.account.id, installationId: fixture.machine.installationId,
                accountEncryptionMode: 'plain',
                authentication: { kind: 'account', tokenEpoch: fixture.account.tokenEpoch,
                    evidence: [{ kind: 'home_method', methodId: 'email_password' }] } });
            expect(authorization.binding).not.toHaveProperty('credentialId');
            expect(authorization.binding).not.toHaveProperty('grant');
            expect(JSON.stringify(authorization)).not.toContain(token);
            authorizationRequests.set(authorization.token, { target: authorization.binding.target,
                installationId: authorization.binding.installationId, requestId: authorization.binding.requestId });
            const body = { managedId: 'same-resource' };
            const execute = () => app.inject({ method: 'POST', url: '/v1/machines/managed/controller/test-effect', payload: body,
                headers: machineHeaders({ authorizationToken: authorization.token, effectActionId: actionId,
                    method: 'POST', path: '/v1/machines/managed/controller/test-effect', body, privateKey: fixture.keyPair.secretKey }) });
            expect((await execute()).json()).toMatchObject({ accountId: fixture.account.id, authority: 'present_user',
                tokenKind: 'account', custodianAccountId: fixture.account.id, requestId: envelope.requestId, hasPat: false });
            const unrelatedBody = { tokenId: crypto.randomUUID(), label: 'Unrelated security authority' };
            const unrelated = await app.inject({ method: 'POST', url: ACCOUNT_API_TOKENS_CREATE_HTTP_PATH_V1,
                payload: unrelatedBody, headers: machineHeaders({ authorizationToken: authorization.token,
                    effectActionId: 'account.apiTokens.create', method: 'POST', path: ACCOUNT_API_TOKENS_CREATE_HTTP_PATH_V1,
                    body: unrelatedBody, privateKey: fixture.keyPair.secretKey }) });
            expect(unrelated.statusCode).toBe(401);
            expect(await db.accountApiToken.findUnique({ where: { id: unrelatedBody.tokenId } })).toBeNull();
            const wrongPurposeBody = { tokenId: crypto.randomUUID(), label: 'Same effect, unrelated HTTP purpose' };
            const wrongPurpose = await app.inject({ method: 'POST', url: ACCOUNT_API_TOKENS_CREATE_HTTP_PATH_V1,
                payload: wrongPurposeBody, headers: machineHeaders({ authorizationToken: authorization.token,
                    effectActionId: actionId, method: 'POST', path: ACCOUNT_API_TOKENS_CREATE_HTTP_PATH_V1,
                    body: wrongPurposeBody, privateKey: fixture.keyPair.secretKey }) });
            expect(wrongPurpose.statusCode).toBe(401);
            expect(await db.accountApiToken.findUnique({ where: { id: wrongPurposeBody.tokenId } })).toBeNull();
            await db.account.update({ where: { id: fixture.account.id }, data: { tokenEpoch: { increment: 1 } } });
            expect((await execute()).statusCode).toBe(401);
        } finally { await app.close(); }
    });

    async function createManagedNativeAuthFixture(rebuild = false) {
        const fixture = await createFixture({ qualifiedPat: false });
        const homeId = await getOrCreateServerIdentityId();
        const controller = { machineId: fixture.machine.id, installationId: fixture.machine.installationId! };
        const native = defineProtocolObject({ id: defineProtocolString({ minLength: 1 }) }, { policy: 'closed' });
        const nativeOperation = rebuild ? native : defineProtocolObject({ requestId: defineProtocolString({ minLength: 1 }) }, { policy: 'closed' });
        const roles = defineMachineProvisionerSchemas({ launch: native, resource: native });
        const reconciliation = defineMachineProvisionerReconciliationSchemas({ launch: native, resource: native, nativeOperation });
        const definitions = [
            { id: 'check', inputSchema: roles.checkInput.jsonSchema, resultSchema: MachineProvisionerCheckResultProtocolV1Schema.jsonSchema },
            { id: 'acquire', inputSchema: roles.acquireInput.jsonSchema, resultSchema: reconciliation.result.jsonSchema },
            { id: 'bootstrap', inputSchema: roles.bootstrapInput.jsonSchema, resultSchema: MachineProvisionerBootstrapCarrierV1Schema.jsonSchema },
            { id: 'inspect', inputSchema: roles.resourceInput.jsonSchema, resultSchema: MachineProvisionerObservationV1Schema.jsonSchema },
            { id: 'destroy', inputSchema: reconciliation.destroyInput.jsonSchema, resultSchema: MachineProvisionerPowerResultV1Schema.jsonSchema },
            { id: 'reconcile', inputSchema: reconciliation.input.jsonSchema, resultSchema: reconciliation.result.jsonSchema },
            ...(rebuild ? [{ id: 'rebuild', inputSchema: roles.rebuildInput.jsonSchema, resultSchema: roles.rebuildResult.jsonSchema }] : []),
        ];
        const manifest = PluginManifestV2Schema.parse({ schemaVersion: 2, id: 'fixture.pending-auth', version: '1.0.0',
            displayName: 'Pending native authentication fixture', engines: { happier: '^1.0.0' }, runtime: { apiVersion: 1 }, contributes: {
                machineProvisioners: [{ id: 'compute', title: 'Guest', icon: 'machine', resourceKind: rebuild ? 'devcontainer' : 'vm', schemaVersion: 1,
                    launchSchema: native.jsonSchema, resourceSchema: native.jsonSchema, platforms: ['linux'], prerequisites: [],
                    billing: { location: 'local', stoppedBilling: 'not-billed' }, retention: { supportedIntents: rebuild ? ['delete', 'rebuild'] : ['delete'] },
                    actions: { check: 'check', acquire: 'acquire', bootstrap: 'bootstrap', inspect: 'inspect', destroy: 'destroy', ...(rebuild ? { rebuild: 'rebuild' } : {}) },
                    reconciliation: { action: 'reconcile', nativeOperationSchema: nativeOperation.jsonSchema } }],
                actions: definitions.map(action => ({ ...action, title: action.id, execution: { target: 'daemon' },
                    surfaces: ['plugin'], scopes: ['global'], dangerLevel: 'safe' })),
            } });
        const declaration = createReleaseLessDeclarationV1(manifest);
        await db.machine.update({ where: { id: fixture.machine.id }, data: { pluginMaterializationRevision: BigInt(1) } });
        await db.accountPluginIntent.create({ data: { accountId: fixture.account.id, pluginId: manifest.id, enabled: true,
            writableCollections: [], releaseLessDeclaration: declaration } });
        await db.pluginMachineMaterialization.create({ data: { accountId: fixture.account.id, serverIdentityId: homeId,
            machineId: controller.machineId, materializationId: controller.installationId, pluginId: manifest.id, version: manifest.version,
            sourceClass: 'bundledFirstParty', portableRelease: false, archiveDigestSha256: declaration.manifestDigestSha256,
            uiArtifacts: [], enabled: true, trustState: 'trusted', observedAt: new Date() } });
        const input = { selection: { kind: 'one-off' as const, homeId, controller,
            launch: { provider: { pluginId: manifest.id, localId: 'compute' }, schemaVersion: 1, name: 'Reviewed', choices: { id: 'reviewed' } },
            retention: { kind: 'until-delete' as const }, wakeOnAcceptedMessage: false } };
        return { fixture, homeId, controller, input };
    }

    it('retains an actually submitted pending allocation through real Home authentication after its Session origin retires', async () => {
        const { fixture, homeId, controller, input } = await createManagedNativeAuthFixture();
        const session = await db.session.create({ data: { accountId: fixture.account.id, tag: crypto.randomUUID(),
            metadata: '{}', encryptionMode: 'plain', active: true, lastActiveAt: new Date() } });
        await db.accessKey.create({ data: { accountId: fixture.account.id, machineId: controller.machineId, sessionId: session.id, data: 'source-key' } });
        const origin = SessionActionRpcOriginV1Schema.parse({ v: 1, caller: { kind: 'session', sessionId: session.id, starterDepth: 0, turnDepth: 0 },
            sourceTurnId: 'paid-source-turn', callerPermissionMode: 'yolo', causalPermissionAuthority: null, requestId: crypto.randomUUID() });
        const actionId = 'machines.managed.acquire';
        const envelope = ExternalActionRequestEnvelopeV1Schema.parse({ v: 1, requestId: origin.requestId,
            target: { kind: 'machine', machineId: controller.machineId }, input });
        const source = controller;
        const installationProof = signMachineInstallationProof({ privateKey: fixture.keyPair.secretKey,
            payload: { version: 1, accountId: fixture.account.id, ...source, externalActionOrigin: { homeId, actionId,
                requestId: origin.requestId, requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope), origin } } });
        const app = Fastify({ logger: false }).withTypeProvider<ZodTypeProvider>() as unknown as import('@/app/api/types').Fastify;
        app.setValidatorCompiler(validatorCompiler);
        app.setSerializerCompiler(serializerCompiler);
        // Only publisher transport is substituted. Source custody, token mint,
        // installation signatures and managed submission use their real owners.
        app.decorate('resolveCurrentSessionMachine', async () => controller.machineId);
        enableAuthentication(app);
        registerExternalActionRoutes(app, { dispatch: async () => ({ kind: 'placement_error', code: 'target_unavailable' }) });
        registerManagedMachineRoutes(app);
        const token = await auth.createToken(fixture.account.id, undefined, { kind: 'account', authority: 'present_user' });
        try {
            const minted = await app.inject({ method: 'POST', url: bindExternalActionExecutionAuthorizationHttpPathV1(actionId),
                headers: { authorization: `Bearer ${token}` }, payload: { v: 1, machineId: controller.machineId,
                    envelope, sessionActionOrigin: origin, sessionActionSource: source, installationProof } });
            expect(minted.statusCode, minted.body).toBe(200);
            const authorization = ExternalActionExecutionAuthorizationV1Schema.parse(minted.json());
            authorizationRequests.set(authorization.token, { target: authorization.binding.target,
                installationId: controller.installationId, requestId: origin.requestId });
            const created = await admitManagedAcquire({ requesterAccountId: fixture.account.id, custodianAccountId: fixture.account.id,
                requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope), input: { input, requestId: origin.requestId, continuationPresent: false } });
            const correlation = { homeId, managedId: created.machine.id, expectedIntentRevision: 0, requestId: origin.requestId, controller };
            const post = (path: string, body: unknown) => app.inject({ method: 'POST', url: path, payload: body,
                headers: machineHeaders({ authorizationToken: authorization.token, effectActionId: actionId,
                    method: 'POST', path, body, privateKey: fixture.keyPair.secretKey }) });
            const submitted = await post('/v1/machines/managed/controller/submit', correlation);
            expect(submitted.statusCode, submitted.body).toBe(200);
            await cancelManagedCreation({ actorAccountId: fixture.account.id, input: { homeId, managedId: created.machine.id, expectedIntentRevision: 0 } });
            await db.accessKey.deleteMany({ where: { accountId: fixture.account.id, machineId: controller.machineId, sessionId: session.id } });
            const nativeOperationRef = { contributionRef: input.selection.launch.provider, schemaVersion: 1, value: { requestId: 'actually-submitted-native-request' } };
            const reported = await post('/v1/machines/managed/controller/report', { ...correlation, result: { kind: 'pending', nativeOperationRef } });
            expect(reported.statusCode, reported.body).toBe(200);
            expect(reported.json()).toMatchObject({ machine: { creationState: 'canceled', allocation: 'may-exist', nativeOperationRef,
                desired: 'delete', intentRevision: 1, cleanup: { disposition: 'pending' } } });
            const invalidHandle = await post('/v1/machines/managed/controller/report', { ...correlation,
                result: { kind: 'pending', nativeOperationRef: { ...nativeOperationRef, value: { ...nativeOperationRef.value, undeclared: true } } } });
            expect(invalidHandle.statusCode, invalidHandle.body).toBe(409);
            expect(invalidHandle.json()).toEqual({ code: 'resource_mismatch' });
            expect((await post('/v1/machines/managed/controller/submit', correlation)).statusCode).toBe(401);
            expect((await post('/v1/machines/managed/controller/report', { ...correlation, result: { kind: 'rejected', code: 'provider_unavailable' } })).statusCode).toBe(401);
            await db.account.update({ where: { id: fixture.account.id }, data: { tokenEpoch: { increment: 1 } } });
            expect((await post('/v1/machines/managed/controller/report', { ...correlation, result: { kind: 'pending', nativeOperationRef } })).statusCode).toBe(401);
        } finally { await app.close(); }
    });

    it('recovers the original rebuild tuple through fresh Inspector Home authentication after its Session origin retires', async () => {
        const { fixture, homeId, controller, input } = await createManagedNativeAuthFixture(true);
        const creationRequestId = crypto.randomUUID();
        const created = await admitManagedAcquire({ requesterAccountId: fixture.account.id, custodianAccountId: fixture.account.id,
            requestEnvelopeDigest: 'reviewed-auth-rebuild-acquire', input: { input, requestId: creationRequestId, continuationPresent: false } });
        const creation = { homeId, managedId: created.machine.id, expectedIntentRevision: 0, requestId: creationRequestId, controller };
        await submitManagedAcquire(creation);
        const observation = (nativeResourceId: string) => ({ nativeResourceId, user: 'coder', workspaceFolder: '/workspace',
            storage: { kind: 'bind' as const, hostPath: '/host/workspace', childPath: '/workspace' } });
        const previous = { contributionRef: input.selection.launch.provider, schemaVersion: 1,
            value: { id: 'a'.repeat(64) }, devcontainerObservation: observation('a'.repeat(64)) };
        const replacement = { ...previous, value: { id: 'b'.repeat(64) }, devcontainerObservation: observation('b'.repeat(64)) };
        await reportManagedAcquire({ ...creation, result: { kind: 'bound', resource: previous } });
        const session = await db.session.create({ data: { accountId: fixture.account.id, tag: crypto.randomUUID(),
            metadata: '{}', encryptionMode: 'plain', active: true, lastActiveAt: new Date() } });
        await db.accessKey.create({ data: { accountId: fixture.account.id, machineId: controller.machineId, sessionId: session.id, data: 'source-key' } });
        const origin = SessionActionRpcOriginV1Schema.parse({ v: 1, caller: { kind: 'session', sessionId: session.id, starterDepth: 0, turnDepth: 0 },
            sourceTurnId: 'rebuild-source-turn', callerPermissionMode: 'yolo', causalPermissionAuthority: null, requestId: crypto.randomUUID() });
        const rebuildInput = { homeId, managedMachineId: created.machine.id, expectedRevision: 0, kind: 'rebuild' as const, reviewedEffectDigest: 'd'.repeat(64) };
        const envelope = ExternalActionRequestEnvelopeV1Schema.parse({ v: 1, requestId: origin.requestId,
            target: { kind: 'machine', machineId: controller.machineId }, input: rebuildInput });
        const actionId = 'machines.managed.rebuild';
        const installationProof = signMachineInstallationProof({ privateKey: fixture.keyPair.secretKey,
            payload: { version: 1, accountId: fixture.account.id, ...controller, externalActionOrigin: { homeId, actionId,
                requestId: origin.requestId, requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope), origin } } });
        const app = Fastify({ logger: false }).withTypeProvider<ZodTypeProvider>() as unknown as import('@/app/api/types').Fastify;
        app.setValidatorCompiler(validatorCompiler);
        app.setSerializerCompiler(serializerCompiler);
        app.decorate('resolveCurrentSessionMachine', async () => controller.machineId);
        enableAuthentication(app);
        registerExternalActionRoutes(app, { dispatch: async () => ({ kind: 'placement_error', code: 'target_unavailable' }) });
        registerManagedMachineRoutes(app);
        const token = await auth.createToken(fixture.account.id, undefined, { kind: 'account', authority: 'present_user' });
        const post = (authorization: { token: string }, effectActionId: string, path: string, body: unknown) => app.inject({ method: 'POST', url: path, payload: body,
            headers: machineHeaders({ authorizationToken: authorization.token, effectActionId, method: 'POST', path, body, privateKey: fixture.keyPair.secretKey }) });
        const remember = (authorization: ReturnType<typeof ExternalActionExecutionAuthorizationV1Schema.parse>) => {
            authorizationRequests.set(authorization.token, { target: authorization.binding.target,
                installationId: controller.installationId, requestId: authorization.binding.requestId });
            return authorization;
        };
        try {
            const minted = await app.inject({ method: 'POST', url: bindExternalActionExecutionAuthorizationHttpPathV1(actionId),
                headers: { authorization: `Bearer ${token}` }, payload: { v: 1, machineId: controller.machineId,
                    envelope, sessionActionOrigin: origin, sessionActionSource: controller, installationProof } });
            expect(minted.statusCode, minted.body).toBe(200);
            const rebuild = remember(ExternalActionExecutionAuthorizationV1Schema.parse(minted.json()));
            const admitted = await post(rebuild, actionId, '/v1/machines/managed/controller/admit-control',
                { action: actionId, requestId: origin.requestId, input: rebuildInput });
            expect(admitted.statusCode, admitted.body).toBe(200);
            const correlation = { ...creation, expectedIntentRevision: 1, requestId: origin.requestId };
            const submitted = await post(rebuild, actionId, '/v1/machines/managed/controller/submit-intent', correlation);
            expect(submitted.statusCode, submitted.body).toBe(200);
            await db.accessKey.deleteMany({ where: { accountId: fixture.account.id, machineId: controller.machineId, sessionId: session.id } });
            const report = { ...correlation, result: { kind: 'bound', resource: replacement } };
            expect((await post(rebuild, actionId, '/v1/machines/managed/controller/report-intent', report)).statusCode).toBe(401);
            const unresolved = await db.managedMachine.findUniqueOrThrow({ where: { id: created.machine.id } });
            expect(unresolved).toMatchObject({ resource: previous, admittedInput: { submittedEffect: {
                requestId: origin.requestId, expectedIntentRevision: 1, intent: 'rebuild', reviewedEffectDigest: rebuildInput.reviewedEffectDigest,
            } } });
            const inspectorEnvelope = ExternalActionRequestEnvelopeV1Schema.parse({ v: 1, requestId: crypto.randomUUID(),
                target: { kind: 'machine', machineId: controller.machineId }, input: { homeId, managedId: created.machine.id } });
            const inspectorMint = await app.inject({ method: 'POST', url: bindExternalActionExecutionAuthorizationHttpPathV1('machines.managed.inspect'),
                headers: { authorization: `Bearer ${token}` }, payload: { v: 1, machineId: controller.machineId, envelope: inspectorEnvelope } });
            expect(inspectorMint.statusCode, inspectorMint.body).toBe(200);
            const inspector = remember(ExternalActionExecutionAuthorizationV1Schema.parse(inspectorMint.json()));
            const current = await post(inspector, 'machines.managed.inspect', '/v1/machines/managed/controller/current', { ...correlation, nativeRole: 'inspect' });
            expect(current.statusCode, current.body).toBe(200);
            expect(current.json()).toMatchObject({ machine: { resource: previous, submittedNativeEffect: {
                requestId: origin.requestId, intentRevision: 1, intent: 'rebuild', reviewedEffectDigest: rebuildInput.reviewedEffectDigest,
            } } });
            const recovered = await post(inspector, 'machines.managed.inspect', '/v1/machines/managed/controller/report-intent', report);
            expect(recovered.statusCode, recovered.body).toBe(200);
            expect(recovered.json()).toMatchObject({ machine: { resource: replacement } });
            expect(recovered.json().machine).not.toHaveProperty('submittedNativeEffect');
            expect(recovered.json().machine).not.toHaveProperty('enrolledMachineId');
            expect(await db.managedMachine.count({ where: { id: created.machine.id } })).toBe(1);
        } finally { await app.close(); }
    });

    it('does not widen an already admitted PAT grant when issuing its later execution authorization', async () => {
        const fixture = await createFixture({ qualifiedPat: false });
        const grant = { ...API_TOKEN_FULL_GRANT_V1, actions: { families: [], ids: ['machines.managed.acquire'] } };
        const principal = (await auth.verifyTokenForRoute(fixture.pat.token))?.apiTokenPrincipal;
        if (!principal) throw new Error('Missing authenticated PAT fixture');
        // A previously admitted root retains its original grant even when the
        // credential's current row is broader at this later mint boundary.
        await expect(auth.mintExternalActionExecutionAuthorization({
            serverIdentityId: await getOrCreateServerIdentityId(), accountId: fixture.account.id,
            principalId: principal.principalId, credentialId: principal.credentialId, grant,
            machineId: fixture.machine.id, actionId: 'session.spawn_new', requestId: crypto.randomUUID(),
            requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(fixture.envelope),
            target: { kind: 'machine', machineId: fixture.machine.id },
        })).rejects.toMatchObject({ code: 'credential_scope_denied' });
    });

    it.each([
        {
            actionId: "identity.providers.test.start",
            body: {
                owner: { kind: "home" },
                id: "missing-provider",
                expectedRevision: 1,
                expectedSecurityRevision: 1,
            },
            expectedStatus: 403,
            expectedDomainError: "identity_provider_forbidden",
        },
        {
            actionId: "teams.identity.connections.test.start",
            body: {
                v: 1,
                teamId: "team_missing",
                connectionId: "missing-connection",
                expectedRevision: 1,
            },
            expectedStatus: 404,
            expectedDomainError: "team_not_found",
        },
    ] as const)(
        "admits signed external PAT execution for Lane 03 action $actionId only as far as domain authorization",
        async ({ actionId, body, expectedStatus, expectedDomainError }) => {
            const fixture = await createFixture({ qualifiedPat: false });
            const { app } = await createRealLane03App();
            try {
                const envelope = ExternalActionRequestEnvelopeV1Schema.parse({
                    v: 1,
                    requestId: crypto.randomUUID(),
                    target: { kind: "machine", machineId: fixture.machine.id },
                    input: body,
                });
                const authorization = await mint(app, fixture, actionId, envelope);
                const transport = getActionSpec(actionId).serverTransport;
                if (!transport) throw new Error(`test Action ${actionId} has no server transport`);
                const response = await app.inject({
                    method: transport.method,
                    url: transport.path,
                    headers: machineHeaders({
                        authorizationToken: authorization.token,
                        target: authorization.binding.target,
                        effectActionId: actionId,
                        method: transport.method,
                        path: transport.path,
                        body,
                        privateKey: fixture.keyPair.secretKey,
                    }),
                    payload: body,
                });

                expect(response.json()).toEqual({ error: expectedDomainError });
                expect(response.statusCode).toBe(expectedStatus);
            } finally {
                await app.close();
            }
        },
    );

    it("keeps Lane 03 external Action admission at the canonical proof owner without route-local Action lists", async () => {
        const { app, duplicateExternalActionAdmissionRoutes } = await createRealLane03App();
        try {
            expect(duplicateExternalActionAdmissionRoutes).toEqual([]);
        } finally {
            await app.close();
        }
    });

    it("reconstructs the current PAT for one exact signed cross-Machine RPC and rejects substitution", async () => {
        const fixture = await createFixture({ qualifiedPat: true });
        const { app } = await createApp(fixture.team.id);
        try {
            const authorization = await mint(app, fixture);
            const method = `${fixture.machine.id}:daemon.mergedContributionRegistry.projection.describe`;
            const requestId = crypto.randomUUID();
            const params = { machineId: fixture.machine.id };
            const execution = {
                v: 1 as const,
                authorization,
                effectActionId: ACTION_ID,
                target: authorization.binding.target,
                installationId: fixture.machine.installationId!,
                machineSignature: signExternalActionMachineRpcRequestV1({
                    authorizationToken: authorization.token,
                    effectActionId: ACTION_ID,
                    target: authorization.binding.target,
                    installationId: fixture.machine.installationId!,
                    event: SOCKET_RPC_EVENTS.CALL,
                    method,
                    requestId,
                    params,
                    privateKey: fixture.keyPair.secretKey,
                }),
            };

            const verified = await verifyExternalActionMachineRpcExecution(execution, { method, requestId, params });
            expect(verified?.principal).toMatchObject({
                accountId: fixture.account.id,
                credentialId: fixture.pat.tokenId,
                authority: "account_automation",
            });
            for (const bindingPatch of [
                { accountId: "account-substituted" },
                { custodianAccountId: "custodian-substituted" },
                { installationId: "installation-substituted" },
                { principalId: "principal-substituted" },
                { credentialId: "credential-substituted" },
                { actionId: "teams.list" },
                { requestId: "request-substituted" },
                { requestEnvelopeDigest: "digest-substituted" },
                { accountEncryptionMode: 'plain' as const },
                { managedContinuation: { managedId: 'unrelated-managed', creationRequestId: 'unrelated-creation',
                    expectedIntentRevision: 0, controller: { machineId: fixture.machine.id, installationId: fixture.machine.installationId! },
                    acquireRequestEnvelopeDigest: authorization.binding.requestEnvelopeDigest } },
                { grant: { ...API_TOKEN_FULL_GRANT_V1, approve: true } },
                { target: { kind: "machine" as const, machineId: "target-machine-substituted" } },
            ]) {
                await expect(verifyExternalActionMachineRpcExecution({
                    ...execution,
                    authorization: {
                        ...execution.authorization,
                        binding: {
                            ...execution.authorization.binding,
                            ...bindingPatch,
                        },
                    },
                }, { method, requestId, params })).resolves.toBeNull();
            }
            await expect(verifyExternalActionMachineRpcExecution({
                ...execution,
                effectActionId: "teams.list",
            }, { method, requestId, params })).resolves.toBeNull();
            await expect(verifyExternalActionMachineRpcExecution({
                ...execution,
                authorization: {
                    ...execution.authorization,
                    binding: {
                        ...execution.authorization.binding,
                        serverIdentityId: "srv_substituted_home",
                    },
                },
            }, { method, requestId, params })).resolves.toBeNull();
            await expect(verifyExternalActionMachineRpcExecution(execution, {
                method,
                requestId,
                params: { machineId: "substituted" },
            })).resolves.toBeNull();
            const otherMachineMethod = `other-machine:daemon.mergedContributionRegistry.projection.describe`;
            const otherMachineExecution = {
                ...execution,
                machineSignature: signExternalActionMachineRpcRequestV1({
                    authorizationToken: authorization.token,
                    effectActionId: ACTION_ID,
                    target: authorization.binding.target,
                    installationId: fixture.machine.installationId!,
                    event: SOCKET_RPC_EVENTS.CALL,
                    method: otherMachineMethod,
                    requestId,
                    params,
                    privateKey: fixture.keyPair.secretKey,
                }),
            };
            await expect(verifyExternalActionMachineRpcExecution(otherMachineExecution, {
                method: otherMachineMethod,
                requestId,
                params,
            })).resolves.toMatchObject({
                principal: {
                    accountId: fixture.account.id,
                    credentialId: fixture.pat.tokenId,
                    authority: "account_automation",
                },
            });
            await expect(verifyExternalActionMachineRpcExecution({
                ...otherMachineExecution,
                authorization: {
                    ...otherMachineExecution.authorization,
                    binding: {
                        ...otherMachineExecution.authorization.binding,
                        machineId: "substituted-relay-machine",
                    },
                },
            }, {
                method: otherMachineMethod,
                requestId,
                params,
            })).resolves.toBeNull();
            await expect(verifyExternalActionMachineRpcExecution(otherMachineExecution, {
                method: `${otherMachineMethod}.substituted`,
                requestId,
                params,
            })).resolves.toBeNull();
        } finally {
            await app.close();
        }
    });

    it("binds protected input to the exact payload and persists the invocation's original constraints", async () => {
        const fixture = await createFixture({ qualifiedPat: true });
        const session = await db.session.create({ data: {
            accountId: fixture.account.id, tag: crypto.randomUUID(), metadata: "{}", encryptionMode: "plain",
        } });
        await db.machine.update({ where: { accountId_id: { accountId: fixture.account.id, id: fixture.machine.id } },
            data: { operationProtocolCapabilities: { sessionInputAdmission: { protocolVersions: [1, 2] } }, operationProtocolCapabilitiesRevision: 1 } });
        await db.accessKey.create({ data: { accountId: fixture.account.id, machineId: fixture.machine.id, sessionId: session.id, data: "key" } });
        try {
            const grant = { ...API_TOKEN_FULL_GRANT_V1, actions: { families: [], ids: ["session.message.send" as const] },
                targets: { sessions: [session.id], machines: [] }, approve: false, permissionModes: ["default" as const] };
            const issued = await auth.createApiToken({ accountId: fixture.account.id, tokenId: crypto.randomUUID(), label: "input", grant });
            const principal = (await auth.verifyTokenForRoute(issued.token))?.apiTokenPrincipal;
            if (!principal) throw new Error("Missing authenticated test principal");
            const target = { kind: "session" as const, sessionId: session.id };
            const authorization = await auth.mintExternalActionExecutionAuthorization({
                serverIdentityId: await getOrCreateServerIdentityId(), accountId: principal.accountId,
                principalId: principal.principalId, credentialId: principal.credentialId, grant,
                machineId: fixture.machine.id, actionId: "session.message.send", requestId: crypto.randomUUID(),
                requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1({ v: 1, target, input: { text: "input" } }), target,
            });
            await auth.updateApiToken({ accountId: fixture.account.id, tokenId: principal.credentialId, grant: API_TOKEN_FULL_GRANT_V1 });
            const request = { v: 1 as const, sessionId: session.id, targetMachineId: fixture.machine.id, localId: "protected-input",
                content: { t: "plain" as const, v: { role: "user", content: { type: "text", text: "input" } } },
                requestedAction: { v: 1 as const, kind: "enqueue" as const } };
            const externalAction = { v: 1 as const, authorization, target, effectActionId: "session.message.send",
                installationId: fixture.machine.installationId!, machineSignature: signExternalActionMachineRpcRequestV1({
                    authorizationToken: authorization.token, target, effectActionId: "session.message.send",
                    installationId: fixture.machine.installationId!, requestId: authorization.binding.requestId,
                    event: SESSION_PENDING_ENQUEUE_BY_MACHINE_EVENT_V1, method: SESSION_PENDING_ENQUEUE_BY_MACHINE_EVENT_V1,
                    params: request, privateKey: fixture.keyPair.secretKey,
                }) };
            const socket = createFakeSocket({ data: { clientType: "machine-scoped", machineId: fixture.machine.id,
                verifiedMachineInstallationId: fixture.machine.installationId } });
            // Only the Socket.IO transport is a fixture; proof verification and durable admission remain real.
            machineUpdateHandler(fixture.account.id, socket as unknown as Socket, {
                operationSocketBatchLimits: { ok: true, limits: { maxItems: 200, maxSerializedBytes: 524_288 } },
            });
            const invoke = getSocketHandler(socket, SESSION_PENDING_ENQUEUE_BY_MACHINE_EVENT_V1);
            let response: unknown;
            await invoke({ ...request, localId: "substituted", externalAction }, (value: unknown) => { response = value; });
            expect(response).toMatchObject({ result: { status: "rejected", code: "session_input_unauthorized" } });
            expect(await db.sessionPendingMessage.findFirst({ where: { sessionId: session.id } })).toBeNull();
            await invoke({ ...request, externalAction }, (value: unknown) => { response = value; });
            expect(response).toMatchObject({ result: { status: "accepted", localId: request.localId } });
            expect(await db.sessionPendingMessage.findFirst({ where: { sessionId: session.id, localId: request.localId } }))
                .toMatchObject({ inputAdmissionReceipt: { issuer: "authenticatedMachine",
                    callerInputConstraints: { models: null, permissionModes: ["default"] } } });
        } finally {
            await db.sessionPendingMessage.deleteMany({ where: { sessionId: session.id } });
            await db.accessKey.deleteMany({ where: { sessionId: session.id } });
        }
    });

    it("uses the originating PAT evidence rather than daemon ambient qualification", async () => {
        const qualified = await createFixture({ qualifiedPat: true });
        const qualifiedRoute = await createApp(qualified.team.id);
        try {
            const authorization = await mint(qualifiedRoute.app, qualified);
            const body = { teamId: qualified.team.id };
            const response = await qualifiedRoute.app.inject({
                method: qualifiedRoute.transport.method,
                url: qualifiedRoute.transport.path,
                headers: machineHeaders({
                    authorizationToken: authorization.token,
                    target: authorization.binding.target,
                    method: qualifiedRoute.transport.method,
                    path: qualifiedRoute.transport.path,
                    body,
                    privateKey: qualified.keyPair.secretKey,
                }),
                payload: body,
            });

            expect(response.statusCode).toBe(200);
            expect(response.json()).toMatchObject({
                qualification: "satisfied",
                rootActionId: ACTION_ID,
                effectActionId: ACTION_ID,
                target: authorization.binding.target,
                principal: {
                    accountId: qualified.account.id,
                    principalId: qualified.account.id,
                    credentialId: qualified.pat.tokenId,
                    authority: "account_automation",
                    authenticationEvidence: [{ kind: "home_method", methodId: "email_password" }],
                },
            });
        } finally {
            await qualifiedRoute.app.close();
        }

        const unqualified = await createFixture({ qualifiedPat: false });
        const unqualifiedRoute = await createApp(unqualified.team.id);
        try {
            const authorization = await mint(unqualifiedRoute.app, unqualified);
            const body = { teamId: unqualified.team.id };
            const response = await unqualifiedRoute.app.inject({
                method: unqualifiedRoute.transport.method,
                url: unqualifiedRoute.transport.path,
                headers: machineHeaders({
                    authorizationToken: authorization.token,
                    target: authorization.binding.target,
                    method: unqualifiedRoute.transport.method,
                    path: unqualifiedRoute.transport.path,
                    body,
                    privateKey: unqualified.keyPair.secretKey,
                }),
                payload: body,
            });

            expect(response.statusCode).toBe(200);
            expect(response.json()).toMatchObject({ qualification: "authentication_required" });
        } finally {
            await unqualifiedRoute.app.close();
        }
    });

    it("revalidates current Home login eligibility before accepting a signed PAT effect", async () => {
        const fixture = await createFixture({ qualifiedPat: true });
        const { app, transport } = await createApp(fixture.team.id);
        const previous = process.env.AUTH_REQUIRED_LOGIN_PROVIDERS;
        try {
            const authorization = await mint(app, fixture);
            process.env.AUTH_REQUIRED_LOGIN_PROVIDERS = "not-configured";
            const body = { teamId: fixture.team.id };
            const response = await app.inject({
                method: transport.method,
                url: transport.path,
                headers: machineHeaders({
                    authorizationToken: authorization.token,
                    target: authorization.binding.target,
                    method: transport.method,
                    path: transport.path,
                    body,
                    privateKey: fixture.keyPair.secretKey,
                }),
                payload: body,
            });
            expect(response.statusCode).toBe(401);
        } finally {
            if (previous === undefined) delete process.env.AUTH_REQUIRED_LOGIN_PROVIDERS;
            else process.env.AUTH_REQUIRED_LOGIN_PROVIDERS = previous;
            await app.close();
        }
    });

    it("binds the proof to the exact body, route, Machine, current PAT, and current evidence row", async () => {
        const fixture = await createFixture({ qualifiedPat: true });
        const { app, transport } = await createApp(fixture.team.id);
        try {
            const authorization = await mint(app, fixture);
            const body = { teamId: fixture.team.id };
            const validHeaders = machineHeaders({
                authorizationToken: authorization.token,
                target: authorization.binding.target,
                method: transport.method,
                path: transport.path,
                body,
                privateKey: fixture.keyPair.secretKey,
            });

            const tamperedBody = await app.inject({
                method: transport.method,
                url: transport.path,
                headers: validHeaders,
                payload: { teamId: "another-team" },
            });
            expect(tamperedBody.statusCode).toBe(401);

            const wrongRoute = await app.inject({
                method: "POST",
                url: bindExternalActionExecutionAuthorizationVerifyHttpPathV1("teams.list"),
                headers: machineHeaders({
                    authorizationToken: authorization.token,
                    target: authorization.binding.target,
                    method: "POST",
                    path: bindExternalActionExecutionAuthorizationVerifyHttpPathV1("teams.list"),
                    body: { v: 1 },
                    privateKey: fixture.keyPair.secretKey,
                }),
                payload: { v: 1 },
            });
            expect(wrongRoute.statusCode).toBe(401);

            const otherKey = tweetnacl.sign.keyPair();
            await db.machine.create({
                data: {
                    id: crypto.randomUUID(),
                    accountId: fixture.account.id,
                    metadata: "substitute",
                    metadataVersion: 1,
                    daemonState: null,
                    daemonStateVersion: 0,
                    installationId: crypto.randomUUID(),
                    installationPublicKey: new Uint8Array(otherKey.publicKey),
                },
            });
            const wrongMachine = await app.inject({
                method: transport.method,
                url: transport.path,
                headers: machineHeaders({
                    authorizationToken: authorization.token,
                    target: authorization.binding.target,
                    method: transport.method,
                    path: transport.path,
                    body,
                    privateKey: otherKey.secretKey,
                }),
                payload: body,
            });
            expect(wrongMachine.statusCode).toBe(401);

            const originalInstallationId = fixture.machine.installationId!;
            await db.machine.update({
                where: { id: fixture.machine.id },
                data: { installationId: crypto.randomUUID() },
            });
            const replacedInstallation = await app.inject({
                method: transport.method,
                url: transport.path,
                headers: validHeaders,
                payload: body,
            });
            expect(replacedInstallation.statusCode).toBe(401);
            await db.machine.update({
                where: { id: fixture.machine.id },
                data: { installationId: originalInstallationId },
            });

            await db.accountApiToken.update({
                where: { id: fixture.pat.tokenId },
                data: { authenticationEvidence: { v: 1, evidence: [] } },
            });
            const evidenceChanged = await app.inject({
                method: transport.method,
                url: transport.path,
                headers: validHeaders,
                payload: body,
            });
            expect(evidenceChanged.statusCode).toBe(200);
            expect(evidenceChanged.json()).toMatchObject({ qualification: "authentication_required" });

            await auth.revokeApiToken({ accountId: fixture.account.id, tokenId: fixture.pat.tokenId });
            const revoked = await app.inject({
                method: transport.method,
                url: transport.path,
                headers: validHeaders,
                payload: body,
            });
            expect(revoked.statusCode).toBe(401);
        } finally {
            await app.close();
        }
    });

    it("keeps the authorization useless without the exact registered Machine signature and preserves allowed bearer admission", async () => {
        const fixture = await createFixture({ qualifiedPat: true });
        const { app, transport } = await createApp(fixture.team.id);
        try {
            const authorization = await mint(app, fixture);
            const body = { teamId: fixture.team.id };

            const tokenOnly = await app.inject({
                method: transport.method,
                url: transport.path,
                headers: { [EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]: authorization.token },
                payload: body,
            });
            expect(tokenOnly.statusCode).toBe(401);

            const rawPat = await app.inject({
                method: transport.method,
                url: transport.path,
                headers: { authorization: `Bearer ${fixture.pat.token}` },
                payload: body,
            });
            expect(rawPat.statusCode).toBe(200);

            const accountToken = await auth.createToken(fixture.account.id, undefined, {
                kind: "account",
                authority: "present_user",
            });
            const ordinary = await app.inject({
                method: transport.method,
                url: transport.path,
                headers: { authorization: `Bearer ${accountToken}` },
                payload: body,
            });
            expect(ordinary.statusCode).toBe(200);
        } finally {
            await app.close();
        }
    });

    it("admits a signed auxiliary production read without treating Action serverTransport as a route allowlist", async () => {
        const fixture = await createFixture({ qualifiedPat: true });
        const { app } = await createApp(fixture.team.id);
        try {
            const authorization = await mint(app, fixture);
            const path = "/v1/features/authenticated";
            const response = await app.inject({
                method: "GET",
                url: path,
                headers: machineHeaders({
                    authorizationToken: authorization.token,
                    target: authorization.binding.target,
                    method: "GET",
                    path,
                    body: undefined,
                    privateKey: fixture.keyPair.secretKey,
                }),
            });

            expect(response.statusCode).toBe(200);
            expect(response.json()).toMatchObject({ capabilities: { serverIdentity: {} } });
        } finally {
            await app.close();
        }
    });

    it("admits the real Follow source-list handler from the exact signed PAT invocation without a duplicate route allowlist", async () => {
        const fixture = await createFixture({ qualifiedPat: true });
        const destination = await db.session.create({
            data: {
                tag: `external-follow-destination-${crypto.randomUUID()}`,
                accountId: fixture.account.id,
                encryptionMode: "plain",
                metadataLayoutVersion: 1,
                metadata: JSON.stringify({ v: 1 }),
                ownerMetadata: JSON.stringify({ t: "plain", v: { v: 1 } }),
                agentState: null,
            },
        });
        const { app } = await createApp(fixture.team.id);
        try {
            const actionId = "session.follow.sources.list";
            const envelope: ExternalActionRequestEnvelopeV1 = {
                v: 1,
                requestId: crypto.randomUUID(),
                target: { kind: "machine", machineId: fixture.machine.id },
                input: { destinationSessionId: destination.id },
            };
            const authorization = await mint(app, fixture, actionId, envelope);
            const path = `/v2/sessions/${destination.id}/follows/sessions`;
            const response = await app.inject({
                method: "GET",
                url: path,
                headers: machineHeaders({
                    authorizationToken: authorization.token,
                    target: authorization.binding.target,
                    effectActionId: actionId,
                    method: "GET",
                    path,
                    body: undefined,
                    privateKey: fixture.keyPair.secretKey,
                }),
            });

            expect(response.statusCode).toBe(200);
            expect(response.json()).toEqual({ sources: [] });
        } finally {
            await app.close();
        }
    });

    it("admits the proof-bound PAT through normal handlers while handler-specific effect, target, resource, and revocation checks stay closed", async () => {
        const fixture = await createFixture({ qualifiedPat: true });
        const now = Date.now();
        const [activeSession, archivedSession] = await Promise.all([
            db.session.create({
                data: {
                    tag: `external-list-active-${crypto.randomUUID()}`,
                    accountId: fixture.account.id,
                    encryptionMode: "plain",
                    metadataLayoutVersion: 1,
                    metadata: JSON.stringify({ v: 1 }),
                    ownerMetadata: JSON.stringify({ t: "plain", v: { v: 1 } }),
                    agentState: null,
                    active: true,
                    lastActiveAt: new Date(now),
                    meaningfulActivityAt: new Date(now),
                    currentStorageState: "hosted",
                },
            }),
            db.session.create({
                data: {
                    tag: `external-list-archived-${crypto.randomUUID()}`,
                    accountId: fixture.account.id,
                    encryptionMode: "plain",
                    metadataLayoutVersion: 1,
                    metadata: JSON.stringify({ v: 1 }),
                    ownerMetadata: JSON.stringify({ t: "plain", v: { v: 1 } }),
                    agentState: null,
                    active: false,
                    archivedAt: new Date(now - 1_000),
                    meaningfulActivityAt: new Date(now - 1_000),
                },
            }),
        ]);
        const foreignAccount = await db.account.create({
            data: { publicKey: crypto.randomUUID(), encryptionMode: "plain" },
        });
        const foreignSession = await db.session.create({
            data: {
                tag: `external-list-foreign-${crypto.randomUUID()}`,
                accountId: foreignAccount.id,
                encryptionMode: "plain",
                metadataLayoutVersion: 1,
                metadata: JSON.stringify({ v: 1 }),
                ownerMetadata: JSON.stringify({ t: "plain", v: { v: 1 } }),
                agentState: null,
            },
        });
        await db.sessionMessage.create({
            data: {
                sessionId: activeSession.id,
                localId: `external-list-preview-${crypto.randomUUID()}`,
                seq: 1,
                messageRole: "user",
                content: {
                    t: "plain",
                    v: {
                        role: "user",
                        content: { type: "text", text: "signed session.list preview" },
                    },
                },
                inputAdmissionReceipt: {
                    v: 1,
                    issuer: "authenticatedAccount",
                    actorAccountId: fixture.account.id,
                    sessionRelationship: "owner",
                },
            },
        });
        const { app } = await createApp(fixture.team.id);
        try {
            const envelope: ExternalActionRequestEnvelopeV1 = {
                v: 1,
                requestId: crypto.randomUUID(),
                target: { kind: "machine", machineId: fixture.machine.id },
                input: {},
            };
            const authorization = await mint(app, fixture, "session.list", envelope);
            const signedGet = (
                path: string,
                effectActionId = "session.list",
                target: ExternalActionRequestEnvelopeV1["target"] = authorization.binding.target,
            ) => app.inject({
                method: "GET",
                url: path,
                headers: machineHeaders({
                    authorizationToken: authorization.token,
                    target,
                    effectActionId,
                    method: "GET",
                    path,
                    body: undefined,
                    privateKey: fixture.keyPair.secretKey,
                }),
            });
            const signedPost = (
                path: string,
                body: unknown,
                effectActionId = "session.list",
            ) => app.inject({
                method: "POST",
                url: path,
                headers: machineHeaders({
                    authorizationToken: authorization.token,
                    effectActionId,
                    method: "POST",
                    path,
                    body,
                    privateKey: fixture.keyPair.secretKey,
                }),
                payload: body,
            });
            const previewPath = `/v1/sessions/${activeSession.id}/messages?limit=1&scope=main&roles=user%2Cagent`;
            const filteredPath = "/v2/sessions/query";
            const filteredBody = {
                v: 1,
                storage: "active",
                includeInactive: true,
                scope: "all_accessible",
                attention: "any",
                audiences: [],
                tagIds: [],
            } as const;
            const [legacyListed, listed, active, archived, detail, filtered, currentness, previewMessages] = await Promise.all([
                signedGet("/v1/sessions"),
                signedGet("/v2/sessions?limit=10"),
                signedGet("/v2/sessions/active?limit=10"),
                signedGet("/v2/sessions/archived?limit=10"),
                signedGet(`/v2/sessions/${activeSession.id}`),
                signedPost(filteredPath, filteredBody),
                signedGet("/v1/account/encryption/currentness"),
                signedGet(previewPath),
            ]);
            expect(legacyListed.statusCode).toBe(200);
            expect(legacyListed.json().sessions.map((session: { id: string }) => session.id))
                .toContain(activeSession.id);
            expect(listed.statusCode).toBe(200);
            expect(listed.json().sessions.map((session: { id: string }) => session.id))
                .toContain(activeSession.id);
            expect(active.statusCode).toBe(200);
            expect(active.json().sessions.map((session: { id: string }) => session.id))
                .toEqual([activeSession.id]);
            expect(archived.statusCode).toBe(200);
            expect(archived.json().sessions.map((session: { id: string }) => session.id))
                .toEqual([archivedSession.id]);
            expect(detail.statusCode).toBe(200);
            expect(detail.json()).toMatchObject({ session: { id: activeSession.id } });
            expect(filtered.statusCode).toBe(200);
            expect(filtered.json().sessions.map((session: { id: string }) => session.id))
                .toContain(activeSession.id);
            expect(currentness.statusCode).toBe(200);
            expect(currentness.json()).toMatchObject({ mode: "plain" });
            expect(previewMessages.statusCode).toBe(200);
            expect(previewMessages.json()).toEqual({
                messages: [{
                    id: expect.any(String),
                    seq: 1,
                    localId: expect.any(String),
                    messageRole: "user",
                    content: {
                        t: "plain",
                        v: {
                            role: "user",
                            content: { type: "text", text: "signed session.list preview" },
                        },
                    },
                    createdAt: expect.any(Number),
                    updatedAt: expect.any(Number),
                }],
                hasMore: false,
                nextBeforeSeq: null,
                nextAfterSeq: null,
            });

            for (const path of [
                "/v1/sessions",
                "/v2/sessions?limit=10",
                "/v2/sessions/active?limit=10",
                "/v2/sessions/archived?limit=10",
                "/v1/account/encryption/currentness",
            ]) {
                const raw = await app.inject({
                    method: "GET",
                    url: path,
                    headers: { ...currentAccountStoredContentCompatibilityHeaders,
                        authorization: `Bearer ${fixture.pat.token}` },
                });
                expect(raw.statusCode, path).toBe(403);
                expect(raw.json(), path).toEqual({ error: "present_user_required" });
            }
            // Full PATs may read a named accessible Session directly; only the
            // Account-wide surfaces above still require proof-bound admission.
            for (const path of [`/v2/sessions/${activeSession.id}`, previewPath]) {
                const raw = await app.inject({ method: "GET", url: path, headers: {
                    ...currentAccountStoredContentCompatibilityHeaders,
                    authorization: `Bearer ${fixture.pat.token}`,
                } });
                expect(raw.statusCode, raw.body).toBe(200);
            }
            const rawFiltered = await app.inject({
                method: "POST",
                url: filteredPath,
                headers: { authorization: `Bearer ${fixture.pat.token}` },
                payload: filteredBody,
            });
            expect(rawFiltered.statusCode).toBe(403);
            const [
                accountSettings,
                accountEncryption,
                alternateEffectListing,
                alternateEffectPreview,
                previewSidechainTraversal,
                previewCursorTraversal,
                previewOversizedRead,
                previewNarrowedRole,
                previewOutsideSessionTarget,
                inaccessibleSessionPreview,
                alternateEffectFiltered,
            ] = await Promise.all([
                signedGet("/v2/account/settings"),
                signedGet("/v1/account/encryption"),
                signedGet("/v2/sessions?limit=10", ACTION_ID),
                signedGet(previewPath, ACTION_ID),
                signedGet(`/v1/sessions/${activeSession.id}/messages?limit=1&scope=all&roles=user%2Cagent`),
                signedGet(`/v1/sessions/${activeSession.id}/messages?limit=1&afterSeq=0&scope=main&roles=user%2Cagent`),
                signedGet(`/v1/sessions/${activeSession.id}/messages?limit=2&scope=main&roles=user%2Cagent`),
                signedGet(`/v1/sessions/${activeSession.id}/messages?limit=1&scope=main&roles=user`),
                signedGet(previewPath, "session.list", { kind: "session", sessionId: archivedSession.id }),
                signedGet(`/v1/sessions/${foreignSession.id}/messages?limit=1&scope=main&roles=user%2Cagent`),
                signedPost(filteredPath, filteredBody, ACTION_ID),
            ]);
            expect(accountSettings.statusCode, accountSettings.body).toBe(200);
            expect(accountEncryption.statusCode, accountEncryption.body).toBe(200);
            expect(alternateEffectListing.statusCode).toBe(200);
            expect(alternateEffectPreview.statusCode).toBe(200);
            expect(previewSidechainTraversal.statusCode).toBe(403);
            expect(previewCursorTraversal.statusCode).toBe(403);
            expect(previewOversizedRead.statusCode).toBe(403);
            expect(previewNarrowedRole.statusCode).toBe(403);
            expect(previewOutsideSessionTarget.statusCode).toBe(403);
            expect(inaccessibleSessionPreview.statusCode).toBe(404);
            expect(alternateEffectFiltered.statusCode).toBe(200);

            await auth.revokeApiToken({
                accountId: fixture.account.id,
                tokenId: fixture.pat.tokenId,
            });
            expect((await signedGet("/v2/sessions?limit=10")).statusCode).toBe(401);
        } finally {
            await app.close();
        }
    });

    it("preserves explicit present-user domain admission after reconstructing the originating PAT", async () => {
        const fixture = await createFixture({ qualifiedPat: true });
        const { app } = await createApp(fixture.team.id);
        try {
            const authorization = await mint(app, fixture);
            const path = "/test/present-user-only";
            const body = { operation: "interactive-only" };
            const response = await app.inject({
                method: "POST",
                url: path,
                headers: machineHeaders({
                    authorizationToken: authorization.token,
                    target: authorization.binding.target,
                    method: "POST",
                    path,
                    body,
                    privateKey: fixture.keyPair.secretKey,
                }),
                payload: body,
            });

            expect(response.statusCode).toBe(403);
            expect(response.json()).toEqual({ error: "present_user_required" });
        } finally {
            await app.close();
        }
    });

    it("lets the ordinary Session handler deny a signed resolved target the originating PAT cannot read", async () => {
        const fixture = await createFixture({ qualifiedPat: true });
        const foreignAccount = await db.account.create({
            data: { publicKey: crypto.randomUUID(), encryptionMode: "plain" },
        });
        const foreignSession = await db.session.create({
            data: {
                tag: crypto.randomUUID(),
                accountId: foreignAccount.id,
                encryptionMode: "plain",
                metadata: "foreign",
                metadataVersion: 1,
            },
        });
        const { app } = await createApp(fixture.team.id);
        try {
            const authorization = await mint(app, fixture);
            const path = `/v2/sessions/${foreignSession.id}`;
            const target = { kind: "session" as const, sessionId: foreignSession.id };
            const response = await app.inject({
                method: "GET",
                url: path,
                headers: machineHeaders({
                    authorizationToken: authorization.token,
                    target,
                    method: "GET",
                    path,
                    body: undefined,
                    privateKey: fixture.keyPair.secretKey,
                }),
            });

            expect(response.statusCode).toBe(404);
        } finally {
            await app.close();
        }
    });

    it("rechecks the same authorization and Machine at the signed currentness endpoint", async () => {
        const fixture = await createFixture({ qualifiedPat: true });
        const { app } = await createApp(fixture.team.id);
        try {
            const authorization = await mint(app, fixture);
            const path = bindExternalActionExecutionAuthorizationVerifyHttpPathV1(ACTION_ID);
            const body = { v: 1 } as const;
            const unsigned = await app.inject({ method: "POST", url: path, payload: body });
            expect(unsigned.statusCode).toBe(401);
            const headers = machineHeaders({
                authorizationToken: authorization.token,
                target: authorization.binding.target,
                method: "POST",
                path,
                body,
                privateKey: fixture.keyPair.secretKey,
            });
            const current = await app.inject({ method: "POST", url: path, headers, payload: body });
            expect(current.statusCode).toBe(200);
            expect(current.json()).toEqual({ ok: true });

            const queryPath = `${path}?bypass=1`;
            const queryBypass = await app.inject({
                method: "POST",
                url: queryPath,
                headers: machineHeaders({
                    authorizationToken: authorization.token,
                    target: authorization.binding.target,
                    method: "POST",
                    path: queryPath,
                    body,
                    privateKey: fixture.keyPair.secretKey,
                }),
                payload: body,
            });
            expect(queryBypass.statusCode).toBe(401);

            const invalidBody = { v: 1, unexpected: true };
            const invalid = await app.inject({
                method: "POST",
                url: path,
                headers: machineHeaders({
                    authorizationToken: authorization.token,
                    target: authorization.binding.target,
                    method: "POST",
                    path,
                    body: invalidBody,
                    privateKey: fixture.keyPair.secretKey,
                }),
                payload: invalidBody,
            });
            expect(invalid.statusCode).toBe(400);

            await db.machine.update({ where: { id: fixture.machine.id }, data: { revokedAt: new Date() } });
            const revokedMachine = await app.inject({ method: "POST", url: path, headers, payload: body });
            expect(revokedMachine.statusCode).toBe(401);
        } finally {
            await app.close();
        }
    });

    it("rejects a deferred authorization after grant narrowing without undoing an already executed effect", async () => {
        const fixture = await createFixture({ qualifiedPat: true });
        const app = await createRealTeamApp();
        try {
            const authorization = await mint(app, fixture, 'approval.request.create');
            const transport = getActionSpec(ACTION_ID).serverTransport;
            if (!transport) throw new Error('test Action has no server transport');
            const body = { v: 1, teamId: fixture.team.id, previousAuthenticationPolicy: fixture.team.authenticationPolicy,
                authenticationPolicy: { v: 1, mode: 'inherit' } };
            const headers = machineHeaders({ authorizationToken: authorization.token, target: authorization.binding.target,
                method: transport.method, path: transport.path, body, privateKey: fixture.keyPair.secretKey });
            const executed = await app.inject({ method: transport.method, url: transport.path, headers, payload: body });
            expect(executed.statusCode, executed.body).toBe(200);
            expect((await db.team.findUniqueOrThrow({ where: { id: fixture.team.id } })).authenticationPolicy).toBeNull();
            await db.accountApiToken.update({ where: { id: fixture.pat.tokenId }, data: {
                accessGrant: { ...API_TOKEN_FULL_GRANT_V1, actions: { families: [], ids: ['session.transcript.get'] } },
            } });
            const replay = await app.inject({ method: transport.method, url: transport.path, headers, payload: body });
            expect(replay.statusCode, replay.body).toBe(401);
            expect((await db.team.findUniqueOrThrow({ where: { id: fixture.team.id } })).authenticationPolicy).toBeNull();
            const path = bindExternalActionExecutionAuthorizationVerifyHttpPathV1('approval.request.create');
            const currentnessBody = { v: 1 };
            const deferred = await app.inject({ method: 'POST', url: path, payload: currentnessBody,
                headers: machineHeaders({ authorizationToken: authorization.token, target: authorization.binding.target,
                    method: 'POST', path, body: currentnessBody, privateKey: fixture.keyPair.secretKey }) });
            expect(deferred.statusCode).toBe(401);
        } finally { await app.close(); }
    });

    it("refuses daemon-local minting outside the current Session grant and admits its named Session", async () => {
        const fixture = await createFixture({ qualifiedPat: true });
        const { app } = await createApp(fixture.team.id);
        try {
            await db.accountApiToken.update({ where: { id: fixture.pat.tokenId }, data: {
                accessGrant: { ...API_TOKEN_FULL_GRANT_V1, targets: { sessions: ['S1'], machines: [] } },
            } });
            const request = (sessionId: string) => app.inject({ method: 'POST',
                url: bindExternalActionExecutionAuthorizationHttpPathV1('session.message.send'),
                headers: { authorization: `Bearer ${fixture.pat.token}` },
                payload: { v: 1, machineId: fixture.machine.id, envelope: { ...fixture.envelope,
                    target: { kind: 'session', sessionId } } } });
            const refused = await request('S2');
            expect(refused.statusCode, refused.body).toBe(403);
            expect(refused.json()).toMatchObject({ error: 'credential_scope_denied' });
            const admitted = await request('S1');
            expect(admitted.statusCode, admitted.body).toBe(200);
            expect(ExternalActionExecutionAuthorizationV1Schema.parse(admitted.json()).binding.target)
                .toEqual({ kind: 'session', sessionId: 'S1' });
        } finally { await app.close(); }
    });

    it("refuses an ungranted relay Session before transport and attenuates verified machine membership without rewriting grants", async () => {
        const fixture = await createFixture({ qualifiedPat: true });
        await db.machine.update({ where: { id: fixture.machine.id }, data: {
            operationProtocolCapabilitiesRevision: 1,
            operationProtocolCapabilities: { externalActionExecutionAuthorization: { protocolVersions: [1] } },
        } });
        const fence = new Date();
        for (const sessionId of ['S1', 'S2']) {
            await db.session.create({ data: { id: sessionId, accountId: fixture.account.id, tag: sessionId,
                metadata: '{}', active: true, lastActiveAt: fence } });
            await db.accessKey.create({ data: { accountId: fixture.account.id, machineId: fixture.machine.id,
                sessionId, data: 'encrypted' } });
        }
        const presence = createSessionPublisherPresence();
        // Only Socket.IO discovery and the daemon transport are simulated; current publisher,
        // credential, grant, placement and persistence decisions remain the real owners.
        let publisherVisible = true;
        const io = { in: (room: string) => ({ fetchSockets: async () => publisherVisible
            ? ['S1', 'S2'].filter((sessionId) => room === getAccountSessionSocketRoom(fixture.account.id, sessionId))
                .map((sessionId) => ({ data: { sessionPublisherAuthority: { v: 1, accountId: fixture.account.id,
                    machineId: fixture.machine.id, sessionId, committedFenceMs: fence.getTime() } } }))
            : [] }) } as unknown as Server;
        const sentSessions: string[] = [];
        const dispatch = createExternalActionDaemonDispatcher({ io, sessionPublisherPresence: presence,
            forwardRpc: async ({ callParams }) => {
                const request = callParams as { actionId: string; envelope: ExternalActionRequestEnvelopeV1 };
                if (request.envelope.target?.kind === 'session') sentSessions.push(request.envelope.target.sessionId);
                return { ok: true, result: createExternalActionDaemonDispatchResponseV1(prepareExternalActionResponseEnvelopeV1({
                    v: 1, actionId: request.actionId, requestId: request.envelope.requestId,
                    execution: { ok: true, result: { accepted: true } },
                })) };
            } });
        const app = Fastify({ logger: false }).withTypeProvider<ZodTypeProvider>() as any;
        app.setValidatorCompiler(validatorCompiler);
        app.setSerializerCompiler(serializerCompiler);
        enableAuthentication(app);
        registerExternalActionRoutes(app, { dispatch });
        await app.ready();
        try {
            const grant = { ...API_TOKEN_FULL_GRANT_V1, targets: { sessions: ['S1'], machines: [] } };
            await db.accountApiToken.update({ where: { id: fixture.pat.tokenId }, data: { accessGrant: grant } });
            const relay = (sessionId: string) => app.inject({ method: 'POST', url: '/v1/actions/session.message.send',
                headers: { authorization: `Bearer ${fixture.pat.token}` }, payload: { ...fixture.envelope,
                    target: { kind: 'session', sessionId } } });
            const refused = await relay('S2');
            expect(refused.statusCode, refused.body).toBe(403);
            expect(refused.json()).toEqual({ error: 'credential_scope_denied' });
            expect(sentSessions).toEqual([]);
            const admitted = await relay('S1');
            expect(admitted.statusCode, admitted.body).toBe(200);
            expect(sentSessions).toEqual(['S1']);

            const machineGrant = { ...API_TOKEN_FULL_GRANT_V1, targets: { sessions: [], machines: [fixture.machine.id] } };
            await db.accountApiToken.update({ where: { id: fixture.pat.tokenId }, data: { accessGrant: machineGrant } });
            const parent = await auth.verifyPat(fixture.pat.token);
            if (!parent.ok) throw new Error('fixture credential was not verified');
            const childGrant = { ...API_TOKEN_FULL_GRANT_V1, targets: { sessions: ['S1'], machines: [] } };
            const mintChild = () => auth.createChildApiToken({ principal: parent, tokenId: crypto.randomUUID(), label: 'Session',
                expiresAt: new Date(Date.now() + 60_000), grant: childGrant,
                resolveSessionMachine: (sessionId) => resolveCurrentSessionMachineFromServer({
                    io, presence, accountId: fixture.account.id, sessionId,
                }) });
            const child = await mintChild();
            expect(child.grant).toEqual(childGrant);
            expect((await db.accountApiToken.findUniqueOrThrow({ where: { id: fixture.pat.tokenId } })).accessGrant).toEqual(machineGrant);
            publisherVisible = false;
            await expect(mintChild()).rejects.toMatchObject({ code: 'api_token_child_invalid' });
        } finally { await app.close(); }
    });

    it("admits a signed decision proof only when the current credential retains approve", async () => {
        const fixture = await createFixture({ qualifiedPat: true });
        const { app } = await createApp(fixture.team.id);
        try {
            await db.accountApiToken.update({ where: { id: fixture.pat.tokenId }, data: {
                accessGrant: { ...API_TOKEN_FULL_GRANT_V1, approve: true },
            } });
            const authorization = await mint(app, fixture, 'approval.request.decide');
            const method = 'S1:permission';
            const requestId = crypto.randomUUID();
            const params = { id: 'request', approved: true };
            const execution = { v: 1 as const, authorization, effectActionId: 'approval.request.decide',
                target: authorization.binding.target, installationId: fixture.machine.installationId!,
                machineSignature: signExternalActionMachineRpcRequestV1({ authorizationToken: authorization.token,
                    effectActionId: 'approval.request.decide', target: authorization.binding.target,
                    installationId: fixture.machine.installationId!, event: SOCKET_RPC_EVENTS.CALL, method, requestId, params,
                    privateKey: fixture.keyPair.secretKey }) };
            expect(await verifyExternalActionMachineRpcExecution(execution, { method, requestId, params })).not.toBeNull();
            await db.accountApiToken.update({ where: { id: fixture.pat.tokenId }, data: { accessGrant: API_TOKEN_FULL_GRANT_V1 } });
            expect(await verifyExternalActionMachineRpcExecution(execution, { method, requestId, params })).toBeNull();

            const withoutApprove = await mint(app, fixture, ACTION_ID);
            await db.accountApiToken.update({ where: { id: fixture.pat.tokenId }, data: {
                accessGrant: { ...API_TOKEN_FULL_GRANT_V1, approve: true },
            } });
            const widenedProof = { ...execution, authorization: withoutApprove,
                target: withoutApprove.binding.target,
                machineSignature: signExternalActionMachineRpcRequestV1({ authorizationToken: withoutApprove.token,
                    effectActionId: 'approval.request.decide', target: withoutApprove.binding.target,
                    installationId: fixture.machine.installationId!, event: SOCKET_RPC_EVENTS.CALL, method, requestId, params,
                    privateKey: fixture.keyPair.secretKey }) };
            expect(await verifyExternalActionMachineRpcExecution(widenedProof, { method, requestId, params })).toBeNull();
        } finally { await app.close(); }
    });

    it("binds a V1 invocation without optional correlation or target to the selected Machine", async () => {
        const fixture = await createFixture({ qualifiedPat: true });
        const { app } = await createApp(fixture.team.id);
        const envelope = { v: 1 as const, input: { teamId: fixture.team.id } };
        try {
            const response = await app.inject({
                method: "POST",
                url: bindExternalActionExecutionAuthorizationHttpPathV1(ACTION_ID),
                headers: { authorization: `Bearer ${fixture.pat.token}` },
                payload: { v: 1, machineId: fixture.machine.id, envelope },
            });
            expect(response.statusCode).toBe(200);
            const authorization = ExternalActionExecutionAuthorizationV1Schema.parse(response.json());
            authorizationRequests.set(authorization.token, {
                target: authorization.binding.target,
                installationId: fixture.machine.installationId!,
                requestId: authorization.binding.requestId,
            });
            expect(authorization.binding).toMatchObject({
                machineId: fixture.machine.id,
                target: { kind: "machine", machineId: fixture.machine.id },
                requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope),
            });
            expect(authorization.binding.requestId.length).toBeGreaterThan(0);
        } finally {
            await app.close();
        }
    });

    it.each(["approval.request.create", "action.invoke", "acme.workflow/actions/update-team"] as const)(
        "allows the trusted Machine to bind a resolved effect for outer %s",
        async (outerActionId) => {
            const fixture = await createFixture({ qualifiedPat: true });
            if (outerActionId !== 'approval.request.create') {
                await db.accountApiToken.update({ where: { id: fixture.pat.tokenId }, data: {
                    accessGrant: { ...API_TOKEN_FULL_GRANT_V1, actions: { families: [], ids: ['acme.workflow/actions/update-team'] } },
                } });
            }
            const envelope = outerActionId === 'action.invoke' ? { ...fixture.envelope, input: {
                action: { pluginId: 'acme.workflow', localId: 'update-team' }, input: { teamId: fixture.team.id },
            } } : fixture.envelope;
            const { app, transport } = await createApp(fixture.team.id);
            try {
                const response = await app.inject({
                    method: "POST",
                    url: bindExternalActionExecutionAuthorizationHttpPathV1(outerActionId),
                    headers: { authorization: `Bearer ${fixture.pat.token}` },
                    payload: { v: 1, machineId: fixture.machine.id, envelope },
                });
                expect(response.statusCode).toBe(200);
                const authorization = ExternalActionExecutionAuthorizationV1Schema.parse(response.json());
                authorizationRequests.set(authorization.token, {
                    target: authorization.binding.target,
                    installationId: fixture.machine.installationId!,
                    requestId: authorization.binding.requestId,
                });
                expect(authorization.binding.actionId).toBe(outerActionId);

                const body = { teamId: fixture.team.id };
                const effect = await app.inject({
                    method: transport.method,
                    url: transport.path,
                    headers: machineHeaders({
                        authorizationToken: authorization.token,
                        target: authorization.binding.target,
                        effectActionId: ACTION_ID,
                        method: transport.method,
                        path: transport.path,
                        body,
                        privateKey: fixture.keyPair.secretKey,
                    }),
                    payload: body,
                });
                expect(effect.statusCode).toBe(200);
                expect(effect.json()).toMatchObject({ qualification: "satisfied" });
            } finally {
                await app.close();
            }
        },
    );

    it("does not let a contributed invocation authorize present-user-only token management even with approve", async () => {
        const fixture = await createFixture({ qualifiedPat: true });
        await db.accountApiToken.update({ where: { id: fixture.pat.tokenId }, data: {
            accessGrant: { ...API_TOKEN_FULL_GRANT_V1, approve: true,
                actions: { families: [], ids: ['acme.workflow/actions/update-team'] } },
        } });
        const { app } = await createApp(fixture.team.id);
        try {
            const response = await app.inject({
                method: "POST",
                url: bindExternalActionExecutionAuthorizationHttpPathV1("acme.workflow/actions/update-team"),
                headers: { authorization: `Bearer ${fixture.pat.token}` },
                payload: { v: 1, machineId: fixture.machine.id, envelope: fixture.envelope },
            });
            expect(response.statusCode).toBe(200);
            const authorization = ExternalActionExecutionAuthorizationV1Schema.parse(response.json());
            authorizationRequests.set(authorization.token, {
                target: authorization.binding.target,
                installationId: fixture.machine.installationId!,
                requestId: authorization.binding.requestId,
            });
            const path = "/test/present-user-only";
            const body = { tokenId: crypto.randomUUID(), label: "must remain present-user-only" };
            const effect = await app.inject({
                method: "POST",
                url: path,
                headers: machineHeaders({
                    authorizationToken: authorization.token,
                    target: authorization.binding.target,
                    effectActionId: "account.apiTokens.create",
                    method: "POST",
                    path,
                    body,
                    privateKey: fixture.keyPair.secretKey,
                }),
                payload: body,
            });
            expect(effect.statusCode).toBe(401);
        } finally {
            await app.close();
        }
    });

    it("admits the qualified PAT through the real Team policy mutation and persists its result", async () => {
        const qualified = await createFixture({ qualifiedPat: true });
        const app = await createRealTeamApp();
        try {
            const authorization = await mint(app, qualified);
            const transport = getActionSpec(ACTION_ID).serverTransport;
            if (!transport) throw new Error("test Action has no server transport");
            const body = {
                v: 1 as const,
                teamId: qualified.team.id,
                previousAuthenticationPolicy: qualified.team.authenticationPolicy,
                authenticationPolicy: { v: 1 as const, mode: "inherit" as const },
            };
            const response = await app.inject({
                method: transport.method,
                url: transport.path,
                headers: machineHeaders({
                    authorizationToken: authorization.token,
                    target: authorization.binding.target,
                    method: transport.method,
                    path: transport.path,
                    body,
                    privateKey: qualified.keyPair.secretKey,
                }),
                payload: body,
            });

            expect(response.statusCode).toBe(200);
            expect(response.json().policy.authenticationPolicy).toBeNull();
            expect((await db.team.findUniqueOrThrow({ where: { id: qualified.team.id } })).authenticationPolicy)
                .toBeNull();
        } finally {
            await app.close();
        }

        const unqualified = await createFixture({ qualifiedPat: false });
        const unqualifiedApp = await createRealTeamApp();
        try {
            const authorization = await mint(unqualifiedApp, unqualified);
            const transport = getActionSpec(ACTION_ID).serverTransport;
            if (!transport) throw new Error("test Action has no server transport");
            const body = {
                v: 1 as const,
                teamId: unqualified.team.id,
                previousAuthenticationPolicy: unqualified.team.authenticationPolicy,
                authenticationPolicy: { v: 1 as const, mode: "inherit" as const },
            };
            const response = await unqualifiedApp.inject({
                method: transport.method,
                url: transport.path,
                headers: machineHeaders({
                    authorizationToken: authorization.token,
                    target: authorization.binding.target,
                    method: transport.method,
                    path: transport.path,
                    body,
                    privateKey: unqualified.keyPair.secretKey,
                }),
                payload: body,
            });

            expect(response.statusCode).toBe(403);
            expect(response.json()).toEqual({ error: "team_authentication_required" });
            expect((await db.team.findUniqueOrThrow({ where: { id: unqualified.team.id } })).authenticationPolicy)
                .toEqual(unqualified.team.authenticationPolicy);
        } finally {
            await unqualifiedApp.close();
        }
    });
});
