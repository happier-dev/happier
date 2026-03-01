import { describe, expect, it } from 'vitest';

import { getFileLanguageFromPath } from '@/utils/code/fileLanguage';
import { isBinaryContent, isKnownBinaryPath } from './filePresentation';

describe('getFileLanguageFromPath', () => {
    it('maps known file extensions to syntax highlighter languages', () => {
        expect(getFileLanguageFromPath('src/example.ts')).toBe('typescript');
        expect(getFileLanguageFromPath('src/example.md')).toBe('markdown');
        expect(getFileLanguageFromPath('src/example.sh')).toBe('bash');
        expect(getFileLanguageFromPath('src/example.rs')).toBe('rust');
        expect(getFileLanguageFromPath('assets/icon.svg')).toBe('xml');
        expect(getFileLanguageFromPath('src/header.h')).toBe('c');
        expect(getFileLanguageFromPath('src/component.vue')).toBe('vue');
        expect(getFileLanguageFromPath('src/schema.graphql')).toBe('graphql');
        expect(getFileLanguageFromPath('src/schema.gql')).toBe('graphql');
    });

    it('maps known special filenames to syntax highlighter languages', () => {
        expect(getFileLanguageFromPath('Dockerfile')).toBe('dockerfile');
        expect(getFileLanguageFromPath('Makefile')).toBe('makefile');
        expect(getFileLanguageFromPath('CMakeLists.txt')).toBe('cmake');
        expect(getFileLanguageFromPath('.editorconfig')).toBe('ini');
        expect(getFileLanguageFromPath('.gitconfig')).toBe('ini');
        expect(getFileLanguageFromPath('.npmrc')).toBe('ini');
        expect(getFileLanguageFromPath('.prettierrc')).toBe('json');
        expect(getFileLanguageFromPath('.bashrc')).toBe('bash');
        expect(getFileLanguageFromPath('.zshrc')).toBe('zsh');
        expect(getFileLanguageFromPath('.env')).toBe('dotenv');
        expect(getFileLanguageFromPath('.env.production')).toBe('dotenv');
        expect(getFileLanguageFromPath('.gitignore')).toBe('text');
        expect(getFileLanguageFromPath('CODEOWNERS')).toBe('codeowners');
        expect(getFileLanguageFromPath('tsconfig.json')).toBe('jsonc');
    });

    it('recognizes special path-based config files', () => {
        expect(getFileLanguageFromPath('/home/me/.ssh/config')).toBe('ssh-config');
    });

    it('returns null for unknown extensions', () => {
        expect(getFileLanguageFromPath('src/example.unknown')).toBeNull();
        expect(getFileLanguageFromPath('src/no-extension')).toBeNull();
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
