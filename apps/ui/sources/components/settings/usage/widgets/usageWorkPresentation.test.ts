import { describe, expect, it } from 'vitest';
import { getUsageQueryKey, normalizeUsageQuery } from '@happier-dev/protocol/inputs/usageQuery';
import type { UsageQueryResultSlice } from '@happier-dev/protocol/usage/resolveUsagePageAggregation';
import {
  allocateUsageOutcomes,
  type UsageWorkContribution,
  type UsageWorkEvidence,
} from '@happier-dev/protocol/usage/usageOutcomeAllocation';
import { t } from '@/text';
import { projectUsageSessionValuePlots, readUsagePageWorkCauses, summarizeUsageWork, summarizeUsageWorkSession, usageWorkContributionAmount,
  usageWorkCauseLabel, usageWorkLinksNotice } from './usageWorkPresentation';

function allocate(input: Parameters<typeof allocateUsageOutcomes>[0]) {
  return { ...allocateUsageOutcomes(input), fixtureContributions: input.contributions };
}
function summarize(work: ReturnType<typeof allocate>, basis: Parameters<typeof summarizeUsageWork>[2],
  namedProjectKeys?: ReadonlySet<string>, anchorOf?: (key: string) => string) {
  return summarizeUsageWork(work, work.fixtureContributions, basis, namedProjectKeys, anchorOf);
}
function summarizeSession(work: ReturnType<typeof allocate>, basis: Parameters<typeof summarizeUsageWorkSession>[2], sessionId: string) {
  return summarizeUsageWorkSession(work, work.fixtureContributions, basis, sessionId);
}

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

describe('Work coverage details', () => {
  it('keeps a single displayed scope exact and avoids a page-wide count for separately scoped Sessions', () => {
    const scope = (session: string): UsageQueryResultSlice => {
      const query = normalizeUsageQuery({ period: { startMs: 0, endMs: 1000 }, session, includeWorkEvidence: true });
      return { key: getUsageQueryKey(query), requestedQuery: query, shownQuery: query, pending: false,
        sources: [{ source: 'work', status: 'partial', unreadSessions: { machine_unavailable: 1, failed: 1 } }] };
    };
    const first = scope('first');
    const second = scope('second');
    const exact = { count: 1, formattedCount: '1' };
    expect(readUsagePageWorkCauses([first]).map(usageWorkCauseLabel)).toEqual([
      t('usage.board.work.workUnreadUnreachable', exact), t('usage.board.work.workUnreadOther', exact),
    ]);
    expect(readUsagePageWorkCauses([first, second]).map(usageWorkCauseLabel)).toEqual([
      t('usage.board.work.workUnreadUnreachableSome'), t('usage.board.work.workUnreadOtherSome'),
    ]);
  });

  it('reuses the settled allocation reasons for cards and sibling-only batch publications', () => {
    // Same real Account scale as the Work grouping measurement below.
    const contributions = Array.from({ length: 3_800 }, (_, index) => contribution(`usage-${index}`, `session-${index}`, 'turn'));
    const query = normalizeUsageQuery({ period: { startMs: 0, endMs: 1000 }, includeWorkEvidence: true });
    const siblingQuery = normalizeUsageQuery({ ...query, includeWorkEvidence: false });
    let reasonReads = 0;
    const graph = (withMissingTurn: boolean) => {
      const rows = withMissingTurn ? [{ ...contributions[0]!, turnId: null }, ...contributions.slice(1)] : contributions;
      const work = allocateUsageOutcomes({ contributions: rows, evidence: [] });
      return { ...work, allocations: work.allocations.map(allocation => ({
        ...allocation,
        get reason() { reasonReads++; return allocation.reason; },
      })) };
    };
    const work = graph(true);
    const slice: UsageQueryResultSlice = { key: getUsageQueryKey(query), requestedQuery: query, shownQuery: query,
      sources: [{ source: 'work', status: 'partial' }], pending: false, work };
    const sibling: UsageQueryResultSlice = { key: getUsageQueryKey(siblingQuery), requestedQuery: siblingQuery, shownQuery: siblingQuery,
      sources: [{ source: 'accounting', status: 'pending' }], pending: true };
    expect(usageWorkLinksNotice(slice).cause).toContain(t('usage.board.work.reason_missing_turn'));
    expect(reasonReads).toBe(contributions.length);

    reasonReads = 0;
    const published = { ...sibling, sources: [{ source: 'accounting', status: 'available' as const }], pending: false };
    const originalCauses = readUsagePageWorkCauses([{ ...slice }, sibling]);
    expect(originalCauses).toHaveLength(1);
    expect(readUsagePageWorkCauses([{ ...slice }, published])).toEqual(originalCauses);
    expect(reasonReads, 'sibling-only publications reuse the allocation reasons already projected for the card').toBe(0);

    expect(readUsagePageWorkCauses([{ ...slice, work: graph(false) }, published])).toHaveLength(0);
    expect(reasonReads).toBe(contributions.length);
  });
});

