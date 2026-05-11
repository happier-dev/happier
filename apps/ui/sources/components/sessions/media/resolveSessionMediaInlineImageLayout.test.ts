import { describe, expect, it } from 'vitest';

describe('resolveSessionMediaInlineImageLayout', () => {
    it('uses persisted dimensions before loaded dimensions', async () => {
        const { resolveSessionMediaInlineImageLayout } = await import('./resolveSessionMediaInlineImageLayout');

        expect(resolveSessionMediaInlineImageLayout({
            persistedDimensions: { width: 1600, height: 900 },
            loadedDimensions: { width: 900, height: 1600 },
        })).toEqual({ width: 220, height: 124 });
    });

    it('uses loaded dimensions when metadata has no valid dimensions', async () => {
        const { resolveSessionMediaInlineImageLayout } = await import('./resolveSessionMediaInlineImageLayout');

        expect(resolveSessionMediaInlineImageLayout({
            persistedDimensions: null,
            loadedDimensions: { width: 900, height: 1600 },
        })).toEqual({ width: 90, height: 160 });
    });

    it('falls back to a square before dimensions are known', async () => {
        const { resolveSessionMediaInlineImageLayout } = await import('./resolveSessionMediaInlineImageLayout');

        expect(resolveSessionMediaInlineImageLayout({
            persistedDimensions: null,
            loadedDimensions: null,
        })).toEqual({ width: 84, height: 84 });
    });
});
