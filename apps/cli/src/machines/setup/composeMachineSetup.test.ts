import { describe, expect, it, vi } from 'vitest';
import {
  MachineSetupApplyInputV1Schema, deriveWorkflowReplacementId, computeActionInputApprovalDigestV1,
  createWorkflowAccountRunActionOwner, materializeWorkflowAcceptedSnapshotV1,
  sealWorkflowAcceptedSnapshotStoredEnvelopeV1, sealWorkflowCheckpointStoredEnvelopeV1,
  sealWorkflowProgressStoredEnvelopeV1, serializeWorkflowStoredContentEnvelopeV1,
  ActionIdSchema, getActionSpec, type ActionExecutorContext,
} from '@happier-dev/protocol';
import { prepareWorkflowApprovedOperationSnapshot } from '@happier-dev/protocol/actions/executor/workflowRunActions';
import { actionSpecToActionDefinitionV1, freezeWorkflowActionContractV1 } from '@happier-dev/protocol/actions/actionCatalog';
import { ActionExecuteFailureSchema, projectActionFailureCauseV1, type ActionExecuteFailure, type ActionFailureCauseV1 } from '@happier-dev/protocol/actions/actionExecutionResult';
import { createHostActionOperationRuntime } from '@/daemon/actionOperations/createHostActionOperationRuntime';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { ActionOperationSnapshotV1Schema } from '@happier-dev/protocol/actions/operations/v1';
import { ActionOperationGetV1ResponseSchema as PredecessorGetSchema } from '@/daemon/actionOperations/testFixtures/predecessorActionOperationV1';
import { createActionOperationRunner } from '@/daemon/actionOperations/actionOperationRunner';
import { createActionOperationStore } from '@/daemon/actionOperations/actionOperationStore';
import { createActionOperationRpcHandlers } from '@/daemon/actionOperations/actionOperationRpcHandlers';
import { waitForMachineSetupOperationV1 } from '@happier-dev/protocol/machines/setup/waitForMachineSetupOperationV1';
import { createWorkflowRunStorageTestkit } from '@/daemon/workflows/workflowRunStorage.testkit';
import { DurableWorkflowCoordinatorStore } from '@/daemon/workflows/production';
import { workflowInvocationKey } from '@/daemon/workflows/coordinator';
import { observeWorkflowInvocationRecoveryEvidence } from '@/daemon/workflows/invocationRecoveryObserver';
import type { WorkflowJsonValue } from '@/daemon/workflows/input';
import { createUnavailableActionTransportDeps } from '@/testkit/actionTransportDeps';
import { createMachineSetupEffectPlan } from '@happier-dev/cli-common/machineSetup';
import { BACKUP_RECEIVER_RECIPE_REF_V1 } from '@happier-dev/protocol/machines/setup/machineRecipeReferenceV1';
import { buildMachineSetupWorkflow, createCombinedMachineSetupActionDeps } from './composeMachineSetup';
import { MachineSetupApplyResultV1Schema, MachineSetupPlanResultV1Schema, machineSetupApplyTargetFromPlanV1 } from '@happier-dev/protocol/machines/managed/actionsV1';
import axios from 'axios';
import { exercisePublicPackagePlanApply, withNativeConfirmation } from '@/testkit/machines/nativeSoftwareInstallFlow';

