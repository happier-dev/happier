import { describe, expect, it } from 'vitest';
import {
  MachineSetupApplyInputV1Schema, deriveWorkflowReplacementId, computeActionInputApprovalDigestV1,
  createWorkflowAccountRunActionOwner, materializeWorkflowAcceptedSnapshotV1,
  sealWorkflowAcceptedSnapshotStoredEnvelopeV1, sealWorkflowCheckpointStoredEnvelopeV1,
  sealWorkflowProgressStoredEnvelopeV1, serializeWorkflowStoredContentEnvelopeV1,
  ActionIdSchema, getActionSpec, type ActionExecutorContext,
} from '@happier-dev/protocol';
import { prepareWorkflowApprovedOperationSnapshot } from '@happier-dev/protocol/actions/executor/workflowRunActions';
import { actionSpecToActionDefinitionV1, freezeWorkflowActionContractV1 } from '@happier-dev/protocol/actions/actionCatalog';
import { ActionExecuteFailureSchema } from '@happier-dev/protocol/actions/actionExecutionResult';
import { createActionOperationRunner } from '@/daemon/actionOperations/actionOperationRunner';
import { createActionOperationStore } from '@/daemon/actionOperations/actionOperationStore';
import { createWorkflowRunStorageTestkit } from '@/daemon/workflows/workflowRunStorage.testkit';
import { DurableWorkflowCoordinatorStore } from '@/daemon/workflows/production';
import { workflowInvocationKey } from '@/daemon/workflows/coordinator';
import { createUnavailableActionTransportDeps } from '@/testkit/actionTransportDeps';
import { buildMachineSetupWorkflow, createCombinedMachineSetupActionDeps } from './composeMachineSetup';

// The opaque Home storage boundary is faked; Run admission, content opening,
// invocation paging and setup composition all use their real owners.
async function retainedSetup(state: 'failed' | 'cancelled' | 'succeeded', errorCode: string, details?: Record<string, string | number>) {
  const accountId = 'actor', machineId = 'guest', rootId = 'setup-root';
  const input = MachineSetupApplyInputV1Schema.parse({ homeId: 'home', machineId, targets: [{
    homeId: 'home', machineId, desiredRevision: 0, sources: [{ kind: 'direct', setup: {} }],
    exclusions: [], recipePlans: [],
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
  const lifecycle = state === 'succeeded' ? 'completed' : state;
  const key = workflowInvocationKey({ runId, blockId: 'setup-0', scope: [], attempt: 0 });
  await store.ensureIntent({ key, recordId: 'setup-child', runId, blockId: 'setup-0', memberOrdinal: '0',
    parentKey: workflowInvocationKey({ runId, blockId: '$root', scope: [], attempt: 0 }),
    path: { blockId: 'setup-0', scope: [] }, blockKind: 'action', attempt: 0, acceptedAtMs: Date.now(), lifecycle: 'pending' });
  await store.commitFact({ key, lifecycle, reason: errorCode, ...(details === undefined ? {} : { result: details }) });
  await store.commitFact({ key: workflowInvocationKey({ runId, blockId: '$root', scope: [], attempt: 0 }), lifecycle });
  await storage.execute({ operation: 'transition', runId, expectedRevision: storage.run().revision,
    state, checkpointEnvelope: storage.checkpointEnvelope() });
  const reader = createWorkflowAccountRunActionOwner({ resolveAccountId: async () => accountId, storage,
    definitions: { get: async () => { throw new Error('inline_run_has_no_saved_definition'); } },
    resolveEncryption: async () => ({ kind: 'available', witness }), normalizeAbsolutePath: directory => directory,
    randomBytes: () => { throw new Error('plain_account_has_no_keys'); } });
  const deps = createCombinedMachineSetupActionDeps({ readDeps: createUnavailableActionTransportDeps,
    targetPlan: async () => { throw new Error('reviewed_exclusions_already_present'); },
    readHostFacts: async () => ({ machines: [{ machineId, online: true }] }), orchestrationDirectory: '/setup',
    startCombined: reader.startCombined,
    waitForRun: () => reader.execute({ actionId: 'workflow.run.wait', input: { runId, conditions: ['terminal'] }, context }),
    readInvocations: (_request, input) => reader.execute({ actionId: 'workflow.run.invocations.list', input, context }),
  });
  return { apply: () => deps.machineSetupApply!({ input, context }), runId, storage };
}

describe('Combined Machine setup child settlement', () => {
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
