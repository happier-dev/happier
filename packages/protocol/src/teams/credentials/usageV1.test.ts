import { describe, expect, it } from 'vitest';
import { buildTeamCredentialUsageCsv } from './usageExportV1.js';
import { aggregateUsageContributionCosts, createEmptyUsageCost, createEmptyUsageTokens } from '../../usage/usageAggregation.js';
import { projectUsageContributionTotals } from '../../usage/usageActivityProjectionFacts.js';

import {
  TeamCredentialUsageCapabilitiesV1Schema,
  TeamCredentialUsageLimitDenialV1Schema,
  TeamCredentialUsageLimitListInputV1Schema,
  TeamCredentialUsageLimitListOutputV1Schema,
  TeamCredentialUsageQueryInputV1Schema,
  TeamCredentialUsageQueryResultV1Schema,
} from './usageV1.js';

describe('Team credential usage capability and denial contracts', () => {
  it('requires explicit limit coverage so omitted capability data fails closed', () => {
    expect(TeamCredentialUsageCapabilitiesV1Schema.safeParse({
      inferenceRequests: 'available', totalTokens: 'available', costUsd: 'unavailable',
    }).success).toBe(false);
    expect(TeamCredentialUsageCapabilitiesV1Schema.parse({
      inferenceRequests: 'available', totalTokens: 'available', costUsd: 'unavailable',
      limitCoverage: 'brokered_only',
    }).limitCoverage).toBe('brokered_only');
  });

  it('accepts the closed recipient-safe denial shape and rejects private limit facts', () => {
    const denial = {
      metric: 'total_tokens',
      remaining: '0',
      resetsAtUtc: '2026-09-15T00:00:00.000Z',
    } as const;
    expect(TeamCredentialUsageLimitDenialV1Schema.parse(denial)).toEqual(denial);
    expect(TeamCredentialUsageLimitDenialV1Schema.safeParse({
      ...denial, limitId: 'private-limit', maximum: '100', memberId: 'private-member',
    }).success).toBe(false);
  });
});

const usageLimit = {
  id: 'limit-1',
  subjectKind: 'resource',
  subjectId: '',
  period: 'day',
  metric: 'inference_requests',
  maximum: '10',
  enabled: true,
  currentWindow: {
    recorded: '3',
    resetsAtUtc: '2026-09-09T00:00:00.000Z',
  },
} as const;

describe('Team credential usage query contract', () => {
  it('accepts Team and Home subjects without requiring an arbitrary credential', () => {
    for (const subject of [{ kind: 'team', teamId: 'team-1' }, { kind: 'home' }]) {
      expect(TeamCredentialUsageQueryInputV1Schema.parse({ subject, startMs: 0, endMs: 10 }))
        .toMatchObject({ subject, granularity: 'day', costMode: 'auto' });
    }
  });

  it('rejects ambiguous, missing and unknown authority subjects', () => {
    for (const selection of [
      {},
      { resourceId: 'resource-1', subject: { kind: 'home' } },
      { subject: { kind: 'team' } },
      { subject: { kind: 'home', teamId: 'team-1' } },
      { subject: { kind: 'account', accountId: 'another-person' } },
    ]) {
      expect(TeamCredentialUsageQueryInputV1Schema.safeParse({ ...selection, startMs: 0, endMs: 10 }).success)
        .toBe(false);
    }
  });

  it('admits every cost mode the shared usage analytics request admits, and rejects others', () => {
    const base = { resourceId: 'resource-1', startMs: 0, endMs: 10 };
    for (const costMode of ['auto', 'reported', 'estimated', 'api_equivalent'] as const) {
      expect(TeamCredentialUsageQueryInputV1Schema.parse({ ...base, costMode }).costMode).toBe(costMode);
    }
    expect(TeamCredentialUsageQueryInputV1Schema.safeParse({ ...base, costMode: 'invoice' }).success).toBe(false);
  });
});

