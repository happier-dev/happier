import { expect, it } from 'vitest';
import { buildReviewCommentFixture } from '@/dev/testkit/fixtures/reviewComments';
import settledRound from '@/dev/testkit/fixtures/settledReviewRound.json';
import { ReviewArtifactBodyV1Schema } from '@happier-dev/protocol/reviews/reviewArtifactV1';

const { projectReviewActivity } = await import('./reviewActivity');

it('lists who did what to the Review, newest first: decisions, fixes, verdicts, reviewer runs and rounds', () => {
  const comment = buildReviewCommentFixture({
    id: 'c1',
    threadId: 'c1',
    reviewId: 'r',
    accountId: 'alice',
    state: 'resolved',
    reviewTriageStatus: 'accept',
    roundOrdinal: 1,
    findingIdentity: '1'.repeat(64),
    finding: {
      id: 'f1',
      title: 'Totals subtract',
      summary: 's',
      severity: 'high',
      category: 'correctness',
    },
  });
  const withHistory = {
    ...comment,
    transitions: [
      {
        transitionId: 't0',
        toState: 'proposed' as const,
        transitionedAt: 10,
        transitionedBy: { kind: 'workflow' as const, runId: 'w' },
      },
      {
        transitionId: 't1',
        fromState: 'proposed' as const,
        toState: 'open' as const,
        reviewTriageStatus: 'accept' as const,
        transitionedAt: 30000,
        transitionedBy: { kind: 'user' as const, userId: 'alice' },
      },
      {
        transitionId: 't2',
        fromState: 'open' as const,
        toState: 'resolved' as const,
        transitionedAt: 50000,
        transitionedBy: { kind: 'user' as const, userId: 'bob' },
      },
    ],
  };
  const events = projectReviewActivity({
    rounds: ReviewArtifactBodyV1Schema.parse(settledRound).rounds,
    comments: [withHistory],
    verdicts: [
      {
        accountId: 'bob',
        roundOrdinal: 1,
        verdict: 'approve',
        submittedAt: 60000,
      },
    ],
  });
  // The workflow proposing a finding is the run's own event, not a second line per finding.
  expect(
    events.map((event) => [event.at, event.actor?.kind ?? null, event.kind]),
  ).toEqual([
    [60000, 'account', 'verdict'],
    [50000, 'account', 'fixed'],
    [30000, 'account', 'decided'],
    [10000, null, 'roundFinished'],
    [9000, 'reviewer', 'reviewerFinished'],
    [6000, 'reviewer', 'reviewerFinished'],
    [1000, null, 'roundStarted'],
  ]);
  expect(events.find((event) => event.kind === 'decided')).toMatchObject({
    actor: { accountId: 'alice' },
    title: 'Totals subtract',
    decision: 'accept',
  });
  expect(events.find((event) => event.id === 'reviewer:1:first')).toMatchObject({
    actor: { name: 'Claude reviewer' }, outcome: 'partial',
  });
});
