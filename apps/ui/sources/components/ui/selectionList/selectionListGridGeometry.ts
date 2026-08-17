/**
 * Grid geometry for the SelectionList `columns` variant.
 *
 * Pure and JSX-free on purpose: layout position and arrow-key movement are the
 * two facts the columns variant adds, and both are decidable from the ordered
 * rendered options plus a column count. Keeping them here means the row
 * renderer, the virtualized row grouper, and the keyboard hook all read ONE
 * description of where a cell sits.
 *
 * Two contracts matter and are easy to get wrong:
 *
 *  1. **Geometry covers every RENDERED option, including disabled ones.**
 *     `flatVisibleOptionIds` (the keyboard nav array) EXCLUDES disabled
 *     options, but disabled options still render — dimmed — in the pane. A
 *     layout built from the nav array would silently drop them from the grid.
 *     Navigation skips holes; layout does not.
 *
 *  2. **Rows never span groups.** Each rendered section is its own group, so a
 *     section header always starts a fresh visual row.
 *
 *  3. **A section too short to fill a row takes the whole width.** A one-option
 *     section in a two-column pane used to render one card at column width
 *     beside an empty spacer, which reads as a missing sibling rather than as a
 *     deliberate single item. `resolveSelectionListSectionColumnCount` is the
 *     ONE place that decides this, so the layout, the ARIA column indices and
 *     the arrow geometry cannot disagree about how wide that section is.
 *
 * Order is ROW-MAJOR (`1 2 | 3 4 | 5 6`). Linear arrow roving and
 * position-in-set semantics both follow reading order; a column-major fill
 * would make ↓ jump from item 1 to item 4.
 */

export type SelectionListGridArrowKey =
    | 'ArrowUp'
    | 'ArrowDown'
    | 'ArrowLeft'
    | 'ArrowRight';

export type SelectionListGridGeometryOption = Readonly<{
    id: string;
    /**
     * Whether this option participates in keyboard navigation — i.e. whether
     * it appears in `flatVisibleOptionIds`. Disabled options (and options in
     * non-focusable sections) render but are `false`.
     */
    focusable: boolean;
}>;

/** One rendered section. Groups never share a visual row. */
export type SelectionListGridGeometryGroup = Readonly<{
    id: string;
    options: ReadonlyArray<SelectionListGridGeometryOption>;
}>;

export type SelectionListGridCell = Readonly<{
    optionId: string;
    groupId: string;
    /** Global visual row index (monotonic across groups). */
    row: number;
    /** Column index within the visual row, `0 <= column < columnCount`. */
    column: number;
    focusable: boolean;
    /**
     * Position within `flatVisibleOptionIds`, or `null` when the cell is not
     * keyboard-reachable. This is the value arrow movement returns, so callers
     * never have to translate between layout order and nav order.
     */
    navIndex: number | null;
}>;

export type SelectionListGridGeometry = Readonly<{
    columnCount: number;
    rowCount: number;
    cells: ReadonlyArray<SelectionListGridCell>;
}>;

function normalizeColumnCount(columnCount: number): number {
    if (!Number.isFinite(columnCount)) return 1;
    const floored = Math.floor(columnCount);
    return floored < 1 ? 1 : floored;
}

/**
 * How many columns ONE section gets out of the pane's `columnCount`.
 *
 * A section with fewer options than there are columns can never fill a row, so
 * it takes the full width instead of leaving a hole beside its last card. The
 * shipped case is the model picker's one-option `current-selection-recovery`
 * section, which rendered at half width with a blank right half.
 *
 * The rule is per SECTION, not per row: a trailing partial row inside a section
 * that IS wide enough keeps its column width, because there its neighbours
 * establish the grid the user is reading.
 */
export function resolveSelectionListSectionColumnCount(
    optionCount: number,
    columnCount: number,
): number {
    const normalized = normalizeColumnCount(columnCount);
    if (normalized <= 1 || optionCount <= 0) return normalized;
    return optionCount < normalized ? 1 : normalized;
}

/**
 * Grid columns one cell of a section occupies — `columnCount` for a full-width
 * section, `1` otherwise. This is what keeps `aria-colcount` truthful: every
 * row still accounts for exactly `columnCount` columns.
 */
export function resolveSelectionListSectionColumnSpan(
    optionCount: number,
    columnCount: number,
): number {
    const normalized = normalizeColumnCount(columnCount);
    return resolveSelectionListSectionColumnCount(optionCount, normalized) === 1
        ? normalized
        : 1;
}

