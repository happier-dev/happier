import { describe, it, expect } from 'vitest';

import { normalizeProxyUrl } from './parseProxyUrl';

describe('normalizeProxyUrl', () => {
  it('adds http:// scheme when missing', () => {
    expect(normalizeProxyUrl('proxy.local:3128')).toBe('http://proxy.local:3128');
  });

  it('defaults http proxy port to 80', () => {
    expect(normalizeProxyUrl('http://proxy.local')).toBe('http://proxy.local:80');
  });

  it('defaults https proxy port to 443', () => {
    expect(normalizeProxyUrl('https://proxy.local')).toBe('https://proxy.local:443');
  });

  it('returns null for empty/whitespace input', () => {
    expect(normalizeProxyUrl('')).toBe(null);
    expect(normalizeProxyUrl('   ')).toBe(null);
  });
});

