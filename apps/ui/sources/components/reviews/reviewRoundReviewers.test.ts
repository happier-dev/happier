import { expect, it } from 'vitest';
import { ExecutionRunPublicStateSchema } from '@happier-dev/protocol/execution/runs/responseSchemas';
import { ReviewArtifactBodyV1Schema } from '@happier-dev/protocol/reviews/reviewArtifactV1';
import settledRound from '@/dev/testkit/fixtures/settledReviewRound.json';
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

it('keeps captured historical Review A aggregate-only when no individual result was persisted', () => {
  // Captured Review A, 2026-11-22T02:15:33Z: b1-refetched.json. Individual facts cannot be recovered from Partial.
  const round = ReviewArtifactBodyV1Schema.parse({ v: 1, rounds: [{ ordinal: 1, state: 'partial', startedAt: 1795245775139,
    finishedAt: 1795245783669, reviewerIds: ['step-1-reviewer-1'], reviewerDisplayNames: { 'step-1-reviewer-1': 'Claude' },
    runs: [{ kind: 'execution', runId: 'run_request_348f81b4586b3f9b946fce9383072762ee4522ef873352cb3d1e6cc4b383435f',
      machineId: '78107177-fb20-4ebc-bdcd-b1f162791537' }] }] }).rounds[0]!;
  expect(projectReviewRoundReviewers(round, undefined)).toEqual([]);
});
