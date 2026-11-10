import { projectExternalActionMachineRuntimeDemandV1 } from '@happier-dev/protocol/actions/actionSpecs';
import Fastify from "fastify";
import fastifyRateLimit from "@fastify/rate-limit";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { serializerCompiler, validatorCompiler, ZodTypeProvider } from "fastify-type-provider-zod";
import { ExternalActionHttpErrorSchema, parseExternalActionResponseEnvelopeV1, prepareExternalActionResponseEnvelopeV1, sealExternalActionRequestV2 } from "@happier-dev/protocol/actions";
import { API_TOKEN_FULL_GRANT_V1, encodePlainMachineStoredContent, MACHINE_PLAIN_DATA_KEY_MARKER,
    ARTIFACT_PLAIN_DATA_KEY_MARKER, encodePlainArtifactStoredContent, createDeploymentApprovalScopeResolverV1,
    DeploymentEnvironmentGetInputV1Schema } from "@happier-dev/protocol";
import { createDeploymentEnvironmentV1 } from '@happier-dev/deployment-protocol/testing/v1';
import { decodeBase64 } from "privacy-kit";
import { ApiTokenGrantV1Schema } from "@happier-dev/protocol/auth/apiTokenGrant";
import { AutomationV3RunMutationResponseSchema } from '@happier-dev/protocol/automations/automationApiV3';
import { ExternalActionDaemonDispatchRequestSchema, createExternalActionDaemonDispatchResponseV1,
    type ExternalActionExecutionAuthorizationBindingV1 } from "@happier-dev/protocol/actions/externalActionApi";
