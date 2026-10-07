import { createTestWorkflowCoordinator as createWorkflowCoordinator } from './workflowCoordinator.testkit';
import { describe, expect, it } from 'vitest';
import { createActionExecutor, freezeActionCompletionContractV1, type ActionExecutorDeps } from '@happier-dev/protocol/actions';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { zodSchemaToJsonSchemaObject } from '@happier-dev/protocol/actions/actionInputJsonSchema';
import { ActionIdSchema, DEFAULT_SESSION_AGENT_SPAWN_POLICY_V1, ExecutionRunResultContractV1Schema, PluginJsonValueV2Schema, ResolvedRoleV1Schema, withExecutionRunStartFailureDetails } from '@happier-dev/protocol';
import { buildBackendTargetKeyV2 } from '@happier-dev/protocol/backends';
import { validateExecutionRunProfileResult } from '@happier-dev/protocol/execution/runs/resultContract';
import type { WorkflowActionLeafV1, WorkflowDefinitionV1, WorkflowMaterializedLeafV1 } from '@happier-dev/protocol/workflows';
import { WORKFLOW_CANCEL_REQUESTED_ABORT_REASON, WorkflowRuntimeInterruption } from './coordinator';
import { createInMemoryWorkflowCoordinatorStore } from './workflowCoordinator.testkit';

const workspace = { machineId: 'machine', directory: '/repo', checkoutRootPath: '/repo' };
const authorization = { principal: { kind: 'host' as const }, admittedPermissionCeiling: 'default' as const };
const executionTarget = { kind: 'session' as const };
// These are host transport boundaries; all Action admission and execution logic stays real.
function createTestActionExecutor(overrides: Partial<ActionExecutorDeps>) {
  const unexpected = async (): Promise<never> => { throw new Error('unexpected_action_dependency'); };
  return createActionExecutor({
    executionRunStart: unexpected,
    executionRunList: unexpected,
    executionRunGet: unexpected,
    detachedExecutionRunSend: unexpected,
    executionRunStop: unexpected,
    executionRunAction: unexpected,
    executionRunWait: unexpected,
    sessionOpen: unexpected,
    sessionFork: unexpected,
    sessionRollback: unexpected,
    sessionSpawnNew: unexpected,
    pathsListRecent: unexpected,
    machinesList: unexpected,
    serversList: unexpected,
    reviewEnginesList: unexpected,
    agentsBackendsList: unexpected,
    agentsModelsList: unexpected,
    sessionSendMessage: unexpected,
    sessionModeSet: unexpected,
    sessionModesList: unexpected,
    sessionList: unexpected,
    sessionActivityGet: unexpected,
    sessionRecentMessagesGet: unexpected,
    resetGlobalVoiceAgent: unexpected,
    daemonMemorySearch: unexpected,
    daemonMemoryGetWindow: unexpected,
    daemonMemoryEnsureUpToDate: unexpected,
    ...overrides,
  });
}
function definition(blocks: WorkflowDefinitionV1['blocks']): WorkflowDefinitionV1 {
  return { version: 1, inputs: [], defaults: {}, blocks };
}
function frozen(leaf: WorkflowActionLeafV1): WorkflowMaterializedLeafV1 {
  const spec = getActionSpec(ActionIdSchema.parse(leaf.actionId));
  const outputSchema = spec.completion?.terminalOutputSchema ?? spec.outputSchema;
  if (!outputSchema) throw new Error('action_fixture_requires_output_schema');
  return { authoredWorkspace: { kind: 'inherit' as const }, sourceKey: '$root', blockId: leaf.id, kind: 'action', selection: {}, executionTarget,
    actionId: leaf.actionId, actionContract: {
      inputSchema: PluginJsonValueV2Schema.parse(zodSchemaToJsonSchemaObject(spec.inputSchema, { target: 'draft-7' })),
      outputSchema: PluginJsonValueV2Schema.parse(zodSchemaToJsonSchemaObject(outputSchema, { target: 'draft-7' })),
      ...(spec.completion ? { completion: freezeActionCompletionContractV1(spec.completion) } : {}),
    } };
}
const goal: WorkflowActionLeafV1 = { kind: 'action', id: 'goal', actionId: 'session.goal.set',
  input: { sessionId: { kind: 'origin_session_id' }, status: { kind: 'literal', value: 'complete' } } };

