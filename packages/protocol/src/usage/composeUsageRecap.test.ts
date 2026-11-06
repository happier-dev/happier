import { describe, expect, it } from 'vitest';
import { normalizeUsageQuery, getUsageQueryKey, usageQueryToAnalyticsRequest } from '../inputs/usageQuery.js';
import { resolveUsagePageAggregation } from './resolveUsagePageAggregation.js';
import { UsageAnalyticsQueryResponseSchema, type UsageAnalyticsQueryResponse } from './usageAnalyticsContracts.js';
import { composeUsageRecap } from './composeUsageRecap.js';
import { resolveUsageHowYouWork } from './resolveUsageHowYouWork.js';
import { UsageRecapComposeInputSchema, UsageRecapComposeResultSchema, USAGE_RECAP_STYLES, USAGE_RECAP_FORMATS } from './usageRecap.js';
import { ScmPullRequestWorkEvidenceSchema } from '../scm/pullRequests.js';
import { projectUsagePageCost } from './usageCostFacts.js';
import { buildUsageFileResult } from './usageExport.js';
import { decodeBase64 } from '../crypto/base64.js';
import { projectUsageAnalyticsSummary } from './usageSummary.js';

const query = normalizeUsageQuery({ period: { startMs: 1000, endMs: 9000 }, timeZoneOffsetMinutes: 120,
  session: 'private-session', projects: ['private-project'], includeInsights: true, includeActivity: true });
const response = UsageAnalyticsQueryResponseSchema.parse({
  v: 1,
  totals: { eventCount: 2, tokens: { input: 100, output: 20, reasoning: 0, cacheRead: 5, cacheWrite: 0, total: 120 },
    cost: { reportedUsd: 1.5, estimatedUsd: 1.2, currency: 'USD', costSource: 'provider_reported' } },
  breakdowns: { model: [{ key: 'private-model', label: 'Private Model', eventCount: 2,
    tokens: { input: 100, output: 20, reasoning: 0, cacheRead: 5, cacheWrite: 0, total: 120 },
    cost: { reportedUsd: 1.5, estimatedUsd: 1.2, currency: 'USD' } }] },
  insights: { activeDays: 1, longestStreakDays: 1, sessionsUsed: 1, messagesUsed: 2, modelsTried: 1, favoriteModelChangeCount: 0 },
});
const snapshot = resolveUsagePageAggregation({ queries: [query], accounting: [{ query, value: response, status: 'available', asOfMs: 9500 }] }).results[0]!;

