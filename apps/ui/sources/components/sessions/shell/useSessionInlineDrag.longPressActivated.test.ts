import { describe, expect, it, vi } from 'vitest';

import { renderHook } from '@/dev/testkit';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

vi.mock('react-native-worklets', () => ({
    scheduleOnRN: (fn: (...args: any[]) => void, ...args: any[]) => fn(...args),
}));

vi.mock('react-native-reanimated', () => ({
    useSharedValue: (initial: any) => ({ value: initial }),
    useAnimatedStyle: (fn: any) => fn(),
    withSpring: (value: any) => value,
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
    chain('onStart', (handler: any) => {
        gesture.handlers.onStart = handler;
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
    it('fires onLongPressActivated from a LongPress gesture (not Pan onStart)', async () => {
        const { useSessionInlineDrag } = await import('./useSessionInlineDrag');

        const onLongPressActivated = vi.fn();

        const hook = await renderHook(() => useSessionInlineDrag({
            sessionKey: 's1',
            groupKey: 'g1',
            rowHeight: 80,
            dataIndex: 1,
            totalItemCount: 10,
            dropIndicatorIdx: { value: -1 } as any,
            dropIndicatorEdge: { value: 0 } as any,
            onDragStart: () => {},
            onDragEnd: () => {},
            activateAfterLongPressMs: 350,
            onLongPressActivated,
        }));

        const gesture = hook.getCurrent().gesture as unknown as MockGesture;
        expect(gesture.kind).toBe('simultaneous');
        expect(Array.isArray(gesture.gestures)).toBe(true);
        const longPress = gesture.gestures?.[0];
        const pan = gesture.gestures?.[1];
        expect(longPress?.kind).toBe('longPress');
        expect(pan?.kind).toBe('pan');

        // Long press should trigger the callback (via scheduleOnRN).
        longPress?.handlers?.onStart?.();
        expect(onLongPressActivated).toHaveBeenCalledWith('s1');

        onLongPressActivated.mockClear();
        // Pan start should not trigger the long-press callback.
        pan?.handlers?.onStart?.();
        expect(onLongPressActivated).not.toHaveBeenCalled();

        await hook.unmount();
    });

    it('returns no drag gesture when disabled', async () => {
        const { useSessionInlineDrag } = await import('./useSessionInlineDrag');

        const hook = await renderHook(() => useSessionInlineDrag({
            enabled: false,
            sessionKey: 's1',
            groupKey: 'g1',
            rowHeight: 80,
            dataIndex: 1,
            totalItemCount: 10,
            dropIndicatorIdx: { value: -1 } as any,
            dropIndicatorEdge: { value: 0 } as any,
            onDragStart: () => {},
            onDragEnd: () => {},
            activateAfterLongPressMs: 350,
            onLongPressActivated: vi.fn(),
        }));

        expect(hook.getCurrent().gesture).toBeUndefined();
        await hook.unmount();
    });
});
