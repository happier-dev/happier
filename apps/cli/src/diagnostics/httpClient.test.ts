import { describe, expect, it } from 'vitest';

import { normalizeBaseUrl } from './httpClient';

describe('normalizeBaseUrl', () => {
  it('removes query + hash and trailing slashes', () => {
    expect(normalizeBaseUrl('https://api.example.com/path/?token=abc#frag///')).toBe('https://api.example.com/path');
  });
});

