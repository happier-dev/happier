import { describe, expect, it } from 'vitest';
import { createReviewRecordPortV1, projectReviewRoundQualityV1, ReviewArtifactBodyV1Schema, ReviewRoundComparisonCaptureV1Schema, type ReviewArtifactTransportV1 } from './reviewArtifactV1.js';
import { presentReviewRoundQualityV1 } from './reviewQualityPresentationV1.js';
import { ReviewReviewerOutcomeV1Schema } from './reviewPublicationEvidence.js';

function fixture() {
  let row: Awaited<ReturnType<ReviewArtifactTransportV1['read']>> = null;
  let writes = 0;
  const transport: ReviewArtifactTransportV1 = {
    read: async () => row,
    create: async input => {
      writes++;
      row = { ...input, revision: { headerVersion: 1, bodyVersion: 1 } };
      return row;
    },
    update: async input => {
      if (!row || input.expectedRevision.bodyVersion !== row.revision.bodyVersion) return { ok: false, errorCode: 'version_mismatch' };
      writes++;
      row = { ...row, header: input.header, body: input.body,
        revision: { headerVersion: row.revision.headerVersion + 1, bodyVersion: row.revision.bodyVersion + 1 } };
      return { ok: true, revision: row.revision };
    },
  };
  return { records: createReviewRecordPortV1(transport), transport, writes: () => writes };
}

