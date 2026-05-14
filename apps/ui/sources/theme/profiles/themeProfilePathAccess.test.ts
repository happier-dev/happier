import { describe, expect, it } from 'vitest';

import { readThemeProfilePathValue, setThemeProfilePathValue } from './themeProfilePathAccess';

describe('theme profile path access', () => {
    it('reads leaf string paths from nested objects and arrays', () => {
        const colors = {
            surface: { base: '#ffffff' },
            gradient: { stops: ['#111111', '#222222'] },
        };

        expect(readThemeProfilePathValue(colors, ['surface', 'base'])).toBe('#ffffff');
        expect(readThemeProfilePathValue(colors, ['gradient', 'stops', 1])).toBe('#222222');
    });

    it('immutably writes terminal string paths without mutating the source object', () => {
        const colors = {
            surface: { base: '#ffffff', elevated: '#f0f0f0' },
            gradient: { stops: ['#111111', '#222222'] },
        };

        const next = setThemeProfilePathValue(colors, ['surface', 'base'], '#101010');
        const nextWithArray = setThemeProfilePathValue(colors, ['gradient', 'stops', 0], '#333333');

        expect(next).not.toBe(colors);
        expect(next.surface).not.toBe(colors.surface);
        expect(next.surface.base).toBe('#101010');
        expect(colors.surface.base).toBe('#ffffff');
        expect(nextWithArray.gradient.stops).toEqual(['#333333', '#222222']);
        expect(colors.gradient.stops).toEqual(['#111111', '#222222']);
    });

    it('ignores unknown paths and non-string terminal values', () => {
        const colors = { surface: { base: '#ffffff' }, metrics: { radius: 12 } };

        expect(readThemeProfilePathValue(colors, ['surface', 'missing'])).toBeUndefined();
        expect(readThemeProfilePathValue(colors, ['metrics', 'radius'])).toBeUndefined();
        expect(setThemeProfilePathValue(colors, ['surface', 'missing'], '#101010')).toBe(colors);
        expect(setThemeProfilePathValue(colors, ['metrics', 'radius'], '#101010')).toBe(colors);
    });
});
