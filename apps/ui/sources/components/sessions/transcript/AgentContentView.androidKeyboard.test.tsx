import React from 'react';
import renderer from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import { installTranscriptCommonModuleMocks } from './transcriptTestHelpers';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

installTranscriptCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            Platform: {
                OS: 'android',
                select: (v: any) => v.android ?? v.native ?? v.default,
            },
            View: (props: any) => React.createElement('View', props, props.children),
        });
    },
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
        tree = (await renderScreen(<AgentContentView
                    content={<React.Fragment>content</React.Fragment>}
                    input={<React.Fragment>input</React.Fragment>}
                    placeholder={<React.Fragment>placeholder</React.Fragment>}
                />)).tree;

        const animatedViews = tree!.findAllByType('AnimatedView' as any);
        expect(animatedViews.length).toBeGreaterThan(0);
        expect(animatedViews[0]?.props.pointerEvents).toBe('box-none');
        expect(tree!.findAllByType('AnimatedScrollView' as any).length).toBe(1);
    });
});
