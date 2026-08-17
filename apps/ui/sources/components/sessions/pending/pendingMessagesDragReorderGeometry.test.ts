import { describe, expect, it } from 'vitest';

import {
    findTargetIndexAtCenterY,
    moveIdToIndex,
    resolveRowDragDisplacementPx,
    resolveRowOffsetPx,
    resolveRowsTotalHeightPx,
} from './pendingMessagesDragReorderGeometry';

/**
 * M1 (2026-08-10) — the pending queue's drag reorder after the layout removal.
 *
 * The rows now sit in NORMAL FLOW: the block's height is theirs, no shared value holds a total, and
 * nothing substitutes an estimated height for a row that has not laid out yet. Drag reorder still
 * has to work, and it is a path the user interacts with directly, so its whole decision — where a
 * dragged row lands, and how far each other row must move to open the slot — is pinned here.
 *
 * The heights are the measured ones the rows report through `onLayout`; a queued message is a
 * bubble whose height follows its text, so they are deliberately unequal in every case below.
 */
const HEIGHTS = { a: 60, b: 100, c: 40 } as const;
const ORDER = ['a', 'b', 'c'] as const;

describe('pending queue drag geometry', () => {
    it('offsets each row by the measured heights above it', () => {
        expect(resolveRowOffsetPx(ORDER, HEIGHTS, 'a')).toBe(0);
        expect(resolveRowOffsetPx(ORDER, HEIGHTS, 'b')).toBe(60);
        expect(resolveRowOffsetPx(ORDER, HEIGHTS, 'c')).toBe(160);
        expect(resolveRowsTotalHeightPx(ORDER, HEIGHTS)).toBe(200);
    });

    it('gives an unmeasured row no extent instead of an estimated one', () => {
        // The removed model substituted `transcriptPendingQueueReorderRowHeightPx` (72) here, and
        // that substitution WAS the block's painted height for a frame. A row that has not laid out
        // has painted nothing, so it displaces nothing — and the rows below it are not pushed down
        // by a number no row ever had.
        const partial = { a: 60 };
        expect(resolveRowOffsetPx(ORDER, partial, 'b')).toBe(60);
        expect(resolveRowOffsetPx(ORDER, partial, 'c')).toBe(60);
        expect(resolveRowsTotalHeightPx(ORDER, partial)).toBe(60);
    });

    it('drops a dragged row into the slot its centre is over', () => {
        // Row midpoints in this order: a at 30, b at 110, c at 180.
        expect(findTargetIndexAtCenterY(ORDER, HEIGHTS, 0)).toBe(0);
        expect(findTargetIndexAtCenterY(ORDER, HEIGHTS, 29)).toBe(0);
        expect(findTargetIndexAtCenterY(ORDER, HEIGHTS, 31)).toBe(1);
        expect(findTargetIndexAtCenterY(ORDER, HEIGHTS, 109)).toBe(1);
        expect(findTargetIndexAtCenterY(ORDER, HEIGHTS, 111)).toBe(2);
        // Past the end of the list the last slot is the answer, never an out-of-range index.
        expect(findTargetIndexAtCenterY(ORDER, HEIGHTS, 10_000)).toBe(2);
    });

    it('reorders by moving the dragged id and leaving the others in sequence', () => {
        expect(moveIdToIndex(ORDER, 'a', 2)).toEqual(['b', 'c', 'a']);
        expect(moveIdToIndex(ORDER, 'c', 0)).toEqual(['c', 'a', 'b']);
        expect(moveIdToIndex(ORDER, 'b', 1)).toEqual(['a', 'b', 'c']);
        expect(moveIdToIndex(ORDER, 'missing', 0)).toEqual(['a', 'b', 'c']);
    });

    it('moves every displaced row by exactly the gap the drag opens, and the rest not at all', () => {
        // Drag `a` (60px tall) to the end: `b` and `c` each rise by a's height, and the flow order
        // still has `a` in its original slot, so `a` itself must travel the sum of the two.
        const dragged = ['b', 'c', 'a'];
        const displacement = (id: string) => resolveRowDragDisplacementPx({
            flowIds: ORDER,
            orderedIds: dragged,
            heights: HEIGHTS,
            id,
        });
        expect(displacement('b')).toBe(-HEIGHTS.a);
        expect(displacement('c')).toBe(-HEIGHTS.a);
        expect(displacement('a')).toBe(HEIGHTS.b + HEIGHTS.c);
    });

    it('displaces nothing while the rendered order already is the drag order', () => {
        // This is every frame outside a drag, and the frame the persisted reorder lands on. A
        // non-zero answer here would be a transform fighting the flow position of the same row.
        for (const id of ORDER) {
            expect(resolveRowDragDisplacementPx({
                flowIds: ORDER,
                orderedIds: ORDER,
                heights: HEIGHTS,
                id,
            })).toBe(0);
        }
        // ...including once the queue itself has re-rendered in the dragged order.
        const settled = ['b', 'c', 'a'];
        for (const id of settled) {
            expect(resolveRowDragDisplacementPx({
                flowIds: settled,
                orderedIds: settled,
                heights: HEIGHTS,
                id,
            })).toBe(0);
        }
    });
});
