import { expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createActionExecutor, type ActionExecuteFailure } from '@happier-dev/protocol/actions';
import { createWorkflowAccountRunActionOwner, openWorkflowAcceptedSnapshotStoredEnvelopeV1,
  parseWorkflowStoredContentEnvelopeV1, sealWorkflowCheckpointStoredEnvelopeV1,
  serializeWorkflowStoredContentEnvelopeV1, type WorkflowAccountRunActionDeps } from '@happier-dev/protocol';
import { WorkflowRunGetResultV1Schema, WorkflowRunStartRequestV1Schema } from '@happier-dev/protocol/workflows/actionsV1';
import { ActionIdSchema } from '@happier-dev/protocol/actions/actionIds';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { actionSpecToActionDefinitionV1, freezeWorkflowActionContractV1 } from '@happier-dev/protocol/actions/actionCatalog';
import { createDeploymentApprovalScopeResolverV1 } from '@happier-dev/protocol/deployments/deploymentApprovalScopeV1';
import { createDeploymentEnvironmentHeaderV1 } from '@happier-dev/deployment-protocol/testing/v1';
import { createDeploymentTargetLinkHeaderV1 } from '@happier-dev/deployments/testing/v1';
import { DeploymentDeployInputV1Schema } from '@happier-dev/protocol/deployments/deploymentActionsV1';
import { DeploymentTeardownNothingDeployedInputV1Schema, DeploymentTeardownRequestInputV1Schema } from '@happier-dev/protocol/deployments/deploymentTeardownRequestV1';
import { createUnavailableActionTransportDeps } from '@/testkit/actionTransportDeps';
import { createWorkflowCoordinator } from './coordinator';
import { createInMemoryWorkflowCoordinatorStore, createTestWorkflowCoordinator } from './workflowCoordinator.testkit';
import { createPlainWorkflowRunKeyCensusFixture, createWorkflowRunStorageTestkit } from './workflowRunStorage.testkit';

it('keeps nothing-deployed teardown empty-only when its schema is materialized', () => {
  const input = { serverId: 'home', environmentId: 'preview', expectedRevision: 1, requestKey: 'close',
    targetLinkId: 'target', expectedTargetLinkRevision: 1, reason: 'previewClosed',
    nothingDeployed: true, removeEnvironment: true };
  expect(DeploymentTeardownNothingDeployedInputV1Schema.safeParse(input).success).toBe(true);
  expect(DeploymentTeardownNothingDeployedInputV1Schema.safeParse({ ...input, volumes: [] }).success).toBe(true);
  expect(DeploymentTeardownNothingDeployedInputV1Schema.safeParse({ ...input,
    volumes: [{ name: 'preview_pg_data', disposition: 'keep' }] }).success).toBe(false);
});

