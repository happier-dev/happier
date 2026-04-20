import { describe, expect, it } from 'vitest';
import {
    collectSplitCanvasLeafIds,
    findAdjacentSplitCanvasLeafId,
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
    it('splits a leaf and focuses the newly inserted leaf', () => {
        let state = createSplitCanvasState({
            root: createLeaf('leaf-a'),
            focusedLeafId: 'leaf-a',
            maxLeaves: 4,
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
            maxLeaves: 4,
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
            maxLeaves: 4,
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
            maxLeaves: 6,
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
            maxLeaves: 4,
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

    it('enforces the configured maximum leaf count', () => {
        let state = createSplitCanvasState({
            root: createLeaf('leaf-a'),
            focusedLeafId: 'leaf-a',
            maxLeaves: 2,
        });

        state = splitCanvasReduce(state, {
            type: 'splitLeaf',
            targetLeafId: 'leaf-a',
            axis: 'row',
            placement: 'after',
            newLeaf: createLeaf('leaf-b'),
        });

        const limited = splitCanvasReduce(state, {
            type: 'splitLeaf',
            targetLeafId: 'leaf-b',
            axis: 'column',
            placement: 'after',
            newLeaf: createLeaf('leaf-c'),
        });

        expect(limited).toBe(state);
        expect(collectSplitCanvasLeafIds(limited)).toEqual(['leaf-a', 'leaf-b']);
    });

    it('finds adjacent leaves from the normalized layout geometry', () => {
        let state = createSplitCanvasState({
            root: createLeaf('leaf-a'),
            focusedLeafId: 'leaf-a',
            maxLeaves: 8,
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
