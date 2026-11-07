import { resolve } from 'node:path';
import fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { computeActionInputApprovalDigestV1 } from '@happier-dev/protocol/actions/decisionAuthority';
import { freezeWorkflowActionContractV1 } from '@happier-dev/protocol/actions/actionCatalog';
import { DeploymentEnvironmentCreateInputV1Schema } from '@happier-dev/protocol/deployments/deploymentActionsV1';
import { DeploymentTargetPreparationBaseV1ProtocolSchema } from '@happier-dev/plugin-sdk';
import { materializeWorkflowAcceptedSnapshotV1 } from '@happier-dev/protocol/workflows/materializeWorkflowAcceptedSnapshotV1';
import { WorkflowApprovedOperationV1Schema } from '@happier-dev/protocol/workflows/workflowDefinitionV1';
import { sealWorkflowAcceptedSnapshotStoredEnvelopeV1, sealWorkflowCheckpointStoredEnvelopeV1,
    sealWorkflowProgressStoredEnvelopeV1, serializeWorkflowStoredContentEnvelopeV1,
    openWorkflowProgressStoredEnvelopeV1, parseWorkflowStoredContentEnvelopeV1 }
    from '@happier-dev/protocol/workflows/workflowStoredContentV1';
import { QualifiedConnectedAccountProfileV4Schema } from '@happier-dev/protocol/connect/qualifiedConnectedAccountsV4';
import { PluginAvailabilityActionHttpPathsV1 } from '@happier-dev/protocol/plugins/availability';
import { encodePlainArtifactStoredContent } from '@happier-dev/protocol/storage/artifactStoredContent';
import { createDeploymentEnvironmentDetailV1, createDeploymentEnvironmentHeaderV1, createDeploymentTargetLinkHeaderV1 }
    from '@happier-dev/deployment-protocol/testing/v1';
import * as supabase from '../../../../../packages/plugins/deployment-supabase/src/index';
import * as neon from '../../../../../packages/plugins/deployment-neon/src/index';
import { registerAuthoredAccountActionRelease } from '@/plugins/runtime/accountPluginActions.testkit';
import { createWorkflowDataPluginRuntimeFixture } from '@/deployments/targets/workflowDataPluginRuntime.testkit';
import { prepareWorkflowDataCreationResultCapture } from '@/deployments/targets/workflowDataCreationResult';
import { createCommittedContributedActionInvoker, createCommittedContributedActionSchemaReader,
    listRuntimeContributedActionDefinitions } from '@/plugins/runtime/invocation/actions/createCommittedContributedActionDeps';
import { createConnectedAccountPurposeBindingOwner } from '@/daemon/connectedServices/purposeBindings/ConnectedAccountPurposeBindingOwner';
import { createPurposeTargetResolver } from '@/daemon/connectedServices/purposeBindings/resolveTarget';
import { createAccountEncryptionCurrentnessFixture } from '@/testkit/backends/sessionFixtures';
import { installAxiosFastifyAdapter } from '@/testkit/http/axiosAdapter';
import { createUnavailableActionTransportDeps } from '@/testkit/actionTransportDeps';
import { createWorkflowApprovedOperationReader, prepareWorkflowApprovedOperationSnapshot } from './workflowApprovedOperation';
import { createWorkflowRunStorageTestkit } from './workflowRunStorage.testkit';
import { DurableWorkflowCoordinatorStore } from './production';
import { createWorkflowCoordinator } from './coordinator';
import { buildWorkflowActionContext } from './workflowActionContext';

// Node's provider HTTP uses Undici; share the fixture boundary with portable fetch.
vi.mock('undici', async importOriginal => ({
    ...await importOriginal<typeof import('undici')>(),
    fetch: (...args: Parameters<typeof globalThis.fetch>) => globalThis.fetch(...args),
}));

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

/** Only Home persistence and vendor HTTP are replaced. The public Account
 * artifact loader, reviewed child, Action executor and durable coordinator run. */
