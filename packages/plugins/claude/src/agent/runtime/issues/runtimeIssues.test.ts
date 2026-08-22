import { describe, expect, it } from 'vitest';

import { mapClaudeProviderFailureToUsageDetails } from './runtimeIssues.js';

describe('mapClaudeProviderFailureToUsageDetails', () => {
  it('normalizes numeric provider reset epochs at the shared boundary', () => {
    const cases = [
      [1_700_000_000, 1_700_000_000_000],
      [1_700_000_000_000, 1_700_000_000_000],
      [1_000_000_000_000, 1_000_000_000_000],
      ['1700000000', 1_700_000_000_000],
      ['1700000000000', 1_700_000_000_000],
      ['100000000000', 100_000_000_000_000],
      ['1000000000000', 1_000_000_000_000],
    ] as const;

    for (const [value, expected] of cases) {
      expect(mapClaudeProviderFailureToUsageDetails({
        status: 429,
        reset_at: value,
      })).toMatchObject({
        resetAtMs: expected,
      });
    }
  });
});
