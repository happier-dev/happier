import { describe, expect, it } from 'vitest';

import type { UsageQueryResultSlice } from './resolveUsagePageAggregation.js';
import { readUsageScopeOptions } from './usageFilterOptions.js';

const entry = (key: string, label?: string) => ({
  key,
  ...(label ? { label } : {}),
  eventCount: 1,
  tokens: {
    input: 1,
    output: 0,
    reasoning: 0,
    cacheRead: 0,
    cacheWrite: 0,
    total: 1,
  },
  cost: { reportedUsd: 0, estimatedUsd: 0, currency: 'USD' },
});

describe('readUsageScopeOptions Projects (owner 11-08)', () => {
  it('offers a grouped Project once, under its current anchor, for usage stamped by any of its checkouts', () => {
    const slices = [
      {
        accounting: {
          breakdowns: {
            project: [entry('payments', 'payments'), entry('nldw6')],
          },
        },
      },
    ] as unknown as UsageQueryResultSlice[];
    const anchorOf = (key: string) => (key === 'nldw6' ? 'payments' : key);
    expect([
      ...readUsageScopeOptions(slices, 'projects', [], anchorOf),
    ]).toEqual([['payments', 'payments']]);
    // Without the census the stamped keys stay as they are.
    expect(
      [...readUsageScopeOptions(slices, 'projects')].map(([key]) => key),
    ).toEqual(['payments', 'nldw6']);
  });
});
