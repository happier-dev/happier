import { describe, expect, it } from 'vitest';
import { createReviewRecordPortV1, type ReviewArtifactTransportV1 } from './reviewArtifactV1.js';

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

  it('retains an addressable completed Review with zero findings and does not republish a terminal retry', async () => {
    const f = fixture();
    const binding = await f.records.start({ reviewId: 'review-1', title: 'Review', subjectKind: 'comparison',
      sourceKind: 'direct', reviewerIds: ['engine'], startedAt: 10, comparisonId: 'comparison-1' });
    const terminal = { ...binding, outcome: 'completed' as const, finishedAt: 20,
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
    await f.records.settle({ ...binding, outcome: 'partial', finishedAt: 21,
      runs: [{ kind: 'workflow', runId: 'workflow-1' }, { kind: 'execution', machineId: 'machine-1', runId: 'one' },
        { kind: 'execution', machineId: 'machine-2', runId: 'two' }] });
    expect(f.writes()).toBe(2);
    const next = await f.records.start({ ...start, startedAt: 30, comparisonId: 'new-code', newRound: true });
    expect(next).toEqual({ reviewId: 'review-1', roundOrdinal: 2 });
    expect((await f.records.read('review-1'))?.rounds).toMatchObject([{ ordinal: 1, state: 'partial' }, { ordinal: 2, comparisonId: 'new-code', state: 'running' }]);
    expect((await f.records.read('review-1'))?.rounds[0]).not.toHaveProperty('results');
  });
});
