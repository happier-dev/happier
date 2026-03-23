import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { createPartialStorageModuleMock, pressTestInstanceAsync, renderScreen } from '@/dev/testkit';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const setFilesDiffPresentationStyle = vi.fn();
let styleSettingValue: 'unified' | 'split' | undefined = 'unified';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
}));

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit');
    return await createUnistylesMock({
        theme: {
            dark: false,
            colors: {
                divider: '#ddd',
                surfaceHigh: '#fff',
                surfaceHighest: '#fff',
                textSecondary: '#666',
            },
        },
    });
});

vi.mock('@/sync/domains/state/storage', async (importOriginal) =>
    await createPartialStorageModuleMock(importOriginal, {
        useSettingMutable: (key: string) => {
            if (key === 'filesDiffPresentationStyle') return [styleSettingValue, setFilesDiffPresentationStyle];
            return [null, vi.fn()];
        },
    }),
);

describe('DiffPresentationStyleToggleButton', () => {
    it('toggles unified -> split', async () => {
        setFilesDiffPresentationStyle.mockClear();
        styleSettingValue = 'unified';
        const { DiffPresentationStyleToggleButton } = await import('./DiffPresentationStyleToggleButton');

        const screen = await renderScreen(<DiffPresentationStyleToggleButton />);
        const pressable = screen.findByProps({ accessibilityRole: 'button' });
        await pressTestInstanceAsync(pressable, 'DiffPresentationStyleToggleButton');

        expect(setFilesDiffPresentationStyle).toHaveBeenCalledWith('split');
    });

    it('defaults to unified when the setting is missing', async () => {
        setFilesDiffPresentationStyle.mockClear();
        styleSettingValue = undefined;
        const { DiffPresentationStyleToggleButton } = await import('./DiffPresentationStyleToggleButton');

        const screen = await renderScreen(<DiffPresentationStyleToggleButton />);
        const pressable = screen.findByProps({ accessibilityRole: 'button' });
        await pressTestInstanceAsync(pressable, 'DiffPresentationStyleToggleButton');

        expect(setFilesDiffPresentationStyle).toHaveBeenCalledWith('split');
    });
});
