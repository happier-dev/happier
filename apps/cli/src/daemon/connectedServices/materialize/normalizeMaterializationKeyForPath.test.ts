import { describe, expect, it } from 'vitest';

import { normalizeMaterializationKeyForPath } from './normalizeMaterializationKeyForPath';

describe('normalizeMaterializationKeyForPath', () => {
  it('never includes path separators or dot segments', () => {
    const key = normalizeMaterializationKeyForPath('../evil/../../key');
    expect(key).toMatch(/^[a-f0-9]{64}$/);
    expect(key.includes('/')).toBe(false);
    expect(key.includes('\\')).toBe(false);
    expect(key.includes('..')).toBe(false);
  });
});

