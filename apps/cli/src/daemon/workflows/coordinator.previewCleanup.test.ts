import { expect, it } from 'vitest';
import { createActionExecutor } from '@happier-dev/protocol/actions';
import { ActionOperationSnapshotV1Schema } from '@happier-dev/protocol/actions/operations/v1';
import { DeploymentDeployInputV1Schema } from '@happier-dev/protocol/deployments/deploymentActionsV1';
import { DeploymentBindingsSetInputV1Schema } from '@happier-dev/protocol/deployments/deploymentBindingPatchV1';
import { DeploymentEnvironmentCreateInputV1Schema } from '@happier-dev/protocol/deployments/deploymentEnvironmentCreateV1';
import { createDeploymentEnvironmentHeaderV1, createDeploymentTargetLinkHeaderV1 } from '@happier-dev/deployment-protocol/testing/v1';
import { createDeploymentApprovalScopeResolverV1 } from '@happier-dev/protocol/deployments/deploymentApprovalScopeV1';
import type { ActionExecutorDeps } from '@happier-dev/protocol/actions';
import { createUnavailableActionTransportDeps } from '@/testkit/actionTransportDeps';
import { prepareWorkflowDeploymentResultCapture } from '@/deployments/targets/workflowDeploymentResult';
import { createInMemoryWorkflowCoordinatorStore, createTestWorkflowCoordinator } from './workflowCoordinator.testkit';
import { workflowInvocationKey } from './coordinator';

it.each(['immediate', 'reclaimed'] as const)('retains immutable %s native deploy output when review replaces the downstream result', async mode => {
    const actionId = 'deployments.deploy';
    const input = DeploymentDeployInputV1Schema.parse({ serverId: 'home', environmentId: 'preview-child',
        targetLinkId: 'preview-runtime', expectedRevision: 1, expectedTargetLinkRevision: 1,
        requestKey: 'preview-provision', contentArtifactId: 'candidate', contentHeaderVersion: 1, contentBodyVersion: 1,
        services: ['postgres'] });
    const previewCleanup = { machines: ['machine-a'], volumes: [{ name: 'preview_pg_data', disposition: 'delete', confirmation: 'preview_pg_data' }] };
    const result = { ok: true, environmentId: input.environmentId, revision: 2,
        deploymentId: 'provision-receipt', deploymentRevision: 1, state: 'succeeded', previewCleanup } as const;
    let effects = 0;
    // Deployment RPC is a genuine transport boundary; real Actions and Workflow owners run beneath it.
    const transport: NonNullable<ActionExecutorDeps['deploymentAction']> = async id => {
            if (id === 'deployments.environments.get') return { ok: true,
                environment: createDeploymentEnvironmentHeaderV1({ id: input.environmentId }),
                targetLinks: [createDeploymentTargetLinkHeaderV1({ id: 'preview-runtime', environmentId: input.environmentId })] };
            effects++;
            return result;
        };
    const executor = createActionExecutor({ ...createUnavailableActionTransportDeps(), deploymentAction: transport,
        resolveEnvironmentApprovalScope: createDeploymentApprovalScopeResolverV1(transport) });
    const store = createInMemoryWorkflowCoordinatorStore();
    const coordinator = createTestWorkflowCoordinator({ store,
        executeStep: async () => { throw new Error('Native provisioning has no Agent step'); },
        resolveWorkspace: async () => ({ ok: true, workspace: { machineId: 'machine-a', directory: '/repo', checkoutRootPath: '/repo' } }),
        action: { executor, prepareResultCapture: async id => prepareWorkflowDeploymentResultCapture(id),
            buildContext: async () => ({ surface: 'cli', authority: 'account_automation', bypassApprovals: true, serverId: 'home' }),
            observeOperation: async () => ActionOperationSnapshotV1Schema.parse({ version: 1,
                operationId: 'native-operation', revision: 1, actionId, state: 'succeeded',
                scope: { accountId: 'owner', machineId: 'machine-a' }, title: 'Provision preview PostgreSQL',
                createdAt: 1, startedAt: 2, settledAt: 3, cancellation: 'unsupported', result }),
            observeRun: async () => { throw new Error('Finite deploy has no awaited Run'); } } });
    const run = { runId: 'preview-native-creation', inputs: {}, executionTarget: { kind: 'session' as const },
        authorization: { principal: { kind: 'host' as const }, admittedPermissionCeiling: 'default' as const },
        definition: { version: 1 as const, inputs: [], defaults: {}, blocks: [{ kind: 'action' as const,
            id: 'provision', actionId, pauseForReview: true,
            input: Object.fromEntries(Object.entries(input).map(([name, value]) => [name, { kind: 'literal' as const, value }])) }] } };
    if (mode === 'reclaimed') {
        // Persisted invocation storage is the recovery boundary after the original host stops.
        const key = workflowInvocationKey({ runId: run.runId, blockId: 'provision', scope: [], attempt: 0 });
        await store.ensureIntent({ key, recordId: 'provision-record', acceptedAtMs: 1, runId: run.runId,
            blockId: 'provision', blockKind: 'action', path: { blockId: 'provision', scope: [] },
            attempt: 0, lifecycle: 'pending', memberOrdinal: '0' });
        await store.commitFact({ key, lifecycle: 'running', workspace: { descriptor: {
            machineId: 'machine-a', directory: '/repo', checkoutRootPath: '/repo' } },
            execution: { kind: 'action', actionId, input, actionRequestId: 'provision-request', localInputId: 'provision-input',
                output: { ok: true, environmentId: input.environmentId, revision: 1, kind: 'pending',
                    actionOperationId: 'native-operation', operation: { serverId: 'home', machineId: 'machine-a', operationId: 'native-operation' } },
                awaitedOperations: [{ key: 'deployment', serverId: 'home', machineId: 'machine-a', operationId: 'native-operation' }] } });
    }
    const first = await coordinator.run(run);
    expect(first, JSON.stringify({ first, invocations: store.list() })).toMatchObject({ state: 'waiting_for_review' });
    const row = store.list().find(row => row.blockId === 'provision');
    if (!row) throw new Error('Expected provisioning invocation');
    expect(row.execution).toMatchObject({ kind: 'action', output: result });
    await store.commitFact({ key: row.key, lifecycle: 'completed', result: { selected: 'review-result' } });
    expect(await coordinator.run(run)).toMatchObject({ state: 'succeeded' });
    expect(store.read(row.key)).toMatchObject({ result: { selected: 'review-result' },
        execution: { output: result } });
    expect(effects).toBe(mode === 'immediate' ? 1 : 0);
});

