import { expect, it } from 'vitest';
import { createDeploymentEnvironmentDetailV1, createDeploymentTargetLinkHeaderV1, createDeploymentReceiptDetailV1 } from '@happier-dev/deployments/testing/v1';
import { WorkflowInvocationListResultV1Schema } from '@happier-dev/protocol/workflows/actionsV1';
import { readPreviewCloseWorkflowForHost } from './previewCloseWorkflowForHost';
import { DeploymentOwnServerContentV1Schema } from '@happier-dev/deployments/contracts/v1';
import { DeploymentTeardownInputV1Schema } from '@happier-dev/protocol/deployments/deploymentActionsV1';
import { DeploymentTeardownRequestInputV1Schema } from '@happier-dev/protocol/deployments/deploymentTeardownRequestV1';
import { resolveWorkflowActionFieldBinding } from '@/daemon/workflows/input';
import { createOwnServerTeardownForHost } from './targets/ownServer/teardown';
import { settleOwnServerTeardownVolumes } from './targets/ownServer/teardownVolumes';

it.each([false, true])('closes the named catalog companion and its captured volume (main already removed: %s)', async alreadyRemoved => {
    const main = createDeploymentEnvironmentDetailV1();
    main.environment.id = 'main-preview';
    main.environment.purpose = 'preview';
    main.environment.runtimeTargetLinkId = 'main-runtime';
    if (alreadyRemoved) main.environment.deletedAtMs = 1;
    const companion = createDeploymentEnvironmentDetailV1();
    companion.environment.id = 'data-companion';
    companion.environment.purpose = 'standard';
    companion.environment.runtimeTargetLinkId = 'data-runtime';
    companion.content.previewCreationRunId = 'shared-creation-run';
    const index = { id: 'companion-provision', runId: 'shared-creation-run', sequence: '0', parentRecordId: null,
        memberOrdinal: '0', attempt: '0', contentRevision: '0', lifecycle: 'completed',
        createdAt: '2026-11-10T00:00:00.000Z', updatedAt: '2026-11-10T00:00:01.000Z' };
    const cleanup = { machines: ['machine-a'], volumes: [{ name: 'companion_pg_data', disposition: 'delete', confirmation: 'companion_pg_data' }] };
    const page = WorkflowInvocationListResultV1Schema.parse({ invocations: [index], parentRevision: 1,
        invocationDetails: [{ index, parentRevision: 1, progress: { kind: 'happier.workflow-progress.v1', blockKind: 'action',
            invocationPath: { blockId: index.id, scope: [] }, attempt: '0', logicalInvocationRecordId: index.id,
            execution: { kind: 'action', actionId: 'deployments.deploy', actionRequestId: 'request', localInputId: 'local',
                input: { serverId: companion.environment.serverId, environmentId: companion.environment.id, targetLinkId: 'data-runtime', services: ['database'] },
                output: { ok: true, environmentId: companion.environment.id, revision: 2, deploymentId: 'data-receipt',
                    deploymentRevision: 1, state: 'succeeded', previewCleanup: cleanup } } } }] });
    const definition = await readPreviewCloseWorkflowForHost({ readEnvironments: async () => [main.environment],
        readCompanions: async environmentId => environmentId === main.environment.id ? [companion.environment] : [],
        readEnvironment: async id => id === companion.environment.id ? companion : main, readInvocations: async () => page });
    const actions = definition?.blocks.filter(block => block.kind === 'action');
    expect(actions).toMatchObject([
        { actionId: 'deployments.teardown', input: { environmentId: { kind: 'literal', value: companion.environment.id },
            volumes: { kind: 'literal', value: cleanup.volumes }, removeEnvironment: { kind: 'literal', value: true } } },
        ...(!alreadyRemoved ? [{ actionId: 'deployments.teardown', input: { environmentId: { kind: 'literal', value: main.environment.id },
            removeEnvironment: { kind: 'literal', value: true } } }] : []),
    ]);
    expect(actions).toHaveLength(alreadyRemoved ? 1 : 2);
});