describe('Workflow preview data creation capture composition', () => {
    it.each([{ plugin: supabase, folder: 'deployment-supabase' }, { plugin: neon, folder: 'deployment-neon' }])(
        'keeps branch creation and deletion discoverable on their supported surfaces: $folder', async ({ plugin, folder }) => {
            const accountId = 'account-A', origin = 'https://data-surface-home.test';
            const app = fastify();
            await registerAuthoredAccountActionRelease(app, accountId, { primary: { manifest: plugin.manifest,
                projectRoot: resolve(import.meta.dirname, `../../../../../packages/plugins/${folder}`),
                entryPath: resolve(import.meta.dirname, `../../../../../packages/plugins/${folder}/src/index.ts`) } });
            app.get('/v1/account/encryption', async () => ({ mode: 'plain', updatedAt: 0 }));
            app.get('/v1/account/encryption/currentness', async () => createAccountEncryptionCurrentnessFixture({ mode: 'plain' }));
            app.get('/v1/account/profile', async () => ({ id: accountId }));
            app.get('/v2/account/settings', async () => ({ content: { t: 'plain', v: {} }, version: 1 }));
            vi.spyOn(globalThis, 'fetch').mockImplementation(async url => {
                if (new URL(String(url)).origin !== origin) throw new Error('Discovery must not call a provider');
                return Response.json({ features: {}, capabilities: { serverIdentity: { serverIdentityId: 'home' } } });
            });
            await app.ready();
            const restoreHttp = installAxiosFastifyAdapter({ app, origin });
            const token = `header.${Buffer.from(JSON.stringify({ sub: accountId })).toString('base64url')}.signature`;
            const mounted = await createWorkflowDataPluginRuntimeFixture({ accountExecution: {
                credentials: { token, encryption: null }, serverUrl: origin, serverId: 'home', machineId: 'host',
                isCurrent: async () => true }, resolveCurrentMachineId: () => 'host' });
            try {
                const list: NonNullable<import('@happier-dev/protocol').ActionExecutorDeps['listContributedActionDefinitions']> =
                    selection => listRuntimeContributedActionDefinitions(mounted.registry, selection);
                const executor = createActionExecutor({ ...createUnavailableActionTransportDeps(),
                    listContributedActionDefinitions: list, readContributedActionSchemas: createCommittedContributedActionSchemaReader(list) });
                for (const surface of ['agent', 'cli', 'plugin'] as const) for (const localId of ['branches-create', 'branches-delete']) {
                    const result = await executor.execute('action.spec.get', { id: `${plugin.manifest.id}/actions/${localId}` },
                        { surface, authority: 'account_automation', ...(surface === 'plugin' ? { actionCaller: {
                            kind: 'plugin' as const, pluginId: plugin.manifest.id, contributionLocalId: 'database',
                            materialization: { machineId: 'host', materializationId: `${plugin.manifest.id}-source`, pluginId: plugin.manifest.id },
                        } } : {}) });
                    expect(result, `${surface}/${localId}: ${JSON.stringify(result)}`).toMatchObject({ ok: true });
                }
            } finally { await mounted.dispose(); restoreHttp(); await app.close(); }
        });

    it('retains only the native delete operand for the accepted exact PR creation', async () => {
        const accountId = 'account-A', runId = 'ca00a439-791a-4bde-b332-d310c218799e';
        const origin = 'https://preview-capture-home.test', machineId = 'host';
        const app = fastify();
        const homeRequests: string[] = [];
        app.addHook('onRequest', async request => { homeRequests.push(request.url); });
        const authored = await registerAuthoredAccountActionRelease(app, accountId, { primary: {
            manifest: supabase.manifest,
            projectRoot: resolve(import.meta.dirname, '../../../../../packages/plugins/deployment-supabase'),
            entryPath: resolve(import.meta.dirname, '../../../../../packages/plugins/deployment-supabase/src/index.ts'),
        } });
        const token = `header.${Buffer.from(JSON.stringify({ sub: accountId })).toString('base64url')}.signature`;
        const credentials = { token, encryption: null };
        const action = { pluginId: supabase.manifest.id, localId: 'branches-create' };
        const actionId = `${action.pluginId}/actions/${action.localId}`;
        const declaration = supabase.manifest.contributes.actions?.find(candidate => candidate.id === action.localId);
        const descriptor = supabase.manifest.contributes.connectedAccountDescriptors?.[0];
        if (!declaration || !descriptor) throw new Error('Supabase create and Account declarations required');
        const credentialRef = { service: { pluginId: supabase.manifest.id, localId: descriptor.id }, accountId: 'connected-A' };
        const custody = DeploymentTargetPreparationBaseV1ProtocolSchema.parse({ v: 1, serverId: 'home',
            environmentId: 'environment-A', expectedRevision: 1, targetLinkId: 'data-link', expectedTargetLinkRevision: 1,
            credentialRef, credentialPrincipal: { kind: 'account', accountId,
                purpose: { consumer: action, purpose: 'deploy-manage' }, target: { kind: 'account', account: credentialRef } },
            providerIdentity: { providerAccountId: 'organization-A', providerResourceId: 'parent-project-A', providerEnvironment: 'parent-project-A' },
            providerEnvironment: { kind: 'custom', id: 'parent-project-A' } });
        const pullRequest = { repository: { kind: 'github', deployment: 'https://forge.example/enterprise', repository: 'owner/app' },
            pullRequestId: '17', headSha: 'a'.repeat(40), branchName: 'pr-17' };
        const input = WorkflowApprovedOperationV1Schema.shape.parent.shape.input.parse({
            ...custody, name: pullRequest.branchName, gitBranch: pullRequest.headSha, withData: false });
        const parent = { actionId: 'deployments.environments.create' as const,
            input: WorkflowApprovedOperationV1Schema.shape.parent.shape.input.parse(DeploymentEnvironmentCreateInputV1Schema.parse({ serverId: 'home', requestKey: 'preview-create',
                contentArtifactId: 'preview-content', contentHeaderVersion: 1, contentBodyVersion: 1,
                projectSourceId: 'repository-source', protection: 'nonProduction', purpose: 'preview',
                deployerMode: 'managers', controllerMachineId: machineId,
                preview: { templateEnvironmentId: 'template-A', expectedTemplateRevision: 1,
                    pullRequestId: pullRequest.pullRequestId, runtimeTargetLinkId: 'template-runtime' } })) };
        const workspace = { machineId, directory: '/repo', checkoutRootPath: '/repo' };
        const materialized = await materializeWorkflowAcceptedSnapshotV1({ definition: { version: 1, defaults: {},
            inputs: [{ name: 'pullRequest', valueType: 'json', required: true }], blocks: [{ kind: 'action', id: 'data', actionId,
                input: { ...Object.fromEntries(Object.entries(custody).map(([field, value]) => [field, { kind: 'literal' as const, value }])),
                    withData: { kind: 'literal', value: false }, name: { kind: 'input', name: 'pullRequest', path: ['branchName'] },
                    gitBranch: { kind: 'input', name: 'pullRequest', path: ['headSha'] } } }] },
            context: { source: { kind: 'inline' }, inputs: { pullRequest }, machineId, executionTarget: { kind: 'session' },
                workspaceTarget: { project: workspace }, origin: { kind: 'direct', originSessionId: 'person-session',
                    actionRequestAttributionV1: { requestRef: 'person-started-preview', requester: { serverId: 'home', accountId },
                        persona: { serverId: 'home', sessionId: 'person-session' }, origin: null } }, authorization: { principal: { kind: 'host' } } },
            admission: { kind: 'user' }, effects: { resolveTargetAvailability: async () => true,
                readActionContract: async id => id === actionId
                    ? freezeWorkflowActionContractV1({ ...declaration, outputSchema: declaration.resultSchema }) : null } });
        if (!materialized.ok) throw new Error(materialized.error.code);
        const accepted = await prepareWorkflowApprovedOperationSnapshot({ snapshot: materialized.snapshot, parent,
            steps: [{ actionId, input }], context: { actionRequestId: 'preview-parent-request',
                approvedActionReplay: { artifactId: 'preview-approval' }, presentUserApproval: { artifactId: 'preview-approval',
                    actionId: parent.actionId, requestId: 'preview-parent-request', decidingAccountId: accountId,
                    inputDigest: computeActionInputApprovalDigestV1(parent.actionId, parent.input) } } });
        const stored = createWorkflowRunStorageTestkit({ runId, machineId, accountId, origin: { kind: 'direct' },
            acceptedEnvelope: serializeWorkflowStoredContentEnvelopeV1(sealWorkflowAcceptedSnapshotStoredEnvelopeV1({ mode: 'plain',
                binding: { v: 1, purpose: 'accepted_snapshot', accountId, runId }, acceptedSnapshot: accepted })) });
        const rootRecordId = 'root';
        const checkpoint = { kind: 'happier.workflow-checkpoint.v1' as const, rootRecordId, nextSequence: '1',
            frontier: { nextBlockOrdinal: 0, paused: false } };
        await stored.execute({ operation: 'initialize', runId, expectedRevision: 0,
            checkpointEnvelope: serializeWorkflowStoredContentEnvelopeV1(sealWorkflowCheckpointStoredEnvelopeV1({ mode: 'plain',
                binding: { v: 1, purpose: 'checkpoint', accountId, runId }, checkpoint })),
            rootInvocation: { id: rootRecordId, contentEnvelope: serializeWorkflowStoredContentEnvelopeV1(sealWorkflowProgressStoredEnvelopeV1({ mode: 'plain',
                binding: { v: 1, purpose: 'invocation_progress', accountId, runId, recordId: rootRecordId,
                    sequence: '0', parentRecordId: null, memberOrdinal: '0', attempt: '0' },
                progress: { kind: 'happier.workflow-progress.v1', blockKind: 'root', attempt: '0',
                    invocationPath: { blockId: '$root', scope: [] }, logicalInvocationRecordId: rootRecordId } })) } });
        const environment = createDeploymentEnvironmentHeaderV1({ id: custody.environmentId, serverId: 'home',
            owner: { kind: 'account', accountId }, controllerMachineId: machineId });
        const baseline = createDeploymentEnvironmentDetailV1();
        const seed = (id: string, kind: string, content: unknown) => authored.artifacts.seed(id,
            encodePlainArtifactStoredContent({ kind, title: 'Preview' }),
            encodePlainArtifactStoredContent({ body: JSON.stringify(content) }));
        seed(environment.contentArtifactId, 'deployment-environment.v1', baseline.content);
        for (const row of baseline.targetLinks) seed(row.targetLink.contentArtifactId, 'deployment-target-link.v1', row.content);
        const link = createDeploymentTargetLinkHeaderV1({ id: custody.targetLinkId, environmentId: environment.id,
            createdByAccountId: accountId, role: 'data', revision: 1, targetKind: 'supabase', machines: [], members: [],
            contentArtifactId: 'artifact-data-link', source: { kind: 'plugin', contribution: { pluginId: supabase.manifest.id, localId: 'database' } } });
        authored.artifacts.seed(link.contentArtifactId, encodePlainArtifactStoredContent({ kind: 'deployment-target-link.v1', title: 'Data' }),
            encodePlainArtifactStoredContent({ body: JSON.stringify({ credentialPrincipal: custody.credentialPrincipal,
                providerIdentity: custody.providerIdentity, providerEnvironment: custody.providerEnvironment }) }));
        const profile = QualifiedConnectedAccountProfileV4Schema.parse({ ref: credentialRef, status: 'connected',
            authenticationModeId: 'token', revisionSemantics: 'revisioned', credentialRevision: 'csr_abcdefghijklmnopqrstuv',
            configurationReady: true, configurationRevision: null, kind: 'token', expiresAt: null,
            displayName: 'Original Supabase', scopes: [] });
        const purposeOwner = createConnectedAccountPurposeBindingOwner({ credentialOwnerAccountId: accountId,
            store: { read: async () => ({ v: 1, bindings: [] }), update: async () => { throw new Error('No preference writes'); },
                subscribe: () => ({ dispose() {} }) }, selectTarget: async () => { throw new Error('No interactive Account selection'); },
            resolveTarget: createPurposeTargetResolver({ available: true,
                resolveService: async () => ({ service: credentialRef.service, authentication: descriptor.authentication }), listAccounts: async () => [profile] }),
            resolveCredentialRevision: async () => profile.credentialRevision,
            materializeAccount: async request => { request.credentialRevisionBasis?.captureCredentialRevision(profile.credentialRevision!);
                return { kind: 'httpHeaders', headers: { authorization: 'Bearer original-A' } }; },
            projectTargetAccounts: async () => [], assertTargetAccountMaterializable: async () => undefined });
        app.get('/v1/account/encryption', async () => ({ mode: 'plain', updatedAt: 0 }));
        app.get('/v1/account/encryption/currentness', async () => createAccountEncryptionCurrentnessFixture({ mode: 'plain' }));
        app.get('/v1/account/profile', async () => ({ id: accountId }));
        app.get('/v2/account/settings', async () => ({ content: { t: 'plain', v: {} }, version: 1 }));
        app.get('/v1/deployments/environments/:environmentId', async () => ({ ok: true, environment,
            targetLinks: [...baseline.targetLinks.map(row => row.targetLink), link] }));
        const providerRequests: { pathname: string; body: unknown; authorization: string | null }[] = [];
        vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
            const parsed = new URL(String(url));
            if (parsed.origin === origin) return Response.json({ features: {}, capabilities: { serverIdentity: { serverIdentityId: 'home' } } });
            if (parsed.hostname !== 'api.supabase.com' || init?.method !== 'POST'
                || parsed.pathname !== '/v1/projects/parent-project-A/branches') throw new Error(`Unexpected vendor request ${parsed.pathname}`);
            providerRequests.push({ pathname: parsed.pathname, body: await new Response(init.body).json(),
                authorization: new Headers(init.headers).get('authorization') });
            return Response.json({ id: 'e242cf8e-9562-4e0b-9082-a10ae56879c6', project_ref: 'child-project-A',
                parent_project_ref: 'parent-project-A', name: 'pr-17', persistent: false, with_data: false,
                status: 'CREATING', db_pass: 'provider-private-echo' }, { status: 201 });
        });
        await app.ready();
        const restoreHttp = installAxiosFastifyAdapter({ app, origin });
        const mounted = await createWorkflowDataPluginRuntimeFixture({ connectedAccounts: purposeOwner,
            actionFormConnectedAccounts: purposeOwner, accountExecution: { credentials, serverUrl: origin, serverId: 'home', serverIdentityId: 'home', machineId,
                isCurrent: async () => true }, resolveCurrentMachineId: () => machineId });
        try {
            const list: NonNullable<import('@happier-dev/protocol').ActionExecutorDeps['listContributedActionDefinitions']> =
                selection => listRuntimeContributedActionDefinitions(mounted.registry, selection);
            const reader = createWorkflowApprovedOperationReader({ storage: stored,
                resolveEncryption: async () => ({ witness: { mode: 'plain' } }) });
            const executor = createActionExecutor({ ...createUnavailableActionTransportDeps(),
                listContributedActionDefinitions: list, readContributedActionSchemas: createCommittedContributedActionSchemaReader(list),
                readApprovedOperation: request => request.runId ? reader({ ...request, runId: request.runId }) : Promise.resolve(null),
                invokeContributedAction: createCommittedContributedActionInvoker({ acquireRuntimeRegistryLease: async () => {
                    const lease = mounted.controller.tryAcquireRuntimeRegistry();
                    if (!lease) throw new Error('Fixture registry unavailable');
                    return lease;
                }, requestCurrentIntent: async ({ fingerprint }) => ({ status: 'approved', fingerprint }) }) });
            const encryption = { witness: { mode: 'plain' as const, version: 1, contentKeyFingerprint: null },
                runCrypto: { mode: 'plain' as const } };
            const store = await DurableWorkflowCoordinatorStore.load({ accountId, runId, parentAttempt: 0, rootRecordId,
                checkpoint, encryption, storage: stored, revision: stored.run().revision });
            const coordinator = createWorkflowCoordinator({ store, rootInvocationRecordId: rootRecordId,
                executeStep: async () => { throw new Error('No Session steps'); }, resolveWorkspace: async () => ({ ok: true, workspace }),
                action: { executor, buildContext: async request => ({ ...buildWorkflowActionContext(request),
                    runtimeAccountId: accountId, serverId: 'home', serverIdentityId: 'home' }),
                    prepareResultCapture: async id => prepareWorkflowDataCreationResultCapture(id, mounted.registry.contributes),
                    observeRun: async () => { throw new Error('No detached Runs'); } } });
            const outcome = await coordinator.run({ ...accepted, runId });
            expect(outcome, JSON.stringify(outcome)).toMatchObject({ state: 'succeeded' });
            expect(providerRequests).toEqual([{ pathname: '/v1/projects/parent-project-A/branches',
                body: { branch_name: pullRequest.branchName, git_branch: pullRequest.headSha, persistent: false, with_data: false },
                authorization: 'Bearer original-A' }]);
            expect(homeRequests).toContain(PluginAvailabilityActionHttpPathsV1['account.plugins.availability.uiArtifact.read']);
            const row = stored.rows().find(row => row.index.parentRecordId === rootRecordId);
            if (!row) throw new Error('Retained data creation invocation required');
            const opened = openWorkflowProgressStoredEnvelopeV1({ mode: 'plain',
                binding: { v: 1, purpose: 'invocation_progress', accountId, runId, recordId: row.index.id,
                    sequence: row.index.sequence, parentRecordId: row.index.parentRecordId,
                    memberOrdinal: row.index.memberOrdinal, attempt: row.index.attempt },
                envelope: parseWorkflowStoredContentEnvelopeV1(row.contentEnvelope) });
            if (opened.kind !== 'available') throw new Error('Retained progress unavailable');
            expect(opened.content.execution).toMatchObject({ kind: 'action', actionId, input });
            expect(opened.content.execution?.kind === 'action' ? opened.content.execution.output : undefined)
                .toEqual({ kind: 'deployment_data_created', v: 1,
                    source: { pluginId: supabase.manifest.id, localId: 'database' },
                    deleteAction: { pluginId: supabase.manifest.id, localId: 'branches-delete' },
                    providerIdentity: { providerAccountId: 'organization-A', providerResourceId: 'parent-project-A', providerEnvironment: 'child-project-A' },
                    providerEnvironment: { kind: 'custom', id: 'child-project-A' }, operands: {} });
            expect(JSON.stringify(opened.content.execution)).not.toContain('provider-private-echo');
        } finally { await mounted.dispose(); restoreHttp(); await app.close(); }
    });
});
