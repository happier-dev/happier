import { expect, it } from 'vitest';
import { Server } from 'socket.io';
import { API_TOKEN_FULL_GRANT_V1 } from '@happier-dev/protocol/auth/apiTokenGrant';
import { ACTION_INVOKE_ACTION_ID_V1 } from '@happier-dev/protocol/actions/actionIds';
import { TELEMETRY_COSTS_READ_ACTION_ID_V1 } from '@happier-dev/protocol/actions/actionIdsDatabaseV1';
import { bindExternalActionExecutionAuthorizationHttpPathV1, ExternalActionExecutionAuthorizationV1Schema,
    ExternalActionRequestEnvelopeV1Schema, EXTERNAL_ACTION_HTTP_PATH_PREFIX_V1,
    createExternalActionDaemonDispatchResponse, ExternalActionDaemonDispatchRequestSchema,
    parseExternalActionResponseEnvelopeV1 } from '@happier-dev/protocol/actions/externalActionApi';
import { ExternalActionHttpErrorSchema, projectExternalActionHttpFailureV1 } from '@happier-dev/protocol/actions/externalActionHttpError';
import { projectExternalActionMachineRuntimeDemandV1 } from '@happier-dev/protocol/actions/actionSpecs';
import { sealManagedControllerActionCodecV1 } from '@happier-dev/protocol/sessions/creation/sessionRequesterBootstrapV1';
import { sealExternalActionRequestV2 } from '@happier-dev/protocol/actions/externalActionEncryption';
import { parseQualifiedPluginActionId } from '@happier-dev/protocol/plugins/actions/qualifiedActionId';
import { USAGE_EXPORT_ACTION_ID_V1, USAGE_PRICE_ACTION_IDS, USAGE_PRIVATE_RECAP_ACTION_IDS, USAGE_QUERY_ACTION_ID_V1 } from '@happier-dev/protocol/usage/usageActionIdsV1';
import { auth } from '@/app/auth/auth';
import { createExternalActionDaemonDispatcher, type ExternalActionDaemonDispatcher } from '@/app/api/socket/externalActionDispatcher';
import { encodeExternalActionResolvedTargetV1, signExternalActionMachineRequestV1 }
    from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { EXTERNAL_ACTION_EFFECT_ACTION_HEADER, EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER,
    EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER, EXTERNAL_ACTION_RESOLVED_TARGET_HEADER } from '@happier-dev/protocol/actions/externalActionApi';
import { decodeBase64 } from 'privacy-kit';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, encodePlainArtifactStoredContent } from '@happier-dev/protocol';
import { DEFAULT_PUBLIC_PROFILE_POLICY_V1 } from '@happier-dev/protocol/account/publicProfile';
import { DEFAULT_PUBLIC_PROFILE_APPEARANCE_V1 } from '@happier-dev/protocol/account/publicProfilePublication';
import { prepareDocDiscussionMutationV1 } from '@happier-dev/protocol/artifacts/artifactCollaborationActionsV1';
import { buildDiscussionMutationRequestBodyV1, DISCUSSION_HTTP_PATHS_V1 } from '@happier-dev/protocol/discussions/api';
import { normalizeUsageQuery, usageQueryToAnalyticsRequest } from '@happier-dev/protocol/inputs/usageQuery';
import { readUsageAppCallsAccounting, readUsageAppCallsEnvironmentIds } from '@happier-dev/plugin-sdk/usage';
import { resolveUsagePageAggregation, UsageQueryBatchResultSchema } from '@happier-dev/protocol/usage/resolveUsagePageAggregation';
import { bundledUsageModelPriceCatalog } from '@happier-dev/protocol/usage/usageModelPriceCatalog';
import { UsageFileResultSchema } from '@happier-dev/protocol/usage/usageExport';
import { DeploymentEnvironmentListInputV1Schema, DeploymentEnvironmentListResultV1Schema } from '@happier-dev/protocol/deployments/deploymentActionsV1';
import { DEPLOYMENT_ENVIRONMENT_LIST_ACTION_ID_V1 } from '@happier-dev/protocol/deployments/deploymentActionIdsV1';
import { projectNativeJsonValueForTransport } from '@happier-dev/protocol/json/strictJsonValue';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import type { ActionExecutorDeps } from '@happier-dev/protocol/actions/executor/types';
import { plainPrivateLabel, storedPlainPrivateLabel } from '@/testkit/privateLabelFixture';
import { createCliTeamCredentialUsageExportAction } from '../../../../../../cli/src/session/actions/teamCredentialUsageExportAction';
import { createCliActionExecutorFromCredentials } from '../../../../../../cli/src/session/actions/createCliActionExecutorFromCredentials';
import { executeExternalAction } from '../../../../../../cli/src/daemon/externalActions/executeExternalAction';
import { verifyExternalActionExecutionAuthorizationCurrent } from '../../../../../../cli/src/api/externalActionExecutionAuthorization';
import { createActionSettingsProvider } from '../../../../../../cli/src/settings/actionsSettingsProvider';
import { installAxiosFastifyAdapter } from '../../../../../../cli/src/testkit/http/axiosAdapter';
import { createCaptureSqliteFixture } from '../../../../../../../packages/plugins/telemetry/src/testing/sqlite';
import { createCaptureRuntime } from '../../../../../../../packages/plugins/telemetry/src/runtime';
import { captureMigrations } from '../../../../../../../packages/plugins/telemetry/src/store/capture';
import { createCaptureSelectedSourceReaders } from '../../../../../../../packages/plugins/telemetry/src/actions';
import { createPostgresqlObservationNormalizer } from '@happier-dev/databases/postgresql';
import { DatabaseCaptureCostsReadInputV1Schema } from '@happier-dev/plugin-sdk/database';
import { createDeploymentEnvironmentDetailV1 } from '@happier-dev/deployments/testing/v1';
import { createArtifact } from '@/app/artifacts/artifactWriteService';
import { createAuthenticatedTestApp } from '@/app/api/testkit/sqliteFastify';
import { createProjectSourceInTx } from '@/app/projects/sources/projectSourceService';
import { getOrCreateServerIdentityId } from '@/app/serverIdentity/serverIdentity';
import { registerTeamCredentialResourceRoutes } from '@/app/teams/credentials/registerTeamCredentialResourceRoutes';
import { registerDeploymentRoutes } from '@/app/api/routes/deployments/deploymentRoutes';
import { db } from '@/storage/db';
import { inTx } from '@/storage/inTx';
import { homeDomainActionPathForMethod } from './homeDomainActionRoute';
import { registerAccountPublicProfileRoutes } from '../account/registerAccountPublicProfileRoutes';
import { registerAccountProfileRoute } from '../account/registerAccountProfileRoute';
import { registerAccountSettingsRoutes } from '../account/registerAccountSettingsRoutes';
import { registerAccountUsageRoutes } from '../account/registerAccountUsageRoutes';
import { createReviewedChildAuthorizationFixture } from './reviewedChildAuthorization.composed.testkit';

