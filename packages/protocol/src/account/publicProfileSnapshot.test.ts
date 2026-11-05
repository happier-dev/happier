import { describe, expect, it } from 'vitest';
import { buildPublicProfileSnapshot } from './publicProfileSnapshot.js';
import { PublicProfilePolicyV1Schema, PUBLIC_PROFILE_FIELDS_V1 } from './publicProfile.js';
import { PublicProfileRefreshBodyV1Schema } from './publicProfilePublication.js';
import { normalizeUsageQuery, usageQueryToAnalyticsRequest } from '../inputs/usageQuery.js';
import { projectUsageAnalyticsSummary } from '../usage/usageCost.js';
import { addUsageTokens, createEmptyUsageTokens } from '../usage/usageAggregation.js';
import { UsageAnalyticsQueryResponseSchema } from '../usage/usageAnalyticsContracts.js';
import { resolveUsagePageAggregation } from '../usage/resolveUsagePageAggregation.js';
import { projectUsageQueryWorkEvidence } from '../usage/usageWorkEvidence.js';
import type { UsageWorkEvidence } from '../usage/usageOutcomeAllocation.js';

const startMs = Date.parse('2026-10-18T00:00:00Z');
const endMs = startMs + 3 * 86_400_000;
const query = normalizeUsageQuery({ population: 'public_eligible_personal', period: { startMs, endMs }, includeActivity: true,
  includeQuotaHistory: false, includeTranscriptEvidence: false });
const policy = PublicProfilePolicyV1Schema.parse({ indexable: false, fields: Object.fromEntries(PUBLIC_PROFILE_FIELDS_V1.map(field => [field, true])) });
function result(evidence?: readonly UsageWorkEvidence[], complete = false, agents: readonly [string, string, string] = ['codex', 'claude', 'codex'], rowCount = 3) {
  const rows = Array.from({ length: rowCount }, (_, index) => {
    const day = index % 3;
    const eventCount = [1, 3, 1][day]!;
    return { id: `private-request-${index}`, observedAtMs: startMs + day * 86_400_000 + 100,
    sessionId: 'private-session', turnId: `private-turn-${day}`, agentId: agents[day]!, modelId: 'private-model',
    machineId: 'private-machine', projectKey: 'private-repository', workspaceId: null, source: 'private-source', eventCount,
    sourceContext: { path: 'runtime' as const, execution: day === 0 ? 'happier' as const : day === 1 ? 'outside' as const : 'unknown' as const },
    tokens: { input: eventCount * 8, output: eventCount * 2, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: eventCount * 10 },
    cost: { reportedUsd: 87654321, estimatedUsd: 98765432, currency: 'USD' } }; });
  const eventCount = rows.reduce((sum, row) => sum + row.eventCount, 0);
  const accounting = UsageAnalyticsQueryResponseSchema.parse({ v: 1, contributions: rows,
    totals: { eventCount, tokens: rows.reduce((sum, row) => addUsageTokens(sum, row.tokens), createEmptyUsageTokens()),
      cost: rows[0]!.cost }, activity: { calendarDays: [0, 1, 2].map(day => ({ date: `2026-10-${18 + day}`,
        eventCount: rows.filter((_, index) => index % 3 === day).reduce((sum, row) => sum + row.eventCount, 0) })) },
    coverage: { status: complete ? 'complete' : 'partial', reasons: complete ? [] : ['incomplete_history'], missingDimensions: [], ranked: [], range: { startMs, endMs, complete },
      sources: [{ source: 'private-source', path: 'runtime', status: 'available', machineId: 'private-machine', eventCount, asOfMs: endMs,
        captureKind: 'measured', historyComplete: complete }] },
  });
  const session = { id: 'private-session', metadata: { machineId: 'private-machine' }, agentState: null,
    sessionTurns: { v: 1 as const, sessionId: 'private-session', updatedAt: endMs, turns: rows.slice(0, 3).map((row, index) => ({
      turnId: row.turnId, agentId: row.agentId, status: 'completed' as const, startedAt: row.observedAtMs, terminalAt: row.observedAtMs + (index + 1) * 100,
      updatedAt: row.observedAtMs + (index + 1) * 100 })) } };
  const detail = projectUsageQueryWorkEvidence({ query, sessions: [session], contributions: accounting.contributions });
  return resolveUsagePageAggregation({ queries: [query], accounting: [{ query, status: 'available', asOfMs: endMs, value: accounting }],
    howYouWork: [{ query, asOfMs: endMs, detail }], ...(evidence ? { work: [{ query, evidence, status: 'available' as const, asOfMs: endMs }] } : {}) }).results[0]!;
}