it.each(['reviewed', 'omitted', 'approval-pending', 'foreign', 'other-child', 'other-target'] as const)('closes native previews through existing exact-volume teardown: %s', async selection => {
    const child = createDeploymentEnvironmentDetailV1();
    child.environment.purpose = 'preview';
    child.environment.controllerMachineId = 'controller-machine';
    const link = child.targetLinks[0].targetLink;
    link.machines = ['machine-a'];
    link.members = [{ machineId: 'machine-a', installationId: 'installation-a', state: 'active' }];
    const selectedName = selection === 'foreign' ? 'template_pg_data' : 'preview_pg_data';
    child.content.previewCreationRunId = 'native-creation-run';
    const cleanup = { machines: ['machine-a'], volumes: [{ name: selectedName, disposition: 'delete', confirmation: selectedName }] };
    const index = { id: 'native-provision', runId: 'native-creation-run', sequence: '0', parentRecordId: null,
        memberOrdinal: '0', attempt: '0', contentRevision: '0', lifecycle: selection === 'approval-pending' ? 'waiting_for_approval' : 'completed',
        createdAt: '2026-11-10T00:00:00.000Z', updatedAt: '2026-11-10T00:00:01.000Z' };
    const page = WorkflowInvocationListResultV1Schema.parse({ invocations: [index], parentRevision: 1,
        invocationDetails: [{ index, parentRevision: 1, progress: { kind: 'happier.workflow-progress.v1', blockKind: 'action',
            invocationPath: { blockId: 'native-provision', scope: [] }, attempt: '0', logicalInvocationRecordId: index.id,
            // A reviewed result is deliberately different: cleanup must consume the immutable effect output.
            result: { previewCleanup: { ...cleanup, volumes: [{ name: 'template_pg_data', disposition: 'delete', confirmation: 'template_pg_data' }] } },
            execution: { kind: 'action', actionId: 'deployments.deploy', actionRequestId: 'request', localInputId: 'local',
                input: { serverId: child.environment.serverId, environmentId: selection === 'other-child' ? 'another-child' : child.environment.id,
                    targetLinkId: selection === 'other-target' ? 'another-runtime' : link.id, services: ['postgres'] },
                ...(selection === 'omitted' ? {} : selection === 'approval-pending'
                    ? { output: { kind: 'approval_required', artifactId: 'deploy-approval', actionId: 'deployments.deploy' } }
                    : { output: { ok: true, environmentId: child.environment.id,
                    revision: child.environment.revision, deploymentId: 'native-receipt', deploymentRevision: 1,
                    state: 'succeeded', previewCleanup: cleanup } }) } } }] });
    const definition = await readPreviewCloseWorkflowForHost({ readEnvironments: async () => [child.environment],
        readEnvironment: async () => child, readInvocations: async () => page });
    const block = definition?.blocks[0];
    if (block?.kind !== 'action') throw new Error('Expected runtime teardown');
    const request = DeploymentTeardownRequestInputV1Schema.parse(Object.fromEntries(await Promise.all(Object.entries(block.input)
        .map(async ([name, binding]) => [name, await resolveWorkflowActionFieldBinding(binding,
            { inputs: {}, resolveResult: async () => { throw new Error('Unexpected result reference'); },
                resolveWorkspace: async () => { throw new Error('Unexpected workspace reference'); } })]))));
    const retained = selection === 'omitted' || selection === 'approval-pending' || selection === 'other-child' || selection === 'other-target';
    expect(request.volumes).toEqual(retained ? undefined
        : [{ name: selectedName, disposition: 'delete', confirmation: selectedName }]);
    expect(request.machines).toEqual(retained ? undefined : ['machine-a']);
    let candidate: ReturnType<typeof DeploymentOwnServerContentV1Schema.parse> | undefined;
    // Home records/Artifacts and the remote Machine transport are genuine IO boundaries.
    const teardown = createOwnServerTeardownForHost({ serverId: child.environment.serverId, machineId: 'controller-machine',
        credentials: { token: 'test-token', encryption: null }, serverHttpBaseUrl: 'https://unused-home.test',
        runtime: { async acquire() { throw new Error('Controller cannot acquire workload'); },
            async acquireTeardown() { throw new Error('Controller cannot acquire remote native target'); } },
        async readEnvironment() { return child; },
        async *readBuildHistory() { yield createDeploymentReceiptDetailV1(); },
        async readReceipt() { throw new Error('No receipt read required during preparation'); },
        async writeTransition() { throw new Error('No receipt transition during preparation'); },
        async findReceipt() { return null; },
        async createCandidate(_environment, content) {
            candidate = DeploymentOwnServerContentV1Schema.parse(content);
            return { contentArtifactId: 'candidate', contentHeaderVersion: 1, contentBodyVersion: 1 };
        },
        async sendChild() { return { ok: true, kind: 'preview', volumes: [
            { name: 'preview_pg_data', machineId: 'machine-a' }, { name: 'preview_logs', machineId: 'machine-a' },
        ] }; },
    });
    const prepared = await teardown.prepare({ input: request, context: {} });
    if (selection === 'foreign') {
        expect(prepared).toMatchObject({ ok: false, errorCode: 'deployment_conflict' });
        expect(candidate).toBeUndefined();
        return;
    }
    if (!('input' in prepared) || !candidate) throw new Error(`Expected teardown candidate: ${JSON.stringify(prepared)}`);
    expect(await teardown.admit(child, link.id, candidate, DeploymentTeardownInputV1Schema.parse(prepared.input), {})).toBeNull();
    const present = new Set(['preview_pg_data', 'preview_logs', 'template_pg_data']);
    // Docker commands are the native OS boundary; native selection/settlement remain real.
    expect(await settleOwnServerTeardownVolumes({ resources: candidate.teardown?.resources ?? [], run: async args => {
        if (args[0] === 'volume' && args[1] === 'ls') return { exitCode: 0, stdout: [...present].join('\n'), stderr: '' };
        if (args[0] === 'volume' && args[1] === 'rm') {
            for (const name of args.slice(2)) present.delete(name);
            return { exitCode: 0, stdout: '', stderr: '' };
        }
        throw new Error(`Unexpected native command ${args.join(' ')}`);
    } })).toBeNull();
    expect([...present]).toEqual(retained ? ['preview_pg_data', 'preview_logs', 'template_pg_data']
        : ['preview_logs', 'template_pg_data']);
});

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