it.each(['machine_unavailable', 'RPC_FORBIDDEN', 'invalid_input'] as const)(
  'retains typed preparation failure %s and replays preview close only on explicit Retry', async errorCode => {
    const machineId = 'preview-machine', accountId = 'account-1';
    const runs = new Map<string, ReturnType<typeof createWorkflowRunStorageTestkit>>();
    const storage: WorkflowAccountRunActionDeps['storage'] = { execute: async (operation, options) => {
      const id = String(operation.runId);
      let run = runs.get(id);
      if (!run && operation.operation === 'get' && operation.prepareAdmission) {
        return { run: null, keyCensus: createPlainWorkflowRunKeyCensusFixture({ runId: id, accountId }) };
      }
      if (!run && operation.operation === 'admit') {
        run = createWorkflowRunStorageTestkit({ runId: id, accountId, machineId, origin: { kind: 'direct' } });
        runs.set(id, run);
      }
      if (!run) throw Object.assign(new Error('Missing Run'), { code: 'run_not_found' });
      return run.execute(operation, options);
    } };
    const owner = createWorkflowAccountRunActionOwner({ storage, resolveAccountId: async () => accountId,
      definitions: { get: async () => { throw new Error('Replay must retain accepted close'); } },
      resolveEncryption: async () => ({ kind: 'available', witness: { mode: 'plain', version: 1, contentKeyFingerprint: null } }),
      normalizeAbsolutePath: path => path.startsWith('/') ? path : null,
      randomBytes: () => { throw new Error('Plain Account'); },
      resolveMaterializationContext: async () => ({ effects: { resolveTargetAvailability: async () => true,
        readActionContract: async id => freezeWorkflowActionContractV1(actionSpecToActionDefinitionV1(getActionSpec(ActionIdSchema.parse(id)))) } }),
      prepareWorkspace: async () => ({ ok: true, workspaceTarget: { project: { machineId, directory: '/repo', checkoutRootPath: '/repo' } } }),
    });
    const input = DeploymentTeardownRequestInputV1Schema.parse({ serverId: 'home', environmentId: 'preview',
      reason: 'previewClosed', machines: [machineId], volumes: [{ name: 'preview_pg_data', disposition: 'delete', confirmation: 'preview_pg_data' }] });
    const definition = { version: 1, inputs: [], defaults: {}, blocks: [{ kind: 'action', id: 'close', actionId: 'deployments.teardown',
      input: Object.fromEntries(Object.entries(input).map(([key, value]) => [key, { kind: 'literal', value }])) }] };
    const context = { surface: 'cli' as const, authority: 'present_user' as const, callerPermissionMode: 'default' as const,
      serverId: 'home', externalActionTarget: { kind: 'machine' as const, machineId, project: { machineId, directory: '/repo' } } };
    const runId = randomUUID();
    await owner.execute({ actionId: 'workflow.run.start', input: WorkflowRunStartRequestV1Schema.parse({ runId,
      source: { kind: 'inline', definition } }), context });
    let offline = true, preparations = 0, teardownDispatches = 0;
    const failure = { ok: false, errorCode, error: errorCode, effectAttempted: false,
      failureCause: { phase: 'rpc.admission.machine', errorClass: 'Error',
        errorCode: errorCode === 'invalid_input' ? 'invalid_input' : 'machine_unavailable', httpStatus: 403 } } satisfies ActionExecuteFailure;
    // Only the deployment transport is replaced: the Action preparer, Workflow
    // coordinator, accepted-snapshot replay and storage readers remain real.
    const transport: NonNullable<Parameters<typeof createActionExecutor>[0]['deploymentAction']> = async id => {
      if (id === 'deployments.environments.get') {
        preparations++;
        return offline ? failure : { ok: true, environment: createDeploymentEnvironmentHeaderV1({ id: 'preview' }), targetLinks: [] };
      }
      teardownDispatches++;
      return { ok: true, environmentId: 'preview', revision: 1, nothingDeployed: true, environmentRemoved: true };
    };
    const execute = async (id: string) => {
      const persisted = await storage.execute({ operation: 'get', runId: id });
      const envelope = (persisted as { acceptedEnvelope: string }).acceptedEnvelope;
      const snapshot = openWorkflowAcceptedSnapshotStoredEnvelopeV1({ envelope: parseWorkflowStoredContentEnvelopeV1(envelope),
        mode: 'plain', binding: { v: 1, purpose: 'accepted_snapshot', accountId, runId: id } });
      const store = createInMemoryWorkflowCoordinatorStore();
      const executor = createActionExecutor({ ...createUnavailableActionTransportDeps(), deploymentAction: transport,
        resolveEnvironmentApprovalScope: createDeploymentApprovalScopeResolverV1(transport) });
      const coordinator = createWorkflowCoordinator({ store, executeStep: async () => { throw new Error('No Agent step'); },
        resolveWorkspace: async () => ({ ok: true, workspace: { machineId, directory: '/repo', checkoutRootPath: '/repo' } }),
        action: { executor, buildContext: async () => ({ surface: 'cli', authority: 'account_automation', bypassApprovals: true, serverId: 'home' }),
          observeRun: async () => { throw new Error('No Agent Run'); } } });
      if (snapshot.kind !== 'available') throw new Error(snapshot.kind);
      const result = await coordinator.run({ ...snapshot.content, runId: id });
      return { result, row: store.list().find(row => row.blockId === 'close') };
    };
    const first = await execute(runId);
    expect(first.result).toMatchObject({ state: 'failed', reason: failure.failureCause.errorCode });
    expect(first.row).toMatchObject({ lifecycle: 'failed', failureCause: failure.failureCause });
    if (errorCode !== 'invalid_input') expect(first.row?.reasonMessage).toMatch(/offline.*Retry/i);
    expect(first.row?.execution).toBeUndefined();
    expect(teardownDispatches).toBe(0);
    // The persisted parent transition is the storage boundary of the executor.
    const original = runs.get(runId)!;
    await original.execute({ operation: 'transition', runId, expectedRevision: original.run().revision,
      state: 'failed', custodyState: 'settled',
      checkpointEnvelope: serializeWorkflowStoredContentEnvelopeV1(sealWorkflowCheckpointStoredEnvelopeV1({ mode: 'plain',
        binding: { v: 1, purpose: 'checkpoint', accountId, runId },
        checkpoint: { kind: 'happier.workflow-checkpoint.v1', rootRecordId: randomUUID(),
          nextSequence: '2', frontier: { nextBlockOrdinal: 1, paused: false } } })) });
    const preparedBeforeReconnect = preparations;
    offline = false;
    expect(original.run().state).toBe('failed');
    expect(preparations).toBe(preparedBeforeReconnect);
    const detail = WorkflowRunGetResultV1Schema.parse(await owner.execute({ actionId: 'workflow.run.get', input: { runId }, context }));
    const retryId = randomUUID();
    await owner.execute({ actionId: 'workflow.run.start', input: WorkflowRunStartRequestV1Schema.parse({ runId: retryId,
      source: { kind: 'inline', definition: detail.authoredDefinition, replay: { runId } } }), context });
    const retry = await execute(retryId);
    expect(retry.result).toMatchObject({ state: 'succeeded' });
    expect(retry.row?.execution).toMatchObject({ input });
    expect(preparations).toBe(preparedBeforeReconnect + 1);
    expect(teardownDispatches).toBe(1);
  });

