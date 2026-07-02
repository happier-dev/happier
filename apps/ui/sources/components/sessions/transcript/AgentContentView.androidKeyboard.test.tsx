import React from 'react';
import renderer from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { invokeTestInstanceHandler, renderScreen } from '@/dev/testkit';
import { installTranscriptCommonModuleMocks } from './transcriptTestHelpers';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
const keyboardDismissMock = vi.fn();

function flattenStyle(style: unknown): Record<string, unknown> {
    if (!style) return {};
    if (Array.isArray(style)) {
        return Object.assign({}, ...style.map((entry) => flattenStyle(entry)));
    }
    if (typeof style === 'object') return style as Record<string, unknown>;
    return {};
}

function findRenderedByTestId(tree: renderer.ReactTestRenderer, testID: string) {
    const rendered = tree.root.findAllByProps({ testID }).find((node) => typeof node.type === 'string');
    if (!rendered) {
        throw new Error(`Expected rendered node with testID ${testID}`);
    }
    return rendered;
}

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
            ScrollView: (props: any) => React.createElement('ScrollView', props, props.children),
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
    KeyboardAvoidingView: (props: any) => React.createElement('KeyboardAvoidingView', props, props.children),
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
    it('keeps transcript content in normal flex layout while only the composer is lifted on Android', async () => {
        const { AgentContentView } = await import('./AgentContentView.native');

        let tree: renderer.ReactTestRenderer | null = null;
        tree = (await renderScreen(<AgentContentView
                    content={<React.Fragment>content</React.Fragment>}
                    input={<React.Fragment>input</React.Fragment>}
                    placeholder={<React.Fragment>placeholder</React.Fragment>}
                />)).tree;

        const keyboardHost = findRenderedByTestId(tree!, 'agent-content-keyboard-host');
        expect(flattenStyle(keyboardHost.props.style)).toMatchObject({
            flex: 1,
            minHeight: 0,
        });
        expect(flattenStyle(keyboardHost.props.style).backgroundColor).toBeTruthy();

        const contentRegion = findRenderedByTestId(tree!, 'agent-content-scroll-region');
        expect(flattenStyle(contentRegion.props.style)).toMatchObject({
            flex: 1,
            minHeight: 0,
            minWidth: 0,
        });
        expect(flattenStyle(contentRegion.props.style).position).not.toBe('absolute');

        const contentLayer = findRenderedByTestId(tree!, 'agent-content-layer');
        expect(flattenStyle(contentLayer.props.style)).toMatchObject({
            bottom: 0,
            left: 0,
            minWidth: 0,
            overflow: 'hidden',
            position: 'absolute',
            right: 0,
            top: 0,
        });

        const placeholderLayer = findRenderedByTestId(tree!, 'agent-content-placeholder-layer');
        expect(flattenStyle(placeholderLayer.props.style)).toMatchObject({
            bottom: 0,
            left: 0,
            minWidth: 0,
            position: 'absolute',
            right: 0,
            top: 0,
        });

        const inputFooter = findRenderedByTestId(tree!, 'agent-content-input-footer');
        expect(flattenStyle(inputFooter.props.style).backgroundColor).toBeTruthy();
        expect(flattenStyle(inputFooter.props.style)).toMatchObject({
            bottom: 0,
            left: 0,
            position: 'absolute',
            right: 0,
        });

        expect(tree!.findAllByType('KeyboardAvoidingView' as any)).toHaveLength(0);
        expect(tree!.findAllByType('AnimatedView' as any)).toHaveLength(1);
        expect(tree!.findAllByType('AnimatedScrollView' as any)).toHaveLength(0);
    });

    it('dismisses the keyboard when transcript content is tapped outside the composer', async () => {
        const { AgentContentView } = await import('./AgentContentView.native');

        let tree: renderer.ReactTestRenderer | null = null;
        tree = (await renderScreen(<AgentContentView
                    content={<React.Fragment>content</React.Fragment>}
                    input={<React.Fragment>input</React.Fragment>}
                    placeholder={<React.Fragment>placeholder</React.Fragment>}
                />)).tree;

        const contentContainer = tree!.root.findByProps({ testID: 'agent-content-scroll-region' });
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

        const contentContainer = tree!.root.findByProps({ testID: 'agent-content-scroll-region' });
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
