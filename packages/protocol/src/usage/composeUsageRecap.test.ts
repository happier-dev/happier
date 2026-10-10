import { describe, expect, it } from 'vitest';
import { normalizeUsageQuery, getUsageQueryKey } from '../inputs/usageQuery.js';
import { resolveUsagePageAggregation } from './resolveUsagePageAggregation.js';
import type { UsageAnalyticsQueryResponse } from './usageAnalyticsContracts.js';
import { composeUsageRecap } from './composeUsageRecap.js';
import { resolveUsageHowYouWork } from './resolveUsageHowYouWork.js';
import { UsageRecapComposeInputSchema, UsageRecapComposeResultSchema, USAGE_RECAP_STYLES, USAGE_RECAP_FORMATS } from './usageRecap.js';

const query = normalizeUsageQuery({ period: { startMs: 1000, endMs: 9000 }, timeZoneOffsetMinutes: 120,
  session: 'private-session', projects: ['private-project'], includeInsights: true, includeActivity: true });
const response: UsageAnalyticsQueryResponse = {
  v: 1,
  totals: { eventCount: 2, tokens: { input: 100, output: 20, reasoning: 0, cacheRead: 5, cacheWrite: 0, total: 120 },
    cost: { reportedUsd: 1.5, estimatedUsd: 1.2, currency: 'USD', costSource: 'provider_reported' } },
  breakdowns: { model: [{ key: 'private-model', label: 'Private Model', eventCount: 2,
    tokens: { input: 100, output: 20, reasoning: 0, cacheRead: 5, cacheWrite: 0, total: 120 },
    cost: { reportedUsd: 1.5, estimatedUsd: 1.2, currency: 'USD' } }] },
  insights: { activeDays: 1, longestStreakDays: 1, sessionsUsed: 1, messagesUsed: 2, modelsTried: 1, favoriteModelChangeCount: 0 },
};
const snapshot = resolveUsagePageAggregation({ queries: [query], accounting: [{ query, value: response, status: 'available', asOfMs: 9500 }] }).results[0]!;

