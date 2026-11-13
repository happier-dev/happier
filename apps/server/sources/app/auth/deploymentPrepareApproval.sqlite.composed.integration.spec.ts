import { randomUUID } from 'node:crypto';
import axios from 'axios';
import { rm } from 'node:fs/promises';
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import { createActionExecutor, type ActionExecutorContext } from '@happier-dev/protocol/actions/actionExecutor';
import { buildAccountStoredContentCompatibilityHttpHeadersV1, CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION } from '@happier-dev/protocol';
import { ApprovalRequestV2Schema, type ApprovalRequestV2 } from '@happier-dev/protocol/approvals/approvalRequestV1';
import { decideApprovalRequestTransition } from '@happier-dev/protocol/approvals/approvalRequestTransition';
import { DeploymentPrepareInputV1Schema } from '@happier-dev/protocol/deployments/deploymentPreparationV1';
import { SessionSpawnNewActionResultV1Schema } from '@happier-dev/protocol/sessions/creation/sessionSpawnNewResultV1';
import { computeExternalActionRequestEnvelopeDigestV1, signExternalActionApprovalInputV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { projectDeploymentPreparationAdmissionV1 } from '@happier-dev/protocol/actions/externalActionApi';
import { createDeploymentApprovalScopeResolverV1 } from '@happier-dev/protocol/deployments/deploymentApprovalScopeV1';
import { createDeploymentSocketHome } from '@/testkit/deploymentSocketHome.testkit.mjs';
import { createProjectSourceInTx, readProjectSourceInTx } from '@/app/projects/sources/projectSourceService';
import { auth } from './auth';
import { db } from '@/storage/db';
import { inTx } from '@/storage/inTx';
import { withConfiguredDaemonTestHome } from '../../../../cli/src/daemon/testkit/fakeDaemonLifecycle.testkit';
import { createPrepareDeployment } from '../../../../cli/src/workspaces/prepareDeployment';
import { createGitWorkspace, runGit } from '../../../../cli/src/scm/rpc/__tests__/testRpcHarness';
import { adoptServerProfileHomeConnectionDescriptor } from '../../../../cli/src/server/serverProfiles';
import { configuration } from '../../../../cli/src/configuration';
import { createRequesterCurrentnessSocketHarness } from '../../../../cli/src/testkit/backends/requesterCurrentnessSocketHarness';
import { admitRequesterAccountActionContext } from '../../../../cli/src/daemon/sessionEncryption/requesterAccountActionProjection';
import { resolveExternalActionServerRequestHeaders, projectExternalActionRequesterHttpAuthorization } from '../../../../cli/src/api/externalActionExecutionAuthorization';
import { readS0ControllerCredentials } from '../../../../cli/src/deployments/deploymentDaemonIngress.testkit';
import { resetInMemoryAccountSettingsContextForTests } from '../../../../cli/src/settings/accountSettings/bootstrapAccountSettingsContext';
import { createAdmittedPluginRuntimeFixture } from '../../../../cli/src/plugins/testkit/admittedRuntime';
import { pluginReloadController } from '../../../../cli/src/plugins/runtime/reload/singleton';

let runtime: Awaited<ReturnType<typeof createAdmittedPluginRuntimeFixture>>;
const serverId = `srv_${randomUUID().replaceAll('-', '')}`;
beforeAll(async () => {
    runtime = await createAdmittedPluginRuntimeFixture({ controller: pluginReloadController,
        runtimeOptions: { pluginIds: ['happier.scm.backend.git', 'happier.scm.forge.github', 'happier.agent.codex'] } });
});
afterAll(async () => { await runtime?.dispose(); await pluginReloadController.shutdown(); });

afterEach(() => { vi.restoreAllMocks(); resetInMemoryAccountSettingsContextForTests(); });

it.each([false, true])('approves host Prepare/Import and executes its reviewed spawn codec read (import=%s)', async importTool => {
    await withConfiguredDaemonTestHome({ prefix: 'prepare-approved-http-', env: {
        HAPPIER_FEATURE_DEPLOYMENTS__ENABLED: '1', HAPPIER_FEATURE_E2EE__KEYLESS_ACCOUNTS_ENABLED: 'true',
    } }, async () => {
        const home = await createDeploymentSocketHome({ serverId });
        const directory = createGitWorkspace('prepare-approved-repository-');
        let requester: Awaited<ReturnType<typeof admitRequesterAccountActionContext>> = null;
        let channel: Awaited<ReturnType<typeof createRequesterCurrentnessSocketHarness>> | undefined;
        try {
            runGit(directory, ['commit', '--allow-empty', '-m', 'Prepare base']);
            runGit(directory, ['remote', 'add', 'origin', 'https://github.com/example/prepare.git']);
            await adoptServerProfileHomeConnectionDescriptor({ expectedProfileId: configuration.activeServerId,
                createIfMissing: true, observation: 'exact', descriptor: { v: 1, homeServerIdentityId: home.serverId,
                    canonicalServerUrl: home.baseUrl, revision: 1, endpoints: [{ kind: 'https', url: home.baseUrl }] } });
            const created = await inTx(tx => createProjectSourceInTx(tx, home.accountId, { serverId: home.serverId,
                requestKey: randomUUID(), name: 'Reviewed Prepare', repository: {
                    provider: { id: 'github', kind: 'github', displayName: 'GitHub', baseUrl: 'https://github.com' },
                    repository: { nameWithOwner: 'example/prepare', cloneUrl: 'https://github.com/example/prepare.git' }, protocol: 'https' } }));
            if (!created.ok) throw new Error(created.error);
            const workspace = { id: randomUUID(), serverId: home.serverId, machineId: home.machineId,
                rootPath: directory, createdAtMs: 1, source: { sourceId: created.source.id, revision: created.source.revision },
                repositoryIdentity: { kind: 'github' as const, deployment: 'https://github.com', repository: 'example/prepare' } };
            const input = DeploymentPrepareInputV1Schema.parse({ projectSourceId: created.source.id,
                sourceRevision: created.source.revision, repository: workspace.repositoryIdentity,
                ...(importTool ? { importFrom: { tool: 'docker-compose', configurationPaths: ['compose.yaml'] } } : {}),
                baseCommit: runGit(directory, ['rev-parse', 'HEAD']),
                workspace: { kind: 'workspace-ref', serverId: home.serverId, id: workspace.id },
                sessionDraft: { executionTarget: { serverId: home.serverId, machineId: home.machineId },
                    directory: { kind: 'path', path: directory },
                    agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } } } });
            const target = { kind: 'machine' as const, machineId: home.machineId };
            const envelope = { v: 1 as const, requestId: randomUUID(), target, input };
            const account = await db.account.findUniqueOrThrow({ where: { id: home.accountId } });
            const root = await auth.mintExternalActionExecutionAuthorization({ accountId: home.accountId,
                serverIdentityId: home.serverId, authentication: { kind: 'account', tokenEpoch: account.tokenEpoch },
                actionId: 'deployments.prepare', machineId: home.machineId, target, requestId: envelope.requestId,
                admittedMachineRole: 'use', requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope),
                deploymentPreparationAdmission: projectDeploymentPreparationAdmissionV1('deployments.prepare', input) }, { input });
            const credentials = readS0ControllerCredentials(home);
            channel = await createRequesterCurrentnessSocketHarness();
            requester = await admitRequesterAccountActionContext({ authorization: root, credentials,
                invocation: { caller: { kind: 'host' }, surface: 'cli', authority: 'account_automation' },
                serverId: home.serverId, serverIdentityId: home.serverId, serverHttpBaseUrl: home.baseUrl,
                isCurrent: async () => true });
            if (!requester) throw new Error('Expected admitted Prepare requester');
            const authorization = await projectExternalActionRequesterHttpAuthorization({ authorization: requester.authorization,
                serverId: home.serverId, serverIdentityId: home.serverId, serverHttpBaseUrl: home.baseUrl, target,
                installationId: home.installationId, privateKey: home.keys.secretKey, rootAdmitted: true });
            if (!authorization) throw new Error('Expected original requester HTTP carrier');
            let stored: ApprovalRequestV2 | undefined;
            const reads: number[] = [];
            const executor = createActionExecutor({
                resolveEnvironmentApprovalScope: createDeploymentApprovalScopeResolverV1(async () => {
                    throw new Error('Repository-only Prepare has no Environment transport');
                }),
                // Persistence and native process launch are the substituted boundaries.
                // Approval policy/CAS/replay, Prepare, Git inspection, reviewed-child
                // production, signing and Home authorization all execute real owners.
                approvalsCreate: async ({ request }) => {
                    stored = ApprovalRequestV2Schema.parse(structuredClone(request));
                    return { artifactId: 'prepare-review' };
                },
                approvalsGet: async () => structuredClone(stored ?? null),
                approvalsUpdate: async ({ request, expectedStatus }) => {
                    if (!stored) throw new Error('Missing Prepare approval');
                    const next = ApprovalRequestV2Schema.parse(request);
                    const transition = decideApprovalRequestTransition(stored, next, { expectedStatus });
                    if (!transition.ok) return transition;
                    stored = structuredClone(next);
                    return { ok: true };
                },
                isApprovalExecutionOriginCurrent: async () => (await auth.verifyExternalActionExecutionAuthorization(root.token)) !== null,
                prepareApprovalExecutionAuthorization: async ({ authorization: replay }) => {
                    expect(replay.token).toBe(root.token);
                    return { authorization };
                },
                deploymentPrepare: createPrepareDeployment({ serverId: home.serverId, serverIdentityId: home.serverId,
                    serverHttpBaseUrl: home.baseUrl, machineId: home.machineId, credentials,
                    readWorkspaceRows: async () => ({ workspaceRefs: [workspace], relationships: [],
                        source: 'network', organizations: [], rows: [], graphRevision: 'absent', loadedAtMs: 1, scopeKey: 'prepare' }),
                    readSource: input => inTx(tx => readProjectSourceInTx(tx, home.accountId, input)) }),
                sessionSpawnNew: async args => {
                    expect(ApprovalRequestV2Schema.parse(stored).decision).toMatchObject({ kind: 'approve', authority: 'present_user' });
                    for (const path of [`/v1/machines/${randomUUID()}`, '/v1/account/profile']) {
                        const denied = resolveExternalActionServerRequestHeaders({ context: args.context, effectActionId: 'session.spawn_new',
                            method: 'GET', path, daemonToken: credentials.token, serverIdentityId: home.serverId,
                            installationId: home.installationId, privateKey: home.keys.secretKey });
                        if (!denied.ok) throw new Error('Expected signed negative control');
                        expect((await axios.get(`${home.baseUrl}${path}`, { headers: denied.headers, validateStatus: () => true })).status).toBe(401);
                    }
                    const path = `/v1/machines/${home.machineId}`;
                    const signed = resolveExternalActionServerRequestHeaders({ context: args.context, effectActionId: 'session.spawn_new',
                        method: 'GET', path, daemonToken: credentials.token, serverIdentityId: home.serverId,
                        installationId: home.installationId, privateKey: home.keys.secretKey });
                    if (!signed.ok) throw new Error('Expected reviewed child HTTP headers');
                    const response = await axios.get(`${home.baseUrl}${path}`, { headers: { ...signed.headers,
                        ...buildAccountStoredContentCompatibilityHttpHeadersV1(CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION) },
                        validateStatus: () => true });
                    reads.push(response.status);
                    expect(response.status).toBe(200);
                    // No Agent process is launched by this authorization test.
                    return SessionSpawnNewActionResultV1Schema.parse({ type: 'error', code: 'spawn_failed', retryable: false });
                },
            });
            const context: ActionExecutorContext = { surface: 'cli', authority: 'account_automation', actionCaller: { kind: 'host' },
                runtimeAccountId: home.accountId, serverId: home.serverId, serverIdentityId: home.serverId,
                defaultSessionMachineId: home.machineId, actionRequestId: envelope.requestId,
                externalActionExecutionAuthorization: authorization, externalActionTarget: target, originalActionEnvelope: envelope,
                signExternalActionApprovalInput: request => signExternalActionApprovalInputV1({ actionId: request.actionId,
                    input: request.input, target: request.target, authorizationToken: request.authorization.token,
                    privateKey: home.keys.secretKey }) };
            const pending = await executor.execute('deployments.prepare', input, context);
            expect(pending, JSON.stringify(pending)).toMatchObject({ ok: true, result: { kind: 'approval_request_created' } });
            expect(reads).toEqual([]);
            const decision = await executor.execute('approval.request.decide', { artifactId: 'prepare-review', decision: 'approve' },
                { ...context, authority: 'present_user', surface: 'ui', actionRequestId: randomUUID() });
            expect(reads, JSON.stringify(decision)).toEqual([200]);
            expect(ApprovalRequestV2Schema.parse(stored).execution).toMatchObject({ ok: false, errorCode: 'spawn_failed' });
        } finally {
            await requester?.dispose(); await channel?.close();
            await rm(directory, { recursive: true, force: true }); await home.close();
        }
    });
});
