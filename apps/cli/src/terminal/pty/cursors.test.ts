import { describe, expect, it } from 'vitest';

import { normalizeByteOffset, normalizeLegacyCursor } from './cursors';

describe('terminal PTY cursor normalization', () => {
  it('normalizes legacy event cursors to non-negative integers', () => {
    expect(normalizeLegacyCursor(7.9)).toBe(7);
    expect(normalizeLegacyCursor(-4)).toBe(0);
    expect(normalizeLegacyCursor(Number.POSITIVE_INFINITY)).toBe(0);
    expect(normalizeLegacyCursor(Number.NaN)).toBe(0);
  });

  it('normalizes byte offsets to non-negative integers', () => {
    expect(normalizeByteOffset(1024.8)).toBe(1024);
    expect(normalizeByteOffset(-1)).toBe(0);
    expect(normalizeByteOffset(Number.NEGATIVE_INFINITY)).toBe(0);
    expect(normalizeByteOffset(Number.NaN)).toBe(0);
  });
});