describe('public-profile snapshot computation from canonical Usage', () => {
  it.each([false, true])('keeps bounded All artifact metadata while rich and compact calendars follow observations (relative %s)', relative => {
    const original = result();
    const selected = normalizeUsageQuery({ ...query, period: relative ? { relative: 'all' } : { endMs }, includeActivity: !relative });
    const accounting = { ...original.accounting!, coverage: { ...original.accounting!.coverage!,
      range: { startMs: 0, endMs, complete: false } } };
    const compact = projectUsageAnalyticsSummary(accounting, usageQueryToAnalyticsRequest(selected, endMs));
    expect(compact.summary!.publicProfileAccounting!.period).toEqual({ startMs: 0, endMs, timeZoneOffsetMinutes: 0 });
    expect(compact.summary!.publicProfileAccounting!.total.calendar.days).toHaveLength(3);
    expect(compact.summary!.publicProfileAccounting!.lenses.every(lens => lens.population.calendar.days.length === 3)).toBe(true);
    const snapshots = [accounting, compact].map(value => resolveUsagePageAggregation({ queries: [selected],
      accounting: [{ query: selected, value, status: 'available', asOfMs: endMs }] }).results[0]!);
    const calendarPolicy = PublicProfilePolicyV1Schema.parse({ ...policy, fields: { ...policy.fields, mergedPrs: false } });
    const built = snapshots.map(queryResult => buildPublicProfileSnapshot({ queryResult, policy: calendarPolicy, nowMs: endMs }));
    expect(built[0]).toEqual(built[1]);
    for (const value of built) {
      expect(value.kind).toBe('ready');
      if (value.kind !== 'ready') throw new Error('Expected All profile');
      expect(value.snapshot.period).toEqual({ startMs: 0, endMs, timeZoneOffsetMinutes: 0 });
      expect(value.snapshot.facts.calendar).toHaveLength(3);
      expect(PublicProfileRefreshBodyV1Schema.safeParse({ query: selected, snapshot: value.snapshot }).success).toBe(true);
    }
    const explicit = normalizeUsageQuery({ ...selected, period: { startMs: 0, endMs }, includeActivity: true });
    const explicitValue = projectUsageAnalyticsSummary(accounting, usageQueryToAnalyticsRequest(explicit, endMs));
    expect(explicitValue.summary!.accountingCalendar!.value.period.startMs).toBe(0);
    expect(explicitValue.summary!.accountingCalendar!.value.days.length).toBeGreaterThan(20_000);
  });

  it('keeps an empty All artifact bounded without projecting empty prehistory', () => {
    const original = result();
    const selected = normalizeUsageQuery({ ...query, period: { relative: 'all' } });
    const accounting = UsageAnalyticsQueryResponseSchema.parse({ ...original.accounting, contributions: [], activity: undefined,
      totals: { eventCount: 0, tokens: createEmptyUsageTokens(), cost: { reportedUsd: 0, estimatedUsd: 0, currency: 'USD' } },
      coverage: { status: 'complete', reasons: [], missingDimensions: [], ranked: [], sources: [],
        range: { startMs: 0, endMs, complete: true } } });
    const compact = projectUsageAnalyticsSummary(accounting, usageQueryToAnalyticsRequest(selected, endMs));
    expect(compact.summary!.publicProfileAccounting!.period).toEqual({ startMs: 0, endMs, timeZoneOffsetMinutes: 0 });
    for (const value of [accounting, compact]) {
      const shown = resolveUsagePageAggregation({ queries: [selected], accounting: [{ query: selected, value,
        status: 'available', asOfMs: endMs }] }).results[0]!;
      const built = buildPublicProfileSnapshot({ queryResult: shown, policy, nowMs: endMs });
      expect(built.kind).toBe('ready');
      if (built.kind !== 'ready') throw new Error('Expected known-empty All profile');
      expect(built.snapshot.period).toEqual({ startMs: 0, endMs, timeZoneOffsetMinutes: 0 });
      expect(built.snapshot.facts).toMatchObject({ activeDays: 0, currentStreakDays: 0, bestStreakDays: 0 });
      expect(built.snapshot.facts.calendar).toEqual([]);
      expect(built.snapshot.fieldCoverage?.calendar).toMatchObject({ status: 'complete_for_supplied_facts' });
      expect(built.snapshot.lenses?.every(lens => (lens.facts.calendar?.length ?? 0) === 0)).toBe(true);
    }
  });
  it('retains the same public snapshot from compact accounting at 32,975 events and three real turns', () => {
    const rich = result(undefined, false, ['codex', 'claude', 'codex'], 32_975);
    const compactAccounting = UsageAnalyticsQueryResponseSchema.parse(JSON.parse(JSON.stringify(
      projectUsageAnalyticsSummary(rich.accounting!, usageQueryToAnalyticsRequest(query)))));
    expect(compactAccounting.contributions).toBeUndefined();
    expect(compactAccounting.summary?.publicProfileAccounting?.total.contributionCount).toBe(32_975);
    expect(compactAccounting.summary?.publicProfileAccounting?.membership.turns).toEqual([
      { sessionId: 'private-session', turnId: 'private-turn-0', executions: ['happier'] },
      { sessionId: 'private-session', turnId: 'private-turn-1', executions: ['outside'] },
      { sessionId: 'private-session', turnId: 'private-turn-2', executions: ['unknown'] },
    ]);
    expect(JSON.stringify(compactAccounting)).not.toContain('private-request-');
    const expected = buildPublicProfileSnapshot({ queryResult: rich, policy, nowMs: endMs });
    const actual = buildPublicProfileSnapshot({ queryResult: { ...rich, accounting: compactAccounting }, policy, nowMs: endMs });
    expect(expected.kind).toBe('ready');
    expect(actual).toEqual(expected);
    expect(JSON.stringify(actual)).not.toMatch(/private-|87654321|98765432|reportedUsd|estimatedUsd|workId|turnId|sessionId/);
  }, 30_000);

  it('keeps unattributed Usage in totals while omitting its Agent rows from the reviewed public snapshot', () => {
    const built = buildPublicProfileSnapshot({ queryResult: result(undefined, false, ['codex', 'unknown', 'legacy']), policy, nowMs: endMs });
    if (built.kind !== 'ready') throw new Error('Expected admitted public snapshot');
    expect(built.snapshot.facts.tokens).toBe(50);
    expect(built.snapshot.facts.agentMix).toEqual([{ agentId: 'codex', share: .2, tokens: 10,
      coverage: { status: 'partial', method: 'runtime' } }]);
    expect(built.snapshot.facts.agentActiveDays?.map(row => row.agentId)).toEqual(['codex']);
    expect(built.snapshot.facts.sessionDurations).toEqual([{ agentId: 'codex', durationMs: 100 }]);
    expect(built.snapshot.facts.weeklyAgentMix?.flatMap(week => week.mix.map(row => row.agentId))).toEqual(['codex']);
    for (const lens of built.snapshot.lenses ?? []) {
      expect(lens.facts.agentMix?.some(row => row.agentId === 'unknown' || row.agentId === 'legacy')).toBe(false);
    }
    expect(PublicProfileRefreshBodyV1Schema.safeParse({ query, snapshot: built.snapshot }).success).toBe(true);
  });
  it('projects actual day, source, interval and anonymous duration facts into the strict server body without private DTOs', () => {
    const computedAtMs = endMs + 12_345;
    const built = buildPublicProfileSnapshot({ queryResult: result(), policy, nowMs: computedAtMs });
    expect(built.kind).toBe('ready');
    if (built.kind !== 'ready') throw new Error('Expected admitted public snapshot');
    expect(built.snapshot).toMatchObject({ computedAtMs, period: { startMs, endMs, timeZoneOffsetMinutes: 0 }, facts: {
      tokens: 50, activeDays: 3, bestStreakDays: 3, currentStreakDays: 3, agentTimeMs: 600, peakParallel: 1,
      calendar: [{ date: '2026-10-18', level: 3 }, { date: '2026-10-19', level: 4 }, { date: '2026-10-20', level: 3 }],
      sourceSplit: [{ execution: 'happier', share: .2 }, { execution: 'outside', share: .6 }, { execution: 'unknown', share: .2 }],
      sessionDurations: [{ agentId: 'claude', durationMs: 200 }, { agentId: 'codex', durationMs: 100 }, { agentId: 'codex', durationMs: 300 }],
      footprint: { status: 'insufficient_basis', reason: 'no_applicable_versioned_method' },
    } });
    expect(PublicProfileRefreshBodyV1Schema.safeParse({ query, snapshot: built.snapshot }).success).toBe(true);
    expect(JSON.stringify(built.snapshot)).not.toMatch(/private-|87654321|98765432|reportedUsd|estimatedUsd|workId|turnId|sessionId/);
    expect(built.snapshot.facts.machineKinds).toBeUndefined();
  });

  it('applies the canonical field mask recursively, including percentages without token counts and source lenses', () => {
    const hidden = PublicProfilePolicyV1Schema.parse({ ...policy, fields: { ...policy.fields, tokens: false, activeDays: false, peakParallel: false } });
    const built = buildPublicProfileSnapshot({ queryResult: result(), policy: hidden, nowMs: endMs });
    if (built.kind !== 'ready') throw new Error('Expected admitted public snapshot');
    expect(built.snapshot.facts.tokens).toBeUndefined();
    expect(built.snapshot.facts.agentMix?.map(row => row.share)).toEqual(expect.arrayContaining([.4, .6]));
    expect(built.snapshot.facts.agentMix?.every(row => row.tokens === undefined)).toBe(true);
    expect(built.snapshot.facts.sourceSplit?.every(row => row.tokens === undefined)).toBe(true);
    expect(built.snapshot.facts.weeklyPeakParallel).toBeUndefined();
    expect(built.snapshot.facts.highlights).not.toContainEqual(expect.objectContaining({ kind: 'active_days' }));
    expect(built.snapshot.lenses?.every(lens => lens.facts.tokens === undefined)).toBe(true);
  });

  it('refuses ordinary history, mismatched shown scope, totals-only and unavailable accounting instead of inventing zero', () => {
    const slice = result();
    for (const queryResult of [
      { ...slice, requestedQuery: normalizeUsageQuery({ ...query, population: 'all_personal_history' }) },
      { ...slice, shownQuery: normalizeUsageQuery({ ...query, agents: ['claude'] }) },
      { ...slice, accounting: slice.accounting && { ...slice.accounting, contributions: undefined } },
      { ...slice, accounting: undefined },
    ]) expect(buildPublicProfileSnapshot({ queryResult, policy, nowMs: endMs }).kind).toBe('unavailable');
  });

  it('distinguishes no eligible personal facts from admitted facts without an observation clock', () => {
    const slice = result();
    for (const { empty, asOfMs } of [{ empty: true }, { empty: true, asOfMs: endMs }, { empty: false }]) {
      const accounting = UsageAnalyticsQueryResponseSchema.parse({ ...slice.accounting,
        contributions: empty ? [] : slice.accounting!.contributions,
        ...(empty ? { totals: { eventCount: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          cost: { reportedUsd: 0, estimatedUsd: 0, currency: 'USD' } }, activity: undefined } : {}),
        coverage: { ...slice.accounting!.coverage, sources: [] },
      });
      const queryResult = resolveUsagePageAggregation({ queries: [query],
        accounting: [{ query, status: 'available', asOfMs, value: accounting }] }).results[0]!;
      expect(buildPublicProfileSnapshot({ queryResult, policy, nowMs: endMs })).toEqual({ kind: 'unavailable',
        reason: empty ? 'no_eligible_personal_usage' : 'source_time_unavailable' });
    }
  });

  it('does not turn absent event observations into known-empty days even with a complete history range', () => {
    const slice = result();
    const accounting = UsageAnalyticsQueryResponseSchema.parse({ ...slice.accounting, activity: undefined,
      contributions: slice.accounting!.contributions!.map(row => ({ ...row, eventCount: undefined })),
      coverage: { ...slice.accounting!.coverage, status: 'complete', range: { startMs, endMs, complete: true } } });
    const queryResult = resolveUsagePageAggregation({ queries: [query],
      accounting: [{ query, status: 'available', asOfMs: endMs, value: accounting }] }).results[0]!;
    const built = buildPublicProfileSnapshot({ queryResult, policy, nowMs: endMs });
    if (built.kind !== 'ready') throw new Error('Expected witnessed token facts');
    expect(built.snapshot.facts.tokens).toBe(50);
    expect(built.snapshot.facts.calendar?.map(day => day.level)).toEqual([null, null, null]);
    expect(built.snapshot.facts.activeDays).toBeUndefined();
    expect(built.snapshot.fieldCoverage?.activeDays?.status).toBe('unknown');
  });

  it('counts deduplicated merged Work and independently projects source lenses without publishing repository evidence', () => {
    const witness = (turnId: string): UsageWorkEvidence => ({ sessionId: 'private-session', turnId, repositoryKey: 'private-repository',
      checkpointRef: 'private-checkpoint', checkpointCommitSha: 'a'.repeat(40), commitSha: 'b'.repeat(40),
      attributionScope: 'no_happier_checkpoint_overlap_observed', pullRequest: { provider: { id: 'forge', kind: 'github',
        displayName: 'Forge', baseUrl: 'https://github.com', nameWithOwner: 'private-owner/private-repo', urlSafety: { allowedSchemes: ['https:'] } },
        number: 999999, title: 'private-title', url: 'https://github.com/private-owner/private-repo/pull/999999',
        baseBranch: 'private-base', headBranch: 'private-head', state: 'merged' } });
    const built = buildPublicProfileSnapshot({ queryResult: result([witness('private-turn-0'), witness('private-turn-0'), witness('private-turn-1')]),
      policy, nowMs: endMs });
    if (built.kind !== 'ready') throw new Error('Expected canonical Work projection');
    expect(built.snapshot.facts.mergedPrs).toBe(1);
    expect(built.snapshot.lenses).toMatchObject([
      { execution: 'happier', facts: { tokens: 10, mergedPrs: 1, agentTimeMs: 100,
        calendar: [{ date: '2026-10-18', level: 4 }, { date: '2026-10-19', level: null }, { date: '2026-10-20', level: null }] } },
      { execution: 'outside', facts: { tokens: 30, mergedPrs: 1, agentTimeMs: 200,
        calendar: [{ date: '2026-10-18', level: null }, { date: '2026-10-19', level: 4 }, { date: '2026-10-20', level: null }] } },
    ]);
    expect(JSON.stringify(built.snapshot)).not.toMatch(/private-|999999|repositoryKey|checkpointRef|commitSha|pullRequest/);
  });

  it('does not label an unclassified execution day as empty in either classified source lens', () => {
    const built = buildPublicProfileSnapshot({ queryResult: result(undefined, true), policy, nowMs: endMs });
    if (built.kind !== 'ready') throw new Error('Expected complete accounting with unknown execution attribution');
    expect(built.snapshot.facts.activeDays).toBe(3);
    expect(built.snapshot.lenses?.map(lens => lens.facts.calendar?.find(day => day.date === '2026-10-20')?.level)).toEqual([null, null]);
  });
});
