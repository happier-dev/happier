import { describe, expect, it } from 'vitest';

import { resolveGeminiAccountUsageAvailability } from './usage.js';

describe('resolveGeminiAccountUsageAvailability', () => {
  it('reports unsupported usage without creating a fake provider-global gauge', () => {
    expect(resolveGeminiAccountUsageAvailability()).toEqual({
      providerId: 'gemini',
      status: 'unsupported',
      reason: 'no_verified_usage_source',
      displayGauge: false,
      canonicalRecord: null,
    });
  });
});
