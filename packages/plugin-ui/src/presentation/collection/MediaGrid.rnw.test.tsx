import { describe, expect, it } from 'vitest';

import {
  buildHappierMediaGridLines,
  resolveHappierMediaGridGeometry,
} from './MediaGrid.js';

describe('media grid geometry', () => {
  it('grows columns with the host: three in the Files pane, five in Details, eight in Focus', () => {
    // Inner widths: the 340 pane less its 12 px insets, a 600 Details tab less 20, a ~1000 Focus tab less 20.
    expect(resolveHappierMediaGridGeometry(316).columns).toBe(3);
    expect(resolveHappierMediaGridGeometry(560).columns).toBe(5);
    expect(resolveHappierMediaGridGeometry(860).columns).toBe(8);
    const { columns, tilePx } = resolveHappierMediaGridGeometry(316);
    expect(tilePx * columns + 4 * (columns - 1)).toBeCloseTo(316);
  });
});

describe('media grid lines', () => {
  const keyOf = (item: string) => item;
  it('draws folders first, then each day with its tile rows in visual order, then the foot', () => {
    const lines = buildHappierMediaGridLines({
      folders: ['phone', 'release'],
      folderKeyOf: keyOf,
      keyOf,
      columns: 3,
      folderColumns: 2,
      foot: true,
      sections: [
        { key: 'today', title: 'Today', items: ['a', 'b', 'c', 'd'] },
        { key: 'empty', title: 'Never', items: [] },
        { key: 'nov', title: 'Nov 20', items: ['e'] },
      ],
    });
    expect(
      lines.map((line) =>
        line.kind === 'tiles'
          ? [line.kind, line.items.join(''), line.first]
          : line.kind === 'heading'
            ? [line.kind, line.title, line.count]
            : [line.kind],
      ),
    ).toEqual([
      ['folders'],
      ['heading', 'Today', 4],
      ['tiles', 'abc', 0],
      ['tiles', 'd', 3],
      ['heading', 'Nov 20', 1],
      ['tiles', 'e', 4],
      ['foot'],
    ]);
  });

  it('keys a row by its first item so rows keep their identity while later items arrive', () => {
    const before = buildHappierMediaGridLines({
      folders: [],
      folderKeyOf: keyOf,
      keyOf,
      columns: 2,
      folderColumns: 2,
      foot: false,
      sections: [{ key: 'd', title: 'Today', items: ['a', 'b', 'c'] }],
    });
    const after = buildHappierMediaGridLines({
      folders: [],
      folderKeyOf: keyOf,
      keyOf,
      columns: 2,
      folderColumns: 2,
      foot: false,
      sections: [{ key: 'd', title: 'Today', items: ['a', 'b', 'c', 'd'] }],
    });
    expect(after.map((line) => line.key)).toEqual(
      before.map((line) => line.key),
    );
  });
});
