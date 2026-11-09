import { afterEach, expect, it, vi } from 'vitest';
import axios from 'axios';
import { createActionExecutor, formatQualifiedPluginActionId } from '@happier-dev/protocol/actions';
import { ActionIdSchema } from '@happier-dev/protocol/actions/actionIds';
import { ActionDefinitionV1Schema } from '@happier-dev/protocol/actions/actionDefinitionV1';
import { actionSpecToActionDefinitionV1, freezeWorkflowActionContractV1 } from '@happier-dev/protocol/actions/actionCatalog';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { materializeWorkflowAcceptedSnapshotV1 } from '@happier-dev/protocol/workflows/materializeWorkflowAcceptedSnapshotV1';
import { createPluginTestkit } from '@happier-dev/plugin-sdk/testing';
import { defineProtocolJsonValue } from '@happier-dev/plugin-sdk/protocol';
import { createCliDeploymentActionDeps } from '@/deployments/createCliDeploymentActionDeps';
import { createUnavailableActionTransportDeps } from '@/testkit/actionTransportDeps';
import { createCommittedContributedActionSchemaReader } from '@/plugins/runtime/invocation/actions/createCommittedContributedActionDeps';
import { PLUGIN_MANIFEST } from '../../../../../packages/plugins/scm-github/src/manifest';
import { activate, activateAccount } from '../../../../../packages/plugins/scm-github/src/activate';
import { GITHUB_PLUGIN_ID } from '../../../../../packages/plugins/scm-github/src/observations/githubProviderContracts';
import { GITHUB_TRIAGE_MUTATION_ACTION_IDS_V1 } from '../../../../../packages/plugins/scm-github/src/triage/contribution';
import { GITHUB_PREVIEW_STATUS_WORKFLOW_ID_V1 } from '../../../../../packages/plugins/scm-github/src/triage/previewStatusWorkflow';
import { previewStatusInput, previewStatusTransport } from '../../../../../packages/plugins/scm-github/src/triage/testkit/githubMutation.test-support';
import { createWorkflowCoordinator } from './coordinator';
import { createInMemoryWorkflowCoordinatorStore } from './workflowCoordinator.testkit';
import { buildWorkflowActionContext } from './workflowActionContext';

afterEach(() => vi.restoreAllMocks());
const workspace = { machineId: 'preview-controller', directory: '/repo', checkoutRootPath: '/repo' };

