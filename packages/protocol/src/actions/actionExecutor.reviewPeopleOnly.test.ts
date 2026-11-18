import { describe, expect, it } from 'vitest';
import { REVIEW_HUMAN_ACTION_IDS_V1 } from './actionIdsReviewHumanV1.js';
import { dispatchReviewDispatch2 } from './executor/review/dispatch.js';
import { createInMemoryReviewRecordPortV1 } from '../reviews/reviewArtifactV1.testkit.js';
import { ReviewStartInputSchema } from '../reviews/reviewStart.js';
import { ReviewHumanActionStateV1Schema, ReviewReviewersSetInputV1Schema } from '../reviews/reviewHumanV1.js';
import { readReviewStartActionResultV1 } from './specs/executionRunCompletion.js';

describe('person-only Review admission', () => {
  it.each([false, true])('requests people without creating executable work (stages: %s)', async staged => {
    const records = createInMemoryReviewRecordPortV1();
    const person = { kind: 'person' as const, principal: { kind: 'account' as const, accountId: 'reviewer' }, required: true };
    const data = ReviewStartInputSchema.parse({ sessionId: 'origin', scope: 'repository',
      reviewers: [person], instructions: 'Please review this repository.',
      ...(staged ? { steps: [{ kind: 'review', reviewers: [person], instructions: 'Please review.' }] } : {}),
    });
    let request: ReturnType<typeof ReviewReviewersSetInputV1Schema.parse> | undefined;
    const result = await dispatchReviewDispatch2({ actionId: 'review.start', data, parsed: { data },
      ctx: { surface: 'ui' }, deps: { reviewRecords: () => records }, workflowSessionScope: null,
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
    expect(request?.reviewers).toEqual([{ principal: person.principal, required: true }]);
    expect(result).toMatchObject({ ok: true, result: { intent: 'review', sessionId: 'origin',
      reviewRound: { reviewId: request?.reviewId, roundOrdinal: 1 }, results: [] } });
    expect(readReviewStartActionResultV1(result, data)).toMatchObject({ kind: 'native', runs: [], failed: [],
      reviewRound: { reviewId: request?.reviewId, roundOrdinal: 1 } });
    expect((await records.read(request!.reviewId))?.rounds).toEqual([
      expect.objectContaining({ state: 'completed', runs: [], reviewerIds: [], finishedAt: expect.any(Number) }),
    ]);
  });
});
