import { describe, expect, it } from 'vitest';
import { createMachineSetupEffectPlan } from '@happier-dev/cli-common/machineSetup';
import { createActionExecutor, invokeHostReviewedChildV1 } from '@happier-dev/protocol/actions/actionExecutor';
import { WorkflowDefinitionV1Schema } from '@happier-dev/protocol/workflows/workflowV1';
import { createMachineUpdatesRolloutWorkflowV1 } from '@happier-dev/protocol/workflows/builtins/machineUpdatesV1';
import { createInMemoryWorkflowCoordinatorStore, createTestWorkflowCoordinator } from '@/daemon/workflows/workflowCoordinator.testkit';
import { buildWorkflowActionContext } from '@/daemon/workflows/workflowActionContext';
import { createHostActionOperationRuntime } from '@/daemon/actionOperations/createHostActionOperationRuntime';
import { projectNativeJsonValueForTransport, sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import { evaluateWorkflowCondition } from '@/daemon/workflows/input';
import { ActionOperationGetV1ResponseSchema } from '@happier-dev/protocol/actions/operations/v1';
import { createUnavailableActionTransportDeps } from '@/testkit/actionTransportDeps';

const target = (machineId: string) => ({ homeId: 'home', machineId, scope: 'security' as const,
  plan: createMachineSetupEffectPlan({ basis: { kind: 'updates', machineId, scope: 'security' }, steps: [], nativeFacts: [] }) });

describe('fleet update Workflow composition', () => {
  it.each([
    { observation: { status: 'satisfied', rebootNeeded: true }, expected: true },
    { observation: { status: 'satisfied', rebootNeeded: false }, expected: false },
    { observation: { status: 'unavailable', reason: 'required_fact_unavailable' }, expected: false },
  ])('reboots only on a known positive observation: $observation', async ({ observation, expected }) => {
    const definition = createMachineUpdatesRolloutWorkflowV1({ homeId: 'home', machineId: 'controller',
      batches: [[{ ...target('first'), reboot: { expectedInstallationId: 'installation' } }]], failurePolicy: 'fail_stop' });
    const batch = definition.blocks[0]!;
    if (batch.kind !== 'parallel') throw new Error('Missing batch');
    const condition = batch.branches[0]!.blocks.find(block => block.kind === 'if');
    if (!condition || condition.kind !== 'if') throw new Error('Missing conditional reboot');
    const retained = projectNativeJsonValueForTransport({ updates: { observation } });
    await expect(evaluateWorkflowCondition(condition.when, { inputs: {}, resolveResult: async () => retained,
      resolveWorkspace: async () => { throw new Error('No workspace reference'); } })).resolves.toBe(expected);
  });

  it.each(['fail_stop', 'collect_outcomes'] as const)('retains terminal native failure before the next batch (%s)', async failurePolicy => {
    const input = { homeId: 'home', machineId: 'machine-1', batches: [[target('first')], [target('second')]], failurePolicy };
    const definition = WorkflowDefinitionV1Schema.parse(createMachineUpdatesRolloutWorkflowV1(input));
    const effects: string[] = [];
    let release!: () => void;
    let opened!: () => void;
    const waiting = new Promise<void>(resolve => { opened = resolve; });
    const settled = new Promise<void>(resolve => { release = resolve; });
    let observing!: () => void;
    const terminalObservation = new Promise<void>(resolve => { observing = resolve; });
    const operations = new Map(input.batches.flat().map(({ machineId }) => [machineId, createHostActionOperationRuntime({
      machineId, resolveAccountId: async () => 'person', generateOperationId: () => `native-${machineId}` })]));
    // Native package execution is the OS boundary; Action admission and Workflow execution remain real.
    const executor = createActionExecutor({ ...createUnavailableActionTransportDeps(),
      machineSetupUpdatesApply: async ({ input, context }) => {
        const observed = await operations.get(input.machineId)!.observeExecution({
        actionId: 'machines.setup.updates.apply', actionRequestId: context.actionRequestId, input,
        execute: async operation => {
          effects.push(input.machineId);
          operation.operationAcceptance!.accept({ operationId: operation.operationAcceptance!.operationId });
          if (input.machineId === 'first') { opened(); await settled; return { ok: false, errorCode: 'native_failed', error: 'native_failed' }; }
          return { ok: true, result: { operationId: operation.operationAcceptance!.operationId } };
        },
        });
        return observed.ok ? observed.result : observed;
      },
    });
    const workspace = { machineId: 'machine-1', directory: '/repo', checkoutRootPath: '/repo' };
    const store = createInMemoryWorkflowCoordinatorStore();
    const coordinator = createTestWorkflowCoordinator({ store,
      executeStep: async () => { throw new Error('Updates have no Agent step'); },
      resolveWorkspace: async () => ({ ok: true, workspace }),
      action: { executor: { prepare: async (actionId, childInput, context) => {
        // This fixture starts after root review. Use the real private issuer at
        // the host boundary; neither public context nor a profile admits a leaf.
        const ordinal = input.batches.flat().findIndex(target => sameStrictJsonValue(target, childInput));
        if (actionId !== 'machines.setup.updates.apply' || ordinal < 0) throw new Error('Unreviewed native child');
        const issued = await invokeHostReviewedChildV1({ parent: { actionId: 'machines.setup.updates.rollout', input },
          child: { action: actionId, role: `update-${ordinal}`, input: projectNativeJsonValueForTransport(childInput) },
          context, admittedReview: { action: actionId, role: `update-${ordinal}`, surface: 'agent' },
          execute: async (input, context) => executor.prepare(actionId, input, context) });
        return 'kind' in issued ? issued : { kind: 'settled', result: issued };
      } }, buildContext: async request => ({ ...buildWorkflowActionContext(request),
        serverId: 'home', serverIdentityId: 'home', runtimeAccountId: 'person' }),
        observeOperation: async target => {
          if (target.machineId === 'first') observing();
          const observed = ActionOperationGetV1ResponseSchema.parse(await operations.get(target.machineId)!.handlers.getV2({
            operationId: target.operationId, waitForTerminal: true }));
          if (observed.kind !== 'found') throw new Error('Missing native update operation');
          return observed.operation;
        },
        observeRun: async () => { throw new Error('Updates have no Agent Run'); } },
    });
    const running = coordinator.run({ runId: `updates-${failurePolicy}`, definition, inputs: {},
      executionTarget: { kind: 'session' }, authorization: { principal: { kind: 'host' }, admittedPermissionCeiling: 'default' },
      origin: { kind: 'direct', actionPolicy: { authority: 'account_automation', approvalProfileId: 'builtin:full-trust' } } });
    try {
      await Promise.race([waiting, running.then(outcome => { throw new Error(JSON.stringify(outcome)); })]);
      await Promise.race([terminalObservation, running.then(outcome => { throw new Error(JSON.stringify(outcome)); })]);
      expect(effects).toEqual(['first']);
    }
    finally { release(); }
    const outcome = await running;
    expect(effects, JSON.stringify({ outcome, invocations: store.list().map(({ blockId, lifecycle, reason }) => ({ blockId, lifecycle, reason })) }))
      .toEqual(failurePolicy === 'fail_stop' ? ['first'] : ['first', 'second']);
    expect(store.list()).toContainEqual(expect.objectContaining({
      blockId: 'update-0-0', lifecycle: 'failed', reason: 'native_failed',
    }));
    expect(outcome).toMatchObject(failurePolicy === 'fail_stop'
      ? { state: 'interrupted', reason: 'native_failed' } : { state: 'succeeded' });
  });
});
