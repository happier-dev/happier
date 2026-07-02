import * as React from 'react';
import type { ScrollView, ScrollViewProps, View, ViewProps } from 'react-native';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';

const platformState = vi.hoisted(() => ({
    os: 'ios',
}));

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
        Platform: {
            get OS() {
                return platformState.os;
            },
            select: <T,>(options: { ios?: T; default?: T; native?: T; web?: T; android?: T }) =>
                platformState.os === 'ios'
                    ? options.ios ?? options.native ?? options.default ?? options.web ?? options.android
                    : options.web ?? options.default ?? options.native ?? options.ios ?? options.android,
        },
    });
});

vi.mock('react-native-keyboard-controller', () => ({
    KeyboardAvoidingView: React.forwardRef<View, React.PropsWithChildren<ViewProps>>(
        function MockKeyboardAvoidingView(props, _ref) {
            return React.createElement('KeyboardAvoidingView', props, props.children);
        },
    ),
    KeyboardAwareScrollView: React.forwardRef<ScrollView, React.PropsWithChildren<ScrollViewProps>>(
        function MockKeyboardAwareScrollView(props, _ref) {
            return React.createElement('KeyboardAwareScrollView', props, props.children);
        },
    ),
    KeyboardStickyView: React.forwardRef<View, React.PropsWithChildren<ViewProps>>(
        function MockKeyboardStickyView(props, _ref) {
            return React.createElement('KeyboardStickyView', props, props.children);
        },
    ),
}));

describe('KeyboardAwareScreen', () => {
    it('renders form screens through the native keyboard-aware frame', async () => {
        platformState.os = 'ios';
        const { KeyboardAwareScreen } = await import('./KeyboardAwareScreen');

        const screen = await renderScreen(
            <KeyboardAwareScreen mode="form" testID="keyboard-aware-screen" keyboardVerticalOffset={12}>
                <Child />
            </KeyboardAwareScreen>,
        );

        const keyboardFrame = screen.findByType('KeyboardAvoidingView');
        expect(keyboardFrame.props.testID).toBe('keyboard-aware-screen');
        expect(keyboardFrame.props.keyboardVerticalOffset).toBe(12);
    });

    it('keeps custom scroll components on no-op platforms', async () => {
        platformState.os = 'web';
        const { KeyboardAwareScrollView } = await import('./KeyboardAwareScrollView');
        const CustomScrollView: React.ComponentType<ScrollViewProps> = (props) =>
            React.createElement('CustomScrollView', props, props.children);

        const screen = await renderScreen(
            <KeyboardAwareScrollView
                ScrollViewComponent={CustomScrollView}
                keyboardShouldPersistTaps="handled"
                testID="custom-scroll"
            >
                <Child />
            </KeyboardAwareScrollView>,
        );

        const customScroll = screen.findByType('CustomScrollView');
        expect(customScroll.props.testID).toBe('custom-scroll');
        expect(customScroll.props.keyboardShouldPersistTaps).toBe('handled');
    });
});

function Child() {
    return React.createElement('Child');
}