it('settles pre-effect deployments.deploy target refusal as failed/interrupted without replay instead of outcome_uncertain', async () => {
  const machineId = 'deploy-machine';
  const input = DeploymentDeployInputV1Schema.parse({
    serverId: 'home',
    environmentId: 'prod-env',
    targetLinkId: 'prod-target',
    expectedRevision: 8,
    expectedTargetLinkRevision: 1,
    requestKey: 'move-deploy-rate-limited',
    contentArtifactId: 'candidate',
    contentHeaderVersion: 1,
    contentBodyVersion: 1,
    services: ['web'],
  });
  const definition = {
    version: 1 as const,
    inputs: [],
    defaults: {},
    blocks: [{
      kind: 'action' as const,
      id: 'deploy',
      actionId: 'deployments.deploy',
      input: Object.fromEntries(Object.entries(input).map(([key, value]) => [key, { kind: 'literal' as const, value }])),
    }],
  };
  const details = {
    kind: 'deploymentImageResolutionFailure',
    service: 'web',
    reference: 'postgres:17',
    reason: 'deployment_image_rate_limited',
  } as const;
  const failureCause = {
    phase: 'deployment.native.image.registry.deployment_image_rate_limited',
    errorClass: 'Error',
    errorCode: 'deployment_image_rate_limited',
    httpStatus: null,
  } as const;
  const preEffectRefusal: ActionExecuteFailure = {
    ok: false,
    errorCode: 'native_failed',
    error: 'The registry rate limit prevented resolving image postgres:17 for service web.',
    effectAttempted: false,
    details,
    failureCause,
  };
  let deployCalls = 0;
  const transport: NonNullable<Parameters<typeof createActionExecutor>[0]['deploymentAction']> = async id => {
    if (id === 'deployments.environments.get') {
      return {
        ok: true,
        environment: createDeploymentEnvironmentHeaderV1({ id: input.environmentId, revision: 8 }),
        targetLinks: [createDeploymentTargetLinkHeaderV1({ id: input.targetLinkId, environmentId: input.environmentId })],
      };
    }
    deployCalls++;
    return preEffectRefusal;
  };
  const executor = createActionExecutor({
    ...createUnavailableActionTransportDeps(),
    deploymentAction: transport,
    resolveEnvironmentApprovalScope: createDeploymentApprovalScopeResolverV1(transport),
  });
  const store = createInMemoryWorkflowCoordinatorStore();
  const coordinator = createTestWorkflowCoordinator({
    store,
    executeStep: async () => { throw new Error('No Agent step'); },
    resolveWorkspace: async () => ({ ok: true, workspace: { machineId, directory: '/repo', checkoutRootPath: '/repo' } }),
    action: {
      executor,
      buildContext: async () => ({ surface: 'cli', authority: 'account_automation', bypassApprovals: true, serverId: 'home' }),
      observeRun: async () => { throw new Error('No Agent Run'); },
      observeOperation: async () => { throw new Error('No operation launched on pre-effect refusal'); },
    },
  });
  const runInput = {
    runId: randomUUID(),
    definition,
    inputs: {},
    executionTarget: { kind: 'session' as const },
    authorization: { principal: { kind: 'host' as const }, admittedPermissionCeiling: 'default' as const },
    originSessionId: 'origin',
  };
  const first = await coordinator.run(runInput);
  expect(first).toMatchObject({ state: 'interrupted', reason: 'native_failed' });
  expect(store.list().find(row => row.blockId === 'deploy')).toMatchObject({
    lifecycle: 'failed',
    reason: 'native_failed',
    reasonMessage: preEffectRefusal.error,
    result: details,
    failureCause,
  });
  expect(deployCalls).toBe(1);
  // Re-entering the same Run never auto-replays the failed attempt.
  expect(await coordinator.run(runInput)).toMatchObject({ state: 'interrupted', reason: 'native_failed' });
  expect(deployCalls).toBe(1);
});

