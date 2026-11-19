import { createHash, randomUUID } from 'node:crypto';
import type { SignKeyPair } from 'tweetnacl';
import { afterEach, expect, it, vi } from 'vitest';
import type { ActionExecutorContext } from '@happier-dev/protocol';
import { DeploymentEnvironmentCreateResultV1Schema } from '@happier-dev/protocol';
import { DeploymentEnvironmentContentV1Schema } from '@happier-dev/deployments/contracts/v1';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { normalizeActionsSettingsV1 } from '@happier-dev/protocol/actions/actionSettings';
import { ActionApprovalRequestCreatedResultSchema } from '@happier-dev/protocol/actions/actionExecutionResult';
import { signExternalActionApprovalInputV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { WorkflowDefinitionV1Schema } from '@happier-dev/protocol/workflows/workflowV1';
import { createCliActionDeps } from '../../../../apps/cli/src/session/actions/createCliActionDeps';
import { createAutomationDefinition, getAutomationDefinition } from '../../../../apps/cli/src/api/automations';
import { runWithServerHttpBaseUrl } from '../../../../apps/cli/src/api/client/serverHttpBaseUrl';
import { fetchServerFeaturesSnapshot } from '../../../../apps/cli/src/features/serverFeaturesClient';
import { prepareExternalActionRequesterAccountAuthorizationWithEnvelope, verifyExternalActionExecutionAuthorizationCurrent }
    from '../../../../apps/cli/src/api/externalActionExecutionAuthorization';
import { prepareRequesterAccountActionContext } from '../../../../apps/cli/src/daemon/sessionEncryption/requesterAccountActionProjection';
import { createDaemonApprovalExecutionOriginCurrentness, createDaemonExternalActionTargetResolver }
    from '../../../../apps/cli/src/daemon/externalActions/daemonExternalActionTargetResolver';
import * as installationStore from '../../../../apps/cli/src/daemon/identity/store';

// Socket delivery and the installation key file are the OS/network boundaries;
// requester admission, approval, Automation transport and persistence stay real.
vi.mock('socket.io-client', async original => {
    const actual = await original<typeof import('socket.io-client')>();
    const { createApiSessionSocketStub } = await import('../../../../apps/cli/src/testkit/backends/apiSessionSocketHarness');
    return { ...actual, io: () => createApiSessionSocketStub() };
});

const serverTestkitPath = '../../../../apps/server/sources/testkit/workflowApprovedOperationServer.testkit';
type ServerBoundary = Readonly<{
    token: string; tokenEpoch: number; accountId: string; homeId: string; baseUrl: string;
    machines: readonly Readonly<{ id: string; installationId: string; keys: SignKeyPair }>[];
    createDeploymentProjectSource(): Promise<{ projectSourceId: string }>;
    demoteDeploymentCaller(): Promise<void>;
    createForeignAccount(): Promise<{ accountId: string; token: string }>;
    createDeploymentArtifact(input: Readonly<{ header: Readonly<Record<string, unknown>>; body: string }>): Promise<{
        contentArtifactId: string; contentHeaderVersion: number; contentBodyVersion: number;
    }>;
    close(): Promise<void>;
    readRequestCosts(): Array<{ method: string; route: string; status: number | null }>;
}>;
let server: ServerBoundary | undefined;
afterEach(async () => {
    await server?.close();
    server = undefined;
    vi.restoreAllMocks();
});

it('lets the owning Account pause and remove triggers after Environment deletion and loss of Source manage, refusing other Accounts', async () => {
    const { startWorkflowApprovedOperationServer } = await import(serverTestkitPath) as {
        startWorkflowApprovedOperationServer(input: { workflowSessions: true; deploymentTeamOwned: true }): Promise<ServerBoundary>;
    };
    server = await startWorkflowApprovedOperationServer({ workflowSessions: true, deploymentTeamOwned: true });
    const home = server;
    await runWithServerHttpBaseUrl(home.baseUrl, async () => {
        const credentials = { token: home.token, encryption: null };
        const cli = createCliActionDeps({ token: home.token, credentials,
            sessionId: '', mode: 'plain', ctx: null, serverId: home.homeId, serverIdentityId: home.homeId,
            serverHttpBaseUrl: home.baseUrl,
            resolveServerFeaturesSnapshot: () => fetchServerFeaturesSnapshot({ serverUrl: home.baseUrl, token: home.token }),
        });
        let executor = createActionExecutor(cli);
        const project = await home.createDeploymentProjectSource();
        const document = 'services: {}';
        const content = DeploymentEnvironmentContentV1Schema.parse({ name: 'Removal regression', retainPreviousDeployments: 1,
            definition: { kind: 'stored', document, contentRevision: 1,
                composeDigest: `sha256:${createHash('sha256').update(document).digest('hex')}`, profiles: [], services: [] },
            bindings: [], ownServer: { rollout: 'recreate', autoRestorePreviousRelease: true } });
        const artifact = await home.createDeploymentArtifact({ header: { kind: 'deployment-environment.v1', title: content.name },
            body: JSON.stringify(content) });
        const headers = { Authorization: `Bearer ${home.token}`, 'Content-Type': 'application/json' };
        const createdResponse = await fetch(`${home.baseUrl}/v1/deployments/environments`, { method: 'POST', headers,
            body: JSON.stringify({ serverId: home.homeId, projectSourceId: project.projectSourceId, requestKey: randomUUID(),
                protection: 'nonProduction', purpose: 'standard', deployerMode: 'managers', controllerMachineId: home.machines[0]!.id,
                ...artifact }) });
        expect(createdResponse.status).toBe(200);
        const environment = DeploymentEnvironmentCreateResultV1Schema.parse(await createdResponse.json());
        if (!environment.ok) throw new Error(environment.error);
        const automationId = randomUUID();
        const childIds = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
        await createAutomationDefinition({ token: home.token, input: {
            automationId, name: 'Trigger removal regression', enabled: true,
            assignments: [{ machineId: home.machines[0]!.id, enabled: true }],
            executionRecipe: { v: 2, templateVersion: 1, triggerEvidence: null, managedTarget: null,
                deploymentEnvironment: { serverId: home.homeId, projectSourceId: project.projectSourceId, environmentId: environment.environmentId },
                workflow: { t: 'plain', v: { workspace: { directory: '/tmp' }, executionTarget: { kind: 'session' },
                    inlineDefinition: WorkflowDefinitionV1Schema.parse({ version: 1,
                        blocks: [{ kind: 'wait', id: 'wait', document: { text: 'Wait', references: [], attachments: [] } }] }) } } },
            triggers: childIds.map(triggerId => ({ triggerId, trigger: { kind: 'schedule', enabled: true,
                schedule: { kind: 'interval', scheduleExpr: null, everyMs: 60_000, timezone: null } } })),
        } });
        const context = { surface: 'cli' as const, authority: 'present_user' as const,
            actionCaller: { kind: 'host' as const }, runtimeAccountId: home.accountId,
            serverId: home.homeId, serverIdentityId: home.homeId,
            actionsSettings: normalizeActionsSettingsV1({ v: 1, actions: {},
                approvalWaivedSurfaces: { 'workflow.trigger.remove': ['cli'], 'workflow.trigger.update': ['cli'] } }) };
        const child = await executor.execute('workflow.trigger.remove', { automationId, triggerId: childIds[0] }, context);
        expect(child, JSON.stringify(child)).toMatchObject({ ok: true });
        expect((await getAutomationDefinition({ token: home.token, automationId }))?.triggers.map(item => item.id).sort()).toEqual(childIds.slice(1).sort());
        const deletedEnvironment = await fetch(`${home.baseUrl}/v1/deployments/environments/${environment.environmentId}/delete`, {
            method: 'POST', headers, body: JSON.stringify({ serverId: home.homeId, environmentId: environment.environmentId,
                expectedRevision: environment.revision, requestKey: randomUUID() }),
        });
        expect(await deletedEnvironment.json()).toMatchObject({ ok: true });
        await home.demoteDeploymentCaller();
        const sourceAfterDemotion = await fetch(`${home.baseUrl}/v1/projects/sources/${project.projectSourceId}?serverId=${home.homeId}`, { headers });
        expect(sourceAfterDemotion.status).toBe(200);
        expect(await sourceAfterDemotion.json()).toMatchObject({ ok: true, canManage: false });
        const beforeCleanup = (await getAutomationDefinition({ token: home.token, automationId }))!;
        const foreign = await home.createForeignAccount();
        const foreignHeaders = { Authorization: `Bearer ${foreign.token}`, 'Content-Type': 'application/json' };
        const refusedChildPause = await fetch(`${home.baseUrl}/v3/automations/${automationId}/triggers`, { method: 'PATCH', headers: foreignHeaders,
            body: JSON.stringify({ triggerId: childIds[3], expectedRevision: beforeCleanup.triggers.find(item => item.id === childIds[3])!.revision,
                enabled: false }) });
        expect(refusedChildPause.status).toBe(404);
        const refusedSetPause = await fetch(`${home.baseUrl}/v3/automations/${automationId}`, { method: 'PATCH', headers: foreignHeaders,
            body: JSON.stringify({ expectedTemplateVersion: beforeCleanup.templateVersion, enabled: false }) });
        expect(refusedSetPause.status).toBe(404);
        const refusedChild = await fetch(`${home.baseUrl}/v3/automations/${automationId}/triggers`, { method: 'DELETE', headers: foreignHeaders,
            body: JSON.stringify({ triggerId: childIds[3], expectedRevision: beforeCleanup.triggers.find(item => item.id === childIds[3])!.revision }) });
        expect(refusedChild.status).toBe(404);
        const refusedSet = await fetch(`${home.baseUrl}/v3/automations/${automationId}`, { method: 'DELETE',
            headers: { Authorization: `Bearer ${foreign.token}` } });
        expect(refusedSet.status).toBe(404);
        expect((await getAutomationDefinition({ token: home.token, automationId }))?.triggers).toEqual(beforeCleanup.triggers);
        const mixedEdit = await fetch(`${home.baseUrl}/v3/automations/${automationId}`, { method: 'PUT', headers,
            body: JSON.stringify({ expectedTemplateVersion: beforeCleanup.templateVersion,
                name: 'Cannot edit during cleanup', description: beforeCleanup.description, enabled: beforeCleanup.enabled,
                assignments: beforeCleanup.assignments.map(({ machineId, enabled, priority }) => ({ machineId, enabled, priority })),
                triggers: beforeCleanup.triggers.filter(item => item.id !== childIds[3]).map(item => ({
                    kind: 'existing', triggerId: item.id, expectedRevision: item.revision })),
                removedTriggers: [{ triggerId: childIds[3], expectedRevision: beforeCleanup.triggers.find(item => item.id === childIds[3])!.revision }] }),
        });
        expect(mixedEdit.status).toBe(400);
        const directPause = await fetch(`${home.baseUrl}/v3/automations/${automationId}/triggers`, { method: 'PATCH', headers,
            body: JSON.stringify({ triggerId: childIds[3], expectedRevision: beforeCleanup.triggers.find(item => item.id === childIds[3])!.revision,
                enabled: false }) });
        expect(directPause.status).toBe(200);
        const afterDirectPause = (await getAutomationDefinition({ token: home.token, automationId }))!;
        expect(afterDirectPause.triggers.find(item => item.id === childIds[3])?.enabled).toBe(false);
        const pausedChild = await executor.execute('workflow.trigger.update', { automationId, triggerId: childIds[2],
            expectedRevision: afterDirectPause.templateVersion, patch: { enabled: false } }, context);
        expect(pausedChild, JSON.stringify(pausedChild)).toMatchObject({ ok: true });
        const afterChildPause = (await getAutomationDefinition({ token: home.token, automationId }))!;
        expect(afterChildPause.triggers.find(item => item.id === childIds[2])?.enabled).toBe(false);
        expect(afterChildPause.assignments).toEqual(beforeCleanup.assignments);
        const refusedChildEnable = await fetch(`${home.baseUrl}/v3/automations/${automationId}/triggers`, { method: 'PATCH', headers,
            body: JSON.stringify({ triggerId: childIds[2], expectedRevision: afterChildPause.triggers.find(item => item.id === childIds[2])!.revision,
                enabled: true }) });
        expect(refusedChildEnable.status).toBe(400);
        const directChild = await fetch(`${home.baseUrl}/v3/automations/${automationId}/triggers`, { method: 'DELETE', headers,
            body: JSON.stringify({ triggerId: childIds[3], expectedRevision: afterChildPause.triggers.find(item => item.id === childIds[3])!.revision }) });
        expect(directChild.status).toBe(200);
        const deletedEnvironmentChild = await executor.execute('workflow.trigger.remove', { automationId, triggerId: childIds[1] }, context);
        expect(deletedEnvironmentChild, JSON.stringify(deletedEnvironmentChild)).toMatchObject({ ok: true });
        expect((await getAutomationDefinition({ token: home.token, automationId }))?.triggers.map(item => item.id)).toEqual([childIds[2]]);
        // Deletion is cleanup; authoring still requires a live Environment,
        // and another Account still cannot remove the retained definition.
        const retained = await getAutomationDefinition({ token: home.token, automationId });
        const edit = await fetch(`${home.baseUrl}/v3/automations/${automationId}`, { method: 'PATCH', headers,
            body: JSON.stringify({ expectedTemplateVersion: retained!.templateVersion, name: 'Cannot revive' }) });
        expect(edit.status).toBe(400);
        const mixedPause = await fetch(`${home.baseUrl}/v3/automations/${automationId}`, { method: 'PATCH', headers,
            body: JSON.stringify({ expectedTemplateVersion: retained!.templateVersion, enabled: false, name: 'Cannot edit while pausing' }) });
        expect(mixedPause.status).toBe(400);
        const directSetPause = await fetch(`${home.baseUrl}/v3/automations/${automationId}`, { method: 'PATCH', headers,
            body: JSON.stringify({ expectedTemplateVersion: retained!.templateVersion, enabled: false,
                assignments: retained!.assignments.map(({ machineId, enabled, priority }) => ({ machineId, enabled, priority })) }) });
        expect(directSetPause.status).toBe(200);
        expect((await getAutomationDefinition({ token: home.token, automationId }))?.assignments).toEqual(beforeCleanup.assignments);
        const paused = await executor.execute('workflow.trigger.update', { automationId,
            expectedRevision: retained!.templateVersion, patch: { enabled: false } }, context);
        expect(paused, JSON.stringify(paused)).toMatchObject({ ok: true });
        const afterPause = (await getAutomationDefinition({ token: home.token, automationId }))!;
        expect(afterPause.enabled).toBe(false);
        const refusedEdit = await executor.execute('workflow.trigger.update', { automationId,
            expectedRevision: afterPause.templateVersion, patch: { enabled: true } }, context);
        expect(refusedEdit, JSON.stringify(refusedEdit)).toMatchObject({ ok: false, effectAttempted: false,
            errorCode: 'workflow_http_error', details: { status: 400 } });
        const machine = home.machines[0]!;
        vi.spyOn(installationStore, 'readInstallationIdentityIfExistsSync').mockReturnValue({ version: 1, createdAt: 1,
            installationId: machine.installationId, publicKey: Buffer.from(machine.keys.publicKey).toString('base64url'),
            privateKey: Buffer.from(machine.keys.secretKey).toString('base64url') });
        const target = { kind: 'machine' as const, machineId: machine.id };
        const requestId = randomUUID();
        const minted = await prepareExternalActionRequesterAccountAuthorizationWithEnvelope({ actionId: 'workflow.trigger.remove',
            input: { automationId }, requestId, target, machineId: machine.id, accountId: home.accountId,
            accountEncryptionMode: 'plain', tokenEpochHint: home.tokenEpoch, token: home.token,
            serverId: home.homeId, serverIdentityId: home.homeId, serverHttpBaseUrl: home.baseUrl,
            installationId: machine.installationId, privateKey: machine.keys.secretKey });
        if (!minted) throw new Error('remove_home_admission_unavailable');
        const lifetime = new AbortController();
        const prepareRequester = (authorization: typeof minted.authorization) => prepareRequesterAccountActionContext({ authorization,
            purpose: { kind: 'external_action' }, ownCredentials: credentials, machineId: machine.id,
            installationId: machine.installationId, installationPrivateKey: machine.keys.secretKey,
            serverId: home.homeId, serverIdentityId: home.homeId, serverHttpBaseUrl: home.baseUrl, signal: lifetime.signal,
            isCustodyCurrent: async () => !lifetime.signal.aborted,
            isCurrent: () => verifyExternalActionExecutionAuthorizationCurrent({ authorization, effectActionId: 'workflow.trigger.remove',
                target, privateKey: machine.keys.secretKey, installationId: machine.installationId, serverHttpBaseUrl: home.baseUrl }),
            createExecutor: () => ({ execute: (...args) => executor.execute(...args) }) });
        const requester = await prepareRequester(minted.authorization);
        if (!requester) throw new Error('remove_requester_custody_unavailable');
        try {
            executor = createActionExecutor({ ...cli,
                isApprovalExecutionOriginCurrent: createDaemonApprovalExecutionOriginCurrentness({ accountId: home.accountId,
                    machineId: machine.id, serverId: home.homeId,
                    resolveCurrentMachineExecutionOriginContext: async () => ({ serverIdentityId: home.homeId, machineId: machine.id }),
                    resolveTarget: createDaemonExternalActionTargetResolver({ credentials, serverApiUrl: home.baseUrl }),
                    resolveCurrentPermissionMode: async () => 'default', externalActionMachinePublicKey: machine.keys.publicKey,
                    verifyExternalExecutionAuthorization: request => verifyExternalActionExecutionAuthorizationCurrent({ ...request,
                        privateKey: machine.keys.secretKey, installationId: machine.installationId, serverHttpBaseUrl: home.baseUrl }),
                    isAccountCurrent: async () => (await fetch(`${home.baseUrl}/v1/account/encryption`, {
                        headers: { Authorization: `Bearer ${home.token}` } })).ok,
                    listAccountApiTokens: async () => { throw new Error('No API-token origin'); } }),
                prepareApprovalExecutionAuthorization: async ({ authorization }) => {
                    const custody = await prepareRequester(authorization);
                    if (!custody) return null;
                    return { authorization: custody.authorization, dispose: () => custody.dispose(),
                        actionsSettings: normalizeActionsSettingsV1(custody.actionsSettings),
                        signExternalActionApprovalInput: ({ authorization: signed, ...request }) => signExternalActionApprovalInputV1({
                            ...request, authorizationToken: signed.token, privateKey: machine.keys.secretKey }) };
                },
            });
            const external: ActionExecutorContext = { ...context, actionsSettings: normalizeActionsSettingsV1(undefined),
                actionRequestId: requestId, externalActionTarget: target, externalActionExecutionAuthorization: requester.authorization,
                originalActionEnvelope: minted.envelope, signal: lifetime.signal, callerPermissionMode: 'default',
                signExternalActionApprovalInput: ({ authorization: signed, ...request }) => signExternalActionApprovalInputV1({
                    ...request, authorizationToken: signed.token, privateKey: machine.keys.secretKey }) };
            const proposed = await executor.execute('workflow.trigger.remove', { automationId }, external);
            expect(proposed, JSON.stringify(proposed)).toMatchObject({ ok: true });
            if (!proposed.ok) throw new Error(proposed.errorCode);
            const approval = ActionApprovalRequestCreatedResultSchema.parse(proposed.result);
            const removed = await executor.execute('approval.request.decide', { artifactId: approval.artifactId, decision: 'approve' }, context);
            expect(removed, JSON.stringify(removed)).toMatchObject({ ok: true, result: { status: 'executed',
                execution: { ok: true, result: { automationId, deleted: true } } } });
        } finally { lifetime.abort(); await requester.dispose(); }
        expect(await getAutomationDefinition({ token: home.token, automationId })).toBeNull();
        expect(home.readRequestCosts().filter(cost => cost.method === 'DELETE' && cost.status === 200)).toEqual([
            expect.objectContaining({ route: '/v3/automations/:id/triggers', status: 200 }),
            expect.objectContaining({ route: '/v3/automations/:id', status: 200 }),
        ]);
    });
});
