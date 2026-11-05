import { describe, expect, it } from 'vitest';
import { decodeBase64 } from '../crypto/base64.js';
import { normalizeUsageQuery } from '../inputs/usageQuery.js';
import { UsageAnalyticsQueryResponseSchema } from './usageAnalyticsContracts.js';
import { buildUsageFileResult, UsageExportInputSchema, UsageFileResultSchema } from './usageExport.js';
import { resolveUsagePageAggregation, UsageQueryBatchResultSchema } from './resolveUsagePageAggregation.js';

const tokens = { input: 10, output: 2, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 12 };
const response = UsageAnalyticsQueryResponseSchema.parse({ v: 1,
  totals: { eventCount: 1, tokens, cost: { reportedUsd: 0, estimatedUsd: 0, currency: 'USD' } },
  costFacts: [{ kind: 'unpriced', currency: 'USD', amountUsd: null, tokens, eventCount: 1,
    source: 'native', asOfMs: 100, complete: false }],
  breakdowns: { session: [{ key: 'private-name', label: 'Private session', eventCount: 1, tokens,
    cost: { reportedUsd: 0, estimatedUsd: 0, currency: 'USD' } }] },
});
const query = normalizeUsageQuery({ costBasis: 'estimated' });

describe('authorized selected-field usage file bytes', () => {
  it('exports authorized client coverage from the admitted query producer in every document format', () => {
    const accounting = UsageAnalyticsQueryResponseSchema.parse({ ...response, coverage: {
      status: 'partial', reasons: ['incomplete_history'], missingDimensions: [],
      sources: [{ source: 'native', path: 'native', status: 'partial', machineId: 'machine', eventCount: 1, asOfMs: 100 }],
      range: { complete: false }, ranked: [],
    } });
    const batch = UsageQueryBatchResultSchema.parse(resolveUsagePageAggregation({ queries: [query],
      accounting: [{ query, value: accounting, status: 'available', asOfMs: 100 }],
      sourceLocations: [{ machineId: 'machine', displayLocation: 'Private workstation' }],
    }));
    const value = batch.results[0]!.accounting!;
    expect(value.coverage?.sources[0]).toMatchObject({ displayLocation: 'Private workstation' });
    for (const format of ['json', 'csv', 'text'] as const) {
      const file = UsageFileResultSchema.parse(buildUsageFileResult({ query, format, fields: ['coverage'] }, value, 100));
      const content = new TextDecoder().decode(decodeBase64(file.base64));
      expect(content).toContain('Private workstation');
      expect(content).not.toContain('Private session');
      const unselected = buildUsageFileResult({ query, format, fields: ['totals'] }, value, 100);
      expect(new TextDecoder().decode(decodeBase64(unselected.base64))).not.toContain('Private workstation');
    }
  });
  it('keeps monetary absence and selected basis explicit in every format without unselected labels', () => {
    for (const format of ['json', 'csv', 'text'] as const) {
      const result = buildUsageFileResult({ query, format, fields: ['costFacts'] }, response, 100);
      const content = new TextDecoder().decode(decodeBase64(result.base64));
      expect(content).toContain('estimated');
      expect(content).toContain('unpriced');
      expect(content).toContain('null');
      expect(content).not.toContain('private-name');
      expect(content).not.toContain('reportedUsd');
      expect(result.fields).toEqual(['costFacts']);
      expect(UsageFileResultSchema.safeParse(result).success).toBe(true);
    }
  });
  it('rejects forged authority, unknown sections, destination effects and unsafe file paths', () => {
    for (const field of ['summary', 'sessionIds', 'sessionMembership']) {
      expect(UsageExportInputSchema.safeParse({ query, format: 'json', fields: [field] }).success).toBe(false);
    }
    expect(UsageExportInputSchema.safeParse({ query, format: 'json', fields: ['credentials'] }).success).toBe(false);
    expect(UsageExportInputSchema.safeParse({ query, format: 'json', fields: ['totals'], destination: 'upload' }).success).toBe(false);
    const file = buildUsageFileResult({ query, format: 'json', fields: ['totals'] }, response, 100);
    expect(UsageFileResultSchema.safeParse({ ...file, fileName: '../usage.json' }).success).toBe(false);
    expect(UsageFileResultSchema.safeParse({ ...file, publicUrl: 'https://example.test' }).success).toBe(false);
    expect(UsageFileResultSchema.safeParse({ ...file, fields: ['credentials'] }).success).toBe(false);
    expect(buildUsageFileResult({ query, format: 'json', fields: ['totals'] }, response, Number.MAX_SAFE_INTEGER).fileName)
      .toBe(`usage-${Number.MAX_SAFE_INTEGER}.json`);
  });
});