it.each([
  ['missing effectAttempted', { ok: false, errorCode: 'native_failed', error: 'rate limited' } satisfies ActionExecuteFailure],
  ['effectAttempted true', { ok: false, errorCode: 'native_failed', error: 'rate limited', effectAttempted: true } satisfies ActionExecuteFailure],
  ['action_failed with effectAttempted false', { ok: false, errorCode: 'action_failed', error: 'action_failed', effectAttempted: false } satisfies ActionExecuteFailure],
  ['outcome_unknown with effectAttempted false', { ok: false, errorCode: 'outcome_unknown', error: 'outcome_unknown', effectAttempted: false } satisfies ActionExecuteFailure],
] as const)('keeps deployments.deploy failure in outcome_uncertain when %s and never replays', async (_label, failure) => {
  const machineId = 'deploy-machine';
  const input = DeploymentDeployInputV1Schema.parse({
    serverId: 'home',
    environmentId: 'prod-env',
    targetLinkId: 'prod-target',
    expectedRevision: 8,
    expectedTargetLinkRevision: 1,
    requestKey: 'move-deploy-ambiguous',
    contentArtifactId: 'candidate',
    contentHeaderVersion: 1,
    contentBodyVersion: 1,
    services: ['web'],
  });
  const definition = {
    version: 1 as const,
    inputs: [],
    defaults: {},
    blocks: [{
      kind: 'action' as const,
      id: 'deploy',
      actionId: 'deployments.deploy',
      input: Object.fromEntries(Object.entries(input).map(([key, value]) => [key, { kind: 'literal' as const, value }])),
    }],
  };
  let deployCalls = 0;
  const transport: NonNullable<Parameters<typeof createActionExecutor>[0]['deploymentAction']> = async id => {
    if (id === 'deployments.environments.get') {
      return {
        ok: true,
        environment: createDeploymentEnvironmentHeaderV1({ id: input.environmentId, revision: 8 }),
        targetLinks: [createDeploymentTargetLinkHeaderV1({ id: input.targetLinkId, environmentId: input.environmentId })],
      };
    }
    deployCalls++;
    return failure;
  };
  const executor = createActionExecutor({
    ...createUnavailableActionTransportDeps(),
    deploymentAction: transport,
    resolveEnvironmentApprovalScope: createDeploymentApprovalScopeResolverV1(transport),
  });
  const store = createInMemoryWorkflowCoordinatorStore();
  const coordinator = createTestWorkflowCoordinator({
    store,
    executeStep: async () => { throw new Error('No Agent step'); },
    resolveWorkspace: async () => ({ ok: true, workspace: { machineId, directory: '/repo', checkoutRootPath: '/repo' } }),
    action: {
      executor,
      buildContext: async () => ({ surface: 'cli', authority: 'account_automation', bypassApprovals: true, serverId: 'home' }),
      observeRun: async () => { throw new Error('No Agent Run'); },
      observeOperation: async () => { throw new Error('No operation snapshot'); },
    },
  });
  const runInput = {
    runId: randomUUID(),
    definition,
    inputs: {},
    executionTarget: { kind: 'session' as const },
    authorization: { principal: { kind: 'host' as const }, admittedPermissionCeiling: 'default' as const },
    originSessionId: 'origin',
  };
  expect(await coordinator.run(runInput)).toMatchObject({ state: 'outcome_uncertain' });
  expect(store.list().find(row => row.blockId === 'deploy')).toMatchObject({ lifecycle: 'outcome_uncertain' });
  expect(deployCalls).toBe(1);
  expect(await coordinator.run(runInput)).toMatchObject({ state: 'outcome_uncertain' });
  expect(deployCalls).toBe(1);
});
