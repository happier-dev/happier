import { describe, expect, it } from 'vitest';

import { lightTheme } from '@/theme';

import { getContextWarning } from './contextWarning';

describe('getContextWarning', () => {
    it('returns null when the provider does not expose a real context window', () => {
        expect(
            getContextWarning({
                contextSize: 120,
                contextWindowTokens: null,
                alwaysShow: true,
                theme: lightTheme,
            }),
        ).toBeNull();
    });

    it('shows a neutral zero-state warning when a real context window exists and alwaysShow is enabled', () => {
        const warning = getContextWarning({
            contextSize: 0,
            contextWindowTokens: 1000,
            alwaysShow: true,
            theme: lightTheme,
        });

        expect(warning).toEqual(
            expect.objectContaining({
                color: lightTheme.colors.warning,
            }),
        );
        expect(warning?.text).toContain('100');
    });
});
