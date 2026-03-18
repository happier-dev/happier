import { describe, expect, it } from 'vitest';

import {
  normalizeOpenCodeBackendMode,
  normalizeOpenCodeServerBaseUrl,
  normalizeOpenCodeServerBaseUrlExplicit,
  readOpenCodeExplicitServerBaseUrl,
} from './opencode.js';

describe('OpenCode provider settings normalization', () => {
  it('accepts localhost http urls', () => {
    expect(normalizeOpenCodeServerBaseUrl(' http://127.0.0.1:4096/ ')).toBe('http://127.0.0.1:4096/');
    expect(normalizeOpenCodeServerBaseUrl('http://localhost:4096')).toBe('http://localhost:4096/');
  });

  it('normalizes accepted urls to their origin only', () => {
    expect(normalizeOpenCodeServerBaseUrl('http://127.0.0.1:4096/api?x=1#hash')).toBe('http://127.0.0.1:4096/');
    expect(normalizeOpenCodeServerBaseUrl('https://example.com:4096/nested/path?x=1')).toBe('https://example.com:4096/');
  });

  it('rejects remote plaintext http urls', () => {
    expect(normalizeOpenCodeServerBaseUrl('http://example.com:4096')).toBeNull();
  });

  it('rejects urls that embed credentials', () => {
    expect(normalizeOpenCodeServerBaseUrl('https://user:pass@example.com:4096')).toBeNull();
    expect(readOpenCodeExplicitServerBaseUrl('https://user:pass@example.com:4096', true)).toBeNull();
  });

  it('normalizes backend mode inputs', () => {
    expect(normalizeOpenCodeBackendMode('acp')).toBe('acp');
    expect(normalizeOpenCodeBackendMode(' server ')).toBe('server');
    expect(normalizeOpenCodeBackendMode(null)).toBe('server');
  });

  it('reads explicit server base urls only when the explicit flag is truthy', () => {
    expect(normalizeOpenCodeServerBaseUrlExplicit('yes')).toBe(true);
    expect(normalizeOpenCodeServerBaseUrlExplicit('0')).toBe(false);
    expect(readOpenCodeExplicitServerBaseUrl('http://127.0.0.1:4096/', 'true')).toBe('http://127.0.0.1:4096/');
    expect(readOpenCodeExplicitServerBaseUrl('http://example.com:4096/', 'true')).toBeNull();
  });
});
