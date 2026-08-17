import * as React from 'react';

/**
 * Keep object identity for rows that did not change.
 *
 * A derivation that rebuilds its whole list on every input tick hands every consumer a new array of
 * new objects, so `React.memo` on a row never holds and every downstream `useMemo` recomputes. The
 * defence already in this corridor is a `JSON.stringify` of the entire derived array
 * (`useSessionSubagents.useStableValueBySignature`) — one full serialisation per recompute, which
 * both allocates a large string on a hot path and can only decide "the whole list changed" or
 * "nothing changed": one row moving to `succeeded` invalidates every other row's identity too.
 *
 * `reconcileStableRows` decides that per row, by key, so one row changing costs one new object.
 */

const MAX_STRUCTURAL_COMPARE_DEPTH = 8;

/**
 * Structural equality over plain data.
 *
 * A property explicitly set to `undefined` is equal to that property being absent: derivations here
 * mix conditional spreads with `?? undefined`, so treating those as different would report
 * "changed" forever and quietly disable the memo this function exists to enable.
 *
 * It allocates nothing on the equal path and short-circuits on the first difference. Beyond
 * `MAX_STRUCTURAL_COMPARE_DEPTH` it reports "not equal", which costs a redundant re-derivation and
 * never a stale row.
 */
export function areRowValuesStructurallyEqual(left: unknown, right: unknown, depth = 0): boolean {
    if (Object.is(left, right)) return true;
    if (left === null || right === null) return false;
    if (typeof left !== 'object' || typeof right !== 'object') return false;
    if (depth >= MAX_STRUCTURAL_COMPARE_DEPTH) return false;

    if (Array.isArray(left) || Array.isArray(right)) {
        if (!Array.isArray(left) || !Array.isArray(right)) return false;
        if (left.length !== right.length) return false;
        for (let index = 0; index < left.length; index += 1) {
            if (!areRowValuesStructurallyEqual(left[index], right[index], depth + 1)) return false;
        }
        return true;
    }

    const leftRecord = left as Record<string, unknown>;
    const rightRecord = right as Record<string, unknown>;

    for (const key of Object.keys(leftRecord)) {
        if (!Object.prototype.hasOwnProperty.call(rightRecord, key)) {
            if (leftRecord[key] !== undefined) return false;
            continue;
        }
        if (!areRowValuesStructurallyEqual(leftRecord[key], rightRecord[key], depth + 1)) return false;
    }

    for (const key of Object.keys(rightRecord)) {
        if (Object.prototype.hasOwnProperty.call(leftRecord, key)) continue;
        if (rightRecord[key] !== undefined) return false;
    }
    return true;
}

/**
 * Returns `previous` when nothing changed, otherwise a new array that reuses every unchanged row's
 * previous object. Rows are matched by key, so a reordered-but-unchanged row keeps its identity.
 */
export function reconcileStableRows<Row>(
    previous: readonly Row[],
    next: readonly Row[],
    readKey: (row: Row) => string,
): readonly Row[] {
    if (previous === next) return previous;
    if (previous.length === 0 && next.length === 0) return previous;

    const previousByKey = new Map<string, Row>();
    for (const row of previous) previousByKey.set(readKey(row), row);

    let changed = previous.length !== next.length;
    const reconciled = new Array<Row>(next.length);
    for (let index = 0; index < next.length; index += 1) {
        const row = next[index]!;
        const previousRow = previousByKey.get(readKey(row));
        const resolved = previousRow !== undefined && areRowValuesStructurallyEqual(previousRow, row)
            ? previousRow
            : row;
        reconciled[index] = resolved;
        if (!changed && previous[index] !== resolved) changed = true;
    }

    return changed ? reconciled : previous;
}

/**
 * `reconcileStableRows` across renders, holding the previous result in a ref.
 *
 * It lives with the reconciler rather than beside each derivation because a private copy per hook is
 * how two rosters end up with different notions of "unchanged". Written during render on purpose:
 * the reconciled array must be the one this render returns, not one an effect installs a frame
 * later.
 */
export function useReconciledStableRows<Row>(
    rows: readonly Row[],
    readKey: (row: Row) => string,
): readonly Row[] {
    const ref = React.useRef<readonly Row[]>(rows);
    ref.current = reconcileStableRows(ref.current, rows, readKey);
    return ref.current;
}
