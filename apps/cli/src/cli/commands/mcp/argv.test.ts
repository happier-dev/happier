import { describe, expect, it } from 'vitest';

import { readRepeatedFlagValues } from './argv';

describe('readRepeatedFlagValues', () => {
  it('does not reinterpret a consumed value as another flag', () => {
    expect(readRepeatedFlagValues(['--arg', '--arg', 'value'], '--arg')).toEqual(['--arg']);
  });
});