describe('private recap composition', () => {
  it('shares one selected-fact result across all seven styles and three formats without leaking names or dollars by default', () => {
    for (const style of USAGE_RECAP_STYLES) {
      for (const format of USAGE_RECAP_FORMATS) {
        const result = composeUsageRecap({ input: UsageRecapComposeInputSchema.parse({ query, style, format }), snapshot });
        expect(result.kind).toBe('composed');
        if (result.kind !== 'composed') continue;
        expect(result.period).toEqual({ startMs: 1000, endMs: 9000, timeZoneOffsetMinutes: 120 });
        expect(result.asOfMs).toBe(9500);
        expect(result.facts.tokens?.total).toBe(120);
        expect(result.facts.dollars).toBeUndefined();
        expect(result.facts.modelMix?.[0]).toEqual({ tokens: 120, events: 2 });
        expect(result.coverage.accounting).toBeNull();
        const serialized = JSON.stringify(result);
        for (const hidden of ['private-session', 'private-project', 'private-model', 'Private Model', 'reportedUsd', 'estimatedUsd']) {
          expect(serialized).not.toContain(hidden);
        }
        expect(UsageRecapComposeResultSchema.parse(result)).toEqual(result);
      }
    }
  });

  it('emits exactly selected facts and permits names/dollars only when explicitly selected', () => {
    const input = UsageRecapComposeInputSchema.parse({ query, selectedFields: ['dollars', 'names', 'modelMix'] });
    const costFact = { kind: 'reported' as const, amountUsd: 1.5, currency: 'USD', tokens: response.totals.tokens,
      eventCount: 2, source: 'private-source', asOfMs: 9500, complete: true };
    const pricedSnapshot = resolveUsagePageAggregation({ queries: [query], accounting: [{ query,
      value: { ...response, costFacts: [costFact] }, status: 'available', asOfMs: 9500 }] }).results[0]!;
    const result = composeUsageRecap({ input, snapshot: pricedSnapshot });
    expect(result.kind).toBe('composed');
    if (result.kind !== 'composed') return;
    expect(result.selectedFields).toEqual(['modelMix', 'names', 'dollars']);
    expect(Object.keys(result.facts)).toEqual(['modelMix', 'dollars']);
    expect(result.facts.modelMix?.[0]?.name).toBe('Private Model');
    const { source: _source, ...projected } = costFact;
    expect(result.facts.dollars).toEqual({ basis: 'auto', facts: [projected] });
  });

  it('does not invent streak, night, parallel, work or coach highlights from accounting totals', () => {
    const result = composeUsageRecap({ input: UsageRecapComposeInputSchema.parse({ query,
      selectedFields: ['streak', 'night', 'parallel', 'work', 'coach', 'highlights'] }), snapshot });
    expect(result.kind).toBe('composed');
    if (result.kind !== 'composed') return;
    expect(result.facts).toEqual({ highlights: [] });
    expect(result.unavailableFields).toEqual(['streak', 'parallel', 'night', 'work', 'coach']);
  });

  it('refuses a previous or differently filtered query and missing accounting instead of re-labelling old values', () => {
    const input = UsageRecapComposeInputSchema.parse({ query });
    const different = normalizeUsageQuery({ ...query, machines: ['other-machine'] });
    expect(composeUsageRecap({ input, snapshot: { ...snapshot, requestedQuery: different, shownQuery: different, key: getUsageQueryKey(different) } }))
      .toEqual({ kind: 'unavailable', reason: 'query_mismatch' });
    expect(composeUsageRecap({ input, snapshot: { ...snapshot, accounting: undefined } }))
      .toEqual({ kind: 'unavailable', reason: 'accounting_unavailable' });
  });

  it('consumes canonical private interval evidence without promoting partial scope history to complete', () => {
    const howYouWork = resolveUsageHowYouWork({ period: { startMs: 1000, endMs: 9000 }, timeZoneOffsetMinutes: 120,
      nightHours: { startHour: 22, endHour: 6 }, detail: { status: 'partial', permissions: [], acceptedInputs: [],
        facts: [{ workId: 'private-work', machineId: 'private-machine', agentId: 'agent', evidenceId: 'private-evidence',
          kind: 'busy', startMs: 2000, endMs: 5000 }] } });
    const result = composeUsageRecap({ input: UsageRecapComposeInputSchema.parse({ query, selectedFields: ['parallel', 'night'] }),
      snapshot: { ...snapshot, howYouWork } });
    expect(result.kind).toBe('composed');
    if (result.kind !== 'composed') return;
    expect(result.facts.parallel).toEqual({ sumAgentMs: 3000, unionElapsedMs: 3000, maximumConcurrency: 1 });
    expect(result.facts.night?.observedBusyMs).toBe(3000);
    expect(result.coverage.intervals?.detailStatus).toBe('partial');
    expect(JSON.stringify(result)).not.toContain('private-work');
  });

  it('keeps native-only recorded night activity available without inventing private busy time', () => {
    const startMs = Date.parse('2026-10-08T22:00:00Z');
    const endMs = startMs + 3_600_000;
    const nightQuery = normalizeUsageQuery({ ...query, period: { startMs, endMs }, timeZoneOffsetMinutes: 120 });
    const native = { ...response, activity: { calendarDays: [{ date: '2026-10-09', eventCount: 7 }],
      weekdayHourBuckets: [{ weekday: 5, hour: 0, eventCount: 7 }] } };
    const nativeSnapshot = resolveUsagePageAggregation({ queries: [nightQuery],
      accounting: [{ query: nightQuery, value: native, status: 'available', asOfMs: endMs }],
      howYouWork: [{ query: nightQuery, nightHours: { startHour: 22, endHour: 6 }, detail: { status: 'unknown' } }] }).results[0]!;
    const input = UsageRecapComposeInputSchema.parse({ query: nightQuery, selectedFields: ['night'] });
    const result = composeUsageRecap({ input, snapshot: nativeSnapshot });
    expect(result).toMatchObject({ kind: 'composed', period: { startMs, endMs, timeZoneOffsetMinutes: 120 }, asOfMs: endMs,
      unavailableFields: [], facts: { night: { startHour: 22, endHour: 6, recordedActivityCount: 7, observedBusyMs: null } },
      coverage: { night: { detailStatus: 'unknown' } } });
    expect(result.kind === 'composed' && result.coverage.intervals).toBeUndefined();
    const noWindowSnapshot = resolveUsagePageAggregation({ queries: [nightQuery],
      accounting: [{ query: nightQuery, value: native, status: 'available', asOfMs: endMs }] }).results[0]!;
    const noWindow = composeUsageRecap({ input, snapshot: noWindowSnapshot });
    expect(noWindow.kind === 'composed' && noWindow.facts.night).toBeUndefined();
    expect(noWindow.kind === 'composed' && noWindow.unavailableFields).toEqual(['night']);
    expect(JSON.stringify(result)).not.toContain('private-session');
  });

  it('rejects a composed result that smuggles a hidden dollar fact or name outside its manifest', () => {
    const result = composeUsageRecap({ input: UsageRecapComposeInputSchema.parse({ query }), snapshot });
    if (result.kind !== 'composed') throw new Error('Expected available accounting');
    expect(UsageRecapComposeResultSchema.safeParse({ ...result, facts: { ...result.facts,
      dollars: { basis: 'auto', reportedUsd: 1.5, estimatedUsd: 1.2, currency: 'USD' } } }).success).toBe(false);
    expect(UsageRecapComposeResultSchema.safeParse({ ...result, facts: { ...result.facts,
      modelMix: [{ tokens: 120, events: 2, name: 'Private Model' }] } }).success).toBe(false);
  });

  it('projects witnessed coach findings from the same admitted slice without private evidence or invented negatives', () => {
    const read = { evidenceId: 'private-read-1', observedAtMs: 2000, turnId: 'private-turn',
      fileKey: '/private/file', versionDigest: 'private-version', selectionKey: 'all', reason: 'required' as const };
    const coached = resolveUsagePageAggregation({ queries: [query],
      accounting: [{ query, value: response, status: 'available', asOfMs: 9500 }],
      howYouWork: [{ query, detail: { status: 'partial', coach: { detail: { coverage: 'partial',
        fileReads: [read, { ...read, evidenceId: 'private-read-2', observedAtMs: 3000, reason: 'redundant' }] } } } }] }).results[0]!;
    const input = UsageRecapComposeInputSchema.parse({ query, selectedFields: ['coach'] });
    const result = composeUsageRecap({ input, snapshot: coached });
    expect(result.kind).toBe('composed');
    if (result.kind !== 'composed') return;
    expect(result.facts.coach).toEqual({ findings: [{ detectorId: 'repeated_file_reads', evidenceCount: 2 }] });
    expect(result.coverage.coach).toEqual({ currentness: 'current', asOfMs: 9500, findings: ['partial'] });
    expect(result.unavailableFields).toEqual([]);
    for (const hidden of ['private-read', 'private-turn', '/private/file', 'private-version', 'evidenceKey', 'summaryCode']) {
      expect(JSON.stringify(result)).not.toContain(hidden);
    }
    const insufficient = composeUsageRecap({ input, snapshot });
    expect(insufficient.kind === 'composed' && insufficient.facts.coach).toBeUndefined();
    expect(insufficient.kind === 'composed' && insufficient.unavailableFields).toEqual(['coach']);
  });

  it('preserves distinct canonical money kinds and unpriced absence rather than scalar zero or blended cost', () => {
    const costFacts: NonNullable<UsageAnalyticsQueryResponse['costFacts']> = [
      ...(['reported', 'estimated', 'api_equivalent', 'invoice'] as const).map((kind, index) => ({ kind,
        amountUsd: index + 1, currency: 'USD', source: 'private-native-source', tokens: response.totals.tokens,
        eventCount: 2, asOfMs: 9500, complete: true })),
      { kind: 'unpriced', amountUsd: null, currency: 'USD', source: 'private-unpriced-source',
        tokens: response.totals.tokens, eventCount: 2, asOfMs: 9500, complete: false },
    ];
    const accounting = { ...response, costFacts, totals: { ...response.totals,
      cost: { reportedUsd: 0, estimatedUsd: 0, currency: 'USD' } } };
    const costSnapshot = resolveUsagePageAggregation({ queries: [query],
      accounting: [{ query, value: accounting, status: 'available', asOfMs: 9500 }] }).results[0]!;
    const input = UsageRecapComposeInputSchema.parse({ query, selectedFields: ['dollars'] });
    const result = composeUsageRecap({ input, snapshot: costSnapshot });
    expect(result.kind).toBe('composed');
    if (result.kind !== 'composed') return;
    expect(result.facts.dollars).toEqual({ basis: 'auto', facts: costFacts.map(({ source: _source, ...fact }) => fact) });
    expect(JSON.stringify(result)).not.toContain('private-native-source');
    expect(JSON.stringify(result)).not.toContain('private-unpriced-source');
    expect(JSON.stringify(result.facts.dollars)).not.toContain('reportedUsd');
    const missing = composeUsageRecap({ input, snapshot });
    expect(missing.kind === 'composed' && missing.facts.dollars).toBeUndefined();
    expect(missing.kind === 'composed' && missing.unavailableFields).toEqual(['dollars']);
  });
});
