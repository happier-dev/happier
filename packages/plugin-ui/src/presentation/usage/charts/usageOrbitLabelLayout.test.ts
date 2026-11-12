import { describe, expect, it } from 'vitest';

import { placeUsageOrbitLabels, usageOrbitAngles } from './usageOrbitLabelLayout.js';

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

describe('usageOrbitAngles', () => {
  it('keeps the lab angles on a wide body with few planets', () => {
    expect(usageOrbitAngles(3, false)).toEqual([-0.12, 3.0, 0.42]);
  });

  it('gives every planet its own angle on a phone, alternating sides, so labels do not crowd beside one planet (R8 #6)', () => {
    for (const narrow of [true, false]) {
      const angles = usageOrbitAngles(9, narrow);
      const right = angles.filter((_, index) => index % 2 === 0), left = angles.filter((_, index) => index % 2 === 1);
      expect(right.every((angle) => Math.cos(angle) > 0)).toBe(true);
      expect(left.every((angle) => Math.cos(angle) < 0)).toBe(true);
      // Same-side planets sit on distinct lines: at least a fifth of a radian apart.
      for (const side of [right, left]) {
        const sines = side.map(Math.sin).sort((a, b) => a - b);
        for (let index = 1; index < sines.length; index++) expect(sines[index]! - sines[index - 1]!).toBeGreaterThan(0.2);
      }
    }
  });
});
