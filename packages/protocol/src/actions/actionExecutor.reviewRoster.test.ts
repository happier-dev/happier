import { describe, expect, it } from 'vitest';

import { createActionExecutor, type ActionExecutorDeps } from './actionExecutor.js';
import { ExecutionRunStartRequestSchema } from '../execution/runs/startRequest.js';
import { createReviewRecordPortV1, ReviewRoundBindingV1Schema, type ReviewArtifactTransportV1 } from '../reviews/reviewArtifactV1.js';
import { ScmComparisonCaptureInputSchema, ScmComparisonCaptureOutputSchema } from '../scm/diffSummary.js';
import { ReviewStartInputSchema } from '../reviews/reviewStart.js';
import { createInMemoryReviewRecordPortV1 } from '../reviews/reviewArtifactV1.testkit.js';
import { dispatchReviewDispatch2 } from './executor/review/dispatch.js';
import { startExecutionRunWithSelectionV1 } from './executor/executionRuns.js';
import { ActionExecuteFailureSchema, createActionExecuteFailureError } from './actionExecutionResult.js';
import { ReviewStartTerminalValueV1Schema, readReviewStartActionResultV1 } from './specs/executionRunCompletion.js';
import { ReviewEngineInventorySchema } from '../reviews/reviewEngines.js';

function observeReviewPersistence(events: string[]) {
  let row: Awaited<ReturnType<ReviewArtifactTransportV1['read']>> = null;
  const records = createReviewRecordPortV1({
    read: async () => row,
    create: async input => {
      events.push('record');
      row = { ...input, revision: { headerVersion: 1, bodyVersion: 1 } };
      return row;
    },
    update: async () => { throw new Error('No settlement expected during initial launch'); },
  });
  return { records, read: () => row };
}

