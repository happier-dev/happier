import { describe, expect, it } from 'vitest';

import { isLoopbackManagedOpenCodeBaseUrl } from './sharedManagedServer';

describe('isLoopbackManagedOpenCodeBaseUrl', () => {
  it('accepts bracketed IPv6 loopback URLs', () => {
    expect(isLoopbackManagedOpenCodeBaseUrl('http://[::1]:4096')).toBe(true);
  });
});
