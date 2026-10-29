import { describe, expect, it } from 'vitest';

import {
  buildHappierSeriesPath,
  estimateHappierDataColumnWidths,
  describeHappierDataChart,
  formatHappierDataBytes,
  formatHappierDataBytesParts,
  formatHappierDataShare,
  formatHappierDataValue,
  resolveHappierDataShares,
  resolveHappierDataTableColumns,
  resolveHappierSeriesGeometry,
  resolveHappierSeriesRampStep,
} from './dataModel.js';

describe('shared data presentation rules', () => {
  it('normalizes stacked observations without treating a comparison overlay as another part', () => {
    const geometry = resolveHappierSeriesGeometry([
      { id: 'observed', label: 'Mean', points: [{ id: 'a', x: 0, y: 20 }] },
      { id: 'maximum', label: 'Maximum', overlay: true, points: [{ id: 'a', x: 0, y: 80 }] },
    ], { width: 100, height: 100, variant: 'area', normalized: true });
    expect(geometry.buckets[0]!.values).toMatchObject([
      { value: 20, lower: 0, upper: 1 }, { value: 80, lower: 0, upper: 4 },
    ]);
  });
  it('reads numbers in the reader locale and shares against the largest value shown', () => {
    expect(formatHappierDataValue(1284, 'en-US')).toBe('1,284');
    expect(formatHappierDataValue(1284, 'de-DE')).toBe('1.284');
    expect(formatHappierDataValue('Team')).toBe('Team');
    expect(resolveHappierDataShares([1284, 812, 0, -3])).toEqual([1, 812 / 1284, 0, 0]);
    expect(resolveHappierDataShares([0, 0])).toEqual([0, 0]);
    expect(formatHappierDataShare(812 / 1284, 'en-US')).toBe('63%');
  });

  it.each([
    [1_234_567_890_123_456, 'en-US', '1,234,567,890,123,456'],
    [Number.MAX_SAFE_INTEGER, 'en-US', '9,007,199,254,740,991'],
    [-Number.MAX_SAFE_INTEGER, 'de-DE', '-9.007.199.254.740.991'],
  ] as const)('retains every integer digit for %s in %s', (value, locale, expected) => {
    expect(formatHappierDataValue(value, locale)).toBe(expected);
    expect(describeHappierDataChart('Count', [{ x: 'Total', y: value }], locale)).toBe(`Count: Total ${expected}`);
  });

  it('retains decimal detail and locale while suppressing floating-point accumulation noise', () => {
    expect(formatHappierDataValue(2.3456789, 'en-US')).toBe('2.3456789');
    expect(formatHappierDataValue(123456789.123, 'de-DE')).toBe('123.456.789,123');
    expect(formatHappierDataValue(0.000000123456789, 'en-US')).toBe('0.000000123456789');
    expect(formatHappierDataValue(0.1 + 0.2, 'en-US')).toBe('0.3');
    expect(formatHappierDataValue(0.1 + 0.2, 'de-DE')).toBe('0,3');
  });

  it('drops secondary columns first on a narrow table, never the name, and keeps every column before measuring', () => {
    const columns = [{ label: 'Person' }, { label: 'Plan', priority: 'secondary' as const }, { label: 'Got to' }, { label: 'Joined' }];
    const rows = [['Mira Kovač', 'Team', 'Paired 2 machines', '10:38']];
    const input = { columns, rows, characterWidth: 7, gap: 8 };
    expect(resolveHappierDataTableColumns({ ...input, availableWidth: null })).toEqual([0, 1, 2, 3]);
    expect(resolveHappierDataTableColumns({ ...input, availableWidth: 600 })).toEqual([0, 1, 2, 3]);
    expect(resolveHappierDataTableColumns({ ...input, availableWidth: 260 })).toEqual([0, 2, 3]);
    expect(resolveHappierDataTableColumns({ ...input, availableWidth: 40 })).toEqual([0]);
  });

  it('gives a header its medium weight, so a label as long as its cells never truncates', () => {
    // Live: "Orders" over two-digit counts drew as "Ord…" at 14px/500 with a body-weight estimate.
    const [, orders] = estimateHappierDataColumnWidths({
      columns: [{ label: 'Channel' }, { label: 'Orders' }], rows: [['Copper', 17]], characterWidth: 7.2,
    });
    const bodyEstimate = 'Orders'.length * 7.2;
    expect(orders).toBeGreaterThan(Math.ceil(bodyEstimate * 1.05));
  });

  it('takes the measured header width when the estimate falls short, and never narrows below the estimate', () => {
    // Live: a header of wide glyphs ("Copper" over short counts) drew as "Cop…" under a character-count estimate.
    const input = { columns: [{ label: 'Channel' }, { label: 'Copper' }, { label: 'Iron' }], rows: [['Day', 1, 2]], characterWidth: 7.2 };
    const estimated = estimateHappierDataColumnWidths(input);
    const measured = estimateHappierDataColumnWidths({ ...input, measuredLabelWidths: [undefined, estimated[1]! + 20, 1] });
    expect(measured[1]).toBe(estimated[1]! + 20);
    expect(measured[2]).toBe(estimated[2]);
    // The table keeps a column only if its true width fits, so measuring also narrows what a card keeps.
    const wide = { ...input, characterWidth: 7.2, gap: 8 };
    const fits = resolveHappierDataTableColumns({ ...wide, availableWidth: estimated[0]! + estimated[1]! + estimated[2]! + 16 });
    expect(fits).toEqual([0, 1, 2]);
    expect(resolveHappierDataTableColumns({ ...wide, measuredLabelWidths: [undefined, estimated[1]! + 20, undefined],
      availableWidth: estimated[0]! + estimated[1]! + estimated[2]! + 16 })).not.toEqual([0, 1, 2]);
  });

  it('names every point through the retained public chart-description helper', () => {
    expect(describeHappierDataChart('Signups per day', [{ x: 'Tue', y: 236 }, { x: 'Wed', y: 1183 }], 'en-US'))
      .toBe('Signups per day: Tue 236, Wed 1,183');
  });

  it('reads bytes in the base the quantity kind sets: storage decimal, memory binary', () => {
    // A 1 TB drive is "1 TB" and a 128 GiB machine is "128 GB", as the OS and drive vendor show them.
    expect(formatHappierDataBytes(1_000_000_000_000, { kind: 'storage', locale: 'en-US' })).toBe('1 TB');
    expect(formatHappierDataBytes(128 * 1024 ** 3, { kind: 'memory', locale: 'en-US' })).toBe('128 GB');
    expect(formatHappierDataBytes(128 * 1024 ** 3, { kind: 'storage', locale: 'en-US' })).toBe('137 GB');
    // Three significant figures at and above one unit; a whole value drops trailing zeroes.
    expect(formatHappierDataBytes(58_400_000_000, { kind: 'storage', locale: 'en-US' })).toBe('58.4 GB');
    expect(formatHappierDataBytes(17_640_000_000, { kind: 'storage', locale: 'en-US' })).toBe('17.6 GB');
    expect(formatHappierDataBytes(71.26 * 1024 ** 3, { kind: 'memory', locale: 'en-US' })).toBe('71.3 GB');
    expect(formatHappierDataBytes(99.97 * 1024 ** 2, { kind: 'memory', locale: 'en-US' })).toBe('100 MB');
    expect(formatHappierDataBytes(3.84 * 1024 ** 3, { kind: 'memory', locale: 'en-US' })).toBe('3.84 GB');
    expect(formatHappierDataBytes(2 * 1024 ** 3, { kind: 'memory', locale: 'en-US' })).toBe('2 GB');
    expect(formatHappierDataBytes(412_400_000_000, { kind: 'storage', locale: 'en-US' })).toBe('412 GB');
    expect(formatHappierDataBytes(1_240_000_000_000, { kind: 'storage', locale: 'de-DE' })).toBe('1,24 TB');
    expect(formatHappierDataBytes(9_960, { kind: 'storage', locale: 'en-US' })).toBe('9.96 KB');
    expect(formatHappierDataBytes(999_600, { kind: 'storage', locale: 'en-US' })).toBe('1 MB');
    expect(formatHappierDataBytes(1023.6 * 1024, { kind: 'memory', locale: 'en-US' })).toBe('1,020 KB');
    expect(formatHappierDataBytesParts(1_236, { kind: 'storage', locale: 'en-US' })).toEqual({ value: '1.24', unit: 'KB' });
    expect(formatHappierDataBytesParts(1_236, { kind: 'storage', locale: 'invalid_locale' })).toEqual({ value: '1.24', unit: 'KB' });
    expect(formatHappierDataBytes(-1, { kind: 'storage', locale: 'en-US' })).toBe('0 B');
    expect(formatHappierDataBytes(Number.POSITIVE_INFINITY, { kind: 'memory', locale: 'en-US' })).toBe('0 B');
    expect(formatHappierDataBytes(0, { kind: 'memory', locale: 'en-US' })).toBe('0 B');
    expect(formatHappierDataBytes(812, { kind: 'storage', locale: 'en-US' })).toBe('812 B');
    expect(formatHappierDataBytesParts(180 * 1024 ** 2, { kind: 'memory', locale: 'en-US' })).toEqual({ value: '180', unit: 'MB' });
  });

  it('spreads a few uncoloured series across the legible ramp so neighbours never sit one step apart', () => {
    expect([0].map((index) => resolveHappierSeriesRampStep(index, 1))).toEqual([0]);
    expect([0, 1].map((index) => resolveHappierSeriesRampStep(index, 2))).toEqual([0, 4]);
    expect([0, 1, 2].map((index) => resolveHappierSeriesRampStep(index, 3))).toEqual([0, 2, 4]);
    // Many series use every step in order, never wrapping.
    expect(Array.from({ length: 8 }, (_, index) => resolveHappierSeriesRampStep(index, 8))).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  });
});

