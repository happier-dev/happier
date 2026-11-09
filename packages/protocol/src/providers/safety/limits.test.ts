import { describe, expect, it } from 'vitest';

import { normalizeProviderEndpointUrlSyntax } from './url.js';

describe('provider endpoint safety limits', () => {
  it('retains DNS hostname and label syntax boundaries', () => {
    const validHost = [...Array.from({ length: 3 }, () => 'h'.repeat(63)), 'h'.repeat(61)].join('.');
    expect(normalizeProviderEndpointUrlSyntax(`https://${validHost}`).hostname).toBe(validHost);
    expect(() => normalizeProviderEndpointUrlSyntax(`https://${validHost}h`)).toThrow(expect.objectContaining({ code: 'host_too_long' }));
    expect(() => normalizeProviderEndpointUrlSyntax(`https://${'h'.repeat(64)}.test`)).toThrow(expect.objectContaining({ code: 'host_too_long' }));
  });
});
