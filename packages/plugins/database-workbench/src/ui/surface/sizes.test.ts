import { describe, expect, it } from 'vitest';
import { approxRowsLabel, formatCount } from './sizes.js';

describe('counts', () => {
  it('says a small estimate exactly and a large one compactly, still marked approximate', () => {
    expect(approxRowsLabel('0')).toBe('0');
    expect(approxRowsLabel('9')).toBe('9');
    expect(approxRowsLabel('212400')).toBe('~212K');
    expect(approxRowsLabel('1200000')).toBe('~1.2M');
    expect(approxRowsLabel(null)).toBeUndefined();
  });

  it('says an exact count in full up to 100,000, then compactly', () => {
    expect(formatCount('48210')).toBe('48,210');
    expect(formatCount(1_400_000)).toBe('1.4M');
    expect(formatCount(undefined)).toBeNull();
    expect(formatCount('48210', { approximate: true, full: true })).toBe('~48,210');
  });
});