describe('Review roster leaves', () => {
  it('keeps a saved Hunt scope refusal while the same reviewer remains available for a comparison', async () => {
    // Captured Machine inventory and Hunt inputs: QA-P04 run 958cfc2e,
    // QA-P01 hunt-scoped-engine-inventory-replay.json. Only the Machine RPC
    // and native process are substituted; Action admission/dispatch stay real.
    const engine = ReviewEngineInventorySchema.parse({ items: [{
      engineId: 'roborev', value: 'agent:happier.review.roborev/roborev', label: 'roborev',
      enabled: false, available: false, unavailableCode: 'review_scope_unsupported',
      capabilities: { structuredNarration: false, sessionTranscript: true },
      retentionPolicy: 'ephemeral', readiness: 'ready', reviewScopes: ['worktree'],
      profileId: 'happier.review.roborev/review',
    }] });
    const records = createInMemoryReviewRecordPortV1();
    const requests: ReturnType<typeof ExecutionRunStartRequestSchema.parse>[] = [];
    const inventoryRequests: unknown[] = [];
    const executor = createActionExecutor({
      reviewRecords: () => records,
      reviewEnginesList: async input => {
        inventoryRequests.push(input);
        if (input.scope === 'repository') return input.includeDisabled ? engine : { items: [] };
        return ReviewEngineInventorySchema.parse({ items: engine.items.map(item => ({
          ...item, enabled: true, available: true, unavailableCode: undefined,
        })) });
      },
      executionRunCheckProtocolV2: async () => ({ ok: true as const }),
      executionRunStart: async (_sessionId, input) => {
        requests.push(ExecutionRunStartRequestSchema.parse(input));
        return { runId: 'comparison-review', callId: 'call', sidechainId: 'call' };
      },
      scmActionExecute: async ({ input }) => {
        const capture = ScmComparisonCaptureInputSchema.parse(input);
        return ScmComparisonCaptureOutputSchema.parse({ success: true, comparison: {
          id: 'c'.repeat(64), source: capture.source ?? { kind: 'workingTree' },
          repository: { rootPath: capture.cwd }, endpoints: {},
          inventory: { state: 'complete', files: [], reasons: [] },
        }, metadata: { source: capture.source ?? { kind: 'workingTree' }, sourceKey: 'c'.repeat(64) } });
      },
    } satisfies ActionExecutorDeps);
    const input = ReviewStartInputSchema.parse({ target: { kind: 'detached' }, cwd: '/repo', scope: 'repository',
      reviewers: [{ kind: 'engine', engineId: 'agent:happier.review.roborev/roborev',
        runnerAgentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.claude', localId: 'claude' } },
        teamCredentialModel: { kind: 'team_credential_provider_model',
          resourceId: '181625b4-b3a0-4611-b474-d6ef874250d7', teamId: 'cmwtcok9c01j2o3mc07iyzgmy',
          expectedResourceRevision: 0, agentTargetKey: 'agent:happier.agent.claude/claude',
          modelId: 'muse-spark-1.3-contributor', deliveryMode: 'brokered' },
      }], instructions: 'Review read-only using the selected Team Muse source. Do not edit files.' });
    const context = { surface: 'agent' as const, executionRunTargetMachineId: 'machine',
      agentStartContext: { caller: { kind: 'originless' as const, runId: '958cfc2e-5af4-473c-a9a9-e1a20d7163d7', runDepth: 0 },
        baseline: { machineId: 'machine', directory: '/repo' }, ledSubtreeSessionIds: [], workDepthLimit: 4,
        roles: {}, callerPermissionCeiling: 'read-only' as const },
      actionCaller: { kind: 'workflowRun' as const, runId: '958cfc2e-5af4-473c-a9a9-e1a20d7163d7',
        authorization: { principal: { kind: 'host' as const }, admittedPermissionCeiling: 'read-only' as const } } };
    const comparison = await executor.execute('review.start', { ...input, scope: 'changes' }, context);
    expect(comparison, JSON.stringify(comparison)).toMatchObject({ ok: true });
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ runnerAgentTarget: {
      kind: 'agent', identity: { pluginId: 'happier.agent.claude', localId: 'claude' },
    } });
    const refused = await executor.execute('review.start', input, context);
    expect(refused, JSON.stringify(refused)).toMatchObject({ ok: true, result: {
      results: [{ ok: false, errorCode: 'review_scope_unsupported', error: 'review_scope_unsupported' }],
    } });
    if (!refused.ok) throw new Error('Expected retained launch refusal');
    const retained = readReviewStartActionResultV1(refused, input);
    if (retained.kind !== 'native' || !retained.reviewRound) throw new Error('Expected durable Hunt round');
    expect((await records.read(retained.reviewRound.reviewId))?.rounds[0]?.reviewerOutcomes?.[0]?.reason)
      .toMatchObject({ run: 'launch_failed', errorCode: 'review_scope_unsupported' });
    expect(requests).toHaveLength(1);
    expect(inventoryRequests).toMatchObject([
      { includeDisabled: true, scope: 'worktree', engineIds: ['agent:happier.review.roborev/roborev'] },
      { includeDisabled: true, scope: 'repository', engineIds: ['agent:happier.review.roborev/roborev'] },
    ]);
  });
  it('retains the engine inventory refusal through Workflow completion and settled round reads', async () => {
    const records = createInMemoryReviewRecordPortV1();
    const refusal = ActionExecuteFailureSchema.parse({ ok: false, errorCode: 'review_engine_unavailable',
      error: 'Reconnect the selected reviewer account.', requestId: 'inventory-request',
      failureCause: { phase: 'review.engine.inventory', errorClass: 'HttpStatusError', errorCode: 'account_disconnected', httpStatus: 403 },
      details: { reason: 'account_disconnected' }, effectAttempted: false });
    const reviewRound = await records.start({ reviewId: 'refused-review', title: 'Review', subjectKind: 'repository',
      sourceKind: 'workflow', reviewerIds: ['reviewer-1'], startedAt: 1 });
    const executor = createActionExecutor({ reviewRecords: () => records,
      reviewEnginesList: async () => { throw createActionExecuteFailureError(refusal); },
    } satisfies ActionExecutorDeps);
    const result = await executor.execute('review.start', { sessionId: 'source-session', scope: 'repository',
      reviewers: [{ kind: 'engine', engineId: 'codex' }], instructions: 'Review this repository.',
      reviewRound, reviewReviewerId: 'reviewer-1', reviewRoundSettlement: 'workflow',
    }, { surface: 'ui', defaultSessionId: 'source-session', defaultSessionMachineId: 'source-machine' });
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true, result: { perEngineOutcome: [{ key: 'reviewer-1', outcome: 'launch_failed',
      errorCode: refusal.errorCode, error: refusal.error, requestId: refusal.requestId,
      failureCause: refusal.failureCause, details: refusal.details }] } });
    if (!result.ok) throw new Error('Expected settled reviewer refusal');
    const terminal = ReviewStartTerminalValueV1Schema.parse(result.result);
    const settled = await executor.execute('review.settle_round', { reviewRound, reviewerResults: [terminal] },
      { surface: 'agent', actionCaller: { kind: 'workflowRun', runId: 'review-workflow',
        authorization: { principal: { kind: 'host' }, admittedPermissionCeiling: 'read-only' } } });
    expect(settled).toMatchObject(refusal);
    expect((await records.read(reviewRound.reviewId))?.rounds[0]?.reviewerOutcomes?.[0]?.reason)
      .toMatchObject({ run: 'launch_failed', errorCode: refusal.errorCode, error: refusal.error,
        requestId: refusal.requestId, failureCause: refusal.failureCause, details: refusal.details });
  });
  it.each(['clawpatch', 'roborev', 'deepsec'].flatMap(engineId =>
    ['claude', 'codex'].map(runnerId => ({ engineId, runnerId })),
  ))('routes the Team model through the $runnerId runner of $engineId', async ({ engineId, runnerId }) => {
    const records = createInMemoryReviewRecordPortV1();
    const requests: ReturnType<typeof ExecutionRunStartRequestSchema.parse>[] = [];
    const deps = {
      reviewRecords: () => records,
      // Machine inventory and process launch are the external boundaries. Review
      // dispatch, target normalization and Run admission remain real.
      reviewEnginesList: async () => ({ items: [{ value: engineId, label: engineId }] }),
      executionRunCheckProtocolV2: async () => ({ ok: true as const }),
      executionRunStart: async (_sessionId, request) => {
        requests.push(ExecutionRunStartRequestSchema.parse(request));
        return { runId: 'native-review-run', callId: 'call', sidechainId: 'call' };
      },
    } satisfies ActionExecutorDeps;
    const executor = createActionExecutor(deps);
    const reviewRound = await records.start({ reviewId: 'native-review', title: 'Native Review',
      subjectKind: 'repository', sourceKind: 'workflow', reviewerIds: ['reviewer-1'], startedAt: 1 });
    const runnerAgentTarget = { kind: 'agent', identity: { pluginId: `happier.agent.${runnerId}`, localId: runnerId } };
    const teamCredentialModel = { kind: 'team_credential_provider_model', teamId: 'qa-team', resourceId: 'muse-resource',
      expectedResourceRevision: 0, deliveryMode: 'brokered', modelId: 'muse-spark-1.3-contributor',
      agentTargetKey: `agent:happier.agent.${runnerId}/${runnerId}` };
    const start = async (agentTargetKey: string) => {
      const data = ReviewStartInputSchema.parse({ sessionId: 'source-session', scope: 'repository',
        instructions: 'Review this repository.', reviewers: [{ kind: 'engine', engineId, runnerAgentTarget,
          teamCredentialModel: { ...teamCredentialModel, agentTargetKey } }],
        reviewRound, reviewReviewerId: 'reviewer-1', reviewRoundSettlement: 'workflow' });
      return dispatchReviewDispatch2({ actionId: 'review.start', deps, data, parsed: { data }, ctx: { surface: 'ui' },
        workflowSessionScope: null,
        executeHostChild: (actionId, input, context) => executor.execute(actionId, input, context),
        startExecutionRunWithSelection: (...args) => startExecutionRunWithSelectionV1(deps, ...args) });
    };
    expect(await start(teamCredentialModel.agentTargetKey)).toMatchObject({ ok: true, result: { reviewRound } });
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ backendTarget: { kind: 'agent', identity: { localId: engineId } }, runnerAgentTarget, teamCredentialModel,
      modelId: teamCredentialModel.modelId, intentInput: { reviewers: [{ engineId, runnerAgentTarget }] } });
    expect(await start(`agent:happier.agent.${runnerId === 'claude' ? 'codex/codex' : 'claude/claude'}`))
      .toMatchObject({ ok: false, errorCode: 'invalid_parameters' });
    expect(requests).toHaveLength(1);
  });

  it.each([false, true])('assigns settlement to the actual round owner for an admitted Workflow caller (bound: %s)', async bound => {
    const records = createInMemoryReviewRecordPortV1();
    const requests: ReturnType<typeof ExecutionRunStartRequestSchema.parse>[] = [];
    const reviewRound = bound ? await records.start({ reviewId: 'composed-review', title: 'Composed Review',
      subjectKind: 'repository', sourceKind: 'workflow', reviewerIds: ['reviewer-1'], startedAt: 1 }) : undefined;
    const deps = {
      reviewRecords: () => records,
      reviewEnginesList: async () => ({ items: [{ value: 'codex', label: 'Codex' }] }),
      executionRunCheckProtocolV2: async () => ({ ok: true as const }),
      executionRunStart: async (_sessionId, request) => {
        requests.push(ExecutionRunStartRequestSchema.parse(request));
        return { runId: 'review-run', callId: 'call', sidechainId: 'call' };
      },
    } satisfies ActionExecutorDeps;
    const ctx = { surface: 'agent' as const, actionRequestId: 'workflow/review/1',
      executionRunTargetMachineId: 'machine-1', actionCaller: { kind: 'workflowRun' as const,
        runId: 'workflow', authorization: { principal: { kind: 'host' as const }, admittedPermissionCeiling: 'read-only' as const } } };
    const data = ReviewStartInputSchema.parse({ scope: 'repository', reviewers: [{ kind: 'engine', engineId: 'codex' }],
      instructions: 'Review this repository.', ...(reviewRound ? { reviewRound, reviewReviewerId: 'reviewer-1', reviewRoundSettlement: 'workflow' } : {}) });
    const executor = createActionExecutor(deps);
    expect(await dispatchReviewDispatch2({ actionId: 'review.start', deps, ctx, parsed: { data }, data,
      workflowSessionScope: { actionRequestId: ctx.actionRequestId, invocationId: 'review', sessions: [] },
      executeHostChild: (actionId, input, context) => executor.execute(actionId, input, context),
      startExecutionRunWithSelection: (...args) => startExecutionRunWithSelectionV1(deps, ...args),
    })).toMatchObject({ ok: true });
    expect(requests[0]?.intentInput).toMatchObject({ reviewRoundSettlement: bound ? 'workflow' : 'execution' });
  });

  it('captures default uncommitted evidence once before admitting the Review and launching its reviewer', async () => {
    const events: string[] = [];
    const persisted = observeReviewPersistence(events);
    const comparisonId = 'c'.repeat(64);
    const requests: ReturnType<typeof ExecutionRunStartRequestSchema.parse>[] = [];
    const captures: ReturnType<typeof ScmComparisonCaptureInputSchema.parse>[] = [];
    const executor = createActionExecutor({
      reviewRecords: () => persisted.records,
      reviewEnginesList: async () => ({ items: [{ value: 'codex', label: 'Codex' }] }),
      scmActionExecute: async ({ actionId, input }) => {
        expect(actionId).toBe('scm.diffSummary.capture');
        captures.push(ScmComparisonCaptureInputSchema.parse(input));
        events.push('capture');
        return ScmComparisonCaptureOutputSchema.parse({ success: true,
          comparison: { id: comparisonId, source: { kind: 'workingTree', area: 'pending' }, repository: { rootPath: '/repo' },
            endpoints: {}, inventory: { state: 'complete', files: [], reasons: [] } },
          metadata: { sourceKey: comparisonId, source: { kind: 'workingTree', area: 'pending' } },
        });
      },
      executionRunStart: async (_sessionId, request) => {
        events.push('run');
        requests.push(ExecutionRunStartRequestSchema.parse(request));
        return { runId: 'review-run', callId: 'call', sidechainId: 'call' };
      },
    } satisfies ActionExecutorDeps);
    expect(await executor.execute('review.start', { sessionId: 'source-session', cwd: '/repo',
      reviewers: [{ kind: 'engine', engineId: 'codex',
        runnerAgentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.claude', localId: 'claude' } },
        connectedServices: { v: 2, bindingsByServiceId: {
          'happier.agent.claude/claude-subscription': { source: 'connected', selection: 'profile', profileId: 'selected-account' },
        } } }], instructions: 'Review uncommitted changes.',
    }, { surface: 'ui', defaultSessionId: 'source-session', defaultSessionMachineId: 'source-machine' })).toMatchObject({ ok: true });
    expect(captures).toHaveLength(1);
    expect(captures[0]).toMatchObject({ cwd: '/repo', source: { kind: 'workingTree', area: 'pending' } });
    expect(events).toEqual(['capture', 'record', 'run']);
    expect(requests[0]).toMatchObject({
      runnerAgentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.claude', localId: 'claude' } },
      connectedServices: { v: 2, bindingsByServiceId: {
        'happier.agent.claude/claude-subscription': { source: 'connected', selection: 'profile', profileId: 'selected-account' },
      } },
      intentInput: { comparisonId },
    });
    const binding = ReviewRoundBindingV1Schema.parse(requests[0]?.intentInput?.reviewRound);
    expect((await persisted.records.read(binding.reviewId))?.rounds[0]).toMatchObject({ comparisonId });
  });

  it('leaves no admitted Review or reviewer when initial comparison capture is refused', async () => {
    const events: string[] = [];
    const persisted = observeReviewPersistence(events);
    const failureCause = { phase: 'scm.requester.native_preparation', errorClass: 'Error',
      errorCode: 'agent_isolation_unavailable', httpStatus: null };
    const executor = createActionExecutor({
      reviewRecords: () => persisted.records,
      reviewEnginesList: async () => ({ items: [{ value: 'codex', label: 'Codex' }] }),
      scmActionExecute: async ({ actionId, input }) => {
        expect(actionId).toBe('scm.diffSummary.capture');
        expect(ScmComparisonCaptureInputSchema.parse(input)).toMatchObject({ cwd: '/repo', source: { kind: 'workingTree' } });
        events.push('capture');
        return { success: false, errorCode: 'DIFF_UNAVAILABLE', error: 'Worktree capture unavailable',
          failureCause, effectAttempted: false };
      },
      executionRunStart: async () => {
        events.push('run');
        return { runId: 'unexpected-run', callId: 'call', sidechainId: 'call' };
      },
    } satisfies ActionExecutorDeps);
    expect(await executor.execute('review.start', { sessionId: 'source-session', cwd: '/repo',
      reviewers: [{ kind: 'engine', engineId: 'codex' }], instructions: 'Review uncommitted changes.',
    }, { surface: 'ui', defaultSessionId: 'source-session', defaultSessionMachineId: 'source-machine' }))
      .toMatchObject({ ok: false, errorCode: 'DIFF_UNAVAILABLE', failureCause, effectAttempted: false });
    expect(events).toEqual(['capture']);
    expect(persisted.read()).toBeNull();
  });

  it('starts repeated engine selections with independent runners and models in the already admitted round', async () => {
    const requests: ReturnType<typeof ExecutionRunStartRequestSchema.parse>[] = [];
    const records = createInMemoryReviewRecordPortV1();
    const deps = {
      reviewRecords: () => records,
      reviewEnginesList: async () => ({ items: [{ value: 'codex', label: 'Codex' }] }),
      executionRunStart: async (_sessionId, request) => {
        requests.push(ExecutionRunStartRequestSchema.parse(request));
        return { runId: `run-${requests.length}`, callId: 'call', sidechainId: 'call' };
      },
    } satisfies ActionExecutorDeps;
    const executor = createActionExecutor(deps);
    const reviewRound = await records.start({ reviewId: 'existing-review', title: 'Independent models',
      subjectKind: 'repository', sourceKind: 'workflow', reviewerIds: ['reviewer-1', 'reviewer-2'], startedAt: 1 });
    const runnerAgentTargets = [
      { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } },
      { kind: 'agent', identity: { pluginId: 'happier.agent.claude', localId: 'claude' } },
    ];
    const connectedServices = { v: 2, bindingsByServiceId: {
      'happier.agent.codex/openai-codex': { source: 'connected', selection: 'profile', profileId: 'selected-account' },
    } };
    for (const [index, modelId] of ['first-model', 'second-model'].entries()) {
      const data = ReviewStartInputSchema.parse({
        sessionId: 'source-session', reviewers: [{ kind: 'engine', engineId: 'codex', modelId,
          runnerAgentTarget: runnerAgentTargets[index], connectedServices, options: { focus: modelId } }], instructions: 'Review independently.',
        reviewRound, reviewReviewerId: `reviewer-${index + 1}`, reviewRoundSettlement: 'workflow',
      });
      expect(await dispatchReviewDispatch2({ actionId: 'review.start', data, parsed: { data }, deps,
        ctx: { surface: 'ui' }, workflowSessionScope: null,
        executeHostChild: (actionId, input, context) => executor.execute(actionId, input, context),
        startExecutionRunWithSelection: (...args) => startExecutionRunWithSelectionV1(deps, ...args),
      })).toMatchObject({ ok: true, result: { reviewRound } });
    }
    expect(requests.map(request => request.runnerAgentTarget)).toEqual(runnerAgentTargets);
    expect(requests.map(request => request.connectedServices)).toEqual([connectedServices, connectedServices]);
    expect(requests.map(request => request.modelId)).toEqual(['first-model', 'second-model']);
    expect(requests.map(request => ReviewStartInputSchema.parse(request.intentInput).reviewers)).toEqual(
      runnerAgentTargets.map((runnerAgentTarget, index) => [{ kind: 'engine', engineId: 'codex',
        runnerAgentTarget, connectedServices, modelId: index === 0 ? 'first-model' : 'second-model',
        options: { focus: index === 0 ? 'first-model' : 'second-model' } }]),
    );
    expect(requests.map(request => request.intentInput)).toMatchObject([
      { reviewRound, reviewReviewerId: 'reviewer-1', reviewRoundSettlement: 'workflow', engines: { codex: { focus: 'first-model' } } },
      { reviewRound, reviewReviewerId: 'reviewer-2', reviewRoundSettlement: 'workflow', engines: { codex: { focus: 'second-model' } } },
    ]);
  });
});
