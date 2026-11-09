import { describe, expect, it } from 'vitest';

import { placeUsageOrbitLabels } from './usageOrbitLabelLayout.js';

const LINE = 15;

describe('placeUsageOrbitLabels', () => {
  it('leaves labels that do not touch where their planets put them', () => {
    const placed = placeUsageOrbitLabels([
      { x: 20, y: 40, span: 60, anchor: 'start' },
      { x: 200, y: 40, span: 60, anchor: 'end' },
    ], { height: 240, line: LINE });
    expect(placed).toEqual([40, 40]);
  });

  it('moves a label that would sit on another one so both stay readable', () => {
    const placed = placeUsageOrbitLabels([
      { x: 100, y: 120, span: 90, anchor: 'start' },
      { x: 110, y: 126, span: 70, anchor: 'start' },
    ], { height: 240, line: LINE });
    expect(placed[0]).toBe(120);
    expect(Math.abs(placed[1]! - placed[0]!)).toBeGreaterThanOrEqual(LINE);
  });

  it('keeps a pushed label inside the drawing and in the order the planets were given', () => {
    const placed = placeUsageOrbitLabels([
      { x: 100, y: 228, span: 80, anchor: 'start' },
      { x: 100, y: 232, span: 80, anchor: 'start' },
    ], { height: 240, line: LINE });
    for (const y of placed) {
      expect(y).toBeLessThanOrEqual(236);
      expect(y).toBeGreaterThanOrEqual(LINE);
    }
    expect(Math.abs(placed[1]! - placed[0]!)).toBeGreaterThanOrEqual(LINE);
  });
});
