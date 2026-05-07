import { describe, expect, it } from 'vitest';

import { darkTheme, lightTheme } from './theme';

describe('control gradient theme tokens', () => {
    function hexLuminance(hex: string): number {
        const value = hex.replace('#', '');
        const channels = [0, 2, 4].map((offset) => parseInt(value.slice(offset, offset + 2), 16) / 255);
        const [red, green, blue] = channels.map((channel) =>
            channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4,
        );
        return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
    }

    function expectVerticalGradientToBeLighterAtTop(colors: readonly [string, string, ...string[]]) {
        const bottomColor = colors[0];
        const topColor = colors[colors.length - 1];
        expect(hexLuminance(topColor)).toBeGreaterThanOrEqual(hexLuminance(bottomColor));
    }

    it('defines subtle fallback-compatible gradients for FAB controls', () => {
        expect(darkTheme.colors.fab.gradient?.colors).toEqual(['#303030', '#343434']);
        expect(lightTheme.colors.fab.gradient?.colors).toEqual(['#000000', '#171717']);
        expect(darkTheme.colors.fab.gradient?.start).toEqual({ x: 0.5, y: 1 });
        expect(darkTheme.colors.fab.gradient?.end).toEqual({ x: 0.5, y: 0 });
    });

    it('defines segmented control gradients without replacing solid color fallbacks', () => {
        expect(lightTheme.colors.segmentedControl.trackBackground).toBe(lightTheme.colors.surfaceHighest);
        expect(lightTheme.colors.segmentedControl.activeBackground).toBe(lightTheme.colors.surface);
        expect(lightTheme.colors.segmentedControl.trackGradient).toBeUndefined();
        expect(lightTheme.colors.segmentedControl.activeGradient?.colors).toEqual(['#FDFDFD', '#FFFFFF']);

        expect(darkTheme.colors.segmentedControl.trackBackground).toBe(darkTheme.colors.surfaceHighest);
        expect(darkTheme.colors.segmentedControl.activeBackground).toBe(darkTheme.colors.surface);
        expect(darkTheme.colors.segmentedControl.trackGradient).toBeUndefined();
        expect(darkTheme.colors.segmentedControl.activeGradient?.colors).toEqual(['#202020', '#232323']);
    });

    it('defines primary button gradients separately from color tokens used by non-fill consumers', () => {
        expect(lightTheme.colors.button.primary.background).toBe('#000000');
        expect(lightTheme.colors.button.primary.gradient?.colors).toEqual(['#000000', '#171717']);
        expect(darkTheme.colors.button.primary.background).toBe('#1b1b1b');
        expect(darkTheme.colors.button.primary.gradient?.colors).toEqual(['#1b1b1b', '#242424']);
    });

    it('keeps raised control gradients lighter at the top than the bottom', () => {
        for (const theme of [lightTheme, darkTheme]) {
            expectVerticalGradientToBeLighterAtTop(theme.colors.fab.gradient.colors);
            expectVerticalGradientToBeLighterAtTop(theme.colors.button.primary.gradient.colors);
            expectVerticalGradientToBeLighterAtTop(theme.colors.segmentedControl.activeGradient.colors);
        }
    });
});
