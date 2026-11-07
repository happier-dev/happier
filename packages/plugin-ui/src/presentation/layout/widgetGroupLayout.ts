/** One child of a group, as the group lays it out: its id and its A3 footprint on the surface. */
export type WidgetGroupCellInput = Readonly<{
  id: string;
  columnSpan: number;
  rowSpan: number;
}>;

export type WidgetGroupCell = Readonly<{ id: string; rowSpan: number }>;

export type WidgetGroupContentState = 'empty' | 'content';

/**
 * A horizontal band of the group, separated from the next by a full-bleed divider:
 * - `row`: one child across every column (a full-width child, a lone child in view mode, or every
 *   child of a one-column group);
 * - `columns`: the two columns packed side by side. The vertical divider belongs to the taller
 *   column and spans it; the space under the shorter one stays quiet paper. `slot` is the column
 *   that shows an empty "drop a widget here" slot beside a lone child while customizing;
 * - `slot`: the empty slot as a row of its own, under the single widget of a one-column group while
 *   customizing (lab wgmenu E "website").
 */
export type WidgetGroupBand =
  | Readonly<{ kind: 'row'; key: string; cell: WidgetGroupCell }>
  | Readonly<{ kind: 'slot'; key: 'slot' }>
  | Readonly<{
      kind: 'columns';
      key: string;
      columns: readonly [
        readonly WidgetGroupCell[],
        readonly WidgetGroupCell[],
      ];
      taller: 0 | 1;
      slot?: 0 | 1;
    }>;

/** How many columns a group has here: a half group and every group on a phone stack in one column. */
export function resolveWidgetGroupColumns(
  width: 'full' | 'half',
  phone: boolean,
): 1 | 2 {
  return phone || width === 'half' ? 1 : 2;
}

/**
 * Packs a group's children into bands (lab `widget-groups` wgvar). Children keep their reading
 * order; each half-width child takes the shorter column, so a Medium beside two Smalls fills one band
 * with the Medium's divider spanning both. A full-width child gets its own band. A child left alone
 * at the end of a band (nothing beside it in the other column) fills its row in view mode; while
 * customizing it keeps its saved half and the other column offers an empty slot. Sizes are never
 * changed: this only decides where each child is drawn.
 */
export function packWidgetGroupBands(
  cells: readonly WidgetGroupCellInput[],
  columns: 1 | 2,
  mode: 'view' | 'customize' = 'view',
): WidgetGroupBand[] {
  const bands: WidgetGroupBand[] = [];
  const row = (cell: WidgetGroupCellInput) =>
    bands.push({
      kind: 'row',
      key: cell.id,
      cell: { id: cell.id, rowSpan: cell.rowSpan },
    });
  if (columns === 1) {
    cells.forEach(row);
    // A group of one is a hole waiting for its second widget: Customize shows where it goes.
    if (mode === 'customize' && cells.length === 1)
      bands.push({ kind: 'slot', key: 'slot' });
    return bands;
  }
  let left: WidgetGroupCell[] = [];
  let right: WidgetGroupCell[] = [];
  let heights: [number, number] = [0, 0];
  // Where the last cell of each column starts, to find a child with nothing beside it.
  let starts: [number, number] = [0, 0];
  const flush = () => {
    if (left.length === 0 && right.length === 0) return;
    const taller: 0 | 1 = heights[1] > heights[0] ? 1 : 0;
    const shorter = taller === 0 ? 1 : 0;
    const tallColumn = taller === 0 ? left : right;
    const lone =
      starts[taller] >= heights[shorter]
        ? tallColumn[tallColumn.length - 1]
        : undefined;
    if (lone && mode === 'view') {
      const rest = tallColumn.slice(0, -1);
      const kept: readonly [WidgetGroupCell[], WidgetGroupCell[]] =
        taller === 0 ? [rest, right] : [left, rest];
      if (kept[0].length || kept[1].length) {
        const restHeight = heights[taller] - lone.rowSpan;
        bands.push({
          kind: 'columns',
          key: (kept[0][0] ?? kept[1][0])!.id,
          columns: kept,
          taller: restHeight >= heights[shorter] ? taller : shorter,
        });
      }
      bands.push({ kind: 'row', key: lone.id, cell: lone });
    } else {
      bands.push({
        kind: 'columns',
        key: (left[0] ?? right[0])!.id,
        columns: [left, right],
        taller,
        ...(lone ? { slot: shorter } : {}),
      });
    }
    left = [];
    right = [];
    heights = [0, 0];
    starts = [0, 0];
  };
  for (const cell of cells) {
    if (cell.columnSpan >= 2) {
      flush();
      row(cell);
      continue;
    }
    const column: 0 | 1 = heights[1] < heights[0] ? 1 : 0;
    (column === 0 ? left : right).push({ id: cell.id, rowSpan: cell.rowSpan });
    starts[column] = heights[column];
    heights[column] += cell.rowSpan;
  }
  flush();
  return bands;
}

/**
 * The order a full group's children stack in when it has one column (a phone): the order its two
 * columns read in on a wide page, not the stored list order. Each band is read top to bottom by where
 * its cells start, and at the same start the shorter cell first, so the lead fact beside a tall chart
 * comes before the chart (lab d2top-A on a phone: figures, chart, Capacity). Equal heights and
 * full-width children keep their reading order. The stored order is unchanged; customizing shows it.
 */
export function orderWidgetGroupCellsForStack<Cell extends WidgetGroupCellInput>(
  cells: readonly Cell[],
): Cell[] {
  const byId = new Map(cells.map((cell) => [cell.id, cell]));
  const ordered: Cell[] = [];
  for (const band of packWidgetGroupBands(cells, 2)) {
    if (band.kind === 'row') ordered.push(byId.get(band.cell.id)!);
    if (band.kind !== 'columns') continue;
    const placed = band.columns.flatMap((column, side) => {
      let start = 0;
      return column.map((cell, index) => {
        const entry = { cell, side, index, start };
        start += cell.rowSpan;
        return entry;
      });
    });
    placed.sort((a, b) => a.start - b.start || a.cell.rowSpan - b.cell.rowSpan || a.side - b.side || a.index - b.index);
    ordered.push(...placed.map((entry) => byId.get(entry.cell.id)!));
  }
  return ordered;
}
