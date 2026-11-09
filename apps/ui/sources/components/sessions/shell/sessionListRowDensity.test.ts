import { describe, expect, it } from 'vitest';

import {
    resolveSessionListRowHeight,
    resolveSessionListRowInteractiveTargetSize,
} from './sessionListRowDensity';

describe('session list native row accessibility geometry', () => {
    it('keeps minimal native rows and their nested controls at a 48dp interaction floor', () => {
        for (const isTablet of [false, true]) {
            expect(resolveSessionListRowHeight({
                compact: true,
                compactMinimal: true,
                isTablet,
                platform: 'android',
            })).toBe(48);
            expect(resolveSessionListRowHeight({
                compact: true,
                compactMinimal: true,
                isTablet,
                platform: 'ios',
            })).toBe(48);
        }
        expect(resolveSessionListRowHeight({
            compact: true,
            compactMinimal: true,
            isTablet: false,
            platform: 'web',
        })).toBe(34);

        expect(resolveSessionListRowInteractiveTargetSize('android')).toBe(48);
        expect(resolveSessionListRowInteractiveTargetSize('ios')).toBe(48);
        expect(resolveSessionListRowInteractiveTargetSize('web')).toBe(44);
    });
});