describe('Team credential usage-limit paging contracts', () => {
  it('accepts an opaque cursor and a bounded page size', () => {
    expect(TeamCredentialUsageLimitListInputV1Schema.parse({
      resourceId: 'resource-1',
      cursor: 'opaque-cursor',
      limit: 25,
    })).toEqual({
      resourceId: 'resource-1',
      cursor: 'opaque-cursor',
      limit: 25,
    });

    expect(TeamCredentialUsageLimitListInputV1Schema.parse({
      resourceId: 'resource-1',
    })).toEqual({ resourceId: 'resource-1', limit: 50 });

    expect(TeamCredentialUsageLimitListInputV1Schema.safeParse({
      resourceId: 'resource-1',
      limit: 0,
    }).success).toBe(false);

    expect(TeamCredentialUsageLimitListInputV1Schema.safeParse({
      resourceId: 'resource-1',
      limit: 101,
    }).success).toBe(false);
  });

  it('projects one page with an explicit continuation cursor', () => {
    expect(TeamCredentialUsageLimitListOutputV1Schema.parse({
      limits: [usageLimit],
      nextCursor: 'next-page',
    })).toEqual({ limits: [usageLimit], nextCursor: 'next-page' });

    expect(TeamCredentialUsageLimitListOutputV1Schema.safeParse({
      limits: [usageLimit],
    }).success).toBe(false);
  });

  it('does not impose a whole-resource 1,000-limit ceiling on the wire contract', () => {
    const limits = Array.from({ length: 1_001 }, (_, index) => ({
      ...usageLimit,
      id: `limit-${index}`,
    }));

    expect(TeamCredentialUsageLimitListOutputV1Schema.safeParse({
      limits,
      nextCursor: null,
    }).success).toBe(true);
  });
});

