import { describe, expect, it } from 'vitest';
import {
  allocateUsageOutcomes,
  type UsageWorkContribution,
  type UsageWorkEvidence,
} from '@happier-dev/protocol/usage/usageOutcomeAllocation';
import { summarizeUsageWork, summarizeUsageWorkSession } from './usageWorkPresentation';

const tokens = {
  input: 10,
  output: 4,
  reasoning: 1,
  cacheRead: 2,
  cacheWrite: 0,
  total: 14,
};
function known(value: number | null): number {
  if (value === null) throw new Error('Expected witnessed money');
  return value;
}
function contribution(
  id: string,
  sessionId: string,
  turnId: string | null,
  projectKey: string | null = 'p1',
): UsageWorkContribution {
  return {
    id,
    sessionId,
    turnId,
    observedAtMs: 1,
    agentId: 'claude',
    modelId: 'model',
    machineId: 'machine',
    projectKey,
    workspaceId: null,
    source: 'runtime',
    tokens,
    cost: { reportedUsd: 3, estimatedUsd: 4, currency: 'USD' },
  };
}
function evidence(
  sessionId: string,
  turnId: string,
  number: number,
  state: 'open' | 'merged' = 'merged',
): UsageWorkEvidence {
  return {
    sessionId,
    turnId,
    repositoryKey: 'repo',
    checkpointRef: `checkpoint/${sessionId}/${turnId}`,
    checkpointCommitSha: 'a'.repeat(40),
    commitSha: 'b'.repeat(40),
    attributionScope: 'no_happier_checkpoint_overlap_observed',
    pullRequest: {
      provider: {
        id: 'forge',
        kind: 'github',
        displayName: 'Forge',
        baseUrl: 'https://github.com',
        nameWithOwner: 'owner/repo',
        urlSafety: { allowedSchemes: ['https:'] },
      },
      number,
      title: `Outcome ${number}`,
      url: `https://github.com/owner/repo/pull/${number}`,
      baseBranch: 'main',
      headBranch: 'feature',
      state,
    },
  };
}