describe('durable Review rounds', () => {
  it('keeps the original requester through settlement and a new round started by its custodian, while older records stay unknown', async () => {
    const f = fixture();
    const start = { reviewId: 'requester-review', title: 'Working tree changes', subjectKind: 'comparison' as const,
      sourceKind: 'direct' as const, reviewerIds: [], startedAt: 1 };
    const requestedBy = { actorKind: 'person' as const, accountId: 'd71dfd69-e2d9-4f92-8453-d4fd74f8f2b1' };
    const first = await f.records.start({ ...start, requestedBy });
    await f.records.settle({ ...first, outcome: 'completed', finishedAt: 2, runs: [] });
    await f.records.start({ ...start, startedAt: 3, newRound: true,
      requestedBy: { actorKind: 'person', accountId: '5e3a0581-6f3d-4e73-bf40-383db0be6c3e' } });
    expect(await f.records.read(start.reviewId)).toMatchObject({ requestedBy, rounds: [
      { ordinal: 1, state: 'completed' }, { ordinal: 2, state: 'running' },
    ] });
    const historical = fixture();
    await historical.records.start(start);
    await historical.records.start({ ...start, startedAt: 3, newRound: true, requestedBy });
    expect(await historical.records.read(start.reviewId)).not.toHaveProperty('requestedBy');
  });
  it('retains admitted reviewer identities across a selected retry without copying omitted reviewers', async () => {
    const f = fixture();
    const start = { reviewId: 'named-session-review', title: 'Review', subjectKind: 'repository' as const,
      sourceKind: 'workflow' as const, reviewerIds: ['reviewer-1', 'reviewer-2'], startedAt: 1 };
    await f.records.start({ ...start, reviewerDisplayNames: { 'reviewer-1': 'Security double-check', 'reviewer-2': 'Claude' },
      reviewerAgentIds: { 'reviewer-1': 'review.plugin/reviewer', 'reviewer-2': 'happier.agent.claude/claude' } });
    const retry = await f.records.start({ ...start, reviewerIds: ['reviewer-1'], startedAt: 2, newRound: true });
    await f.records.settle({ ...retry, outcome: 'cancelled', finishedAt: 3, runs: [] });
    const round = (await f.records.read(start.reviewId))?.rounds[1];
    expect(round?.reviewerDisplayNames).toEqual({ 'reviewer-1': 'Security double-check' });
    expect(round?.reviewerAgentIds).toEqual({ 'reviewer-1': 'review.plugin/reviewer' });
    expect(round?.reviewerOutcomes).toEqual([{ reviewerId: 'reviewer-1', displayName: 'Security double-check', agentId: 'review.plugin/reviewer', outcome: 'cancelled' }]);
    await f.records.start({ ...start, startedAt: 4, newRound: true, reviewerDisplayNames: { 'reviewer-1': 'Renamed reviewer' },
      reviewerAgentIds: { 'reviewer-1': 'other.plugin/reviewer' } });
    expect((await f.records.read(start.reviewId))?.rounds[2]?.reviewerDisplayNames)
      .toEqual({ 'reviewer-1': 'Renamed reviewer', 'reviewer-2': 'Claude' });
    expect((await f.records.read(start.reviewId))?.rounds[2]?.reviewerAgentIds)
      .toEqual({ 'reviewer-1': 'other.plugin/reviewer', 'reviewer-2': 'happier.agent.claude/claude' });
  });
  it('retains the pinned capture address for each round independently of execution history', async () => {
    const f = fixture();
    const comparisonCapture = { target: { kind: 'machine' as const, machineId: 'source-machine' }, input: {
      cwd: '/original/worktree', sessionId: 'capture-namespace', source: { kind: 'workingTree' as const }, comparisonId: 'a'.repeat(64),
    } };
    const { comparisonId: _pin, ...unboundCapture } = comparisonCapture.input;
    expect(ReviewRoundComparisonCaptureV1Schema.safeParse({ ...comparisonCapture, input: unboundCapture }).success).toBe(false);
    expect(ReviewRoundComparisonCaptureV1Schema.safeParse({ ...comparisonCapture,
      input: { ...comparisonCapture.input, projection: { kind: 'index' } } }).success).toBe(false);
    const start = { reviewId: 'captured-review', title: 'Review', subjectKind: 'comparison' as const,
      sourceKind: 'workflow' as const, reviewerIds: [], startedAt: 1,
      comparisonId: comparisonCapture.input.comparisonId, comparisonCapture };
    const binding = await f.records.start(start);
    await f.records.settle({ ...binding, outcome: 'completed', finishedAt: 2, runs: [] });
    const nextCapture = { ...comparisonCapture, input: { ...comparisonCapture.input, comparisonId: 'b'.repeat(64) } };
    await f.records.start({ ...start, startedAt: 3, newRound: true, comparisonId: nextCapture.input.comparisonId,
      comparisonCapture: nextCapture });
    expect((await f.records.read(start.reviewId))?.rounds).toMatchObject([
      { ordinal: 1, comparisonId: comparisonCapture.input.comparisonId, comparisonCapture },
      { ordinal: 2, comparisonId: nextCapture.input.comparisonId, comparisonCapture: nextCapture },
    ]);
  });
  it.each(['start', 'settle'] as const)('surfaces the Artifact CAS conflict during %s without silently retrying', async operation => {
    const f = fixture();
    const input = { reviewId: 'review-cas', title: 'Review', subjectKind: 'comparison' as const,
      sourceKind: 'direct' as const, reviewerIds: ['one'], startedAt: 1 };
    const binding = await f.records.start(input);
    const update = f.transport.update;
    let attempts = 0;
    // The Artifact transport is the persistence boundary. A second attempt could succeed,
    // but a new round must remain a visible conflict rather than choosing another ordinal.
    f.transport.update = async request => ++attempts === 1 ? { ok: false, errorCode: 'version_mismatch' } : update(request);
    await expect(operation === 'start' ? f.records.start({ ...input, newRound: true })
      : f.records.settle({ ...binding, outcome: 'completed', finishedAt: 2, runs: [] }))
      .rejects.toMatchObject({ code: 'version_mismatch' });
    expect(attempts).toBe(1);
    expect((await f.records.read(binding.reviewId))?.rounds).toHaveLength(1);
    expect((await f.records.read(binding.reviewId))?.rounds[0]?.state).toBe('running');
  });

  it('uses Artifact failures for an absent resource or an invalid round', async () => {
    const f = fixture();
    const settlement = { reviewId: 'missing', roundOrdinal: 1, outcome: 'completed' as const, finishedAt: 2, runs: [] };
    await expect(f.records.settle(settlement)).rejects.toMatchObject({ code: 'artifact_not_found' });
    await f.records.start({ reviewId: 'present', title: 'Review', subjectKind: 'comparison', sourceKind: 'direct',
      reviewerIds: [], startedAt: 1 });
    await expect(f.records.settle({ ...settlement, reviewId: 'present', roundOrdinal: 2 }))
      .rejects.toMatchObject({ code: 'invalid-params' });
  });

  it.each([
    { name: 'complete empty output', expected: ['one'], outcomes: [{ key: 'one', outcome: 'completed', materialization: { kind: 'complete' } }], state: 'completed' },
    { name: 'failed empty output', expected: ['one'], outcomes: [{ key: 'one', outcome: 'failed' }], state: 'failed' },
    { name: 'missing reviewer', expected: ['one', 'two'], outcomes: [{ key: 'one', outcome: 'completed', materialization: { kind: 'complete' } }], state: 'partial' },
    { name: 'missing all results', expected: ['one'], outcomes: [], state: 'failed' },
    { name: 'partial publication', expected: ['one'], outcomes: [{ key: 'one', outcome: 'completed', materialization: { kind: 'partial', errorCode: 'write_failed' } }], state: 'partial' },
    { name: 'missing publication', expected: ['one'], outcomes: [{ key: 'one', outcome: 'completed' }], state: 'failed' },
    { name: 'partial reviewer output', expected: ['one'], outcomes: [{ key: 'one', outcome: 'completed', reviewOutcome: 'partial', materialization: { kind: 'complete' } }], state: 'partial' },
    { name: 'human-only round', expected: [], outcomes: [], state: 'completed' },
  ])('settles $name from the admitted roster and host evidence', async ({ expected, outcomes, state }) => {
    const f = fixture();
    const binding = await f.records.start({ reviewId: 'review-coverage', title: 'Review', subjectKind: 'repository',
      sourceKind: 'workflow', reviewerIds: expected, startedAt: 10 });
    await f.records.settle({ ...binding, outcome: 'completed', finishedAt: 20,
      reviewerOutcomes: outcomes.map(outcome => ReviewReviewerOutcomeV1Schema.parse(outcome)), runs: [{ kind: 'workflow', runId: 'workflow-run' }] });
    expect((await f.records.read(binding.reviewId))?.rounds[0]?.state).toBe(state);
    expect(f.writes()).toBe(2);
  });

  it('does not let a claimed completion bypass missing host receipts', async () => {
    const f = fixture();
    const binding = await f.records.start({ reviewId: 'review-no-receipts', title: 'Review', subjectKind: 'repository',
      sourceKind: 'workflow', reviewerIds: ['one'], startedAt: 10 });
    await f.records.settle({ ...binding, outcome: 'completed', finishedAt: 20, runs: [] });
    expect((await f.records.read(binding.reviewId))?.rounds[0]?.state).toBe('failed');
  });

  it.each(['failed', 'cancelled'] as const)('preserves completed reviewer evidence when the Workflow is %s', async outcome => {
    const f = fixture();
    const binding = await f.records.start({ reviewId: 'stopped-workflow', title: 'Review', subjectKind: 'repository',
      sourceKind: 'workflow', reviewerIds: ['finished', 'refused'], startedAt: 10 });
    const round = await f.records.settle({ ...binding, outcome, finishedAt: 20, runs: [], reviewerOutcomes: [
      { key: 'finished', outcome: 'completed', reviewOutcome: 'complete', materialization: { kind: 'complete' },
        quality: { score: 4, rationale: 'Reviewed successfully.' } },
      { key: 'refused', outcome: 'launch_failed', errorCode: 'agent_isolation_unavailable' },
    ] });
    expect(round.state).toBe('partial');
    expect(round.reviewerOutcomes).toMatchObject([{ reviewerId: 'finished', outcome: 'completed' },
      { reviewerId: 'refused', outcome: 'failed', reason: { run: 'launch_failed', errorCode: 'agent_isolation_unavailable' } }]);
    expect(round.reviewerQuality).toMatchObject([{ reviewerId: 'finished', score: 4 }]);
    expect(projectReviewRoundQualityV1(round, 'median')).toBeNull();
    await f.records.settle({ ...binding, outcome: 'failed', finishedAt: 30, runs: [] });
    expect((await f.records.read(binding.reviewId))?.rounds[0]).toEqual(round);
  });

  it('opens settled quality for each admitted reviewer without inventing scores for old or missing evidence', async () => {
    const f = fixture();
    const start = { reviewId: 'quality-review', title: 'Review', subjectKind: 'repository' as const,
      sourceKind: 'workflow' as const, reviewerIds: ['one', 'two', 'legacy'],
      reviewerDisplayNames: { one: 'GPT-6.1', two: 'Claude Opus' }, startedAt: 1 };
    const binding = await f.records.start(start);
    const one = { score: 2, rationale: 'A regression remains.' };
    const two = { score: 5, rationale: 'The change has complete coverage.' };
    const outcomes = [
      { key: 'one', quality: one }, { key: 'unadmitted', quality: { score: 1, rationale: 'Outside the roster.' } },
      { key: 'two', quality: two }, { key: 'legacy' },
    ].map(outcome => ReviewReviewerOutcomeV1Schema.parse({ ...outcome, outcome: 'completed',
      reviewOutcome: 'complete', materialization: { kind: 'complete' } }));
    await f.records.settle({ ...binding, outcome: 'completed', finishedAt: 2, runs: [],
      reviewerOutcomes: outcomes });
    await f.records.start({ ...start, startedAt: 3, newRound: true });
    const rounds = (await f.records.read(binding.reviewId))?.rounds;
    expect(rounds).toMatchObject([
      { ordinal: 1, state: 'completed', medianQualityScore: 3.5, reviewerQuality: [{ reviewerId: 'one', displayName: 'GPT-6.1', ...one }, { reviewerId: 'two', displayName: 'Claude Opus', ...two }] },
      { ordinal: 2, state: 'running' },
    ]);
    expect(projectReviewRoundQualityV1(rounds?.[0], 'lowest')?.score).toBe(2);
    const median = projectReviewRoundQualityV1(rounds?.[0], 'median');
    expect(median?.score).toBe(3.5);
    expect(presentReviewRoundQualityV1(median)).toEqual({
      aggregation: 'median', displayScore: 3, reviewers: [{ reviewerId: 'one', displayName: 'GPT-6.1', ...one }, { reviewerId: 'two', displayName: 'Claude Opus', ...two }],
    });
    expect(presentReviewRoundQualityV1(projectReviewRoundQualityV1(rounds?.[0], 'lowest'))?.displayScore).toBe(2);
    expect(presentReviewRoundQualityV1(null)).toBeNull();
    expect(projectReviewRoundQualityV1(rounds?.[1], 'lowest')).toBeNull();
  });

  it('persists each admitted reviewer outcome and timing once at settlement; older rounds stay aggregate only', async () => {
    const f = fixture();
    const start = { reviewId: 'outcome-review', title: 'Review', subjectKind: 'repository' as const,
      sourceKind: 'workflow' as const, reviewerIds: ['fast', 'slow', 'thin', 'absent'],
      reviewerDisplayNames: { fast: 'Codex', slow: 'Claude' }, startedAt: 10 };
    const binding = await f.records.start(start);
    const outcomes = [
      { key: 'fast', runId: 'run-fast', outcome: 'completed', reviewOutcome: 'complete', materialization: { kind: 'complete' }, startedAt: 11, finishedAt: 40 },
      { key: 'slow', runId: 'run-slow', outcome: 'failed', errorCode: 'execution_run_failed', startedAt: 12, finishedAt: 90 },
      { key: 'thin', outcome: 'completed', reviewOutcome: 'partial', materialization: { kind: 'complete' } },
      { key: 'unadmitted', outcome: 'completed', reviewOutcome: 'complete', materialization: { kind: 'complete' } },
    ].map(outcome => ReviewReviewerOutcomeV1Schema.parse(outcome));
    await f.records.settle({ ...binding, outcome: 'completed', finishedAt: 100, runs: [], reviewerOutcomes: outcomes });
    const round = (await f.records.read(binding.reviewId))?.rounds[0];
    expect(round?.state).toBe('partial');
    expect(round?.reviewerOutcomes).toEqual([
      { reviewerId: 'fast', displayName: 'Codex', outcome: 'completed', runId: 'run-fast', startedAt: 11, finishedAt: 40 },
      { reviewerId: 'slow', displayName: 'Claude', outcome: 'failed', runId: 'run-slow', startedAt: 12, finishedAt: 90,
        reason: { run: 'failed', errorCode: 'execution_run_failed' } },
      { reviewerId: 'thin', outcome: 'partial', reason: { run: 'completed', reviewOutcome: 'partial' } },
      { reviewerId: 'absent', outcome: 'failed' },
    ]);
    const cancelled = await f.records.start({ ...start, startedAt: 200, newRound: true });
    await f.records.settle({ ...cancelled, outcome: 'cancelled', finishedAt: 210, runs: [] });
    expect((await f.records.read(binding.reviewId))?.rounds[1]?.reviewerOutcomes?.map(row => row.outcome))
      .toEqual(['cancelled', 'cancelled', 'cancelled', 'cancelled']);
    const legacy = { v: 1, rounds: [{ ordinal: 1, state: 'partial', startedAt: 1, finishedAt: 2, reviewerIds: ['a', 'b'], runs: [] }] };
    expect(ReviewArtifactBodyV1Schema.parse(legacy).rounds[0]?.reviewerOutcomes).toBeUndefined();
  });

  it('keeps a typed reason for each reviewer that did not finish, from its settled receipt', async () => {
    const f = fixture();
    const binding = await f.records.start({ reviewId: 'reason-review', title: 'Review', subjectKind: 'repository',
      sourceKind: 'workflow', reviewerIds: ['limited', 'stopped', 'unlaunched', 'thin', 'done', 'silent'], startedAt: 1 });
    const outcomes = [
      { key: 'limited', outcome: 'failed', errorCode: 'execution_run_failed', runtimeIssueV1: { v: 1, scope: 'primary_session',
        status: 'failed', code: 'usage_limit_reached', source: 'usage_limit', occurredAt: 5, sanitizedPreview: 'Limit reached' } },
      { key: 'stopped', outcome: 'cancelled' },
      { key: 'unlaunched', outcome: 'launch_failed', errorCode: 'review_engine_unavailable' },
      { key: 'thin', outcome: 'completed', reviewOutcome: 'partial', materialization: { kind: 'complete' } },
      { key: 'done', outcome: 'completed', reviewOutcome: 'complete', materialization: { kind: 'complete' } },
    ].map(outcome => ReviewReviewerOutcomeV1Schema.parse(outcome));
    await f.records.settle({ ...binding, outcome: 'completed', finishedAt: 9, runs: [], reviewerOutcomes: outcomes });
    const rows = (await f.records.read(binding.reviewId))?.rounds[0]?.reviewerOutcomes;
    expect(rows?.map(row => [row.reviewerId, row.outcome, row.reason])).toEqual([
      ['limited', 'failed', { run: 'failed', errorCode: 'execution_run_failed', runtimeIssue: { source: 'usage_limit', code: 'usage_limit_reached' } }],
      ['stopped', 'cancelled', { run: 'cancelled' }],
      ['unlaunched', 'failed', { run: 'launch_failed', errorCode: 'review_engine_unavailable' }],
      ['thin', 'partial', { run: 'completed', reviewOutcome: 'partial' }],
      ['done', 'completed', undefined],
      ['silent', 'failed', undefined],
    ]);
  });

  it('retains an addressable completed Review with zero findings and does not republish a terminal retry', async () => {
    const f = fixture();
    const binding = await f.records.start({ reviewId: 'review-1', title: 'Review', subjectKind: 'comparison',
      sourceKind: 'direct', reviewerIds: ['engine'], startedAt: 10, comparisonId: 'comparison-1' });
    const terminal = { ...binding, outcome: 'completed' as const, finishedAt: 20,
      reviewerOutcomes: [{ key: 'engine', outcome: 'completed' as const, materialization: { kind: 'complete' as const } }],
      runs: [{ kind: 'execution' as const, runId: 'run-1', machineId: 'machine-1', sessionId: 'session-1' }] };
    await f.records.settle(terminal);
    await f.records.settle(terminal);
    expect(await f.records.read('review-1')).toMatchObject({ rounds: [{ ordinal: 1, comparisonId: 'comparison-1',
      state: 'completed', runs: [{ runId: 'run-1' }] }] });
    expect(await f.records.read('review-1')).not.toHaveProperty('metadata');
    expect(f.writes()).toBe(2);
  });

  it.each(['failed', 'cancelled'] as const)('retains workflow %s separately from a clean result', async outcome => {
    const f = fixture();
    const binding = await f.records.start({ reviewId: 'review-1', title: 'Review', subjectKind: 'repository',
      sourceKind: 'workflow', workflowId: 'workflow-1', reviewerIds: ['engine'], startedAt: 10 });
    await f.records.settle({ ...binding, outcome, finishedAt: 20, runs: [{ kind: 'workflow', runId: 'workflow-run-1' }] });
    expect(await f.records.read('review-1')).toMatchObject({ rounds: [{ state: outcome, runs: [{ kind: 'workflow', runId: 'workflow-run-1' }] }] });
  });

  it('settles a workflow once with all run evidence and preserves history when a new round starts', async () => {
    const f = fixture();
    const start = { reviewId: 'review-1', title: 'Review', subjectKind: 'comparison' as const, sourceKind: 'direct' as const,
      reviewerIds: ['one', 'two'], startedAt: 10 };
    const binding = await f.records.start(start);
    const quality = { score: 5, rationale: 'This reviewer found no issues.' };
    await f.records.settle({ ...binding, outcome: 'partial', finishedAt: 21,
      reviewerOutcomes: [{ key: 'one', outcome: 'completed', materialization: { kind: 'complete' }, quality },
        { key: 'two', outcome: 'failed' }],
      runs: [{ kind: 'workflow', runId: 'workflow-1' }, { kind: 'execution', machineId: 'machine-1', runId: 'one' },
        { kind: 'execution', machineId: 'machine-2', runId: 'two' }] });
    expect(f.writes()).toBe(2);
    const next = await f.records.start({ ...start, startedAt: 30, comparisonId: 'new-code', newRound: true });
    expect(next).toEqual({ reviewId: 'review-1', roundOrdinal: 2 });
    const rounds = (await f.records.read('review-1'))?.rounds;
    expect(rounds).toMatchObject([
      { ordinal: 1, state: 'partial', reviewerQuality: [{ reviewerId: 'one', ...quality }] },
      { ordinal: 2, comparisonId: 'new-code', state: 'running' },
    ]);
    expect(projectReviewRoundQualityV1(rounds?.[0], 'lowest')).toBeNull();
    expect(projectReviewRoundQualityV1(rounds?.[0], 'median')).toBeNull();
    const { describeReviewRoundQualityV1 } = await import('./reviewArtifactV1.js');
    expect(describeReviewRoundQualityV1(rounds?.[0], 'median')).toEqual({
      quality: null, unavailableReason: 'partial', reviewers: [{ reviewerId: 'one', ...quality }],
    });
    expect(rounds?.[0]).not.toHaveProperty('results');
  });
});