describe('Team credential usage coverage contract', () => {
  it('exports measured token totals and breakdown floors without replacing reported zero', () => {
    const tokens = { input: 100, output: null, reasoning: null, cacheRead: null, cacheWrite: null, total: null };
    const cost = createEmptyUsageCost();
    const result = TeamCredentialUsageQueryResultV1Schema.parse({ v: 1,
      totals: { eventCount: 2, requestCount: 0, tokens: { ...tokens, total: 10, measured: { total: 110, fromParts: true } }, cost },
      series: [], nextCursor: null, limits: [], breakdown: [
        { key: 'parts', totals: { eventCount: 1, requestCount: 0, tokens, cost } },
        { key: 'zero', totals: { eventCount: 1, requestCount: 0, tokens: { ...tokens, total: 0 }, cost } },
      ], coverage: { requestAdmissionCount: 0, agentObservationCount: 2, externalTerminalObservationCount: 0,
        directRecordedUseOnly: false, requestCountCoverage: 'complete', tokenCoverage: 'partial', costCoverage: 'unavailable',
        unobservedExternalRequestCount: 0 } });
    const lines = buildTeamCredentialUsageCsv({ resourceName: 'Shared provider', result, startMs: 0, endMs: 1000,
      breakdown: 'member', breakdownComplete: true, costMode: 'auto' }).trim().split('\n').map(line => line.split(','));
    expect(lines.slice(1).map(row => row[lines[0]!.indexOf('tokens')])).toEqual(['110', '100', '0']);
  });

  it('exports canonical empty population zeros without turning unavailable coverage into missing measurements', () => {
    const missing = [{ eventCount: 1, tokens: createEmptyUsageTokens(), cost: createEmptyUsageCost() }];
    for (const rows of [[], missing]) {
      const totals = projectUsageContributionTotals(rows, aggregateUsageContributionCosts(rows, 'auto'));
      const result = TeamCredentialUsageQueryResultV1Schema.parse({ v: 1,
        totals: { eventCount: totals.eventCount, requestCount: 0, tokens: totals.tokens, cost: totals.cost },
        series: [], nextCursor: null, limits: [],
        coverage: { requestAdmissionCount: 0, agentObservationCount: rows.length, externalTerminalObservationCount: 0,
          directRecordedUseOnly: false, requestCountCoverage: 'brokered_only', tokenCoverage: 'unavailable',
          costCoverage: 'unavailable', unobservedExternalRequestCount: 0 } });
      const lines = buildTeamCredentialUsageCsv({ resourceName: 'Shared provider', result, startMs: 0, endMs: 1000,
        breakdown: null, breakdownComplete: true, costMode: 'estimated' }).trim().split('\n').map(line => line.split(','));
      const cells = ['tokens', 'cost', 'reported_cost', 'estimated_cost'].map(field => lines[1]![lines[0]!.indexOf(field)]);
      expect(cells).toEqual(rows.length === 0 ? ['0', '0', '0', '0'] : ['', '', '', '']);
      expect(lines[1]![lines[0]!.indexOf('token_coverage')]).toBe('unavailable');
      expect(lines[1]![lines[0]!.indexOf('cost_coverage')]).toBe('unavailable');
    }
  });
  it('exports unknown measurements as blank cells and measured zero even with partial coverage', () => {
    const tokens = { input: null, output: null, reasoning: null, cacheRead: null, cacheWrite: null, total: null };
    const cost = { reportedUsd: null, estimatedUsd: null, currency: 'USD', costSource: 'none' as const };
    const result = TeamCredentialUsageQueryResultV1Schema.parse({ v: 1,
      totals: { eventCount: 1, requestCount: 0, tokens, cost }, series: [], nextCursor: null, limits: [],
      breakdown: [{ key: 'measured', totals: { eventCount: 1, requestCount: 0, tokens: { ...tokens, total: 0 },
        cost: { ...cost, reportedUsd: 0, costSource: 'provider_reported' } } }],
      coverage: { requestAdmissionCount: 0, agentObservationCount: 1, externalTerminalObservationCount: 0,
        directRecordedUseOnly: false, requestCountCoverage: 'complete', tokenCoverage: 'partial', costCoverage: 'partial', unobservedExternalRequestCount: 0 } });
    const lines = buildTeamCredentialUsageCsv({ resourceName: 'Shared provider', result, startMs: 0, endMs: 1000,
      breakdown: 'member', breakdownComplete: true, costMode: 'auto' }).trim().split('\n').map(line => line.split(','));
    const fields = ['tokens', 'cost', 'reported_cost', 'estimated_cost'];
    const cells = (row: number) => fields.map(field => lines[row]![lines[0]!.indexOf(field)]);
    expect(cells(1)).toEqual(['', '', '', '']);
    expect(cells(2)).toEqual(['0', '0', '0', '']);
  });
  it('exports the selected cost mode for totals and breakdown rows', () => {
    const tokens = { input: 1, output: 2, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 3 };
    const cost = { reportedUsd: 1, estimatedUsd: 2, currency: 'USD', costSource: 'provider_reported' as const };
    const result = TeamCredentialUsageQueryResultV1Schema.parse({ v: 1,
      totals: { eventCount: 1, requestCount: 1, tokens, cost }, series: [], nextCursor: null, limits: [],
      breakdown: [{ key: 'member-1', totals: { eventCount: 1, requestCount: 1, tokens, cost } }],
      coverage: { requestAdmissionCount: 1, agentObservationCount: 1, externalTerminalObservationCount: 0,
        directRecordedUseOnly: false, requestCountCoverage: 'complete', tokenCoverage: 'complete', costCoverage: 'partial', unobservedExternalRequestCount: 0 } });
    const lines = buildTeamCredentialUsageCsv({ resourceName: 'Shared provider', result, startMs: 0, endMs: 1000,
      breakdown: 'member', breakdownComplete: true, costMode: 'estimated' }).trim().split('\n').map(line => line.split(','));
    const costColumn = lines[0]!.indexOf('cost');
    expect(lines.slice(1).map(row => row[costColumn])).toEqual(['2', '2']);
  });
  it('requires independent completeness and disjoint observation counters', () => {
    const result = {
      v: 1,
      totals: {
        eventCount: 3,
        requestCount: 2,
        tokens: { input: 1, output: 2, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 3 },
        cost: {
          reportedUsd: 0, estimatedUsd: 0, invoiceUsd: 0, effectiveUsd: 0,
          billingContext: 'unknown', costSource: 'none', currency: 'USD',
        },
      },
      coverage: {
        requestAdmissionCount: 2,
        agentObservationCount: 1,
        externalTerminalObservationCount: 1,
        directRecordedUseOnly: false,
        requestCountCoverage: 'complete',
        tokenCoverage: 'partial',
        costCoverage: 'unavailable',
        unobservedExternalRequestCount: 1,
      },
      series: [],
      nextCursor: null,
      limits: [],
    } as const;

    expect(TeamCredentialUsageQueryResultV1Schema.parse(result).coverage).toEqual(result.coverage);
    expect(TeamCredentialUsageQueryResultV1Schema.safeParse({
      ...result,
      coverage: { ...result.coverage, costIncomplete: true },
    }).success).toBe(false);
  });
});
