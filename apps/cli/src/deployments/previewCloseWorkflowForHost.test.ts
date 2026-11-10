import { expect, it } from 'vitest';
import { createDeploymentEnvironmentDetailV1, createDeploymentTargetLinkHeaderV1 } from '@happier-dev/deployment-protocol/testing/v1';
import { WorkflowInvocationListResultV1Schema } from '@happier-dev/protocol/workflows/actionsV1';
import { readPreviewCloseWorkflowForHost } from './previewCloseWorkflowForHost';

it('closes a PR using its saved creation Run and exact native capture before removing its Environment', async () => {
    const child = createDeploymentEnvironmentDetailV1();
    child.environment.purpose = 'preview';
    child.content.previewCreationRunId = 'creation-run';
    const source = { pluginId: 'happier.deploy.supabase', localId: 'database' };
    const dataLink = createDeploymentTargetLinkHeaderV1({ id: 'child-data', environmentId: child.environment.id,
        role: 'data', source: { kind: 'plugin', contribution: source }, targetKind: 'supabase', machines: [], members: [] });
    child.targetLinks.push({ targetLink: dataLink, content: {} });
    const credentialRef = { service: { pluginId: source.pluginId, localId: 'supabase' }, accountId: 'connected-A' };
    const input = { v: 1, serverId: child.environment.serverId, environmentId: child.environment.id,
        expectedRevision: 1, targetLinkId: dataLink.id, expectedTargetLinkRevision: 1, credentialRef,
        credentialPrincipal: { kind: 'account', accountId: 'account-A',
            purpose: { consumer: { pluginId: source.pluginId, localId: 'projects-link' }, purpose: 'deploy-manage' },
            target: { kind: 'account', account: credentialRef } },
        providerIdentity: { providerAccountId: 'organization-A', providerResourceId: 'parent', providerEnvironment: 'parent' },
        providerEnvironment: { kind: 'custom', id: 'parent' }, name: 'pr-17', withData: false };
    const index = { id: 'branch-invocation', runId: 'creation-run', sequence: '0', parentRecordId: null,
        memberOrdinal: '0', attempt: '0', contentRevision: '0', lifecycle: 'completed',
        createdAt: '2026-11-10T00:00:00.000Z', updatedAt: '2026-11-10T00:00:01.000Z' };
    const page = WorkflowInvocationListResultV1Schema.parse({ invocations: [index], parentRevision: 1,
        invocationDetails: [{ index, parentRevision: 1, progress: { kind: 'happier.workflow-progress.v1', blockKind: 'action',
            invocationPath: { blockId: 'data', scope: [] }, attempt: '0', logicalInvocationRecordId: index.id,
            execution: { kind: 'action', actionId: `${source.pluginId}/actions/branches-create`, actionRequestId: 'request',
                localInputId: 'local', input, output: { kind: 'deployment_data_created', v: 1, source,
                    deleteAction: { pluginId: source.pluginId, localId: 'branches-delete' }, operands: {},
                    providerIdentity: { ...input.providerIdentity, providerEnvironment: 'child' },
                    providerEnvironment: { kind: 'custom', id: 'child' } } } } }] });
    const reads: string[] = [];
    const definition = await readPreviewCloseWorkflowForHost({ readEnvironments: async () => [child.environment],
        readEnvironment: async () => child,
        readInvocations: async ({ runId }) => { reads.push(runId); return page; } });
    expect(reads).toEqual(['creation-run']);
    expect(definition?.blocks).toMatchObject([
        { kind: 'action', actionId: 'deployments.teardown', input: {
            environmentId: { kind: 'literal', value: child.environment.id },
            targetLinkId: { kind: 'literal', value: dataLink.id },
            dataCreation: { kind: 'literal', value: { runId: 'creation-run', invocationId: index.id } },
        } },
        { kind: 'action', actionId: 'deployments.teardown', input: { removeEnvironment: { kind: 'literal', value: true } } },
    ]);
});
