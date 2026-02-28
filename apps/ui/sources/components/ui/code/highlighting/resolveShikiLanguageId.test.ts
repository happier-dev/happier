import { describe, expect, it, vi } from 'vitest';

vi.mock('shiki', () => ({
    bundledLanguages: {
        ts: {},
        js: {},
        python: {},
        bash: {},
        makefile: {},
        cmake: {},
        dotenv: {},
        json: {},
        jsonc: {},
        yaml: {},
        markdown: {},
        mdx: {},
        graphql: {},
    },
}));

describe('resolveShikiLanguageId', () => {
    it('maps common language aliases to Shiki bundled language ids', async () => {
        const { resolveShikiLanguageId } = await import('./resolveShikiLanguageId');
        expect(resolveShikiLanguageId('typescript')).toBe('ts');
        expect(resolveShikiLanguageId('javascript')).toBe('js');
        expect(resolveShikiLanguageId('py')).toBe('python');
        expect(resolveShikiLanguageId('md')).toBe('markdown');
        expect(resolveShikiLanguageId('gql')).toBe('graphql');
        expect(resolveShikiLanguageId('yml')).toBe('yaml');
        expect(resolveShikiLanguageId('sh')).toBe('bash');
    });

    it('passes through known bundled language ids', async () => {
        const { resolveShikiLanguageId } = await import('./resolveShikiLanguageId');
        expect(resolveShikiLanguageId('makefile')).toBe('makefile');
        expect(resolveShikiLanguageId('cmake')).toBe('cmake');
        expect(resolveShikiLanguageId('dotenv')).toBe('dotenv');
        expect(resolveShikiLanguageId('markdown')).toBe('markdown');
        expect(resolveShikiLanguageId('graphql')).toBe('graphql');
    });

    it('falls back to text for unknown languages', async () => {
        const { resolveShikiLanguageId } = await import('./resolveShikiLanguageId');
        expect(resolveShikiLanguageId('totally-unknown')).toBe('text');
        expect(resolveShikiLanguageId('')).toBe('text');
    });
});
