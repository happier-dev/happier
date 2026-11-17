import { describe, expect, it } from 'vitest';

import { createActionExecutor } from './actionExecutor.js';
import { createReviewRecordPortV1, type ReviewArtifactTransportV1 } from '../reviews/reviewArtifactV1.js';
import { prepareReviewRoundV1 } from '../reviews/prepareReviewRoundV1.js';
import { ReviewPrepareRoundInputV1Schema } from '../reviews/reviewRoundActionsV1.js';

describe('Review round preparation', () => {
  it('routes an explicit native New round through its retained Session action owner', async () => {
    const receipt = { runId: 'next-native-run', callId: 'next-call', sidechainId: 'next-sidechain',
      reviewRound: { reviewId: 'same-review', roundOrdinal: 2 }, comparisonId: 'new-comparison' };
    const executor = createActionExecutor({
      resolveSessionReference: async ({ sessionId }) => ({ kind: 'unique', address: { serverId: 'home', sessionId: sessionId! } }),
      executionRunAction: async (sessionId, request) => {
        expect(sessionId).toBe('actual-session');
        expect(request).toEqual({ runId: 'previous-native-run', actionId: 'review.new_round', input: { fresh: true } });
        return { ok: true, result: receipt };
      },
    });
    await expect(executor.execute('review.new_round', { runId: 'previous-native-run', sessionId: 'actual-session', fresh: true },
      { surface: 'ui', serverId: 'home' })).resolves.toEqual({ ok: true, result: receipt });
  });

  it('consumes initial admission and captures current evidence for later rounds of the same Review', async () => {
    let row: Awaited<ReturnType<ReviewArtifactTransportV1['read']>> = null;
    let writes = 0;
    const records = createReviewRecordPortV1({
      read: async () => row,
      create: async input => {
        writes++;
        row = { ...input, revision: { headerVersion: writes, bodyVersion: writes } };
        return row;
      },
      update: async input => {
        writes++;
        row = { ...input, revision: { headerVersion: writes, bodyVersion: writes } };
        return { ok: true, revision: row.revision };
      },
    });
    const reviewRound = await records.start({ reviewId: 'one-review', title: 'Review', subjectKind: 'repository',
      sourceKind: 'workflow', reviewerIds: ['step-1-reviewer-1'], startedAt: 1 });
    const reviewInput = { reviewers: [{ kind: 'engine', engineId: 'codex' }], instructions: 'Find bugs.', scope: 'repository' };
    const executor = createActionExecutor({ reviewRecords: () => records });
    const initial = await executor.execute('review.prepare_round', { reviewRound, reviewInput, previousRoundContext: null }, { surface: 'ui' });
    expect(initial).toMatchObject({ ok: true, result: { reviewRound } });
    expect(writes).toBe(1);
    await records.settle({ ...reviewRound, outcome: 'completed', finishedAt: 2, runs: [],
      reviewerOutcomes: [{ key: 'step-1-reviewer-1', outcome: 'completed', reviewOutcome: 'complete', materialization: { kind: 'complete' } }] });
    const replay = await executor.execute('review.prepare_round', { reviewRound, reviewInput,
      previousRoundContext: { runId: 'previous-workflow', state: 'succeeded', outcomes: [] } }, { surface: 'ui' });
    expect(replay).toMatchObject({ ok: true, result: { reviewRound: { reviewId: reviewRound.reviewId, roundOrdinal: 2 } } });
    expect((await records.read(reviewRound.reviewId))?.rounds).toMatchObject([
      { ordinal: 1, state: 'completed' }, { ordinal: 2, state: 'running', reviewerIds: ['step-1-reviewer-1'] },
    ]);
    expect(writes).toBe(3);
    const pinnedComparisonId = 'a'.repeat(64);
    const currentComparisonId = 'b'.repeat(64);
    const current = await prepareReviewRoundV1(ReviewPrepareRoundInputV1Schema.parse({ reviewRound,
      reviewInput: { ...reviewInput, scope: 'changes', comparisonId: pinnedComparisonId },
      comparisonCapture: { cwd: '/workspace', source: { kind: 'workingTree' }, comparisonId: pinnedComparisonId },
      previousRoundContext: { runId: 'second-workflow' },
    }), { reviewRecords: records, startedAt: 3,
      // The host SCM boundary reads a pinned capture, or captures the current tree without a pin.
      captureComparison: async capture => ({ id: capture.comparisonId ?? currentComparisonId, source: capture.source,
        repository: { rootPath: '/workspace' }, endpoints: {}, inventory: { state: 'complete', files: [], reasons: [] } }),
    });
    expect(current).toMatchObject({ reviewRound: { reviewId: reviewRound.reviewId, roundOrdinal: 3 }, comparisonId: currentComparisonId });
  });
});
