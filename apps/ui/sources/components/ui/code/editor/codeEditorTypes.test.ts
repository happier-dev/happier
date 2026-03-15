import { describe, expect, it } from 'vitest';

describe('resolveMonacoLanguageId', () => {
    it('maps common aliases and react variants', async () => {
        const { resolveMonacoLanguageId } = await import('./codeEditorTypes');
        expect(resolveMonacoLanguageId('ts')).toBe('typescript');
        expect(resolveMonacoLanguageId('tsx')).toBe('typescript');
        expect(resolveMonacoLanguageId('typescript')).toBe('typescript');

        expect(resolveMonacoLanguageId('js')).toBe('javascript');
        expect(resolveMonacoLanguageId('jsx')).toBe('javascript');
        expect(resolveMonacoLanguageId('javascript')).toBe('javascript');

        expect(resolveMonacoLanguageId('md')).toBe('markdown');
        expect(resolveMonacoLanguageId('markdown')).toBe('markdown');
        expect(resolveMonacoLanguageId('mdx')).toBe('markdown');

        expect(resolveMonacoLanguageId('yml')).toBe('yaml');
        expect(resolveMonacoLanguageId('yaml')).toBe('yaml');

        expect(resolveMonacoLanguageId('jsonc')).toBe('json');
        expect(resolveMonacoLanguageId('json5')).toBe('json');

        expect(resolveMonacoLanguageId('bash')).toBe('shell');
        expect(resolveMonacoLanguageId('zsh')).toBe('shell');
        expect(resolveMonacoLanguageId('dotenv')).toBe('shell');
    });

    it('falls back to plaintext for empty values', async () => {
        const { resolveMonacoLanguageId } = await import('./codeEditorTypes');
        expect(resolveMonacoLanguageId(null)).toBe('plaintext');
        expect(resolveMonacoLanguageId('')).toBe('plaintext');
        expect(resolveMonacoLanguageId('   ')).toBe('plaintext');
    });
});