// The opaque Home storage boundary is faked; Run admission, content opening,
// invocation paging and setup composition all use their real owners.
async function retainedSetup(state: 'failed' | 'cancelled' | 'succeeded' | 'running' | 'interrupted', errorCode: string, details?: Record<string, WorkflowJsonValue>, readRefusalCode?: string, waitError?: Error | ActionExecuteFailure, pendingNative = false, failureCause?: ActionFailureCauseV1, receiver = false) {
  const accountId = 'actor', machineId = 'guest', rootId = 'setup-root';
  const selection = { ref: BACKUP_RECEIVER_RECIPE_REF_V1, inputs: {} };
  const receiverPlan = createMachineSetupEffectPlan({ basis: { kind: 'setup', machineId, desiredRevision: 0, selection }, steps: [], nativeFacts: [] });
  const input = MachineSetupApplyInputV1Schema.parse({ homeId: 'home', machineId, targets: [{
    homeId: 'home', machineId, desiredRevision: 0, sources: [{ kind: 'direct', setup: receiver ? { items: [{ kind: 'setupRecipe', selection }] } : {} }],
    exclusions: [], recipePlans: receiver ? [{ sourceIndex: 0, itemIndex: 0, plan: receiverPlan }] : [],
  }] });
  const runId = deriveWorkflowReplacementId(['machines.setup.apply', input.homeId, accountId, 'setup-request']);
  const definition = buildMachineSetupWorkflow(input);
  const context: ActionExecutorContext = { surface: 'cli', authority: 'present_user', actionCaller: { kind: 'host' },
    serverId: input.homeId, runtimeAccountId: accountId, actionRequestId: 'setup-request',
    approvedActionReplay: { artifactId: 'setup-approval' }, presentUserApproval: { artifactId: 'setup-approval',
      actionId: 'machines.setup.apply', requestId: 'setup-request', decidingAccountId: accountId,
      inputDigest: computeActionInputApprovalDigestV1('machines.setup.apply', input) },
    operationAcceptance: { actionId: 'machines.setup.apply', operationId: 'setup-operation', accept: () => {} } };
  const accepted = await materializeWorkflowAcceptedSnapshotV1({ definition,
    context: { source: { kind: 'inline' }, inputs: {}, machineId, executionTarget: { kind: 'session' },
      workspaceTarget: { project: { machineId, directory: '/setup', checkoutRootPath: '/setup' } },
      origin: { kind: 'direct' }, authorization: { principal: { kind: 'host' } } },
    admission: { kind: 'user' }, effects: { resolveTargetAvailability: async () => true,
      readActionContract: async id => freezeWorkflowActionContractV1(actionSpecToActionDefinitionV1(getActionSpec(ActionIdSchema.parse(id)))) } });
  if (!accepted.ok) throw new Error(accepted.error.code);
  const snapshot = await prepareWorkflowApprovedOperationSnapshot({ snapshot: accepted.snapshot,
    parent: { actionId: 'machines.setup.apply', input },
    steps: [{ actionId: 'machines.setup.apply', input: { homeId: input.homeId, machineId, targets: input.targets } }], context });
  const storage = createWorkflowRunStorageTestkit({ accountId, runId, machineId, origin: { kind: 'direct' },
    invocationPageSize: 1, acceptedEnvelope: serializeWorkflowStoredContentEnvelopeV1(sealWorkflowAcceptedSnapshotStoredEnvelopeV1({
      mode: 'plain', binding: { v: 1, purpose: 'accepted_snapshot', accountId, runId }, acceptedSnapshot: snapshot })) });
  const checkpoint = { kind: 'happier.workflow-checkpoint.v1' as const, rootRecordId: rootId,
    nextSequence: '1', frontier: { nextBlockOrdinal: 0, paused: false } };
  await storage.execute({ operation: 'initialize', runId, expectedRevision: 0,
    checkpointEnvelope: serializeWorkflowStoredContentEnvelopeV1(sealWorkflowCheckpointStoredEnvelopeV1({ mode: 'plain',
      binding: { v: 1, purpose: 'checkpoint', accountId, runId }, checkpoint })),
    rootInvocation: { id: rootId, contentEnvelope: serializeWorkflowStoredContentEnvelopeV1(sealWorkflowProgressStoredEnvelopeV1({
      mode: 'plain', binding: { v: 1, purpose: 'invocation_progress', accountId, runId, recordId: rootId,
        sequence: '0', parentRecordId: null, memberOrdinal: '0', attempt: '0' },
      progress: { kind: 'happier.workflow-progress.v1', blockKind: 'root', attempt: '0',
        invocationPath: { blockId: '$root', scope: [] }, logicalInvocationRecordId: rootId } })) } });
  const witness = { mode: 'plain' as const, version: 1, contentKeyFingerprint: null };
  const store = await DurableWorkflowCoordinatorStore.load({ accountId, runId, parentAttempt: 0,
    rootRecordId: rootId, checkpoint, encryption: { witness, runCrypto: { mode: 'plain' } }, storage,
    revision: storage.run().revision });
  const lifecycle = state === 'succeeded' ? 'completed' : state === 'interrupted' ? 'failed' : state;
  const key = workflowInvocationKey({ runId, blockId: 'setup-0', scope: [], attempt: 0 });
  await store.ensureIntent({ key, recordId: 'setup-child', runId, blockId: 'setup-0', memberOrdinal: '0',
    parentKey: workflowInvocationKey({ runId, blockId: '$root', scope: [], attempt: 0 }),
    path: { blockId: 'setup-0', scope: [] }, blockKind: 'action', attempt: 0, acceptedAtMs: Date.now(), lifecycle: 'pending' });
  const native = ActionOperationSnapshotV1Schema.safeParse(details?.operation);
  await store.commitFact({ key, lifecycle: pendingNative ? 'running' : lifecycle, reason: errorCode,
    ...(state === 'interrupted' && native.success ? { execution: {
      kind: 'action' as const, actionId: 'machines.setup.apply', actionRequestId: 'native-request',
      localInputId: 'native-invocation', input,
      awaitedOperations: [{ key: 'setup', serverId: input.homeId, machineId, operationId: native.data.operationId }],
    } } : {}),
    ...(failureCause ? { failureCause } : {}),
    ...(details === undefined ? {} : { result: details }) });
  await store.commitFact({ key: workflowInvocationKey({ runId, blockId: '$root', scope: [], attempt: 0 }), lifecycle });
  await storage.execute({ operation: 'transition', runId, expectedRevision: storage.run().revision,
    state, ...(!pendingNative && state !== 'running' && state !== 'interrupted' ? { custodyState: 'settled' as const } : {}),
    checkpointEnvelope: storage.checkpointEnvelope() });
  let nativeReadUnavailable = false;
  const reader = createWorkflowAccountRunActionOwner({ resolveAccountId: async () => accountId,
    storage: { ...storage, execute: async (operation, options) => {
      if (operation.operation === 'wait' && waitError instanceof Error) throw waitError;
      return storage.execute(operation, options);
    } },
    definitions: { get: async () => { throw new Error('inline_run_has_no_saved_definition'); } },
    resolveEncryption: async () => ({ kind: 'available', witness }), normalizeAbsolutePath: directory => directory,
    randomBytes: () => { throw new Error('plain_account_has_no_keys'); },
    observeRecovery: async ({ progress }) => await observeWorkflowInvocationRecoveryEvidence({ runId, machineId,
      credentials: { token: 'fixture', encryption: null }, progress,
      getOperation: async target => {
        if (nativeReadUnavailable) throw new Error('machine_unreachable');
        return native.success && native.data.operationId === target.operationId
          ? { kind: 'found', operation: native.data } : { kind: 'not_found' };
      },
      getRun: async () => { throw new Error('Native Setup uses an Action Operation'); },
    }) });
  const deps = createCombinedMachineSetupActionDeps({ readDeps: createUnavailableActionTransportDeps,
    targetPlan: async () => { throw new Error('reviewed_exclusions_already_present'); },
    readHostFacts: async () => ({ machines: [{ machineId, online: true }] }), orchestrationDirectory: '/setup',
    startCombined: reader.startCombined,
    // The Action transport can refuse before the retained Run reader is reached.
    waitForRun: request => waitError && !(waitError instanceof Error) ? Promise.resolve(waitError)
      : reader.waitCombined(request),
    // This host port is the external Action transport boundary; a refused read
    // supplies no retained child content for the composition owner to interpret.
    readInvocations: (_request, read) => readRefusalCode
      ? Promise.resolve(ActionExecuteFailureSchema.parse({ ok: false, errorCode: readRefusalCode, error: readRefusalCode }))
      : reader.execute({ ...read, context }),
  });
  const readRecovery = () => reader.execute({ actionId: 'workflow.run.invocations.get',
    input: { runId, invocationId: 'setup-child' }, context });
  return { apply: () => deps.machineSetupApply!({ input, context }), input, context, deps, runId, storage, store, key, readRecovery,
    disconnectNativeOperationRead: () => { nativeReadUnavailable = true; } };
}