describe('Work display grouping of the canonical allocation', () => {
  it('carries measured-floor provenance beside reported totals through Work groups and turns', () => {
    const parts = { ...contribution('parts', 'session', 'turn'),
      tokens: { input: 1710, output: 3, reasoning: null, cacheRead: null, cacheWrite: null, total: null } };
    const reported = { ...contribution('reported', 'session', 'turn'), tokens: { ...tokens, total: 2000 } };
    const work = allocate({ contributions: [reported, parts], evidence: [evidence('session', 'turn', 1)] });
    const basis = { metric: 'tokens', costBasis: 'auto' } as const;
    const summary = summarize(work, basis);
    expect.soft(summary).toMatchObject({ total: 3713, tokensFromParts: true });
    expect.soft(summary.projects[0]).toMatchObject({ amount: 3713, tokensFromParts: true });
    expect.soft(summary.sessions[0]).toMatchObject({ amount: 3713, tokensFromParts: true });
    expect.soft(summary.outcomes[0]).toMatchObject({ amount: 3713, tokensFromParts: true });
    expect.soft(summary.projects[0]?.sessions[0]).toMatchObject({ amount: 3713, tokensFromParts: true });
    const autopsy = summarizeSession(work, basis, 'session');
    expect(autopsy.turns[0]).toMatchObject({ amount: 3713, tokensFromParts: true });
    const exact = summarize(allocate({ contributions: [reported], evidence: [] }), basis);
    expect(exact).toMatchObject({ total: 2000, tokensFromParts: false });
  });

  it('uses measured parts in Work amounts and grouped totals', () => {
    const measured = { ...contribution('parts', 'session', 'turn'),
      tokens: { input: 1710, output: 3, reasoning: null, cacheRead: null, cacheWrite: null, total: null } };
    const work = allocate({ contributions: [measured], evidence: [] });
    const summary = summarize(work, { metric: 'tokens', costBasis: 'auto' });
    expect(summary.total).toBe(1713);
    expect(summary.sessions[0]?.amount).toBe(1713);
    expect(usageWorkContributionAmount({ contribution: measured }, { metric: 'tokens', costBasis: 'auto' })).toBe(1713);
  });
  it('visits allocations in proportion to contributions, without multiplying by Project count', () => {
    // Reload 145's Account has over 3,800 Sessions; each Project must not re-scan that inventory.
    const measure = (projectCount: number) => {
      const contributions = Array.from({ length: 3_800 }, (_, index) =>
        contribution(`cost-${index}`, `session-${index}`, 't1', `project-${index % projectCount}`));
      const witness = { sessionId: 'session-0', turnId: 't1', repositoryKey: 'repo', checkpointRef: 'checkpoint/0',
        checkpointCommitSha: 'a'.repeat(40), commitSha: 'b'.repeat(40), attributionScope: 'no_happier_checkpoint_overlap_observed' as const,
        branch: { ref: 'refs/heads/work', headSha: 'c'.repeat(40) } };
      const work = allocate({ contributions, evidence: [], branchEvidence: [witness] });
      let projectReads = 0;
      let identityReads = 0;
      // Instrument admitted data, leaving the real allocation and grouping path intact.
      const measured = new Map(contributions.map(row => [row.id, { ...row,
        get projectKey() { projectReads++; return row.projectKey; },
        get id() { identityReads++; return row.id; },
      }]));
      const input = { ...work, fixtureContributions: contributions.map(row => measured.get(row.id)!) };
      const summary = summarize(input, { metric: 'cost', costBasis: 'reported' });
      expect(summary.total).toBe(3 * contributions.length);
      expect(summary.projects).toHaveLength(projectCount);
      expect(summary.projects.find(row => row.projectKey === 'project-0')?.branches).toEqual(summary.branches);
      expect(summary.branches[0]?.amount).toBe(3);
      // One contribution pass, plus grouping and presentation of the actual branch rows.
      expect(projectReads).toBeLessThanOrEqual(2 * contributions.length + 3 * work.branchAllocations.length);
      return identityReads;
    };
    const identityReads = measure(40);
    // Money aggregation visits the real populations of several displayed totals. More Projects
    // partition those populations; they must not cause more full-inventory identity scans.
    expect(measure(80)).toBeLessThanOrEqual(identityReads);
  });
  it('retains measured token amounts beside unknown allocations without fabricating unknown-only zeroes', () => {
    const measured = contribution('known', 'session', 'turn-known');
    const unknown = { ...contribution('unknown', 'session', 'turn-unknown'),
      tokens: { input: null, output: null, reasoning: null, cacheRead: null, cacheWrite: null, total: null } };
    const summarizeRows = (rows: UsageWorkContribution[]) => summarize(
      allocate({ contributions: rows, evidence: [] }), { metric: 'tokens', costBasis: 'auto' });
    expect(summarizeRows([unknown]).total).toBeNull();
    expect(summarizeRows([unknown, measured]).total).toBe(14);
    expect(summarizeRows([unknown, measured]).sessions[0]?.amount).toBe(14);
  });

  it('aggregates complete whole-call populations with linear contribution work', () => {
    const measure = (count: number) => {
      const rows = Array.from({ length: count }, (_, index) => {
        const earlier = { ...contribution(`earlier-${index}`, 'session', `turn-${index}`),
          cost: { reportedUsd: 0, estimatedUsd: 1, currency: 'USD', costSource: 'pricing_estimate' as const,
            reportedTotalId: `final-${index}` } };
        const final = { ...contribution(`final-${index}`, 'session', null),
          tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          cost: { reportedUsd: 0.12, estimatedUsd: 0, currency: 'USD', costSource: 'provider_reported' as const,
            reportedTotalContributionIds: [earlier.id] } };
        return [earlier, final];
      }).flat();
      const work = allocate({ contributions: rows, evidence: [] });
      let costReads = 0;
      for (const row of work.fixtureContributions) {
        const cost = row.cost;
        Object.defineProperty(row, 'cost', { enumerable: true, get() { costReads++; return cost; } });
      }
      const summary = summarize(work, { metric: 'cost', costBasis: 'auto' });
      for (const amount of [summary.total, summary.unallocated, summary.projects[0]?.amount,
        summary.sessions[0]?.amount, summary.agents[0]?.amount]) expect(amount).toBeCloseTo(count * 0.12, 10);
      return costReads;
    };
    const small = measure(32);
    expect(measure(64), 'doubling the same grouped population must not rescan every prefix').toBeLessThanOrEqual(2 * small);
  });
  it('groups unnamed project identities once without changing allocation or money conservation', () => {
    const work = allocate({ contributions: [contribution('a', 's1', 't1', 'known'),
      contribution('b', 's1', 't2', 'opaque-a'), contribution('c', 's2', 't3', 'opaque-b')], evidence: [] });
    const summary = summarize(work, { metric: 'tokens', costBasis: 'auto' }, new Set(['known']));
    expect(summary.projects).toHaveLength(2);
    expect(summary.projects.find(row => row.projectKey === null)).toMatchObject({ amount: 28,
      unnamedProjectCount: 2, sessionIds: ['s1', 's2'] });
    expect(summary.total).toBe(42);
    expect(work.fixtureContributions.map(row => row.projectKey)).toEqual(['known', 'opaque-a', 'opaque-b']);
  });
  it('counts usage a grouped checkout was stamped with under the Project it belongs to now (owner 11-08)', () => {
    // "nldw6" joined "payments" after its Sessions were stamped with its own id.
    const work = allocate({ contributions: [contribution('a', 's1', 't1', 'payments'),
      contribution('b', 's2', 't2', 'nldw6')], evidence: [] });
    const anchorOf = (key: string) => key === 'nldw6' ? 'payments' : key;
    const summary = summarize(work, { metric: 'tokens', costBasis: 'auto' }, new Set(['payments']), anchorOf);
    expect(summary.projects.map(row => [row.projectKey, row.sessionIds])).toEqual([['payments', ['s1', 's2']]]);
    expect(summary.total).toBe(28);
  });
  it('selects a whole-call final for the complete Session without assigning it to an earlier PR turn', () => {
    const earlier: UsageWorkContribution = { ...contribution('earlier', 's1', 't1'), observedAtMs: 10,
      cost: { reportedUsd: 0, estimatedUsd: 1, currency: 'USD', costSource: 'pricing_estimate', reportedTotalId: 'final' } };
    const final: UsageWorkContribution = { ...contribution('final', 's1', null), observedAtMs: 20,
      modelId: null, tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      cost: { reportedUsd: 0.12, estimatedUsd: 0, currency: 'USD', costSource: 'provider_reported',
        reportedTotalContributionIds: ['earlier'] } };
    const work = allocate({ contributions: [earlier, final], evidence: [evidence('s1', 't1', 7)] });
    const basis = { metric: 'cost', costBasis: 'auto' } as const;
    const summary = summarize(work, basis);
    expect(summary.total).toBeCloseTo(0.12, 10);
    expect(summary.sessions[0]?.amount).toBeCloseTo(0.12, 10);
    expect(summary.projects[0]?.amount).toBeCloseTo(0.12, 10);
    expect(summary.outcomes[0]?.amount).toBeNull();
    const autopsy = summarizeSession(work, basis, 's1');
    expect(autopsy.costTimeline.map(row => row.amount)).toEqual([null, 0.12]);
    expect(autopsy.turns.map(row => row.amount)).toEqual([null, null]);
  });
  it("reads one row per turn: a turn's model calls add up, and a no-turn row with no usage is left out", () => {
    const none = { ...contribution('empty', 's1', null), tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
    const autopsy = summarizeSession(allocate({
      contributions: [contribution('a', 's1', 't1'), contribution('b', 's1', 't1'), none, contribution('c', 's1', 't2')],
      evidence: [],
    }), { metric: 'tokens', costBasis: 'auto' }, 's1');
    expect(autopsy.turns.map(turn => [turn.turnId, turn.amount])).toEqual([['t1', 28], ['t2', 14]]);
    expect(autopsy.costTimeline).toHaveLength(4);
  });
  it('plots only monetary partitions with witnessed outcome coordinates, including open outcomes at zero merged', () => {
    const unlinkedEuro = { ...contribution('unlinked', 'unlinked', 'u'),
      cost: { reportedUsd: 3, estimatedUsd: 4, currency: 'EUR' } };
    const summary = summarize(allocate({
      contributions: [contribution('linked', 'linked', 'l'), contribution('unlinked-dollar', 'unlinked-dollar', 'u2'), unlinkedEuro],
      evidence: [evidence('linked', 'l', 1, 'open')],
    }), { metric: 'cost', costBasis: 'reported' });
    expect(projectUsageSessionValuePlots(summary.sessions, 'cost').map(plot => plot.rows.map(row => row.sessionId)))
      .toEqual([['linked']]);
    expect(projectUsageSessionValuePlots(summarize(allocate({
      contributions: [unlinkedEuro], evidence: [],
    }), { metric: 'tokens', costBasis: 'auto' }).sessions, 'tokens')).toEqual([]);
  });
  it.each([
    { amounts: [10, 30], median: 20 },
    { amounts: [10, 50, 30], median: 30 },
    { amounts: [10, null, 30], median: 20 },
    { amounts: [30], median: null },
    { amounts: [null, null], median: null },
  ])('projects the median of comparable witnessed Session amounts $amounts', ({ amounts, median }) => {
    const summary = summarize(allocate({
      contributions: amounts.map((amount, index) => ({ ...contribution(`c${index}`, `s${index}`, `t${index}`),
        cost: { reportedUsd: amount, estimatedUsd: null, currency: 'USD' } })),
      evidence: amounts.map((_, index) => evidence(`s${index}`, `t${index}`, index + 1)),
    }), { metric: 'cost', costBasis: 'reported' });
    const plots = projectUsageSessionValuePlots(summary.sessions, 'cost');
    expect(plots.length === 0 ? null : plots[0]!.medianAmount).toBe(median);
  });
  it('expands a project, a PR and a branch into exact per-Session parts that add back to the row', () => {
    const bound = (id: string, sessionId: string, turnId: string, projectKey: string) => ({ ...contribution(id, sessionId, turnId, projectKey),
      providerId: 'provider.openrouter', providerConnectionId: 'connection' });
    const branchWitness = (sessionId: string, turnId: string, commitSha: string) => ({ sessionId, turnId, repositoryKey: 'repo',
      checkpointRef: `checkpoint/${sessionId}/${turnId}`, checkpointCommitSha: 'a'.repeat(40), commitSha,
      attributionScope: 'no_happier_checkpoint_overlap_observed' as const, branch: { ref: 'refs/heads/glass', headSha: 'c'.repeat(40) } });
    const summary = summarize(allocate({
      contributions: [bound('a', 's1', 't1', 'p1'), bound('b', 's1', 't2', 'p1'), contribution('c', 's2', 't3', 'p1'), contribution('d', 's2', 't4', 'p2')],
      evidence: [evidence('s1', 't1', 1), evidence('s2', 't3', 1)],
      branchEvidence: [branchWitness('s1', 't1', 'd'.repeat(40)), branchWitness('s1', 't2', 'e'.repeat(40)), branchWitness('s2', 't4', 'd'.repeat(40))],
    }), { metric: 'cost', costBasis: 'reported' });
    const project = summary.projects.find(row => row.projectKey === 'p1')!;
    expect(project.sessions).toMatchObject([{ sessionId: 's1', amount: 6 }, { sessionId: 's2', amount: 3 }]);
    expect(project.sessions.reduce((sum, row) => sum + known(row.amount), 0)).toBe(project.amount);
    // The branch part of a project counts only that project's witnessed contributions.
    expect(project.branches).toMatchObject([{ amount: 6, sessions: [{ sessionId: 's1', amount: 6 }],
      commits: ['d'.repeat(40), 'e'.repeat(40)] }]);
    const branch = summary.branches[0]!;
    expect(summary.agents).toMatchObject([{ agentId: 'claude', amount: 12 }]);
    expect(branch).toMatchObject({ amount: 9, perSession: 4.5, projectKeys: ['p1', 'p2'], agentIds: ['claude'],
      providers: [{ providerId: 'provider.openrouter', machineId: 'machine' }] });
    expect(branch.sessions).toMatchObject([{ sessionId: 's1', amount: 6 }, { sessionId: 's2', amount: 3 }]);
    const outcome = summary.outcomes[0]!;
    expect(outcome.sessions).toMatchObject([{ sessionId: 's1', amount: 3 }, { sessionId: 's2', amount: 3 }]);
    expect(outcome.sessions.reduce((sum, row) => sum + known(row.amount), 0)).toBe(outcome.amount);
    expect(outcome).toMatchObject({ providers: [{ providerId: 'provider.openrouter', machineId: 'machine' }] });
  });
  it('reads one Session as its turns in witnessed order, each with its own exact amount and evidence', () => {
    const at = (row: UsageWorkContribution, observedAtMs: number) => ({ ...row, observedAtMs });
    const work = allocate({
      contributions: [at(contribution('late', 's1', 't2'), 30), at(contribution('early', 's1', 't1'), 10),
        at(contribution('loose', 's1', null), 20), at(contribution('other', 's2', 't9'), 5)],
      evidence: [evidence('s1', 't1', 7)],
      branchEvidence: [{ sessionId: 's1', turnId: 't2', repositoryKey: 'repo', checkpointRef: 'checkpoint/s1/t2', checkpointCommitSha: 'a'.repeat(40),
        commitSha: 'f'.repeat(40), attributionScope: 'no_happier_checkpoint_overlap_observed', branch: { ref: 'refs/heads/glass', headSha: 'c'.repeat(40) } }],
    });
    const autopsy = summarizeSession(work, { metric: 'cost', costBasis: 'reported' }, 's1');
    expect(autopsy.turns.map(turn => [turn.contributionId, turn.turnId, turn.amount, turn.reason])).toEqual([
      ['early', 't1', 3, 'allocated'], ['loose', null, 3, 'missing_turn'], ['late', 't2', 3, 'missing_evidence']]);
    expect(autopsy.turns[0]).toMatchObject({ checkpoints: ['checkpoint/s1/t1'], commits: ['b'.repeat(40)], branches: [],
      outcome: expect.objectContaining({ pullRequest: expect.objectContaining({ number: 7 }) }) });
    expect(autopsy.turns[2]).toMatchObject({ checkpoints: ['checkpoint/s1/t2'], commits: ['f'.repeat(40)], branches: ['refs/heads/glass'], outcome: null });
    expect(autopsy.costTimelineBasis).toEqual({ kind: 'reported', currency: 'USD' });
    expect(autopsy.costTimeline).toEqual([
      { id: 'early', observedAtMs: 10, amount: 3 },
      { id: 'loose', observedAtMs: 20, amount: 6 },
      { id: 'late', observedAtMs: 30, amount: 9 },
    ]);
    expect(autopsy.outcomes.map(row => row.pullRequest.number)).toEqual([7]);
    expect(summarizeSession(work, { metric: 'cost', costBasis: 'reported' }, 'missing').turns).toEqual([]);
  });
  it('retains the known cumulative cost beside unpriced contributions and preserves witnessed zero', () => {
    const zero = { ...contribution('zero', 's1', 't1'), observedAtMs: 10, cost: { reportedUsd: 0, estimatedUsd: 0, currency: 'USD', costSource: 'provider_reported' as const } };
    const unknown = { ...contribution('unknown', 's1', 't2'), observedAtMs: 20, cost: { reportedUsd: 0, estimatedUsd: 0, currency: 'USD', costSource: 'none' as const } };
    const later = { ...contribution('later', 's1', 't3'), observedAtMs: 30 };
    const work = allocate({ contributions: [later, zero, unknown], evidence: [] });
    expect(summarizeSession(work, { metric: 'tokens', costBasis: 'reported' }, 's1').costTimeline)
      .toEqual([{ id: 'zero', observedAtMs: 10, amount: 0 }, { id: 'unknown', observedAtMs: 20, amount: 0 },
        { id: 'later', observedAtMs: 30, amount: 3 }]);
  });
  it('labels best available mixed kinds and never combines different currencies in a cost curve', () => {
    const first = { ...contribution('first', 's1', 't1'), observedAtMs: 10 };
    for (const cost of [{ reportedUsd: 0, estimatedUsd: 4, currency: 'USD', costSource: 'pricing_estimate' as const },
      { reportedUsd: 3, estimatedUsd: 4, currency: 'EUR' }]) {
      const work = allocate({ contributions: [first, { ...contribution('other', 's1', 't2'), observedAtMs: 20, cost }], evidence: [] });
      const expected = cost.currency === 'USD' ? 7 : null;
      expect(summarizeSession(work, { metric: 'cost', costBasis: 'auto' }, 's1').costTimeline)
        .toEqual([{ id: 'first', observedAtMs: 10, amount: 3 }, { id: 'other', observedAtMs: 20, amount: expected }]);
      const summary = summarize(work, { metric: 'cost', costBasis: 'auto' });
      expect([summary.total, summary.unallocated, summary.projects[0]?.amount, summary.sessions[0]?.amount,
        summary.agents[0]?.amount, summary.unallocatedByReason.missing_evidence]).toEqual(Array(6).fill(expected));
      if (expected !== null) {
        expect(summary.moneyBasis).toEqual({ kind: 'mixed', currency: 'USD' });
        expect(summarizeSession(work, { metric: 'cost', costBasis: 'auto' }, 's1').costTimelineBasis).toEqual(summary.moneyBasis);
      }
      expect(summarize(work, { metric: 'tokens', costBasis: 'auto' }).total).toBe(28);
    }
  });
  it('retains each independently known group monetary basis when the whole is mixed', () => {
    const euro = { ...contribution('euro', 'eur-session', 'eur-turn', 'eur-project'),
      cost: { reportedUsd: 3, estimatedUsd: 4, currency: 'EUR' } };
    const dollars = { ...contribution('dollars', 'usd-session', 'usd-turn', 'usd-project'),
      cost: { reportedUsd: 0, estimatedUsd: 4, currency: 'USD', costSource: 'pricing_estimate' as const } };
    const summary = summarize(allocate({ contributions: [euro, dollars], evidence: [] }),
      { metric: 'cost', costBasis: 'auto' });
    expect(summary.total).toBeNull();
    expect(summary.sessions.find(row => row.sessionId === 'eur-session')).toMatchObject({ amount: 3,
      moneyBasis: { kind: 'reported', currency: 'EUR' } });
    expect(summary.projects.find(row => row.projectKey === 'usd-project')).toMatchObject({ amount: 4,
      moneyBasis: { kind: 'estimated', currency: 'USD' } });
    expect(summary.projects.find(row => row.projectKey === 'eur-project')?.sessions[0]).toMatchObject({
      amount: 3, moneyBasis: { kind: 'reported', currency: 'EUR' } });
  });
  it('carries named retained comparisons once and uses Git times without substituting accounting time', () => {
    const branch = { ref: 'refs/heads/proof', headSha: 'c'.repeat(40) };
    const comparison = { targetSha: branch.headSha, method: 'changed_file_tree_comparison' as const,
      status: 'partial' as const, addedLines: 7, removedLines: 2 };
    const witness = { ...evidence('s1', 't1', 9), repositoryKey: 'hosted-repo', branchRepositoryKey: 'repo',
      branches: [branch], committedAtMs: 600, checkpointCommittedAtMs: 500,
      retainedChange: comparison };
    const branchWitness = { ...witness, repositoryKey: 'repo', branch };
    const work = allocate({ contributions: [contribution('a', 's1', 't1'), contribution('b', 's1', 't1')],
      evidence: [witness], branchEvidence: [branchWitness] });
    const autopsy = summarizeSession(work, { metric: 'cost', costBasis: 'reported' }, 's1');
    expect(autopsy.turns[0]).toMatchObject({ modelId: 'model', machineId: 'machine',
      moments: [{ kind: 'checkpoint', sha: 'a'.repeat(40), atMs: 500 }, { kind: 'commit', sha: 'b'.repeat(40), atMs: 600 }],
      retainedChanges: [{ commitSha: 'b'.repeat(40), ...comparison }] });
    const summary = summarize(work, { metric: 'cost', costBasis: 'reported' });
    expect(summary.branches[0]).toMatchObject({ retainedChanges: [{ commitSha: 'b'.repeat(40), ...comparison }],
      linkedPullRequests: [expect.objectContaining({ number: 9 })] });
    const old = summarizeSession(allocate({ contributions: [contribution('old', 's1', 't1')],
      evidence: [evidence('s1', 't1', 9)] }), { metric: 'cost', costBasis: 'reported' }, 's1');
    expect(old.turns[0]?.moments).toEqual([]);
    for (const mismatch of [{ ...branch, headSha: 'd'.repeat(40) }, branch]) {
      const mismatchWitness = { ...witness, branches: [mismatch],
        branchRepositoryKey: mismatch.headSha === branch.headSha ? 'another-repo' : witness.branchRepositoryKey };
      const unrelated = allocate({ contributions: [contribution('a', 's1', 't1')],
        evidence: [mismatchWitness], branchEvidence: [branchWitness] });
      expect(summarize(unrelated, { metric: 'cost', costBasis: 'reported' }).branches[0]?.linkedPullRequests).toEqual([]);
    }
  });
  it('groups a standalone branch only from canonical branch allocations and retains the actual Provider binding', () => {
    const bound = { ...contribution('branch', 's1', 't1'), providerId: 'provider.openrouter', providerConnectionId: 'connection', agentId: 'claude' };
    const witness = { sessionId: 's1', turnId: 't1', repositoryKey: 'opaque-repo', checkpointRef: 'checkpoint/s1/t1',
      checkpointCommitSha: 'a'.repeat(40), commitSha: 'b'.repeat(40), attributionScope: 'no_happier_checkpoint_overlap_observed' as const,
      branch: { ref: 'refs/heads/standalone', headSha: 'c'.repeat(40) } };
    const summary = summarize(allocate({ contributions: [bound], evidence: [], branchEvidence: [witness] }), { metric: 'cost', costBasis: 'reported' });
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
    const summary = summarize(allocate({ contributions: [unknown, free, known, partlyPriced], evidence: [] }), { metric: 'cost', costBasis: 'reported' });
    expect(summary.total).toBe(3);
    expect(summary.sessions.find(row => row.sessionId === 'unpriced')?.amount).toBeNull();
    expect(summary.sessions.find(row => row.sessionId === 'partial')?.amount).toBe(3);
    expect(summary.sessions.find(row => row.sessionId === 'free')?.amount).toBe(0);
    expect(summary.unallocatedByReason.missing_evidence).toBe(3);
    const independent = summarize(allocate({ contributions: [unknown, known],
      evidence: [evidence('unpriced', 't1', 1)] }), { metric: 'cost', costBasis: 'reported' });
    expect(independent.allocated).toBeNull();
    expect(independent.unallocated).toBe(3);
    expect(summarize(allocate({ contributions: [unknown, free, known, partlyPriced], evidence: [] }), { metric: 'tokens', costBasis: 'reported' }).total).toBe(56);
  });
  it('keeps allocated plus every unallocated reason equal to the admitted total, per metric and cost basis', () => {
    // s1 links two turns to two PRs; s2 links one turn to two PRs (ambiguous); s3 has no evidence; one row has no turn.
    const work = allocate({
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
      const summary = summarize(work, basis);
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
    const summary = summarize(work, {
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
