import { describe, expect, it } from 'vitest';

import { formatSessionUpdatedAtForCli } from './sessionListFormatting';

describe('formatSessionUpdatedAtForCli', () => {
  it('uses the shared epoch parser on both sides of the seconds-to-milliseconds boundary', () => {
    expect(formatSessionUpdatedAtForCli(999_999_999_999, 1_000_000_000_000_000)).toBe('1s');
    expect(formatSessionUpdatedAtForCli(1_000_000_000_000, 1_000_000_001_000)).toBe('1s');
  });
});
