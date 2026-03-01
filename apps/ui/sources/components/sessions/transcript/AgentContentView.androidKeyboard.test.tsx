import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', async () => {
    const rn = await import('@/dev/reactNativeStub');
    return {
        ...rn,
        Platform: { ...rn.Platform, OS: 'android', select: (v: any) => v.android ?? v.native ?? v.default },
        View: (props: any) => React.createElement('View', props, props.children),
    };
});

vi.mock('@/utils/platform/responsive', () => ({
    useHeaderHeight: () => 0,
}));

vi.mock('react-native-safe-area-context', () => ({
    useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

vi.mock('react-native-keyboard-controller', () => ({
    useKeyboardHandler: () => undefined,
    useReanimatedKeyboardAnimation: () => ({
        height: { value: 0 },
        progress: { value: 0 },
    }),
}));

vi.mock('react-native-reanimated', async () => {
    const React = await import('react');
    return {
        __esModule: true,
        default: {
            View: (props: any) => React.createElement('AnimatedView', props, props.children),
            ScrollView: (props: any) => React.createElement('AnimatedScrollView', props, props.children),
        },
        useAnimatedStyle: (fn: any) => fn(),
        useSharedValue: (initial: any) => ({ value: initial }),
    };
});

describe('AgentContentView (android keyboard)', () => {
    it('uses the keyboard-controller animated implementation on Android', async () => {
        const { AgentContentView } = await import('./AgentContentView.native');

        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(
                <AgentContentView
                    content={<React.Fragment>content</React.Fragment>}
                    input={<React.Fragment>input</React.Fragment>}
                    placeholder={<React.Fragment>placeholder</React.Fragment>}
                />,
            );
        });

        expect(tree!.root.findAllByType('AnimatedView' as any).length).toBeGreaterThan(0);
        expect(tree!.root.findAllByType('AnimatedScrollView' as any).length).toBe(1);
    });
});
