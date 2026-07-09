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
                color: lightTheme.colors.state.neutral.foreground,
            }),
        );
        expect(warning?.text).toContain('100');
    });

    it('uses baseline-adjusted canonical percentage math and the distinct warning color at 15% remaining', () => {
        const warning = getContextWarning({
            contextSize: 865,
            contextWindowTokens: 1_000,
            contextSnapshot: {
                v: 1,
                modelId: 'gpt-5.4',
                usedTokens: 865,
                windowTokens: 1_000,
                totalProcessedTokens: null,
                baselineTokens: 100,
                isAutoCompactEnabled: null,
                categories: null,
                observedAtMs: 1_000,
                source: 'provider_turn',
            },
            theme: lightTheme,
        });

        expect(warning).toEqual(expect.objectContaining({
            color: lightTheme.colors.state.warning.foreground,
        }));
        expect(warning?.text).toContain('15');
    });

    it('suppresses percentages for a snapshot made stale by a model switch', () => {
        expect(getContextWarning({
            contextSize: 950,
            contextWindowTokens: 1_000,
            contextSnapshot: {
                v: 1,
                modelId: 'model-a',
                usedTokens: 950,
                windowTokens: 1_000,
                totalProcessedTokens: null,
                baselineTokens: null,
                isAutoCompactEnabled: null,
                categories: null,
                observedAtMs: 1_000,
                source: 'provider_turn',
            },
            contextSnapshotStale: true,
            alwaysShow: true,
            theme: lightTheme,
        })).toBeNull();
    });
});
