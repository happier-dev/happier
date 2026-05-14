import * as React from 'react';
import type renderer from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { installTranscriptCommonModuleMocks } from './transcriptTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

installTranscriptCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            Platform: {
                OS: 'ios',
                select: (v: any) => v.ios ?? v.native ?? v.default,
            },
            View: (props: any) => React.createElement('View', props, props.children),
            ScrollView: (props: any) => React.createElement('ScrollView', props, props.children),
        });
    },
});

vi.mock('@/utils/platform/responsive', () => ({
    useHeaderHeight: () => 40,
}));

vi.mock('react-native-safe-area-context', () => ({
    useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
    initialWindowMetrics: { insets: { top: 22, bottom: 0, left: 0, right: 0 } },
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

describe('AgentContentView safe area', () => {
    it('uses the chrome-safe area fallback (initialWindowMetrics) when positioning placeholder content', async () => {
        const { AgentContentView } = await import('./AgentContentView.native');

        const tree = (await renderScreen(
            <AgentContentView
                content={<React.Fragment>content</React.Fragment>}
                input={<React.Fragment>input</React.Fragment>}
                placeholder={<React.Fragment>placeholder</React.Fragment>}
            />,
        )).tree as renderer.ReactTestRenderer;

        const scroll = tree.findByType('ScrollView' as any);
        expect(scroll.props.contentContainerStyle).toEqual(
            expect.objectContaining({
                paddingTop: 22 + 40,
            }),
        );
    });
});
