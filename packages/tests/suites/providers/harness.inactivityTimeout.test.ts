import { describe, expect, it } from 'vitest';

import { resolveProviderInactivityTimeoutMs } from '../../src/testkit/providers/harness';

describe('providers harness: inactivity timeout', () => {
  it('uses default inactivity timeout when unset', () => {
    expect(resolveProviderInactivityTimeoutMs(undefined, 240_000)).toBe(120_000);
  });

  it('clamps inactivity timeout to max wait', () => {
    expect(resolveProviderInactivityTimeoutMs('500000', 240_000)).toBe(240_000);
  });

  it('uses a longer default inactivity timeout for kimi', () => {
    expect(resolveProviderInactivityTimeoutMs(undefined, 240_000, 'kimi')).toBe(240_000);
  });
});
