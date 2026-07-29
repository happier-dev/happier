import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

vi.mock('react-native-safe-area-context', () => ({
    useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
}));

vi.mock('expo-router', () => ({
    Stack: {
        Screen: () => null,
    },
}));

vi.mock('react-native-keyboard-controller', () => ({
    useKeyboardHandler: () => undefined,
    useReanimatedKeyboardAnimation: () => ({ height: 0 }),
}));

vi.mock('react-native-reanimated', () => ({
    default: {
        View: (props: React.PropsWithChildren<Record<string, unknown>>) =>
            React.createElement('AnimatedView', props, props.children),
    },
    runOnJS: (callback: (...args: unknown[]) => unknown) => callback,
    useSharedValue: (value: unknown) => ({ value }),
}));

vi.mock('@legendapp/list/react-native', () => ({
    LegendList: (props: React.PropsWithChildren<Record<string, unknown>>) =>
        React.createElement('LegendList', props, props.children),
}));

describe('InvertedListTest', () => {
    it('compares only the supported canonical Legend and Flat backends', async () => {
        const { default: InvertedListTest } = await import('@/app/(app)/dev/inverted-list');
        const screen = await renderScreen(React.createElement(InvertedListTest));

        expect(screen.getTextContent()).toContain(
            'List Implementation: FlatList LegendList Padding Method:',
        );
    });
});
