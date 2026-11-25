import fastify from 'fastify';
import { afterEach, expect, it, vi } from 'vitest';
import { readOrCreateInstallationIdentity } from '@/daemon/identity/store';
import { decodeBase64 } from '@happier-dev/protocol/crypto/base64';
import { ApprovalRequestV2Schema, decodePlainArtifactStoredContent, encodePlainArtifactStoredContent,
    DeploymentTargetLinkInputV1Schema } from '@happier-dev/protocol';
import { DEPLOYMENT_ENVIRONMENT_ARTIFACT_KIND_V1, DEPLOYMENT_TARGET_LINK_ARTIFACT_KIND_V1 } from '@happier-dev/deployment-protocol';
import { normalizeActionsSettingsV1 } from '@happier-dev/protocol/actions/actionSettings';
import { bindExternalActionExecutionAuthorizationVerifyHttpPathV1, EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER,
    EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER, ExternalActionExecutionAuthorizationRequestV1Schema,
    ExternalActionExecutionAuthorizationV1Schema, ExternalActionExecutionAuthorizationVerifyRequestV1Schema,
    ExternalActionExecutionAuthorizationVerifyResponseV1Schema, type ExternalActionExecutionAuthorizationV1 } from '@happier-dev/protocol/actions/externalActionApi';
