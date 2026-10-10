import { describe, expect, it } from 'vitest';
import { normalizeUsageQuery } from '../inputs/usageQuery.js';
import { UsageAnalyticsQueryResponseSchema } from './usageAnalyticsContracts.js';
import { resolveUsagePageAggregation, UsageQueryBatchResultSchema } from './resolveUsagePageAggregation.js';
import type { UsageWorkEvidence } from './usageOutcomeAllocation.js';

const tokens = { input: 12, output: 4, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 16 };
const accounting = UsageAnalyticsQueryResponseSchema.parse({
  v: 1, totals: { eventCount: 1, tokens, cost: { reportedUsd: 0.02, estimatedUsd: 0, currency: 'USD' } },
});

describe('resolveUsagePageAggregation', () => {
  it('re-prices historical API-equivalent facts through Account overrides without changing vendor reports', () => {
    const query = normalizeUsageQuery({ period: { startMs: 100, endMs: 200 } });
    const historicalTokens = { input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, total: 1_000_000 };
    const cost = { reportedUsd: 4, estimatedUsd: 1.75, currency: 'USD', costSource: 'provider_reported' };
    const value = UsageAnalyticsQueryResponseSchema.parse({ v: 1, totals: { eventCount: 1, tokens: historicalTokens, cost },
      contributions: [{ id: 'history', observedAtMs: 150, sessionId: 's', turnId: 't', agentId: 'codex', modelId: 'gpt-5.2',
        machineId: null, projectKey: null, workspaceId: null, source: 'runtime', tokens: historicalTokens, tokenCategories: historicalTokens, cost }],
      costFacts: [{ kind: 'reported', amountUsd: 4, currency: 'USD', source: 'provider_reported', tokens: historicalTokens,
        eventCount: 1, asOfMs: 150, complete: false }],
    });
    const result = resolveUsagePageAggregation({ queries: [query], accounting: [{ query, value, status: 'available' }],
      pricingOverrides: { 'gpt-5.2': { kind: 'rates', inputUsdPerMillion: 9, outputUsdPerMillion: 1 } },
    });
    expect(result.results[0]!.costFactTotals?.find(fact => fact.kind === 'api_equivalent')?.amountUsd).toBe(9);
    expect(result.results[0]!.accounting!.totals.cost.reportedUsd).toBe(4);
    expect(result.results[0]!.accounting!.contributions![0]!.cost.estimatedUsd).toBe(1.75);
    expect(result.results[0]!.costFactTotals?.find(fact => fact.kind === 'reported')?.amountUsd).toBe(4);
    const retained = resolveUsagePageAggregation({ queries: [query], previous: result,
      accounting: [{ query, status: 'error', errorCode: 'network_error' }],
      pricingOverrides: { 'gpt-5.2': { kind: 'rates', inputUsdPerMillion: 13, outputUsdPerMillion: 1 } } });
    expect(retained.results[0]!.costFactTotals?.find(fact => fact.kind === 'api_equivalent')?.amountUsd).toBe(13);
  });
  it('offers a query-bound recurring digest recipe without choosing or creating its Automation', () => {
    const query = normalizeUsageQuery({ period: { startMs: 100, endMs: 200 }, machines: ['selected-machine'], costBasis: 'reported' });
    const result = resolveUsagePageAggregation({ queries: [query],
      accounting: [{ query, value: accounting, status: 'available', asOfMs: 200 }] });
    const coach = result.results[0]!.coach!;
    expect(coach).toHaveProperty('digestSuggestion', {
      kind: 'recurring_automation', queryKey: result.results[0]!.key, lookbackMs: 100,
      query, actionId: 'workflow.trigger.add', requiredInputs: ['project', 'trigger'],
      target: { kind: 'inline', definition: expect.objectContaining({
        blocks: expect.arrayContaining([
          expect.objectContaining({ kind: 'step', id: 'digest' }),
          expect.objectContaining({ kind: 'action', actionId: 'notifications.notify_me' }),
        ]),
      }) },
    });
    expect(coach.digestSuggestion).not.toHaveProperty('project');
    expect(coach.digestSuggestion).not.toHaveProperty('trigger');
    expect(UsageQueryBatchResultSchema.safeParse(result).success).toBe(true);
    const emptyPeriod = normalizeUsageQuery({ ...query, period: { startMs: 100, endMs: 100 } });
    expect(resolveUsagePageAggregation({ queries: [emptyPeriod] }).results[0]!.coach).not.toHaveProperty('digestSuggestion');
  });
  it('keeps conservative witnessed accounting freshness and never substitutes an unavailable source or the clock', () => {
    const value = UsageAnalyticsQueryResponseSchema.parse({ ...accounting, coverage: { status: 'partial', reasons: [],
      sources: [{ source: 'a', path: 'native', status: 'available', asOfMs: 180, eventCount: 1 },
        { source: 'b', path: 'runtime', status: 'partial', asOfMs: 160, eventCount: 1 },
        { source: 'c', path: 'unknown', status: 'unsupported', asOfMs: 1, eventCount: 0 }],
      missingDimensions: [], range: { complete: false }, ranked: [] } });
    const query = normalizeUsageQuery({ period: { startMs: 100, endMs: 200 } });
    const slice = resolveUsagePageAggregation({ queries: [query], accounting: [{ query, value, status: 'available' }] }).results[0]!;
    expect(slice.coach).toMatchObject({ asOfMs: 160, currentness: 'current' });
    expect(slice.sources.find(row => row.source === 'accounting')?.asOfMs).toBe(160);
    const unknown = resolveUsagePageAggregation({ queries: [query], accounting: [{ query, value: accounting, status: 'available' }] }).results[0]!;
    expect(unknown.coach).toMatchObject({ asOfMs: null, currentness: 'unknown' });
  });
  it('totals each monetary kind and denomination with all contributing source provenance', () => {
    const query = normalizeUsageQuery({ period: { startMs: 100, endMs: 200 } });
    const fact = { kind: 'reported' as const, currency: 'USD', amountUsd: 2, tokens, eventCount: 1, asOfMs: 180, complete: true };
    const value = UsageAnalyticsQueryResponseSchema.parse({ ...accounting, costFacts: [
      { ...fact, source: 'native:a' }, { ...fact, source: 'runtime:b', amountUsd: 3, asOfMs: 150, complete: false },
      { ...fact, source: 'native:a', currency: 'EUR', amountUsd: 4 },
      { ...fact, source: 'invoice', kind: 'invoice', amountUsd: 10 },
      { ...fact, source: 'unknown', kind: 'unpriced', amountUsd: null },
    ] });
    const result = resolveUsagePageAggregation({ queries: [query], accounting: [{ query, value, status: 'available' }] });
    expect(result.results[0]).toHaveProperty('costFactTotals', [
      { ...fact, amountUsd: 5, tokens: { input: 24, output: 8, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 32 }, eventCount: 2, asOfMs: 150, complete: false, sources: ['native:a', 'runtime:b'] },
      { ...fact, currency: 'EUR', amountUsd: 4, sources: ['native:a'] },
      { ...fact, kind: 'invoice', amountUsd: 10, sources: ['invoice'] },
      { ...fact, kind: 'unpriced', amountUsd: null, sources: ['unknown'] },
    ]);
    const slice = result.results[0]!;
    expect(UsageQueryBatchResultSchema.safeParse({ ...result, results: [{ ...slice, accounting: undefined }] }).success).toBe(false);
    expect(UsageQueryBatchResultSchema.safeParse({ ...result, results: [{ ...slice,
      costFactTotals: slice.costFactTotals?.map(total => ({ ...total, sources: ['fictional'] })),
    }] }).success).toBe(false);
  });
  it('carries overlapping qualified pools separately from unique quota accounting and withdraws denied selector evidence', () => {
    const query = normalizeUsageQuery({ machines: ['selected-machine'] });
    const service = { pluginId: 'happier.agent.codex', localId: 'openai-codex' };
    const selected = { profileId: 'work', priority: 1, createdAtMs: 1, enabled: true, leastLimitedScore: 80 };
    const group = { service, groupId: 'primary' };
    const value = { group, observedAtMs: 100, selection: { selected, reason: 'selected' as const, excluded: [],
      decisionTrace: { activeProfileId: 'work', reason: 'selected' as const, strategy: 'priority' as const,
        selectionBasis: 'active_stickiness' as const, sticky: true, orderedEligibleCandidates: [selected], candidates: [] } } };
    const pools = [
      { group, memberAccountIds: ['work', 'personal'], activeAccountId: 'work',
        selection: { status: 'available' as const, machineId: 'selected-machine', value, asOfMs: 100 } },
      { group: { service, groupId: 'secondary' }, memberAccountIds: ['work'], activeAccountId: null,
        selection: { status: 'error' as const, errorCode: 'permission_denied', value } },
    ];
    const result = resolveUsagePageAggregation({ queries: [query], pools: [{ query, value: pools }] });
    expect(result.results[0]).toMatchObject({ pools: [pools[0], {
      group: pools[1]!.group, memberAccountIds: ['work'], activeAccountId: null,
      selection: { status: 'error', errorCode: 'permission_denied' },
    }] });
    expect(UsageQueryBatchResultSchema.safeParse(result).success).toBe(true);
    expect(UsageQueryBatchResultSchema.safeParse({ ...result, results: [{ ...result.results[0], pools: [pools[1]] }] }).success).toBe(false);
  });
  it('publishes all Coach evidence states on the same admitted query rather than a separate detector read', () => {
    const query = normalizeUsageQuery({ period: { startMs: 100, endMs: 200 } });
    const result = resolveUsagePageAggregation({ queries: [query],
      accounting: [{ query, value: accounting, status: 'available', asOfMs: 200 }] });
    expect(result).toMatchObject({ results: [{ coach: {
      period: { startMs: 100, endMs: 200 },
      evaluations: expect.arrayContaining([
        expect.objectContaining({ detectorId: 'duplicated_instructions', status: 'insufficient_evidence' }),
        expect.objectContaining({ detectorId: 'cache_busting_prompt_changes', status: 'insufficient_evidence' }),
      ]),
    } }] });
    const unavailable = resolveUsagePageAggregation({ queries: [query] });
    expect(unavailable.results[0]?.coach).toMatchObject({ asOfMs: null, currentness: 'unknown', findings: [] });
    expect(unavailable.results[0]?.coach?.evaluations).toHaveLength(11);
  });
  it('uses witnessed private approval pairs only on their admitted Coach query', () => {
    const query = normalizeUsageQuery({ session: 'session', period: { startMs: 100, endMs: 200 } });
    const other = normalizeUsageQuery({ ...query, session: 'other' });
    const detail = { status: 'partial' as const, facts: [], acceptedInputs: [], permissions: [{
      requestId: 'request', workId: JSON.stringify(['session', 'turn']), requestedAtMs: 120,
      decidedAtMs: 160, toolId: 'Bash', answeringClientCategory: null,
    }] };
    const result = resolveUsagePageAggregation({ queries: [query, other], howYouWork: [{ query, detail, asOfMs: 200 }] });
    expect(result.results[0]).toHaveProperty('coach.findings', expect.arrayContaining([
      expect.objectContaining({ detectorId: 'approval_friction', coverage: 'partial',
        measurements: expect.arrayContaining([{ metric: 'permission_wait', value: 40, unit: 'milliseconds' }]) }),
    ]));
    expect(result.results[1]).toHaveProperty('coach.findings', []);
    const pending = resolveUsagePageAggregation({ queries: [query, other], previous: result,
      sources: [{ source: 'how_you_work', status: 'pending' }],
      accounting: [{ query, value: accounting, status: 'available', asOfMs: 210 }] });
    expect(pending.results[0]?.coach).toMatchObject({ currentness: 'stale', findings: [
      expect.objectContaining({ detectorId: 'approval_friction', currentness: 'stale', remedy: null, action: null }),
    ] });
    expect(pending.results[1]).toHaveProperty('coach.findings', []);
    expect(UsageQueryBatchResultSchema.safeParse(pending).success).toBe(true);
    const denied = resolveUsagePageAggregation({ queries: [query], howYouWork: [{ query,
      detail: { ...detail, status: 'unknown' }, asOfMs: 200 }], previous: result });
    expect(denied.results[0]).toHaveProperty('coach.findings', []);
    expect(UsageQueryBatchResultSchema.safeParse({ ...result, results: [{ ...result.results[0],
      sources: [{ source: 'how_you_work', status: 'unknown' }] }] }).success).toBe(false);
  });
  it('retains an open-query finding identity when only its observation clock advances', () => {
    const query = normalizeUsageQuery({ session: 'session', period: { startMs: 100 } });
    const detail = { status: 'partial' as const, facts: [], acceptedInputs: [], permissions: [{
      requestId: 'request', workId: JSON.stringify(['session', 'turn']), requestedAtMs: 120,
      decidedAtMs: 160, toolId: 'Bash', answeringClientCategory: null,
    }] };
    const read = (asOfMs: number, decidedAtMs = 160) => resolveUsagePageAggregation({ queries: [query],
      howYouWork: [{ query, detail: { ...detail, permissions: [{ ...detail.permissions[0]!, decidedAtMs }] }, asOfMs }] });
    const first = read(200).results[0]!.coach!.findings.find(row => row.detectorId === 'approval_friction')!;
    const refreshed = read(201).results[0]!.coach!.findings.find(row => row.detectorId === 'approval_friction')!;
    expect(first).toBeDefined();
    expect(refreshed).toMatchObject({ evidenceKey: first.evidenceKey, asOfMs: 201, period: { startMs: 100, endMs: 201 } });
    const changed = read(201, 170).results[0]!.coach!.findings.find(row => row.detectorId === 'approval_friction')!;
    expect(changed.evidenceKey).not.toBe(first.evidenceKey);
  });
  it('keeps opened allowance facts separate from accounting totals', () => {
    const query = normalizeUsageQuery({});
    const allowance = { source: { bindingKind: 'account' as const, ref: {
      service: { pluginId: 'test.provider', localId: 'account' }, accountId: 'personal',
    } }, current: null, pace: [], targets: [], waitingWork: { status: 'unavailable' as const, reason: 'read_failed' as const } };
    const result = resolveUsagePageAggregation({ queries: [query], accounting: [{ query, value: accounting, status: 'available' }],
      quota: { status: 'available', value: [allowance] } });
    expect(result.results[0]?.quota).toEqual([allowance]);
    expect(result.results[0]?.accounting?.totals).toEqual(accounting.totals);
    expect(UsageQueryBatchResultSchema.safeParse({ ...result, results: [{ ...result.results[0],
      sources: [{ source: 'quota', status: 'error', errorCode: 'denied' }] }] }).success).toBe(false);
  });
  it('retains exact-query authorized facts on refresh failure without retaining denied or changed-scope facts', () => {
    const query = normalizeUsageQuery({ agents: ['a'] });
    const other = normalizeUsageQuery({ agents: ['b'] });
    const previous = resolveUsagePageAggregation({ queries: [query], accounting: [{ query, value: accounting, status: 'available' }] });
    const refreshed = resolveUsagePageAggregation({ queries: [query, other], previous,
      accounting: [{ query, status: 'error', errorCode: 'usage_analytics_query_failed' }, { query: other, status: 'error' }] });
    expect(refreshed.results[0]?.accounting).toEqual(accounting);
    expect(refreshed.results[0]?.sources).toContainEqual({ source: 'accounting', status: 'error', errorCode: 'usage_analytics_query_failed' });
    expect(refreshed.results[1]?.accounting).toBeUndefined();
    for (const errorCode of ['denied', 'permission_denied']) {
      const denied = resolveUsagePageAggregation({ queries: [query], previous, accounting: [{ query, status: 'error', errorCode }] });
      expect(denied.results[0]?.accounting).toBeUndefined();
    }
  });
  it('projects producer progress only into the slice that observed it', () => {
    const query = normalizeUsageQuery({ agents: ['a'] });
    const other = normalizeUsageQuery({ agents: ['b'] });
    const value = UsageAnalyticsQueryResponseSchema.parse({ ...accounting, coverage: {
      status: 'partial', reasons: ['incomplete_history'], missingDimensions: [], range: { complete: false }, ranked: [],
      sources: [{ source: 'native:capture', path: 'native', status: 'pending', eventCount: 1, asOfMs: 200 }],
    } });
    const result = resolveUsagePageAggregation({ queries: [query, other], accounting: [{ query, value, status: 'available' }] });
    expect(result.results[0]?.sources).toContainEqual({ source: 'native:capture', status: 'pending', asOfMs: 200 });
    expect(result.results[1]?.sources.some(source => source.source === 'native:capture')).toBe(false);
  });
  it('retains exact preceding-period facts on ordinary comparison refresh failure', () => {
    const query = normalizeUsageQuery({ period: { startMs: 100, endMs: 200 } });
    const comparison = normalizeUsageQuery({ ...query, period: { startMs: 0, endMs: 100 } });
    const previous = resolveUsagePageAggregation({ queries: [query], accounting: [
      { query, value: accounting, status: 'available' }, { query: comparison, value: accounting, status: 'available', asOfMs: 100 },
    ] });
    const result = resolveUsagePageAggregation({ queries: [query], previous, accounting: [
      { query, value: accounting, status: 'available' }, { query: comparison, status: 'error', errorCode: 'usage_query_failed' },
    ] });
    expect(result.results[0]?.comparison).toMatchObject({ accounting, source: { status: 'error', asOfMs: 100 } });
    const denied = resolveUsagePageAggregation({ queries: [query], previous, accounting: [
      { query, value: accounting, status: 'available' }, { query: comparison, status: 'error', errorCode: 'permission_denied' },
    ] });
    expect(denied.results[0]?.accounting).toEqual(accounting);
    expect(denied.results[0]?.comparison?.accounting).toBeUndefined();
  });
  it('exposes private witnessed work only on its exact admitted query slice', () => {
    const query = normalizeUsageQuery({ period: { startMs: 100, endMs: 200 } });
    const other = normalizeUsageQuery({ period: { startMs: 0, endMs: 100 } });
    const result = resolveUsagePageAggregation({ queries: [query, other], howYouWork: [{ query, detail: {
      status: 'partial', facts: [{ workId: 't', evidenceId: 't', kind: 'busy', agentId: null, machineId: null, startMs: 100, endMs: 180 }],
      permissions: [], acceptedInputs: [],
    } }] });
    expect(result.results[0]?.howYouWork).toMatchObject({ detailStatus: 'partial', intervals: { elapsedBusyMs: 80 } });
    expect(result.results[1]?.howYouWork).toMatchObject({ detailStatus: 'unknown', intervals: null });
    const pending = resolveUsagePageAggregation({ queries: [query], previous: result,
      sources: [{ source: 'how_you_work', status: 'pending' }] });
    expect(pending.results[0]?.howYouWork).toEqual(result.results[0]?.howYouWork);
    expect(pending.results[0]?.coach?.currentness).not.toBe('current');
    const unavailable = resolveUsagePageAggregation({ queries: [query], previous: result,
      howYouWork: [{ query, detail: { status: 'unknown' } }] });
    expect(unavailable.results[0]?.howYouWork?.intervals).toBeNull();
  });
  it('composes Work only from the exact admitted accounting query and witnessed turns', () => {
    const query = normalizeUsageQuery({ session: 'session', period: { startMs: 100, endMs: 200 } });
    const other = normalizeUsageQuery({ ...query, agents: ['other'] });
    const contribution = { id: 'cost', observedAtMs: 150, sessionId: 'session', turnId: 'turn', agentId: null,
      modelId: null, machineId: null, projectKey: null, workspaceId: null, source: null, tokens,
      cost: { reportedUsd: 0.02, estimatedUsd: 0, currency: 'USD' } };
    const value = UsageAnalyticsQueryResponseSchema.parse({ ...accounting, contributions: [contribution] });
    const witness: UsageWorkEvidence = { sessionId: 'session', turnId: 'turn', repositoryKey: 'repo',
      checkpointRef: 'checkpoint', checkpointCommitSha: 'a'.repeat(40), commitSha: 'b'.repeat(40),
      attributionScope: 'no_happier_checkpoint_overlap_observed', pullRequest: {
        provider: { id: 'forge', kind: 'github', displayName: 'Forge', baseUrl: 'https://github.com',
          nameWithOwner: 'owner/repo', urlSafety: { allowedSchemes: ['https:'] } },
        number: 1, title: 'Work', url: 'https://github.com/owner/repo/pull/1', baseBranch: 'main', headBranch: 'feature', state: 'open',
      } };
    const result = resolveUsagePageAggregation({ queries: [query, other], accounting: [{ query, value, status: 'available' }],
      work: [{ query, status: 'partial', evidence: [witness] }] });
    expect(result.results[0]?.work?.allocations).toMatchObject([{ contribution, reason: 'allocated', outcome: { repositoryKey: 'repo' } }]);
    expect(result.results[0]?.sources).toContainEqual({ source: 'work', status: 'partial' });
    expect(result.results[1]?.work).toBeUndefined();
    expect(UsageQueryBatchResultSchema.safeParse(result).success).toBe(true);
    const pending = resolveUsagePageAggregation({ queries: [query], accounting: [{ query, value, status: 'available' }],
      work: [{ query, status: 'pending' }], previous: result });
    expect(pending.results[0]?.work).toEqual(result.results[0]?.work);
    const changedValue = UsageAnalyticsQueryResponseSchema.parse({ ...value, contributions: [{ ...contribution, tokens: { ...tokens, input: 14, total: 18 } }] });
    const changed = resolveUsagePageAggregation({ queries: [query], accounting: [{ query, value: changedValue, status: 'available' }],
      work: [{ query, status: 'pending' }], previous: result });
    expect(changed.results[0]?.work?.allocations[0]).toMatchObject({ contribution: { tokens: { input: 14, total: 18 } }, reason: 'allocated' });
    const revoked = resolveUsagePageAggregation({ queries: [query], accounting: [{ query, value, status: 'available' }],
      work: [{ query, status: 'error', errorCode: 'unauthorized', evidence: [witness] }], previous: result });
    expect(revoked.results[0]?.work?.allocations).toMatchObject([{ contribution, reason: 'missing_evidence', outcome: null, evidence: [] }]);
    expect(revoked.results[0]?.work?.outcomes).toEqual([]);
    expect(revoked.results[0]?.sources).toContainEqual({ source: 'work', status: 'error', errorCode: 'unauthorized' });
    expect(UsageQueryBatchResultSchema.safeParse({ ...result, results: [{ ...result.results[0], accounting }] }).success).toBe(false);
    expect(UsageQueryBatchResultSchema.safeParse({ ...result, results: [{ ...result.results[0],
      sources: [{ source: 'work', status: 'unsupported' }] }] }).success).toBe(false);
    expect(UsageQueryBatchResultSchema.safeParse({ ...result, results: [{ ...result.results[0], work: {
      ...result.results[0]!.work, allocations: result.results[0]!.work!.allocations.map(row => ({ ...row, reason: 'missing_evidence' })),
    } }] }).success).toBe(false);
  });
  it('shares equivalent requests while keeping independently pinned requests separate', () => {
    const query = normalizeUsageQuery({ period: { startMs: 100, endMs: 200 }, agents: ['b', 'a'] });
    const equivalent = normalizeUsageQuery({ ...query, agents: ['a', 'b', 'a'] });
    const pinned = normalizeUsageQuery({ ...query, period: { startMs: 0, endMs: 100 } });
    const result = resolveUsagePageAggregation({ queries: [query, equivalent, pinned], accounting: [
      { query, status: 'available', value: accounting, asOfMs: 200 },
    ], quota: { status: 'pending' } });
    expect(result.results).toHaveLength(2);
    expect(result.results[0]?.accounting?.totals.tokens.total).toBe(16);
    expect(result.results[0]?.requestedQuery.period).toEqual({ startMs: 100, endMs: 200 });
    expect(result.results[1]?.accounting).toBeUndefined();
    expect(result.results[1]?.shownQuery.period).toEqual({ startMs: 0, endMs: 100 });
    expect(result.results.every(slice => slice.pending)).toBe(true);
    expect(UsageQueryBatchResultSchema.safeParse(result).success).toBe(true);
  });

  it('retains A facts without manufacturing zeros while quota and capture are pending', () => {
    const query = normalizeUsageQuery({});
    const result = resolveUsagePageAggregation({ queries: [query], accounting: [
      { query, status: 'available', value: accounting },
    ], quota: { status: 'not_loaded' }, sources: [{ source: 'native:capture', status: 'pending' }] });
    expect(result.results[0]?.accounting?.totals).toEqual(accounting.totals);
    expect(result.results[0]).not.toHaveProperty('quota');
    expect(result.results[0]?.sources).toEqual([
      { source: 'accounting', status: 'available' },
      { source: 'quota', status: 'not_loaded' },
      { source: 'work', status: 'not_loaded' },
      { source: 'native:capture', status: 'pending' },
    ]);
    expect(result.results[0]?.pending).toBe(true);
  });

  it('keeps unchanged slices referentially stable when another source advances', () => {
    const query = normalizeUsageQuery({ agents: ['a'] });
    const other = normalizeUsageQuery({ agents: ['b'] });
    const first = resolveUsagePageAggregation({ queries: [query, other], accounting: [
      { query, status: 'available', value: accounting },
    ] });
    const next = resolveUsagePageAggregation({ queries: [query, other], previous: first, accounting: [
      { query, status: 'available', value: accounting }, { query: other, status: 'available', value: accounting },
    ] });
    expect(next.results[0]).toBe(first.results[0]);
    expect(next.results[1]).not.toBe(first.results[1]);
    expect(next.results[1]?.accounting?.totals.tokens.total).toBe(16);
  });

  it('refuses mismatched shown-query identity and unavailable facts in the public result', () => {
    const query = normalizeUsageQuery({});
    const result = resolveUsagePageAggregation({ queries: [query] });
    expect(UsageQueryBatchResultSchema.safeParse({ ...result, results: [{ ...result.results[0], key: 'wrong' }] }).success).toBe(false);
    expect(UsageQueryBatchResultSchema.safeParse({ ...result, credentials: 'not query authority' }).success).toBe(false);
  });

  it('names and composes the exact preceding range without assigning those facts to the current period', () => {
    const query = normalizeUsageQuery({ period: { startMs: 100, endMs: 200 }, timeZoneOffsetMinutes: 120 });
    const previousPeriod = normalizeUsageQuery({ ...query, period: { startMs: 0, endMs: 100 } });
    const result = resolveUsagePageAggregation({ queries: [query], accounting: [
      { query, status: 'pending' }, { query: previousPeriod, status: 'available', value: accounting },
    ] });
    expect(result.results[0]).toMatchObject({
      requestedQuery: { period: { startMs: 100, endMs: 200 } },
      comparison: { query: { period: { startMs: 0, endMs: 100 }, timeZoneOffsetMinutes: 120 }, accounting },
    });
    expect(result.results[0]?.accounting).toBeUndefined();
  });
});
