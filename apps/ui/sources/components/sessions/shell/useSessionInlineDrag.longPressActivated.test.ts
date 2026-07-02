import { describe, expect, it, vi } from 'vitest';

import { renderHook } from '@/dev/testkit';
import {
    TREE_DROP_OVERLAY_KIND_LINE,
    TREE_DROP_OVERLAY_KIND_NONE,
    type TreeDropOverlaySharedValues,
    type TreeDropResult,
    type TreeDropVisualGeometry,
} from '@/components/ui/treeDragDrop';
import type {
    UseSessionInlineDragParams,
    UseSessionInlineDragResolvedDrop,
} from './useSessionInlineDrag';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

vi.mock('react-native-worklets', () => ({
    scheduleOnRN: (fn: (...args: any[]) => void, ...args: any[]) => fn(...args),
}));

vi.mock('react-native-reanimated', () => ({
    Easing: {
        bezier: () => () => 0,
        linear: () => 0,
    },
    useSharedValue: (initial: any) => ({ value: initial }),
    useAnimatedStyle: (fn: any) => fn(),
    withSpring: (value: any) => value,
    withTiming: (value: any) => value,
}));

type MockGesture = Readonly<{
    kind: 'pan' | 'longPress' | 'simultaneous';
    config: Record<string, any>;
    handlers: Record<string, any>;
    gestures?: MockGesture[];
}>;

function createMockGesture(kind: MockGesture['kind']): any {
    const gesture: any = {
        kind,
        config: {},
        handlers: {},
    };

    const chain = (method: string, fn: (...args: any[]) => void) => {
        gesture[method] = fn;
    };

    chain('minDistance', (value: number) => {
        gesture.config.minDistance = value;
        return gesture;
    });
    chain('activateAfterLongPress', (value: number) => {
        gesture.config.activateAfterLongPress = value;
        return gesture;
    });
    chain('minDuration', (value: number) => {
        gesture.config.minDuration = value;
        return gesture;
    });
    chain('maxDistance', (value: number) => {
        gesture.config.maxDistance = value;
        return gesture;
    });
    chain('shouldCancelWhenOutside', (value: boolean) => {
        gesture.config.shouldCancelWhenOutside = value;
        return gesture;
    });
    chain('cancelsTouchesInView', (value: boolean) => {
        gesture.config.cancelsTouchesInView = value;
        return gesture;
    });
    chain('onStart', (handler: any) => {
        gesture.handlers.onStart = handler;
        return gesture;
    });
    chain('onBegin', (handler: any) => {
        gesture.handlers.onBegin = handler;
        return gesture;
    });
    chain('onUpdate', (handler: any) => {
        gesture.handlers.onUpdate = handler;
        return gesture;
    });
    chain('onEnd', (handler: any) => {
        gesture.handlers.onEnd = handler;
        return gesture;
    });
    chain('onFinalize', (handler: any) => {
        gesture.handlers.onFinalize = handler;
        return gesture;
    });
    chain('onTouchesDown', (handler: any) => {
        gesture.handlers.onTouchesDown = handler;
        return gesture;
    });
    chain('onTouchesMove', (handler: any) => {
        gesture.handlers.onTouchesMove = handler;
        return gesture;
    });
    chain('onTouchesUp', (handler: any) => {
        gesture.handlers.onTouchesUp = handler;
        return gesture;
    });
    chain('onTouchesCancelled', (handler: any) => {
        gesture.handlers.onTouchesCancelled = handler;
        return gesture;
    });

    return gesture;
}

vi.mock('react-native-gesture-handler', () => ({
    Gesture: {
        Pan: () => createMockGesture('pan'),
        LongPress: () => createMockGesture('longPress'),
        Simultaneous: (...gestures: MockGesture[]) => ({
            kind: 'simultaneous',
            config: {},
            handlers: {},
            gestures,
        }),
    },
}));

