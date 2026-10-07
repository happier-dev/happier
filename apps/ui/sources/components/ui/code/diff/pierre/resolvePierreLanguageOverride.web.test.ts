import { describe, expect, it } from 'vitest';

describe('resolvePierreLanguageOverride (web)', () => {
    it('returns shiki language ids for known file paths', async () => {
        const { resolvePierreLanguageOverride } = await import('./resolvePierreLanguageOverride.web');
        expect(resolvePierreLanguageOverride('.env.production')).toBe('dotenv');
        expect(resolvePierreLanguageOverride('src/demo.ts')).toBe('ts');
        expect(resolvePierreLanguageOverride('AGENTS.md')).toBe('markdown');
    });

    it('returns null for unknown languages or empty paths', async () => {
        const { resolvePierreLanguageOverride } = await import('./resolvePierreLanguageOverride.web');
        expect(resolvePierreLanguageOverride('src/demo.unknown')).toBe(null);
        expect(resolvePierreLanguageOverride('')).toBe(null);
    });
});
