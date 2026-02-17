import { describe, expect, it } from 'vitest';

import { normalizeMaterializationKeyForPath } from './normalizeMaterializationKeyForPath';

describe('normalizeMaterializationKeyForPath', () => {
  it('returns a stable hex digest', () => {
    expect(normalizeMaterializationKeyForPath('session-1')).toBe(normalizeMaterializationKeyForPath('session-1'));
  });

  it('never includes path separators or dot segments', () => {
    const key = normalizeMaterializationKeyForPath('../evil/../../key');
    expect(key).toMatch(/^[a-f0-9]{64}$/);
    expect(key.includes('/')).toBe(false);
    expect(key.includes('\\')).toBe(false);
    expect(key.includes('..')).toBe(false);
  });
});