describe('Combined Machine setup child settlement', () => {
  it.each([true, false])('observes a declared Agent failure as stopped only with terminal installer evidence (receipt: %s)', async terminal => {
    const outcome = { kind: 'failed', code: 'rate_limited', stepId: 'cli.pi', message: 'Registry rate limited' };
    const machineId = 'guest';
    const observed = await observeWorkflowInvocationRecoveryEvidence({
      runId: 'run', machineId, credentials: { token: 'fixture', encryption: null },
      progress: { kind: 'happier.workflow-progress.v1', blockKind: 'action', attempt: '0',
        invocationPath: { blockId: 'app-0-0', scope: [] }, logicalInvocationRecordId: 'install-child',
        execution: { kind: 'action', actionId: 'machines.agents.install', actionRequestId: 'run/install-child/0',
          localInputId: 'run/install-child/0', input: { machineId, agentId: 'pi', intent: 'install', waitForTerminal: true } },
        reason: { code: 'native_effect_failed' }, result: terminal ? { jobId: 'pi-1', outcome } : { jobId: 'pi-1' },
      },
      getRun: async () => { throw new Error('Agent installation has no Execution Run'); },
    });
    expect(observed.activity).toBe(terminal ? 'not_active' : 'unknown');
  });

  it.skipIf(process.platform === 'win32')('keeps the admitted Apply credential for a nested opaque-source Plan', async () => {
    await exercisePublicPackagePlanApply('native-confirm', false, async fixture => {
      const target = { homeId: 'srv_home', machineId: fixture.machine.id };
      const source = { kind: 'accountPresetOpaque' as const, presetId: 'saved', presetRevision: 1,
        contentEncryptionMode: 'plain' as const };
      const direct = { kind: 'direct' as const, setup: {} };
      const sources = [source, direct];
      const resolvedSources = [{ ...source, presetContent: { content: { t: 'plain' as const,
        v: { v: 1, name: 'Saved setup', setup: {} } }, recipientEnvelope: null } }, direct];
      const homePost = vi.mocked(axios.post).getMockImplementation();
      if (!homePost) throw new Error('Expected public Setup Home boundary');
      let presetReads = 0;
      // Only Home's saved-preset storage response is specialized. The public
      // Action, requester sealing, Machine RPC and installed receiver stay real.
      vi.mocked(axios.post).mockImplementation(async (url, body, options) => {
        if (new URL(String(url)).pathname !== '/v1/machines/setup/resolve') return homePost(url, body, options);
        presetReads += 1;
        expect(body).toEqual({ ...target, candidatePreset: { presetId: source.presetId, presetRevision: 1 } });
        return { status: 200, data: { sources: resolvedSources } };
      });
      const planned = await fixture.publicExecutor.execute('machines.setup.plan', { ...target, sources, mode: 'effects' },
        fixture.context('machines.setup.plan', 'opaque-plan'));
      expect(planned, JSON.stringify(planned)).toMatchObject({ ok: true });
      if (!planned.ok) throw new Error('Opaque preset Plan was refused');
      const plan = MachineSetupPlanResultV1Schema.parse(planned.result);
      expect(plan.sources).toEqual(sources);
      expect(plan.resolvedSources).toEqual(resolvedSources);
      const planPresetReads = presetReads;
      expect(planPresetReads).toBeGreaterThan(0);
      const input = MachineSetupApplyInputV1Schema.parse({ ...target,
        targets: [machineSetupApplyTargetFromPlanV1(target, plan)] });
      const context = fixture.context('machines.setup.apply', 'opaque-apply');
      const applied = await fixture.publicExecutor.execute('machines.setup.apply', input,
        withNativeConfirmation('machines.setup.apply', input, context));
      expect(applied, JSON.stringify(applied)).toMatchObject({ ok: true });
      if (!applied.ok) throw new Error('Opaque preset Apply was refused');
      // Apply's admitted re-Plan must resolve the opaque source again through
      // requester custody rather than accepting an unconditional target Plan.
      expect(presetReads).toBeGreaterThan(planPresetReads);
      const receipt = MachineSetupApplyResultV1Schema.parse(applied.result);
      const retained = await fixture.operations.handlers.getV2({ operationId: receipt.operationId }, context);
      expect(retained, JSON.stringify(retained)).toMatchObject({ kind: 'found', operation: {
        actionId: 'machines.setup.apply', requestId: 'opaque-apply',
        actor: { actorKind: 'person', accountId: 'alice' },
        scope: { accountId: 'alice', machineId: fixture.machine.id },
      } });
    }, undefined, undefined, 'plain');
  });
  it('settles an interrupted Setup from its exact retained terminal native failure when a fresh Machine read fails', async () => {
    const child = { version: 1, operationId: 'native-child', revision: 5, requestId: 'native-request',
      actionId: 'machines.setup.apply', state: 'failed', scope: { accountId: 'actor', machineId: 'guest' },
      title: 'Set up machine', createdAt: 1, startedAt: 2, settledAt: 3, cancellation: 'unsupported',
      error: { errorCode: 'terminal_spawn_failed', error: 'terminal_spawn_failed' } } as const;
    ActionOperationSnapshotV1Schema.parse(child);
    const fixture = await retainedSetup('interrupted', 'terminal_spawn_failed', { operation: child });
    expect(await fixture.storage.execute({ operation: 'wait', runId: fixture.runId,
      conditions: ['terminal', 'attention'] })).toMatchObject({ observation: 'waiting',
      run: { state: 'interrupted', workflowCustodyState: 'pending', attentionRequired: false } });
    expect((await fixture.store.read(fixture.key))?.result).toEqual({ operation: child });
    fixture.disconnectNativeOperationRead();
    const detail = await fixture.readRecovery();
    expect(detail, JSON.stringify(detail)).toMatchObject({ invocation: { recoveryAvailability: { retry: { kind: 'available' } } } });
    const store = createActionOperationStore();
    const spec = getActionSpec('machines.setup.apply');
    const scope = { accountId: 'actor', machineId: 'guest' };
    const runner = createActionOperationRunner({ store, generateOperationId: () => 'setup-operation',
      resolveAction: () => ({ actionId: spec.id, title: spec.title, operation: spec.operation! }) });
    const controller = new AbortController();
    let observed: unknown;
    const observation = runner.observe({ actionId: spec.id, scope, requestId: 'setup-request',
      execute: async () => ActionExecuteFailureSchema.parse(await fixture.deps.machineSetupApply!({
        input: fixture.input, context: { ...fixture.context, signal: controller.signal } })) })
      .then(value => { observed = value; });
    try {
      await vi.waitFor(() => expect(observed, JSON.stringify(observed)).toMatchObject({ ok: false, errorCode: 'terminal_spawn_failed' }));
      const setupRetry = { runId: fixture.runId, invocationId: 'setup-child' };
      expect(observed).toEqual({ ok: false, errorCode: 'terminal_spawn_failed', error: 'terminal_spawn_failed', setupRetry });
      const operation = store.get(scope, 'setup-operation');
      expect(operation).toMatchObject({ state: 'failed', error: {
        errorCode: 'terminal_spawn_failed', setupRetry: { runId: fixture.runId, invocationId: 'setup-child' },
      } });
      expect(operation?.error?.details).toBeUndefined();
      const handlers = createActionOperationRpcHandlers({ store, runner, machineId: scope.machineId,
        resolveAccountId: async () => scope.accountId });
      expect(await waitForMachineSetupOperationV1('setup-operation', request => handlers.getV2(request))).toEqual({
        ok: false, errorCode: 'terminal_spawn_failed', error: 'terminal_spawn_failed', setupRetry,
      });
    } finally {
      controller.abort();
      await observation;
    }
  });
  it('retains settled receiver evidence through the completed native child and root setup result', async () => {
    const backupReceivers = [{ sourceIndex: 0, itemIndex: 0, machineId: 'guest', installationId: 'receiver-installation',
      status: 'ready', endpoint: { host: 'receiver.example', port: 2205 }, username: 'archive', path: '/repository',
      hostKey: '[receiver.example]:2205 ssh-ed25519 AAAA', fingerprint: 'SHA256:fixture' }];
    const operation = { version: 1, operationId: 'child-operation', revision: 2,
      actionId: 'machines.setup.apply', state: 'succeeded', scope: { accountId: 'actor', machineId: 'guest' },
      title: 'Set up machine', createdAt: 1, startedAt: 1, settledAt: 2, cancellation: 'supported',
      result: { operationId: 'child-operation', backupReceivers } };
    const fixture = await retainedSetup('succeeded', 'completed', { operation },
      undefined, undefined, false, undefined, true);
    expect(await fixture.apply()).toMatchObject({ operationId: 'setup-operation', runId: fixture.runId, backupReceivers });
  });

  it.each(['failed', 'running', 'cancelled'] as const)('retains root recovery links alongside native details for a %s receiver setup', async state => {
    const details = { operationId: 'native-operation', stepId: 'receiver-policy' };
    const fixture = await retainedSetup(state, 'native_effect_failed', details, undefined,
      state === 'running' ? new Error('observer unavailable') : undefined, false, undefined, true);
    expect(await fixture.apply()).toMatchObject({ ok: false, details: {
      setupOperation: { operationId: 'setup-operation', runId: fixture.runId },
      ...(state === 'failed' ? details : {}),
    } });
  });
  it.each<{ errorCode: string; details: Record<string, WorkflowJsonValue> }>([
    { errorCode: 'machine_setup_setup_failed', details: { kind: 'finiteCommand', phase: 'setup', step: 1, exitCode: 23, signal: 0 } },
    { errorCode: 'native_effect_failed', details: { kind: 'machineSetup',
      failure: { kind: 'native_effect_failed', reason: 'native_effect_failed' } } },
    { errorCode: 'target_unavailable', details: { reason: 'machine_offline',
      requiredFact: 'machine_online', remedy: 'reconnect_machine' } },
  ])('retains the child $errorCode facts through stored Workflow content and the parent operation', async ({ errorCode, details }) => {
    const failureCause = projectActionFailureCauseV1(Object.assign(new Error('denied'), { code: 'EACCES' }), 'machines.setup.apply');
    const fixture = await retainedSetup('failed', errorCode, details, undefined, undefined, false, failureCause);
    const store = createActionOperationStore();
    const spec = getActionSpec('machines.setup.apply');
    const scope = { accountId: 'actor', machineId: 'guest' };
    const runner = createActionOperationRunner({ store, generateOperationId: () => 'setup-operation',
      resolveAction: () => ({ actionId: spec.id, title: spec.title, operation: spec.operation! }) });
    await runner.observe({ actionId: spec.id, scope, requestId: 'setup-request',
      execute: async () => ActionExecuteFailureSchema.parse(await fixture.apply()) });
    expect(store.get(scope, 'setup-operation')).toMatchObject({ state: 'failed',
      error: { errorCode, details, failureCause } });
    const retained = ActionOperationSnapshotV1Schema.parse(JSON.parse(JSON.stringify(store.get(scope, 'setup-operation'))));
    const restartedStore = createActionOperationStore();
    restartedStore.project(retained);
    const restartedRunner = createActionOperationRunner({ store: restartedStore,
      resolveAction: () => ({ actionId: spec.id, title: spec.title, operation: spec.operation! }) });
    const operations = createActionOperationRpcHandlers({ store: restartedStore, runner: restartedRunner,
      machineId: scope.machineId, resolveAccountId: async () => scope.accountId });
    expect(await waitForMachineSetupOperationV1('setup-operation', request => operations.getV2(request)))
      .toMatchObject({ ok: false, errorCode, details, failureCause });
  });
  it('keeps an interrupted Setup uncertain while its current native child has no terminal outcome', async () => {
    const fixture = await retainedSetup('running', 'outcome_uncertain');
    await fixture.store.commitFact({ key: fixture.key, lifecycle: 'outcome_uncertain', reason: 'outcome_uncertain' });
    await fixture.store.commitFact({ key: workflowInvocationKey({ runId: fixture.runId, blockId: '$root', scope: [], attempt: 0 }),
      lifecycle: 'outcome_uncertain' });
    await fixture.storage.execute({ operation: 'transition', runId: fixture.runId,
      expectedRevision: fixture.storage.run().revision, state: 'interrupted', checkpointEnvelope: fixture.storage.checkpointEnvelope() });
    expect(fixture.storage.run()).toMatchObject({ state: 'interrupted', workflowCustodyState: 'pending', attentionRequired: true });
    expect(await fixture.apply()).toMatchObject({ ok: false, errorCode: 'outcome_uncertain', details: { runId: fixture.runId } });
    expect(fixture.store.read(fixture.key)).toMatchObject({ lifecycle: 'outcome_uncertain' });
  });
  it('retains the combined observer until a cancelled Run settles its native custody', async () => {
    const fixture = await retainedSetup('cancelled', 'cancelled', undefined, undefined, undefined, true);
    const controller = new AbortController();
    const observed = fixture.deps.machineSetupApply!({ input: fixture.input,
      context: { ...fixture.context, signal: controller.signal } });
    try {
      await vi.waitFor(() => expect(fixture.storage.operations()).toContain('wait'));
      await fixture.store.commitFact({ key: fixture.key, lifecycle: 'cancelled', reason: 'cancelled' });
      await fixture.storage.execute({ operation: 'transition', runId: fixture.runId,
        expectedRevision: fixture.storage.run().revision, state: 'cancelled', custodyState: 'settled',
        checkpointEnvelope: fixture.storage.checkpointEnvelope() });
      expect(await observed).toMatchObject({ ok: false, errorCode: 'cancelled' });
    } finally {
      controller.abort();
      await observed;
    }
  });
  it('keeps a lost Workflow observation nonterminal through operation projection and restart', async () => {
    const fixture = await retainedSetup('running', 'native_effect_failed', undefined, undefined,
      Object.assign(new Error('socket closed'), { code: 'ECONNRESET' }));
    const store = createActionOperationStore();
    const spec = getActionSpec('machines.setup.apply');
    const scope = { accountId: 'actor', machineId: 'guest' };
    const runner = createActionOperationRunner({ store, generateOperationId: () => 'setup-operation',
      resolveAction: () => ({ actionId: spec.id, title: spec.title, operation: spec.operation! }) });
    const result = await runner.observe({ actionId: spec.id, scope, requestId: 'setup-request',
      execute: async () => ActionExecuteFailureSchema.parse(await fixture.apply()) });
    expect(result).toMatchObject({ ok: false, errorCode: 'outcome_uncertain',
      details: { runId: fixture.runId }, failureCause: { phase: 'workflow.run.wait', errorCode: 'storage_unavailable' } });
    expect(store.get(scope, 'setup-operation')).toMatchObject({ state: 'running',
      observation: { kind: 'outcome_uncertain' },
      error: { errorCode: 'outcome_uncertain',
        failureCause: { phase: 'workflow.run.wait', errorCode: 'storage_unavailable' } } });
    const retained = ActionOperationSnapshotV1Schema.parse(JSON.parse(JSON.stringify(store.get(scope, 'setup-operation'))));
    const restartedStore = createActionOperationStore();
    restartedStore.project(retained);
    const restartedRunner = createActionOperationRunner({ store: restartedStore,
      resolveAction: () => ({ actionId: spec.id, title: spec.title, operation: spec.operation! }) });
    const operations = createActionOperationRpcHandlers({ store: restartedStore, runner: restartedRunner,
      machineId: scope.machineId, resolveAccountId: async () => scope.accountId });
    const predecessor = PredecessorGetSchema.parse(await operations.get({ operationId: 'setup-operation' }));
    expect(predecessor).toMatchObject({ kind: 'found', operation: { state: 'running' } });
    if (predecessor.kind === 'found') expect(predecessor.operation.error).toBeUndefined();
    expect(await operations.getV2({ operationId: 'setup-operation' })).toMatchObject({ kind: 'found',
      operation: { error: { error: expect.stringContaining('Workflow Run'),
        failureCause: { phase: 'workflow.run.wait', errorCode: 'storage_unavailable' } } } });
    expect(await waitForMachineSetupOperationV1('setup-operation', request => operations.getV2(request)))
      .toMatchObject({ ok: false, errorCode: 'outcome_uncertain', error: expect.stringContaining('Workflow Run'),
        failureCause: { phase: 'workflow.run.wait', errorCode: 'storage_unavailable' } });
  });
  it('retains the typed wait refusal when the transport supplies no exception cause', async () => {
    const fixture = await retainedSetup('running', 'native_effect_failed', undefined, undefined,
      { ok: false, errorCode: 'forbidden', error: 'forbidden' });
    expect(await fixture.apply()).toMatchObject({ ok: false, errorCode: 'outcome_uncertain',
      failureCause: { phase: 'workflow.run.wait', errorCode: 'forbidden' } });
  });
  it('exposes retained uncertainty and truthful cancellation through the real Action entry', async () => {
    const fixture = await retainedSetup('running', 'native_effect_failed', undefined, undefined,
      Object.assign(new Error('socket closed'), { code: 'ECONNRESET' }));
    const runtime = createHostActionOperationRuntime({ machineId: 'guest', resolveAccountId: async () => 'actor',
      generateOperationId: () => 'setup-operation' });
    const executor = createActionExecutor({ ...createUnavailableActionTransportDeps(), ...fixture.deps,
      runActionOperation: runtime.runActionOperation });
    const { operationAcceptance: _acceptance, ...context } = fixture.context;
    const accepted = await executor.execute('machines.setup.apply', fixture.input, { ...context,
      surface: 'ui', presentUserConfirmation: { actionId: 'machines.setup.apply' } });
    expect(accepted, JSON.stringify(accepted))
      .toMatchObject({ ok: true, result: { operationId: 'setup-operation', runId: fixture.runId } });
    const response = await runtime.handlers.getV2({ operationId: 'setup-operation', waitForTerminal: true });
    expect(response).toMatchObject({ kind: 'found', operation: { state: 'running', cancellation: 'unsupported',
      error: { errorCode: 'outcome_uncertain', failureCause: { phase: 'workflow.run.wait', errorCode: 'storage_unavailable' } } } });
    expect(runtime.runner.cancel({ accountId: 'actor', machineId: 'guest' }, 'setup-operation'))
      .toEqual({ kind: 'unsupported' });
  });

  it.each([
    { actionId: 'machines.setup.apply', errorCode: 'target_unavailable', reason: 'credentials' },
    { actionId: 'machines.setup.apply', errorCode: 'native_check_unavailable', reason: 'required_fact_unavailable' },
    { actionId: 'machines.setup.apply', errorCode: 'native_effect_failed', reason: 'required_fact_unavailable' },
    { actionId: 'machines.setup.apply', errorCode: 'outcome_unknown', reason: 'native_effect_failed' },
    { actionId: 'machines.setup.remove', errorCode: 'outcome_unknown', reason: 'native_effect_failed' },
    { actionId: 'machines.setup.updates.apply', errorCode: 'outcome_unknown', reason: 'native_effect_failed' },
  ] as const)('retains the closed $errorCode diagnostic through Workflow and $actionId', async ({ actionId, errorCode, reason }) => {
    const details: Record<string, WorkflowJsonValue> = errorCode === 'target_unavailable' ? { kind: 'machineSetup', failure: {
      kind: errorCode, phase: 'machine_setup_target', branch: 'installed_runtime', reason,
    } } : { kind: 'machineSetup', failure: {
      kind: errorCode === 'native_check_unavailable' ? errorCode : 'native_effect_failed', reason,
      ...(errorCode === 'native_check_unavailable' ? { requiredFact: 'administratorIdentity',
        remedy: 'Check administratorIdentity with administrator access, then retry.' } : {}),
    } };
    const fixture = await retainedSetup('failed', errorCode, details);
    const store = createActionOperationStore();
    const spec = getActionSpec(actionId);
    const scope = { accountId: 'actor', machineId: 'guest' };
    const runner = createActionOperationRunner({ store, generateOperationId: () => 'setup-operation',
      resolveAction: () => ({ actionId: spec.id, title: spec.title, operation: spec.operation! }) });
    await runner.observe({ actionId: spec.id, scope, requestId: 'setup-request',
      execute: async () => ActionExecuteFailureSchema.parse(await fixture.apply()) });
    expect(store.get(scope, 'setup-operation')).toMatchObject({ state: 'failed',
      error: { errorCode, error: errorCode, details } });
  });
  it('retains the classified refusal when the failed-child content read is refused', async () => {
    const fixture = await retainedSetup('failed', 'native_effect_failed', undefined, 'permission_denied');
    expect(await fixture.apply()).toEqual({ ok: false, errorCode: 'permission_denied', error: 'permission_denied' });
  });

  it.each<{ errorCode: string; details: Record<string, string | number> }>([
    { errorCode: 'required_fact_unavailable', details: { requiredFact: 'packageManagerLocks', remedy: 'check_with_administrator' } },
    { errorCode: 'native_effect_failed', details: { stepId: 'package-apt', exitCode: 100 } },
  ])('surfaces the retained $errorCode child cause through the parent operation', async ({ errorCode, details }) => {
    const fixture = await retainedSetup('failed', errorCode, details);
    const store = createActionOperationStore();
    const spec = getActionSpec('machines.setup.apply');
    const scope = { accountId: 'actor', machineId: 'guest' };
    const runner = createActionOperationRunner({ store, generateOperationId: () => 'setup-operation',
      resolveAction: () => ({ actionId: spec.id, title: spec.title, operation: spec.operation! }) });
    expect(await runner.observe({ actionId: spec.id, scope, requestId: 'setup-request',
      execute: async () => ActionExecuteFailureSchema.parse(await fixture.apply()) }))
      .toEqual({ ok: false, errorCode, error: errorCode, details });
    expect(store.get(scope, 'setup-operation')).toMatchObject({ state: 'failed', error: { errorCode, error: errorCode } });
  });

  it.each(['cancelled', 'succeeded'] as const)('preserves %s without reading failed-child content', async state => {
    const fixture = await retainedSetup(state, 'native_effect_failed');
    const result = await fixture.apply();
    expect(result).toEqual(state === 'succeeded' ? { operationId: 'setup-operation', runId: fixture.runId }
      : { ok: false, errorCode: 'cancelled', error: 'cancelled' });
    expect(fixture.storage.calls.filter(call => call.operation === 'invocations.list')).toEqual([]);
  });
});