type Fixture = Awaited<ReturnType<typeof createReviewedChildAuthorizationFixture>>;
function signedUsageHeaders(input: Omit<Parameters<typeof signExternalActionMachineRequestV1>[0], 'privateKey'>, privateKey: Uint8Array) {
    return { 'content-type': 'application/json',
        [EXTERNAL_ACTION_EFFECT_ACTION_HEADER]: input.effectActionId,
        [EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]: input.authorizationToken,
        [EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER]: signExternalActionMachineRequestV1({ ...input, privateKey }),
        [EXTERNAL_ACTION_RESOLVED_TARGET_HEADER]: encodeExternalActionResolvedTargetV1(input.target),
    };
}

const content = { v: 1 as const, parts: [{ t: 'text' as const, text: 'Reviewed passage' }] };

async function artifact(f: Fixture) {
    const created = await createArtifact({ actorUserId: f.account.id, artifactId: crypto.randomUUID(),
        header: decodeBase64(encodePlainArtifactStoredContent({ kind: 'prompt_doc.v2', title: 'Reviewed Doc' })),
        body: decodeBase64(encodePlainArtifactStoredContent({ body: 'Reviewed passage' })),
        dataEncryptionKey: decodeBase64(ARTIFACT_PLAIN_DATA_KEY_MARKER) });
    if (!created.ok) throw new Error(created.error);
    return created.artifact;
}

async function discussion(f: Fixture) {
    const body = buildDiscussionMutationRequestBodyV1({ kind: 'create', creationLocalId: crypto.randomUUID(),
        titleContent: { t: 'plain', v: { v: 1, title: 'Reviewed comments' } },
        firstMessage: { localId: crypto.randomUUID(), content: { t: 'plain', v: content },
            authoredContent: content, mentionedAccountIds: [] } });
    const response = await f.app.inject({ method: 'POST', url: DISCUSSION_HTTP_PATHS_V1.collection,
        headers: { authorization: `Bearer ${f.presentUserToken}` }, payload: body });
    expect(response.statusCode, response.body).toBe(200);
    return response.json().discussion.id as string;
}

