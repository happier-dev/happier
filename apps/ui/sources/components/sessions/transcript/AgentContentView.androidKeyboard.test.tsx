import React from 'react';
import renderer from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { invokeTestInstanceHandler, renderScreen } from '@/dev/testkit';
import { installTranscriptCommonModuleMocks } from './transcriptTestHelpers';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
const keyboardDismissMock = vi.fn();

installTranscriptCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            Keyboard: {
                addListener: () => ({ remove: () => {} }),
                dismiss: keyboardDismissMock,
            },
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
    initialWindowMetrics: { insets: { top: 0, bottom: 0, left: 0, right: 0 } },
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

afterEach(() => {
    keyboardDismissMock.mockReset();
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

    it('dismisses the keyboard when transcript content is tapped outside the composer', async () => {
        const { AgentContentView } = await import('./AgentContentView.native');

        let tree: renderer.ReactTestRenderer | null = null;
        tree = (await renderScreen(<AgentContentView
                    content={<React.Fragment>content</React.Fragment>}
                    input={<React.Fragment>input</React.Fragment>}
                    placeholder={<React.Fragment>placeholder</React.Fragment>}
                />)).tree;

        const contentContainer = tree!.root.findAllByType('View').find((node) => typeof node.props.onTouchStart === 'function');
        expect(contentContainer).toBeTruthy();

        invokeTestInstanceHandler(
            contentContainer!,
            'onTouchStart',
            { nativeEvent: { pageX: 16, pageY: 24 } },
            'agent-content-tap-start',
        );
        invokeTestInstanceHandler(
            contentContainer!,
            'onTouchEnd',
            { nativeEvent: { pageX: 16, pageY: 24 } },
            'agent-content-tap-end',
        );

        expect(keyboardDismissMock).toHaveBeenCalledTimes(1);
    });

    it('does not dismiss the keyboard when transcript content is scrolled', async () => {
        const { AgentContentView } = await import('./AgentContentView.native');

        let tree: renderer.ReactTestRenderer | null = null;
        tree = (await renderScreen(<AgentContentView
                    content={<React.Fragment>content</React.Fragment>}
                    input={<React.Fragment>input</React.Fragment>}
                    placeholder={<React.Fragment>placeholder</React.Fragment>}
                />)).tree;

        const contentContainer = tree!.root.findAllByType('View').find((node) => typeof node.props.onTouchStart === 'function');
        expect(contentContainer).toBeTruthy();

        invokeTestInstanceHandler(
            contentContainer!,
            'onTouchStart',
            { nativeEvent: { pageX: 16, pageY: 24 } },
            'agent-content-scroll-start',
        );
        invokeTestInstanceHandler(
            contentContainer!,
            'onTouchMove',
            { nativeEvent: { pageX: 16, pageY: 48 } },
            'agent-content-scroll-move',
        );
        invokeTestInstanceHandler(
            contentContainer!,
            'onTouchEnd',
            { nativeEvent: { pageX: 16, pageY: 48 } },
            'agent-content-scroll-end',
        );

        expect(keyboardDismissMock).not.toHaveBeenCalled();
    });
});
