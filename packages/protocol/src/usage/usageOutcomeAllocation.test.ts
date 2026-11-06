import { describe, expect, it } from 'vitest';
import { allocateUsageOutcomes, summarizeUsageMergedOutcomes, UsageMergedOutcomeSummarySchema,
  UsageWorkProjectionSchema, type UsageWorkContribution, type UsageWorkEvidence } from './usageOutcomeAllocation.js';

const tokens = { input: 10, output: 4, reasoning: 1, cacheRead: 2, cacheWrite: 0, total: 14 };
function contribution(id: string, sessionId: string, turnId: string | null): UsageWorkContribution {
  return { id, sessionId, turnId, observedAtMs: 1, agentId: 'coding-agent', modelId: 'model', machineId: 'machine',
    projectKey: 'project', workspaceId: null, source: 'runtime', tokens,
    cost: { reportedUsd: 3, estimatedUsd: 4, invoiceUsd: 2, currency: 'USD' } };
}
function evidence(sessionId: string, turnId: string, number: number, repositoryKey = 'repo'): UsageWorkEvidence {
  return { sessionId, turnId, repositoryKey, checkpointRef: `checkpoint/${sessionId}/${turnId}`,
    checkpointCommitSha: 'a'.repeat(40), commitSha: 'b'.repeat(40), attributionScope: 'no_happier_checkpoint_overlap_observed',
    pullRequest: { provider: { id: 'forge', kind: 'github', displayName: 'Forge', baseUrl: 'https://github.com',
      nameWithOwner: 'owner/repo', urlSafety: { allowedSchemes: ['https:'] } },
      number, title: 'Outcome', url: `https://github.com/owner/repo/pull/${number}`, baseBranch: 'main', headBranch: 'feature', state: 'merged' } };
}

