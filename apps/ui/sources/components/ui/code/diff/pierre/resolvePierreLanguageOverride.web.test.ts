import { describe, expect, it, vi } from 'vitest';

vi.mock('@/utils/code/fileLanguage', () => ({
    getFileLanguageFromPath: (path: string) => {
        if (path === '.env.production') return 'dotenv';
        if (path.endsWith('.ts')) return 'typescript';
        if (path.endsWith('.md')) return 'markdown';
        return null;
    },
}));

vi.mock('@/components/ui/code/highlighting/resolveShikiLanguageId', () => ({
    resolveShikiLanguageId: (language: string) => {
        const lang = String(language ?? '').toLowerCase();
        if (lang === 'typescript') return 'ts';
        if (lang === 'dotenv') return 'dotenv';
        if (lang === 'markdown') return 'markdown';
        return 'text';
    },
}));

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
