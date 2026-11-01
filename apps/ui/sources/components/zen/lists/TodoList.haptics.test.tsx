import * as React from 'react';
import { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderScreen, type TestGestureChain } from '@/dev/testkit';
import { TodoList, type TodoListProps } from './TodoList';

const events = vi.hoisted(() => [] as string[]);
vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({ Platform: { OS: 'ios' } });
});
vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});
vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock().module;
});
vi.mock('react-native-worklets', () => ({
    scheduleOnRN: (fn: (...args: unknown[]) => unknown, ...args: unknown[]) => fn(...args),
}));
vi.mock('expo-haptics', () => ({
    ImpactFeedbackStyle: { Medium: 'medium', Light: 'light' },
    NotificationFeedbackType: { Error: 'error' },
    AndroidHaptics: { Reject: 'reject', Context_Click: 'context', Segment_Tick: 'tick', Drag_Start: 'start' },
    impactAsync: async (style: string) => { events.push(style); },
    selectionAsync: async () => { events.push('selection'); },
    notificationAsync: async (kind: string) => { events.push(kind); },
}));

const todos = ['a', 'b', 'c'].map((id) => ({ id, title: id, done: false }));
async function mountList(onReorderTodo: TodoListProps['onReorderTodo']) {
    const screen = await renderScreen(<TodoList todos={todos} onReorderTodo={onReorderTodo} />);
    return screen.findAllByType('GestureDetector')[0]!.props.gesture as TestGestureChain;
}

describe('TodoList drag feedback', () => {
    beforeEach(() => { events.length = 0; });

    it('ticks each slot once and waits for the applied result before settling', async () => {
        let resolveReorder!: (result: 'applied') => void;
        const gesture = await mountList(() => new Promise<'applied'>((resolve) => { resolveReorder = resolve; }));
        await act(async () => {
            gesture.__handlers.onStart?.();
            gesture.__handlers.onUpdate?.({ translationY: 70 });
            gesture.__handlers.onUpdate?.({ translationY: 71 });
            gesture.__handlers.onUpdate?.({ translationY: 138 });
            gesture.__handlers.onEnd?.();
            gesture.__handlers.onFinalize?.({}, true);
        });
        expect(events).toEqual(['light', 'selection', 'selection']);
        await act(async () => { resolveReorder('applied'); });
        expect(events).toEqual(['light', 'selection', 'selection', 'light']);
    });

    it.each(['refused', 'unknown', 'unchanged', undefined] as const)('finishes %s truthfully', async (result) => {
        const gesture = await mountList(async () => result);
        await act(async () => {
            gesture.__handlers.onStart?.();
            gesture.__handlers.onUpdate?.({ translationY: 70 });
            gesture.__handlers.onEnd?.();
            gesture.__handlers.onFinalize?.({}, true);
        });
        expect(events).toEqual(['light', 'selection', ...(result === 'refused' ? ['error'] : [])]);
    });

    it('ticks on reentry to the same slot after leaving the valid range', async () => {
        const gesture = await mountList(() => 'unchanged');
        await act(async () => {
            gesture.__handlers.onStart?.();
            gesture.__handlers.onUpdate?.({ translationY: 70 });
            gesture.__handlers.onUpdate?.({ translationY: 300 });
            gesture.__handlers.onUpdate?.({ translationY: 301 });
        });
        expect(events).toEqual(['light', 'selection']);
        await act(async () => { gesture.__handlers.onUpdate?.({ translationY: 70 }); });
        expect(events).toEqual(['light', 'selection', 'selection']);
    });

    it('does not persist or settle a cancelled drag or unchanged drop', async () => {
        const reorder = vi.fn();
        const gesture = await mountList(reorder);
        await act(async () => {
            gesture.__handlers.onBegin?.();
            gesture.__handlers.onFinalize?.({}, false);
        });
        expect(events).toEqual([]);
        await act(async () => {
            gesture.__handlers.onStart?.();
            gesture.__handlers.onEnd?.();
            gesture.__handlers.onFinalize?.({}, true);
        });
        expect(events).toEqual(['light']);
        expect(reorder).not.toHaveBeenCalled();
    });

    it('restores the initial slots after a moved gesture is cancelled', async () => {
        const reorder = vi.fn();
        const screen = await renderScreen(<TodoList todos={todos} onReorderTodo={reorder} />);
        const gesture = screen.findAllByType('GestureDetector')[0]!.props.gesture as TestGestureChain;
        await act(async () => {
            gesture.__handlers.onStart?.();
            gesture.__handlers.onUpdate?.({ translationY: 138 });
            gesture.__handlers.onEnd?.({}, false);
            gesture.__handlers.onFinalize?.({}, false);
        });
        // A real frame re-evaluates derived values; a changed callback makes the host
        // Reanimated boundary recompute them without replacing the canonical todo order.
        await act(async () => { screen.tree.update(<TodoList todos={todos} onReorderTodo={(...args) => reorder(...args)} />); });
        const nextGesture = screen.findAllByType('GestureDetector')[0]!.props.gesture as TestGestureChain;
        await act(async () => {
            nextGesture.__handlers.onStart?.();
            nextGesture.__handlers.onUpdate?.({ translationY: 70 });
            nextGesture.__handlers.onEnd?.();
            nextGesture.__handlers.onFinalize?.({}, true);
        });
        expect(reorder).toHaveBeenCalledWith('a', 1);
        expect(events).toEqual(['light', 'selection', 'light', 'selection']);
    });
});
