import { describe, expect, it } from 'vitest';

import { getFileLanguageFromPath } from '@/utils/code/fileLanguage';
import { isBinaryContent, resolveFileViewerKind } from './filePresentation';

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

describe('resolveFileViewerKind', () => {
    it('projects alpha capability from the same resolved kind and MIME row', () => {
        for (const path of ['icon.png', 'icon.webp', 'icon.gif', 'icon.ico', 'icon.svg', 'icon.avif']) {
            expect(resolveFileViewerKind({ path }).alphaCapable).toBe(true);
        }
        for (const path of ['photo.jpg', 'photo.bmp', 'README.md', 'unknown']) {
            expect(resolveFileViewerKind({ path }).alphaCapable).toBe(false);
        }
        expect(resolveFileViewerKind({ path: 'icon.png', mimeType: 'image/jpeg' }).alphaCapable).toBe(false);
        expect(resolveFileViewerKind({ path: 'photo.jpg', mimeType: 'image/png' }).alphaCapable).toBe(true);
        expect(resolveFileViewerKind({ path: 'icon.png', isBinaryContent: true }).alphaCapable).toBe(true);
    });

    it('provides precise kinds and MIME across file families', () => {
        for (const [path, kind, mimeType, previewable] of [
            ['logo.png', 'image', 'image/png', true],
            ['icon.svg', 'svg', 'image/svg+xml', true],
            ['README.md', 'markdown', 'text/markdown', false],
            ['report.html', 'html', 'text/html', false],
            ['legacy.HTM', 'html', 'text/html', false],
            ['app.ts', 'code', 'text/plain', false],
            ['spec.pdf', 'pdf', 'application/pdf', true],
            ['clip.m4v', 'video', 'video/x-m4v', true],
            ['song.mp3', 'audio', 'audio/mpeg', true],
            ['archive.zip', 'binary', 'application/zip', false],
            ['C:\\project.mp4\\plain.unknown', 'code', 'text/plain', false],
        ] as const) {
            expect(resolveFileViewerKind({ path })).toMatchObject({ kind, mimeType, previewable });
        }
    });

    it('prefers specific MIME and falls back from generic MIME to the path', () => {
        expect(resolveFileViewerKind({ path: 'photo.jpg', mimeType: ' application/pdf; charset=binary ' }).kind).toBe('pdf');
        expect(resolveFileViewerKind({ path: 'icon.SVG', mimeType: 'application/octet-stream' }).kind).toBe('svg');
        expect(resolveFileViewerKind({ path: 'icon.svg', isBinaryContent: true }).kind).toBe('svg');
        expect(resolveFileViewerKind({ path: 'report.html', isBinaryContent: true }).kind).toBe('binary');
        expect(resolveFileViewerKind({ path: 'unknown.asset', isBinaryContent: true })).toMatchObject({ kind: 'binary', mimeType: 'application/octet-stream' });
        expect(resolveFileViewerKind({ path: 'photo', mimeType: 'image/heic' })).toMatchObject({ kind: 'image', mimeType: 'image/heic', previewable: true });
        expect(resolveFileViewerKind({ path: 'recording', mimeType: 'audio/opus' })).toMatchObject({ kind: 'audio', mimeType: 'audio/opus', previewable: true });
    });

    it('treats Git binary metadata as lack of a text diff while preserving recognized media', () => {
        for (const [path, kind, mimeType] of [
            ['logo.png', 'image', 'image/png'],
            ['icon.svg', 'svg', 'image/svg+xml'],
            ['spec.pdf', 'pdf', 'application/pdf'],
            ['song.mp3', 'audio', 'audio/mpeg'],
            ['clip.mp4', 'video', 'video/mp4'],
        ] as const) {
            expect(resolveFileViewerKind({ path, isBinaryContent: true })).toMatchObject({ kind, mimeType, previewable: true });
        }
        expect(resolveFileViewerKind({ path: 'upload', mimeType: 'image/webp', isBinaryContent: true })).toMatchObject({ kind: 'image', mimeType: 'image/webp', previewable: true });
        expect(resolveFileViewerKind({ path: 'upload', head: new TextEncoder().encode('%PDF-1.7'), isBinaryContent: true })).toMatchObject({ kind: 'pdf', mimeType: 'application/pdf', previewable: true });
        for (const path of ['unknown.asset', 'README.md', 'script.ts']) {
            expect(resolveFileViewerKind({ path, isBinaryContent: true })).toMatchObject({ kind: 'binary', mimeType: 'application/octet-stream', previewable: false });
        }
    });

    it('refines supplied generic bytes without reading anything itself', () => {
        const bytes = (text: string) => new TextEncoder().encode(text);
        expect(resolveFileViewerKind({ path: 'upload', head: bytes('%PDF-1.7') }).kind).toBe('pdf');
        expect(resolveFileViewerKind({ path: 'wrong.txt', head: new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]) }).kind).toBe('image');
        expect(resolveFileViewerKind({ path: 'script', head: bytes('#!/bin/sh\necho hi') }).kind).toBe('code');
        expect(resolveFileViewerKind({ path: 'bad.pdf', head: bytes('not a PDF') }).kind).toBe('binary');
        expect(resolveFileViewerKind({ path: 'offset.pdf', head: bytes('padding\n%PDF-1.7') }).kind).toBe('pdf');
        expect(resolveFileViewerKind({ path: 'late.pdf', head: bytes('x'.repeat(1024) + '%PDF-1.7') }).kind).toBe('binary');
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