it('captures canonical restore outcomes without promoting rollback to verified restoration', () => {
    const capture = prepareWorkflowDeploymentResultCapture('deployments.backups.restore');
    expect(capture).toBeTypeOf('function');
    for (const result of [{ kind: 'restored', verified: true, nextAction: 'deploy', evidence: {} },
        { kind: 'rolledBack', verified: false, nextAction: 'review', evidence: {} }] as const) {
        expect(capture?.(result)).toEqual(result);
    }
    expect(capture?.({ kind: 'restored', verified: false, nextAction: 'deploy', evidence: {} })).toBeUndefined();
});

it('retains the actual companion connection after review replaces the binding result', async () => {
    const actionId = 'deployments.bindings.set';
    expect(prepareWorkflowDeploymentResultCapture(actionId)?.({ ok: false, error: 'deployment_conflict' })).toBeUndefined();
    const input = DeploymentBindingsSetInputV1Schema.parse({ serverId: 'home', environmentId: 'main-preview', expectedRevision: 3,
        set: [{ purpose: 'variable', phase: 'runtime', name: 'DB_HOST', source: { kind: 'reference',
            environmentId: 'data-companion', export: 'postgres', via: 'auto', component: 'host' } }], remove: [] });
    const result = { ok: true, environmentId: 'main-preview', revision: 4 } as const;
    // Binding persistence is the IO boundary; the public executor and coordinator remain real.
    const transport: NonNullable<ActionExecutorDeps['deploymentAction']> = async id => id === 'deployments.environments.get'
        ? { ok: true, environment: createDeploymentEnvironmentHeaderV1({ id: 'main-preview' }), targetLinks: [] } : result;
    const executor = createActionExecutor({ ...createUnavailableActionTransportDeps(), deploymentAction: transport,
        resolveEnvironmentApprovalScope: createDeploymentApprovalScopeResolverV1(transport) });
    const store = createInMemoryWorkflowCoordinatorStore();
    const coordinator = createTestWorkflowCoordinator({ store,
        executeStep: async () => { throw new Error('Binding connection has no Agent step'); },
        resolveWorkspace: async () => ({ ok: true, workspace: { machineId: 'machine-a', directory: '/repo', checkoutRootPath: '/repo' } }),
        action: { executor, prepareResultCapture: async id => prepareWorkflowDeploymentResultCapture(id),
            buildContext: async () => ({ surface: 'cli', authority: 'account_automation', bypassApprovals: true, serverId: 'home' }),
            observeRun: async () => { throw new Error('Binding connection has no awaited Run'); } } });
    const run = { runId: 'connection-run', inputs: {}, executionTarget: { kind: 'session' as const },
        authorization: { principal: { kind: 'host' as const }, admittedPermissionCeiling: 'default' as const },
        definition: { version: 1 as const, inputs: [], defaults: {}, blocks: [{ kind: 'action' as const,
            id: 'ordinary-binding-write', actionId, pauseForReview: true,
            input: Object.fromEntries(Object.entries(input).map(([name, value]) => [name, { kind: 'literal' as const, value }])) }] } };
    expect(await coordinator.run(run)).toMatchObject({ state: 'waiting_for_review' });
    const row = store.list().find(row => row.blockId === 'ordinary-binding-write');
    if (!row) throw new Error('Expected binding connection invocation');
    expect(row.execution).toMatchObject({ input, output: result });
    await store.commitFact({ key: row.key, lifecycle: 'completed', result: { ok: true, environmentId: 'review-edited', revision: 9 } });
    expect(await coordinator.run(run)).toMatchObject({ state: 'succeeded' });
    expect(store.read(row.key)).toMatchObject({ execution: { output: result }, result: { environmentId: 'review-edited' } });
});

