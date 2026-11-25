import fastify from 'fastify';
import { afterEach, expect, it, vi } from 'vitest';
import { readOrCreateInstallationIdentity } from '@/daemon/identity/store';
import { decodeBase64 } from '@happier-dev/protocol/crypto/base64';
import { ApprovalRequestV2Schema, encodePlainArtifactStoredContent } from '@happier-dev/protocol';
import { ExternalActionExecutionAuthorizationV1Schema, projectDeploymentNativeAdmissionV1 } from '@happier-dev/protocol/actions/externalActionApi';
import { computeExternalActionRequestEnvelopeDigestV1, signExternalActionApprovalInputV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { DEPLOYMENT_DOMAIN_ARTIFACT_KIND_V1, DEPLOYMENT_ENVIRONMENT_ARTIFACT_KIND_V1,
    DEPLOYMENT_TARGET_LINK_ARTIFACT_KIND_V1 } from '@happier-dev/protocol/artifacts/deploymentArtifactKindsV1';
import { DeploymentDomainMachineTopologyV1Schema } from '@happier-dev/protocol/deployments/deploymentDomainV1';
import { DeploymentChildRpcV1Schema } from '@happier-dev/protocol/deployments/deploymentChildRpcV1';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { normalizeActionsSettingsV1 } from '@happier-dev/protocol/actions/actionSettings';
import { buildApprovalRequestArtifactHeaderV1 } from '@happier-dev/protocol/approvals/approvalArtifactHeaderV1';
import { resolveApprovalExecutor } from '@happier-dev/protocol/approvals/resolveApprovalExecutor';
import { projectApprovalRequestForPublicRead } from '@happier-dev/protocol/actions/actionApprovalPresentation';
import { createDeploymentEnvironmentDetailV1 } from '@happier-dev/deployments/testing/v1';
import { configuration } from '@/configuration';
import { updateSettings } from '@/persistence';
import { withConfiguredDaemonTestHome } from '@/daemon/testkit/fakeDaemonLifecycle.testkit';
import { createDaemonApprovalExecutionOriginCurrentnessFromCredentials } from '@/daemon/externalActions/daemonExternalActionTargetResolver';
import { createHostActionOperationRuntime } from '@/daemon/actionOperations/createHostActionOperationRuntime';
import { createDaemonDeploymentActionDeps } from '@/deployments/createDaemonDeploymentActionDeps';
import * as machineRpc from '@/session/transport/rpc/machineRpc';
import { installAxiosFastifyAdapter } from '@/testkit/http/axiosAdapter';
import { createCliActionExecutorFromCredentials } from '../createCliActionExecutorFromCredentials';
import { createCliActionExecutorHarness } from '../createCliActionExecutorHarness';
import { createMachineApprovalReplayPreparer, registerAccountHomeHttp, registerPlainArtifactRoutes,
    registerMachineApprovalDecisionHomeHttp } from '../widgetApproval.testkit';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it.each(['deployments.domains.add', 'deployments.domains.remove', 'deployments.domains.verify'] as const)(
    'retains the reviewed controller for %s in private and public approval placement', actionId => {
        const input = actionId === 'deployments.domains.add'
            ? { serverId: 'home', environmentId: 'environment', domainId: 'domain', expectedRevision: 3,
                requestKey: 'reviewed-domain', targetLinkId: 'runtime', expectedTargetLinkRevision: 2,
                contentArtifactId: 'content', contentHeaderVersion: 1, contentBodyVersion: 1 }
            : { serverId: 'home', environmentId: 'environment', domainId: 'domain', expectedRevision: 3,
                expectedDomainRevision: 1, requestKey: 'reviewed-domain' };
        const request = ApprovalRequestV2Schema.parse({ v: 2, status: 'open', createdAtMs: 1, updatedAtMs: 1,
            createdBy: { surface: 'system' }, actionId, actionArgs: input, summary: 'Reviewed Domain change',
            approval: { flow: 'deferred', result: 'required' }, executionOriginV1: {
                v: 1, authority: 'account_automation', surface: 'cli', caller: { kind: 'host' },
                serverId: 'home', accountId: 'owner', machineId: 'controller',
                target: { kind: 'machine', machineId: 'controller' }, actionId, requestId: 'original-request',
            } });
        expect(resolveApprovalExecutor(request)).toEqual({ kind: 'daemon', machineId: 'controller' });
        expect(resolveApprovalExecutor(ApprovalRequestV2Schema.parse(projectApprovalRequestForPublicRead(request))))
            .toEqual({ kind: 'daemon', machineId: 'controller' });
    });

it.each([true, false])('replays Domain add with controller operation available=%s', async operationAvailable => {
        const actionId = 'deployments.domains.add';
        await withConfiguredDaemonTestHome({ prefix: 'happier-domain-approval-', env: {
            HAPPIER_SERVER_URL: 'https://domain-approval.test', HAPPIER_WEBAPP_URL: 'https://domain-approval.test',
            HAPPIER_TOKEN: undefined, HAPPIER_SESSION_REQUESTER_CREDENTIAL_FILE: undefined,
        } }, async () => {
            const app = fastify();
            const endpoint = 'https://domain-approval.test';
            const restore = installAxiosFastifyAdapter({ app, origin: endpoint });
            const serverId = configuration.activeServerId;
            const homeId = 'srv_domain_approval';
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
            const actions = normalizeActionsSettingsV1({ v: 1, actions: {} });
            const policy = { getActionsSettings: () => actions, getAccountSettings: () => ({}) };
            const features = registerAccountHomeHttp(app, { accountId, serverId: homeId, settings: { actionsSettingsV1: actions } });
            const artifacts = registerPlainArtifactRoutes(app, accountId);
            vi.stubGlobal('fetch', async () => Response.json(features));
            const installation = await readOrCreateInstallationIdentity();
            const privateKey = decodeBase64(installation.privateKey, 'base64url');
            const environment = createDeploymentEnvironmentDetailV1();
            environment.environment.serverId = homeId;
            environment.environment.owner = { kind: 'account', accountId };
            environment.environment.controllerMachineId = machineId;
            delete environment.content.ingress;
            const runtimeLink = environment.targetLinks[0]!.targetLink;
            runtimeLink.machines = [machineId];
            runtimeLink.members = [{ machineId, installationId: installation.installationId, state: 'active' }];
            const input = { serverId: homeId, environmentId: environment.environment.id, targetLinkId: runtimeLink.id,
                requestKey: 'reviewed-domain', domainId: 'domain', expectedRevision: environment.environment.revision,
                expectedTargetLinkRevision: runtimeLink.revision, contentArtifactId: 'domain-content', contentHeaderVersion: 1, contentBodyVersion: 1 };
            const target = { kind: 'machine' as const, machineId };
            const envelope = { v: 1 as const, requestId: 'original-domain-request', target, input };
            const authorization = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'retained-domain-root', binding: {
                serverIdentityId: homeId, accountId, authentication: { kind: 'account', tokenEpoch: 1 }, custodianAccountId: accountId,
                admittedMachineRole: 'manage', machineId, installationId: installation.installationId, actionId, environmentId: input.environmentId,
                requestId: envelope.requestId, accountEncryptionMode: 'plain', target,
                requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope), deploymentChildRoot: true,
                deploymentNativeAdmission: projectDeploymentNativeAdmissionV1(actionId, input),
            } });
            const request = ApprovalRequestV2Schema.parse({ v: 2, status: 'open', createdAtMs: 1, updatedAtMs: 1,
                createdBy: { surface: 'system' }, requestedSurface: 'cli', actionId, actionArgs: input,
                summary: 'Reviewed Domain change', approval: { flow: 'deferred', result: 'required' },
                executionOriginV1: { v: 1, authority: 'account_automation', surface: 'cli', caller: { kind: 'host' },
                    serverId, serverIdentityId: homeId, accountId, machineId, target, actionId, requestId: envelope.requestId,
                    originalActionEnvelope: envelope, externalActionExecutionAuthorization: authorization,
                    externalActionInputSignature: signExternalActionApprovalInputV1({ authorizationToken: authorization.token,
                        actionId, input, target, privateKey }),
                } });
            artifacts.seed('approval', encodePlainArtifactStoredContent(buildApprovalRequestArtifactHeaderV1(request)),
                encodePlainArtifactStoredContent({ body: JSON.stringify(request) }));
            const machine = { id: machineId, kind: 'persistent', active: true, installationId: installation.installationId,
                installationPublicKey: Buffer.from(decodeBase64(installation.publicKey, 'base64url')).toString('base64'),
                revokedAt: null, replacedByMachineId: null,
                access: { custodian: { accountId, displayName: 'Owner' }, role: 'manage', resourceMode: 'plain', accessState: 'ready' } };
            app.get('/v1/machines', async () => [machine]);
            app.get(`/v1/machines/${machineId}`, async () => ({ machine }));
            for (const [id, kind, content] of [
                [environment.environment.contentArtifactId, DEPLOYMENT_ENVIRONMENT_ARTIFACT_KIND_V1, environment.content],
                [runtimeLink.contentArtifactId, DEPLOYMENT_TARGET_LINK_ARTIFACT_KIND_V1, environment.targetLinks[0]!.content],
                [input.contentArtifactId, DEPLOYMENT_DOMAIN_ARTIFACT_KIND_V1, { hostname: 'app.example.test', target: { service: 'web', containerPort: 8080 } }],
            ] as const) artifacts.seed(id, encodePlainArtifactStoredContent({ kind, title: 'Domain' }),
                encodePlainArtifactStoredContent({ body: JSON.stringify(content) }));
            app.get(`/v1/deployments/environments/${input.environmentId}`, async () => ({ ok: true,
                environment: environment.environment, targetLinks: environment.targetLinks.map(item => item.targetLink) }));
            const writes: unknown[] = [];
            app.post(`/v1/deployments/environments/${input.environmentId}/domains`, async httpRequest => {
                writes.push(httpRequest.body);
                // Home refusal is deliberately terminal: reaching it proves operation
                // admission preceded storage without performing a native effect.
                return { ok: false, error: 'deployment_conflict' };
            });
            const runtime = createHostActionOperationRuntime({ serverId: homeId, machineId, resolveAccountId: async () => accountId });
            const native = createDaemonDeploymentActionDeps({ credentials, serverId: homeId, serverHttpBaseUrl: endpoint, machineId,
                resolveRequesterIdentity: async () => ({ kind: 'unknown', reason: 'requester_authority_unavailable' }),
                runtime: { async acquire() { throw new Error('Domain Add cannot deploy an application'); } },
            });
            let receiving: ReturnType<typeof createCliActionExecutorHarness>['executor'];
            const prepareApprovalExecutionAuthorization = createMachineApprovalReplayPreparer({ credentials,
                machineId, serverId, serverIdentityId: homeId, serverHttpBaseUrl: endpoint, installation, executor: () => receiving });
            const { executor: daemon } = createCliActionExecutorHarness({ credentials, token: credentials.token,
                sessionId: 'cli-global', mode: 'plain', ctx: null, serverId, serverIdentityId: homeId,
                serverHttpBaseUrl: endpoint, actionsSettingsProvider: policy, externalActionMachineInstallationId: installation.installationId,
                externalActionMachineRequestPrivateKey: privateKey }, {
                ...(operationAvailable ? { runActionOperation: runtime.runActionOperation } : {}),
                deploymentAction: native.deploymentAction, prepareApprovalExecutionAuthorization,
                isApprovalExecutionOriginCurrent: createDaemonApprovalExecutionOriginCurrentnessFromCredentials({
                    credentials, machineId, serverId, serverApiUrl: endpoint }),
            });
            receiving = daemon;
            const receiver = await registerMachineApprovalDecisionHomeHttp(app, { credentials, accountId, machineId,
                serverId, serverIdentityId: homeId, serverHttpBaseUrl: endpoint, installation, executor: daemon, retainedAction: authorization });
            // HTTP and exact Machine RPC are external boundaries. The public
            // decision, placement, replay, operation and storage owners stay real.
            vi.spyOn(machineRpc, 'callExactMachineRpc').mockImplementation(async rpcRequest => {
                expect(rpcRequest.machineId).toBe(machineId);
                if (rpcRequest.method === RPC_METHODS.DAEMON_DEPLOYMENT_CHILD) {
                    const child = DeploymentChildRpcV1Schema.parse(rpcRequest.request);
                    expect(child.kind).toBe('domainDiscover');
                    return DeploymentDomainMachineTopologyV1Schema.parse({ machineId, installationId: installation.installationId,
                        dockerEngineId: 'fixture-docker', privateNetworks: [], replicas: [], caddy: { status: 'ready', containerId: 'caddy',
                            containerName: 'caddy', adminSocketPath: '/run/caddy/admin.sock', networkNames: [], servers: [
                                { serverId: 'private', listen: [':8080'], tls: false, automaticHttpsDisabled: true, endpoints: [] },
                                { serverId: 'public', listen: [':443'], tls: true, automaticHttpsDisabled: false,
                                    endpoints: [{ hostAddress: '0.0.0.0', hostPort: 443, containerPort: 443 }] },
                            ] } });
                }
                return await receiver.handleRequest({ method: `${machineId}:${rpcRequest.method}`,
                    params: rpcRequest.request, callerAuthority: 'present_user' });
            });
            const caller = createCliActionExecutorFromCredentials({ credentials, readCredentials: async () => credentials,
                serverId, serverIdentityId: homeId, serverApiUrl: endpoint, actionsSettingsProvider: policy });
            try {
                const result = await caller.execute('approval.request.decide', { artifactId: 'approval', decision: 'approve' }, {
                    surface: 'cli', authority: 'present_user', runtimeAccountId: accountId, serverId, serverIdentityId: homeId,
                    actionCaller: { kind: 'host' } });
                if (!operationAvailable) {
                    expect(result, JSON.stringify(result)).toMatchObject({ ok: true, result: { status: 'failed', execution: {
                        ok: false, errorCode: 'operation_unavailable',
                        error: 'operation_unavailable (deployment.domain.operation_acceptance_missing)',
                    } } });
                    expect(writes).toEqual([]);
                    return;
                }
                expect(result, JSON.stringify(result)).toMatchObject({ ok: true, result: { status: 'failed', execution: {
                    ok: false, errorCode: 'deployment_conflict' } } });
                expect(writes).toEqual([expect.objectContaining({ ...input, requestId: 'original-domain-request', actionOperationId: expect.any(String) })]);
            } finally { restore(); await app.close(); }
        });
    });
