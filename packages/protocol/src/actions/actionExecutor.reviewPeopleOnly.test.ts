import { describe, expect, it } from 'vitest';
import { REVIEW_HUMAN_ACTION_IDS_V1 } from './actionIdsReviewHumanV1.js';
import { dispatchReviewDispatch2 } from './executor/review/dispatch.js';
import { createInMemoryReviewRecordPortV1 } from '../reviews/reviewArtifactV1.testkit.js';
import { ReviewStartInputSchema } from '../reviews/reviewStart.js';
import { ReviewHumanActionStateV1Schema, ReviewReviewersSetInputV1Schema } from '../reviews/reviewHumanV1.js';
import { readReviewStartActionResultV1 } from './specs/executionRunCompletion.js';
import { createActionExecutor } from './actionExecutor.js';
import { ReviewNewRoundResultV1Schema } from '../reviews/reviewRoundActionsV1.js';
import { getActionSpec } from './actionSpecs.js';
import { prepareActionCompletionV1 } from './actionCompletion.js';

describe('person-only Review admission', () => {
  it.each([{ comparison: false, unfinished: false }, { comparison: true, unfinished: false },
    { comparison: false, unfinished: true }])('repeats the same person-only Review without a synthetic Run (comparison: $comparison, unfinished: $unfinished)', async ({ comparison, unfinished }) => {
    const records = createInMemoryReviewRecordPortV1();
    const oldComparison = 'a'.repeat(64);
    const newComparison = 'b'.repeat(64);
    const source = { kind: 'workingTree' as const, area: 'pending' as const };
    const first = await records.start({ reviewId: 'people-review', title: 'Review', subjectKind: comparison ? 'comparison' : 'repository',
      sourceKind: 'direct', reviewerIds: [], startedAt: 1,
      ...(comparison ? { comparisonId: oldComparison, comparisonCapture: { target: { kind: 'machine' as const, machineId: 'source-machine' },
        input: { cwd: '/source/repo', source, comparisonId: oldComparison } } } : {}) });
    if (!unfinished) await records.settle({ ...first, outcome: 'completed', finishedAt: 2, runs: [] });
    let captureUnavailable = false;
    const executor = createActionExecutor({ reviewRecords: () => records,
      scmActionExecute: async request => {
        expect(request.context.externalActionTarget).toEqual({ kind: 'machine', machineId: 'source-machine' });
        expect(request.input).toMatchObject({ cwd: '/source/repo', source });
        expect(request.input).not.toHaveProperty('comparisonId');
        if (captureUnavailable) return { success: false, errorCode: 'DIFF_UNAVAILABLE', error: 'Source unavailable' };
        return { success: true, comparison: { id: newComparison, source, repository: { rootPath: '/source/repo' },
          endpoints: {}, inventory: { state: 'complete', files: [], reasons: [] } }, metadata: { source, sourceKey: newComparison } };
      },
      workflowAction: async () => { throw new Error('People-only rounds have no Workflow'); },
      executionRunStart: async () => { throw new Error('People-only rounds have no native Run'); },
    });
    const input = { reviewId: first.reviewId };
    const spec = getActionSpec('review.new_round');
    expect(spec.executionPlacementForInput?.(input)).toBe('account');
    const result = await executor.execute('review.new_round', input, { surface: 'ui' });
    expect(result).toMatchObject({ ok: true, result: { reviewRound: { reviewId: first.reviewId, roundOrdinal: 2 } } });
    if (!result.ok) throw new Error(result.error);
    expect(ReviewNewRoundResultV1Schema.parse(result.result)).toMatchObject({ reviewRound: { reviewId: first.reviewId, roundOrdinal: 2 } });
    expect((await records.read(first.reviewId))?.rounds).toEqual([
      expect.objectContaining({ ordinal: 1, state: unfinished ? 'running' : 'completed', runs: [], ...(comparison ? { comparisonId: oldComparison } : {}) }),
      expect.objectContaining({ ordinal: 2, state: 'completed', runs: [], reviewerIds: [], ...(comparison ? { comparisonId: newComparison } : {}) }),
    ]);
    if (comparison) {
      captureUnavailable = true;
      expect(await executor.execute('review.new_round', input, { surface: 'ui' })).toMatchObject({ ok: false });
      expect((await records.read(first.reviewId))?.rounds).toHaveLength(2);
    }
  });
  it.each([{ staged: false, detached: false }, { staged: true, detached: false }, { staged: false, detached: true }])(
    'completes requested people without creating executable work (stages: $staged, detached: $detached)', async ({ staged, detached }) => {
    const records = createInMemoryReviewRecordPortV1();
    const person = { kind: 'person' as const, principal: { kind: 'account' as const, accountId: 'reviewer' }, required: true };
    const data = ReviewStartInputSchema.parse({ ...(detached ? { target: { kind: 'detached' }, cwd: '/qa/repository' } : { sessionId: 'origin' }), scope: 'repository',
      reviewers: [person], instructions: 'Please review this repository.',
      ...(staged ? { steps: [{ kind: 'review', reviewers: [person], instructions: 'Please review.' }] } : {}),
    });
    let request: ReturnType<typeof ReviewReviewersSetInputV1Schema.parse> | undefined;
    const result = await dispatchReviewDispatch2({ actionId: 'review.start', data, parsed: { data },
      ctx: { surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' },
        runtimeAccountId: 'd71dfd69-e2d9-4f92-8453-d4fd74f8f2b1' },
      deps: { reviewRecords: () => records }, workflowSessionScope: null,
      // The authenticated requested-reviewer transport is the external boundary;
      // Review creation and settlement retain their real domain implementation.
      executeHostChild: async (actionId, input) => {
        if (actionId !== REVIEW_HUMAN_ACTION_IDS_V1.setReviewers) {
          return { ok: false, errorCode: 'unsupported_action', error: 'Unexpected executable work' };
        }
        request = ReviewReviewersSetInputV1Schema.parse(input);
        return { ok: true, result: ReviewHumanActionStateV1Schema.parse({ reviewId: request.reviewId,
          roundOrdinal: request.roundOrdinal, requests: [{ id: 'request', roundOrdinal: request.roundOrdinal,
            principal: person.principal, required: true, needsAccess: false }], verdicts: [], needsYou: {
          reviewId: request.reviewId, roundOrdinal: request.roundOrdinal, reason: 'review_needs_you',
          needsYou: true, requestedVerdict: true, pendingDecisions: false, canSubmitVerdict: true,
        } }) };
      },
      startExecutionRunWithSelection: async () => { throw new Error('Person requests do not launch an Agent'); },
    });
    if (!result) throw new Error('Expected Review dispatch result');
    expect(request?.reviewers).toEqual([{ principal: person.principal, required: true }]);
    expect(result).toMatchObject({ ok: true, result: { intent: 'review', sessionId: detached ? null : 'origin',
      reviewRound: { reviewId: request?.reviewId, roundOrdinal: 1 }, results: [] } });
    expect(readReviewStartActionResultV1(result, data)).toMatchObject({ kind: 'native', runs: [], failed: [],
      reviewRound: { reviewId: request?.reviewId, roundOrdinal: 1 } });
    const completion = getActionSpec('review.start').completion;
    expect(prepareActionCompletionV1(completion, result, { input: data }))
      .toEqual({ kind: 'completed', value: result.ok ? result.result : undefined });
    expect((await records.read(request!.reviewId))?.rounds).toEqual([
      expect.objectContaining({ state: 'completed', runs: [], reviewerIds: [], finishedAt: expect.any(Number) }),
    ]);
    // A68 live Team13 -> QA A Machine: execution placement is not the requester.
    expect(await records.read(request!.reviewId)).toMatchObject({ requestedBy: {
      actorKind: 'person', accountId: 'd71dfd69-e2d9-4f92-8453-d4fd74f8f2b1',
    } });
  });
});
