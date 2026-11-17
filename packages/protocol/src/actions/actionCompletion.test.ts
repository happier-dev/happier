import { describe, expect, it } from 'vitest';
import { createActionExecutor, type ActionExecutorDeps } from './actionExecutor.js';

import { getActionSpec } from './actionSpecs.js';
import { serializeActionSpec } from './actionCatalog.js';
import { reviewStartExecutionRunCompletion } from './specs/executionRunCompletion.js';
import { readActionCompletionRunObservationV1, prepareActionCompletionV1,
  freezeActionCompletionContractV1, resumeActionCompletionV1 } from './actionCompletion.js';

describe('Action completion contract', () => {
  it('retains the admitted Review binding after a clean direct reviewer completes', () => {
    const declaration = reviewStartExecutionRunCompletion;
    const reviewRound = { reviewId: 'review-existing', roundOrdinal: 2 };
    const value = declaration.terminal({ intent: 'review', sessionId: 'source', reviewRound,
      results: [{ key: 'reviewer-1', ok: true, result: { runId: 'run-clean' } }] },
    [{ key: 'reviewer-1', runId: 'run-clean', outcome: { kind: 'completed', result: {}, commentIds: [],
      materialization: { kind: 'complete' } } }]);
    expect(declaration.terminalOutputSchema.parse(value)).toMatchObject({ reviewRound, commentIds: [] });
  });
  it('preserves native partial review coverage independently of complete comment publication', () => {
    const outcome = readActionCompletionRunObservationV1({ run: { status: 'succeeded' }, latestToolResult: {
      reviewOutcome: 'partial', commentIds: [], materialization: { kind: 'complete' },
    } });
    expect(outcome).toMatchObject({ kind: 'completed', reviewOutcome: 'partial', materialization: { kind: 'complete' } });
    expect(reviewStartExecutionRunCompletion.terminal({ intent: 'review', sessionId: 'source',
      results: [{ key: 'reviewer', ok: true, result: { runId: 'partial' } }] }, [{ key: 'reviewer', runId: 'partial', outcome }]))
      .toMatchObject({ perEngineOutcome: [{ outcome: 'completed', reviewOutcome: 'partial' }] });
  });
  it.each([undefined, { kind: 'review_walkthrough', comparisonId: 'c' }] as const)('CC5 carries runtime issue through terminal Action values (%s)', (observation) => {
    const runtimeIssueV1 = { v: 1, scope: 'primary_session', status: 'failed', code: 'usage_limit', source: 'usage_limit', occurredAt: 1, failureCause: { phase: 'client_start', failureReason: 'usage_limit', retryable: false } } as const;
    const outcome = readActionCompletionRunObservationV1({ run: { status: 'failed', error: { code: 'execution_run_failed', runtimeIssueV1 } } }, observation);
    expect(outcome).toMatchObject({ kind: 'failed', runtimeIssueV1 });
    const declaration = reviewStartExecutionRunCompletion;
    const value = declaration.terminal({ intent: 'review', sessionId: null, results: [{ key: 'engine', ok: true, result: { runId: 'r' } }] }, [{ key: 'engine', runId: 'r', outcome }]);
    expect(declaration.terminalOutputSchema.parse(value)).toMatchObject({ perEngineOutcome: [{ runtimeIssueV1 }] });
  });
  it('preserves the source failure cause separately from failed Action details', () => {
    const failureCause = { phase: 'workflow.run.wait', errorClass: 'Error', errorCode: 'ECONNRESET', httpStatus: null } as const;
    const details = { reason: 'connection_lost' };
    expect(prepareActionCompletionV1(undefined, { ok: false, errorCode: 'storage_unavailable',
      error: 'unavailable', details, failureCause })).toEqual({ kind: 'failed', errorCode: 'storage_unavailable',
      error: 'unavailable', value: details, failureCause });
  });
  it('waits for the qualified pending deployment operation and accepts only its completed Environment receipt', async () => {
    const actionId = 'deployments.deploy';
    const declaration = getActionSpec(actionId).completion;
    if (!declaration) throw new Error('Deployment completion is unavailable');
    const pending = { ok: true, environmentId: 'environment', revision: 3, kind: 'pending', actionOperationId: 'operation' };
    const address = { serverId: 'home', machineId: 'accepted-host', operationId: pending.actionOperationId };
    const accepted = { ...pending, operation: address };
    const prepare = (result: unknown) => prepareActionCompletionV1(declaration, { ok: true, result }, { serverId: 'home' });
    const prepared = prepare(accepted);
    expect(prepared.kind).toBe('awaiting');
    if (prepared.kind !== 'awaiting') throw new Error('Pending deployment must await its accepted operation');
    expect(prepared.state.awaitedOperations).toEqual([{ key: 'deployment', ...address }]);
    expect(prepare(pending).kind).toBe('outcome_uncertain');
    expect(prepare({ ...accepted, operation: { ...address, operationId: 'different-operation' } }).kind).toBe('outcome_uncertain');
    const receipt = { ok: true, environmentId: pending.environmentId, revision: 4,
      deploymentId: 'receipt', deploymentRevision: 2, state: 'succeeded' };
    expect(prepare(receipt)).toEqual({ kind: 'completed', value: receipt });
    for (const state of ['queued', 'running', 'waitingApproval']) {
      expect(prepare({ ...receipt, state }).kind).toBe('outcome_uncertain');
    }
    const operation = { version: 1, operationId: address.operationId, revision: 3, actionId,
      state: 'succeeded', scope: { accountId: 'requester', machineId: address.machineId }, title: 'Deploy',
      createdAt: 1, startedAt: 2, settledAt: 3, cancellation: 'supported', result: receipt };
    const resume = (observed: unknown, state = prepared.state) => resumeActionCompletionV1({ actionId,
      completion: freezeActionCompletionContractV1(declaration), state,
      resolveDeclaration: id => id === actionId ? declaration : undefined,
      observeOperation: async () => observed });
    expect(await resume(operation)).toEqual({ kind: 'completed', value: receipt });
    for (const other of [
      { ...operation, operationId: 'other' },
      { ...operation, result: { ...receipt, environmentId: 'other' } },
      { ...operation, result: accepted },
      { ...operation, result: { ...receipt, state: 'running' } },
    ]) expect((await resume(other)).kind).toBe('outcome_uncertain');
    expect((await resume(operation, { ...prepared.state, awaitedOperations: [{ key: 'deployment', ...address, serverId: 'other-home' }] })).kind)
      .toBe('outcome_uncertain');
    const { result: _result, ...withoutResult } = operation;
    expect((await resume({ ...withoutResult, state: 'failed', error: {
      errorCode: 'permission_denied', error: 'Permission denied' } }))).toMatchObject({
      kind: 'failed', errorCode: 'permission_denied',
    });
    expect((await resume({ ...withoutResult, state: 'cancelled' })).kind).toBe('cancelled');
  });

  it('observes settled walkthrough output independently of a healthy retained process', () => {
    const output = {
      success: true, sourceKey: 'comparison-1', summaryMarkdown: undefined,
      metadata: { source: { kind: 'workingTree' }, sourceKey: 'comparison-1' },
      resultId: 'saved-1', revision: 2,
      comparison: { id: 'comparison-1', source: { kind: 'workingTree' }, repository: { rootPath: '/repo' },
        endpoints: { before: 'a', after: 'b' }, inventory: { state: 'complete', reasons: [], files: [] } },
      requestedOutputs: ['walkthrough'], outputs: { walkthrough: { state: 'partial',
        value: { title: 'Changes', intro: '', stops: [], otherChangeRefs: [] }, reason: 'cancelled' } },
      analysis: { suppliedChangeRefs: [], analysedChangeRefs: [], remainingChangeRefs: [] },
    };
    const native = { run: { status: 'running' as const }, structuredMeta: { kind: 'scm_diff_summary.v1', payload: output } };
    expect(readActionCompletionRunObservationV1(native, { kind: 'review_walkthrough', comparisonId: 'comparison-1' }))
      .toMatchObject({ kind: 'completed', result: { sourceKey: 'comparison-1' } });
    expect(readActionCompletionRunObservationV1(native, { kind: 'review_walkthrough', comparisonId: 'other' }))
      .toMatchObject({ kind: 'outcome_uncertain' });
    const continuation = { kind: 'review_walkthrough' as const, comparisonId: 'comparison-1', resultId: 'saved-1', afterRevision: 2 };
    expect(readActionCompletionRunObservationV1(native, continuation))
      .toMatchObject({ kind: 'outcome_uncertain', code: 'execution_run_output_not_settled' });
    expect(readActionCompletionRunObservationV1({ ...native, structuredMeta: { ...native.structuredMeta,
      payload: { ...output, revision: 3 } } }, continuation)).toMatchObject({ kind: 'completed' });
    expect(readActionCompletionRunObservationV1({ ...native, run: { status: 'running', error: { code: 'revision_conflict' } },
      structuredMeta: { ...native.structuredMeta, payload: { ...output, revision: 3 } } }, continuation))
      .toEqual({ kind: 'failed', code: 'revision_conflict' });
    expect(readActionCompletionRunObservationV1({ ...native, structuredMeta: { ...native.structuredMeta,
      payload: { ...output, revision: 3, resultId: 'foreign' } } }, continuation)).toMatchObject({ kind: 'outcome_uncertain' });
    expect(readActionCompletionRunObservationV1({ ...native, structuredMeta: { kind: 'scm_diff_summary.v1',
      payload: { ...output, outputs: { walkthrough: { state: 'writing' } } } } },
    { kind: 'review_walkthrough', comparisonId: 'comparison-1' })).toMatchObject({ kind: 'outcome_uncertain' });
    expect(readActionCompletionRunObservationV1({ ...native, run: { status: 'running',
      error: { code: 'execution_run_send_outcome_unknown' } } },
    { kind: 'review_walkthrough', comparisonId: 'comparison-1' }))
      .toMatchObject({ kind: 'outcome_uncertain', code: 'execution_run_send_outcome_unknown' });
    expect(readActionCompletionRunObservationV1({ ...native, run: { status: 'succeeded' },
      structuredMeta: { kind: 'scm_diff_summary.v1', payload: { ...output, outputs: { walkthrough: { state: 'writing' } } } } },
    { kind: 'review_walkthrough', comparisonId: 'comparison-1' }))
      .toMatchObject({ kind: 'outcome_uncertain', code: 'execution_run_result_unavailable' });
  });
  it('links one narrator operation without treating it as an additional reviewer', () => {
    const launched = reviewStartExecutionRunCompletion.launched({ intent: 'review', sessionId: 's1', results: [
      { key: 'codex', ok: true, result: { runId: 'review-1' } },
    ], narration: { runId: 'narrator-1', comparisonId: 'comparison-1', state: 'collecting', mode: 'seeded_narrator' } });
    expect(launched.runs).toEqual([{ key: 'codex', runId: 'review-1' }, { key: 'narrator', runId: 'narrator-1',
      observation: { kind: 'review_walkthrough', comparisonId: 'comparison-1' } }]);
  });
  it('reads terminal native output and materialized review evidence without inventing comments', () => {
    expect(readActionCompletionRunObservationV1({ run: { status: 'succeeded' }, latestToolResult: {
      reviewedFingerprint: 'fingerprint', commentIds: ['comment-1'], materialization: { kind: 'complete' }, findings: [],
      summary: undefined,
    } })).toMatchObject({ kind: 'completed', result: { findings: [] }, reviewedFingerprint: 'fingerprint',
      commentIds: ['comment-1'], materialization: { kind: 'complete' } });
    // Raw JSON model output can itself have an output member; it is not a host envelope.
    expect(readActionCompletionRunObservationV1({ run: { status: 'succeeded' }, latestToolResult: { output: { value: 'raw' } } }))
      .toEqual({ kind: 'completed', result: { output: { value: 'raw' } } });
    expect(readActionCompletionRunObservationV1({ run: { status: 'timeout', error: { code: 'budget' } } }))
      .toEqual({ kind: 'failed', code: 'budget' });
    expect(readActionCompletionRunObservationV1({ run: { status: 'succeeded' }, latestToolResult: undefined }))
      .toMatchObject({ kind: 'outcome_uncertain' });
  });
  it.each(['review.start', 'subagents.plan.start'] as const)('declares execution-run completion for %s', (actionId) => {
    const spec = getActionSpec(actionId);
    expect(spec).toMatchObject({ completion: { awaits: 'execution_runs' } });
    expect(serializeActionSpec(spec)).not.toHaveProperty('completion');
  });

  it('starts explicit detached plans in the supplied workspace, without manufacturing a session', async () => {
    const starts: unknown[] = [];
    const executor = createActionExecutor({
      executionRunCheckProtocolV2: async () => ({ ok: true }),
      executionRunStart: async (sessionId, request, opts) => {
        starts.push({ sessionId, request, opts });
        return { runId: 'plan-1', callId: 'call-1', sidechainId: 'call-1' };
      },
    } as ActionExecutorDeps); // Only the execution-run transport is exercised.
    const input = { target: { kind: 'detached' }, backendTargetKeys: ['agent:codex'], instructions: 'Plan' };
    const context = {
      surface: 'cli' as const,
      defaultSessionId: 'irrelevant-default',
      externalActionTarget: { kind: 'machine' as const, machineId: 'machine-1', project: { directory: '/workspace' } },
    };
    expect(await executor.execute('subagents.plan.start', input, context)).toMatchObject({ ok: true });
    expect(starts).toEqual([{
      sessionId: null,
      request: expect.objectContaining({ intent: 'plan', cwd: '/workspace' }),
      opts: expect.objectContaining({ targetMachineId: 'machine-1' }),
    }]);
    expect(await executor.execute('subagents.plan.start', { ...input, target: undefined }, { surface: 'cli' }))
      .toMatchObject({ ok: false, errorCode: 'session_not_selected' });
  });

  it('requires the detached protocol rather than routing a detached plan through a session', async () => {
    const executor = createActionExecutor({} as ActionExecutorDeps);
    expect(await executor.execute('subagents.plan.start', {
      target: { kind: 'detached' }, backendTargetKeys: ['agent:codex'], instructions: 'Plan',
    }, { surface: 'cli' })).toMatchObject({ ok: false, errorCode: 'execution_run_protocol_unsupported' });
  });

  it('sets the explicitly bound origin goal even when the caller has a different default session', async () => {
    const mutations: unknown[] = [];
    const executor = createActionExecutor({
      sessionGoalSet: async (input) => { mutations.push(input); return { ok: true }; },
    } as ActionExecutorDeps);
    expect(await executor.execute('session.goal.set', {
      sessionId: 'authorized-origin', status: 'complete',
    }, { surface: 'cli', defaultSessionId: 'different-session' })).toMatchObject({ ok: true });
    expect(mutations).toEqual([{ sessionId: 'authorized-origin', status: 'complete' }]);
    expect(await executor.execute('session.goal.set', { status: 'complete' }, { surface: 'cli' }))
      .toMatchObject({ ok: false });
  });

  it('preserves explicit no-wake goal intent and cancellation through Action dispatch', async () => {
    const mutations: unknown[] = [];
    const controller = new AbortController();
    const executor = createActionExecutor({
      sessionGoalSet: async input => { mutations.push(input); return { ok: true }; },
    } as ActionExecutorDeps);
    expect(await executor.execute('session.goal.set', {
      sessionId: 'goal-session', objective: 'Save for later', resumeInactiveWithInitialGoal: false,
    }, { surface: 'cli', signal: controller.signal, actionRequestId: 'goal-request' })).toMatchObject({ ok: true });
    expect(mutations).toEqual([{ sessionId: 'goal-session', objective: 'Save for later',
      resumeInactiveWithInitialGoal: false, signal: controller.signal, actionRequestId: 'goal-request' }]);
  });

  it('refuses an Agent wake before dispatch when canonical start authority is unavailable', async () => {
    let effects = 0;
    const executor = createActionExecutor({
      sessionGoalSet: async () => { effects++; return { ok: true }; },
    } as ActionExecutorDeps);
    expect(await executor.execute('session.goal.set', { sessionId: 'goal-session', objective: 'Finish',
      resumeInactiveWithInitialGoal: true }, { surface: 'agent', defaultSessionId: 'goal-session', authority: 'account_automation', callerPermissionMode: 'default' }))
      .toMatchObject({ ok: false, errorCode: 'target_unavailable' });
    expect(effects).toBe(0);
    expect(await executor.execute('session.goal.set', { sessionId: 'goal-session', objective: 'Save for later',
      resumeInactiveWithInitialGoal: false }, { surface: 'agent', defaultSessionId: 'goal-session', authority: 'account_automation', callerPermissionMode: 'default' }))
      .toMatchObject({ ok: true });
  });

  it('refuses contradictory detached and explicit session targets before starting a run', async () => {
    let starts = 0;
    const executor = createActionExecutor({
      executionRunCheckProtocolV2: async () => ({ ok: true }),
      executionRunStart: async () => { starts++; return { runId: 'r', callId: 'c', sidechainId: 'c' }; },
    } as ActionExecutorDeps);
    expect(await executor.execute('subagents.plan.start', {
      target: { kind: 'detached' }, sessionId: 'explicit-session',
      backendTargetKeys: ['agent:codex'], instructions: 'Plan',
    }, { surface: 'cli' })).toMatchObject({ ok: false, errorCode: 'invalid_parameters' });
    expect(starts).toBe(0);
  });
});
