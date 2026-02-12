import { describe, expect, it } from 'vitest';

import { getFileLanguageFromPath, isBinaryContent, isKnownBinaryPath } from './filePresentation';

describe('getFileLanguageFromPath', () => {
    it('maps known file extensions to syntax highlighter languages', () => {
        expect(getFileLanguageFromPath('src/example.ts')).toBe('typescript');
        expect(getFileLanguageFromPath('src/example.md')).toBe('markdown');
        expect(getFileLanguageFromPath('src/example.sh')).toBe('bash');
        expect(getFileLanguageFromPath('src/example.rs')).toBe('rust');
        expect(getFileLanguageFromPath('assets/icon.svg')).toBe('xml');
    });

    it('returns null for unknown extensions', () => {
        expect(getFileLanguageFromPath('src/example.unknown')).toBeNull();
        expect(getFileLanguageFromPath('src/no-extension')).toBeNull();
        expect(getFileLanguageFromPath('Makefile')).toBeNull();
        expect(getFileLanguageFromPath('.gitignore')).toBeNull();
    });
});

describe('isKnownBinaryPath', () => {
    it('detects binary file extensions', () => {
        expect(isKnownBinaryPath('assets/logo.png')).toBe(true);
        expect(isKnownBinaryPath('build/app.exe')).toBe(true);
        expect(isKnownBinaryPath('src/app.ts')).toBe(false);
        expect(isKnownBinaryPath('assets/icon.svg')).toBe(false);
    });
});

describe('isBinaryContent', () => {
    it('detects NUL bytes', () => {
        expect(isBinaryContent('text\0binary')).toBe(true);
    });

    it('detects high non-printable character ratios', () => {
        const mostlyBinary = `abcdef${String.fromCharCode(1)}${String.fromCharCode(2)}`;
        expect(isBinaryContent(mostlyBinary)).toBe(true);
    });

    it('allows plain text including whitespace controls', () => {
        expect(isBinaryContent('line 1\nline 2\tline 3\r\n')).toBe(false);
    });
});
