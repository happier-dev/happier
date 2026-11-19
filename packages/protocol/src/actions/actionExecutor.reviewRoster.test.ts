import { describe, expect, it } from 'vitest';

import { createActionExecutor, type ActionExecutorDeps } from './actionExecutor.js';
import { ExecutionRunStartRequestSchema } from '../execution/runs/startRequest.js';
import { createReviewRecordPortV1, ReviewRoundBindingV1Schema, type ReviewArtifactTransportV1 } from '../reviews/reviewArtifactV1.js';
import { ScmComparisonCaptureInputSchema, ScmComparisonCaptureOutputSchema } from '../scm/diffSummary.js';
import { ReviewStartInputSchema } from '../reviews/reviewStart.js';
import { createInMemoryReviewRecordPortV1 } from '../reviews/reviewArtifactV1.testkit.js';
import { dispatchReviewDispatch2 } from './executor/review/dispatch.js';
import { startExecutionRunWithSelectionV1 } from './executor/executionRuns.js';

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
      reviewers: [{ kind: 'engine', engineId: 'codex' }], instructions: 'Review uncommitted changes.',
    }, { surface: 'ui', defaultSessionId: 'source-session', defaultSessionMachineId: 'source-machine' })).toMatchObject({ ok: true });
    expect(captures).toHaveLength(1);
    expect(captures[0]).toMatchObject({ cwd: '/repo', source: { kind: 'workingTree', area: 'pending' } });
    expect(events).toEqual(['capture', 'record', 'run']);
    expect(requests[0]?.intentInput).toMatchObject({ comparisonId });
    const binding = ReviewRoundBindingV1Schema.parse(requests[0]?.intentInput?.reviewRound);
    expect((await persisted.records.read(binding.reviewId))?.rounds[0]).toMatchObject({ comparisonId });
  });

  it('leaves no admitted Review or reviewer when initial comparison capture is refused', async () => {
    const events: string[] = [];
    const persisted = observeReviewPersistence(events);
    const executor = createActionExecutor({
      reviewRecords: () => persisted.records,
      reviewEnginesList: async () => ({ items: [{ value: 'codex', label: 'Codex' }] }),
      scmActionExecute: async ({ actionId, input }) => {
        expect(actionId).toBe('scm.diffSummary.capture');
        expect(ScmComparisonCaptureInputSchema.parse(input)).toMatchObject({ cwd: '/repo', source: { kind: 'workingTree' } });
        events.push('capture');
        return ScmComparisonCaptureOutputSchema.parse({ success: false, errorCode: 'DIFF_UNAVAILABLE', error: 'Worktree capture unavailable' });
      },
      executionRunStart: async () => {
        events.push('run');
        return { runId: 'unexpected-run', callId: 'call', sidechainId: 'call' };
      },
    } satisfies ActionExecutorDeps);
    expect(await executor.execute('review.start', { sessionId: 'source-session', cwd: '/repo',
      reviewers: [{ kind: 'engine', engineId: 'codex' }], instructions: 'Review uncommitted changes.',
    }, { surface: 'ui', defaultSessionId: 'source-session', defaultSessionMachineId: 'source-machine' }))
      .toMatchObject({ ok: false, errorCode: 'DIFF_UNAVAILABLE' });
    expect(events).toEqual(['capture']);
    expect(persisted.read()).toBeNull();
  });

  it('starts repeated engine selections with independent models in the already admitted round', async () => {
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
    for (const [index, modelId] of ['first-model', 'second-model'].entries()) {
      const data = ReviewStartInputSchema.parse({
        sessionId: 'source-session', reviewers: [{ kind: 'engine', engineId: 'codex', modelId,
          options: { focus: modelId } }], instructions: 'Review independently.',
        reviewRound, reviewReviewerId: `reviewer-${index + 1}`, reviewRoundSettlement: 'workflow',
      });
      expect(await dispatchReviewDispatch2({ actionId: 'review.start', data, parsed: { data }, deps,
        ctx: { surface: 'ui' }, workflowSessionScope: null,
        executeHostChild: (actionId, input, context) => executor.execute(actionId, input, context),
        startExecutionRunWithSelection: (...args) => startExecutionRunWithSelectionV1(deps, ...args),
      })).toMatchObject({ ok: true, result: { reviewRound } });
    }
    expect(requests.map(request => request.modelId)).toEqual(['first-model', 'second-model']);
    expect(requests.map(request => request.intentInput)).toMatchObject([
      { reviewRound, reviewReviewerId: 'reviewer-1', reviewRoundSettlement: 'workflow', engines: { codex: { focus: 'first-model' } } },
      { reviewRound, reviewReviewerId: 'reviewer-2', reviewRoundSettlement: 'workflow', engines: { codex: { focus: 'second-model' } } },
    ]);
  });
});
