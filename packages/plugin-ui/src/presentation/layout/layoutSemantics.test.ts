import { describe, expect, it } from 'vitest';

import { resolveHappierLayoutGap } from './layoutSemantics.js';

describe('resolveHappierLayoutGap', () => {
  const spacing = Object.freeze({
    xsmall: 4,
    small: 8,
    medium: 12,
    large: 16,
    xlarge: 24,
  });

  it('resolves the shared semantic gap vocabulary from the projected theme', () => {
    expect(resolveHappierLayoutGap(undefined, spacing)).toBe(12);
    expect(resolveHappierLayoutGap('none', spacing)).toBe(0);
    expect(resolveHappierLayoutGap('small', spacing)).toBe(8);
    expect(resolveHappierLayoutGap('medium', spacing)).toBe(12);
    expect(resolveHappierLayoutGap('large', spacing)).toBe(16);
  });

  it('rejects an unknown gap word instead of inventing a number', () => {
    const unknownGap = 'huge' as unknown as Parameters<typeof resolveHappierLayoutGap>[0];
    expect(resolveHappierLayoutGap(unknownGap, spacing)).toBeUndefined();
  });
});
