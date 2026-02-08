import { describe, expect, it } from 'vitest';

import { resolveProviderPermissionBlockTimeoutMs } from '../../src/testkit/providers/harness';

describe('providers harness: permission-block timeout', () => {
  it('uses default timeout when unset', () => {
    expect(resolveProviderPermissionBlockTimeoutMs(undefined, 240_000)).toBe(45_000);
  });

  it('clamps timeout to max wait', () => {
    expect(resolveProviderPermissionBlockTimeoutMs('500000', 120_000)).toBe(120_000);
  });
});
