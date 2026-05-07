import { describe, expect, it } from 'vitest';

describe('useChromeSafeAreaInsets helpers', () => {
    it('merges safe-area inset sources by keeping the larger edge value', async () => {
        const { mergeSafeAreaInsets } = await import('./useChromeSafeAreaInsets');

        expect(mergeSafeAreaInsets(
            { top: 4, bottom: 12, left: 0, right: 6 },
            { top: 8, bottom: 2, left: 3, right: 1 },
        )).toEqual({
            top: 8,
            bottom: 12,
            left: 3,
            right: 6,
        });
    });

    it('returns zero web fallback insets when document is unavailable', async () => {
        const { readWebSafeAreaInsetsFromCss } = await import('./useChromeSafeAreaInsets');

        expect(readWebSafeAreaInsetsFromCss()).toEqual({
            top: 0,
            bottom: 0,
            left: 0,
            right: 0,
        });
    });
});