describe('smoothed series path', () => {
  const segments = (path: string) => [...path.matchAll(/C([^A-Z]+)/gu)].map(match => match[1]!.trim().split(/[ ,]+/u).map(Number));
  it('passes through every sample without overshooting and without a kink where samples join', () => {
    // A steep rise, a near-flat step, then another rise: a clamped spline flattens one side of the middle sample.
    const points = [{ x: 0, y: 100 }, { x: 10, y: 50 }, { x: 20, y: 48 }, { x: 30, y: 0 }, { x: 40, y: 60 }];
    const curves = segments(buildHappierSeriesPath(points, 1));
    expect(curves).toHaveLength(points.length - 1);
    curves.forEach(([, c1y, , c2y, x, y], index) => {
      const from = points[index]!; const to = points[index + 1]!;
      expect([x, y]).toEqual([to.x, to.y]);
      for (const control of [c1y!, c2y!]) {
        expect(control).toBeGreaterThanOrEqual(Math.min(from.y, to.y) - 0.01);
        expect(control).toBeLessThanOrEqual(Math.max(from.y, to.y) + 0.01);
      }
    });
    for (let index = 1; index < curves.length; index += 1) {
      const [, , c2x, c2y] = curves[index - 1]!; const [c1x, c1y] = curves[index]!; const joint = points[index]!;
      const incoming = (joint.y - c2y!) / (joint.x - c2x!); const outgoing = (c1y! - joint.y) / (c1x! - joint.x);
      expect(outgoing).toBeCloseTo(incoming, 2);
    }
  });
  it('draws the same curve backwards for a ribbon lower edge', () => {
    const points = [{ x: 0, y: 100 }, { x: 10, y: 50 }, { x: 20, y: 48 }, { x: 30, y: 0 }];
    const reversed = segments(buildHappierSeriesPath([...points].reverse(), 1));
    const forward = segments(buildHappierSeriesPath(points, 1));
    expect(reversed[0]!.slice(0, 2)).toEqual(forward.at(-1)!.slice(2, 4));
  });
});
