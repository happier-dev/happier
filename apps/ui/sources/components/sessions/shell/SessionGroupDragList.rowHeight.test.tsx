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

vi.mock('./SessionItem', () => ({
    SessionItem: (props: any) => React.createElement('SessionItem', props),
}));

describe('SessionGroupDragList row height', () => {
    it('does not increase the group container height when some rows have tags', async () => {
        const { SessionGroupDragList } = await import('./SessionGroupDragList');

        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(
                <SessionGroupDragList
                    groupKey="g1"
                    compact={false}
                    compactMinimal={false}
                    rows={[
                        { key: 'a', session: {} as any, pinned: false, showServerBadge: false, tagsEnabled: true, tags: ['t1'] },
                        { key: 'b', session: {} as any, pinned: false, showServerBadge: false, tagsEnabled: true, tags: [] },
                        { key: 'c', session: {} as any, pinned: false, showServerBadge: false, tagsEnabled: true, tags: [] },
                    ]}
                />,
            );
        });

        const views = (tree as any).root.findAllByType('View');
        const groupContainer = views.find((node: any) => {
            const style = node.props?.style;
            if (!Array.isArray(style)) return false;
            return style.some((s: any) => typeof s === 'object' && s && typeof s.height === 'number');
        });
        expect(groupContainer).toBeTruthy();

        const styleArray = groupContainer.props.style as any[];
        const heightStyle = styleArray.find((s: any) => typeof s === 'object' && s && typeof s.height === 'number');
        expect(heightStyle.height).toBe(88 * 3);
    });
});

