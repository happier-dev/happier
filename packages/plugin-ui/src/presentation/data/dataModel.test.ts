import { describe, expect, it } from 'vitest';

import {
  describeHappierDataChart,
  formatHappierDataShare,
  formatHappierDataValue,
  resolveHappierDataLinePoints,
  resolveHappierDataShares,
  resolveHappierDataTableColumns,
} from './dataModel.js';

describe('shared data presentation rules', () => {
  it('reads numbers in the reader locale and shares against the largest value shown', () => {
    expect(formatHappierDataValue(1284, 'en-US')).toBe('1,284');
    expect(formatHappierDataValue(1284, 'de-DE')).toBe('1.284');
    expect(formatHappierDataValue('Team')).toBe('Team');
    expect(resolveHappierDataShares([1284, 812, 0, -3])).toEqual([1, 812 / 1284, 0, 0]);
    expect(resolveHappierDataShares([0, 0])).toEqual([0, 0]);
    expect(formatHappierDataShare(812 / 1284, 'en-US')).toBe('63%');
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

  it('names every point of a chart for assistive technology and keeps a flat line inside its plot', () => {
    expect(describeHappierDataChart('Signups per day', [{ x: 'Tue', y: 236 }, { x: 'Wed', y: 1183 }], 'en-US'))
      .toBe('Signups per day: Tue 236, Wed 1,183');
    expect(resolveHappierDataLinePoints([{ x: 1, y: 5 }, { x: 2, y: 5 }], 100, 40, 2)).toEqual([{ x: 0, y: 20 }, { x: 100, y: 20 }]);
    const rising = resolveHappierDataLinePoints([{ x: 1, y: 0 }, { x: 2, y: 10 }], 100, 40, 2);
    expect(rising[0]).toEqual({ x: 0, y: 39 });
    expect(rising[1]).toEqual({ x: 100, y: 1 });
  });
});
