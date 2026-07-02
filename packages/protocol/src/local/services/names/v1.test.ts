import { describe, expect, it } from 'vitest';

import { LocalServiceDnsLabelV1Schema } from './v1.js';

describe('LocalServiceDnsLabelV1Schema', () => {
  it('accepts DNS-safe route labels and rejects invalid host label shapes', () => {
    expect(LocalServiceDnsLabelV1Schema.parse('plugin-web-5173')).toBe('plugin-web-5173');
    expect(LocalServiceDnsLabelV1Schema.safeParse('-plugin-web').success).toBe(false);
    expect(LocalServiceDnsLabelV1Schema.safeParse('plugin_web').success).toBe(false);
    expect(LocalServiceDnsLabelV1Schema.safeParse('a'.repeat(64)).success).toBe(false);
  });
});
