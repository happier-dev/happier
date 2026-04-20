import { describe, expect, it } from 'vitest';

import { resolveSplitCanvasDropTarget } from './splitCanvasDropTarget';

describe('resolveSplitCanvasDropTarget', () => {
    const rect = {
        left: 100,
        top: 200,
        width: 400,
        height: 240,
    };

    it('targets the left edge when the pointer is near the left boundary', () => {
        expect(resolveSplitCanvasDropTarget({
            rect,
            clientX: 120,
            clientY: 320,
            leafId: 'leaf-a',
        })).toEqual({
            leafId: 'leaf-a',
            placement: 'left',
        });
    });

    it('targets the right edge when the pointer is near the right boundary', () => {
        expect(resolveSplitCanvasDropTarget({
            rect,
            clientX: 480,
            clientY: 320,
            leafId: 'leaf-a',
        })).toEqual({
            leafId: 'leaf-a',
            placement: 'right',
        });
    });

    it('targets the top edge when the pointer is near the top boundary', () => {
        expect(resolveSplitCanvasDropTarget({
            rect,
            clientX: 260,
            clientY: 212,
            leafId: 'leaf-a',
        })).toEqual({
            leafId: 'leaf-a',
            placement: 'up',
        });
    });

    it('targets the center when the pointer stays within the ghost preview safe zone', () => {
        expect(resolveSplitCanvasDropTarget({
            rect,
            clientX: 280,
            clientY: 320,
            leafId: 'leaf-a',
        })).toEqual({
            leafId: 'leaf-a',
            placement: 'center',
        });
    });
});