import { computeExternalActionRequestEnvelopeDigestV1, signExternalActionApprovalInputV1,
    verifyExternalActionMachineRequestV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { createDeploymentEnvironmentDetailV1, createDeploymentTargetLinkHeaderV1 } from '@happier-dev/deployments/testing/v1';
import { configuration } from '@/configuration';
import { projectExternalActionRequesterHttpAuthorization } from '@/api/externalActionExecutionAuthorization';
import { createExampleDeploymentTargetContributions, createInstalledDeploymentTargetContributions } from '@/deployments/platformFailureNotices.testkit';
import { createDaemonDeploymentActionDeps } from '@/deployments/createDaemonDeploymentActionDeps';
import { createDaemonApprovalExecutionOriginCurrentnessFromCredentials } from '@/daemon/externalActions/daemonExternalActionTargetResolver';
import { withConfiguredDaemonTestHome } from '@/daemon/testkit/fakeDaemonLifecycle.testkit';
import { updateSettings } from '@/persistence';
import * as machineRpc from '@/session/transport/rpc/machineRpc';
import { installAxiosFastifyAdapter } from '@/testkit/http/axiosAdapter';
import { createCliActionExecutorFromCredentials } from '../createCliActionExecutorFromCredentials';
import { createCliActionExecutorHarness } from '../createCliActionExecutorHarness';
import { createMachineApprovalReplayPreparer, registerAccountHomeHttp, registerPlainArtifactRoutes,
    registerMachineApprovalDecisionHomeHttp } from '../widgetApproval.testkit';
import { PLUGIN_MANIFEST as cloudflareManifest } from '../../../../../../packages/plugins/deploy-cloudflare/src/manifest';
import { normalizePluginManifestV2 } from '@/plugins/manifest/normalize';
import type { PluginRuntimeRegistryLease } from '@/plugins/runtime/reload/controller';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it.each(['ready', 'cloudflare-existing-content', 'partial-inventory', 'invalid-inventory', 'validation-inventory', 'validation-environment', 'content-publish-refused', 'association-refused'] as const)('replays public provider Link on its retained Machine (%s)', async scenario => {
    await withConfiguredDaemonTestHome({ prefix: 'happier-link-approval-', env: {
        HAPPIER_SERVER_URL: 'https://link-approval.test', HAPPIER_WEBAPP_URL: 'https://link-approval.test',
        HAPPIER_TOKEN: undefined, HAPPIER_SESSION_REQUESTER_CREDENTIAL_FILE: undefined,
    } }, async () => {
        const app = fastify();
        const endpoint = 'https://link-approval.test';
        const restore = installAxiosFastifyAdapter({ app, origin: endpoint });
        const serverId = configuration.activeServerId;
        const homeId = 'srv_link_approval';
        const accountId = 'owner';
        const machineId = 'controller';
        const credentials = { token: `header.${Buffer.from(JSON.stringify({ sub: accountId, tokenEpoch: 1,
            provenance: { v: 1, kind: 'account', authority: 'present_user' } })).toString('base64url')}.signature`,
            encryption: null, credentialProvenance: 'stored_session' as const };
        await updateSettings(settings => ({ ...settings, servers: { ...settings.servers, [serverId]: {
            id: serverId, name: 'Home', serverUrl: endpoint, webappUrl: endpoint, createdAt: 1, updatedAt: 1,
            lastUsedAt: 1, homeConnectionDescriptorAuthority: 'exact', homeConnectionDescriptor: {
                v: 1, homeServerIdentityId: homeId, canonicalServerUrl: endpoint, revision: 1,
                endpoints: [{ kind: 'https', url: endpoint }],
            },
        } } }));
        const actions = normalizeActionsSettingsV1({ v: 1, actions: {
            'deployments.targets.link': { approvalRequiredSurfaces: ['cli'] },
        } });
        const policy = { getActionsSettings: () => actions, getAccountSettings: () => ({}) };
        const features = registerAccountHomeHttp(app, { accountId, serverId: homeId, settings: { actionsSettingsV1: actions } });
        const artifacts = registerPlainArtifactRoutes(app, accountId);
        vi.stubGlobal('fetch', async () => Response.json(features));
        const environment = createDeploymentEnvironmentDetailV1();
        environment.environment.serverId = homeId;
        environment.environment.owner = { kind: 'account', accountId };
        environment.environment.controllerMachineId = machineId;
        artifacts.seed(environment.environment.contentArtifactId,
            encodePlainArtifactStoredContent({ kind: DEPLOYMENT_ENVIRONMENT_ARTIFACT_KIND_V1, title: 'Staging' }),
            encodePlainArtifactStoredContent({ body: JSON.stringify(environment.content) }));
        // The Pages fixture follows QA's r62-c4 Link input; provider calls are already completed by Inspect.
        const pages = scenario === 'cloudflare-existing-content';
        const pluginId = pages ? 'happier.deploy.cloudflare' : 'example.deploy';
        const contribution = { pluginId, localId: pages ? 'pages' : 'platform' };
        const provider = { credentialPrincipal: { kind: 'account', accountId,
            purpose: { consumer: { pluginId, localId: pages ? 'targets-inspect-v1' : 'runtime' }, purpose: pages ? 'deploy.manage' : 'manage' },
            target: { kind: 'account', account: { service: { pluginId, localId: pages ? 'cloudflare' : 'service' }, accountId: 'credential' } } },
            providerIdentity: { providerAccountId: 'organization', providerResourceId: 'project', providerEnvironment: 'production' },
            providerEnvironment: { kind: 'native', selection: { kind: 'production' } } };
        const input = { serverId: homeId, environmentId: environment.environment.id,
            expectedRevision: environment.environment.revision, requestKey: 'link-provider', role: 'runtime',
            targetId: 'runtime', targetKind: pages ? 'cloudflare-pages' : 'example', machines: [],
            source: { kind: 'plugin', contribution }, provider };
        const existingLink = createDeploymentTargetLinkHeaderV1({ id: 'existing-pages-link', environmentId: 'sibling-environment',
            role: 'runtime', source: input.source, targetKind: input.targetKind, machines: [], members: [],
            contentArtifactId: 'existing-pages-content', contentHeaderVersion: 1, contentBodyVersion: 1 });
        if (pages) artifacts.seed(existingLink.contentArtifactId,
            encodePlainArtifactStoredContent({ kind: DEPLOYMENT_TARGET_LINK_ARTIFACT_KIND_V1, title: 'Existing Pages project' }),
            encodePlainArtifactStoredContent({ body: JSON.stringify({ ...provider,
                providerIdentity: { ...provider.providerIdentity, providerResourceId: 'another-pages-project' } }) }));
        let persistedLink: ReturnType<typeof createDeploymentTargetLinkHeaderV1> | null = null;
        let replaying = false;
        const environmentDiagnostic = { step: 'target_link.environment_read', field: 'serverId', rule: 'invalid_type' };
        app.get(`/v1/deployments/environments/${input.environmentId}`, async (_request, reply) =>
            scenario === 'validation-environment' && replaying
                ? reply.code(400).send({ ok: false, error: 'deployment_invalid', diagnostic: environmentDiagnostic })
                : { ok: true, environment: environment.environment, targetLinks: persistedLink ? [persistedLink] : [] });
        const inventoryDiagnostic = { step: 'target_link.provider_links_read', field: 'selection', rule: 'invalid_type' };
        app.post('/v1/deployments/targets/list', async (_request, reply) => scenario === 'invalid-inventory'
            ? { error: 'private-response-must-not-escape', secret: 'private-provider-payload' }
            : scenario === 'validation-inventory' ? reply.code(400).send({ ok: false, error: 'deployment_invalid', diagnostic: inventoryDiagnostic })
                : { ok: true, items: pages ? [{ environment: { ...environment.environment, id: existingLink.environmentId }, targetLink: existingLink }] : [],
                    nextCursor: null, coverage: scenario === 'partial-inventory' ? 'partial' : 'complete' });
        const associations: unknown[] = [];
        app.post(`/v1/deployments/environments/${input.environmentId}/targets`, async request => {
            const prepared = DeploymentTargetLinkInputV1Schema.parse(request.body);
            associations.push(prepared);
            if (scenario === 'association-refused') return { ok: false, error: 'deployment_content_unavailable' };
            persistedLink = createDeploymentTargetLinkHeaderV1({ id: 'linked-runtime', environmentId: input.environmentId,
                role: 'runtime', source: input.source, targetKind: input.targetKind, machines: [], members: [],
                contentArtifactId: prepared.contentArtifactId, contentHeaderVersion: prepared.contentHeaderVersion,
                contentBodyVersion: prepared.contentBodyVersion });
            environment.environment.revision = input.expectedRevision + 1;
            environment.environment.runtimeTargetLinkId = persistedLink.id;
            return { ok: true, environmentId: input.environmentId, revision: input.expectedRevision + 1,
                targetLinkId: 'linked-runtime', targetLinkRevision: 1 };
        });
        const installation = await readOrCreateInstallationIdentity();
        const installationKeys = { publicKey: decodeBase64(installation.publicKey, 'base64url'),
            secretKey: decodeBase64(installation.privateKey, 'base64url') };
        const machine = { id: machineId, kind: 'persistent', active: true, installationId: installation.installationId,
            installationPublicKey: Buffer.from(installationKeys.publicKey).toString('base64'),
            revokedAt: null, replacedByMachineId: null,
            access: { custodian: { accountId, displayName: 'Owner' }, role: 'manage', resourceMode: 'plain', accessState: 'ready' } };
        app.get('/v1/machines', async () => [machine]);
        app.get(`/v1/machines/${machineId}`, async () => ({ machine }));
        const artifactCreates: unknown[] = [];
        const http: string[] = [];
        let postPersistArtifactReads = 0;
        app.addHook('preHandler', async (request, reply) => {
            http.push(`${request.method} ${request.url}`);
            // A successful association is durable; an unnecessary content read must not turn it into failure.
            if (persistedLink && request.method === 'GET'
                && (request.url === `/v1/artifacts/${environment.environment.contentArtifactId}`
                    || request.url === `/v1/artifacts/${persistedLink.contentArtifactId}`)) {
                postPersistArtifactReads++;
                return reply.code(401).send({ error: 'private-post-persist-read-refusal' });
            }
            if (request.method === 'POST' && request.url === '/v1/artifacts') {
                artifactCreates.push(request.body);
                // Fail the provider-content publication after the approval Artifact succeeds.
                if (scenario === 'content-publish-refused' && artifactCreates.length === 2) {
                    return reply.code(403).send({ error: 'private-response-must-not-escape' });
                }
            }
        });
        const { contributes } = pages ? createInstalledDeploymentTargetContributions({ pluginId, pluginRootPath: '/plugins/cloudflare',
            manifestPath: '/plugins/cloudflare/plugin.json', daemonEntryPath: '/plugins/cloudflare/daemon.js', devDaemonEntryPath: null,
            sourceSpec: { kind: 'package', locator: pluginId, trustPolicy: 'local_trusted', installPolicy: 'copy' },
            manifest: normalizePluginManifestV2(cloudflareManifest) }) : createExampleDeploymentTargetContributions();
        const native = createDaemonDeploymentActionDeps({ credentials, serverId: homeId, serverHttpBaseUrl: endpoint, machineId,
            async acquirePluginRuntimeRegistryLease() {
                // Installed registry boundary: real manifest projection, no provider executable before the refused read.
                return { registry: { contributes }, source: 'active', durableRevision: 1, release: async () => {} } as PluginRuntimeRegistryLease;
            },
            resolveRequesterIdentity: async () => ({ kind: 'unknown', reason: 'requester_authority_unavailable' }),
            runtime: { async acquire() { throw new Error('Link preparation has no deployment runtime effect'); } } });
        let receiving: ReturnType<typeof createCliActionExecutorHarness>['executor'] | undefined;
        const prepareApprovalExecutionAuthorization = createMachineApprovalReplayPreparer({ credentials, machineId,
            serverId, serverIdentityId: homeId, serverHttpBaseUrl: endpoint, installation, executor: () => receiving! });
        const { executor: daemon } = createCliActionExecutorHarness({ credentials, token: credentials.token,
            sessionId: 'cli-global', mode: 'plain', ctx: null, serverId, serverIdentityId: homeId,
            serverHttpBaseUrl: endpoint, actionsSettingsProvider: policy,
            externalActionMachineInstallationId: machine.installationId,
            externalActionMachineRequestPrivateKey: installationKeys.secretKey,
        }, {
            deploymentAction: native.deploymentAction, prepareApprovalExecutionAuthorization,
            isApprovalExecutionOriginCurrent: createDaemonApprovalExecutionOriginCurrentnessFromCredentials({
                credentials, machineId, serverId, serverApiUrl: endpoint }),
        });
        receiving = daemon;
        const receiver = await registerMachineApprovalDecisionHomeHttp(app, { credentials, accountId, machineId,
            serverId, serverIdentityId: homeId, serverHttpBaseUrl: endpoint, installation, executor: daemon });
        const originalDispatches: unknown[] = [];
        let admittedLink: ExternalActionExecutionAuthorizationV1 | undefined;
        app.post('/v1/actions/deployments.targets.link/execution-authorization', async request => {
            const { envelope } = ExternalActionExecutionAuthorizationRequestV1Schema.parse(request.body);
            admittedLink = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'home-proof', binding: {
                accountId, authentication: { kind: 'account', tokenEpoch: 1 }, accountEncryptionMode: 'plain',
                serverIdentityId: homeId, custodianAccountId: accountId, machineId, installationId: machine.installationId,
                actionId: 'deployments.targets.link', requestId: envelope.requestId, target: envelope.target,
                requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope),
                deploymentLinkAdmission: { environmentId: environment.environment.id, owner: environment.environment.owner },
            } });
            return admittedLink;
        });
        const verifyLinkPath = bindExternalActionExecutionAuthorizationVerifyHttpPathV1('deployments.targets.link');
        app.post(verifyLinkPath, async request => {
            if (!admittedLink) throw new Error('Missing retained Link root');
            expect(request.headers[EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]).toBe(admittedLink.token);
            const body = ExternalActionExecutionAuthorizationVerifyRequestV1Schema.parse(request.body);
            expect(body.binding).toEqual(admittedLink.binding);
            expect(verifyExternalActionMachineRequestV1({
                authorizationToken: admittedLink.token, effectActionId: admittedLink.binding.actionId,
                target: admittedLink.binding.target, installationId: machine.installationId,
                requestId: admittedLink.binding.requestId, method: 'POST', path: verifyLinkPath, body,
                publicKey: installationKeys.publicKey, signature: String(request.headers[EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER]),
            })).toBe(true);
            return ExternalActionExecutionAuthorizationVerifyResponseV1Schema.parse({ ok: true });
        });
        app.post('/v1/actions/deployments.targets.link', async request => {
            const incoming = ExternalActionExecutionAuthorizationRequestV1Schema.parse(request.body);
            originalDispatches.push(incoming);
            if (incoming.envelope.v !== 1 || !incoming.executionAuthorization) throw new Error('Missing Home admission');
            const authorization = await projectExternalActionRequesterHttpAuthorization({
                authorization: incoming.executionAuthorization, serverId, serverIdentityId: homeId,
                serverHttpBaseUrl: endpoint, target: incoming.envelope.target, installationId: machine.installationId,
                privateKey: installationKeys.secretKey, rootAdmitted: true,
            });
            if (!authorization) throw new Error('Missing admitted HTTP projection');
            // Home delivery is a network boundary. Feed its admitted root into
            // the real receiving executor, so accidental re-Ask spends the real
            // immutable creation binding instead of a fabricated conflict reply.
            const execution = await daemon.execute('deployments.targets.link', incoming.envelope.input, {
                surface: 'cli', authority: 'present_user', serverId, serverIdentityId: homeId, runtimeAccountId: accountId,
                defaultSessionMachineId: machineId, actionRequestId: incoming.envelope.requestId,
                actionCaller: { kind: 'host' }, externalActionTarget: incoming.envelope.target,
                externalActionExecutionAuthorization: authorization,
                signExternalActionApprovalInput: ({ actionId, input: approvedInput, target, requesterConfirmation, sessionTargetsV1 }) =>
                    signExternalActionApprovalInputV1({ authorizationToken: authorization.token, actionId, input: approvedInput, target,
                        privateKey: installationKeys.secretKey, ...(requesterConfirmation ? { requesterConfirmation } : {}),
                        ...(sessionTargetsV1 ? { sessionTargetsV1 } : {}) }),
            });
            return { v: 1, actionId: 'deployments.targets.link', requestId: incoming.envelope.requestId, execution };
        });
        // HTTP and exact Machine RPC are replaced boundaries. Approval placement,
        // construction/CAS, registered replay and native content preparation stay real.
        const rpc = vi.spyOn(machineRpc, 'callExactMachineRpc').mockImplementation(async request => {
            expect(request.machineId).toBe(machineId);
            return await receiver.handleRequest({ method: `${machineId}:${request.method}`,
                params: request.request, callerAuthority: 'present_user' });
        });
        const caller = createCliActionExecutorFromCredentials({ credentials, readCredentials: async () => credentials,
            serverId, serverIdentityId: homeId, serverApiUrl: endpoint, actionsSettingsProvider: policy });
        try {
            const context = { surface: 'cli' as const, authority: 'present_user' as const, serverId, serverIdentityId: homeId,
                runtimeAccountId: accountId, defaultSessionMachineId: machineId, actionRequestId: 'public-provider-link',
                externalActionTarget: { kind: 'machine' as const, machineId } };
            const proposed = await caller.execute('deployments.targets.link', input, context);
            expect(proposed, JSON.stringify(proposed)).toMatchObject({ ok: true, result: { artifactId: expect.any(String) } });
            if (!proposed.ok || !proposed.result || typeof proposed.result !== 'object'
                || !('artifactId' in proposed.result) || typeof proposed.result.artifactId !== 'string') throw new Error('Missing approval');
            const artifactId = proposed.result.artifactId;
            const readRequest = () => {
                const body = decodePlainArtifactStoredContent(artifacts.read(artifactId)!.body);
                if (!body || typeof body !== 'object' || !('body' in body) || typeof body.body !== 'string') throw new Error('Missing approval body');
                return ApprovalRequestV2Schema.parse(JSON.parse(body.body));
            };
            expect(readRequest()).toMatchObject({ status: 'open', executionOriginV1: { target: { kind: 'machine', machineId } } });
            expect(associations).toEqual([]);
            // The proposal reaches its Machine once through Home; the replay never dispatches it again.
            expect(originalDispatches).toHaveLength(1);
            replaying = true;
            const result = await caller.execute('approval.request.decide', { artifactId, decision: 'approve' }, {
                surface: 'cli', authority: 'present_user', actionCaller: { kind: 'host' } });
            if (scenario !== 'ready' && !pages) {
                const step = scenario === 'content-publish-refused' ? 'content_publish' : scenario === 'association-refused' ? 'content_associate'
                    : scenario === 'validation-environment' ? 'environment_read'
                        : scenario === 'partial-inventory' || scenario === 'validation-inventory' ? 'provider_links_compare' : 'provider_links_read';
                const reason = scenario === 'content-publish-refused' ? 'dependency_failed, http_status=403' : scenario === 'association-refused' ? 'storage_refused'
                    : scenario === 'partial-inventory' ? 'content_unavailable'
                        : scenario === 'validation-inventory' || scenario === 'validation-environment' ? 'dependency_failed' : 'invalid_payload';
                const errorCode = scenario === 'content-publish-refused' ? 'action_forbidden'
                    : scenario === 'validation-inventory' || scenario === 'validation-environment' ? 'deployment_invalid'
                        // Malformed Home JSON projects through the deployment Zod owner (38cddb70537).
                        : scenario === 'invalid-inventory' ? 'invalid_action_output' : 'deployment_content_unavailable';
                const expectedError = scenario === 'validation-environment' ? errorCode
                    : `${errorCode}${scenario === 'content-publish-refused' ? ' (home_deployment_http_forbidden)' : ''} (target_link.${step}: ${reason})`;
                expect(result).toMatchObject({ ok: true, result: { status: 'failed', execution: { ok: false,
                    errorCode, error: expectedError } } });
                expect(JSON.stringify(result)).not.toMatch(/private-response-must-not-escape|private-provider-payload/);
                if (scenario === 'validation-inventory' || scenario === 'validation-environment') expect(result).toMatchObject({ result: { execution: {
                    details: { diagnostic: scenario === 'validation-inventory' ? inventoryDiagnostic : environmentDiagnostic },
                } } });
                expect(associations).toHaveLength(scenario === 'association-refused' ? 1 : 0);
                expect(artifactCreates).toHaveLength(scenario === 'association-refused' || scenario === 'content-publish-refused' ? 2 : 1);
                expect(originalDispatches).toHaveLength(1);
                expect(readRequest()).toMatchObject({ status: 'failed', execution: { ok: false,
                    errorCode, error: expectedError } });
                return;
            }
            expect(result, JSON.stringify({ result, http, originalDispatchCount: originalDispatches.length })).toMatchObject({ ok: true, result: { status: 'executed', execution: { ok: true } } });
            expect(rpc).toHaveBeenCalledOnce();
            expect(associations).toEqual([expect.objectContaining({ contentArtifactId: expect.any(String) })]);
            expect(associations[0]).not.toHaveProperty('provider');
            expect(artifactCreates).toHaveLength(2); // One approval and one provider-content Artifact, with no second Ask.
            expect(originalDispatches).toHaveLength(1);
            expect(readRequest().status).toBe('executed');
            expect(persistedLink).toMatchObject({ id: 'linked-runtime', environmentId: input.environmentId });
            expect(environment.environment).toMatchObject({ revision: input.expectedRevision + 1, runtimeTargetLinkId: 'linked-runtime' });
            // Both installed targets enroll the bundled receipt observer; its refused read leaves the Link persisted.
            expect(postPersistArtifactReads).toBe(1);
            if (pages) expect(http).toContain(`GET /v1/artifacts/${existingLink.contentArtifactId}`);
            expect(result).toMatchObject({ result: { execution: { result: {
                ok: true, targetLinkId: 'linked-runtime', failureObserver: { status: 'unavailable',
                    // The signed Home transport owns the typed 401 cause; the observer carries it unchanged.
                    failureCause: { phase: 'home.authorization.signed_request', httpStatus: 401 } },
            } } } });
        } finally { restore(); await app.close(); }
    });
});
