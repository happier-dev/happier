import { describe, expect, it } from 'vitest';
import { getUsageQueryKey, normalizeUsageQuery, usageAnalyticsRequestToQuery, usageQueryToAnalyticsRequest, UsageQuerySchema, USAGE_QUERY_INPUT_FIELDS } from './usageQuery.js';
import { UsageAnalyticsQueryRequestSchema } from '../usage/usageAnalyticsContracts.js';
import { InputFieldHintSchema } from './inputFields.js';

describe('shared UsageQuery', () => {
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
      breakdowns: ['model'], includeSeries: false, includeInsights: true, includeActivity: true, activityResolution: 'weekdayHour', topLimit: 3 });
    const roundTrip = usageQueryToAnalyticsRequest(usageAnalyticsRequestToQuery(request));
    expect(roundTrip).toMatchObject({ ...request, filters: { ...request.filters, sessionIds: ['one', 'two'] } });
    expect(UsageQuerySchema.safeParse({ accountId: 'other' }).success).toBe(false);
  });
  it('declares scope and cost basis independently followable, with own presentation paths', () => {
    const fields = USAGE_QUERY_INPUT_FIELDS.map(field => InputFieldHintSchema.parse(field));
    expect(fields.filter(field => field.contextMode === 'own').map(field => field.path)).toEqual(['metric', 'breakdown']);
    expect(fields.filter(field => field.contextMode === 'follow').map(field => field.path)).toEqual(['period', 'agents', 'machines', 'projects', 'sources', 'session', 'costBasis']);
  });
});