describe('useSessionInlineDrag (onLongPressActivated)', () => {
    function sharedOverlayValues(): TreeDropOverlaySharedValues {
        return {
            overlayVisible: { value: 0 },
            overlayKind: { value: TREE_DROP_OVERLAY_KIND_NONE },
            overlayTop: { value: 0 },
            overlayHeight: { value: 0 },
            overlayLeft: { value: 0 },
            overlayRight: { value: 0 },
            overlayDepth: { value: 0 },
        };
    }

    const idleResult: TreeDropResult = {
        instruction: { kind: 'idle' },
        visual: { kind: 'none' },
    };

    function lineResult(targetId: string, depth: number): TreeDropResult {
        return {
            instruction: {
                kind: 'reorder-before',
                targetId,
                containerId: 'workspace-root:one',
                parentId: null,
                depth,
            },
            visual: {
                kind: 'line',
                targetId,
                edge: 'top',
                depth,
            },
        };
    }

    function outlineResult(targetId: string): TreeDropResult {
        return {
            instruction: {
                kind: 'nest-into',
                targetId,
                containerId: targetId,
                parentId: targetId,
                depth: 1,
            },
            visual: {
                kind: 'outline',
                targetId,
            },
        };
    }

    function lineGeometry(targetId: string, depth: number): TreeDropVisualGeometry {
        return {
            kind: 'line',
            targetId,
            edge: 'top',
            depth,
            geometry: {
                top: 12,
                left: 24,
                width: 180,
                height: 2,
            },
        };
    }

    function outlineGeometry(targetId: string): TreeDropVisualGeometry {
        return {
            kind: 'outline',
            targetId,
            geometry: {
                top: 40,
                left: 16,
                width: 220,
                height: 36,
            },
        };
    }

    function resolvedDrop(result: TreeDropResult, geometry: TreeDropVisualGeometry): UseSessionInlineDragResolvedDrop {
        return { result, geometry };
    }

    function dragParams(overrides: Partial<UseSessionInlineDragParams> = {}): UseSessionInlineDragParams {
        const base: UseSessionInlineDragParams = {
            sessionKey: 's1',
            groupKey: 'g1',
            dataIndex: 1,
            overlayShared: sharedOverlayValues(),
            onDragStart: () => {},
            resolveDropResult: () => resolvedDrop(idleResult, { kind: 'none' }),
            onDropResult: () => {},
        };
        return { ...base, ...overrides };
    }

    function touchEvent(x: number, y: number) {
        return {
            changedTouches: [{ absoluteX: x, absoluteY: y }],
            allTouches: [{ absoluteX: x, absoluteY: y }],
        };
    }

    it('resolves one canonical drop result on update and writes numeric overlay geometry', async () => {
        const { useSessionInlineDrag } = await import('./useSessionInlineDrag');

        const overlayShared = sharedOverlayValues();
        const onDragUpdate = vi.fn();
        const resolveDropResult = vi.fn(() => resolvedDrop(
            lineResult('session:server:target', 2),
            lineGeometry('session:server:target', 2),
        ));

        const hook = await renderHook(() => useSessionInlineDrag(dragParams({
            overlayShared,
            onDragUpdate,
            resolveDropResult,
        })));

        const gesture = hook.getCurrent().gesture as unknown as MockGesture;
        gesture.handlers.onStart?.();
        gesture.handlers.onUpdate?.({
            translationY: 240,
            absoluteX: 18,
            absoluteY: 64,
        });

        expect(resolveDropResult).toHaveBeenCalledWith({
            sessionKey: 's1',
            groupKey: 'g1',
            dataIndex: 1,
            pointer: { x: 18, y: 64 },
        });
        expect(onDragUpdate).toHaveBeenCalledWith({
            sessionKey: 's1',
            groupKey: 'g1',
            dataIndex: 1,
            result: lineResult('session:server:target', 2),
        });
        expect(overlayShared.overlayVisible.value).toBe(1);
        expect(overlayShared.overlayKind.value).toBe(TREE_DROP_OVERLAY_KIND_LINE);
        expect(overlayShared.overlayTop.value).toBe(12);
        expect(overlayShared.overlayHeight.value).toBe(2);
        expect(overlayShared.overlayLeft.value).toBe(24);
        expect(overlayShared.overlayRight.value).toBe(204);
        expect(overlayShared.overlayDepth.value).toBe(2);

        await hook.unmount();
    });

    it('re-resolves the final pointer before completing the drag', async () => {
        const { useSessionInlineDrag } = await import('./useSessionInlineDrag');

        const overlayShared = sharedOverlayValues();
        const onDropResult = vi.fn();
        const resolveDropResult = vi.fn((event: { pointer: { x: number; y: number } | null }) => {
            if (event.pointer?.y === 300) {
                return resolvedDrop(outlineResult('folder:final'), outlineGeometry('folder:final'));
            }
            return resolvedDrop(lineResult('session:server:hover', 1), lineGeometry('session:server:hover', 1));
        });

        const hook = await renderHook(() => useSessionInlineDrag(dragParams({
            overlayShared,
            resolveDropResult,
            onDropResult,
        })));

        const gesture = hook.getCurrent().gesture as unknown as MockGesture;
        gesture.handlers.onStart?.();
        gesture.handlers.onUpdate?.({
            translationY: 80,
            absoluteX: 24,
            absoluteY: 120,
        });
        gesture.handlers.onEnd?.({
            translationY: 90,
            absoluteX: 24,
            absoluteY: 300,
        });

        expect(resolveDropResult).toHaveBeenLastCalledWith({
            sessionKey: 's1',
            groupKey: 'g1',
            dataIndex: 1,
            pointer: { x: 24, y: 300 },
        });
        expect(onDropResult).toHaveBeenCalledWith({
            sessionKey: 's1',
            groupKey: 'g1',
            dataIndex: 1,
            result: outlineResult('folder:final'),
        });
        expect(overlayShared.overlayVisible.value).toBe(0);
        expect(overlayShared.overlayKind.value).toBe(TREE_DROP_OVERLAY_KIND_NONE);

        await hook.unmount();
    });

    it('clears overlay state and notifies the owner when an active drag is cancelled by the touch system', async () => {
        const { useSessionInlineDrag } = await import('./useSessionInlineDrag');

        const overlayShared = sharedOverlayValues();
        const onDragCancel = vi.fn();
        const params = {
            ...dragParams({
                overlayShared,
                resolveDropResult: () => resolvedDrop(
                    lineResult('session:server:target', 2),
                    lineGeometry('session:server:target', 2),
                ),
            }),
            onDragCancel,
        } satisfies UseSessionInlineDragParams & {
            onDragCancel: (event: { sessionKey: string; groupKey: string; dataIndex: number }) => void;
        };
        const hook = await renderHook(() => useSessionInlineDrag(params));

        const gesture = hook.getCurrent().gesture as unknown as MockGesture;
        gesture.handlers.onStart?.();
        gesture.handlers.onUpdate?.({
            translationY: 240,
            absoluteX: 18,
            absoluteY: 64,
        });

        expect(overlayShared.overlayKind.value).toBe(TREE_DROP_OVERLAY_KIND_LINE);

        gesture.handlers.onTouchesCancelled?.();
        gesture.handlers.onFinalize?.({
            translationY: 240,
            absoluteX: 18,
            absoluteY: 64,
        });

        expect(overlayShared.overlayVisible.value).toBe(0);
        expect(overlayShared.overlayKind.value).toBe(TREE_DROP_OVERLAY_KIND_NONE);
        expect(onDragCancel).toHaveBeenCalledWith({
            sessionKey: 's1',
            groupKey: 'g1',
            dataIndex: 1,
        });

        await hook.unmount();
    });

    it('fires onLongPressActivated from a LongPress gesture (not Pan onStart)', async () => {
        const { useSessionInlineDrag } = await import('./useSessionInlineDrag');

        const onLongPressActivated = vi.fn();

        const hook = await renderHook(() => useSessionInlineDrag({
            ...dragParams(),
            activateAfterLongPressMs: 350,
            onLongPressActivated,
        }));

        const gesture = hook.getCurrent().gesture as unknown as MockGesture;
        expect(gesture.kind).toBe('simultaneous');
        expect(Array.isArray(gesture.gestures)).toBe(true);
        const longPress = gesture.gestures?.[0];
        const pan = gesture.gestures?.[1];
        expect(longPress?.kind).toBe('longPress');
        expect(longPress?.config.maxDistance).toBeGreaterThanOrEqual(8);
        expect(longPress?.config.maxDistance).toBeLessThanOrEqual(12);
        expect(longPress?.config.shouldCancelWhenOutside).toBe(false);
        expect(longPress?.config.cancelsTouchesInView).toBe(false);
        expect(pan?.kind).toBe('pan');
        expect(pan?.config.cancelsTouchesInView).toBe(false);

        // Long press should trigger the callback (via scheduleOnRN).
        longPress?.handlers?.onStart?.();
        expect(onLongPressActivated).toHaveBeenCalledWith('s1');

        onLongPressActivated.mockClear();
        longPress?.handlers?.onBegin?.();
        longPress?.handlers?.onEnd?.({}, true);
        expect(onLongPressActivated).toHaveBeenCalledWith('s1');

        onLongPressActivated.mockClear();
        longPress?.handlers?.onBegin?.();
        longPress?.handlers?.onEnd?.({}, false);
        expect(onLongPressActivated).not.toHaveBeenCalled();

        onLongPressActivated.mockClear();
        longPress?.handlers?.onBegin?.();
        longPress?.handlers?.onStart?.();
        longPress?.handlers?.onEnd?.({}, true);
        expect(onLongPressActivated).toHaveBeenCalledTimes(1);

        onLongPressActivated.mockClear();
        // Pan start should not trigger the long-press callback.
        pan?.handlers?.onStart?.();
        expect(onLongPressActivated).not.toHaveBeenCalled();

        await hook.unmount();
    });

    it('still fires onLongPressActivated when Pan starts before the LongPress callback reports activation', async () => {
        const { useSessionInlineDrag } = await import('./useSessionInlineDrag');

        const onLongPressActivated = vi.fn();

        const hook = await renderHook(() => useSessionInlineDrag({
            ...dragParams(),
            activateAfterLongPressMs: 350,
            onLongPressActivated,
        }));

        const gesture = hook.getCurrent().gesture as unknown as MockGesture;
        const longPress = gesture.gestures?.[0];
        const pan = gesture.gestures?.[1];

        expect(longPress?.kind).toBe('longPress');
        expect(pan?.kind).toBe('pan');

        pan?.handlers?.onStart?.();
        expect(onLongPressActivated).not.toHaveBeenCalled();

        longPress?.handlers?.onStart?.();
        expect(onLongPressActivated).toHaveBeenCalledWith('s1');

        await hook.unmount();
    });

    it('does not synthesize a context-menu long press from Pan touch-down events', async () => {
        vi.useFakeTimers();
        try {
            const { useSessionInlineDrag } = await import('./useSessionInlineDrag');

            const onLongPressActivated = vi.fn();

            const hook = await renderHook(() => useSessionInlineDrag({
                ...dragParams(),
                activateAfterLongPressMs: 350,
                onLongPressActivated,
            }));

            const gesture = hook.getCurrent().gesture as unknown as MockGesture;
            const pan = gesture.gestures?.[1];

            pan?.handlers?.onTouchesDown?.(touchEvent(100, 200));
            vi.advanceTimersByTime(1000);
            expect(onLongPressActivated).not.toHaveBeenCalled();

            await hook.unmount();
        } finally {
            vi.useRealTimers();
        }
    });

    it('does not fire onLongPressActivated when native LongPress ends after a completed drag', async () => {
        const { useSessionInlineDrag } = await import('./useSessionInlineDrag');

        const onLongPressActivated = vi.fn();

        const hook = await renderHook(() => useSessionInlineDrag({
            ...dragParams(),
            activateAfterLongPressMs: 350,
            onLongPressActivated,
        }));

        const gesture = hook.getCurrent().gesture as unknown as MockGesture;
        const longPress = gesture.gestures?.[0];
        const pan = gesture.gestures?.[1];

        longPress?.handlers?.onBegin?.();
        pan?.handlers?.onStart?.();
        pan?.handlers?.onUpdate?.({
            translationY: 80,
            absoluteX: 100,
            absoluteY: 280,
        });
        pan?.handlers?.onEnd?.({
            absoluteX: 100,
            absoluteY: 280,
        });

        // Some native event orderings can report the LongPress lifecycle after
        // Pan has already cleaned up. That must still be treated as the same
        // drag touch, not as a fresh stationary long press.
        longPress?.handlers?.onBegin?.();
        longPress?.handlers?.onEnd?.({}, true);

        expect(onLongPressActivated).not.toHaveBeenCalled();

        await hook.unmount();
    });

    it('does not fire onLongPressActivated after release without native LongPress activation', async () => {
        vi.useFakeTimers();
        try {
            const { useSessionInlineDrag } = await import('./useSessionInlineDrag');

            const onLongPressActivated = vi.fn();

            const hook = await renderHook(() => useSessionInlineDrag({
                ...dragParams(),
                activateAfterLongPressMs: 350,
                onLongPressActivated,
            }));

            const gesture = hook.getCurrent().gesture as unknown as MockGesture;
            const pan = gesture.gestures?.[1];

            pan?.handlers?.onTouchesDown?.(touchEvent(100, 200));
            pan?.handlers?.onTouchesUp?.(touchEvent(100, 200));
            vi.advanceTimersByTime(350);
            expect(onLongPressActivated).not.toHaveBeenCalled();

            await hook.unmount();
        } finally {
            vi.useRealTimers();
        }
    });

    it('does not fire onLongPressActivated after scroll movement without native LongPress activation', async () => {
        vi.useFakeTimers();
        try {
            const { useSessionInlineDrag } = await import('./useSessionInlineDrag');

            const onLongPressActivated = vi.fn();

            const hook = await renderHook(() => useSessionInlineDrag({
                ...dragParams(),
                activateAfterLongPressMs: 350,
                onLongPressActivated,
            }));

            const gesture = hook.getCurrent().gesture as unknown as MockGesture;
            const pan = gesture.gestures?.[1];

            pan?.handlers?.onTouchesDown?.(touchEvent(100, 200));
            pan?.handlers?.onTouchesMove?.(touchEvent(100, 212));
            vi.advanceTimersByTime(350);
            expect(onLongPressActivated).not.toHaveBeenCalled();

            await hook.unmount();
        } finally {
            vi.useRealTimers();
        }
    });

    it('returns no drag gesture when disabled', async () => {
        const { useSessionInlineDrag } = await import('./useSessionInlineDrag');

        const hook = await renderHook(() => useSessionInlineDrag({
            ...dragParams(),
            enabled: false,
            activateAfterLongPressMs: 350,
            onLongPressActivated: vi.fn(),
        }));

        expect(hook.getCurrent().gesture).toBeUndefined();
        await hook.unmount();
    });
});
