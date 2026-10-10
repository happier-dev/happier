import { describe, expect, it } from 'vitest';

import {
  packWidgetGroupBands,
  resolveWidgetGroupCells,
  resolveWidgetGroupColumns,
} from './widgetGroupLayout';

const cells = (
  ...sizes: Array<
    ['small' | 'medium' | 'wide' | 'full' | 'tall' | 'large', string]
  >
) =>
  resolveWidgetGroupCells(
    'home',
    sizes.map(([size, id]) => ({ id, size })),
  );

describe('packWidgetGroupBands', () => {
  it('packs a Medium beside two Smalls in one band, the Medium drawing the vertical divider', () => {
    expect(
      packWidgetGroupBands(
        cells(['medium', 'summary'], ['small', 'checks'], ['small', 'prs']),
        2,
      ),
    ).toEqual([
      {
        kind: 'columns',
        key: 'summary',
        columns: [
          [{ id: 'summary', rowSpan: 2 }],
          [
            { id: 'checks', rowSpan: 1 },
            { id: 'prs', rowSpan: 1 },
          ],
        ],
        taller: 0,
      },
    ]);
  });

  it('gives a full-width child its own row between the column bands', () => {
    const bands = packWidgetGroupBands(
      cells(['wide', 'daily'], ['small', 'summary'], ['small', 'checks']),
      2,
    );
    expect(bands.map((band) => band.kind)).toEqual(['row', 'columns']);
    expect(bands[0]).toEqual({
      kind: 'row',
      key: 'daily',
      cell: { id: 'daily', rowSpan: 1 },
    });
  });

  it('ends a one-column group that holds a single widget with an empty slot while customizing, and never in view mode', () => {
    const one = cells(['small', 'checks']);
    expect(packWidgetGroupBands(one, 1, 'customize')).toEqual([
      { kind: 'row', key: 'checks', cell: { id: 'checks', rowSpan: 1 } },
      { kind: 'slot', key: 'slot' },
    ]);
    expect(packWidgetGroupBands(one, 1, 'view')).toEqual([
      { kind: 'row', key: 'checks', cell: { id: 'checks', rowSpan: 1 } },
    ]);
    // Two widgets already make a group: no hole to offer.
    expect(
      packWidgetGroupBands(cells(['small', 'a'], ['small', 'b']), 1, 'customize').map((band) => band.kind),
    ).toEqual(['row', 'row']);
  });

  it('lets a lone child fill its row in view mode and keeps its half beside an empty slot while customizing', () => {
    const input = cells(['small', 'a'], ['small', 'b'], ['small', 'c']);
    expect(packWidgetGroupBands(input, 2, 'view')).toEqual([
      {
        kind: 'columns',
        key: 'a',
        columns: [[{ id: 'a', rowSpan: 1 }], [{ id: 'b', rowSpan: 1 }]],
        taller: 0,
      },
      { kind: 'row', key: 'c', cell: { id: 'c', rowSpan: 1 } },
    ]);
    expect(packWidgetGroupBands(input, 2, 'customize')).toEqual([
      {
        kind: 'columns',
        key: 'a',
        columns: [
          [
            { id: 'a', rowSpan: 1 },
            { id: 'c', rowSpan: 1 },
          ],
          [{ id: 'b', rowSpan: 1 }],
        ],
        taller: 0,
        slot: 1,
      },
    ]);
  });

  it('does not treat the short side of a taller neighbour as a lone child', () => {
    const bands = packWidgetGroupBands(
      cells(['tall', 'limits'], ['small', 'checks'], ['small', 'prs']),
      2,
    );
    expect(bands).toEqual([
      {
        kind: 'columns',
        key: 'limits',
        columns: [
          [{ id: 'limits', rowSpan: 4 }],
          [
            { id: 'checks', rowSpan: 1 },
            { id: 'prs', rowSpan: 1 },
          ],
        ],
        taller: 0,
      },
    ]);
  });

  it('stacks every child in reading order in one column (a half group, or any group on a phone)', () => {
    expect(resolveWidgetGroupColumns('full', true)).toBe(1);
    expect(resolveWidgetGroupColumns('half', false)).toBe(1);
    expect(resolveWidgetGroupColumns('full', false)).toBe(2);
    expect(
      packWidgetGroupBands(cells(['medium', 'a'], ['small', 'b']), 1).map(
        (band) => band.key,
      ),
    ).toEqual(['a', 'b']);
  });
});
