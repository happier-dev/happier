import { expect, it } from 'vitest';
import { ExecutionRunPublicStateSchema } from '@happier-dev/protocol/execution/runs/responseSchemas';
import { ReviewArtifactBodyV1Schema } from '@happier-dev/protocol/reviews/reviewArtifactV1';
import settledRound from '@/dev/testkit/fixtures/settledReviewRound.json';
import historicalRound from '@/dev/testkit/fixtures/historicalReviewRound.json';
import { projectReviewRoundReviewers } from './reviewRoundReviewers';

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
    { reviewerId: 'step-1-reviewer-1', name: 'Claude', outcome: null, findingsCount: null, run: null },
  ]);
  // The older completed neighbor also has no individual facts, even if its execution has since succeeded.
  expect(projectReviewRoundReviewers({ ...round, state: 'completed' }, new Map([[runId, {
    run: { ...run, status: 'succeeded', finishedAtMs: round.finishedAt! }, findingsCount: 99,
  }]]))).toEqual([
    { reviewerId: 'step-1-reviewer-1', name: 'Claude', outcome: null, findingsCount: null, run: null },
  ]);
  // A producer explicitly recording no outcomes is authoritative; only an absent field preserves the older roster.
  expect(projectReviewRoundReviewers({ ...round, reviewerOutcomes: [] }, undefined)).toEqual([]);
});
