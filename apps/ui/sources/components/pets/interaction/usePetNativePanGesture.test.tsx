import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { renderHook } from '@/dev/testkit';

import { PET_NATIVE_PAN_DRAG_THRESHOLD_PT, usePetNativePanGesture } from './usePetNativePanGesture';

type TestGesture = Readonly<{
    __config: Readonly<{ minDistance?: number; testId?: string }>;
    __handlers: Record<string, (...args: unknown[]) => void>;
}>;

describe('usePetNativePanGesture', () => {
    const bounds = { minX: 12, maxX: 282, minY: 71, maxY: 394 } as const;

    it('uses a 4 pt Pan gesture threshold and ignores starts inside native no-drag regions', async () => {
        const onPositionChange = vi.fn();
        const hook = await renderHook(() => usePetNativePanGesture({
            bounds,
            initialPoint: { x: 120, y: 200 },
            noDragRegions: [{ id: 'tray-action', x: 100, y: 180, width: 80, height: 60 }],
            onPositionChange,
        }));

        const gesture = hook.getCurrent().gesture as unknown as TestGesture;
        expect(gesture.__config.minDistance).toBe(PET_NATIVE_PAN_DRAG_THRESHOLD_PT);

        await act(async () => {
            gesture.__handlers.onBegin?.({
                absoluteX: 120,
                absoluteY: 200,
                translationX: 0,
                translationY: 0,
                velocityX: 0,
                velocityY: 0,
            });
            gesture.__handlers.onUpdate?.({
                absoluteX: 180,
                absoluteY: 240,
                translationX: 60,
                translationY: 40,
                velocityX: 700,
                velocityY: 200,
            });
            gesture.__handlers.onEnd?.({
                absoluteX: 180,
                absoluteY: 240,
                translationX: 60,
                translationY: 40,
                velocityX: 700,
                velocityY: 200,
            }, true);
        });

        expect(onPositionChange).not.toHaveBeenCalled();
    });

    it('clamps movement, derives running direction, persists normalized position, and emits release velocity', async () => {
        const onPositionChange = vi.fn();
        const onDragRelease = vi.fn();
        const onDragStateChange = vi.fn();
        const hook = await renderHook(() => usePetNativePanGesture({
            bounds,
            initialPoint: { x: 120, y: 200 },
            noDragRegions: [],
            onDragStateChange,
            onPositionChange,
            onDragRelease,
        }));
        const gesture = hook.getCurrent().gesture as unknown as TestGesture;

        await act(async () => {
            gesture.__handlers.onBegin?.({
                absoluteX: 120,
                absoluteY: 200,
                translationX: 0,
                translationY: 0,
                velocityX: 0,
                velocityY: 0,
            });
            gesture.__handlers.onUpdate?.({
                absoluteX: 420,
                absoluteY: 10,
                translationX: 300,
                translationY: -300,
                velocityX: 1_900,
                velocityY: -200,
            });
            gesture.__handlers.onEnd?.({
                absoluteX: 420,
                absoluteY: 10,
                translationX: 300,
                translationY: -300,
                velocityX: 1_900,
                velocityY: -200,
            }, true);
        });

        expect(hook.getCurrent().point).toEqual({ x: 282, y: 71 });
        expect(onDragStateChange).toHaveBeenCalledWith('running-right');
        expect(onPositionChange).toHaveBeenCalledWith({
            point: { x: 282, y: 71 },
            normalized: { normalizedX: 1, normalizedY: 0 },
        });
        expect(onDragRelease).toHaveBeenCalledWith({
            velocityX: 1_900,
            velocityY: -200,
        });
    });
});