it.each(['main', 'companion'] as const)('retains the actual created %s Environment after review replaces Create result', async kind => {
    const actionId = 'deployments.environments.create';
    const input = DeploymentEnvironmentCreateInputV1Schema.parse({ serverId: 'home', requestKey: 'companion-create',
        projectSourceId: 'project', purpose: 'standard', protection: 'nonProduction', deployerMode: 'managers',
        controllerMachineId: 'machine-a', contentArtifactId: 'child-content', contentHeaderVersion: 1, contentBodyVersion: 1 });
    const result = { ok: true as const, environmentId: kind, revision: 1, runtimeTargetLinkId: `${kind}-runtime`,
        ...(kind === 'main' ? { previewCompanionRequired: true as const } : { previewNativeData: [{ service: 'postgres', database: 'app' }] }) };
    // Environment creation transport is the boundary; the public executor and coordinator remain real.
    const transport: NonNullable<ActionExecutorDeps['deploymentAction']> = async () => result;
    const executor = createActionExecutor({ ...createUnavailableActionTransportDeps(), deploymentAction: transport,
        resolveEnvironmentApprovalScope: createDeploymentApprovalScopeResolverV1(transport) });
    const store = createInMemoryWorkflowCoordinatorStore();
    const coordinator = createTestWorkflowCoordinator({ store,
        executeStep: async () => { throw new Error('Environment creation has no Agent step'); },
        resolveWorkspace: async () => ({ ok: true, workspace: { machineId: 'machine-a', directory: '/repo', checkoutRootPath: '/repo' } }),
        action: { executor, prepareResultCapture: async id => prepareWorkflowDeploymentResultCapture(id),
            buildContext: async () => ({ surface: 'cli', authority: 'account_automation', bypassApprovals: true, serverId: 'home' }),
            observeRun: async () => { throw new Error('Environment creation has no awaited Run'); } } });
    const run = { runId: 'creation-run', inputs: {}, executionTarget: { kind: 'session' as const },
        authorization: { principal: { kind: 'host' as const }, admittedPermissionCeiling: 'default' as const },
        definition: { version: 1 as const, inputs: [], defaults: {}, blocks: [{ kind: 'action' as const,
            id: 'create', actionId, pauseForReview: true,
            input: Object.fromEntries(Object.entries(input).map(([name, value]) => [name, { kind: 'literal' as const, value }])) }] } };
    expect(await coordinator.run(run)).toMatchObject({ state: 'waiting_for_review' });
    const row = store.list().find(row => row.blockId === 'create');
    if (!row) throw new Error('Expected Create invocation');
    expect(row.execution).toMatchObject({ output: result });
    await store.commitFact({ key: row.key, lifecycle: 'completed', result: { ok: true, environmentId: 'review-edited', revision: 9 } });
    expect(await coordinator.run(run)).toMatchObject({ state: 'succeeded' });
    expect(store.read(row.key)).toMatchObject({ execution: { output: result }, result: { environmentId: 'review-edited' } });
});
