import { describe, expect, it } from 'vitest';
import { createActionExecutor } from './actionExecutor.js';
import { createReviewRecordPortV1, type ReviewArtifactTransportV1 } from '../reviews/reviewArtifactV1.js';

describe('Review workflow settlement', () => {
  it.each(['complete', 'missing', 'other-round', 'denied', 'denied-and-missing'] as const)('folds %s collected results without treating a workflow handle as review coverage', async mode => {
    let row: Awaited<ReturnType<ReviewArtifactTransportV1['read']>> = null;
    let writes = 0;
    const records = createReviewRecordPortV1({
      read: async () => row,
      create: async input => { writes++; row = { ...input, revision: { headerVersion: writes, bodyVersion: writes } }; return row; },
      update: async input => { writes++; row = { ...input, revision: { headerVersion: writes, bodyVersion: writes } }; return { ok: true, revision: row.revision }; },
    });
    const reviewRound = await records.start({ reviewId: 'review', title: 'Review', subjectKind: 'repository',
      sourceKind: 'workflow', reviewerIds: ['first', 'second'], startedAt: 1 });
    const receipt = (key: string) => ({ reviewRound: key === 'second' && mode === 'other-round'
      ? { ...reviewRound, roundOrdinal: 2 } : reviewRound, reviewedFingerprint: null, commentIds: [],
      perEngineOutcome: [mode === 'denied' || mode === 'denied-and-missing'
        ? { key, outcome: 'failed', errorCode: 'resource_forbidden' }
        : { key, outcome: 'completed', materialization: { kind: 'complete' } }] });
    const result = await createActionExecutor({ reviewRecords: () => records }).execute('review.settle_round', {
      reviewRound, reviewerResults: [[{ status: 'completed', results: { first: receipt('first') } },
        mode === 'missing' || mode === 'denied-and-missing' ? { status: 'failed', reason: 'review_unavailable' }
          : { status: 'completed', results: { second: receipt('second') } }]],
    }, { surface: 'ui', actionCaller: { kind: 'workflowRun', runId: 'workflow-run',
      authorization: { principal: { kind: 'host' }, admittedPermissionCeiling: 'read-only' } } });
    const expectedState = {
      complete: 'completed', missing: 'partial', 'other-round': 'partial', denied: 'failed', 'denied-and-missing': 'failed',
    }[mode];
    expect((await records.read(reviewRound.reviewId))?.rounds[0]).toMatchObject({
      state: expectedState, runs: [{ kind: 'workflow', runId: 'workflow-run' }],
    });
    expect(result).toMatchObject(mode === 'denied'
      ? { ok: false, errorCode: 'resource_forbidden' }
      : { ok: true, result: reviewRound });
    expect(writes).toBe(2);
  });
});