/** Post-refactor characterization using the private host or native sibling issuer and real CLI signatures. */
export function registerAccountChildAuthorizationComposedTests(): void {
    it('exports Team credential usage through its native query sibling and refuses a freshly signed Account read', async () => {
        // Export builds its CSV on the client. A scoped API token exercises the signed sibling without claiming a person-originated Account root.
        const f = await createReviewedChildAuthorizationFixture({ allowedActionIds: ['teams.credentials.usage.export'] });
        const app = createAuthenticatedTestApp({ authentication: 'real' });
        registerTeamCredentialResourceRoutes(app);
        await app.ready();
        try {
            const team = await db.team.create({ data: { name: 'Reviewed usage export' } });
            await db.teamMembership.create({ data: { teamId: team.id, accountId: f.account.id, role: 'admin' } });
            const resource = await db.teamCredentialResource.create({ data: { teamId: team.id,
                custodianAccountId: f.account.id, displayName: storedPlainPrivateLabel('Reviewed model'), disclosureCeiling: 'brokered_only',
                sessionUsePolicy: 'personal_allowed', sourceBindingJson: '{}', allMembersDeliveryMode: 'brokered' } });
            const input = { query: { resourceId: resource.id, startMs: 0, endMs: Date.now(),
                granularity: 'day', costMode: 'auto' } };
            const root = await f.root('teams.credentials.usage.export', input, 'api_token');
            const homeDomainAction: NonNullable<ActionExecutorDeps['homeDomainAction']> = async ({ actionId, input: body, context }) => {
                const path = homeDomainActionPathForMethod(actionId, 'POST');
                const response = await app.inject({ method: 'POST', url: path, payload: body,
                    headers: await f.headers(context.externalActionExecutionAuthorization!, { effectActionId: actionId, method: 'POST', path, body }) });
                expect(response.statusCode, response.body).toBe(200);
                expect(response.json()).toMatchObject({ v: 1, totals: { tokens: { total: 0 } } });
                return response.json();
            };
            const executor = createActionExecutor({ teamCredentialUsageExport: createCliTeamCredentialUsageExportAction({
                credentials: { token: f.pat.token, encryption: null }, homeDomainAction,
            }) });
            const exported = await executor.execute('teams.credentials.usage.export', input, f.context(root));
            expect(exported, JSON.stringify(exported)).toMatchObject({ ok: true, result: { mediaType: 'text/csv' } });
            const path = '/v1/account/encryption/currentness';
            const refused = await f.app.inject({ method: 'GET', url: path,
                headers: await f.headers(root, { effectActionId: 'teams.credentials.usage.query', method: 'GET', path }) });
            expect(refused.statusCode, refused.body).toBe(401);
        } finally { await app.close(); await f.app.close(); }
    });

    it('reads a selected registry app update Environment through its native sibling and refuses a fresh unselected read', async () => {
        const f = await createReviewedChildAuthorizationFixture();
        const app = createAuthenticatedTestApp({ authentication: 'real' });
        registerDeploymentRoutes(app);
        await app.ready();
        try {
            const serverId = await getOrCreateServerIdentityId();
            const source = await inTx(tx => createProjectSourceInTx(tx, f.account.id, { serverId,
                requestKey: crypto.randomUUID(), name: 'Reviewed registry app', audience: [] }));
            if (!source.ok) throw new Error(source.error);
            const content = await createArtifact({ actorUserId: f.account.id, artifactId: crypto.randomUUID(),
                header: decodeBase64(encodePlainArtifactStoredContent({ kind: 'deployment-environment.v1', title: 'Reviewed app' })),
                body: decodeBase64(encodePlainArtifactStoredContent({ body: JSON.stringify(createDeploymentEnvironmentDetailV1().content) })),
                dataEncryptionKey: decodeBase64(ARTIFACT_PLAIN_DATA_KEY_MARKER) });
            if (!content.ok) throw new Error(content.error);
            const data = { projectSourceId: source.source.id, createdByAccountId: f.account.id,
                protection: 'nonProduction', purpose: 'standard', deployerMode: 'managers',
                controllerMachineId: f.machine.id, buildMachineId: f.machine.id,
                contentArtifactId: content.artifact.id, contentHeaderVersion: content.artifact.headerVersion,
                contentBodyVersion: content.artifact.bodyVersion } as const;
            const environment = await db.deploymentEnvironment.create({ data });
            const unselected = await db.deploymentEnvironment.create({ data });
            const input = { kind: 'app', environments: [{ environmentId: environment.id, expectedRevision: environment.revision }] };
            const root = await f.root('registries.updates.check', input);
            for (const [id, status] of [[environment.id, 200], [unselected.id, 401]] as const) {
                const path = `/v1/deployments/environments/${id}?serverId=${serverId}`;
                const response = await app.inject({ method: 'GET', url: path,
                    headers: await f.headers(root, { effectActionId: 'deployments.environments.get', method: 'GET', path }) });
                expect(response.statusCode, response.body).toBe(status);
                if (status === 200) expect(response.json()).toMatchObject({ ok: true, environment: { id: environment.id } });
            }
        } finally { await app.close(); await f.app.close(); }
    });

    it('mints the signed Usage collector child for the original scoped token and refuses other operands', async () => {
        let dispatch: ExternalActionDaemonDispatcher | undefined;
        const requests: Array<{ method: string; url: string; status: number }> = [];
        const f = await createReviewedChildAuthorizationFixture({
            configureApp: home => {
                home.addHook('onResponse', (request, reply, done) => {
                    requests.push({ method: request.method, url: request.url, status: reply.statusCode });
                    done();
                });
                registerDeploymentRoutes(home);
                registerAccountProfileRoute(home);
                registerAccountSettingsRoutes(home);
                registerAccountUsageRoutes(home);
            },
            dispatch: (request, options) => dispatch?.(request, options) ?? Promise.resolve({ kind: 'placement_error', code: 'target_unavailable' }),
        });
        const app = createAuthenticatedTestApp({ authentication: 'real' });
        registerDeploymentRoutes(app);
        await app.ready();
        try {
            const serverId = await getOrCreateServerIdentityId();
            const source = await inTx(tx => createProjectSourceInTx(tx, f.account.id, { serverId,
                requestKey: crypto.randomUUID(), name: 'Usage test', audience: [] }));
            if (!source.ok) throw new Error(source.error);
            const content = await createArtifact({ actorUserId: f.account.id, artifactId: crypto.randomUUID(),
                header: decodeBase64(encodePlainArtifactStoredContent({ kind: 'deployment-environment.v1', title: 'App' })),
                body: decodeBase64(encodePlainArtifactStoredContent({ body: JSON.stringify(createDeploymentEnvironmentDetailV1().content) })),
                dataEncryptionKey: decodeBase64(ARTIFACT_PLAIN_DATA_KEY_MARKER) });
            if (!content.ok) throw new Error(content.error);
            const data = { projectSourceId: source.source.id, createdByAccountId: f.account.id,
                protection: 'nonProduction', purpose: 'standard', deployerMode: 'managers',
                controllerMachineId: f.machine.id, buildMachineId: f.machine.id, telemetryMachineId: f.machine.id,
                telemetryAppLlmCostEnabled: true, contentArtifactId: content.artifact.id,
                contentHeaderVersion: content.artifact.headerVersion, contentBodyVersion: content.artifact.bodyVersion } as const;
            const selected = await db.deploymentEnvironment.create({ data });
            const foreign = await db.deploymentEnvironment.create({ data });
            const machineId = f.machine.id;
            const target = { kind: 'machine', machineId } as const;
            const grant = { ...API_TOKEN_FULL_GRANT_V1, actions: { families: ['usage' as const], ids: [] },
                targets: { sessions: [], machines: [machineId], environments: [selected.id] } };
            const tokenId = crypto.randomUUID();
            const pat = await auth.createApiToken({ accountId: f.account.id, tokenId,
                label: plainPrivateLabel('Usage app only'), grant });
            const sqlite = createCaptureSqliteFixture();
            const socket = new Server();
            const restoreAxios = installAxiosFastifyAdapter({ app: f.app, origin: f.origin });
            try {
                for (const migration of captureMigrations) await migration.up(sqlite.db);
                const runtime = createCaptureRuntime({ database: sqlite.db,
                    normalizeStatement: createPostgresqlObservationNormalizer(), publish() {} });
                const tokens = { input: 10, output: 2, cacheRead: null, cacheWrite: null, reasoning: null, total: null };
                const partition = `environment:${selected.id}`;
                const reader = createCaptureSelectedSourceReaders({ runtime, partition,
                    source: { kind: 'environment', serverId, environmentId: selected.id } });
                await runtime.store.write([{ id: 'call', kind: 'span', source: 'otlp', worktree: partition, at: 150,
                    genAi: { provider: 'openai', modelId: 'sample', requestedModel: 'sample', operation: 'chat',
                        tokens, tokenCategories: tokens, reportedCost: null } }]);
                const token = await auth.createToken(f.account.id, undefined, { kind: 'terminal', authority: 'account_automation' });
                const installationId = f.machine.installationId!;
                const executor = createCliActionExecutorFromCredentials({
                    credentials: { token, encryption: null }, serverId, serverIdentityId: serverId, serverApiUrl: f.origin,
                    machineId, pluginActionExecutionOwner: 'current_process',
                    actionsSettingsProvider: createActionSettingsProvider({ scopeKey: 'app-accounting-route' }),
                    externalActionMachineRequestPrivateKey: f.keyPair.secretKey, externalActionMachineInstallationId: installationId,
                });
                dispatch = createExternalActionDaemonDispatcher({ io: socket, resolveMachine: async () => 'available',
                    forwardRpc: async ({ callParams, cancellation, machineAdmission }) => {
                    const received = await executeExternalAction({
                        ...ExternalActionDaemonDispatchRequestSchema.parse(callParams), machineAdmission, signal: cancellation?.signal,
                        currentMachineId: machineId, currentAccountId: f.account.id, currentServerId: serverId,
                        currentInstallationId: installationId, currentServerHttpBaseUrl: f.origin,
                        externalActionMachineRequestPrivateKey: f.keyPair.secretKey,
                        verifyExecutionAuthorization: args => verifyExternalActionExecutionAuthorizationCurrent({ ...args,
                            installationId, privateKey: f.keyPair.secretKey, serverHttpBaseUrl: f.origin }),
                        resolveTarget: async ({ target: requested }) => requested ?? null,
                        executor: { async execute(id, value, context) {
                            if (id !== ACTION_INVOKE_ACTION_ID_V1) return executor.execute(id, value, context);
                            const admitted = context?.externalActionExecutionAuthorization?.binding;
                            expect(admitted).toMatchObject({ usageCollectorParent: { requestId: expect.any(String) },
                                deploymentTelemetryRead: [{ environmentId: selected.id }] });
                            const read = DatabaseCaptureCostsReadInputV1Schema.parse((value as { input: unknown }).input);
                            return { ok: true, result: await reader.readCapturedCosts(read) };
                        } },
                    });
                    return { ok: true, result: received.kind === 'response' ? createExternalActionDaemonDispatchResponse(received.prepared) : received };
                } });
                const listControl = await f.app.inject({ method: 'GET', url: `/v1/deployments/environments?serverId=${serverId}`,
                    headers: { authorization: `Bearer ${f.presentUserToken}` } });
                expect(listControl.statusCode, listControl.body).toBe(200);
                const response = await f.app.inject({ method: 'POST',
                    url: `${EXTERNAL_ACTION_HTTP_PATH_PREFIX_V1}${USAGE_QUERY_ACTION_ID_V1}`,
                    headers: { authorization: `Bearer ${pat.token}` }, payload: {
                        v: 1, requestId: crypto.randomUUID(), target,
                        input: { queries: [{ period: { startMs: 100, endMs: 200 }, sources: [`app_calls:${selected.id}`] }] },
                    } });
                expect(response.statusCode, response.body).toBe(200);
                const execution = parseExternalActionResponseEnvelopeV1(response.json())?.execution;
                expect(execution, response.body).toMatchObject({ ok: true });
                if (!execution?.ok) throw new Error('Usage query did not settle');
                const result = UsageQueryBatchResultSchema.parse(execution.result);
                expect(result.results[0], JSON.stringify({ sources: result.results[0]?.sources, requests })).toMatchObject({
                    accounting: { totals: { eventCount: 1, tokens: { total: null, measured: { total: 12, fromParts: true } } } },
                });
            } finally { dispatch = undefined; restoreAxios(); sqlite.close(); }
            const mintPath = bindExternalActionExecutionAuthorizationHttpPathV1(ACTION_INVOKE_ACTION_ID_V1);
            let credentialId: string | undefined;
            const randomBytes = (size: number) => new Uint8Array(crypto.getRandomValues(new Uint8Array(size)));
            const material = { type: 'dataKey' as const, machineKey: randomBytes(32) };
            const collectorRequest = (environmentId: string, collectorMachineId: string = machineId, value?: unknown) => {
                if (!credentialId) throw new Error('Usage credential is required');
                const requestId = crypto.randomUUID();
                const action = parseQualifiedPluginActionId(TELEMETRY_COSTS_READ_ACTION_ID_V1)!;
                const input = { action, input: { source: { kind: 'environment', serverId, environmentId },
                    since: 100, until: 200, granularity: 'hour' } };
                const envelope = sealExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1, binding: { serverIdentityId: serverId, accountId: f.account.id,
                    credentialId, actionId: ACTION_INVOKE_ACTION_ID_V1, requestId,
                    target: { kind: 'machine', machineId: collectorMachineId } },
                    material, input: value ?? input, randomBytes });
                return { v: 1, machineId: collectorMachineId, envelope: { ...envelope, telemetryCollectorCodec: true } };
            };
            const sendUnder = (authorization: ReturnType<typeof ExternalActionExecutionAuthorizationV1Schema.parse>) => async (url: string, method: 'GET' | 'POST', effectActionId: string, body?: unknown) => {
                const signed = { authorizationToken: authorization.token, installationId: f.machine.installationId!,
                    requestId: authorization.binding.requestId, target, effectActionId, method, path: url, body };
                return (method === 'GET' ? app : f.app).inject({ method, url,
                    headers: signedUsageHeaders(signed, f.keyPair.secretKey),
                    ...(body === undefined ? {} : { payload: JSON.stringify(body) }) });
            };
            for (const actionId of [USAGE_QUERY_ACTION_ID_V1, USAGE_PRIVATE_RECAP_ACTION_IDS.compose, USAGE_EXPORT_ACTION_ID_V1]) {
                const query = normalizeUsageQuery({ sources: [`app_calls:${selected.id}`, `app_calls:${foreign.id}`],
                    period: { startMs: 100, endMs: 200 }, includeQuota: true, includeQuotaHistory: true, includeQuotaExactHistory: true,
                    includeWorkEvidence: true, includeSessionEvidence: true, includeTranscriptEvidence: true, includeCoach: true,
                    includeActivity: true, includeMessageStats: true });
                const input = actionId === USAGE_QUERY_ACTION_ID_V1 ? { queries: [query] }
                    : actionId === USAGE_EXPORT_ACTION_ID_V1 ? { query, format: 'json', fields: ['totals'] }
                        : { query, selectedFields: ['tokens'] };
                const root = await f.app.inject({ method: 'POST',
                    url: bindExternalActionExecutionAuthorizationHttpPathV1(actionId),
                    headers: { authorization: `Bearer ${pat.token}` }, payload: { v: 1, machineId,
                        envelope: ExternalActionRequestEnvelopeV1Schema.parse({ v: 1, requestId: crypto.randomUUID(), target, input: projectNativeJsonValueForTransport(input) }) } });
                expect(root.statusCode, root.body).toBe(200);
                const authorization = ExternalActionExecutionAuthorizationV1Schema.parse(root.json());
                if ('authentication' in authorization.binding) throw new Error('Expected the original Usage token');
                credentialId = authorization.binding.credentialId;
                const send = sendUnder(authorization);
                const list = (environmentId?: string) => send(
                    `/v1/deployments/environments?serverId=${serverId}${environmentId ? `&environmentIds=${environmentId}` : ''}`,
                    'GET', 'deployments.environments.list');
                if (actionId === USAGE_QUERY_ACTION_ID_V1 || actionId === USAGE_EXPORT_ACTION_ID_V1) {
                    const listAttempts: (string[] | undefined)[] = [];
                    let collectorMints = 0;
                    const homeRefusal = (body: unknown) =>
                        projectExternalActionHttpFailureV1(ExternalActionHttpErrorSchema.parse(body));
                    let driveForeignChild = actionId === USAGE_QUERY_ACTION_ID_V1;
                    const executor = createActionExecutor({
                        deploymentAction: async (_actionId, value) => {
                            const { environmentIds } = DeploymentEnvironmentListInputV1Schema.parse(value);
                            listAttempts.push(environmentIds);
                            const response = await list(environmentIds?.[0]);
                            return response.statusCode === 200 ? DeploymentEnvironmentListResultV1Schema.parse(response.json()) : homeRefusal(response.json());
                        },
                        routeHostChildAction: async ({ input: value }) => {
                            const request = collectorRequest(selected.id, machineId, value);
                            collectorMints++;
                            const child = await send(mintPath, 'POST', ACTION_INVOKE_ACTION_ID_V1, request);
                            if (child.statusCode !== 200) return homeRefusal(child.json());
                            const { telemetryReadInstallationPublicKey: _key, ...issued } = ExternalActionExecutionAuthorizationV1Schema.parse(child.json());
                            const executionAuthorization = sealManagedControllerActionCodecV1({ authorization: issued, material,
                                installationPublicKey: new Uint8Array(f.keyPair.publicKey), randomBytes });
                            const relayPath = `${EXTERNAL_ACTION_HTTP_PATH_PREFIX_V1}${ACTION_INVOKE_ACTION_ID_V1}`;
                            const priorDispatches = f.dispatchPrincipals.length;
                            const relayed = await send(relayPath, 'POST', ACTION_INVOKE_ACTION_ID_V1, { ...request, executionAuthorization });
                            if (f.dispatchPrincipals.length === priorDispatches) return homeRefusal(relayed.json());
                            expect(f.dispatchPrincipals.length - priorDispatches).toBe(1);
                            // Supply retained raw operands at the remote daemon transport boundary.
                            const tokens = { input: 10, output: 2, cacheRead: 0, cacheWrite: 0, reasoning: 0, total: 12 };
                            return { ok: true, result: { ok: true, source: { kind: 'environment', serverId, environmentId: selected.id },
                                since: 100, until: 200, items: [{ bucketStartMs: 0, provider: null, modelId: 'sample', requestedModel: null,
                                    operation: null, callCount: 1, tokens, tokenCategories: tokens, reportedCost: { amount: 3, currency: 'USD' },
                                    firstSeenMs: 150, lastSeenMs: 150 }],
                                coverage: { callCount: 1, tokenCategoryCallCount: 1, reportedCostCallCount: 1, lostObservations: 0, reason: null } } };
                        },
                        usageActions: {
                            prices: { get: async () => bundledUsageModelPriceCatalog, refresh: async () => bundledUsageModelPriceCatalog },
                            query: async ({ queries }, _context, child) => {
                                if (!child) throw new Error('Usage executor did not supply its App accounting child reader');
                                if (driveForeignChild) return await child(DEPLOYMENT_ENVIRONMENT_LIST_ACTION_ID_V1,
                                    { serverId, environmentIds: [foreign.id] }).then(result => {
                                    if (result.ok) throw new Error('Home admitted a foreign Environment');
                                    return result;
                                });
                                const [projected] = queries;
                                expect(projected).toMatchObject({ sources: [`app_calls:${selected.id}`], includeQuota: false,
                                    includeQuotaHistory: false, includeQuotaExactHistory: false, includeWorkEvidence: false, includeSessionEvidence: false,
                                    includeTranscriptEvidence: false, includeCoach: false, includeActivity: false, includeMessageStats: false });
                                const environmentIds = readUsageAppCallsEnvironmentIds(projected!.sources)!;
                                const value = await readUsageAppCallsAccounting({ serverId, environmentIds,
                                    request: usageQueryToAnalyticsRequest(projected!, 200),
                                    execute: async (id, value, operation) => {
                                        const result = await child(id, value, operation);
                                        if (!result.ok) throw new Error(result.errorCode);
                                        return result.result;
                                    },
                                    readOverrides: () => ({}),
                                    readCatalog: async modelIds => {
                                        const result = await child(USAGE_PRICE_ACTION_IDS.get, { modelIds });
                                        if (!result.ok) throw new Error(result.errorCode);
                                        return result.result;
                                    },
                                });
                                return resolveUsagePageAggregation({ queries, accounting: [{ query: projected!, status: 'available', value }] },
                                    bundledUsageModelPriceCatalog);
                            },
                        },
                    } as ActionExecutorDeps);
                    const context = { ...f.context(authorization), actionRequestId: authorization.binding.requestId,
                        externalActionCredential: { accountId: f.account.id, principalId: authorization.binding.principalId,
                            credentialId, grant } };
                    if (driveForeignChild) {
                        const result = await executor.execute(actionId, input, context);
                        const refused = await list(foreign.id);
                        expect.soft(refused.statusCode).toBe(403);
                        expect.soft(refused.json()).toMatchObject({ error: 'credential_scope_denied',
                            details: { reason: 'environment_not_granted' } });
                        expect.soft(result).toMatchObject(homeRefusal(refused.json()));
                        // One request reaches the Environment owner even when the child is out of scope.
                        expect.soft(listAttempts.splice(0)).toEqual([[foreign.id]]);
                        expect(collectorMints).toBe(0);
                        driveForeignChild = false;
                    }
                    const result = await executor.execute(actionId, input, context);
                    expect(result).toMatchObject({ ok: true });
                    expect(listAttempts).toEqual([[selected.id]]);
                    expect(collectorMints).toBe(1);
                    if (actionId === USAGE_EXPORT_ACTION_ID_V1 && result.ok) {
                        const file = UsageFileResultSchema.parse(result.result);
                        const exported = JSON.parse(new TextDecoder().decode(decodeBase64(file.base64)));
                        expect(exported).toMatchObject({ query: { sources: [`app_calls:${selected.id}`] },
                            accounting: { totals: { eventCount: 1, cost: { reportedUsd: 3 } } } });
                        expect(Object.keys(exported.accounting)).toEqual(['totals']);
                        expect(await executor.execute(actionId, { ...input, query: { ...query, sources: [`app_calls:${foreign.id}`] } }, context))
                            .toMatchObject({ ok: false, errorCode: 'credential_scope_denied', details: { reason: 'environment_not_granted' } });
                        expect(listAttempts).toEqual([[selected.id]]);
                        expect(collectorMints).toBe(1);
                    }
                }
                const selectedList = await list(selected.id);
                expect(selectedList.statusCode, selectedList.body).toBe(200);
                expect(selectedList.json().items.map((row: { id: string }) => row.id)).toEqual([selected.id]);
                expect((await list()).statusCode).toBe(401);
                expect.soft((await list(foreign.id)).statusCode).toBe(403);

                const request = collectorRequest(selected.id);
                const { target: _target, ...targetlessEnvelope } = request.envelope;
                const targetless = await send(mintPath, 'POST', ACTION_INVOKE_ACTION_ID_V1,
                    { ...request, envelope: targetlessEnvelope });
                expect(targetless.statusCode, targetless.body).toBe(401);
                const child = await send(mintPath, 'POST', ACTION_INVOKE_ACTION_ID_V1, request);
                expect(child.statusCode, child.body).toBe(200);
                const { telemetryReadInstallationPublicKey, ...issued } = ExternalActionExecutionAuthorizationV1Schema.parse(child.json());
                expect(issued.binding).toMatchObject({
                    credentialId, principalId: authorization.binding.principalId, grant,
                    usageCollectorParent: { requestId: authorization.binding.requestId,
                        requestEnvelopeDigest: authorization.binding.requestEnvelopeDigest },
                });
                if (!telemetryReadInstallationPublicKey) throw new Error('The admitted collector needs an installation key');
                const executionAuthorization = sealManagedControllerActionCodecV1({ authorization: issued, material,
                    installationPublicKey: new Uint8Array(f.keyPair.publicKey), randomBytes });
                const relayPath = `${EXTERNAL_ACTION_HTTP_PATH_PREFIX_V1}${ACTION_INVOKE_ACTION_ID_V1}`;
                const priorDispatches = f.dispatchPrincipals.length;
                await send(relayPath, 'POST', ACTION_INVOKE_ACTION_ID_V1, { ...request, executionAuthorization });
                expect(f.dispatchPrincipals.slice(priorDispatches)).toMatchObject([{ credentialId, grant }]);
                for (const [refusedRequest, reason] of [
                    [collectorRequest(foreign.id), 'environment_not_granted'],
                    [collectorRequest(selected.id, crypto.randomUUID()), 'target_not_granted'],
                ] as const) {
                    const refused = await send(mintPath, 'POST', ACTION_INVOKE_ACTION_ID_V1, refusedRequest);
                    expect.soft(refused.statusCode).toBe(403);
                    expect.soft(refused.json()).toMatchObject({ error: 'credential_scope_denied', details: { reason } });
                }
                expect((await f.app.inject({ method: 'POST', url: mintPath,
                    headers: { authorization: `Bearer ${pat.token}` }, payload: request })).statusCode).toBeGreaterThanOrEqual(400);
                if (actionId === USAGE_EXPORT_ACTION_ID_V1) {
                    await auth.revokeApiToken({ accountId: f.account.id, tokenId });
                    const revoked = await send(mintPath, 'POST', ACTION_INVOKE_ACTION_ID_V1, request);
                    expect(revoked.statusCode).toBe(401);
                    expect(revoked.json()).toMatchObject({ error: 'invalid_token', authorizationRefusal: 'principal' });
                }
            }
            const otherAccount = await db.account.create({ data: { encryptionMode: 'plain' } });
            const otherSource = await inTx(tx => createProjectSourceInTx(tx, otherAccount.id, { serverId,
                requestKey: crypto.randomUUID(), name: 'Another Account', audience: [] }));
            if (!otherSource.ok) throw new Error(otherSource.error);
            // Keep the same collector to make the Source access decision decisive.
            const inaccessible = await db.deploymentEnvironment.create({ data: {
                ...data, projectSourceId: otherSource.source.id, createdByAccountId: otherAccount.id,
            } });
            const accountGrant = { ...grant, targets: null };
            const accountTokenId = crypto.randomUUID();
            const accountToken = await auth.createApiToken({ accountId: f.account.id, tokenId: accountTokenId,
                label: plainPrivateLabel('Account Usage'), grant: accountGrant });
            try {
                const queries = [normalizeUsageQuery({
                    sources: [selected.id, foreign.id].map(id => `app_calls:${id}`),
                    period: { startMs: 100, endMs: 200 },
                })];
                const requestRoot = await f.app.inject({ method: 'POST',
                    url: bindExternalActionExecutionAuthorizationHttpPathV1(USAGE_QUERY_ACTION_ID_V1),
                    headers: { authorization: `Bearer ${accountToken.token}` }, payload: { v: 1, machineId,
                        envelope: { v: 1, requestId: crypto.randomUUID(), target,
                            input: projectNativeJsonValueForTransport({ queries }) } } });
                expect(requestRoot.statusCode, requestRoot.body).toBe(200);
                const root = ExternalActionExecutionAuthorizationV1Schema.parse(requestRoot.json());
                if ('authentication' in root.binding) throw new Error('Expected the original Account-wide token');
                credentialId = root.binding.credentialId;
                const send = sendUnder(root);
                const list = (...ids: string[]) => send(
                    `/v1/deployments/environments?${new URLSearchParams([['serverId', serverId],
                        ...ids.map(id => ['environmentIds', id])])}`, 'GET', DEPLOYMENT_ENVIRONMENT_LIST_ACTION_ID_V1);
                const visible = await list(selected.id, foreign.id, inaccessible.id);
                expect(visible.statusCode, visible.body).toBe(200);
                expect(visible.json().items.map((row: { id: string }) => row.id).sort()).toEqual([selected.id, foreign.id].sort());
                for (const environmentId of [selected.id, foreign.id]) {
                    const request = collectorRequest(environmentId);
                    const child = await send(mintPath, 'POST', ACTION_INVOKE_ACTION_ID_V1, request);
                    expect(child.statusCode, child.body).toBe(200);
                    const { telemetryReadInstallationPublicKey: _key, ...issued } = ExternalActionExecutionAuthorizationV1Schema.parse(child.json());
                    const { binding } = issued;
                    expect(binding).toMatchObject({ credentialId, principalId: root.binding.principalId, grant: accountGrant,
                        usageCollectorParent: { requestId: root.binding.requestId, requestEnvelopeDigest: root.binding.requestEnvelopeDigest },
                        deploymentTelemetryRead: [{ environmentId }],
                    });
                    const executionAuthorization = sealManagedControllerActionCodecV1({ authorization: issued, material,
                        installationPublicKey: new Uint8Array(f.keyPair.publicKey), randomBytes });
                    const priorDispatches = f.dispatchPrincipals.length;
                    await send(`${EXTERNAL_ACTION_HTTP_PATH_PREFIX_V1}${ACTION_INVOKE_ACTION_ID_V1}`, 'POST',
                        ACTION_INVOKE_ACTION_ID_V1, { ...request, executionAuthorization });
                    expect(f.dispatchPrincipals.slice(priorDispatches)).toMatchObject([{ credentialId, grant: accountGrant }]);
                }
                const refused = await send(mintPath, 'POST', ACTION_INVOKE_ACTION_ID_V1, collectorRequest(inaccessible.id));
                expect(refused.statusCode).toBeGreaterThanOrEqual(400);
                expect(refused.json()).not.toHaveProperty('token');
            } finally {
                await auth.revokeApiToken({ accountId: f.account.id, tokenId: accountTokenId });
            }
        } finally { await app.close(); await f.app.close(); }
    });

    // These native owners reuse the admitted root context for their internal HTTP transports; they declare no reviewed-child role.
    it('authorizes native Doc acceptance Discussion preparation and refuses its grant roster', async () => {
        const f = await createReviewedChildAuthorizationFixture();
        try {
            const discussionId = await discussion(f);
            const input = { proposalRef: { kind: 'discussion', discussion: { serverId: await getOrCreateServerIdentityId(), discussionId }, messageId: 'proposal' },
                expectedRevision: { headerVersion: 1, bodyVersion: 1 } };
            const root = await f.root('doc.edit.accept', input);
            for (const [template, status] of [[DISCUSSION_HTTP_PATHS_V1.discussion, 200], [DISCUSSION_HTTP_PATHS_V1.recipientCensus, 401]] as const) {
                const path = template.replace(':discussionId', discussionId);
                const response = await f.app.inject({ method: 'GET', url: path,
                    headers: await f.headers(root, { effectActionId: 'discussion.read', method: 'GET', path }) });
                expect(response.statusCode, response.body).toBe(status);
            }
        } finally { await f.app.close(); }
    });

    it('authorizes the native Doc comment Discussion write and refuses its grant roster', async () => {
        const f = await createReviewedChildAuthorizationFixture();
        try {
            const discussionId = await discussion(f);
            const doc = await artifact(f);
            const serverId = await getOrCreateServerIdentityId();
            const input = { target: { ref: { kind: 'doc', artifactId: doc.id, serverId }, revision: { headerVersion: 1, bodyVersion: 1 },
                range: { start: 0, end: 7 }, quote: 'Passage' }, discussionRef: { serverId, discussionId },
                localId: crypto.randomUUID(), content };
            const root = await f.root('doc.comment.reply', input);
            const mutation = prepareDocDiscussionMutationV1('doc.comment.reply', input, serverId);
            if (mutation.actionId !== 'discussion.post') throw new Error('Expected the canonical Doc comment post');
            const body = buildDiscussionMutationRequestBodyV1({ kind: 'post', localId: mutation.input.localId,
                content: { t: 'plain', v: mutation.input.content }, authoredContent: mutation.input.content,
                replyTarget: mutation.input.replyTarget, mentionedAccountIds: [] });
            const path = DISCUSSION_HTTP_PATHS_V1.messages.replace(':discussionId', discussionId);
            const response = await f.app.inject({ method: 'POST', url: path, payload: body,
                headers: await f.headers(root, { effectActionId: 'discussion.post', method: 'POST', path, body }) });
            expect(response.statusCode, response.body).toBe(200);
            const refusedPath = DISCUSSION_HTTP_PATHS_V1.recipientCensus.replace(':discussionId', discussionId);
            const refused = await f.app.inject({ method: 'GET', url: refusedPath,
                headers: await f.headers(root, { effectActionId: 'discussion.post', method: 'GET', path: refusedPath }) });
            expect(refused.statusCode, refused.body).toBe(401);
        } finally { await f.app.close(); }
    });

    it('authorizes native Second opinion Artifact preparation and refuses Artifact inventory', async () => {
        const f = await createReviewedChildAuthorizationFixture({ artifactReads: true });
        try {
            const doc = await artifact(f);
            const source = { kind: 'doc_passage', passage: { ref: { kind: 'doc', artifactId: doc.id },
                revision: { headerVersion: 1, bodyVersion: 1 }, range: { start: 0, end: 7 }, quote: 'Passage' } };
            const input = { intent: 'preview', source, title: 'Review', question: 'Check this', reviewers: [],
                retry: { creationLocalId: crypto.randomUUID(), quoteLocalId: crypto.randomUUID(), questionLocalId: crypto.randomUUID() } };
            const root = await f.root('discussion.second_opinion.start', input);
            for (const [path, status] of [[`/v1/artifacts/${doc.id}`, 200], ['/v1/artifacts', 401]] as const) {
                const response = await f.app.inject({ method: 'GET', url: path,
                    headers: await f.headers(root, { effectActionId: 'artifact.get', method: 'GET', path }) });
                expect(response.statusCode, response.body).toBe(status);
            }
        } finally { await f.app.close(); }
    });

    it('authorizes native Memory exposure reads and refuses recipient key preparation', async () => {
        const f = await createReviewedChildAuthorizationFixture({ artifactReads: true, publicShares: true });
        try {
            const doc = await artifact(f);
            const input = { ref: { kind: 'doc', artifactId: doc.id }, expectedRevision: { headerVersion: 1, bodyVersion: 1 }, factId: 'fact' };
            const root = await f.root('memory.forget', input);
            for (const [path, status] of [[`/v1/artifacts/${doc.id}/access/grants`, 200],
                [`/v1/public-shares?subjectKind=artifact&subjectId=${doc.id}`, 200],
                [`/v1/artifacts/${doc.id}/access/recipients`, 401]] as const) {
                const response = await f.app.inject({ method: 'GET', url: path,
                    headers: await f.headers(root, { effectActionId: 'artifact.access.grants.list', method: 'GET', path }) });
                expect(response.statusCode, response.body).toBe(status);
                if (status === 200 && path.includes('/access/grants')) expect(response.json()).toMatchObject({ artifactId: doc.id, ownerAccountId: f.account.id });
            }
        } finally { await f.app.close(); }
    });

    it('authorizes native Usage export encryption preparation and refuses feature inventory', async () => {
        const f = await createReviewedChildAuthorizationFixture();
        try {
            const input = { query: projectNativeJsonValueForTransport(normalizeUsageQuery({})), format: 'json', fields: ['totals'] };
            const root = await f.root('usage.export', input);
            for (const [path, status] of [['/v1/account/encryption/currentness', 200], ['/v1/features/authenticated', 401]] as const) {
                const response = await f.app.inject({ method: 'GET', url: path,
                    headers: await f.headers(root, { effectActionId: 'usage.query', method: 'GET', path }) });
                expect(response.statusCode, response.body).toBe(status);
                if (status === 200) expect(response.json()).toMatchObject({ mode: 'plain' });
            }
        } finally { await f.app.close(); }
    });

    it('authorizes native public-profile owner preparation and refuses the published view sibling', async () => {
        const f = await createReviewedChildAuthorizationFixture();
        const app = createAuthenticatedTestApp({ authentication: 'real' });
        registerAccountPublicProfileRoutes(app);
        await app.ready();
        try {
            const input = { policy: DEFAULT_PUBLIC_PROFILE_POLICY_V1, metadataSelection: {}, query: projectNativeJsonValueForTransport(normalizeUsageQuery({})),
                layout: { v: 1, items: [] }, appearance: DEFAULT_PUBLIC_PROFILE_APPEARANCE_V1 };
            const root = await f.root('account.public_profile.preview', input);
            for (const [path, status] of [['/v1/account/public-profile', 200], ['/v1/account/public-profile/view', 401]] as const) {
                const response = await app.inject({ method: 'GET', url: path,
                    headers: await f.headers(root, { effectActionId: 'account.public_profile.get', method: 'GET', path }) });
                expect(response.statusCode, response.body).toBe(status);
                if (status === 200) expect(response.json()).toMatchObject({ kind: 'absent' });
            }
        } finally { await app.close(); await f.app.close(); }
    });
}