describe('evidence-derived Work allocation', () => {
  it('summarizes only distinct merged outcomes and uses actual merge dates, the query offset and witnessed Agent contributions', () => {
    const period = { startMs: Date.parse('2026-10-11T23:00:00Z'), endMs: Date.parse('2026-10-20T23:00:00Z') };
    const timeZoneOffsetMinutes = 120;
    const contributions = [
      { ...contribution('a', 's1', 't1'), agentId: 'alpha' },
      { ...contribution('b', 's2', 't2'), agentId: 'beta' },
      { ...contribution('c', 's2', 't3'), agentId: 'alpha' },
      { ...contribution('d', 's3', 't4'), agentId: null },
      { ...contribution('e', 's3', 't5'), agentId: 'beta' },
      contribution('f', 's4', 't6'), contribution('g', 's4', 't7'), contribution('h', 's4', 't8'),
      contribution('i', 's4', 't9'),
    ];
    const merged = (sessionId: string, turnId: string, number: number, mergedAtMs?: number): UsageWorkEvidence => {
      const witness = evidence(sessionId, turnId, number);
      return { ...witness, pullRequest: { ...witness.pullRequest, ...(mergedAtMs === undefined ? {} : { mergedAtMs }),
        author: { login: 'unrelated-author' } } };
    };
    const witnesses = [
      merged('s1', 't1', 1, period.startMs), merged('s2', 't2', 1, period.startMs),
      merged('s2', 't3', 1, period.startMs), merged('s3', 't4', 2),
      merged('s3', 't5', 3, Date.parse('2026-10-18T22:30:00Z')),
      { ...merged('s4', 't6', 4), pullRequest: { ...evidence('s4', 't6', 4).pullRequest, state: 'open' as const } },
      merged('s4', 't7', 5, period.startMs - 1), merged('s4', 't8', 6, period.endMs),
      { ...merged('s4', 't9', 7), pullRequest: { ...evidence('s4', 't9', 7).pullRequest,
        state: 'closed' as const, closedAtMs: period.startMs } },
    ];
    const work = allocateUsageOutcomes({ contributions, evidence: [...witnesses, witnesses[0]] });
    const summary = summarizeUsageMergedOutcomes({ work, period, timeZoneOffsetMinutes });
    expect(summary).toMatchObject({ period, timeZoneOffsetMinutes, attributionBasis: 'contribution_count',
      linkedMergedCount: 5, mergedInPeriodCount: 2, outsidePeriodMergedCount: 2, undatedMergedCount: 1,
      mergeWeeks: [
        { bucketStartMs: period.startMs, bucketEndMs: Date.parse('2026-10-18T22:00:00Z'), count: 1 },
        { bucketStartMs: Date.parse('2026-10-18T22:00:00Z'), bucketEndMs: period.endMs, count: 1 },
      ],
    });
    expect(summary.outcomes).toHaveLength(5);
    expect(summary.outcomes.find(row => row.key === '["repo",1]')).toEqual({
      key: '["repo",1]', mergedAtMs: period.startMs, attribution: 'mixed',
      agentContributions: [{ agentId: 'alpha', contributionCount: 2 }, { agentId: 'beta', contributionCount: 1 }],
      leadingAgentIds: ['alpha'],
    });
    expect(summary.outcomes.find(row => row.key === '["repo",2]')).toEqual({
      key: '["repo",2]', mergedAtMs: null, attribution: 'unknown',
      agentContributions: [{ agentId: null, contributionCount: 1 }], leadingAgentIds: [null],
    });
    expect(summarizeUsageMergedOutcomes({ work: allocateUsageOutcomes({ contributions: [...contributions].reverse(),
      evidence: [...witnesses].reverse() }), period, timeZoneOffsetMinutes })).toEqual(summary);
  });

  it('retains Unknown and tied leading Agents while refusing ambiguous or shared-writer attribution', () => {
    const period = { startMs: 0, endMs: 1_000 };
    const contributions = [
      { ...contribution('a', 's1', 't1'), agentId: 'alpha' },
      { ...contribution('b', 's2', 't2'), agentId: 'beta' },
      { ...contribution('c', 's3', 't3'), agentId: null },
      contribution('ambiguous', 's4', 't4'), contribution('shared', 's5', 't5'),
    ];
    const work = allocateUsageOutcomes({ contributions, evidence: [
      ...[['s1', 't1'], ['s2', 't2'], ['s3', 't3']].map(([sessionId, turnId]) => {
        const witness = evidence(sessionId, turnId, 1);
        return { ...witness, pullRequest: { ...witness.pullRequest, mergedAtMs: 0 } };
      }),
      evidence('s4', 't4', 2), evidence('s4', 't4', 3),
      { ...evidence('s5', 't5', 4), attributionScope: 'shared_worktree' },
    ] });
    const summary = summarizeUsageMergedOutcomes({ work, period, timeZoneOffsetMinutes: 0 });
    expect(summary).toMatchObject({ linkedMergedCount: 1, mergedInPeriodCount: 1, outsidePeriodMergedCount: 0,
      undatedMergedCount: 0, mergeWeeks: [{ bucketStartMs: 0, bucketEndMs: 1_000, count: 1 }],
      outcomes: [{ key: '["repo",1]', mergedAtMs: 0, attribution: 'mixed',
        agentContributions: [{ agentId: 'alpha', contributionCount: 1 }, { agentId: 'beta', contributionCount: 1 },
          { agentId: null, contributionCount: 1 }], leadingAgentIds: ['alpha', 'beta', null] }],
    });
    expect(UsageMergedOutcomeSummarySchema.safeParse(summary).success).toBe(true);
    expect(UsageMergedOutcomeSummarySchema.safeParse({ ...summary, outcomes: [{ ...summary.outcomes[0], author: 'guessed' }] }).success).toBe(false);
    expect(UsageMergedOutcomeSummarySchema.safeParse({ ...summary, outcomes: [{ ...summary.outcomes[0], agentContributions: [
      { ...summary.outcomes[0].agentContributions[0], currentSessionAgent: 'guessed' },
    ] }] }).success).toBe(false);
    expect(summarizeUsageMergedOutcomes({ work: allocateUsageOutcomes({ contributions: [], evidence: [] }), period,
      timeZoneOffsetMinutes: 0 })).toEqual({ period, timeZoneOffsetMinutes: 0, attributionBasis: 'contribution_count',
      linkedMergedCount: 0, mergedInPeriodCount: 0, outsidePeriodMergedCount: 0, undatedMergedCount: 0,
      mergeWeeks: [], outcomes: [] });
  });

  it('allocates standalone branch graphs once without changing PR allocation, and retains ambiguity/shared writers', () => {
    const witnessed = evidence('s', 't', 1);
    const { pullRequest: _pullRequest, ...checkpoint } = witnessed;
    const branchEvidence = [{ ...checkpoint, branch: { ref: 'refs/heads/feature', headSha: 'b'.repeat(40) } }];
    const contributions = [contribution('a', 's', 't')];
    const result = allocateUsageOutcomes({ contributions, evidence: [], branchEvidence: [...branchEvidence, ...branchEvidence] });
    expect(result.allocations[0].outcome).toBeNull();
    expect(result.branchAllocations[0].branch?.contributionIds).toEqual(['a']);
    expect(result.branches).toHaveLength(1);
    expect(result.branchAllocations[0].contribution.cost.reportedUsd).toBe(3);
    expect(UsageWorkProjectionSchema.safeParse(result).success).toBe(true);
    const withPr = allocateUsageOutcomes({ contributions, evidence: [witnessed], branchEvidence });
    expect(withPr.allocations).toEqual(allocateUsageOutcomes({ contributions, evidence: [witnessed] }).allocations);
    const ambiguous = allocateUsageOutcomes({ contributions, evidence: [], branchEvidence: [...branchEvidence,
      { ...checkpoint, branch: { ref: 'refs/heads/other', headSha: 'b'.repeat(40) } }] });
    expect(ambiguous.branchAllocations[0]).toMatchObject({ branch: null, reason: 'ambiguous_outcome' });
    expect(allocateUsageOutcomes({ contributions, evidence: [], branchEvidence: [...branchEvidence,
      { ...branchEvidence[0], repositoryKey: 'other-repository' },
    ] }).branchAllocations[0]).toMatchObject({ branch: null, reason: 'ambiguous_outcome' });
    expect(allocateUsageOutcomes({ contributions, evidence: [], branchEvidence: [
      { ...branchEvidence[0], attributionScope: 'shared_worktree' },
    ] }).branchAllocations[0]).toMatchObject({ branch: null, reason: 'uncertain_writers' });
    expect(UsageWorkProjectionSchema.safeParse({ ...result, branches: [{ ...result.branches[0], invented: true }] }).success).toBe(false);
  });
  it('does not let a different query turn change an admitted allocation', () => {
    const admitted = evidence('s', 't', 1);
    const other = { ...evidence('s', 'another-turn', 1), pullRequest: { ...admitted.pullRequest, state: 'open' as const } };
    const contributions = [contribution('a', 's', 't')];
    const projected = allocateUsageOutcomes({ contributions, evidence: [admitted, other] });
    expect(projected).toEqual(allocateUsageOutcomes({ contributions, evidence: [admitted] }));
    expect(UsageWorkProjectionSchema.safeParse(projected).success).toBe(true);
  });
  it('allocates distinct turns many-to-many and conserves each input cost kind and tokens exactly once', () => {
    const contributions = [contribution('a', 's1', 't1'), contribution('b', 's1', 't2'),
      contribution('c', 's2', 't3'), contribution('d', 's1', null)];
    const result = allocateUsageOutcomes({ contributions, evidence: [evidence('s1', 't1', 1),
      evidence('s1', 't2', 2), evidence('s2', 't3', 1), evidence('s1', 't1', 1)] });
    expect(result.allocations.map(row => [row.contribution.id, row.outcome?.pullRequest.number ?? null])).toEqual([
      ['a', 1], ['b', 2], ['c', 1], ['d', null],
    ]);
    expect(result.outcomes.map(row => row.contributionIds)).toEqual([['a', 'c'], ['b']]);
    // Output shape does not rerun the allocator to impose its presentation order.
    expect(UsageWorkProjectionSchema.safeParse({ ...result, outcomes: [...result.outcomes].reverse() }).success).toBe(true);
    for (const key of ['reportedUsd', 'estimatedUsd', 'invoiceUsd'] as const) {
      expect(result.allocations.reduce((sum, row) => sum + (row.contribution.cost[key] ?? 0), 0))
        .toBe(contributions.reduce((sum, row) => sum + (row.cost[key] ?? 0), 0));
    }
    expect(result.allocations.reduce((sum, row) => sum + row.contribution.tokens.total, 0)).toBe(56);
    expect(result.allocations[3].reason).toBe('missing_turn');
  });

  it('leaves conflicting outcomes, shared writers, absent/revoked evidence and another repository unallocated', () => {
    const contributions = [contribution('conflict', 's', 't1'), contribution('shared', 's', 't2'),
      contribution('missing', 's', 't3'), contribution('repo-conflict', 's', 't4')];
    const result = allocateUsageOutcomes({ contributions, evidence: [evidence('s', 't1', 1), evidence('s', 't1', 2),
      { ...evidence('s', 't2', 1), attributionScope: 'shared_worktree' },
      evidence('s', 't4', 1), evidence('s', 't4', 1, 'other-repo')] });
    expect(result.outcomes).toEqual([]);
    expect(result.allocations.map(row => row.reason)).toEqual(['ambiguous_outcome', 'uncertain_writers', 'missing_evidence', 'ambiguous_outcome']);
    expect(allocateUsageOutcomes({ contributions, evidence: [] }).allocations.every(row => row.outcome === null)).toBe(true);
  });

  it('is independent of evidence ordering and refuses conflicting contribution identities', () => {
    const contributions = [contribution('a', 's', 't')];
    const witnesses = [evidence('s', 't', 1), { ...evidence('s', 't', 1), commitSha: 'c'.repeat(40) }];
    expect(allocateUsageOutcomes({ contributions, evidence: witnesses })).toEqual(
      allocateUsageOutcomes({ contributions, evidence: [...witnesses].reverse() }));
    expect(() => allocateUsageOutcomes({ contributions: [contributions[0], contribution('a', 'other', 't')], evidence: witnesses }))
      .toThrow(/contribution/i);
  });

  it('leaves inconsistent hosting summaries unallocated instead of selecting one state', () => {
    const witnesses = [evidence('s', 't', 1), { ...evidence('s', 't', 1), pullRequest: {
      ...evidence('s', 't', 1).pullRequest, state: 'open' as const,
    } }];
    const result = allocateUsageOutcomes({ contributions: [contribution('a', 's', 't')], evidence: witnesses });
    expect(result.allocations[0]).toMatchObject({ reason: 'ambiguous_outcome', outcome: null });
    expect(result.outcomes).toEqual([]);
  });
});
