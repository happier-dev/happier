import { describe, expect, it } from 'vitest';

import { readSplitCanvasDropZone, resolveSplitCanvasDropTarget } from './splitCanvasDropTarget';

describe('resolveSplitCanvasDropTarget', () => {
    const rect = {
        left: 100,
        top: 200,
        width: 400,
        height: 240,
    };

    it('admits the displayed zone throughout its interior, including pane corners', () => {
        for (const placement of ['left', 'right', 'up', 'down', 'center'] as const) {
            const zone = readSplitCanvasDropZone(placement);
            for (const x of [0.01, 0.5, 0.99]) for (const y of [0.01, 0.5, 0.99]) {
                expect(resolveSplitCanvasDropTarget({ rect, leafId: 'leaf-a',
                    clientX: rect.left + rect.width * (zone.left + (zone.right - zone.left) * x),
                    clientY: rect.top + rect.height * (zone.top + (zone.bottom - zone.top) * y),
                }).placement).toBe(placement);
            }
        }
    });

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
