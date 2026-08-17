import { describe, expect, it } from 'vitest';

import {
    buildSelectionListGridGeometry,
    resolveSelectionListGridArrowTarget,
    resolveSelectionListSectionColumnCount,
    resolveSelectionListSectionColumnSpan,
    type SelectionListGridGeometryGroup,
} from '../selectionListGridGeometry';

function group(
    id: string,
    options: ReadonlyArray<readonly [string, boolean]>,
): SelectionListGridGeometryGroup {
    return { id, options: options.map(([optionId, focusable]) => ({ id: optionId, focusable })) };
}

function allFocusable(id: string, ids: ReadonlyArray<string>): SelectionListGridGeometryGroup {
    return group(id, ids.map((optionId) => [optionId, true] as const));
}

function positionOf(
    geometry: ReturnType<typeof buildSelectionListGridGeometry>,
    optionId: string,
): { row: number; column: number; navIndex: number | null } {
    const cell = geometry.cells.find((candidate) => candidate.optionId === optionId);
    if (!cell) throw new Error(`no geometry cell for ${optionId}`);
    return { row: cell.row, column: cell.column, navIndex: cell.navIndex };
}

describe('buildSelectionListGridGeometry', () => {
    it('fills row-major so reading order matches arrow roving', () => {
        const geometry = buildSelectionListGridGeometry({
            groups: [allFocusable('s', ['a', 'b', 'c', 'd', 'e', 'f'])],
            columnCount: 2,
        });
        expect(geometry.cells.map((cell) => [cell.optionId, cell.row, cell.column])).toEqual([
            ['a', 0, 0],
            ['b', 0, 1],
            ['c', 1, 0],
            ['d', 1, 1],
            ['e', 2, 0],
            ['f', 2, 1],
        ]);
        expect(geometry.rowCount).toBe(3);
    });

    it('keeps DISABLED options in the layout while leaving them out of nav order', () => {
        // `flatVisibleOptionIds` is ['a', 'c', 'd'] — 'b' is disabled. The grid
        // must still paint 'b' in its cell, otherwise unauthorized/experimental
        // model rows would vanish from the pane entirely.
        const geometry = buildSelectionListGridGeometry({
            groups: [group('s', [['a', true], ['b', false], ['c', true], ['d', true]])],
            columnCount: 2,
        });
        expect(geometry.cells.map((cell) => cell.optionId)).toEqual(['a', 'b', 'c', 'd']);
        expect(positionOf(geometry, 'b')).toEqual({ row: 0, column: 1, navIndex: null });
        expect(positionOf(geometry, 'c')).toEqual({ row: 1, column: 0, navIndex: 1 });
        expect(positionOf(geometry, 'd')).toEqual({ row: 1, column: 1, navIndex: 2 });
    });

    it('never lets a visual row span two groups', () => {
        const geometry = buildSelectionListGridGeometry({
            groups: [allFocusable('first', ['a', 'b', 'c']), allFocusable('second', ['d', 'e'])],
            columnCount: 2,
        });
        expect(positionOf(geometry, 'c')).toEqual({ row: 1, column: 0, navIndex: 2 });
        expect(positionOf(geometry, 'd')).toEqual({ row: 2, column: 0, navIndex: 3 });
        expect(positionOf(geometry, 'e')).toEqual({ row: 2, column: 1, navIndex: 4 });
        expect(geometry.rowCount).toBe(3);
    });

    it('numbers navIndex by position among focusable options across all groups', () => {
        const geometry = buildSelectionListGridGeometry({
            groups: [
                group('first', [['a', true], ['b', false]]),
                group('second', [['c', false], ['d', true], ['e', true]]),
            ],
            columnCount: 2,
        });
        const navOrder = geometry.cells
            .filter((cell) => cell.navIndex !== null)
            .map((cell) => cell.optionId);
        expect(navOrder).toEqual(['a', 'd', 'e']);
        expect(geometry.cells.map((cell) => cell.navIndex)).toEqual([0, null, null, 1, 2]);
    });

    it('gives a section too short to fill a row the whole width', () => {
        // The shipped shape of the model picker: a one-option recovery section
        // above the real list. Chunked at the pane's column count it rendered
        // one card at half width beside a blank spacer.
        const geometry = buildSelectionListGridGeometry({
            groups: [
                allFocusable('recovery', ['current']),
                allFocusable('models', ['a', 'b', 'c']),
            ],
            columnCount: 2,
        });
        expect(positionOf(geometry, 'current')).toEqual({ row: 0, column: 0, navIndex: 0 });
        expect(resolveSelectionListSectionColumnCount(1, 2)).toBe(1);
        expect(resolveSelectionListSectionColumnSpan(1, 2)).toBe(2);
        // …while the section that CAN fill a row is untouched, including its
        // trailing partial row: there the neighbours establish the grid.
        expect(positionOf(geometry, 'a')).toEqual({ row: 1, column: 0, navIndex: 1 });
        expect(positionOf(geometry, 'b')).toEqual({ row: 1, column: 1, navIndex: 2 });
        expect(positionOf(geometry, 'c')).toEqual({ row: 2, column: 0, navIndex: 3 });
        expect(resolveSelectionListSectionColumnCount(3, 2)).toBe(2);
        expect(resolveSelectionListSectionColumnSpan(3, 2)).toBe(1);
        expect(geometry.rowCount).toBe(3);
    });

    it('leaves a section that exactly fills a row at full column width', () => {
        expect(resolveSelectionListSectionColumnCount(2, 2)).toBe(2);
        expect(resolveSelectionListSectionColumnSpan(2, 2)).toBe(1);
        // Two options in a THREE-column pane cannot fill a row either.
        expect(resolveSelectionListSectionColumnCount(2, 3)).toBe(1);
        expect(resolveSelectionListSectionColumnSpan(2, 3)).toBe(3);
    });

    it('collapses to one cell per row when a single column is requested', () => {
        const geometry = buildSelectionListGridGeometry({
            groups: [allFocusable('s', ['a', 'b', 'c'])],
            columnCount: 1,
        });
        expect(geometry.rowCount).toBe(3);
        expect(geometry.cells.every((cell) => cell.column === 0)).toBe(true);
    });
});