describe('workflow Action leaves', () => {
  it('retains JSON failure output and gives the effect its run/step/attempt idempotency identity', async () => {
    const contexts: string[] = [];
    const store = createInMemoryWorkflowCoordinatorStore();
    const output = { exitCode: 7, stdout: 'partial', stderr: 'refused' };
    const leaf: WorkflowActionLeafV1 = { kind: 'action', id: 'command', actionId: 'machines.command.run',
      input: { command: { kind: 'literal', value: 'exit 7' } } };
    const executor = createTestActionExecutor({ machineCommandRun: async (_input, context) => {
      contexts.push(context.actionRequestId ?? '');
      return { ok: false, errorCode: 'command_failed', error: 'Command failed', details: output };
    } });
    // Admission remains real; the process-effect dependency supplies its definitive response.
    const observedCoordinator = createWorkflowCoordinator({ store, executeStep: async () => { throw new Error('Action has no Agent'); },
      resolveWorkspace: async () => ({ ok: true, workspace }), isAcceptedAuthorizationCurrent: async () => true,
      action: { executor, buildContext: async () => ({ surface: 'cli', authority: 'account_automation', bypassApprovals: true,
        externalActionTarget: { kind: 'machine', machineId: workspace.machineId,
          project: { machineId: workspace.machineId, directory: workspace.directory } } }),
        observeRun: async () => { throw new Error('Immediate Action has no awaited Runs'); } } });
    const outcome = await observedCoordinator.run({ runId: 'effect-run', definition: definition([leaf]), inputs: {},
      executionTarget, authorization, originSessionId: 'origin', materializedLeaves: [frozen(leaf)] });
    expect(outcome.state).toBe('failed');
    const row = store.list().find((entry) => entry.blockId === leaf.id)!;
    expect(row).toMatchObject({ lifecycle: 'failed', reason: 'command_failed', result: output });
    expect(contexts).toEqual([`effect-run/${row.logicalInvocationRecordId ?? row.recordId}/0`]);
  });
  it('keeps known command output when an authoritative Stop cancels the Run during the effect', async () => {
    const controller = new AbortController();
    const store = createInMemoryWorkflowCoordinatorStore();
    const output = { exitCode: -1, stdout: 'printed before Stop', stderr: '' };
    const leaf: WorkflowActionLeafV1 = { kind: 'action', id: 'command', actionId: 'machines.command.run',
      input: { command: { kind: 'literal', value: 'long-running-command' } } };
    const executor = createTestActionExecutor({ machineCommandRun: async () => {
      controller.abort(WORKFLOW_CANCEL_REQUESTED_ABORT_REASON);
      return { ok: false, errorCode: 'command_cancelled', error: 'Command cancelled', details: output };
    } });
    const coordinator = createWorkflowCoordinator({ store, executeStep: async () => { throw new Error('Action has no Agent'); },
      resolveWorkspace: async () => ({ ok: true, workspace }), isAcceptedAuthorizationCurrent: async () => true,
      action: { executor, buildContext: async () => ({ surface: 'cli', authority: 'account_automation', bypassApprovals: true,
        externalActionTarget: { kind: 'machine', machineId: workspace.machineId,
          project: { machineId: workspace.machineId, directory: workspace.directory } } }),
        observeRun: async () => { throw new Error('Immediate Action has no awaited Runs'); } } });
    expect(await coordinator.run({ runId: 'stopped-command', definition: definition([leaf]), inputs: {},
      executionTarget, authorization, signal: controller.signal, materializedLeaves: [frozen(leaf)] }))
      .toMatchObject({ state: 'cancelled' });
    expect(store.list().find((row) => row.blockId === leaf.id)?.result).toEqual(output);
  });
  it.each([true, false])('keeps a successful Action with invalid frozen output repairable only when review is enabled (%s)', async (pauseForReview) => {
    let effects = 0;
    const leaf = { ...goal, pauseForReview };
    const materialized = frozen(leaf);
    const store = createInMemoryWorkflowCoordinatorStore();
    const coordinator = createWorkflowCoordinator({ store, executeStep: async () => { throw new Error('Action has no Agent'); },
      resolveWorkspace: async () => ({ ok: true, workspace }), isAcceptedAuthorizationCurrent: async () => true,
      action: { executor: createTestActionExecutor({ sessionGoalSet: async () => { effects++; return { ok: true }; } }),
        buildContext: async () => ({ surface: 'cli', authority: 'account_automation' }),
        observeRun: async () => { throw new Error('Immediate Action has no awaited Runs'); } } });
    const outcome = await coordinator.run({ runId: 'invalid-action-output', definition: definition([leaf]),
      inputs: {}, executionTarget, authorization, originSessionId: 'origin', materializedLeaves: [{ ...materialized,
        actionContract: { ...materialized.actionContract!, outputSchema: { type: 'object', required: ['answer'] } } }] });
    expect(outcome.state).toBe(pauseForReview ? 'waiting_for_review' : 'failed');
    expect(effects).toBe(1);
    expect(store.list().find((row) => row.blockId === leaf.id)).toMatchObject({
      lifecycle: pauseForReview ? 'waiting_for_review' : 'failed', reason: 'schema_mismatch',
    });
    expect(store.list().find((row) => row.blockId === leaf.id)?.result).toBeUndefined();
  });
  it('collects definitive pre-invoke Action failures without preventing a successful sibling', async () => {
    let effects = 0;
    const leaf: WorkflowActionLeafV1 = { ...goal, input: { sessionId: { kind: 'item', field: 'value', path: ['sessionId'] },
      status: { kind: 'literal', value: 'complete' } } };
    const store = createInMemoryWorkflowCoordinatorStore();
    const coordinator = createWorkflowCoordinator({ store, executeStep: async () => { throw new Error('Agent'); },
      resolveWorkspace: async () => ({ ok: true, workspace }), isAcceptedAuthorizationCurrent: async () => true,
      action: { executor: createTestActionExecutor({ sessionGoalSet: async () => { effects++; return { ok: true }; } }),
        buildContext: async () => ({ surface: 'cli', authority: 'account_automation' }),
        observeRun: async () => { throw new Error('Immediate Action'); } } });
    const result = await coordinator.run({ runId: 'collect-action-refusal', definition: definition([{ kind: 'loop', id: 'items',
      repetition: { kind: 'items', items: { kind: 'literal', value: [{ sessionId: null }, { sessionId: 'valid' }] },
        execution: 'parallel', failurePolicy: 'collect_outcomes' }, body: [leaf] }]),
      inputs: {}, executionTarget, authorization, materializedLeaves: [frozen(leaf)] });
    expect(result).toMatchObject({ state: 'succeeded', completedWithFailures: true });
    expect(effects).toBe(1);
    expect(store.list().filter((row) => row.blockKind === 'action').map((row) => row.lifecycle).sort()).toEqual(['completed', 'failed']);
  });
  it.each([false, true])('collects typed terminal failures only when no native launch failed (%s)', async (launchFailure) => {
    const observed: string[] = [];
    let starts = 0;
    let downstreamEffects = 0;
    const leaf: WorkflowActionLeafV1 = { kind: 'action', id: 'panel', actionId: 'review.start', input: {
      target: { kind: 'literal', value: { kind: 'detached' } }, instructions: { kind: 'literal', value: 'Review' },
      engineIds: { kind: 'literal', value: ['codex', 'claude'] },
    } };
    const materialized = frozen(leaf);
    const completion = materialized.actionContract?.completion;
    if (!completion || typeof completion !== 'object' || Array.isArray(completion)) throw new Error('Expected Action completion contract');
    const store = createInMemoryWorkflowCoordinatorStore();
    const coordinator = createWorkflowCoordinator({ store, executeStep: async () => { throw new Error('Agent'); },
      resolveWorkspace: async () => ({ ok: true, workspace }), isAcceptedAuthorizationCurrent: async () => true,
      action: { executor: createTestActionExecutor({
        executionRunCheckProtocolV2: async () => ({ ok: true }),
        executionRunStart: async () => {
          starts++;
          return launchFailure && starts === 2
            ? { ok: false, errorCode: 'native_response_lost', error: 'native_response_lost' }
            : { runId: `run-${starts}`, callId: 'call', sidechainId: 'call' };
        },
        reviewEnginesList: async () => ({ items: ['codex', 'claude'].map((value) => ({ value, label: value })) }),
        sessionGoalSet: async () => { downstreamEffects++; return { ok: true }; },
      }), buildContext: async () => ({ surface: 'cli', externalActionTarget: {
        kind: 'machine', machineId: workspace.machineId,
        project: { machineId: workspace.machineId, directory: workspace.directory } } }),
        observeRun: async (run) => {
          observed.push(run.runId);
          return { kind: 'completed', result: {}, commentIds: [], materialization: { kind: 'complete' } };
        } } });
    const outcome = await coordinator.run({ runId: 'terminal-failure', definition: definition([{ kind: 'loop', id: 'items',
      repetition: { kind: 'items', items: { kind: 'literal', value: [1] }, execution: 'parallel',
        failurePolicy: 'collect_outcomes' }, body: [leaf] }, goal]),
      inputs: {}, executionTarget, authorization, originSessionId: 'origin', materializedLeaves: [
        { ...materialized, actionContract: { ...materialized.actionContract!, completion: {
          ...completion, terminalOutputSchema: { type: 'object', required: ['missing'] },
        } } }, frozen(goal),
      ] });
    expect(outcome).toMatchObject(launchFailure ? { state: 'outcome_uncertain' }
      : { state: 'succeeded', completedWithFailures: true });
    expect(observed.sort()).toEqual(launchFailure ? ['run-1'] : ['run-1', 'run-2']);
    expect(store.list().find((row) => row.blockId === leaf.id))
      .toMatchObject({ lifecycle: launchFailure ? 'outcome_uncertain' : 'failed', reason: 'invalid_action_output' });
    expect(downstreamEffects).toBe(launchFailure ? 0 : 1);
  });
  it('never collects an uncertain native launch failure or repeats its effect on replay', async () => {
    let starts = 0;
    let observations = 0;
    let downstreamEffects = 0;
    const leaf: WorkflowActionLeafV1 = { kind: 'action', id: 'panel', actionId: 'review.start', input: {
      target: { kind: 'literal', value: { kind: 'detached' } }, instructions: { kind: 'literal', value: 'Review' },
      engineIds: { kind: 'literal', value: ['codex'] },
    } };
    const store = createInMemoryWorkflowCoordinatorStore();
    const coordinator = createWorkflowCoordinator({ store, executeStep: async () => { throw new Error('Agent'); },
      resolveWorkspace: async () => ({ ok: true, workspace }), isAcceptedAuthorizationCurrent: async () => true,
      action: { executor: createTestActionExecutor({
        executionRunCheckProtocolV2: async () => ({ ok: true }),
        executionRunStart: async () => {
          starts++;
          // The native process may exist even though its launch acknowledgement was lost.
          return { ok: false, errorCode: 'native_response_lost', error: 'native_response_lost' };
        },
        reviewEnginesList: async () => ({ items: [{ value: 'codex', label: 'Codex' }] }),
        sessionGoalSet: async () => { downstreamEffects++; return { ok: true }; },
      }), buildContext: async () => ({ surface: 'cli', externalActionTarget: {
        kind: 'machine', machineId: workspace.machineId,
        project: { machineId: workspace.machineId, directory: workspace.directory } } }),
        observeRun: async () => { observations++; throw new Error('No launch correspondence'); } } });
    const params = { runId: 'uncertain-launch', definition: definition([{ kind: 'loop', id: 'items',
      repetition: { kind: 'items', items: { kind: 'literal', value: [1] }, execution: 'parallel',
        failurePolicy: 'collect_outcomes' }, body: [leaf] }, goal]),
      inputs: {}, executionTarget, authorization, originSessionId: 'origin',
      materializedLeaves: [frozen(leaf), frozen(goal)] };
    expect(await coordinator.run(params)).toMatchObject({ state: 'outcome_uncertain', reason: 'native_response_lost' });
    expect(await coordinator.run(params)).toMatchObject({ state: 'outcome_uncertain' });
    expect(store.list().find((row) => row.blockId === leaf.id))
      .toMatchObject({ lifecycle: 'outcome_uncertain', reason: 'native_response_lost' });
    expect(starts).toBe(1);
    expect(observations).toBe(0);
    expect(downstreamEffects).toBe(0);
  });
  it('keeps Action context preparation in flight while an independent leaf is held', async () => {
    let release!: () => void;
    let preparing!: () => void;
    const started = new Promise<void>((resolve) => { preparing = resolve; });
    const preparation = new Promise<void>((resolve) => { release = resolve; });
    let effects = 0;
    const executor = createTestActionExecutor({ sessionGoalSet: async () => { effects++; return { ok: true }; } });
    const store = createInMemoryWorkflowCoordinatorStore();
    const coordinator = createWorkflowCoordinator({ store, executeStep: async () => { throw new Error('Wait has no Agent'); },
      resolveWorkspace: async () => ({ ok: true, workspace }), isAcceptedAuthorizationCurrent: async () => true,
      action: { executor, buildContext: async () => {
        preparing(); await preparation;
        return { surface: 'cli', authority: 'account_automation' };
      }, observeRun: async () => { throw new Error('Immediate Action has no awaited Runs'); } } });
    const running = coordinator.run({ runId: 'action-context', definition: definition([{ kind: 'parallel', id: 'p', failurePolicy: 'fail_stop',
      branches: [{ id: 'a', blocks: [{ kind: 'wait', id: 'human', document: { text: 'Continue', references: [], attachments: [] } }] },
        { id: 'b', blocks: [goal] }] }]), materializedLeaves: [frozen(goal)], inputs: {}, executionTarget, authorization, originSessionId: 'origin' });
    await started;
    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));
    release();
    expect(await running).toMatchObject({ state: 'waiting_for_review' });
    expect(effects).toBe(1);
    expect(store.list().find((row) => row.blockId === goal.id)?.lifecycle).toBe('completed');
  });
  it('admits a named Action role from the frozen leaf selection without a live role lookup', async () => {
    let starts = 0;
    const targetKey = buildBackendTargetKeyV2({ kind: 'backend', backendId: 'codex' });
    const requestIds: (string | undefined)[] = [];
    const executor = createTestActionExecutor({ executionRunCheckProtocolV2: async () => ({ ok: true }),
      executionRunStart: async (_sessionId, _request, options) => {
        requestIds.push(options?.actionRequestId);
        starts++; return { runId: 'role-run', callId: 'call', sidechainId: 'call' };
      },
      reviewEnginesList: async () => ({ items: [{ value: targetKey, label: 'Codex' }] }),
    });
    const leaf: WorkflowActionLeafV1 = { kind: 'action', id: 'review-role', actionId: 'review.start', input: {
      target: { kind: 'literal', value: { kind: 'detached' } }, instructions: { kind: 'literal', value: 'Review' },
      engineIds: { kind: 'literal', value: [targetKey] }, roleId: { kind: 'literal', value: 'pinned-reviewer' },
    } };
    const role = ResolvedRoleV1Schema.parse({ roleId: 'pinned-reviewer', name: 'Reviewer', instructions: 'Review',
      engine: { agentTargetKey: targetKey },
      runsAs: { kind: 'background_run', intent: 'review' }, workspaceWrites: 'deny', secondOpinion: 'off', enabled: true });
    const store = createInMemoryWorkflowCoordinatorStore();
    const coordinator = createWorkflowCoordinator({ store, executeStep: async () => { throw new Error('Agent'); },
      resolveWorkspace: async () => ({ ok: true, workspace }), isAcceptedAuthorizationCurrent: async () => true,
      action: { executor, buildContext: async (input) => {
        const selected = ResolvedRoleV1Schema.safeParse('role' in input ? input.role : undefined);
        return { surface: 'agent', authority: 'account_automation', sessionAgentSpawnPolicyV1: DEFAULT_SESSION_AGENT_SPAWN_POLICY_V1,
          agentStartContext: { caller: { kind: 'originless', runId: input.runId, runDepth: input.workDepth },
            baseline: { machineId: workspace.machineId, directory: workspace.directory }, ledSubtreeSessionIds: [],
            roles: selected.success ? { [selected.data.roleId]: selected.data } : {}, workDepthLimit: 4,
            callerPermissionCeiling: input.authorization.admittedPermissionCeiling },
          externalActionTarget: { kind: 'machine', machineId: workspace.machineId, project: { machineId: workspace.machineId, directory: workspace.directory } } };
      }, observeRun: async () => ({ kind: 'completed', result: {}, commentIds: [], materialization: { kind: 'complete' } }) } });
    const result = await coordinator.run({ runId: 'role-action', definition: definition([leaf]), inputs: {}, executionTarget,
      authorization, materializedLeaves: [{ ...frozen(leaf), role }] });
    expect(result.state, result.reason).toBe('succeeded');
    expect(starts).toBe(1);
    const launch = store.list().find((row) => row.blockId === leaf.id)?.execution;
    expect(launch).toMatchObject({ kind: 'action', actionRequestId: expect.any(String) });
    expect(requestIds).toEqual([launch?.kind === 'action' ? launch.actionRequestId : undefined]);
  });
  it('retains launch correspondence when interruption arrives during Action invocation', async () => {
    let release!: () => void;
    let started!: () => void;
    const invocationStarted = new Promise<void>((resolve) => { started = resolve; });
    const invocationRelease = new Promise<void>((resolve) => { release = resolve; });
    const executor = createTestActionExecutor({ executionRunCheckProtocolV2: async () => ({ ok: true }),
      executionRunStart: async () => { started(); await invocationRelease; return { runId: 'interrupted-run', callId: 'call', sidechainId: 'call' }; },
      reviewEnginesList: async () => ({ items: [{ value: 'codex', label: 'Codex' }] }),
    });
    const leaf: WorkflowActionLeafV1 = { kind: 'action', id: 'review', actionId: 'review.start', input: {
      target: { kind: 'literal', value: { kind: 'detached' } }, instructions: { kind: 'literal', value: 'Review' },
      engineIds: { kind: 'literal', value: ['codex'] },
    } };
    const store = createInMemoryWorkflowCoordinatorStore();
    const coordinator = createWorkflowCoordinator({ store, executeStep: async () => { throw new Error('Agent'); },
      resolveWorkspace: async () => ({ ok: true, workspace }), isAcceptedAuthorizationCurrent: async () => true,
      action: { executor, buildContext: async () => ({ surface: 'cli', externalActionTarget: {
        kind: 'machine', machineId: workspace.machineId, project: { machineId: workspace.machineId, directory: workspace.directory } } }),
        observeRun: async () => { throw new Error('Interrupted claim cannot observe'); } } });
    const controller = new AbortController();
    const running = coordinator.run({ runId: 'interrupted-action', definition: definition([leaf]), materializedLeaves: [frozen(leaf)],
      inputs: {}, executionTarget, authorization, signal: controller.signal });
    const outcome = expect(running).rejects.toBeInstanceOf(WorkflowRuntimeInterruption);
    await invocationStarted;
    controller.abort(new WorkflowRuntimeInterruption());
    release();
    await outcome;
    expect(store.list().find((row) => row.blockId === leaf.id)?.execution).toMatchObject({
      kind: 'action', awaitedRuns: [{ key: 'codex', runId: 'interrupted-run' }], output: expect.any(Object),
    });
  });
  it('continues a held Action evaluator with human-supplied decisions inside its exact loop iteration', async () => {
    let actionEffects = 0;
    const agentEffects: string[] = [];
    const evaluator = { ...goal, id: 'evaluator', pauseForReview: true };
    const executor = createTestActionExecutor({ sessionGoalSet: async () => { actionEffects++; return { ok: true }; } });
    const store = createInMemoryWorkflowCoordinatorStore();
    const coordinator = createWorkflowCoordinator({ store,
      executeStep: async (params) => {
        agentEffects.push(params.step.id);
        await params.beforeInputAdmission();
        await params.onInputAccepted({ kind: 'session', sessionId: 'origin', localInputId: params.invocationRecordId! });
        return { kind: 'completed', result: 'body' };
      }, resolveWorkspace: async () => ({ ok: true, workspace }), isAcceptedAuthorizationCurrent: async () => true,
      action: { executor, buildContext: async () => ({ surface: 'cli', authority: 'account_automation' }),
        observeRun: async () => { throw new Error('Immediate Action has no awaited Runs'); } } });
    const body = { kind: 'step' as const, id: 'body', document: { text: 'Body', references: [], attachments: [] },
      input: [], result: { kind: 'text' as const } };
    const params = { runId: 'action-evaluator', definition: definition([{ kind: 'loop', id: 'loop', body: [body],
      repetition: { kind: 'evaluate', maxIterations: 2, history: 'none', evaluator } }]),
      inputs: {}, executionTarget, authorization, originSessionId: 'origin', materializedLeaves: [frozen(evaluator),
        { authoredWorkspace: { kind: 'inherit' as const }, sourceKey: '$root', blockId: body.id, kind: 'step' as const, selection: {}, executionTarget }] };
    expect(await coordinator.run(params))
      .toMatchObject({ state: 'waiting_for_review' });
    expect(actionEffects).toBe(1);
    expect(agentEffects).toEqual(['body']);
    expect(store.list().find((row) => row.blockId === evaluator.id)).toMatchObject({ blockKind: 'action',
      lifecycle: 'waiting_for_review', result: { ok: true }, path: { scope: [{ kind: 'iteration', blockId: 'loop', index: 0 }] } });
    // The native goal Action is not a decision producer. Human replacement values
    // are permitted by its frozen JSON contract and become the loop's decisions.
    for (const decision of ['continue', 'done']) {
      const held = store.list().find((row) => row.blockId === evaluator.id && row.lifecycle === 'waiting_for_review')!;
      const accepted = validateExecutionRunProfileResult(decision, ExecutionRunResultContractV1Schema.parse(held.resultContract));
      expect(accepted).toEqual({ ok: true, value: decision });
      if (!accepted.ok) throw new Error('human_decision_invalid');
      await store.commitFact({ key: held.key, lifecycle: 'completed', result: accepted.value,
        review: { resultSource: { kind: 'human', accountId: 'person' },
          decision: { kind: 'use_result', requestedFromContentRevision: held.contentRevision! } } });
      expect(await coordinator.run(params)).toMatchObject({ state: decision === 'continue' ? 'waiting_for_review' : 'succeeded' });
      expect(actionEffects).toBe(2);
      expect(agentEffects).toEqual(['body', 'body']);
    }
    expect(store.list().filter((row) => row.blockId === evaluator.id).map((row) => ({ lifecycle: row.lifecycle,
      result: row.result, scope: row.path.scope }))).toEqual([
      { lifecycle: 'completed', result: 'continue', scope: [{ kind: 'iteration', blockId: 'loop', index: 0 }] },
      { lifecycle: 'completed', result: 'done', scope: [{ kind: 'iteration', blockId: 'loop', index: 1 }] },
    ]);
    expect(store.list().find((row) => row.blockId === 'loop')?.container).toMatchObject({
      kind: 'loop', closing: { outcome: { kind: 'decision', value: 'done' } },
    });
  });
  it.each([{ workDepth: 4, allowModelOverride: true }, { workDepth: 0, allowModelOverride: true },
    { workDepth: 0, allowModelOverride: false }])('enforces current Action policy and frozen depth %j', async ({ workDepth, allowModelOverride }) => {
    let starts = 0;
    const executor = createTestActionExecutor({ executionRunCheckProtocolV2: async () => ({ ok: true }),
      executionRunStart: async () => { starts++; return { runId: 'review-run', callId: 'call', sidechainId: 'call' }; },
      reviewEnginesList: async () => ({ items: [{ value: 'codex', label: 'Codex' }] }),
    });
    const leaf: WorkflowActionLeafV1 = { kind: 'action', id: 'review', actionId: 'review.start', input: {
      target: { kind: 'literal', value: { kind: 'detached' } }, instructions: { kind: 'literal', value: 'Review' },
      engineIds: { kind: 'literal', value: ['codex'] },
      modelId: { kind: 'literal', value: 'selected-model' },
    } };
    const store = createInMemoryWorkflowCoordinatorStore();
    const coordinator = createWorkflowCoordinator({ store, executeStep: async () => { throw new Error('Agent'); },
      resolveWorkspace: async () => ({ ok: true, workspace }), isAcceptedAuthorizationCurrent: async () => true,
      action: { executor, buildContext: async (input) => ({ surface: 'agent', authority: 'account_automation',
        actionCaller: { kind: 'workflowRun', runId: input.runId, authorization: input.authorization },
        callerPermissionMode: input.authorization.admittedPermissionCeiling,
        sessionAgentSpawnPolicyV1: { ...DEFAULT_SESSION_AGENT_SPAWN_POLICY_V1, allowModelOverride },
        agentStartContext: { caller: { kind: 'originless', runId: input.runId, runDepth: input.workDepth },
          baseline: { machineId: workspace.machineId, directory: workspace.directory },
          ledSubtreeSessionIds: [], roles: {}, workDepthLimit: 4, callerPermissionCeiling: 'default' },
        executionRunTargetMachineId: workspace.machineId,
        externalActionTarget: { kind: 'machine', machineId: workspace.machineId, project: { machineId: workspace.machineId, directory: workspace.directory } } }),
        observeRun: async () => ({ kind: 'completed', result: {}, commentIds: [], materialization: { kind: 'complete' } }) } });
    expect(await coordinator.run({ runId: `depth-${workDepth}`, workDepth, definition: definition([leaf]), inputs: {},
      executionTarget, authorization, materializedLeaves: [frozen(leaf)] }))
      .toMatchObject(workDepth === 4 ? { state: 'failed', reason: 'work_depth_exceeded' }
        : !allowModelOverride ? { state: 'failed', reason: 'policy_denied_field' } : { state: 'succeeded' });
    expect(starts).toBe(workDepth === 4 || !allowModelOverride ? 0 : 1);
    if (workDepth === 4 || !allowModelOverride) expect(store.list()[0]?.execution).toBeUndefined();
  });
  it('validates typed Action output against the frozen schema rather than a live replacement', async () => {
    const executor = createTestActionExecutor({ sessionGoalSet: async () => ({ ok: true }) });
    const store = createInMemoryWorkflowCoordinatorStore();
    const coordinator = createWorkflowCoordinator({ store, executeStep: async () => { throw new Error('Agent'); },
      resolveWorkspace: async () => ({ ok: true, workspace }), isAcceptedAuthorizationCurrent: async () => true,
      action: { executor, buildContext: async () => ({ surface: 'cli' }), observeRun: async () => { throw new Error('No runs'); } } });
    const sidecar = frozen(goal);
    expect(await coordinator.run({ runId: 'schema-drift', definition: definition([goal]), inputs: {}, executionTarget,
      authorization, originSessionId: 'origin', materializedLeaves: [{ ...sidecar, actionContract: {
        ...sidecar.actionContract!, outputSchema: { type: 'object', required: ['acceptedAnswer'] },
      } }] })).toMatchObject({ state: 'failed', reason: 'schema_mismatch' });
    expect(store.list().find((row) => row.blockId === goal.id)).toMatchObject({ lifecycle: 'failed', reason: 'schema_mismatch' });
  });
  it('uses isolated inline Workflow frames for repeated children with colliding ids', async () => {
    let writes = 0;
    const executor = createTestActionExecutor({ sessionGoalSet: async () => { writes++; return { ok: true }; } });
    const store = createInMemoryWorkflowCoordinatorStore();
    const first = { kind: 'workflow' as const, id: 'first', workflowRef: 'builtin:child', input: {} };
    const second = { ...first, id: 'second' };
    const child = { ...definition([goal]), finalOutput: { kind: 'result' as const,
      producer: { blockId: goal.id, scope: { kind: 'current' as const } }, path: [] } };
    const coordinator = createWorkflowCoordinator({ store, executeStep: async () => { throw new Error('Agent dispatch'); },
      resolveWorkspace: async () => ({ ok: true, workspace }), isAcceptedAuthorizationCurrent: async () => true,
      action: { executor, buildContext: async () => ({ surface: 'cli' }), observeRun: async () => { throw new Error('No runs'); } } });
    const leaves: WorkflowMaterializedLeafV1[] = [frozen(goal), { ...frozen(goal), sourceKey: first.workflowRef },
      ...[first, second].map((leaf) => ({ authoredWorkspace: { kind: 'inherit' as const }, sourceKey: '$root', blockId: leaf.id, kind: 'workflow' as const,
        selection: {}, executionTarget, childRef: leaf.workflowRef }))];
    expect(await coordinator.run({ runId: 'nested', definition: { ...definition([goal, first, second]), finalOutput: {
      kind: 'result', producer: { blockId: second.id, scope: { kind: 'current' } }, path: [] } },
      frozenChildren: { [first.workflowRef]: child }, materializedLeaves: leaves, inputs: {}, executionTarget, authorization,
      originSessionId: 'origin' })).toMatchObject({ state: 'succeeded', finalOutput: { ok: true } });
    expect(writes).toBe(3);
    expect(store.list().filter((row) => row.blockId === goal.id).map((row) => row.path.scope))
      .toEqual([[], [{ kind: 'workflow', blockId: first.id }], [{ kind: 'workflow', blockId: second.id }]]);
  });
  it.each(['review.start', 'subagents.plan.start'] as const)('persists %s launches before observing, and replays only observations', async (actionId) => {
    let starts = 0;
    const executor = createTestActionExecutor({
      executionRunCheckProtocolV2: async () => ({ ok: true }),
      executionRunStart: async (_sessionId, request) => {
        starts++;
        if (starts === 3) throw Object.assign(new Error('engine launch failed'), {
          details: withExecutionRunStartFailureDetails(undefined, 'noRunCreated'),
        });
        return { runId: `run-${starts}`, callId: `call-${starts}`, sidechainId: `call-${starts}` };
      },
      reviewEnginesList: async () => ({ items: ['codex', 'claude', 'gemini'].map((value) => ({ value, label: value })) }),
    }); // Native machine start and inventory transport boundaries.
    const leaf: WorkflowActionLeafV1 = { kind: 'action', id: 'panel', actionId, input: {
      target: { kind: 'literal', value: { kind: 'detached' } },
      instructions: { kind: 'literal', value: 'Work' },
      [actionId === 'review.start' ? 'engineIds' : 'backendTargetKeys']: { kind: 'literal',
        value: actionId === 'review.start' ? ['codex', 'claude', 'gemini'] : ['agent:codex', 'agent:claude', 'agent:gemini'] },
    } };
    const store = createInMemoryWorkflowCoordinatorStore();
    let cut = true;
    const boundary = { ...store, commitFact: async (fact: Parameters<typeof store.commitFact>[0]) => {
      const row = await store.commitFact(fact);
      if (cut && fact.lifecycle === 'running' && fact.execution?.kind === 'action' && fact.execution.awaitedRuns) {
        cut = false; throw new WorkflowRuntimeInterruption();
      }
      return row;
    } };
    const observed: string[] = [];
    const coordinator = createWorkflowCoordinator({ store: boundary,
      executeStep: async () => { throw new Error('Agent dispatch'); }, resolveWorkspace: async () => ({ ok: true, workspace }),
      isAcceptedAuthorizationCurrent: async () => true,
      action: { executor, buildContext: async () => ({ surface: 'cli', externalActionTarget: {
        kind: 'machine', machineId: workspace.machineId, project: { machineId: workspace.machineId, directory: workspace.directory } } }),
        observeRun: async (run) => {
          expect(store.list()[0]?.execution).toMatchObject({ kind: 'action', awaitedRuns: [{ runId: 'run-1' }, { runId: 'run-2' }] });
          observed.push(run.runId);
          return run.runId === 'run-1' ? { kind: 'completed', result: { plan: 'ready' }, reviewedFingerprint: 'fingerprint',
            commentIds: ['comment'], materialization: { kind: 'complete' } } : { kind: 'failed', code: 'native_failed' };
        } },
    });
    const params = { runId: actionId, definition: definition([leaf]), materializedLeaves: [frozen(leaf)], inputs: {}, executionTarget, authorization };
    await expect(coordinator.run(params)).rejects.toBeInstanceOf(WorkflowRuntimeInterruption);
    expect(starts).toBe(3);
    expect(observed).toEqual([]);
    expect(await coordinator.run(params)).toMatchObject({ state: 'succeeded' });
    expect(observed).toEqual(['run-1', 'run-2']);
    expect(starts).toBe(3);
    expect(store.list()[0]?.result).toMatchObject({ perEngineOutcome: [
      { outcome: 'completed' }, { outcome: 'failed', errorCode: 'native_failed' }, { outcome: 'launch_failed' },
    ] });
    if (actionId === 'review.start') expect(store.list()[0]?.result).toMatchObject({ reviewedFingerprint: null, commentIds: ['comment'] });
  });

  it('holds the exact validated Action output and never re-invokes it on held replay', async () => {
    let effects = 0;
    let entries = 0;
    const reviewed = { ...goal, pauseForReview: true };
    const executor = createTestActionExecutor({ sessionGoalSet: async () => { effects++; return { ok: true }; } });
    const store = createInMemoryWorkflowCoordinatorStore();
    const coordinator = createWorkflowCoordinator({ store, executeStep: async () => { throw new Error('Agent dispatch'); },
      resolveWorkspace: async () => ({ ok: true, workspace }), isAcceptedAuthorizationCurrent: async () => true,
      onReviewEntered: async () => { entries++; },
      action: { executor, buildContext: async () => ({ surface: 'cli', authority: 'account_automation' }),
        observeRun: async () => { throw new Error('Immediate Action observation'); } } });
    const params = { runId: 'reviewed-action', definition: definition([reviewed]), materializedLeaves: [frozen(reviewed)],
      inputs: {}, executionTarget, authorization, originSessionId: 'origin' };
    expect(await coordinator.run(params)).toMatchObject({ state: 'waiting_for_review' });
    expect(store.list()[0]).toMatchObject({ lifecycle: 'waiting_for_review', result: { ok: true },
      review: { resultSource: { kind: 'execution_input' } } });
    expect(await coordinator.run(params)).toMatchObject({ state: 'waiting_for_review' });
    expect(effects).toBe(1); expect(entries).toBe(1);
    await store.commitFact({ key: store.list()[0]!.key, lifecycle: 'completed' });
    expect(await coordinator.run(params)).toMatchObject({ state: 'succeeded' });
    expect(effects).toBe(1);
  });
  it('runs the real immediate Action with the bound origin and persists a typed result', async () => {
    const writes: unknown[] = [];
    const executor = createTestActionExecutor({ sessionGoalSet: async (value) => { writes.push(value); return { ok: true }; } });
    const store = createInMemoryWorkflowCoordinatorStore();
    const coordinator = createWorkflowCoordinator({ store, executeStep: async () => { throw new Error('Agent dispatch'); },
      resolveWorkspace: async () => ({ ok: true, workspace }), isAcceptedAuthorizationCurrent: async () => true,
      action: { executor, buildContext: async () => ({ surface: 'cli', authority: 'account_automation' }), observeRun: async () => { throw new Error('Immediate Action observation'); } },
    });
    const result = await coordinator.run({ runId: 'immediate', definition: definition([goal]), materializedLeaves: [frozen(goal)],
      inputs: {}, executionTarget, authorization, originSessionId: 'origin' });
    expect(result).toMatchObject({ state: 'succeeded' });
    expect(writes).toEqual([{ sessionId: 'origin', status: 'complete' }]);
    expect(store.list()[0]).toMatchObject({ blockKind: 'action', lifecycle: 'completed', result: { ok: true },
      execution: { kind: 'action', actionId: 'session.goal.set', actionRequestId: expect.any(String) } });
  });

  it('keeps a lost invoke response uncertain and never invokes it on replay', async () => {
    let effects = 0;
    const executor = createTestActionExecutor({ sessionGoalSet: async () => { effects++; throw new Error('response lost'); } });
    const store = createInMemoryWorkflowCoordinatorStore();
    const coordinator = createWorkflowCoordinator({ store, executeStep: async () => { throw new Error('Agent dispatch'); },
      resolveWorkspace: async () => ({ ok: true, workspace }), isAcceptedAuthorizationCurrent: async () => true,
      action: { executor, buildContext: async () => ({ surface: 'cli', authority: 'account_automation' }), observeRun: async () => { throw new Error('No launch fact'); } },
    });
    const params = { runId: 'lost', definition: definition([goal]), materializedLeaves: [frozen(goal)], inputs: {}, executionTarget,
      authorization, originSessionId: 'origin' };
    expect(await coordinator.run(params)).toMatchObject({ state: 'outcome_uncertain' });
    expect(await coordinator.run(params)).toMatchObject({ state: 'outcome_uncertain' });
    expect(effects).toBe(1);
  });

  it('rejects a runtime input binding with pointer issues before Action admission', async () => {
    let effects = 0;
    const executor = createTestActionExecutor({ sessionGoalSet: async () => { effects++; return { ok: true }; } });
    const store = createInMemoryWorkflowCoordinatorStore();
    const leaf = { ...goal, input: { ...goal.input, status: { kind: 'literal' as const, value: 42 } } };
    const coordinator = createWorkflowCoordinator({ store, executeStep: async () => { throw new Error('Agent dispatch'); },
      resolveWorkspace: async () => ({ ok: true, workspace }), isAcceptedAuthorizationCurrent: async () => true,
      action: { executor, buildContext: async () => ({ surface: 'cli', authority: 'account_automation' }), observeRun: async () => { throw new Error('No launch'); } },
    });
    expect(await coordinator.run({ runId: 'invalid', definition: definition([leaf]), materializedLeaves: [frozen(leaf)], inputs: {},
      executionTarget, authorization, originSessionId: 'origin' })).toMatchObject({ state: 'failed', reason: 'invalid_input' });
    expect(effects).toBe(0);
    expect(store.list()[0]).toMatchObject({ lifecycle: 'failed', validationIssues: expect.arrayContaining([expect.objectContaining({ pointer: '/status' })]) });
    expect(store.list()[0]?.execution).toBeUndefined();
  });
});
