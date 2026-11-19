import fastify from 'fastify';
import { afterEach, expect, it, vi } from 'vitest';
import { ApprovalRequestV2Schema, encodePlainArtifactStoredContent, SocketRpcMachineAdmissionContextV1Schema } from '@happier-dev/protocol';
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
import { registerApprovalRpcHandlers } from '@/rpc/handlers/approvals';
import type { RpcHandler } from '@/api/rpc/types';
import * as machineRpc from '@/session/transport/rpc/machineRpc';
import { installAxiosFastifyAdapter } from '@/testkit/http/axiosAdapter';
import { createCliActionExecutorFromCredentials } from '../createCliActionExecutorFromCredentials';
import { createCliActionExecutorHarness } from '../createCliActionExecutorHarness';
import { registerAccountHomeHttp, registerPlainArtifactRoutes } from '../widgetApproval.testkit';

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
            const input = { serverId: homeId, environmentId: 'environment', targetLinkId: 'runtime', requestKey: 'reviewed-domain',
                    domainId: 'domain', expectedRevision: 3, expectedTargetLinkRevision: 2,
                    contentArtifactId: 'domain-content', contentHeaderVersion: 1, contentBodyVersion: 1 };
            const request = ApprovalRequestV2Schema.parse({ v: 2, status: 'open', createdAtMs: 1, updatedAtMs: 1,
                createdBy: { surface: 'system' }, requestedSurface: 'cli', actionId, actionArgs: input,
                summary: 'Reviewed Domain change', approval: { flow: 'deferred', result: 'required' },
                executionOriginV1: { v: 1, authority: 'account_automation', surface: 'cli', caller: { kind: 'host' },
                    serverId, serverIdentityId: homeId, accountId, machineId, target: { kind: 'machine', machineId },
                    actionId, requestId: 'original-domain-request' } });
            artifacts.seed('approval', encodePlainArtifactStoredContent(buildApprovalRequestArtifactHeaderV1(request)),
                encodePlainArtifactStoredContent({ body: JSON.stringify(request) }));
            const machine = { id: machineId, kind: 'persistent', active: true, installationId: 'installation',
                revokedAt: null, replacedByMachineId: null,
                access: { custodian: { accountId, displayName: 'Owner' }, role: 'manage', resourceMode: 'plain', accessState: 'ready' } };
            app.get('/v1/machines', async () => [machine]);
            app.get(`/v1/machines/${machineId}`, async () => ({ machine }));
            const environment = createDeploymentEnvironmentDetailV1();
            environment.environment.id = input.environmentId;
            environment.environment.serverId = homeId;
            environment.environment.owner = { kind: 'account', accountId };
            environment.environment.controllerMachineId = machineId;
            app.get('/v1/deployments/environments/environment', async () => ({ ok: true,
                environment: environment.environment, targetLinks: environment.targetLinks.map(item => item.targetLink) }));
            const writes: unknown[] = [];
            app.post('/v1/deployments/environments/environment/domains', async httpRequest => {
                writes.push(httpRequest.body);
                // Home refusal is deliberately terminal: reaching it proves operation
                // admission preceded storage without performing a native effect.
                return { ok: false, error: 'deployment_conflict' };
            });
            const runtime = createHostActionOperationRuntime({ serverId: homeId, machineId, resolveAccountId: async () => accountId });
            const { executor: daemon, deps } = createCliActionExecutorHarness({ credentials, token: credentials.token,
                sessionId: 'cli-global', mode: 'plain', ctx: null, serverId, serverIdentityId: homeId,
                serverHttpBaseUrl: endpoint, actionsSettingsProvider: policy }, {
                ...(operationAvailable ? { runActionOperation: runtime.runActionOperation } : {}),
                isApprovalExecutionOriginCurrent: createDaemonApprovalExecutionOriginCurrentnessFromCredentials({
                    credentials, machineId, serverId, serverApiUrl: endpoint }),
            });
            const handlers = new Map<string, RpcHandler>();
            registerApprovalRpcHandlers({ rpcHandlerManager: { registerHandler: (method, handler) => handlers.set(method, handler) }, actionExecutor: daemon });
            // HTTP and exact Machine RPC are external boundaries. The public
            // decision, placement, replay, operation and storage owners stay real.
            vi.spyOn(machineRpc, 'callExactMachineRpc').mockImplementation(async rpcRequest => {
                expect(rpcRequest.machineId).toBe(machineId);
                const handler = handlers.get(rpcRequest.method);
                if (!handler) throw new Error(`Unexpected RPC ${rpcRequest.method}`);
                return await handler(rpcRequest.request, { signal: new AbortController().signal, callerAuthority: 'present_user',
                    machineAdmission: SocketRpcMachineAdmissionContextV1Schema.parse({ actorAccountId: accountId, custodianAccountId: accountId,
                        machineId, installationId: machine.installationId, role: 'manage', encryptionMode: 'plain' }),
                    verifyMachineAdmissionCurrent: async () => true });
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
                    // Approval history retains safe prose but excludes arbitrary
                    // details. The owning live result also carries the typed failureCause.
                    expect(await deps.deploymentAction!(actionId, input, { surface: 'cli', authority: 'present_user',
                        serverId, serverIdentityId: homeId, runtimeAccountId: accountId,
                        actionRequestId: 'original-domain-request', actionCaller: { kind: 'host' } })).toMatchObject({
                        ok: false, errorCode: 'operation_unavailable', details: { requiredFact: 'operationAcceptance' },
                        failureCause: { phase: 'deployment.domain.operation_acceptance_missing', errorClass: 'Error',
                            errorCode: null, httpStatus: null },
                    });
                    expect(writes).toEqual([]);
                    return;
                }
                expect(result, JSON.stringify(result)).toMatchObject({ ok: true, result: { status: 'failed', execution: {
                    ok: false, errorCode: 'deployment_conflict' } } });
                expect(writes).toEqual([expect.objectContaining({ ...input, requestId: 'original-domain-request', actionOperationId: expect.any(String) })]);
            } finally { restore(); await app.close(); }
        });
    });
