import { expect, it } from 'vitest';
import { buildReviewCommentFixture } from '@/dev/testkit/fixtures/reviewComments';

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
        transitionedAt: 30,
        transitionedBy: { kind: 'user' as const, userId: 'alice' },
      },
      {
        transitionId: 't2',
        fromState: 'open' as const,
        toState: 'resolved' as const,
        transitionedAt: 50,
        transitionedBy: { kind: 'user' as const, userId: 'bob' },
      },
    ],
  };
  const events = projectReviewActivity({
    rounds: [{ ordinal: 1, state: 'partial', startedAt: 1, finishedAt: 20 }],
    comments: [withHistory],
    verdicts: [
      {
        accountId: 'bob',
        roundOrdinal: 1,
        verdict: 'approve',
        submittedAt: 60,
      },
    ],
    runs: [
      {
        runId: 'run-1',
        status: 'succeeded',
        finishedAtMs: 15,
        findingsCount: 4,
        backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      },
      {
        runId: 'run-2',
        status: 'failed',
        finishedAtMs: 16,
        findingsCount: null,
        backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
      },
    ],
  });
  // The workflow proposing a finding is the run's own event, not a second line per finding.
  expect(
    events.map((event) => [event.at, event.actor?.kind ?? null, event.kind]),
  ).toEqual([
    [60, 'account', 'verdict'],
    [50, 'account', 'fixed'],
    [30, 'account', 'decided'],
    [20, null, 'roundFinished'],
    [16, 'run', 'runDidntFinish'],
    [15, 'run', 'runFinished'],
    [1, null, 'roundStarted'],
  ]);
  expect(events.find((event) => event.kind === 'decided')).toMatchObject({
    actor: { accountId: 'alice' },
    title: 'Totals subtract',
    decision: 'accept',
  });
  expect(events.find((event) => event.kind === 'runFinished')).toMatchObject({
    findingsCount: 4,
  });
});