export function buildSelectionListGridGeometry(params: Readonly<{
    groups: ReadonlyArray<SelectionListGridGeometryGroup>;
    columnCount: number;
}>): SelectionListGridGeometry {
    const columnCount = normalizeColumnCount(params.columnCount);
    const cells: SelectionListGridCell[] = [];
    let row = -1;
    let navIndex = 0;
    for (const group of params.groups) {
        if (group.options.length === 0) continue;
        const groupColumnCount = resolveSelectionListSectionColumnCount(
            group.options.length,
            columnCount,
        );
        // A fresh group always starts a fresh visual row.
        let column = groupColumnCount;
        for (const option of group.options) {
            if (column >= groupColumnCount) {
                row += 1;
                column = 0;
            }
            const focusable = option.focusable;
            cells.push({
                optionId: option.id,
                groupId: group.id,
                row,
                column,
                focusable,
                navIndex: focusable ? navIndex : null,
            });
            if (focusable) navIndex += 1;
            column += 1;
        }
    }
    return { columnCount, rowCount: row + 1, cells };
}

function findCellByNavIndex(
    geometry: SelectionListGridGeometry,
    navIndex: number,
): SelectionListGridCell | null {
    for (const cell of geometry.cells) {
        if (cell.navIndex === navIndex) return cell;
    }
    return null;
}

/**
 * Nearest focusable cell in `row`, preferring the same column and breaking
 * ties toward the smaller column so the movement is deterministic.
 */
function nearestFocusableInRow(
    geometry: SelectionListGridGeometry,
    row: number,
    preferredColumn: number,
): SelectionListGridCell | null {
    let best: SelectionListGridCell | null = null;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (const cell of geometry.cells) {
        if (cell.row !== row) continue;
        if (!cell.focusable || cell.navIndex === null) continue;
        const distance = Math.abs(cell.column - preferredColumn);
        if (distance < bestDistance) {
            best = cell;
            bestDistance = distance;
        }
    }
    return best;
}

export type SelectionListGridArrowResult = Readonly<{
    /** Position within `flatVisibleOptionIds` to focus. */
    navIndex: number;
    /**
     * The column the user is AIMING at, which is not always the column they
     * landed in: passing down through a row whose matching cell is disabled
     * lands one column over. Feeding this back on the next vertical press is
     * what makes the roving focus return to its column instead of drifting —
     * the same "desired column" every native grid remembers.
     */
    desiredColumn: number;
}>;

/**
 * Resolve an arrow press to a nav index (a position within
 * `flatVisibleOptionIds`), or `null` when the grid has no opinion.
 *
 * `null` is a real answer, not a failure: the keyboard hook treats it as
 * "fall back to my own behavior". That is what keeps a single-column list
 * byte-identical to today (vertical modulo wrap) and lets ArrowLeft at the
 * left edge of a row release the key back to the text caret.
 *
 * - **Vertical** walks whole rows, wrapping past the last row, and lands on
 *   the nearest focusable column so a disabled neighbour is stepped over
 *   rather than swallowing the key.
 * - **Horizontal** stays inside its own row and clamps at the edges. Wrapping
 *   sideways into the next row would duplicate what ↓ already does while
 *   stealing the caret keys the input still needs.
 */
export function resolveSelectionListGridArrowTarget(
    geometry: SelectionListGridGeometry,
    currentNavIndex: number,
    key: SelectionListGridArrowKey,
    /**
     * Column the caller remembered from the previous move, or `null` for a
     * fresh aim. Ignored for horizontal keys, which by definition re-aim.
     */
    desiredColumn?: number | null,
): SelectionListGridArrowResult | null {
    if (geometry.columnCount <= 1) return null;
    if (geometry.rowCount <= 0) return null;
    const current = findCellByNavIndex(geometry, currentNavIndex);
    if (current === null) return null;

    if (key === 'ArrowLeft' || key === 'ArrowRight') {
        const step = key === 'ArrowRight' ? 1 : -1;
        for (
            let column = current.column + step;
            column >= 0 && column < geometry.columnCount;
            column += step
        ) {
            const match = geometry.cells.find(
                (cell) => cell.row === current.row
                    && cell.column === column
                    && cell.focusable
                    && cell.navIndex !== null,
            );
            if (match?.navIndex !== undefined && match.navIndex !== null) {
                return { navIndex: match.navIndex, desiredColumn: match.column };
            }
        }
        return null;
    }

    const step = key === 'ArrowDown' ? 1 : -1;
    const rowCount = geometry.rowCount;
    // A remembered aim survives rows that could not honour it. Without it, one
    // pass over a disabled cell would permanently move the roving column.
    const preferredColumn = typeof desiredColumn === 'number' && desiredColumn >= 0
        ? desiredColumn
        : current.column;
    for (let offset = 1; offset < rowCount; offset += 1) {
        const row = (((current.row + (step * offset)) % rowCount) + rowCount) % rowCount;
        const match = nearestFocusableInRow(geometry, row, preferredColumn);
        if (match?.navIndex !== undefined && match.navIndex !== null) {
            return { navIndex: match.navIndex, desiredColumn: preferredColumn };
        }
    }
    return null;
}
