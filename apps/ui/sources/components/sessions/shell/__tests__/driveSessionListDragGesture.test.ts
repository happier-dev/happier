import { describe, expect, it, vi } from 'vitest';

import { createGestureHandlerMock } from '@/dev/testkit';
import { driveSessionListDragGesture } from './driveSessionListDragGesture';

describe('driveSessionListDragGesture', () => {
    it('drives the recorded pan gesture through its lifecycle', async () => {
        const gestureModule = createGestureHandlerMock();
        const onStart = vi.fn();
        const onUpdate = vi.fn();
        const onEnd = vi.fn();
        const gesture = gestureModule.Gesture.Pan()
            .onStart(onStart)
            .onUpdate(onUpdate)
            .onEnd(onEnd);

        await driveSessionListDragGesture({
            gesture,
            pointerSequence: [
                { x: 10, y: 20 },
                { x: 12, y: 55 },
                { x: 14, y: 90 },
            ],
        });

        expect(onStart).toHaveBeenCalledTimes(1);
        expect(onUpdate).toHaveBeenCalledTimes(2);
        expect(onUpdate).toHaveBeenNthCalledWith(1, expect.objectContaining({
            absoluteX: 12,
            absoluteY: 55,
            translationY: 35,
        }));
        expect(onEnd).toHaveBeenCalledWith(expect.objectContaining({
            absoluteX: 14,
            absoluteY: 90,
            translationY: 70,
        }));
    });
});