import { computeExternalActionRequestEnvelopeDigestV1 } from "@happier-dev/protocol/actions/externalActionExecutionAuthorization";
import { Server } from "socket.io";
import tweetnacl from 'tweetnacl';
import { signExternalActionApprovalInputV1, verifyExternalActionApprovalInputV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';

import { auth } from "@/app/auth/auth";
import type { Fastify as AppFastify } from "@/app/api/types";
import { enableAuthentication } from "@/app/api/utils/enableAuthentication";
import { resolveApiRateLimitPluginOptions } from "@/app/api/utils/apiRateLimitPolicy";
import { createExternalActionDaemonDispatcher, type ExternalActionDaemonDispatcher, type ExternalActionForwardRpcCall } from "@/app/api/socket/externalActionDispatcher";
import { verifyCurrentExternalActionPrincipal } from "@/app/auth/externalActionExecutionAuthorization";
import { createSessionPublisherPresence } from '@/app/presence/sessionPublisherPresence';
import { db } from "@/storage/db";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";
import { inTx } from '@/storage/inTx';
import { createProjectSourceInTx } from '@/app/projects/sources/projectSourceService';
import { createDeploymentEnvironmentInTx, loadDeploymentEnvironmentInTx,
    projectDeploymentEnvironmentHeader } from '@/app/deployments/deploymentEnvironmentService';
import { createArtifact } from '@/app/artifacts/artifactWriteService';
import { getOrCreateServerIdentityId } from '@/app/serverIdentity/serverIdentity';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { normalizeActionsSettingsV1 } from '@happier-dev/protocol/actions/actionSettings';
import { buildApprovalRequestArtifactHeaderV1 } from '@happier-dev/protocol/approvals/approvalArtifactHeaderV1';
import type { ActionExecutorContext, ActionExecutorDeps } from '@happier-dev/protocol/actions';

import { registerExternalActionRoutes } from "./registerExternalActionRoutes";
import { registerAccountProfileRoute } from '../account/registerAccountProfileRoute';
import { WidgetInstanceActionInputSchemasV1 } from '@happier-dev/protocol/widgets/actionsV1';
import { clientActionUnavailable } from '@happier-dev/protocol/actions/clientDispatchV1';

function dispatchedResponse(response: unknown) {
    return {
        kind: "response" as const,
        prepared: prepareExternalActionResponseEnvelopeV1(response),
    };
}

function createTestApp(
    dispatch: ExternalActionDaemonDispatcher,
    configure?: (app: AppFastify) => void,
): AppFastify {
    const app = Fastify({ logger: false });
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    const typed = app.withTypeProvider<ZodTypeProvider>() as unknown as AppFastify;
    enableAuthentication(typed);
    configure?.(typed);
    registerExternalActionRoutes(typed, { dispatch });
    return typed;
}

describe("registerExternalActionRoutes (API-token provenance) (integration)", () => {
    let harness: LightSqliteHarness;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-external-action-pat-provenance-",
            initAuth: true,
            initEncrypt: true,
            env: {
                AUTH_REQUIRED_LOGIN_PROVIDERS: "",
                AUTH_LOGIN_ELIGIBILITY_CACHE_TTL_MS: "0",
            },
        });
    }, 120_000);

    afterEach(async () => {
        vi.restoreAllMocks();
        harness.resetEnv();
        await db.machine.deleteMany();
        await db.account.deleteMany();
    });

    afterAll(async () => {
        await harness.close();
    });

    it("refuses an ungranted Open before stopped-Session publisher discovery", async () => {
        const account = await db.account.create({ data: { encryptionMode: 'plain' } });
        const session = await db.session.create({ data: { accountId: account.id,
            tag: crypto.randomUUID(), metadata: '{}', encryptionMode: 'plain', active: false } });
        const parent = await auth.createApiToken({ accountId: account.id, tokenId: crypto.randomUUID(), label: 'Embed parent' });
        const principal = await auth.verifyPat(parent.token);
        if (!principal.ok) throw new Error('Expected verified test parent');
        const sendOnly = await auth.createChildApiToken({ principal, tokenId: crypto.randomUUID(), label: 'Send only',
            expiresAt: new Date(Date.now() + 60_000),
            grant: ApiTokenGrantV1Schema.parse({ ...API_TOKEN_FULL_GRANT_V1,
                actions: { families: ['messaging', 'session_transcripts'], ids: ['session.user_action.answer'] },
                targets: { sessions: [session.id], machines: [] } }) });
        const canOpen = await auth.createApiToken({ accountId: account.id, tokenId: crypto.randomUUID(), label: 'Open',
            grant: ApiTokenGrantV1Schema.parse({ ...API_TOKEN_FULL_GRANT_V1,
                actions: { families: [], ids: ['session.open'] }, targets: { sessions: [session.id], machines: [] } }) });
        const io = new Server();
        const discovery = vi.spyOn(io, 'in');
        const app = createTestApp(createExternalActionDaemonDispatcher({ io,
            sessionPublisherPresence: createSessionPublisherPresence() }));
        io.attach(app.server);
        await app.ready();
        try {
            // Real bearer admission, stored grant, dispatcher, publisher owner and
            // strict HTTP response reader; the stopped Session has no publisher.
            for (const actionId of ['session.open', 'teams.list'] as const) for (const v of [1, 2] as const) {
                const denied = await app.inject({ method: 'POST', url: `/v1/actions/${actionId}`,
                    headers: { authorization: `Bearer ${sendOnly.token}` },
                    payload: { v, requestId: crypto.randomUUID(), target: { kind: 'session', sessionId: session.id },
                        ...(v === 1 ? { input: actionId === 'teams.list' ? {} : { sessionId: session.id } }
                            : { payload: { t: 'encrypted', c: 'opaque' } }) } });
                expect(denied.statusCode).toBe(403);
                expect(ExternalActionHttpErrorSchema.parse(denied.json())).toEqual({ error: 'credential_scope_denied' });
                // An HTTP refusal is intentionally outside the success envelope.
                // Consumers must read the strict error union on a non-2xx response.
                expect(parseExternalActionResponseEnvelopeV1(denied.json())).toBeNull();
            }
            // An unavailable target cannot hide a known action denial or incur
            // publisher transport reads. A granted Open still checks availability.
            expect(discovery).not.toHaveBeenCalled();
            const unavailable = await app.inject({ method: 'POST', url: '/v1/actions/session.open',
                headers: { authorization: `Bearer ${canOpen.token}` }, payload: { v: 1,
                    requestId: crypto.randomUUID(), target: { kind: 'session', sessionId: session.id }, input: { sessionId: session.id } } });
            expect(unavailable.statusCode).toBe(200);
            expect(unavailable.json()).toMatchObject({ execution: { ok: false, errorCode: 'target_unavailable' } });
            expect(discovery).toHaveBeenCalled();
        } finally {
            await new Promise<void>(resolve => { io.close(() => resolve()); });
            await app.close();
            await db.session.delete({ where: { id: session.id } });
        }
    });

    it("routes an Environment-only CI deploy without granting its controller Machine and retains exact token consent", async () => {
        const account = await db.account.create({ data: { encryptionMode: "plain" } });
        const serverId = await getOrCreateServerIdentityId();
        const installationKeys = tweetnacl.sign.keyPair();
        const controller = await db.machine.create({ data: { id: crypto.randomUUID(), accountId: account.id,
            metadata: encodePlainMachineStoredContent({ host: 'ci-controller', platform: 'linux' }),
            dataEncryptionKey: decodeBase64(MACHINE_PLAIN_DATA_KEY_MARKER, 'base64'),
            installationId: crypto.randomUUID(), installationPublicKey: installationKeys.publicKey, active: true,
            operationProtocolCapabilitiesRevision: 1,
            operationProtocolCapabilities: { externalActionExecutionAuthorization: { protocolVersions: [1] } },
        } });
        const source = await inTx(tx => createProjectSourceInTx(tx, account.id, { serverId,
            requestKey: crypto.randomUUID(), name: 'CI app', audience: [],
            repository: { provider: { id: 'github', kind: 'github', displayName: 'GitHub', baseUrl: 'https://github.com' },
                repository: { nameWithOwner: 'owner/app', cloneUrl: 'https://github.com/owner/app.git' }, protocol: 'https' },
        }));
        if (!source.ok) throw new Error(source.error);
        const content = createDeploymentEnvironmentV1().content;
        if (content.t !== 'plain') throw new Error('Expected plain Environment fixture');
        const artifact = await createArtifact({ actorUserId: account.id, artifactId: crypto.randomUUID(),
            header: decodeBase64(encodePlainArtifactStoredContent({ kind: 'deployment-environment.v1', title: 'CI app' }), 'base64'),
            body: decodeBase64(encodePlainArtifactStoredContent({ body: JSON.stringify(content.v) }), 'base64'),
            dataEncryptionKey: decodeBase64(ARTIFACT_PLAIN_DATA_KEY_MARKER, 'base64') });
        if (!artifact.ok) throw new Error(artifact.error);
        const environment = await inTx(tx => createDeploymentEnvironmentInTx(tx, account.id, { serverId,
            requestKey: crypto.randomUUID(), projectSourceId: source.source.id,
            protection: 'nonProduction', purpose: 'standard', deployerMode: 'managers',
            controllerMachineId: controller.id, buildMachineId: controller.id,
            contentArtifactId: artifact.artifact.id, contentHeaderVersion: 1, contentBodyVersion: 1,
        }));
        if (!environment.ok) throw new Error(environment.error);
        const environmentId = environment.environmentId;
        const grant = ApiTokenGrantV1Schema.parse({ ...API_TOKEN_FULL_GRANT_V1,
            actions: { families: [], ids: ["deployments.deploy", "action.operations.get"] },
            targets: { sessions: [], machines: [], environments: [environmentId] }, approve: false, create: null,
        });
        const deployment = { serverId, environmentId, deployApproval: 'automatic' as const };
        const deploymentApproval = { input: { serverId, environmentId } };
        const pat = await auth.createApiToken({ accountId: account.id, tokenId: crypto.randomUUID(),
            label: "Staging CI", grant, deployment, deploymentApproval });
        const askToken = await auth.createApiToken({ accountId: account.id, tokenId: crypto.randomUUID(),
            label: 'Independent Ask token', grant, deployment: { ...deployment, deployApproval: 'ask' } });
        const forwarded: string[] = [];
        const admittedShas: string[] = [];
        const holds: Parameters<NonNullable<ActionExecutorDeps['approvalsCreate']>>[0]['request'][] = [];
        const holdArtifacts: string[] = [];
        let requireApproval = false;
        let issuedBinding: ExternalActionExecutionAuthorizationBindingV1 | undefined;
        const preparedInput = { serverId, environmentId, requestKey: '1-1', targetLinkId: 'runtime', sha: 'a'.repeat(40) };
        // Socket delivery is the boundary. Home's real ingress, persisted token,
        // grant evaluator and dispatcher decide the Environment-only request.
        const io = new Server();
        const forwardRpc: ExternalActionForwardRpcCall = async ({ callParams }) => {
            const request = ExternalActionDaemonDispatchRequestSchema.parse(callParams);
            const authorization = request.executionAuthorization;
            if (!authorization) throw new Error("Expected signed Environment admission");
            expect(authorization.binding.environmentId).toBe(environmentId);
            expect(authorization.binding.machineId).toBe(controller.id);
            expect(await verifyCurrentExternalActionPrincipal(authorization.binding)).not.toBeNull();
            forwarded.push(authorization.binding.machineId);
            if ('authentication' in authorization.binding) throw new Error('Expected token principal');
            const binding = authorization.binding;
            issuedBinding = binding;
            await expect(auth.mintExternalActionExecutionAuthorization({ ...binding, environmentId: 'forged-environment' },
                { input: preparedInput })).rejects.toMatchObject({ code: 'credential_scope_denied' });
            // The deployment port is the authenticated storage/effect transport
            // boundary. Its typed refusal must survive the real decoded executor.
            const executor = createActionExecutor({
                resolveEnvironmentApprovalScope: createDeploymentApprovalScopeResolverV1(async (actionId, input) => {
                    if (actionId !== 'deployments.environments.get') throw new Error('Unexpected scope read');
                    const read = DeploymentEnvironmentGetInputV1Schema.parse(input);
                    const loaded = await inTx(tx => loadDeploymentEnvironmentInTx(tx, account.id, read.serverId, read.environmentId));
                    return loaded.ok ? { ok: true,
                        environment: projectDeploymentEnvironmentHeader(loaded.row, read.serverId, loaded.admission), targetLinks: [] } : loaded;
                }),
                deploymentAction: (async (actionId, input) => {
                    if (actionId !== 'deployments.deploy' || !('sha' in input) || typeof input.sha !== 'string')
                        throw new Error('Expected exact CI deploy at the native transport boundary');
                    admittedShas.push(input.sha);
                    return { ok: false, error: 'deployment_conflict' };
                }) satisfies NonNullable<ActionExecutorDeps['deploymentAction']>,
                // Durable Artifact storage is the boundary; the executor builds
                // the real scoped approval and its signed execution origin.
                approvalsCreate: (async ({ request }) => {
                    if (request.v !== 2) throw new Error('Expected current scoped approval');
                    const origin = request.executionOriginV1;
                    expect(origin.externalActionInputSignature).toBeDefined();
                    expect(verifyExternalActionApprovalInputV1({ actionId: request.actionId, input: request.actionArgs,
                        authorizationToken: authorization.token, target: binding.target, publicKey: installationKeys.publicKey,
                        signature: origin.externalActionInputSignature! })).toBe(true);
                    const created = await createArtifact({ actorUserId: account.id, artifactId: crypto.randomUUID(),
                        header: decodeBase64(encodePlainArtifactStoredContent(buildApprovalRequestArtifactHeaderV1(request)), 'base64'),
                        body: decodeBase64(encodePlainArtifactStoredContent({ body: JSON.stringify(request) }), 'base64'),
                        dataEncryptionKey: decodeBase64(ARTIFACT_PLAIN_DATA_KEY_MARKER, 'base64') });
                    if (!created.ok) throw new Error(created.error);
                    holds.push(request);
                    holdArtifacts.push(created.artifact.id);
                    return { artifactId: created.artifact.id };
                }) satisfies NonNullable<ActionExecutorDeps['approvalsCreate']>,
            } as unknown as ActionExecutorDeps);
            const context: ActionExecutorContext = { surface: 'api', authority: 'account_automation',
                serverId, serverIdentityId: serverId, runtimeAccountId: account.id, actionRequestId: request.envelope.requestId,
                actionsSettings: normalizeActionsSettingsV1({ v: 1, actions: requireApproval
                    ? { 'deployments.deploy': { approvalRequiredSurfaces: ['api'] } } : {} }),
                externalActionExecutionAuthorization: authorization,
                originalActionEnvelope: request.envelope,
                signExternalActionApprovalInput: args => signExternalActionApprovalInputV1({ actionId: args.actionId,
                    input: args.input, authorizationToken: args.authorization.token, target: args.target,
                    requesterConfirmation: args.requesterConfirmation, sessionTargetsV1: args.sessionTargetsV1,
                    privateKey: installationKeys.secretKey }),
                externalActionTarget: binding.target, externalActionCredential: { accountId: binding.accountId,
                    principalId: binding.principalId, credentialId: binding.credentialId, grant: binding.grant } };
            if (request.envelope.v !== 1) throw new Error('Expected plain test request');
            const execution = await executor.execute('deployments.deploy', request.envelope.input, context);
            for (const substitute of ['another-environment', undefined]) {
                expect(await executor.execute('deployments.deploy', { ...preparedInput,
                    environmentId: substitute }, context)).toMatchObject({ ok: false });
            }
            return { ok: true, result: createExternalActionDaemonDispatchResponseV1(
                prepareExternalActionResponseEnvelopeV1({ v: 1, actionId: request.actionId,
                    requestId: request.envelope.requestId, execution })) };
        };
        const app = createTestApp(createExternalActionDaemonDispatcher({ io, forwardRpc }));
        io.attach(app.server);
        await app.listen({ host: '127.0.0.1', port: 0 });
        try {
            const response = await app.inject({ method: "POST", url: "/v1/actions/deployments.deploy",
                headers: { authorization: `Bearer ${pat.token}` }, payload: { v: 1, requestId: "ci-run-1",
                    target: { kind: 'machine', machineId: controller.id }, input: preparedInput } });
            // An explicit reviewed target is routing, not a grant to that Machine.
            expect(response.statusCode, response.body).toBe(200);
            expect(response.json()).toMatchObject({ execution: { ok: false, errorCode: 'deployment_conflict' } });
            expect(forwarded).toEqual([controller.id]);
            expect(admittedShas).toEqual([preparedInput.sha]);
            expect(holds).toEqual([]);
            if (!issuedBinding) throw new Error('Expected issued Environment root');
            const submit = (token: string, requestId: string, input: unknown = preparedInput, actionId = 'deployments.deploy') =>
                app.inject({ method: 'POST', url: `/v1/actions/${actionId}`, headers: { authorization: `Bearer ${token}` },
                    payload: { v: 1, requestId, target: { kind: 'machine', machineId: controller.id }, input } });
            // Saved Automatic survives a Production edit and varies only the
            // commit/request identity; a second token cannot borrow that choice.
            await db.deploymentEnvironment.update({ where: { id: environmentId }, data: { protection: 'production' } });
            const next = await submit(pat.token, 'ci-sha-b', { ...preparedInput, sha: 'b'.repeat(40), requestKey: 'ci-sha-b' });
            expect(next.statusCode, next.body).toBe(200);
            expect(next.json()).toMatchObject({ execution: { ok: false, errorCode: 'deployment_conflict' } });
            expect(admittedShas).toEqual(['a'.repeat(40), 'b'.repeat(40)]);
            const independent = await submit(askToken.token, 'independent-token');
            expect(independent.statusCode, independent.body).toBe(200);
            expect(independent.json(), independent.json().execution?.errorCode).toMatchObject({ execution: { ok: true, result: { kind: 'approval_request_created' } } });
            requireApproval = true;
            const stricter = await submit(pat.token, 'stricter-policy');
            expect(stricter.statusCode, stricter.body).toBe(200);
            expect(stricter.json(), stricter.json().execution?.errorCode).toMatchObject({ execution: { ok: true, result: { kind: 'approval_request_created' } } });
            expect(holds).toHaveLength(2);
            expect(holds).toEqual(expect.arrayContaining([expect.objectContaining({ status: 'open', actionId: 'deployments.deploy',
                actionArgs: preparedInput })]));
            expect(admittedShas).toEqual(['a'.repeat(40), 'b'.repeat(40)]);
            requireApproval = false;
            for (const denied of [
                await submit(pat.token, 'wrong-environment', { ...preparedInput, environmentId: 'another-environment' }),
                await submit(pat.token, 'wrong-action', preparedInput, 'deployments.rollback'),
            ]) {
                expect(denied.statusCode, denied.body).toBe(403);
                expect(ExternalActionHttpErrorSchema.parse(denied.json())).toMatchObject({ error: 'credential_scope_denied' });
            }
            const forwardedBeforeMove = [...forwarded];
            const nextController = await db.machine.create({ data: { id: crypto.randomUUID(), accountId: account.id,
                metadata: controller.metadata, installationId: crypto.randomUUID() } });
            await db.deploymentEnvironment.update({ where: { id: environmentId }, data: { controllerMachineId: nextController.id } });
            // Moving future dispatch does not rewrite an already-issued root's native fact custody.
            expect(await verifyCurrentExternalActionPrincipal(issuedBinding)).not.toBeNull();
            const moved = await app.inject({ method: 'POST', url: '/v1/actions/deployments.deploy',
                headers: { authorization: `Bearer ${pat.token}` }, payload: { v: 1, requestId: 'after-controller-change',
                    target: { kind: 'machine', machineId: controller.id }, input: preparedInput } });
            expect(moved.statusCode).toBe(403);
            expect(forwarded).toEqual(forwardedBeforeMove);
            await auth.updateApiToken({ accountId: account.id, tokenId: pat.tokenId,
                deployment: { ...deployment, deployApproval: 'ask' } });
            expect(await verifyCurrentExternalActionPrincipal(issuedBinding)).toBeNull();
            await auth.updateApiToken({ accountId: account.id, tokenId: pat.tokenId, deployment, deploymentApproval });
            expect(await verifyCurrentExternalActionPrincipal(issuedBinding)).not.toBeNull();
            await db.accountApiToken.update({ where: { id: pat.tokenId }, data: { expiresAt: new Date(Date.now() - 1) } });
            expect(await verifyCurrentExternalActionPrincipal(issuedBinding)).toBeNull();
            await db.accountApiToken.update({ where: { id: pat.tokenId }, data: { expiresAt: null } });
            expect(await verifyCurrentExternalActionPrincipal(issuedBinding)).not.toBeNull();
            await auth.revokeApiToken({ accountId: account.id, tokenId: pat.tokenId });
            expect(await verifyCurrentExternalActionPrincipal(issuedBinding)).toBeNull();
            await db.deploymentEnvironment.update({ where: { id: environmentId }, data: { controllerMachineId: controller.id } });
            const revoked = await submit(pat.token, 'after-revoke');
            expect(revoked.statusCode, revoked.body).toBe(401);
            expect(forwarded).toEqual(forwardedBeforeMove);
            expect(admittedShas).toEqual(['a'.repeat(40), 'b'.repeat(40)]);
        } finally {
            await db.artifact.deleteMany({ where: { id: { in: holdArtifacts } } });
            await db.deploymentEnvironment.delete({ where: { id: environmentId } });
            await db.artifact.delete({ where: { id: artifact.artifact.id } });
            await new Promise<void>(resolve => { io.close(() => resolve()); });
            await app.close();
        }
    });

    it("admits exactly the granted Automation through HTTP and the real signed relay", async () => {
        const account = await db.account.create({ data: { encryptionMode: "plain" } });
        const machineId = crypto.randomUUID();
        await db.machine.create({ data: { id: machineId, accountId: account.id,
            metadata: encodePlainMachineStoredContent({ host: "grant-test", platform: "linux" }),
            dataEncryptionKey: decodeBase64(MACHINE_PLAIN_DATA_KEY_MARKER, "base64"),
            installationId: crypto.randomUUID(), installationPublicKey: new Uint8Array(32), active: true,
            operationProtocolCapabilitiesRevision: 1,
            operationProtocolCapabilities: { externalActionExecutionAuthorization: { protocolVersions: [1] } },
        } });
        const grant = ApiTokenGrantV1Schema.parse({ ...API_TOKEN_FULL_GRANT_V1,
            actions: { families: [], ids: ["workflow.trigger.run_now"] },
            targets: { sessions: [], machines: [machineId] }, automationIds: ["brief"],
        });
        const pat = await auth.createApiToken({ accountId: account.id, tokenId: crypto.randomUUID(), label: "Brief only", grant });
        const admitted: string[] = [];
        let signed: ReturnType<typeof ExternalActionDaemonDispatchRequestSchema.parse> | null = null;
        // The network hop is the only substitute: authentication, persisted
        // grant, Machine admission and signed request production remain real.
        const forwardRpc: ExternalActionForwardRpcCall = async ({ callParams }) => {
            const request = ExternalActionDaemonDispatchRequestSchema.parse(callParams);
            const authorization = request.executionAuthorization;
            if (!authorization) throw new Error("Expected signed execution admission");
            expect(await auth.verifyExternalActionExecutionAuthorization(authorization.token)).toEqual(authorization.binding);
            expect(await verifyCurrentExternalActionPrincipal(authorization.binding)).not.toBeNull();
            expect(authorization.binding.requestEnvelopeDigest).toBe(computeExternalActionRequestEnvelopeDigestV1(request.envelope));
            expect(authorization.binding.automationId).toBe("brief");
            signed = request;
            admitted.push("brief");
            const result = AutomationV3RunMutationResponseSchema.parse({ run: {
                id: 'run-brief', automationId: 'brief', revision: 1, triggerId: null, triggerRetired: false,
                state: 'queued', cause: { kind: 'manual', invokedAt: 1 }, dueAt: 1,
                claimedAt: null, startedAt: null, finishedAt: null, claimedByMachineId: null, leaseExpiresAt: null,
                attempt: 0, errorCode: null, producedSessionId: null, executionDispatchState: null, executionAttempt: 0,
                replyHandoffState: 'none', replyHandoffAttempt: 0, replyHandoffDueAt: null, createdAt: 1, updatedAt: 1,
            } });
            return { ok: true, result: createExternalActionDaemonDispatchResponseV1(prepareExternalActionResponseEnvelopeV1({ v: 1,
                actionId: request.actionId, requestId: request.envelope.requestId,
                execution: { ok: true, result },
            })) };
        };
        const io = new Server();
        const app = createTestApp(createExternalActionDaemonDispatcher({ io, forwardRpc }));
        io.attach(app.server);
        await app.listen({ host: "127.0.0.1", port: 0 });
        try {
            const address = app.server.address();
            if (!address || typeof address === "string") throw new Error("Expected HTTP listener");
            const send = async (automationId: unknown) => fetch(`http://127.0.0.1:${address.port}/v1/actions/workflow.trigger.run_now`, {
                method: "POST", headers: { authorization: `Bearer ${pat.token}`, "content-type": "application/json" },
                body: JSON.stringify({ v: 1, requestId: crypto.randomUUID(), target: { kind: "machine", machineId },
                    input: { automationId } }),
            });
            const allowed = await send("brief");
            expect(allowed.status).toBe(200);
            expect(await allowed.json()).toMatchObject({ execution: { ok: true, result: { run: { automationId: "brief", state: 'queued' } } } });
            for (const automationId of ["other", undefined]) {
                const denied = await send(automationId);
                expect(denied.status).toBe(403);
                expect(await denied.json()).toMatchObject({ error: "credential_scope_denied" });
            }
            expect(admitted).toEqual(["brief"]);
            expect(signed).not.toBeNull();
        } finally {
            await new Promise<void>(resolve => { io.close(() => resolve()); });
            await app.close();
        }
    });

    it("relays only the request-local PAT principal and refuses it after revocation", async () => {
        const account = await db.account.create({
            data: { publicKey: "external-action-pat-provenance" },
            select: { id: true },
        });
        const pat = await auth.createApiToken({
            accountId: account.id,
            tokenId: crypto.randomUUID(),
            label: "External Action request-local provenance",
            expiresAt: new Date("2030-08-22T12:01:00.000Z"),
        });
        const received = {
            request: null as Parameters<ExternalActionDaemonDispatcher>[0] | null,
        };
        const dispatch: ExternalActionDaemonDispatcher = async (request) => {
            received.request = request;
            return dispatchedResponse({
                v: 1,
                actionId: request.actionId,
                ...(request.envelope.requestId === undefined
                    ? {}
                    : { requestId: request.envelope.requestId }),
                execution: { ok: true, result: { accepted: true } },
            });
        };
        const app = createTestApp(dispatch);
        await app.ready();

        try {
            const response = await app.inject({
                method: "POST",
                url: "/v1/actions/session.spawn_new",
                headers: { authorization: `Bearer ${pat.token}` },
                payload: { v: 1, requestId: "one-verify", input: {} },
            });

            expect(response.statusCode).toBe(200);
            expect(received.request).toEqual({
                actionId: "session.spawn_new",
                envelope: { v: 1, requestId: "one-verify", input: {} },
                principal: {
                    accountId: account.id,
                    principalId: account.id,
                    credentialId: pat.tokenId,
                    authority: "account_automation",
                    grant: API_TOKEN_FULL_GRANT_V1,
                },
            });
            const relayed = received.request;
            if (!relayed) throw new Error("Expected the authenticated request to reach the daemon relay");
            expect(relayed.principal).not.toHaveProperty("expiresAt");
            expect(JSON.stringify(relayed).includes(pat.token)).toBe(false);
            expect(await auth.revokeApiToken({ accountId: account.id, tokenId: pat.tokenId })).toMatchObject({ revoked: true });
            received.request = null;
            const revokedResponse = await app.inject({
                method: "POST",
                url: "/v1/actions/session.spawn_new",
                headers: { authorization: `Bearer ${pat.token}` },
                payload: { v: 1, requestId: "after-revocation", input: {} },
            });
            expect(revokedResponse.statusCode).toBe(401);
            expect(revokedResponse.json()).toEqual({ error: "invalid_token" });
            expect(received.request).toBeNull();
        } finally {
            await app.close();
        }
    });

    it("keeps the Action-owned limiter and PAT principal under global user-or-ip limiting", async () => {
        const account = await db.account.create({
            data: { publicKey: "external-action-global-rate-limit" },
            select: { id: true },
        });
        const pat = await auth.createApiToken({
            accountId: account.id,
            tokenId: crypto.randomUUID(),
            label: "External Action global rate limiter",
        });
        const dispatch = vi.fn<ExternalActionDaemonDispatcher>(async (request) => dispatchedResponse({
            v: 1 as const,
            actionId: request.actionId,
            execution: { ok: true as const, result: { accepted: true } },
        }));
        const rawApp = Fastify({ logger: false });
        await rawApp.register(fastifyRateLimit, resolveApiRateLimitPluginOptions({
            HAPPIER_API_RATE_LIMITS_ENABLED: "1",
            HAPPIER_API_RATE_LIMITS_GLOBAL_MAX: "100",
            HAPPIER_API_RATE_LIMITS_GLOBAL_KEY_STRATEGY: "user-or-ip",
        }));
        rawApp.setValidatorCompiler(validatorCompiler);
        rawApp.setSerializerCompiler(serializerCompiler);
        const app = rawApp.withTypeProvider<ZodTypeProvider>() as unknown as AppFastify;
        enableAuthentication(app);
        registerExternalActionRoutes(app, { dispatch });
        await app.ready();

        try {
            const response = await app.inject({
                method: "POST",
                url: "/v1/actions/session.spawn_new",
                headers: { authorization: `Bearer ${pat.token}` },
                payload: { v: 1, input: {} },
            });

            expect(response.statusCode).toBe(200);
            // The Action route owns its limiter even under a different global strategy.
            expect(response.headers["x-ratelimit-limit"]).toBe("600");
            expect(dispatch).toHaveBeenCalledOnce();
            expect(dispatch.mock.calls[0]?.[0].principal).toEqual({
                accountId: account.id,
                principalId: account.id,
                credentialId: pat.tokenId,
                authority: "account_automation",
                grant: API_TOKEN_FULL_GRANT_V1,
            });
        } finally {
            await app.close();
        }
    });

    it('distinguishes an authenticated Account Action refusal from a rejected bearer', async () => {
        const account = await db.account.create({ data: { encryptionMode: 'plain' } });
        const token = await auth.createToken(account.id, undefined, { kind: 'account', authority: 'present_user' });
        const dispatch = vi.fn<ExternalActionDaemonDispatcher>();
        const app = createTestApp(dispatch, registerAccountProfileRoute);
        const headers = { authorization: `Bearer ${token}` };
        const envelope = { v: 1, requestId: crypto.randomUUID(), target: { kind: 'machine', machineId: crypto.randomUUID() }, input: {} };
        try {
            const profile = () => app.inject({ method: 'GET', url: '/v1/account/profile', headers });
            expect((await profile()).statusCode).toBe(200);
            for (const suffix of ['', '/execution-authorization']) {
                const denied = await app.inject({ method: 'POST', url: `/v1/actions/ui.current_context.read${suffix}`,
                    headers, payload: envelope });
                expect(denied.statusCode).toBe(403);
                expect(denied.json()).toEqual({ error: 'credential_scope_denied' });
            }
            const retained = await profile();
            expect(retained.statusCode).toBe(200);
            expect(retained.json()).toMatchObject({ id: account.id });
            const rejected = await app.inject({ method: 'POST', url: '/v1/actions/ui.current_context.read',
                headers: { authorization: 'Bearer invalid-fixture-token' }, payload: envelope });
            expect(rejected.statusCode).toBe(401);
            expect(rejected.json()).toEqual({ error: 'invalid_token' });
            expect(dispatch).not.toHaveBeenCalled();
        } finally { await app.close(); }
    });

    it.each(['account', 'terminal'] as const)('preserves client absence instead of invalid_token for an authenticated original Widget Refresh (%s)', async kind => {
        const account = await db.account.create({ data: { encryptionMode: 'plain' } });
        const token = await auth.createToken(account.id, undefined, { kind,
            authority: kind === 'account' ? 'present_user' : 'account_automation' });
        const input = WidgetInstanceActionInputSchemasV1['widgets.item.refresh'].parse({ ref: {
            surface: { serverId: await getOrCreateServerIdentityId(), accountId: account.id, owner: { kind: 'home' } },
            instanceId: crypto.randomUUID(),
        } });
        // Only the remote daemon response is a boundary fixture. HTTP bearer,
        // epoch, original-root admission and response projection remain real.
        const dispatch = vi.fn<ExternalActionDaemonDispatcher>(async () => dispatchedResponse({
            v: 1, actionId: 'widgets.item.refresh',
            execution: clientActionUnavailable('widgets.item.refresh'),
        }));
        const app = createTestApp(dispatch, registerAccountProfileRoute);
        await app.ready();
        try {
            const headers = { authorization: `Bearer ${token}` };
            const profile = await app.inject({ method: 'GET', url: '/v1/account/profile', headers });
            expect(profile.statusCode).toBe(200);
            expect(profile.json()).toMatchObject({ id: account.id });
            const invalid = await app.inject({ method: 'POST', url: '/v1/actions/widgets.item.refresh',
                headers: { authorization: 'Bearer invalid-fixture-token' },
                payload: { v: 1, requestId: crypto.randomUUID(), input } });
            expect(invalid.statusCode).toBe(401);
            expect(invalid.json()).toEqual({ error: 'invalid_token' });
            expect(dispatch).not.toHaveBeenCalled();

            const response = await app.inject({ method: 'POST', url: '/v1/actions/widgets.item.refresh', headers,
                payload: { v: 1, requestId: crypto.randomUUID(), input } });
            expect({ status: response.statusCode, body: response.json(), dispatches: dispatch.mock.calls.length })
                .toMatchObject({ status: 200, dispatches: 1,
                    body: { execution: clientActionUnavailable('widgets.item.refresh') } });
        } finally {
            await app.close();
        }
    });

    it.each((['plain', 'e2ee'] as const).flatMap(encryptionMode => ([
        { actionId: 'approval.request.create', kind: 'account', input: { actionId: 'session.title.set',
            actionArgs: { sessionId: 'reviewed-session', title: 'Reviewed title' }, summary: 'Review title change', createdBy: { surface: 'cli' } } },
        { actionId: 'action.invoke', kind: 'account', input: { action: { pluginId: 'happier.machine.services', localId: 'health/setup' }, input: {} } },
        { actionId: 'approval.request.list', kind: 'account', input: {} },
        { actionId: 'teams.list', kind: 'account', input: {} },
        { actionId: 'approval.request.get', kind: 'account', input: { artifactId: 'reviewed-approval' } },
        { actionId: 'workflow.run.get', kind: 'terminal', input: { runId: '46d53d20-11a7-4a49-93a8-cbf56381e2dc' } },
        { actionId: 'workflow.run.invocations.list', kind: 'terminal', input: { runId: '46d53d20-11a7-4a49-93a8-cbf56381e2dc' } },
        { actionId: 'deployments.receipts.list', kind: 'account', input: { serverId: 'srv_home', environmentId: 'environment' } },
    ] as const).map(row => ({ encryptionMode, ...row }))))('admits an original Account root after real bearer authentication ($actionId, $encryptionMode)', async ({ encryptionMode, actionId, kind, input }) => {
        const account = await db.account.create({ data: { encryptionMode } });
        const authority = kind === 'terminal' ? 'account_automation' : 'present_user';
        const token = await auth.createToken(account.id, undefined, { kind, authority });
        const accountToken = kind === 'account' ? token
            : await auth.createToken(account.id, undefined, { kind: 'account', authority: 'present_user' });
        // The daemon hop is the only substituted boundary: auth, provenance,
        // epoch and original-root admission use the actual HTTP owners and SQLite.
        const dispatch = vi.fn<ExternalActionDaemonDispatcher>(async request => dispatchedResponse({
            v: 1, actionId: request.actionId, requestId: request.envelope.requestId,
            execution: { ok: true, result: { reachedDaemon: true } },
        }));
        const app = createTestApp(dispatch, registerAccountProfileRoute);
        const headers = { authorization: `Bearer ${token}` };
        const requestId = crypto.randomUUID();
        const target = { kind: 'machine' as const, machineId: crypto.randomUUID() };
        const envelope = encryptionMode === 'e2ee' ? sealExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1,
            binding: { serverIdentityId: await getOrCreateServerIdentityId(), accountId: account.id,
                authentication: { kind, tokenEpoch: account.tokenEpoch },
                actionId, requestId, target },
            input, material: { type: 'dataKey', machineKey: new Uint8Array(32) },
            randomBytes: length => crypto.getRandomValues(new Uint8Array(length)),
        }) : { v: 1, requestId, target, input };
        try {
            expect((await app.inject({ method: 'GET', url: '/v1/account/profile', headers })).statusCode).toBe(200);
            for (const refusal of [
                { actionId, headers: { authorization: 'Bearer invalid-fixture-token' }, status: 401, error: 'invalid_token' },
                { actionId: 'ui.current_context.read', headers: { authorization: `Bearer ${accountToken}` },
                    status: 403, error: 'credential_scope_denied' },
                { actionId: encodeURIComponent('happier.machine.services/actions/health/setup'),
                    headers: { authorization: `Bearer ${accountToken}` }, status: 403, error: 'credential_scope_denied' },
            ]) {
                const response = await app.inject({ method: 'POST', url: `/v1/actions/${refusal.actionId}`,
                    headers: refusal.headers, payload: envelope });
                expect(response.statusCode).toBe(refusal.status);
                expect(response.json()).toEqual({ error: refusal.error });
            }
            expect(dispatch).not.toHaveBeenCalled();
            const response = await app.inject({ method: 'POST', url: `/v1/actions/${actionId}`, headers, payload: envelope });
            expect({ status: response.statusCode, body: response.json() }).toMatchObject({ status: 200,
                body: { actionId, requestId, execution: { ok: true, result: { reachedDaemon: true } } } });
            expect(dispatch).toHaveBeenCalledOnce();
            expect(dispatch.mock.calls[0]?.[0]).toMatchObject({ envelope, principal: {
                accountId: account.id, authority, authentication: { kind, tokenEpoch: account.tokenEpoch },
            } });
        } finally { await app.close(); }
    });

    it('never forwards client-variant Actions to another person\'s daemon under a Machine Use grant', async () => {
        const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
        const grantee = await db.account.create({ data: { encryptionMode: 'plain' } });
        const machine = await db.machine.create({ data: { id: crypto.randomUUID(), accountId: owner.id,
            metadata: encodePlainMachineStoredContent({ host: 'owner-host', platform: 'linux', happyCliVersion: '0.3.0',
                homeDir: '/home/owner', happyHomeDir: '/home/owner/.happier' }),
            dataEncryptionKey: decodeBase64(MACHINE_PLAIN_DATA_KEY_MARKER, 'base64'),
            installationId: crypto.randomUUID(), installationPublicKey: new Uint8Array(32), active: true,
            operationProtocolCapabilitiesRevision: 1,
            operationProtocolCapabilities: { externalActionExecutionAuthorization: { protocolVersions: [1] } } } });
        // `view` is the Machine Use role.
        await db.machineAccountGrant.create({ data: { machineId: machine.id, accountId: grantee.id,
            accessLevel: 'view', createdByAccountId: owner.id } });
        const surface = { serverId: await getOrCreateServerIdentityId(), accountId: owner.id,
            owner: { kind: 'companion' as const, sessionId: crypto.randomUUID() } };
        const inputs = {
            'widgets.item.list': { surface },
            'localServices.actions.copyUrl': { requestId: crypto.randomUUID(), action: 'copy_url',
                target: { kind: 'inventory_entry', inventoryEntryId: 'svc-1', machineId: machine.id } },
        } as const;
        // Only the daemon socket hop is substituted; HTTP, auth, SQLite, Machine
        // admission and the real dispatcher run.
        const forwarded: Array<{ actionId: string; requester: string | undefined }> = [];
        const forwardRpc: ExternalActionForwardRpcCall = async ({ callParams }) => {
            const request = ExternalActionDaemonDispatchRequestSchema.parse(callParams);
            const binding = request.executionAuthorization?.binding;
            forwarded.push({ actionId: request.actionId, requester: binding?.accountId });
            return { ok: true, result: createExternalActionDaemonDispatchResponseV1(prepareExternalActionResponseEnvelopeV1({
                v: 1, actionId: request.actionId, requestId: request.envelope.requestId,
                execution: { ok: true, result: { reachedDaemon: true } } })) } as Awaited<ReturnType<ExternalActionForwardRpcCall>>;
        };
        const io = new Server();
        const app = createTestApp(createExternalActionDaemonDispatcher({ io, forwardRpc }));
        await app.ready();
        try {
            const token = (accountId: string, kind: 'account' | 'terminal') => auth.createToken(accountId, undefined,
                { kind, authority: kind === 'account' ? 'present_user' : 'account_automation' });
            const send = async (actionId: keyof typeof inputs, bearer: string) => {
                const before = forwarded.length;
                const response = await app.inject({ method: 'POST', url: `/v1/actions/${actionId}`,
                    headers: { authorization: `Bearer ${bearer}` },
                    payload: { v: 1, requestId: crypto.randomUUID(), target: { kind: 'machine', machineId: machine.id },
                        input: inputs[actionId] } });
                return { forwards: forwarded.slice(before), ok: response.json().execution?.ok };
            };
            for (const actionId of Object.keys(inputs) as Array<keyof typeof inputs>) {
                for (const kind of ['account', 'terminal'] as const) {
                    expect({ actionId, kind, ...await send(actionId, await token(grantee.id, kind)) })
                        .toEqual({ actionId, kind, forwards: [], ok: false });
                    expect({ actionId, kind, ...await send(actionId, await token(owner.id, kind)) })
                        .toEqual({ actionId, kind, forwards: [{ actionId, requester: owner.id }], ok: true });
                }
            }
        } finally {
            await app.close();
        }
    });

    it("rejects missing and invalid credentials before the JSON parser", async () => {
        const parse = vi.fn();
        const dispatch = vi.fn(async () => dispatchedResponse({
            v: 1 as const,
            actionId: "session.spawn_new" as const,
            execution: { ok: true as const, result: { accepted: true } },
        }));
        const app = createTestApp(dispatch, (configured) => {
            configured.removeContentTypeParser("application/json");
            configured.addContentTypeParser(
                "application/json",
                { parseAs: "string" },
                (_request, body, done) => {
                    parse();
                    done(null, { received: body });
                },
            );
        });
        await app.ready();

        try {
            for (const headers of [
                {},
                { authorization: "Bearer not-a-valid-token" },
            ]) {
                const response = await app.inject({
                    method: "POST",
                    url: "/v1/actions/session.spawn_new",
                    headers: {
                        ...headers,
                        "content-type": "application/json",
                    },
                    payload: "{not-json",
                });

                expect(response.statusCode).toBe(401);
                expect(response.json()).toEqual({ error: "invalid_token" });
            }

            expect(parse).not.toHaveBeenCalled();
            expect(dispatch).not.toHaveBeenCalled();
        } finally {
            await app.close();
        }
    });
});