describe('Work display grouping of the canonical allocation', () => {
  it('expands a project, a PR and a branch into exact per-Session parts that add back to the row', () => {
    const bound = (id: string, sessionId: string, turnId: string, projectKey: string) => ({ ...contribution(id, sessionId, turnId, projectKey),
      providerId: 'provider.openrouter', providerConnectionId: 'connection' });
    const branchWitness = (sessionId: string, turnId: string, commitSha: string) => ({ sessionId, turnId, repositoryKey: 'repo',
      checkpointRef: `checkpoint/${sessionId}/${turnId}`, checkpointCommitSha: 'a'.repeat(40), commitSha,
      attributionScope: 'no_happier_checkpoint_overlap_observed' as const, branch: { ref: 'refs/heads/glass', headSha: 'c'.repeat(40) } });
    const summary = summarizeUsageWork(allocateUsageOutcomes({
      contributions: [bound('a', 's1', 't1', 'p1'), bound('b', 's1', 't2', 'p1'), contribution('c', 's2', 't3', 'p1'), contribution('d', 's2', 't4', 'p2')],
      evidence: [evidence('s1', 't1', 1), evidence('s2', 't3', 1)],
      branchEvidence: [branchWitness('s1', 't1', 'd'.repeat(40)), branchWitness('s1', 't2', 'e'.repeat(40)), branchWitness('s2', 't4', 'd'.repeat(40))],
    }), { metric: 'cost', costBasis: 'reported' });
    const project = summary.projects.find(row => row.projectKey === 'p1')!;
    expect(project.sessions).toEqual([{ sessionId: 's1', amount: 6 }, { sessionId: 's2', amount: 3 }]);
    expect(project.sessions.reduce((sum, row) => sum + known(row.amount), 0)).toBe(project.amount);
    // The branch part of a project counts only that project's witnessed contributions.
    expect(project.branches).toEqual([expect.objectContaining({ amount: 6, sessions: [{ sessionId: 's1', amount: 6 }],
      commits: ['d'.repeat(40), 'e'.repeat(40)] })]);
    const branch = summary.branches[0]!;
    expect(summary.agents).toEqual([{ agentId: 'claude', amount: 12 }]);
    expect(branch).toMatchObject({ amount: 9, perSession: 4.5, projectKeys: ['p1', 'p2'], agentIds: ['claude'], providerUnknown: true,
      providers: [{ providerId: 'provider.openrouter', machineId: 'machine' }] });
    expect(branch.sessions).toEqual([{ sessionId: 's1', amount: 6 }, { sessionId: 's2', amount: 3 }]);
    const outcome = summary.outcomes[0]!;
    expect(outcome.sessions).toEqual([{ sessionId: 's1', amount: 3 }, { sessionId: 's2', amount: 3 }]);
    expect(outcome.sessions.reduce((sum, row) => sum + known(row.amount), 0)).toBe(outcome.amount);
    expect(outcome).toMatchObject({ providers: [{ providerId: 'provider.openrouter', machineId: 'machine' }], providerUnknown: true });
  });
  it('reads one Session as its turns in witnessed order, each with its own exact amount and evidence', () => {
    const at = (row: UsageWorkContribution, observedAtMs: number) => ({ ...row, observedAtMs });
    const work = allocateUsageOutcomes({
      contributions: [at(contribution('late', 's1', 't2'), 30), at(contribution('early', 's1', 't1'), 10),
        at(contribution('loose', 's1', null), 20), at(contribution('other', 's2', 't9'), 5)],
      evidence: [evidence('s1', 't1', 7)],
      branchEvidence: [{ sessionId: 's1', turnId: 't2', repositoryKey: 'repo', checkpointRef: 'checkpoint/s1/t2', checkpointCommitSha: 'a'.repeat(40),
        commitSha: 'f'.repeat(40), attributionScope: 'no_happier_checkpoint_overlap_observed', branch: { ref: 'refs/heads/glass', headSha: 'c'.repeat(40) } }],
    });
    const autopsy = summarizeUsageWorkSession(work, { metric: 'cost', costBasis: 'reported' }, 's1');
    expect(autopsy.turns.map(turn => [turn.contributionId, turn.turnId, turn.amount, turn.reason])).toEqual([
      ['early', 't1', 3, 'allocated'], ['loose', null, 3, 'missing_turn'], ['late', 't2', 3, 'missing_evidence']]);
    expect(autopsy.turns[0]).toMatchObject({ checkpoints: ['checkpoint/s1/t1'], commits: ['b'.repeat(40)], branches: [],
      outcome: expect.objectContaining({ pullRequest: expect.objectContaining({ number: 7 }) }) });
    expect(autopsy.turns[2]).toMatchObject({ checkpoints: ['checkpoint/s1/t2'], commits: ['f'.repeat(40)], branches: ['refs/heads/glass'], outcome: null });
    expect(autopsy.amount).toBe(9);
    expect(autopsy.outcomes.map(row => row.pullRequest.number)).toEqual([7]);
    expect(summarizeUsageWorkSession(work, { metric: 'cost', costBasis: 'reported' }, 'missing').turns).toEqual([]);
  });
  it('groups a standalone branch only from canonical branch allocations and retains the actual Provider binding', () => {
    const bound = { ...contribution('branch', 's1', 't1'), providerId: 'provider.openrouter', providerConnectionId: 'connection', agentId: 'claude' };
    const witness = { sessionId: 's1', turnId: 't1', repositoryKey: 'opaque-repo', checkpointRef: 'checkpoint/s1/t1',
      checkpointCommitSha: 'a'.repeat(40), commitSha: 'b'.repeat(40), attributionScope: 'no_happier_checkpoint_overlap_observed' as const,
      branch: { ref: 'refs/heads/standalone', headSha: 'c'.repeat(40) } };
    const summary = summarizeUsageWork(allocateUsageOutcomes({ contributions: [bound], evidence: [], branchEvidence: [witness] }), { metric: 'cost', costBasis: 'reported' });
    expect(summary.branches).toEqual([expect.objectContaining({ amount: 3, branch: expect.objectContaining({ branch: witness.branch }) })]);
    expect(summary.projects[0]?.providers).toEqual([{ providerId: 'provider.openrouter', machineId: 'machine' }]);
    expect(summary.sessions[0]?.providers).toEqual([{ providerId: 'provider.openrouter', machineId: 'machine' }]);
    expect(summary.outcomes).toEqual([]);
    expect(summary.unallocatedByReason.missing_evidence).toBe(3);
  });
  it('preserves absent and partly priced money while retaining a witnessed zero', () => {
    const unknown = { ...contribution('unknown', 'unpriced', 't1'), cost: { reportedUsd: 0, estimatedUsd: 0, currency: 'USD', costSource: 'none' as const } };
    const free = { ...contribution('free', 'free', 't2'), cost: { reportedUsd: 0, estimatedUsd: 0, currency: 'USD', costSource: 'provider_reported' as const } };
    const known = contribution('known', 'partial', 't3');
    const partlyPriced = { ...unknown, id: 'partial-unknown', sessionId: 'partial', turnId: 't4' };
    const summary = summarizeUsageWork(allocateUsageOutcomes({ contributions: [unknown, free, known, partlyPriced], evidence: [] }), { metric: 'cost', costBasis: 'reported' });
    expect(summary.total).toBeNull();
    expect(summary.sessions.find(row => row.sessionId === 'unpriced')?.amount).toBeNull();
    expect(summary.sessions.find(row => row.sessionId === 'partial')?.amount).toBeNull();
    expect(summary.sessions.find(row => row.sessionId === 'free')?.amount).toBe(0);
    expect(summary.unallocatedByReason.missing_evidence).toBeNull();
    const independent = summarizeUsageWork(allocateUsageOutcomes({ contributions: [unknown, known],
      evidence: [evidence('unpriced', 't1', 1)] }), { metric: 'cost', costBasis: 'reported' });
    expect(independent.allocated).toBeNull();
    expect(independent.unallocated).toBe(3);
    expect(summarizeUsageWork(allocateUsageOutcomes({ contributions: [unknown, free, known, partlyPriced], evidence: [] }), { metric: 'tokens', costBasis: 'reported' }).total).toBe(56);
  });
  it('keeps allocated plus every unallocated reason equal to the admitted total, per metric and cost basis', () => {
    // s1 links two turns to two PRs; s2 links one turn to two PRs (ambiguous); s3 has no evidence; one row has no turn.
    const work = allocateUsageOutcomes({
      contributions: [
        contribution('a', 's1', 't1'),
        contribution('b', 's1', 't2'),
        contribution('c', 's2', 't3', 'p2'),
        contribution('d', 's3', 't4', null),
        contribution('e', 's1', null),
      ],
      evidence: [
        evidence('s1', 't1', 1),
        evidence('s1', 't2', 2, 'open'),
        evidence('s2', 't3', 1),
        evidence('s2', 't3', 3),
      ],
    });
    for (const basis of [
      { metric: 'cost', costBasis: 'reported' },
      { metric: 'cost', costBasis: 'estimated' },
      { metric: 'tokens', costBasis: 'auto' },
    ] as const) {
      const summary = summarizeUsageWork(work, basis);
      const unallocated = Object.values(summary.unallocatedByReason).reduce(
        (sum: number, value) => sum + known(value),
        0,
      );
      expect(known(summary.allocated) + unallocated).toBe(summary.total);
      expect(
        summary.projects.reduce(
          (sum, row) => sum + known(row.allocated) + known(row.unallocated),
          0,
        ),
      ).toBe(summary.total);
      expect(summary.outcomes.reduce((sum, row) => sum + known(row.amount), 0)).toBe(
        summary.allocated,
      );
    }
    const summary = summarizeUsageWork(work, {
      metric: 'cost',
      costBasis: 'reported',
    });
    expect(summary.total).toBe(15);
    expect(summary.unallocatedByReason).toEqual({
      missing_turn: 3,
      missing_evidence: 3,
      ambiguous_outcome: 3,
      uncertain_writers: 0,
    });
    // An ambiguous session is witnessed but never counted as an outcome; an unlinked one is neither.
    expect(summary.funnel).toEqual({
      sessions: 3,
      witnessed: 2,
      allocated: 1,
      merged: 1,
    });
    expect(
      summary.sessions.find((row) => row.sessionId === 's2'),
    ).toMatchObject({
      witnessed: true,
      outcomes: [],
      unallocatedReasons: ['ambiguous_outcome'],
    });
    expect(
      summary.outcomes.map((row) => [
        row.outcome.pullRequest.number,
        row.amount,
        row.sessionIds,
      ]),
    ).toEqual([
      [1, 3, ['s1']],
      [2, 3, ['s1']],
    ]);
  });
});
