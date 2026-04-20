import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { renderHook } from '@/dev/testkit';
import { createSplitCanvasState, splitCanvasReduce } from '../model/splitCanvasReducer';
import { useSplitCanvasPersistence } from './useSplitCanvasPersistence';

function createLeaf(id: string) {
    return {
        id,
        kind: 'leaf' as const,
        leafKind: 'test',
        payload: id,
    };
}

describe('useSplitCanvasPersistence', () => {
    it('serializes and persists canonical split state snapshots', async () => {
        const onPersist = vi.fn();
        const initialState = createSplitCanvasState({
            root: createLeaf('leaf-a'),
            focusedLeafId: 'leaf-a',
            maxLeaves: 4,
        });

        const hook = await renderHook(() => useSplitCanvasPersistence({
            state: initialState,
            onPersist,
        }));

        expect(onPersist).toHaveBeenCalledWith(expect.objectContaining({
            version: 1,
            focusedLeafId: 'leaf-a',
        }));

        const nextState = splitCanvasReduce(initialState, {
            type: 'splitLeaf',
            targetLeafId: 'leaf-a',
            axis: 'row',
            placement: 'after',
            newLeaf: createLeaf('leaf-b'),
        });

        await act(async () => {
            await hook.rerender(undefined);
        });

        const rerendered = await renderHook(() => useSplitCanvasPersistence({
            state: nextState,
            onPersist,
        }));
        await rerendered.rerender(undefined);

        expect(onPersist).toHaveBeenLastCalledWith(expect.objectContaining({
            focusedLeafId: 'leaf-b',
            root: expect.objectContaining({
                kind: 'split',
            }),
        }));
    });
});
