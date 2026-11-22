import { expect, it } from 'vitest';
import { ExecutionRunPublicStateSchema } from '@happier-dev/protocol/execution/runs/responseSchemas';
import { ReviewArtifactBodyV1Schema } from '@happier-dev/protocol/reviews/reviewArtifactV1';
import settledRound from '@/dev/testkit/fixtures/settledReviewRound.json';
import historicalRound from '@/dev/testkit/fixtures/historicalReviewRound.json';
import twoStepRound from '@/dev/testkit/fixtures/twoStepPartialReviewRound.json';
import { projectReviewRoundReviewers, reviewRoundReviewerName, reviewRoundReviewerOutcomeLabel, reviewRoundReviewerRowCount } from './reviewRoundReviewers';

it('uses the sealed reviewer result and timing after settlement, even while its continued execution still runs', () => {
  // Captured real createReviewRecordPortV1.start/settle output (P02 producer e, 2026-11-22).
  const round = ReviewArtifactBodyV1Schema.parse(settledRound).rounds[0]!;
  const run = ExecutionRunPublicStateSchema.parse({ runId: 'claude', callId: 'call', sidechainId: 'side', intent: 'review',
    backendTarget: { kind: 'builtInAgent', agentId: 'claude' }, permissionMode: 'default', retentionPolicy: 'resumable',
    runClass: 'long_lived', ioMode: 'streaming', status: 'running', startedAtMs: 5000 });
  expect(projectReviewRoundReviewers(round, new Map([['claude', { run, findingsCount: 99 }]]))).toMatchObject([
    { reviewerId: 'first', name: 'Claude reviewer', outcome: 'partial', runId: 'claude', startedAt: 2000,
      finishedAt: 9000, findingsCount: null, run: null },
    { reviewerId: 'second', name: 'Codex reviewer', outcome: 'completed' },
  ]);
});

it('keeps captured historical Review A names without inventing individual results or timing from its running marker', () => {
  // Captured Review A, 2026-11-22T02:15:33Z: b1-refetched.json. Individual facts cannot be recovered from Partial.
  const round = ReviewArtifactBodyV1Schema.parse(historicalRound).rounds[0]!;
  const runId = round.runs[0]!.runId;
  const run = ExecutionRunPublicStateSchema.parse({ runId, callId: 'call', sidechainId: 'side', intent: 'review',
    backendTarget: { kind: 'builtInAgent', agentId: 'claude' }, permissionMode: 'default', retentionPolicy: 'resumable',
    runClass: 'long_lived', ioMode: 'streaming', status: 'running', startedAtMs: round.startedAt });
  expect(projectReviewRoundReviewers(round, new Map([[runId, { run, findingsCount: 99 }]]))).toEqual([
    { reviewerId: 'step-1-reviewer-1', name: 'Claude', agentId: 'claude', outcome: null, findingsCount: null, run: null },
  ]);
  // The older completed neighbor also has no individual facts, even if its execution has since succeeded.
  expect(projectReviewRoundReviewers({ ...round, state: 'completed' }, new Map([[runId, {
    run: { ...run, status: 'succeeded', finishedAtMs: round.finishedAt! }, findingsCount: 99,
  }]]))).toEqual([
    { reviewerId: 'step-1-reviewer-1', name: 'Claude', agentId: 'claude', outcome: null, findingsCount: null, run: null },
  ]);
  // A producer explicitly recording no outcomes is authoritative; only an absent field preserves the older roster.
  expect(projectReviewRoundReviewers({ ...round, reviewerOutcomes: [] }, undefined)).toEqual([]);
});

it('names same-Agent reviewers through the catalog with their mark and step, with one outcome word (captured Review 5bee0f3e)', async () => {
  // Captured public artifact body of the U8 R4 two-step Partial (two sequential Review steps, one Claude each).
  const round = ReviewArtifactBodyV1Schema.parse(twoStepRound).rounds[0]!;
  const { t } = await import('@/text');
  const reviewers = projectReviewRoundReviewers(round, undefined);
  expect(reviewers.map(reviewer => [reviewer.name, reviewer.agentId])).toEqual([
    [t('reviewWalkthrough.detail.reviewerInStep', { name: 'Claude', step: 1 }), 'claude'],
    [t('reviewWalkthrough.detail.reviewerInStep', { name: 'Claude', step: 2 }), 'claude'],
  ]);
  expect(reviewRoundReviewerOutcomeLabel('partial')).toBe(t('reviewWalkthrough.detail.reviewerDidntFinish'));
  // The Runs tab counts the rows it draws: one per reviewer, not the round's one Workflow run reference.
  expect(reviewRoundReviewerRowCount(round)).toBe(2);
  // Two reviewers of one step with the same Agent are told apart by their place, never by a raw id.
  const parallel = { ...round, reviewerIds: ['step-1-reviewer-1', 'step-1-reviewer-2'],
    reviewerDisplayNames: { 'step-1-reviewer-1': 'claude', 'step-1-reviewer-2': 'claude' }, reviewerOutcomes: undefined };
  expect(projectReviewRoundReviewers(parallel, undefined).map(reviewer => reviewer.name)).toEqual([
    t('reviewWalkthrough.detail.reviewerOrdinal', { name: 'Claude', count: 1 }),
    t('reviewWalkthrough.detail.reviewerOrdinal', { name: 'Claude', count: 2 }),
  ]);
  // A recorded name that is not an Agent (an engine label) stays as recorded, with no mark.
  expect(reviewRoundReviewerName({ reviewerIds: ['a'], reviewerDisplayNames: { a: 'CodeRabbit' } }, 'a')).toBe('CodeRabbit');
});
