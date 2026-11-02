import { describe, expect, it } from 'vitest';
import { blurBlockEdge, pixelateSourcePixels } from './pixelate';

describe('burned blur pixels', () => {
  it('replaces every source pixel with its untouched block mean, including partial edge blocks', () => {
    const source = new Uint8ClampedArray([
      0, 20, 40, 255, 100, 120, 140, 255, 200, 210, 220, 255,
      20, 40, 60, 255, 80, 100, 120, 255, 220, 230, 240, 255,
    ]);
    const before = source.slice();
    const burned = pixelateSourcePixels(source, 3, 2, 2);
    expect(Array.from(burned)).toEqual([
      50, 70, 90, 255, 50, 70, 90, 255, 210, 220, 230, 255,
      50, 70, 90, 255, 50, 70, 90, 255, 210, 220, 230, 255,
    ]);
    expect(source).toEqual(before);
    expect(burned).not.toEqual(source);
    expect(blurBlockEdge('s', 2)).toBeGreaterThanOrEqual(18 * 1.25 * 2);
    expect(blurBlockEdge('m', 2)).toBeGreaterThan(blurBlockEdge('s', 2));
  });
});
