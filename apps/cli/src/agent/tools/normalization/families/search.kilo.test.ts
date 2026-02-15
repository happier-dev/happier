import { describe, expect, it } from 'vitest';

import { normalizeCodeSearchResult, normalizeGlobResult, normalizeGrepResult, normalizeLsResult } from './search';

type CodeSearchMatch = {
  filePath?: string;
  line?: number;
  excerpt?: string;
};

function expectMatches(value: Record<string, unknown>): CodeSearchMatch[] {
  const matches = value.matches;
  expect(Array.isArray(matches)).toBe(true);
  return matches as CodeSearchMatch[];
}

describe('normalizeCodeSearchResult (Kilo ACP shapes)', () => {
  it('parses { output } OpenCode-style search text into matches', () => {
    const normalized = normalizeCodeSearchResult({
      output: ['Found 1 matches', '/repo/src/foo.ts:', '  Line 3: NEEDLE'].join('\n'),
      metadata: { matches: 1, truncated: false },
    });

    const matches = expectMatches(normalized);
    expect(matches[0]).toMatchObject({ filePath: '/repo/src/foo.ts', line: 3 });
  });

  it('prefers output over metadata.output when both are present', () => {
    const normalized = normalizeCodeSearchResult({
      output: ['Found 1 matches', '/repo/src/preferred.ts:', '  Line 10: preferred'].join('\n'),
      metadata: {
        output: ['Found 1 matches', '/repo/src/ignored.ts:', '  Line 8: ignored'].join('\n'),
      },
    });

    const matches = expectMatches(normalized);
    expect(matches[0]).toMatchObject({ filePath: '/repo/src/preferred.ts', line: 10 });
  });

  it('returns stable empty matches for record outputs without parseable text', () => {
    const normalized = normalizeCodeSearchResult({
      error: 'provider unavailable',
      metadata: { retryable: true },
    });

    expect(normalized.matches).toEqual([]);
  });

  it('falls back to excerpt-only matches for non-structured string output', () => {
    const normalized = normalizeCodeSearchResult('just a plain message');
    const matches = expectMatches(normalized);
    expect(matches).toEqual([{ excerpt: 'just a plain message' }]);
  });
});

describe('search family normalizers (Pi content block wrappers)', () => {
  it('normalizes ls result content blocks into entries', () => {
    const normalized = normalizeLsResult({
      content: [{ type: 'text', text: 'alpha.txt\nnotes.md\n' }],
    });

    expect(normalized.entries).toEqual(['alpha.txt', 'notes.md']);
  });

  it('normalizes glob/find result content blocks into matches', () => {
    const normalized = normalizeGlobResult({
      content: [{ type: 'text', text: 'notes.md\nREADME.md\n' }],
    });

    expect(normalized.matches).toEqual(['notes.md', 'README.md']);
  });

  it('normalizes grep result content blocks into structured matches', () => {
    const normalized = normalizeGrepResult({
      content: [{ type: 'text', text: 'alpha.txt:1: alpha line with NEEDLE token' }],
    });

    expect(normalized.matches).toEqual([
      {
        filePath: 'alpha.txt',
        line: 1,
        excerpt: 'alpha line with NEEDLE token',
      },
    ]);
  });
});
