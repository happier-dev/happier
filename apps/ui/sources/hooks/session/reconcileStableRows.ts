/**
 * Keep object identity for rows that did not change.
 *
 * A derivation that rebuilds its whole list on every input tick hands every consumer a new array of
 * new objects, so `React.memo` on a row never holds and every downstream `useMemo` recomputes. The
 * previous defence in this corridor was a `JSON.stringify` of the entire derived array — one full
 * serialisation per recompute, which both allocated a large string on a hot path and could only
 * decide "the whole list changed" or "nothing changed": a single row moving to `succeeded`
 * invalidated every other row's identity too.
 *
 * `reconcileStableRows` decides that per row, by key, so one row changing costs one new object.
 */

const MAX_STRUCTURAL_COMPARE_DEPTH = 8;

/**
 * Structural equality over plain data.
 *
 * Deliberately matches `JSON.stringify` semantics on the one case that differs from a naive key
 * walk: a property explicitly set to `undefined` is equal to that property being absent. Derivations
 * in this corridor mix conditional spreads with `?? undefined`, so treating those as different
 * would report "changed" forever and quietly disable the memo this function exists to enable.
 *
 * Unlike `JSON.stringify` it is key-order independent, allocates nothing on the equal path, and
 * short-circuits on the first difference. Beyond `MAX_STRUCTURAL_COMPARE_DEPTH` it reports "not
 * equal", which costs a redundant re-derivation and never a stale row.
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
    const leftKeys = Object.keys(leftRecord);
    const rightKeys = Object.keys(rightRecord);

    for (const key of leftKeys) {
        if (!Object.prototype.hasOwnProperty.call(rightRecord, key)) {
            if (leftRecord[key] !== undefined) return false;
            continue;
        }
        if (!areRowValuesStructurallyEqual(leftRecord[key], rightRecord[key], depth + 1)) return false;
    }

    for (const key of rightKeys) {
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