/** The nav index an arrow resolves to, or `null` when the grid declines. */
function arrowNavIndex(
    geometry: ReturnType<typeof buildSelectionListGridGeometry>,
    currentNavIndex: number,
    key: Parameters<typeof resolveSelectionListGridArrowTarget>[2],
    desiredColumn?: number | null,
): number | null {
    return resolveSelectionListGridArrowTarget(
        geometry,
        currentNavIndex,
        key,
        desiredColumn,
    )?.navIndex ?? null;
}

describe('resolveSelectionListGridArrowTarget', () => {
    const sixCells = buildSelectionListGridGeometry({
        groups: [allFocusable('s', ['a', 'b', 'c', 'd', 'e', 'f'])],
        columnCount: 2,
    });

    it('moves horizontally by one column inside its own row', () => {
        expect(arrowNavIndex(sixCells, 0, 'ArrowRight')).toBe(1);
        expect(arrowNavIndex(sixCells, 3, 'ArrowLeft')).toBe(2);
    });

    it('clamps horizontally at the row edges so the caret keeps the key', () => {
        expect(arrowNavIndex(sixCells, 1, 'ArrowRight')).toBeNull();
        expect(arrowNavIndex(sixCells, 2, 'ArrowLeft')).toBeNull();
    });

    it('moves vertically by a whole row, not by one index', () => {
        expect(arrowNavIndex(sixCells, 0, 'ArrowDown')).toBe(2);
        expect(arrowNavIndex(sixCells, 3, 'ArrowUp')).toBe(1);
    });

    it('wraps vertically past the last row, keeping the column', () => {
        expect(arrowNavIndex(sixCells, 5, 'ArrowDown')).toBe(1);
        expect(arrowNavIndex(sixCells, 0, 'ArrowUp')).toBe(4);
    });

    it('steps over a disabled cell instead of swallowing the key', () => {
        // Row 1 is [disabled, c]. ↓ from 'a' (row 0, col 0) must land on 'c'.
        const geometry = buildSelectionListGridGeometry({
            groups: [group('s', [['a', true], ['b', true], ['x', false], ['c', true]])],
            columnCount: 2,
        });
        expect(arrowNavIndex(geometry, 0, 'ArrowDown')).toBe(2);
    });

    it('skips a disabled cell when moving horizontally', () => {
        const geometry = buildSelectionListGridGeometry({
            groups: [group('s', [['a', true], ['x', false], ['c', true]])],
            columnCount: 3,
        });
        expect(arrowNavIndex(geometry, 0, 'ArrowRight')).toBe(1);
        expect(arrowNavIndex(geometry, 1, 'ArrowLeft')).toBe(0);
    });

    it('skips a fully disabled row when moving vertically', () => {
        const geometry = buildSelectionListGridGeometry({
            groups: [group('s', [
                ['a', true], ['b', true],
                ['x', false], ['y', false],
                ['c', true], ['d', true],
            ])],
            columnCount: 2,
        });
        expect(arrowNavIndex(geometry, 0, 'ArrowDown')).toBe(2);
    });

    it('has no opinion at all in a single-column geometry', () => {
        const geometry = buildSelectionListGridGeometry({
            groups: [allFocusable('s', ['a', 'b', 'c'])],
            columnCount: 1,
        });
        for (const key of ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'] as const) {
            expect(arrowNavIndex(geometry, 0, key)).toBeNull();
        }
    });

    it('returns null for a nav index the geometry does not contain', () => {
        expect(arrowNavIndex(sixCells, -1, 'ArrowDown')).toBeNull();
        expect(arrowNavIndex(sixCells, 99, 'ArrowDown')).toBeNull();
    });

    it('reports the column the move AIMED at, not always the one it reached', () => {
        // Row 1 is [disabled, c]: ↓ from 'a' (column 0) has to land in column 1,
        // but the user is still aiming at column 0.
        const geometry = buildSelectionListGridGeometry({
            groups: [group('s', [['a', true], ['b', true], ['x', false], ['c', true]])],
            columnCount: 2,
        });
        expect(resolveSelectionListGridArrowTarget(geometry, 0, 'ArrowDown')).toEqual({
            navIndex: 2,
            desiredColumn: 0,
        });
        // A horizontal move re-aims: the column it reached IS the new aim.
        expect(resolveSelectionListGridArrowTarget(geometry, 0, 'ArrowRight')).toEqual({
            navIndex: 1,
            desiredColumn: 1,
        });
    });

    it('honours a remembered column so passing a disabled cell does not move the aim', () => {
        //   row 0:  a       b
        //   row 1:  x(off)  c
        //   row 2:  d       e
        // ↓ ↓ from 'a' must reach 'd' (column 0), not 'e' — the detour through
        // row 1 landed in column 1 but never changed what the user was aiming at.
        const geometry = buildSelectionListGridGeometry({
            groups: [group('s', [
                ['a', true], ['b', true],
                ['x', false], ['c', true],
                ['d', true], ['e', true],
            ])],
            columnCount: 2,
        });
        const first = resolveSelectionListGridArrowTarget(geometry, 0, 'ArrowDown');
        expect(first).toEqual({ navIndex: 2, desiredColumn: 0 });
        expect(resolveSelectionListGridArrowTarget(
            geometry,
            first!.navIndex,
            'ArrowDown',
            first!.desiredColumn,
        )).toEqual({ navIndex: 3, desiredColumn: 0 });
        // Without the memory the second press keeps the column it landed in.
        expect(arrowNavIndex(geometry, 2, 'ArrowDown')).toBe(4);
    });

    it('returns null when the only row has no other focusable cell to reach', () => {
        const geometry = buildSelectionListGridGeometry({
            groups: [group('s', [['a', true], ['x', false]])],
            columnCount: 2,
        });
        expect(arrowNavIndex(geometry, 0, 'ArrowDown')).toBeNull();
        expect(arrowNavIndex(geometry, 0, 'ArrowRight')).toBeNull();
    });
});