async function publicationRun(stub: ReturnType<typeof previewStatusTransport>, input: ReturnType<typeof previewStatusInput>) {
    const localId = GITHUB_TRIAGE_MUTATION_ACTION_IDS_V1.pullRequestPreviewStatus;
    const actionId = formatQualifiedPluginActionId({ pluginId: GITHUB_PLUGIN_ID, localId });
    const action = PLUGIN_MANIFEST.contributes.actions!.find(item => item.id === localId)!;
    const workflow = PLUGIN_MANIFEST.contributes.workflows!.find(item => item.id === GITHUB_PREVIEW_STATUS_WORKFLOW_ID_V1)!;
    const definition = ActionDefinitionV1Schema.parse({ kindVersion: 1, id: actionId, title: action.title,
        description: null, safety: 'danger', placements: [], slash: null, bindings: null, examples: null,
        surfaces: { agent: true }, inputHints: null, inputSchema: action.inputSchema, outputSchema: action.resultSchema });
    const accepted = await materializeWorkflowAcceptedSnapshotV1({ definition: workflow.definition,
        context: { source: { kind: 'inline' }, inputs: { publication: defineProtocolJsonValue().parse(input) },
            machineId: workspace.machineId, workspaceTarget: { project: workspace }, executionTarget: { kind: 'session' },
            origin: { kind: 'direct' }, authorization: { principal: { kind: 'host' }, admittedPermissionCeiling: 'default' } },
        admission: { kind: 'user' }, effects: { resolveTargetAvailability: async () => true,
            readActionContract: async id => id === actionId ? freezeWorkflowActionContractV1(definition)
                : freezeWorkflowActionContractV1(actionSpecToActionDefinitionV1(getActionSpec(ActionIdSchema.parse(id)))) } });
    if (!accepted.ok) throw new Error(accepted.error.code);
    // Home HTTP is a genuine boundary. The same public Home Action fixture also
    // serves Forge's separate services.actions transport; its internal policy stays real.
    const reads: string[] = [];
    const http = vi.spyOn(axios, 'request').mockImplementation(async request => {
        const path = new URL(request.url!).pathname;
        reads.push(path);
        const data = path === '/v1/deployments/receipts/preview-teardown'
            ? await stub.context.services.actions.execute('deployments.receipts.get', {
                serverId: 'srv_preview', deploymentId: 'preview-teardown',
            })
            : path === '/v1/deployments/environments/preview-child'
                ? await stub.context.services.actions.execute('deployments.environments.get', {
                    serverId: 'srv_preview', environmentId: 'preview-child',
                })
                : (() => { throw new Error(`Unexpected Home request: ${path}`); })();
        return { status: 200, data };
    });
    const deployment = createCliDeploymentActionDeps({ serverHttpBaseUrl: 'https://home.test',
        admitAccount: async () => null, resolveRequestHeaders: async () => ({ Authorization: 'Bearer fixture-token' }),
        dispatchReceipt: async () => { throw new Error('Publication must never deploy or tear down'); } });
    const kit = await createPluginTestkit({ manifest: PLUGIN_MANIFEST, module: { activate, activateAccount }, services: stub.context.services });
    const list = () => [definition];
    const executor = createActionExecutor({ ...createUnavailableActionTransportDeps(),
        deploymentAction: deployment.deploymentAction, resolveEnvironmentApprovalScope: deployment.resolveEnvironmentApprovalScope,
        listContributedActionDefinitions: list, readContributedActionSchemas: createCommittedContributedActionSchemaReader(list),
        invokeContributedAction: async request => ({ ok: true,
            result: await kit.invokeAction(request.action.localId, defineProtocolJsonValue().parse(request.input)) }) });
    const store = createInMemoryWorkflowCoordinatorStore();
    const coordinator = createWorkflowCoordinator({ store,
        executeStep: async () => { throw new Error('Publication must not start an agent'); },
        resolveWorkspace: async () => ({ ok: true, workspace }), action: { executor,
            buildContext: async params => ({ ...buildWorkflowActionContext(params), serverId: 'srv_preview', serverIdentityId: 'srv_preview' }),
            observeRun: async () => { throw new Error('Immediate publication must not observe a Run'); } } });
    try {
        const result = await coordinator.run({ ...accepted.snapshot, runId: 'preview-publication',
            originSessionId: accepted.snapshot.origin?.originSessionId });
        expect(result, JSON.stringify(result)).toMatchObject({ state: 'succeeded' });
        const publication = store.list().find(row => row.blockId === 'publish');
        // One native admission resolves the receipt's Environment; the Action then reads its current result.
        expect(reads).toEqual(['/v1/deployments/receipts/preview-teardown',
            '/v1/deployments/environments/preview-child', '/v1/deployments/receipts/preview-teardown']);
        return publication?.result;
    } finally { http.mockRestore(); await kit.dispose(); }
}

it('binds preview publication to the receipt observed by the real controller Workflow and retries without deploying', async () => {
    const stub = previewStatusTransport();
    const input = { ...previewStatusInput(), environmentId: 'caller-copy', targetLinkId: 'caller-copy' };
    expect(await publicationRun(stub, input)).toMatchObject({ kind: 'applied', publication: {
        environmentId: 'preview-child', targetLinkId: 'preview-runtime', deploymentId: 'preview-teardown', status: 'removed',
    } });
    expect(await publicationRun(stub, input)).toMatchObject({ kind: 'applied' });
    expect(stub.requests.filter(request => request.method === 'POST')).toHaveLength(1);
});

it('does not publish removal for the pending teardown observed by the controller Workflow', async () => {
    const stub = previewStatusTransport({ receiptState: 'running' });
    expect(await publicationRun(stub, previewStatusInput())).toMatchObject({ kind: 'refused', reason: 'preview_context_changed' });
    expect(stub.requests.filter(request => request.method === 'POST')).toHaveLength(0);
});
