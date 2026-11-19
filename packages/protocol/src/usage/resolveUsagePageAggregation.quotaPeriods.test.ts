import { expect, it } from 'vitest';

import { getUsageQueryKey, normalizeUsageQuery } from '../inputs/usageQuery.js';
import { ConnectedServiceQuotaGetResultV1Schema } from '../connect/providerAccountUsageHistorySchemasV1.js';
import { resolveUsagePageAggregation, resolveUsageQuotaPageAggregation } from './resolveUsagePageAggregation.js';
import { bundledUsageModelPriceCatalog } from './usageModelPriceCatalog.js';

it.each(['accounting', 'quota-only'] as const)('keeps each admitted quota period and its source state in its own %s slice', kind => {
  const narrow = normalizeUsageQuery({ period: { startMs: 200, endMs: 400 },
    includeAccounting: kind === 'accounting', includeSessionEvidence: false, includeWorkEvidence: false });
  const wide = normalizeUsageQuery({ ...narrow, period: { startMs: 100, endMs: 400 } });
  const source = { bindingKind: 'account' as const,
    ref: { service: { pluginId: 'example.usage', localId: 'quota' }, accountId: 'work' } };
  const read = ConnectedServiceQuotaGetResultV1Schema.parse({ source, current: null, pace: [], targets: [],
    waitingWork: { status: 'unavailable', reason: 'unsupported' } });
  const specific = { status: 'available' as const, asOfMs: 350, value: [read],
    sources: [{ source: 'quota:work', status: 'available' as const, asOfMs: 350 }] };
  const unavailable = { status: 'error' as const, errorCode: 'denied',
    sources: [{ source: 'quota:work', status: 'error' as const, errorCode: 'denied' }] };
  // The host has already acquired each distinct period. Attachment must never
  // substitute a wider sibling's facts or source state for that admitted read.
  const input = { queries: [narrow, wide], nowMs: 400,
    quotaByQuery: new Map<string, typeof specific | typeof unavailable>([
      [getUsageQueryKey(narrow), specific], [getUsageQueryKey(wide), unavailable],
    ]),
    quota: { status: 'pending' as const },
    sources: [{ source: 'quota:unrelated-period', status: 'pending' as const }] };
  const batch = kind === 'accounting' ? resolveUsagePageAggregation(input, bundledUsageModelPriceCatalog)
    : resolveUsageQuotaPageAggregation(input);
  const first = batch.results.find(slice => slice.key === getUsageQueryKey(narrow))!;
  const second = batch.results.find(slice => slice.key === getUsageQueryKey(wide))!;
  expect(first.quota).toEqual([read]);
  expect(first.sources.filter(row => row.source === 'quota' || row.source.startsWith('quota:'))).toEqual([
    { source: 'quota', status: 'available', asOfMs: 350 }, ...specific.sources,
  ]);
  expect(second.quota).toBeUndefined();
  expect(second.sources.filter(row => row.source === 'quota' || row.source.startsWith('quota:'))).toEqual([
    { source: 'quota', status: 'error', errorCode: 'denied' }, ...unavailable.sources,
  ]);
  if (kind === 'accounting') {
    expect(first.planInsights?.accounts.map(account => account.source)).toEqual([source]);
    expect(second.planInsights?.accounts).toEqual([]);
  }
});
