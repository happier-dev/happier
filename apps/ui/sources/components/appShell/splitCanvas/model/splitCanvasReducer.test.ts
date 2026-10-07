import { describe, expect, it } from 'vitest';
import {
    collectSplitCanvasLeafIds,
    findAdjacentSplitCanvasLeafId,
    isSplitCanvasLeafVisible,
} from './splitCanvasSelectors';
import {
    createSplitCanvasState,
    splitCanvasReduce,
    SPLIT_CANVAS_RATIO_MAX,
    SPLIT_CANVAS_RATIO_MIN,
} from './splitCanvasReducer';

function createLeaf(id: string, payload: string = id) {
    return {
        id,
        kind: 'leaf' as const,
        leafKind: 'test',
        payload,
    };
}

describe('splitCanvasReduce', () => {
    it('reveals the fallback or moved leaf when tree edits change focus under maximize', () => {
        let state = createSplitCanvasState({ root: createLeaf('leaf-a') });
        state = splitCanvasReduce(state, {
            type: 'splitLeaf', targetLeafId: 'leaf-a', axis: 'row', placement: 'after', newLeaf: createLeaf('leaf-b'),
        });
        state = splitCanvasReduce(state, {
            type: 'splitLeaf', targetLeafId: 'leaf-b', axis: 'column', placement: 'after', newLeaf: createLeaf('leaf-c'),
        });
        state = splitCanvasReduce(state, { type: 'toggleMaximizeLeaf', leafId: 'leaf-a' });
        const closed = splitCanvasReduce(state, { type: 'closeLeaf', leafId: 'leaf-c' });
        expect(closed.focusedLeafId).toBe('leaf-b');
        expect(isSplitCanvasLeafVisible(closed, 'leaf-b')).toBe(true);

        const moved = splitCanvasReduce(state, {
            type: 'moveLeaf', sourceLeafId: 'leaf-b', targetLeafId: 'leaf-c', placement: 'after',
        });
        expect(moved.focusedLeafId).toBe('leaf-b');
        expect(isSplitCanvasLeafVisible(moved, 'leaf-b')).toBe(true);
        const maximizedSource = splitCanvasReduce(state, { type: 'toggleMaximizeLeaf', leafId: 'leaf-b' });
        expect(splitCanvasReduce(maximizedSource, {
            type: 'moveLeaf', sourceLeafId: 'leaf-b', targetLeafId: 'leaf-c', placement: 'after',
        }).maximizedLeafId).toBe('leaf-b');
    });

    it('reveals a newly focused leaf while preserving maximize for the same leaf', () => {
        let state = createSplitCanvasState({ root: createLeaf('leaf-a') });
        state = splitCanvasReduce(state, {
            type: 'splitLeaf', targetLeafId: 'leaf-a', axis: 'row', placement: 'after', newLeaf: createLeaf('leaf-b'),
        });
        state = splitCanvasReduce(state, { type: 'toggleMaximizeLeaf', leafId: 'leaf-a' });
        expect(splitCanvasReduce(state, { type: 'focusLeaf', leafId: 'leaf-a' })).toBe(state);
        const focused = splitCanvasReduce(state, { type: 'focusLeaf', leafId: 'leaf-b' });
        expect(focused.focusedLeafId).toBe('leaf-b');
        expect(isSplitCanvasLeafVisible(focused, 'leaf-b')).toBe(true);
    });

    it('restores the normal layout only when a maximized split succeeds', () => {
        const state = createSplitCanvasState({ root: createLeaf('leaf-a'), maximizedLeafId: 'leaf-a' });
        const action = {
            type: 'splitLeaf' as const, targetLeafId: 'leaf-a', axis: 'row' as const, placement: 'after' as const,
            newLeaf: createLeaf('leaf-b'), availableSizePx: 500, minimumFirstSizePx: 300, minimumSecondSizePx: 300,
        };
        expect(splitCanvasReduce(state, action)).toBe(state);
        const split = splitCanvasReduce(state, { ...action, availableSizePx: 600 });
        expect(split.focusedLeafId).toBe('leaf-b');
        expect(split.maximizedLeafId).toBeNull();
        expect(isSplitCanvasLeafVisible(split, 'leaf-a')).toBe(true);
        expect(isSplitCanvasLeafVisible(split, 'leaf-b')).toBe(true);
    });

    it('splits a leaf and focuses the newly inserted leaf', () => {
        let state = createSplitCanvasState({
            root: createLeaf('leaf-a'),
            focusedLeafId: 'leaf-a',
        });

        state = splitCanvasReduce(state, {
            type: 'splitLeaf',
            targetLeafId: 'leaf-a',
            axis: 'row',
            placement: 'after',
            newLeaf: createLeaf('leaf-b'),
        });

        expect(collectSplitCanvasLeafIds(state)).toEqual(['leaf-a', 'leaf-b']);
        expect(state.focusedLeafId).toBe('leaf-b');
        expect(state.root).toMatchObject({
            kind: 'split',
            axis: 'row',
            ratio: 0.5,
            first: { id: 'leaf-a' },
            second: { id: 'leaf-b' },
        });
    });

    it('collapses parent split nodes when a leaf closes', () => {
        let state = createSplitCanvasState({
            root: createLeaf('leaf-a'),
            focusedLeafId: 'leaf-a',
        });

        state = splitCanvasReduce(state, {
            type: 'splitLeaf',
            targetLeafId: 'leaf-a',
            axis: 'row',
            placement: 'after',
            newLeaf: createLeaf('leaf-b'),
        });
        state = splitCanvasReduce(state, {
            type: 'closeLeaf',
            leafId: 'leaf-b',
        });

        expect(state.root).toEqual(createLeaf('leaf-a'));
        expect(state.focusedLeafId).toBe('leaf-a');
    });

    it('preserves state identity when focusing the already-focused leaf', () => {
        const state = createSplitCanvasState({
            root: createLeaf('leaf-a'),
            focusedLeafId: 'leaf-a',
        });

        const nextState = splitCanvasReduce(state, {
            type: 'focusLeaf',
            leafId: 'leaf-a',
        });

        expect(nextState).toBe(state);
    });

    it('moves a leaf before another leaf without duplicating it', () => {
        let state = createSplitCanvasState({
            root: createLeaf('leaf-a'),
            focusedLeafId: 'leaf-a',
        });

        state = splitCanvasReduce(state, {
            type: 'splitLeaf',
            targetLeafId: 'leaf-a',
            axis: 'row',
            placement: 'after',
            newLeaf: createLeaf('leaf-b'),
        });
        state = splitCanvasReduce(state, {
            type: 'splitLeaf',
            targetLeafId: 'leaf-b',
            axis: 'row',
            placement: 'after',
            newLeaf: createLeaf('leaf-c'),
        });

        state = splitCanvasReduce(state, {
            type: 'moveLeaf',
            sourceLeafId: 'leaf-c',
            targetLeafId: 'leaf-a',
            placement: 'before',
        });

        expect(collectSplitCanvasLeafIds(state)).toEqual(['leaf-c', 'leaf-a', 'leaf-b']);
        expect(state.focusedLeafId).toBe('leaf-c');
    });

    it('clamps ratios and toggles maximize state', () => {
        let state = createSplitCanvasState({
            root: createLeaf('leaf-a'),
            focusedLeafId: 'leaf-a',
        });

        state = splitCanvasReduce(state, {
            type: 'splitLeaf',
            targetLeafId: 'leaf-a',
            axis: 'column',
            placement: 'after',
            newLeaf: createLeaf('leaf-b'),
        });

        const splitId = state.root?.kind === 'split' ? state.root.id : null;
        expect(splitId).not.toBeNull();

        state = splitCanvasReduce(state, {
            type: 'setSplitRatio',
            splitId: splitId!,
            ratio: 0.98,
        });

        expect(state.root).toMatchObject({
            kind: 'split',
            ratio: SPLIT_CANVAS_RATIO_MAX,
        });

        state = splitCanvasReduce(state, {
            type: 'setSplitRatio',
            splitId: splitId!,
            ratio: 0.02,
        });

        expect(state.root).toMatchObject({
            kind: 'split',
            ratio: SPLIT_CANVAS_RATIO_MIN,
        });

        state = splitCanvasReduce(state, {
            type: 'toggleMaximizeLeaf',
            leafId: 'leaf-a',
        });
        expect(state.maximizedLeafId).toBe('leaf-a');

        state = splitCanvasReduce(state, {
            type: 'toggleMaximizeLeaf',
            leafId: 'leaf-a',
        });
        expect(state.maximizedLeafId).toBeNull();
    });

    it('keeps unmeasured legacy split requests free of an arbitrary pane-count ceiling', () => {
        let state = createSplitCanvasState({ root: createLeaf('leaf-0') });
        for (let index = 1; index < 10; index++) {
            state = splitCanvasReduce(state, {
                type: 'splitLeaf', targetLeafId: `leaf-${index - 1}`, axis: 'row', placement: 'after',
                newLeaf: createLeaf(`leaf-${index}`),
            });
        }
        expect(collectSplitCanvasLeafIds(state)).toHaveLength(10);
    });

    it('admits a ninth nested leaf when its measured view minimums fit', () => {
        let state = createSplitCanvasState({ root: createLeaf('leaf-0') });
        for (let index = 1; index <= 8; index += 1) {
            state = splitCanvasReduce(state, {
                type: 'splitLeaf',
                targetLeafId: `leaf-${index - 1}`,
                axis: 'row',
                placement: 'after',
                newLeaf: createLeaf(`leaf-${index}`),
                availableSizePx: 1000,
                minimumFirstSizePx: 100,
                minimumSecondSizePx: 100,
            });
        }

        expect(collectSplitCanvasLeafIds(state)).toHaveLength(9);
    });

    it('refuses a split when either view would be narrower than its minimum', () => {
        const state = createSplitCanvasState({ root: createLeaf('leaf-a') });
        const refused = splitCanvasReduce(state, {
            type: 'splitLeaf',
            targetLeafId: 'leaf-a',
            axis: 'row',
            placement: 'after',
            newLeaf: createLeaf('leaf-b'),
            availableSizePx: 600,
            minimumFirstSizePx: 350,
            minimumSecondSizePx: 300,
        });

        expect(refused).toBe(state);
    });

    it('clamps a measured divider resize to both child view minimums', () => {
        let state = createSplitCanvasState({ root: createLeaf('leaf-a') });
        state = splitCanvasReduce(state, {
            type: 'splitLeaf', targetLeafId: 'leaf-a', axis: 'row', placement: 'after',
            newLeaf: createLeaf('leaf-b'), availableSizePx: 700,
            minimumFirstSizePx: 300, minimumSecondSizePx: 100,
        });
        const splitId = state.root?.id;
        state = splitCanvasReduce(state, {
            type: 'setSplitRatio', splitId: splitId!, ratio: 0.4,
            availableSizePx: 700, minimumFirstSizePx: 400, minimumSecondSizePx: 100,
        });

        expect(state.root).toMatchObject({ kind: 'split', ratio: 400 / 700 });
    });

    it('finds adjacent leaves from the normalized layout geometry', () => {
        let state = createSplitCanvasState({
            root: createLeaf('leaf-a'),
            focusedLeafId: 'leaf-a',
        });

        state = splitCanvasReduce(state, {
            type: 'splitLeaf',
            targetLeafId: 'leaf-a',
            axis: 'column',
            placement: 'after',
            newLeaf: createLeaf('leaf-b'),
        });
        state = splitCanvasReduce(state, {
            type: 'splitLeaf',
            targetLeafId: 'leaf-a',
            axis: 'row',
            placement: 'after',
            newLeaf: createLeaf('leaf-c'),
        });
        state = splitCanvasReduce(state, {
            type: 'splitLeaf',
            targetLeafId: 'leaf-b',
            axis: 'row',
            placement: 'after',
            newLeaf: createLeaf('leaf-d'),
        });

        expect(findAdjacentSplitCanvasLeafId(state, 'leaf-a', 'right')).toBe('leaf-c');
        expect(findAdjacentSplitCanvasLeafId(state, 'leaf-a', 'down')).toBe('leaf-b');
        expect(findAdjacentSplitCanvasLeafId(state, 'leaf-d', 'left')).toBe('leaf-b');
        expect(findAdjacentSplitCanvasLeafId(state, 'leaf-d', 'up')).toBe('leaf-c');
    });
});
