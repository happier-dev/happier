import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';

import { CommandPaletteInput } from './CommandPaletteInput';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});
vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});
vi.mock('@/components/ui/text/Text', async () => {
    const { createUiTextModuleMock } = await import('@/dev/testkit/mocks/uiText');
    return createUiTextModuleMock();
});
vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock();
});

describe('CommandPaletteInput', () => {
    afterEach(() => {
        standardCleanup();
    });

    it('does not consume Enter while text composition is active', async () => {
        const onKeyPress = vi.fn();
        const preventDefault = vi.fn();
        const stopPropagation = vi.fn();
        const screen = await renderScreen(
            <CommandPaletteInput
                value=""
                onChangeText={() => {}}
                onKeyPress={onKeyPress}
            />,
        );

        const input = screen.findByType('TextInput');
        input.props.onKeyPress({
            nativeEvent: {
                key: 'Enter',
                code: 'Enter',
                isComposing: true,
            },
            preventDefault,
            stopPropagation,
        });

        expect(onKeyPress).not.toHaveBeenCalled();
        expect(preventDefault).not.toHaveBeenCalled();
        expect(stopPropagation).not.toHaveBeenCalled();
    });

    it('consumes normalized navigation keys after composition ends', async () => {
        const onKeyPress = vi.fn();
        const preventDefault = vi.fn();
        const stopPropagation = vi.fn();
        const screen = await renderScreen(
            <CommandPaletteInput
                value=""
                onChangeText={() => {}}
                onKeyPress={onKeyPress}
            />,
        );

        const input = screen.findByType('TextInput');
        input.props.onKeyPress({
            nativeEvent: {
                key: 'Down',
                code: 'ArrowDown',
                isComposing: false,
            },
            preventDefault,
            stopPropagation,
        });

        expect(onKeyPress).toHaveBeenCalledWith('ArrowDown');
        expect(preventDefault).toHaveBeenCalledTimes(1);
        expect(stopPropagation).toHaveBeenCalledTimes(1);
    });
});
