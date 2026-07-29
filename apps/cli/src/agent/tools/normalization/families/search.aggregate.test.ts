import { describe, expect, it } from 'vitest';

import { normalizeCodeSearchResult } from './search';

describe('normalizeCodeSearchResult aggregate semantics', () => {
  it('marks a positive aggregate without detail as unavailable instead of a zero-match result', () => {
    expect(normalizeCodeSearchResult({ totalMatches: 4, truncated: true })).toEqual({
      totalMatches: 4,
      truncated: true,
      detailsUnavailable: true,
    });
  });

  it('keeps an explicit zero match result distinct from unavailable details', () => {
    expect(normalizeCodeSearchResult({ totalMatches: 0, truncated: false })).toEqual({
      totalMatches: 0,
      truncated: false,
      matches: [],
    });
  });

  it('preserves aggregate metadata and truncation when detail rows are present', () => {
    expect(normalizeCodeSearchResult({
      totalMatches: 4,
      truncated: true,
      matches: [{ filePath: '/repo/a.ts', line: 2, excerpt: 'needle' }],
    })).toEqual({
      totalMatches: 4,
      truncated: true,
      matches: [{ filePath: '/repo/a.ts', line: 2, excerpt: 'needle' }],
    });
  });

  it('keeps an error authoritative when a provider also sends a positive aggregate', () => {
    expect(normalizeCodeSearchResult({ error: 'timeout', totalMatches: 4, truncated: true })).toEqual({
      error: 'timeout',
      totalMatches: 4,
      truncated: true,
      matches: [],
    });
  });
});
