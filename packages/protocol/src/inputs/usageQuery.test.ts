import { describe, expect, it } from 'vitest';
import { z } from 'zod/mini';
import { getUsageQueryBatchKey, getUsageQueryKey, normalizeUsageQuery, normalizeUsageQueryBatchInput, usageAnalyticsRequestToQuery, usageQueryToAnalyticsRequest, UsageQuerySchema, USAGE_QUERY_INPUT_FIELDS, readUsagePeriodOptions } from './usageQuery.js';
import { UsageAnalyticsQueryRequestSchema } from '../usage/usageAnalyticsContracts.js';
import { InputFieldHintSchema } from './inputFields.js';
import { resolveEffectiveInputFields } from './inputFieldRuntime.js';
import { projectInputOptionsDependencies } from './inputOptionsDependencies.js';
import * as usageQuery from './usageQuery.js';
import { createStoredReadSchema } from '../json/storedReadSchema.js';

describe('shared UsageQuery', () => {
  it('reuses only owner-normalized immutable identities while mutable caller values remain live', () => {
    const raw = { period: { startMs: 100, endMs: 200 }, agents: ['b', 'a'] };
    const query = normalizeUsageQuery(raw);
    const first = getUsageQueryKey(query);
    expect(normalizeUsageQuery(query)).toBe(query);
    expect(Object.isFrozen(query)).toBe(true);
    expect(Object.isFrozen(query.period)).toBe(true);
    expect(Object.isFrozen(query.agents)).toBe(true);
    expect(getUsageQueryKey(query)).toBe(first);
    raw.period.endMs = 300;
    raw.agents.push('c');
    expect(getUsageQueryKey(raw)).not.toBe(first);

    const batch = normalizeUsageQueryBatchInput({ queries: [query, raw] });
    const batchKey = getUsageQueryBatchKey(batch);
    expect(normalizeUsageQueryBatchInput(batch)).toBe(batch);
    expect(Object.isFrozen(batch.queries)).toBe(true);
    expect(getUsageQueryBatchKey(batch)).toBe(batchKey);
    raw.period.endMs = 400;
    expect(getUsageQueryBatchKey({ queries: [query, raw] })).not.toBe(batchKey);
  });
  it('keeps comparison demand on the host while preserving default comparison reads', () => {
    const full = normalizeUsageQuery({ period: { startMs: 100, endMs: 200 } });
    const currentOnly = normalizeUsageQuery({ ...full, includeComparison: false });
    expect(getUsageQueryKey(currentOnly)).not.toBe(getUsageQueryKey(full));
    expect(usageQueryToAnalyticsRequest(currentOnly)).toEqual(usageQueryToAnalyticsRequest(full));
    expect(usageQueryToAnalyticsRequest(currentOnly)).not.toHaveProperty('includeComparison');
  });
  it('demands explicit contribution delivery without changing the accounting wire query', () => {
    const summary = normalizeUsageQuery({ period: { startMs: 100, endMs: 200 } });
    const detail = normalizeUsageQuery({ ...summary, includeContributions: true });
    expect(getUsageQueryKey(detail)).not.toBe(getUsageQueryKey(summary));
    expect(usageQueryToAnalyticsRequest(detail)).toEqual(usageQueryToAnalyticsRequest(summary));
    expect(usageQueryToAnalyticsRequest(detail)).not.toHaveProperty('includeContributions');
  });
  it('keeps summary Work demand distinct while using the same accounting request', () => {
    const detail = normalizeUsageQuery({});
    const summary = normalizeUsageQuery({ workProjection: 'summary' });
    expect(detail.workProjection).toBe('detail');
    expect(summary.workProjection).toBe('summary');
    expect(getUsageQueryKey(summary)).not.toBe(getUsageQueryKey(detail));
    expect(usageQueryToAnalyticsRequest(summary)).toEqual(usageQueryToAnalyticsRequest(detail));
    expect(usageQueryToAnalyticsRequest(summary)).not.toHaveProperty('workProjection');
  });
  it('preserves witnessed execution selection separately from producer sources', () => {
    const query = normalizeUsageQuery({ execution: 'happier', sources: ['native'] });
    const request = usageQueryToAnalyticsRequest(query);
    expect(request.filters).toMatchObject({ execution: 'happier', sources: ['native'] });
    expect(usageAnalyticsRequestToQuery(request)).toMatchObject({ execution: 'happier', sources: ['native'] });
    expect(getUsageQueryKey(query)).not.toBe(getUsageQueryKey({ sources: ['native'] }));
    expect(usageQueryToAnalyticsRequest(normalizeUsageQuery({})).filters).not.toHaveProperty('execution');
  });
  it('preserves rolling intent through stored reads without admitting malformed or mixed period modes', () => {
    const stored = createStoredReadSchema(UsageQuerySchema);
    for (const period of [{ relative: '90days' }, { startMs: 100, endMs: 200 }, {}]) {
      expect(stored.parse({ period }).period).toEqual(period);
    }
    expect(stored.parse({ period: { relative: '90days', retired: true } }).period).toEqual({ relative: '90days' });
    for (const period of [{ relative: 'invalid' }, { relative: '90days', startMs: 100 }, { relative: 'invalid', endMs: 200 }]) {
      expect(stored.safeParse({ period }).success).toBe(false);
      expect(UsageQuerySchema.safeParse({ period }).success).toBe(false);
    }
  });
  it('keeps accounting-only consumers on an explicit tokens/cost boundary rather than else-tokens', () => {
    expect(usageQuery.UsageAccountingMetricSchema.parse('tokens')).toBe('tokens');
    expect(usageQuery.UsageAccountingMetricSchema.parse('cost')).toBe('cost');
    for (const metric of ['sessions', 'busy', 'steering', 'peakParallel']) {
      expect(usageQuery.UsageAccountingMetricSchema.safeParse(metric).success).toBe(false);
      expect(normalizeUsageQuery({ metric }).metric).toBe(metric);
    }
  });
  it('keys eligible public history separately and preserves the ordinary older-server request shape', () => {
    const ordinary = normalizeUsageQuery({});
    const explicitOrdinary = normalizeUsageQuery({ population: 'all_personal_history' });
    const publicHistory = normalizeUsageQuery({ population: 'public_eligible_personal' });
    expect(getUsageQueryKey(ordinary)).toBe(getUsageQueryKey(explicitOrdinary));
    expect(getUsageQueryKey(publicHistory)).not.toBe(getUsageQueryKey(ordinary));
    expect(usageQueryToAnalyticsRequest(ordinary)).not.toHaveProperty('population');
    expect(usageQueryToAnalyticsRequest(explicitOrdinary)).not.toHaveProperty('population');
    expect(usageQueryToAnalyticsRequest(publicHistory).population).toBe('public_eligible_personal');
    expect(usageAnalyticsRequestToQuery(usageQueryToAnalyticsRequest(publicHistory)).population).toBe('public_eligible_personal');
    // A predecessor's strict request parser must reject, not silently broaden, this new selection.
    const predecessor = z.omit(UsageAnalyticsQueryRequestSchema, { population: true });
    expect(predecessor.safeParse(usageQueryToAnalyticsRequest(publicHistory)).success).toBe(false);
  });
  it.each(['sessions', 'busy', 'steering', 'peakParallel'])('keeps %s presentation distinct without changing accounting transport', metric => {
    const base = normalizeUsageQuery({ period: { startMs: 100, endMs: 200 }, agents: ['claude'] });
    const query = normalizeUsageQuery({ ...base, metric });
    expect(query.metric).toBe(metric);
    expect(getUsageQueryKey(query)).not.toBe(getUsageQueryKey(base));
    expect(usageQueryToAnalyticsRequest(query)).toEqual(usageQueryToAnalyticsRequest(base));
    expect(usageQueryToAnalyticsRequest(query)).not.toHaveProperty('metric');
  });
  it('keys current-only quota demand without forwarding it to accounting', () => {
    expect(normalizeUsageQuery({}).includeQuotaHistory).toBe(true);
    const head = normalizeUsageQuery({ includeQuotaHistory: false });
    expect(getUsageQueryKey(head)).not.toBe(getUsageQueryKey({}));
    expect(getUsageQueryKey({ includeQuotaHistory: true })).toBe(getUsageQueryKey({}));
    expect(usageQueryToAnalyticsRequest(head)).not.toHaveProperty('includeQuotaHistory');
    expect(usageQueryToAnalyticsRequest(head)).toEqual(usageQueryToAnalyticsRequest(normalizeUsageQuery({})));
  });
  it('keeps quota-only demand distinct and out of the accounting transport', () => {
    const full = normalizeUsageQuery({});
    const quota = normalizeUsageQuery({ includeAccounting: false });
    expect(getUsageQueryKey(quota)).not.toBe(getUsageQueryKey(full));
    expect(usageQueryToAnalyticsRequest(quota)).not.toHaveProperty('includeAccounting');
  });
  it('keys Session evidence demand without forwarding it to the accounting server', () => {
    const full = normalizeUsageQuery({});
    const accountingOnly = normalizeUsageQuery({ includeSessionEvidence: false, includeWorkEvidence: false, includeInsights: true });
    expect(full.includeSessionEvidence).toBe(true);
    expect(full.includeWorkEvidence).toBe(true);
    expect(getUsageQueryKey({})).toBe(getUsageQueryKey({ includeSessionEvidence: true }));
    expect(getUsageQueryKey(accountingOnly)).not.toBe(getUsageQueryKey({ includeInsights: true }));
    expect(usageQueryToAnalyticsRequest(accountingOnly)).toMatchObject({ includeInsights: true });
    expect(usageQueryToAnalyticsRequest(accountingOnly)).not.toHaveProperty('includeSessionEvidence');
    expect(usageQueryToAnalyticsRequest(accountingOnly)).not.toHaveProperty('includeWorkEvidence');
  });
  it('separates transcript demand from Session evidence and keeps it off the accounting transport', () => {
    const summaryOnly = normalizeUsageQuery({ includeTranscriptEvidence: false });
    expect(normalizeUsageQuery({}).includeTranscriptEvidence).toBe(true);
    expect(summaryOnly.includeSessionEvidence).toBe(true);
    expect(getUsageQueryKey({})).toBe(getUsageQueryKey({ includeTranscriptEvidence: true }));
    expect(getUsageQueryKey(summaryOnly)).not.toBe(getUsageQueryKey({}));
    expect(UsageAnalyticsQueryRequestSchema.safeParse(usageQueryToAnalyticsRequest(summaryOnly)).success).toBe(true);
    expect(usageQueryToAnalyticsRequest(summaryOnly)).not.toHaveProperty('includeTranscriptEvidence');
  });
  it('retains a relative period as semantic input and resolves it at the analytics read clock', () => {
    const now = Date.parse('2026-10-11T20:30:00Z');
    const query = normalizeUsageQuery({ period: { relative: '7days' }, breakdown: ['agent'] });
    expect(query.period).toEqual({ relative: '7days' });
    expect(usageQueryToAnalyticsRequest(query, now).dateRange).toEqual({ startMs: Date.parse('2026-10-05T00:00:00Z'), endMs: now });
    expect(usageQueryToAnalyticsRequest(query, now + 86_400_000).dateRange).toEqual({ startMs: Date.parse('2026-10-06T00:00:00Z'), endMs: now + 86_400_000 });
    expect(getUsageQueryKey(query)).toBe(getUsageQueryKey({ ...query, period: { relative: '7days' } }));
    expect(UsageQuerySchema.safeParse({ period: { relative: '7days', startMs: 100 } }).success).toBe(false);
    expect(usageQueryToAnalyticsRequest(normalizeUsageQuery({ period: { relative: 'today' }, timeZoneOffsetMinutes: 120 }),
      Date.parse('2026-10-11T00:30:00Z')).dateRange).toEqual({ startMs: Date.parse('2026-10-10T22:00:00Z'), endMs: Date.parse('2026-10-11T00:30:00Z') });
    expect(usageQueryToAnalyticsRequest(normalizeUsageQuery({ period: { relative: 'all' } }), now).dateRange).toEqual({ endMs: now });
    const epoch = normalizeUsageQuery({ period: { startMs: 0, endMs: now } });
    expect(usageQueryToAnalyticsRequest(epoch, now).dateRange).toEqual({ startMs: 0, endMs: now });
    expect(getUsageQueryKey(epoch)).not.toBe(getUsageQueryKey({ period: { relative: 'all' } }));
    const absolute = normalizeUsageQuery({ period: { startMs: 100, endMs: 200 } });
    expect(usageQueryToAnalyticsRequest(absolute, now).dateRange).toEqual(absolute.period);
  });
  it.each([['7days', 7], ['30days', 30], ['90days', 90], ['year', 365]] as const)('reads %s as exactly %s calendar days including today', (relative, days) => {
    const now = Date.parse('2026-10-11T20:30:00Z');
    const query = normalizeUsageQuery({ period: { relative }, timeZoneOffsetMinutes: 120 });
    expect(usageQueryToAnalyticsRequest(query, now).dateRange).toEqual({
      startMs: Date.parse('2026-10-10T22:00:00Z') - (days - 1) * 86_400_000, endMs: now,
    });
  });
  it('retains Usage choice dependencies for ordinary Action editors, not only widget consumers', () => {
    const query = { period: { startMs: 1, endMs: 2 }, agents: ['claude'], breakdown: ['source', 'machine'] };
    expect(projectInputOptionsDependencies({ query, prompt: 'unrelated' })).toEqual({ query });
    expect(projectInputOptionsDependencies(query)).toEqual(query);
  });
  it('keys equivalent selected sets while preserving every distinct filter and output clause', () => {
    const query = normalizeUsageQuery({ period: { startMs: 100, endMs: 200 }, agents: ['codex', 'claude', 'codex'], session: 'one' });
    expect(getUsageQueryKey(query)).toBe(getUsageQueryKey({ ...query, agents: ['claude', 'codex'], session: ['one'] }));
    for (const change of [{ costBasis: 'reported' }, { metric: 'cost' }, { machines: ['machine'] }, { projects: ['project'] },
      { session: ['two'] }, { sources: ['native'] }, { modelIds: ['model'] }, { includeSeries: false }, { includeInsights: true }, { topLimit: 3 }]) {
      expect(getUsageQueryKey({ ...query, ...change })).not.toBe(getUsageQueryKey(query));
    }
  });
  it('round-trips canonical range, bucket, multiple Session filters and all admitted output flags', () => {
    const request = UsageAnalyticsQueryRequestSchema.parse({ dateRange: { startMs: 100, endMs: 200 }, granularity: 'hour', timeZoneOffsetMinutes: 60,
      filters: { sessionIds: ['two', 'one'], machineIds: ['machine'], modelIds: ['model'], workspaceIds: ['workspace'], backendModes: ['remote'] },
      breakdowns: ['model'], includeSeries: false, includeInsights: true, includeActivity: true, activityResolution: 'weekdayHour', topLimit: 101 });
    const roundTrip = usageQueryToAnalyticsRequest(usageAnalyticsRequestToQuery(request));
    expect(roundTrip).toMatchObject({ ...request, filters: { ...request.filters, sessionIds: ['one', 'two'] } });
    expect(roundTrip.topLimit).toBe(101);
    expect(UsageQuerySchema.safeParse({ accountId: 'other' }).success).toBe(false);
  });
  it('declares scope and cost basis independently followable, with own presentation paths', () => {
    const fields = USAGE_QUERY_INPUT_FIELDS.map(field => InputFieldHintSchema.parse(field));
    expect(fields.filter(field => field.contextMode === 'own').map(field => field.path)).toEqual(['metric', 'breakdown']);
    expect(fields.filter(field => field.contextMode === 'follow').map(field => field.path)).toEqual(['period', 'agents', 'machines', 'projects', 'sources', 'session', 'costBasis']);
  });
  it('offers typed multiselect scope choices with an unrestricted empty selection', () => {
    for (const path of ['agents', 'machines', 'projects', 'sources'] as const) {
      const field = USAGE_QUERY_INPUT_FIELDS.find(field => field.path === path)!;
      expect(field.widget).toBe('multiselect');
      expect(field.optionsSourceId).toBe(`usage.filters.${path}`);
      expect(field.placeholder).toBe(`All ${path}`);
      expect(normalizeUsageQuery({ [path]: [] })[path]).toEqual([]);
    }
  });
  it('offers Session editing only when the surface actually declares its Session slot', () => {
    const spec = { inputHints: { fields: [...USAGE_QUERY_INPUT_FIELDS] } };
    const input = normalizeUsageQuery({ session: 'retained-pin' });
    const visible = (contextSlots: readonly string[]) => resolveEffectiveInputFields(spec, input, { contextSlots }).map(field => field.path);
    expect(visible(['period', 'projects'])).not.toContain('session');
    expect(visible(['session'])).toContain('session');
    expect(visible([])).toContain('metric');
    // A standalone query form has no surface contract and can still choose any query scope.
    expect(resolveEffectiveInputFields(spec, input).map(field => field.path)).toContain('session');
    expect(usageQueryToAnalyticsRequest(input).filters?.sessionIds).toEqual(['retained-pin']);
  });
  it('offers the Period as its few named choices in place, keeping a stored custom range nameable (final-acceptance 4)', () => {
    const field = USAGE_QUERY_INPUT_FIELDS.find(field => field.path === 'period')!;
    expect(field.optionsSourceId).toBe('usage.query.period');
    expect(readUsagePeriodOptions(undefined).map(option => option.value)).toEqual(
      ['today', '7days', '30days', '90days', 'year', 'all'].map(relative => ({ relative })));
    const custom = { startMs: 100, endMs: 200 };
    expect(readUsagePeriodOptions(custom).at(-1)?.value).toEqual(custom);
    expect(readUsagePeriodOptions({ relative: '7days' })).toHaveLength(6);
    // The Usage page's unbounded All time is the All time choice, not a second one.
    expect(readUsagePeriodOptions({})).toHaveLength(6);
    expect(readUsagePeriodOptions({}).at(-1)?.value).toEqual({});
  });
  it('offers the user-facing breakdown dimensions without narrowing admitted advanced queries', () => {
    const field = USAGE_QUERY_INPUT_FIELDS.find(field => field.path === 'breakdown')!;
    expect(field.widget).toBe('select');
    expect(field.optionsSourceId).toBe('usage.query.breakdown');
    expect(normalizeUsageQuery({ breakdown: ['session', 'workspace', 'backendMode'] }).breakdown)
      .toEqual(['backendMode', 'session', 'workspace']);
  });
});
