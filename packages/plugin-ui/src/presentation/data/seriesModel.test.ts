import { describe, expect, it } from 'vitest';
import * as model from './dataModel.js';

describe('neutral stacked series geometry', () => {
  it('draws finite extreme stack shares without overflowing or altering exact values', () => {
    const input = ['a', 'b'].map((id) => ({ id, label: id, points: [{ id: 'm', x: 'Mon', y: Number.MAX_VALUE }] }));
    for (const normalized of [false, true]) {
      const geometry = model.resolveHappierSeriesGeometry(input, { width: 100, height: 50, variant: 'area', normalized });
      const values = geometry.buckets[0]!.values;
      expect(values.map((value) => value.value)).toEqual([Number.MAX_VALUE, Number.MAX_VALUE]);
      expect(geometry.yAt(values[0]!.upper)).toBeCloseTo(25);
      expect(geometry.yAt(values[1]!.upper)).toBe(0);
    }
  });
  it('places unequal observed intervals at their real numeric x position', () => {
    const geometry = model.resolveHappierSeriesGeometry([{ id: 'reservoir', label: 'Water', points: [
      { id: 'start', x: 0, y: 2 }, { id: 'sample', x: 2, y: 4 }, { id: 'end', x: 10, y: 6 },
    ] }], { width: 100, height: 50, variant: 'line' });
    expect(geometry.xAt(1)).toBe(20);
    expect(geometry.hitRangeAt(1)).toEqual({ left: 10, width: 50 });
  });
  it('shares the spark scale and stable flat-line fallback without Usage data', () => {
    const points = [0, 5, 10].map((y, index) => ({ id: String(index), x: index, y }));
    const geometry = model.resolveHappierSeriesGeometry([{ id: 'signups', label: 'Signups', points }], { width: 40, height: 10, variant: 'line', fitLine: true });
    const vertices = geometry.buckets.map((bucket, index) => ({ x: geometry.xAt(index), y: geometry.yAt(bucket.values[0]!.upper) }));
    expect(model.buildHappierSeriesPath(vertices)).toBe('M0 10 L20 5 L40 0');
    const flat = model.resolveHappierSeriesGeometry([{ id: 'signups', label: 'Signups', points: [{ id: 'a', x: 'A', y: 5 }] }], { width: 40, height: 14, variant: 'line', fitLine: true });
    expect(flat.yAt(5)).toBe(7);
    expect(model.buildHappierSeriesPath([])).toBe('');
  });
  it('aligns semantic buckets, stacks real values and leaves unknown values as gaps', () => {
    const geometry = model.resolveHappierSeriesGeometry([
      { id: 'north', label: 'North', points: [{ id: 'mon', x: 'Mon', y: 3 }, { id: 'tue', x: 'Tue', y: null }] },
      { id: 'south', label: 'South', points: [{ id: 'mon', x: 'Mon', y: 2 }, { id: 'tue', x: 'Tue', y: 0 }] },
    ], { width: 100, height: 50, variant: 'bar' });
    expect(geometry.max).toBe(5);
    expect(geometry.buckets[0]!.values.map((value) => [value.value, value.lower, value.upper])).toEqual([[3, 0, 3], [2, 3, 5]]);
    expect(geometry.buckets[1]!.values.map((value) => value.value)).toEqual([null, 0]);
    expect(geometry.buckets.map((bucket) => bucket.id)).toEqual(['mon', 'tue']);
    const zero = model.resolveHappierSeriesGeometry([{ id: 'zero', label: 'Zero', points: [{ id: 'z', x: 0, y: 0 }] }], { width: 100, height: 50, variant: 'bar' });
    expect(zero.yAt(0)).toBe(50);
    const magnitudeFloor = { minimumMaximum: 1 };
    const tiny = model.resolveHappierSeriesGeometry([{ id: 'cost', label: 'Cost', points: [{ id: 'small', x: 0, y: 0.00004 }] }], { width: 100, height: 50, variant: 'bar', ...magnitudeFloor });
    expect(tiny.yAt(tiny.buckets[0]!.values[0]!.upper)).toBeCloseTo(49.998);
  });
  it('keeps every series exact value when drawing normalized shares', () => {
    const geometry = model.resolveHappierSeriesGeometry([
      { id: 'a', label: 'A', points: [{ id: 'm', x: 2.3456789, label: 'Noon', y: 0.00004 }] },
      { id: 'b', label: 'B', points: [{ id: 'm', x: 2.3456789, label: 'Noon', y: 0.00006 }] },
    ], { width: 100, height: 50, variant: 'area', normalized: true });
    expect(geometry.buckets[0]!.values[0]!.value).toBe(0.00004);
    expect(geometry.buckets[0]!.values[1]!.upper).toBeCloseTo(1);
    expect(model.describeHappierSeriesBucket(geometry.buckets[0]!, 'Unknown')).toContain('A 0.00004');
    expect(model.describeHappierSeriesBucket(geometry.buckets[0]!, 'Unknown')).toContain('2.3456789');
  });
});