describe('private recap composition', () => {
  it('keeps All private interval, night and Coach facts on their admitted source period', () => {
    const endMs = 5 * 86_400_000;
    const observedAtMs = 4 * 86_400_000 + 1000;
    const selected = normalizeUsageQuery({ ...query, period: { endMs }, timeZoneOffsetMinutes: 0 });
    const accounting = UsageAnalyticsQueryResponseSchema.parse({ ...response, coverage: {
      status: 'partial', reasons: [], missingDimensions: [], ranked: [], sources: [],
      range: { startMs: 0, endMs, complete: false } }, contributions: [{ id: 'all-private', observedAtMs,
        sessionId: 'private-session', turnId: 'private-turn', agentId: 'codex', modelId: null,
        machineId: null, projectKey: null, workspaceId: null, source: 'runtime',
        tokens: response.totals.tokens, cost: response.totals.cost }] });
    const read = { evidenceId: 'first', observedAtMs, turnId: 'private-turn', fileKey: '/private/file',
      versionDigest: 'same-version', selectionKey: 'all', reason: 'required' as const };
    const shown = resolveUsagePageAggregation({ queries: [selected],
      accounting: [{ query: selected, value: accounting, status: 'available', asOfMs: endMs }],
      howYouWork: [{ query: selected, nightHours: { startHour: 22, endHour: 6 }, detail: { status: 'partial',
        facts: [{ workId: 'private-work', machineId: null, agentId: 'codex', evidenceId: 'busy', kind: 'busy',
          startMs: observedAtMs, endMs: observedAtMs + 3000 }],
        coach: { detail: { coverage: 'partial', fileReads: [read,
          { ...read, evidenceId: 'second', observedAtMs: observedAtMs + 1000, reason: 'redundant' }] } } } }] }).results[0]!;
    const input = UsageRecapComposeInputSchema.parse({ query: selected, selectedFields: ['parallel', 'night', 'coach'] });
    const composed = composeUsageRecap({ input, snapshot: shown });
    expect(composed).toMatchObject({ kind: 'composed', period: { startMs: 0, endMs }, unavailableFields: [], facts: {
      parallel: { sumAgentMs: 3000, unionElapsedMs: 3000, maximumConcurrency: 1 },
      night: { observedBusyMs: 3000 }, coach: { findings: [{ detectorId: 'repeated_file_reads', evidenceCount: 2 }] },
    } });
  });
  it.each([false, true])('preserves bounded All artifact metadata from compact accounting (relative %s)', relative => {
    const endMs = Date.parse('2026-10-11T20:30:00Z');
    const observedAtMs = Date.parse('2026-10-10T23:30:00Z');
    const selected = normalizeUsageQuery({ ...query, period: relative ? { relative: 'all' } : { endMs },
      includeActivity: false, includeModelTimeline: false });
    const rich = UsageAnalyticsQueryResponseSchema.parse({ ...response,
      coverage: { status: 'partial', reasons: [], missingDimensions: [],
        range: { startMs: 0, endMs, complete: false }, ranked: [], sources: [] },
      contributions: [{ id: 'all-observation', observedAtMs, sessionId: null, turnId: null, agentId: 'codex',
        modelId: null, machineId: null, projectKey: null, workspaceId: null, source: 'native',
        eventCount: 2, tokens: response.totals.tokens, cost: response.totals.cost }] });
    const accounting = projectUsageAnalyticsSummary(rich, usageQueryToAnalyticsRequest(selected, endMs));
    expect(accounting.summary?.accountingCalendar).toBeUndefined();
    const shown = resolveUsagePageAggregation({ queries: [selected], accounting: [{ query: selected,
      value: accounting, status: 'available', asOfMs: endMs }] }).results[0]!;
    const input = UsageRecapComposeInputSchema.parse({ query: selected, selectedFields: ['tokens'] });
    for (const snapshot of [shown, { ...shown, accounting: { ...accounting, summary: undefined },
      accountingObservationRange: accounting.summary!.observationRange }]) {
      expect(composeUsageRecap({ input, snapshot })).toMatchObject({ kind: 'composed',
        period: { startMs: 0, endMs, timeZoneOffsetMinutes: 120 }, facts: { tokens: response.totals.tokens } });
      const explicit = normalizeUsageQuery({ ...selected, period: { startMs: 0, endMs } });
      expect(composeUsageRecap({ input: { ...input, query: explicit }, snapshot })).toMatchObject({ kind: 'composed',
        period: { startMs: 0, endMs, timeZoneOffsetMinutes: 120 } });
    }
  });
  it('keeps unknown execution qualified without interpreting private producer ids as execution', () => {
    const contribution = { id: 'unknown', observedAtMs: 2000, sessionId: 'private-session', turnId: null,
      agentId: null, modelId: null, machineId: null, projectKey: null, workspaceId: null,
      source: 'runtime', tokens: response.totals.tokens, cost: response.totals.cost };
    const result = composeUsageRecap({ input: UsageRecapComposeInputSchema.parse({ query, sourceSelection: 'whole_usage', selectedFields: [] }),
      snapshot: { ...snapshot, accounting: { ...response, totals: { ...response.totals,
        tokens: { ...response.totals.tokens, input: 200, output: 40, total: 240 } }, contributions: [contribution,
        { ...contribution, id: 'native-linked', source: 'native', sourceContext: { path: 'native', execution: 'happier' } }] } } });
    expect(result).toMatchObject({ kind: 'composed', sourceSelection: 'whole_usage', facts: {}, coverage: { execution: { status: 'partial' } } });
    expect(JSON.stringify(result)).not.toContain('"tokens"');
    expect(JSON.stringify(result)).not.toMatch(/native-linked|private-session|"source":"runtime"/);
  });
  it('keeps public Agent identity when private names are off, while model labels stay private', () => {
    const agent = { ...response.breakdowns!.model![0]!, key: 'claude', label: 'Claude' };
    const result = composeUsageRecap({ input: UsageRecapComposeInputSchema.parse({ query, selectedFields: ['agentMix', 'modelMix'] }),
      snapshot: { ...snapshot, accounting: { ...response, breakdowns: { ...response.breakdowns, agent: [agent] } } } });
    expect(result).toMatchObject({ kind: 'composed', facts: { agentMix: [{ agentId: 'claude' }], modelMix: [{ tokens: 120 }] } });
    expect(JSON.stringify(result)).not.toContain('Private Model');
    expect(UsageRecapComposeResultSchema.safeParse(result).success).toBe(true);
  });
  it('uses the query cost owner and merges comparison facts across private pricing sources', () => {
    const fact = { kind: 'reported' as const, amountUsd: 1.5, currency: 'USD', tokens: response.totals.tokens,
      eventCount: 1, source: 'private-first', asOfMs: 9500, complete: true };
    const accounting = { ...response, costFacts: [fact, { ...fact, amountUsd: 2, source: 'private-second' }] };
    const input = UsageRecapComposeInputSchema.parse({ query, selectedFields: ['dollars'] });
    const result = composeUsageRecap({ input, snapshot: { ...snapshot, accounting } });
    expect(result.kind).toBe('composed');
    if (result.kind !== 'composed') return;
    expect(result.facts.dollars).toMatchObject({ selected: {
      kind: 'reported', currency: 'USD', amountUsd: projectUsagePageCost(accounting, 'auto').amountUsd,
    }, facts: [{ kind: 'reported', amountUsd: 3.5, eventCount: 2 }] });
    expect(result.facts.dollars?.facts).toHaveLength(1);
    expect(JSON.stringify(result)).not.toContain('private-first');
    expect(UsageRecapComposeResultSchema.parse(result)).toEqual(result);
  });
  it('keeps unavailable scoped money unavailable even when raw whole-report facts are present', () => {
    const accounting = { ...response, contributions: [], costPresentation: undefined,
      costFacts: [{ kind: 'reported' as const, amountUsd: 3.5, currency: 'USD', tokens: response.totals.tokens,
        eventCount: 1, source: 'whole-report', asOfMs: 9500, complete: false }] };
    const result = composeUsageRecap({ input: UsageRecapComposeInputSchema.parse({ query, selectedFields: ['dollars'] }),
      snapshot: { ...snapshot, accounting } });
    expect(result).toMatchObject({ kind: 'composed', facts: { dollars: { selected: null } } });
  });
  it('retains selected query money when there are no raw comparison facts', () => {
    const result = composeUsageRecap({ input: UsageRecapComposeInputSchema.parse({ query, selectedFields: ['dollars'] }), snapshot });
    expect(result).toMatchObject({ kind: 'composed', facts: { dollars: {
      selected: { kind: 'reported', currency: 'USD', amountUsd: 1.5 }, facts: [],
    } } });
  });
  it('preserves the selected total through the query projection, recap and serialized export', () => {
    const cost = { reportedUsd: 0, estimatedUsd: 1, apiEquivalentUsd: 0.0002,
      currency: 'USD', costSource: 'pricing_estimate' as const, reportedTotalId: 'final' };
    const accounting = UsageAnalyticsQueryResponseSchema.parse({ v: 1, totals: response.totals,
      contributions: [
        { id: 'inference', observedAtMs: 2000, sessionId: 'private-session', turnId: null, agentId: null,
          modelId: null, machineId: null, projectKey: null, workspaceId: null, source: 'runtime', tokens: response.totals.tokens, cost },
        { id: 'final', observedAtMs: 3000, sessionId: 'private-session', turnId: null, agentId: null,
          modelId: null, machineId: null, projectKey: null, workspaceId: null, source: 'final',
          tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          cost: { reportedUsd: 0.12, estimatedUsd: 0, apiEquivalentUsd: 0, currency: 'USD',
            costSource: 'provider_reported', reportedTotalContributionIds: ['inference'] } },
      ] });
    const shown = resolveUsagePageAggregation({ queries: [query], pricingOverrides: {},
      accounting: [{ query, value: accounting, status: 'available' }] }).results[0]!;
    const result = composeUsageRecap({ input: UsageRecapComposeInputSchema.parse({ query, selectedFields: ['dollars'] }), snapshot: shown });
    expect(result).toMatchObject({ kind: 'composed', facts: { dollars: {
      selected: { kind: 'reported', currency: 'USD', amountUsd: 0.12 },
    } } });
    const exported = buildUsageFileResult({ query, format: 'json', fields: ['costPresentation'] }, shown.accounting!, null);
    expect(JSON.parse(new TextDecoder().decode(decodeBase64(exported.base64))).accounting.costPresentation.effectiveUsd)
      .toBeCloseTo(0.12, 10);
  });
  it('composes a relative selection using witnessed accounting bounds, never a new viewer clock', () => {
    const relative = normalizeUsageQuery({ ...query, period: { relative: '7days' } });
    const endMs = Date.parse('2026-10-11T20:30:00Z');
    const period = { startMs: endMs - 7 * 86_400_000, endMs };
    const value = { ...response, coverage: { status: 'partial' as const, reasons: [], missingDimensions: [],
      range: { ...period, complete: false }, ranked: [], sources: [] } };
    const shown = resolveUsagePageAggregation({ queries: [relative], accounting: [{ query: relative, value,
      status: 'available', asOfMs: endMs }] }).results[0]!;
    const input = UsageRecapComposeInputSchema.parse({ query: relative, selectedFields: ['tokens'] });
    expect(composeUsageRecap({ input, snapshot: shown })).toMatchObject({ kind: 'composed',
      period: { ...period, timeZoneOffsetMinutes: 120 }, facts: { tokens: response.totals.tokens } });
    expect(composeUsageRecap({ input, snapshot: { ...shown, accounting: response } }))
      .toEqual({ kind: 'unavailable', reason: 'period_unavailable' });
  });
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
    expect(result.facts.dollars).toEqual({ basis: 'auto', selected: { kind: 'reported', currency: 'USD', amountUsd: 1.5 }, facts: [projected] });
  });

  it('does not invent streak, night, parallel, work or coach highlights from accounting totals', () => {
    const result = composeUsageRecap({ input: UsageRecapComposeInputSchema.parse({ query,
      selectedFields: ['streak', 'night', 'parallel', 'work', 'coach', 'highlights'] }), snapshot });
    expect(result.kind).toBe('composed');
    if (result.kind !== 'composed') return;
    expect(result.facts).toEqual({ highlights: [] });
    expect(result.unavailableFields).toEqual(['streak', 'parallel', 'night', 'work', 'coach']);

    const value = UsageAnalyticsQueryResponseSchema.parse({ ...response, contributions: [{
      id: 'private-contribution', observedAtMs: 2000, sessionId: 'private-session', turnId: 'private-turn',
      agentId: null, modelId: null, machineId: null, projectKey: 'private-project', workspaceId: null,
      source: 'runtime', tokens: response.totals.tokens, cost: response.totals.cost,
    }] });
    const input = UsageRecapComposeInputSchema.parse({ query, selectedFields: ['work', 'highlights'] });
    const witness = ScmPullRequestWorkEvidenceSchema.parse({ sessionId: 'private-session', turnId: 'private-turn',
      repositoryKey: 'private-repository', checkpointRef: 'private-checkpoint', checkpointCommitSha: 'a'.repeat(40),
      commitSha: 'b'.repeat(40), attributionScope: 'no_happier_checkpoint_overlap_observed', pullRequest: {
        provider: { id: 'forge', kind: 'github', displayName: 'Forge', baseUrl: 'https://github.com',
          nameWithOwner: 'private-owner/private-repository', urlSafety: { allowedSchemes: ['https:'] } },
        number: 1, title: 'Private outcome', url: 'https://github.com/private-owner/private-repository/pull/1',
        baseBranch: 'main', headBranch: 'private-branch', state: 'merged',
      } });
    for (const status of ['unknown', 'error', 'unsupported', 'not_loaded'] as const) {
      const unavailable = resolveUsagePageAggregation({ queries: [query],
        accounting: [{ query, value, status: 'available' }], work: [{ query, status, evidence: [witness] }] }).results[0]!;
      const composed = composeUsageRecap({ input, snapshot: unavailable });
      expect(composed.kind).toBe('composed');
      if (composed.kind !== 'composed') throw new Error('Expected available accounting');
      expect(composed.facts.work).toBeUndefined();
      expect(composed.unavailableFields).toContain('work');
      expect(composed.facts.highlights).toEqual([]);
      expect(composed.coverage.sourceStatuses).toContainEqual({ status });
    }
    const available = resolveUsagePageAggregation({ queries: [query],
      accounting: [{ query, value, status: 'available' }], work: [{ query, status: 'available', evidence: [] }] });
    const empty = composeUsageRecap({ input, snapshot: available.results[0]! });
    expect(empty).toMatchObject({ kind: 'composed', unavailableFields: [], facts: { work: {
      linkedOutcomes: 0, allocatedContributions: 0, unallocatedContributions: 1 }, highlights: [] } });
    const partial = resolveUsagePageAggregation({ queries: [query],
      accounting: [{ query, value, status: 'available' }], work: [{ query, status: 'partial', evidence: [witness] }] });
    const witnessed = composeUsageRecap({ input, snapshot: partial.results[0]! });
    expect(witnessed).toMatchObject({ kind: 'composed', unavailableFields: [], facts: { work: {
      linkedOutcomes: 1, allocatedContributions: 1, unallocatedContributions: 0 }, highlights: [{ kind: 'linked_outcomes', count: 1 }] },
      coverage: { sourceStatuses: expect.arrayContaining([{ status: 'partial' }]) } });
    expect(JSON.stringify(witnessed)).not.toContain('private-');
    const pending = resolveUsagePageAggregation({ queries: [query],
      accounting: [{ query, value, status: 'available' }], work: [{ query, status: 'pending' }], previous: partial });
    expect(composeUsageRecap({ input, snapshot: pending.results[0]! })).toMatchObject({ kind: 'composed',
      unavailableFields: [], facts: { work: { linkedOutcomes: 1 }, highlights: [{ kind: 'linked_outcomes', count: 1 }] },
      coverage: { pending: true, sourceStatuses: expect.arrayContaining([{ status: 'pending' }]) } });
    for (const previous of [undefined, available]) {
      const noWitness = resolveUsagePageAggregation({ queries: [query],
        accounting: [{ query, value, status: 'available' }], work: [{ query, status: 'pending' }], previous }).results[0]!;
      expect(composeUsageRecap({ input, snapshot: noWitness })).toMatchObject({ kind: 'composed',
        unavailableFields: ['work'], facts: { highlights: [] }, coverage: { pending: true } });
      const composed = composeUsageRecap({ input, snapshot: noWitness });
      expect(composed.kind === 'composed' && composed.facts.work).toBeUndefined();
    }
  });

  it('keeps missing accounting unavailable after read admission', () => {
    const input = UsageRecapComposeInputSchema.parse({ query });
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
    expect(result.facts.dollars).toEqual({ basis: 'auto', selected: null, facts: costFacts.map(({ source: _source, ...fact }) => fact) });
    expect(JSON.stringify(result)).not.toContain('private-native-source');
    expect(JSON.stringify(result)).not.toContain('private-unpriced-source');
    expect(JSON.stringify(result.facts.dollars)).not.toContain('reportedUsd');
    const missing = composeUsageRecap({ input, snapshot: { ...snapshot, accounting: { ...response,
      totals: { ...response.totals, cost: { reportedUsd: 0, estimatedUsd: 0, currency: 'USD', costSource: 'none' } } } } });
    expect(missing.kind === 'composed' && missing.facts.dollars).toBeUndefined();
    expect(missing.kind === 'composed' && missing.unavailableFields).toEqual(['dollars']);
  });
});
