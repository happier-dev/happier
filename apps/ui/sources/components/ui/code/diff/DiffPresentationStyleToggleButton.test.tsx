import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { createPartialStorageModuleMock, pressTestInstanceAsync, renderScreen } from '@/dev/testkit';
import { installCodeDiffCommonModuleMocks } from './codeDiffTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const setFilesDiffPresentationStyle = vi.fn();
let styleSettingValue: 'unified' | 'split' | undefined = 'unified';

installCodeDiffCommonModuleMocks({
    storage: async (importOriginal) =>
        await createPartialStorageModuleMock(importOriginal, {
            useSettingMutable: (key: string) => {
                if (key === 'filesDiffPresentationStyle') return [styleSettingValue, setFilesDiffPresentationStyle];
                return [null, vi.fn()];
            },
        }),
    unistyles: async () => {
        const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
        return createUnistylesMock({
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
    },
});

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
}));

describe('DiffPresentationStyleToggleButton', () => {
    it('offers both view choices explicitly and applies the selected view', async () => {
        setFilesDiffPresentationStyle.mockClear();
        styleSettingValue = 'unified';
        const { DiffPresentationStyleToggleButton } = await import('./DiffPresentationStyleToggleButton');
        const { DiffPresentationWidthProvider } = await import('./diffPresentationStyle');
        const screen = await renderScreen(<DiffPresentationWidthProvider widthPx={1100}><DiffPresentationStyleToggleButton presentation="segmented" /></DiffPresentationWidthProvider>);
        await screen.pressByTestIdAsync('diff-presentation:split');
        expect(setFilesDiffPresentationStyle).toHaveBeenCalledWith('split');
    });
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

    it('does not offer split where the pane is too narrow to draw it, and says why', async () => {
        setFilesDiffPresentationStyle.mockClear();
        styleSettingValue = 'unified';
        const { DiffPresentationStyleToggleButton } = await import('./DiffPresentationStyleToggleButton');
        const { DiffPresentationWidthProvider } = await import('./diffPresentationStyle');

        const screen = await renderScreen(
            <DiffPresentationWidthProvider widthPx={600}>
                <DiffPresentationStyleToggleButton />
            </DiffPresentationWidthProvider>,
        );
        const pressable = screen.findByProps({ accessibilityRole: 'button' });
        await pressTestInstanceAsync(pressable, 'DiffPresentationStyleToggleButton');

        expect(setFilesDiffPresentationStyle).not.toHaveBeenCalled();
        expect(screen.findAll((node) => node.props?.accessibilityHint === 'detailsSurface.chrome.splitNeedsWiderPane').length).toBeGreaterThan(0);
    });

    it('offers split once the pane is wide enough', async () => {
        setFilesDiffPresentationStyle.mockClear();
        styleSettingValue = 'unified';
        const { DiffPresentationStyleToggleButton } = await import('./DiffPresentationStyleToggleButton');
        const { DiffPresentationWidthProvider } = await import('./diffPresentationStyle');

        const screen = await renderScreen(
            <DiffPresentationWidthProvider widthPx={1100}>
                <DiffPresentationStyleToggleButton />
            </DiffPresentationWidthProvider>,
        );
        await pressTestInstanceAsync(screen.findByProps({ accessibilityRole: 'button' }), 'DiffPresentationStyleToggleButton');
        expect(setFilesDiffPresentationStyle).toHaveBeenCalledWith('split');
    });
});
