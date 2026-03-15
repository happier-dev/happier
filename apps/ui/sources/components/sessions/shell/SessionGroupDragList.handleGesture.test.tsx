import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', async () => {
    const stub = await import('@/dev/reactNativeStub');
    return {
        ...stub,
        Platform: { ...stub.Platform, OS: 'web' },
    };
});

vi.mock('react-native-reanimated', () => {
    const React = require('react');
    const AnimatedView = (props: any) => React.createElement('AnimatedView', props, props.children);
    return {
        __esModule: true,
        default: {
            View: AnimatedView,
        },
        useSharedValue: (value: any) => ({ value }),
        useDerivedValue: (fn: any) => ({ value: fn() }),
        withSpring: (value: any) => value,
        useAnimatedStyle: (fn: any) => fn(),
    };
});

vi.mock('react-native-gesture-handler', () => ({
    GestureDetector: (props: any) => React.createElement('GestureDetector', props, props.children),
    Gesture: {
        Pan: () => {
            const chain: any = {};
            chain.activateAfterLongPress = () => chain;
            chain.minDistance = () => chain;
            chain.onStart = () => chain;
            chain.onUpdate = () => chain;
            chain.onEnd = () => chain;
            chain.onFinalize = () => chain;
            return chain;
        },
    },
}));

vi.mock('react-native-worklets', () => ({
    scheduleOnRN: (fn: any, ...args: any[]) => fn(...args),
}));

const capturedSessionItemProps: any[] = [];
vi.mock('./SessionItem', () => ({
    SessionItem: (props: any) => {
        capturedSessionItemProps.push(props);
        return React.createElement('SessionItem', props);
    },
}));

describe('SessionGroupDragList gesture attachment', () => {
    it('attaches drag gesture to the reorder handle (not the whole row)', async () => {
        capturedSessionItemProps.length = 0;
        const { SessionGroupDragList } = await import('./SessionGroupDragList');

        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(
                <SessionGroupDragList
                    groupKey="g1"
                    compact={false}
                    compactMinimal={false}
                    reorderMode={true}
                    rows={[
                        { key: 'a', session: {} as any, pinned: false, showServerBadge: false },
                        { key: 'b', session: {} as any, pinned: false, showServerBadge: false },
                    ]}
                />,
            );
        });

        expect((tree as any).root.findAllByType('GestureDetector')).toHaveLength(0);
        expect(capturedSessionItemProps[0]?.reorderHandleGesture).toBeTruthy();
    });
});
