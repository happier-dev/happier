import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});

vi.mock('reanimated-color-picker', async () => {
    const { createReanimatedColorPickerMock } = await import('@/dev/testkit/mocks/reanimatedColorPicker');
    return createReanimatedColorPickerMock();
});

describe('ThemeColorPicker', () => {
    it('opens the picker surface from the swatch instead of rendering it in every row', async () => {
        Object.defineProperty(globalThis, 'window', {
            configurable: true,
            value: {
                addEventListener: () => {},
                removeEventListener: () => {},
                innerWidth: 1024,
                innerHeight: 768,
            },
        });
        const { ThemeColorPicker } = await import('./ThemeColorPicker');

        const screen = await renderScreen(
            <ThemeColorPicker
                value="#123456"
                onChange={() => {}}
                inputTestID="theme-color-input"
                previewTestID="theme-color-preview"
                pickerTestID="theme-color-picker"
            />,
        );

        expect(screen.findByTestId('theme-color-input')).not.toBeNull();
        expect(screen.findByTestId('theme-color-preview')).not.toBeNull();
        expect(screen.findByTestId('theme-color-picker')).toBeNull();

        await screen.pressByTestIdAsync('theme-color-preview-button');

        expect(screen.findByTestId('theme-color-picker')).not.toBeNull();
        expect(screen.findByTestId('theme-color-picker:panel')).not.toBeNull();
        expect(screen.findByTestId('theme-color-picker:hue')).not.toBeNull();
        expect(screen.findByTestId('theme-color-picker:opacity')).not.toBeNull();
        expect(screen.findByTestId('theme-color-picker:swatches')).not.toBeNull();
    });

    it('toggles the picker surface closed from the swatch', async () => {
        Object.defineProperty(globalThis, 'window', {
            configurable: true,
            value: {
                addEventListener: () => {},
                removeEventListener: () => {},
                innerWidth: 1024,
                innerHeight: 768,
            },
        });
        const { ThemeColorPicker } = await import('./ThemeColorPicker');

        const screen = await renderScreen(
            <ThemeColorPicker
                value="#123456"
                onChange={() => {}}
                inputTestID="theme-color-input"
                previewTestID="theme-color-preview"
                pickerTestID="theme-color-picker"
            />,
        );

        await screen.pressByTestIdAsync('theme-color-preview-button');
        expect(screen.findByTestId('theme-color-picker')).not.toBeNull();

        await screen.pressByTestIdAsync('theme-color-preview-button');
        expect(screen.findByTestId('theme-color-picker')).toBeNull();
    });
});
