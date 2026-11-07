import { describe, expect, it, vi } from 'vitest';
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';

import { generateShikiGrammarAssets } from '../../../../../../scripts/generateShikiGrammarAssets.mjs';

import { clearShikiCacheForKey, resolveHappierShikiThemeId, shikiTokenizeLines } from './shikiTokenize';

describe('shikiTokenizeLines with the real highlighter', () => {
    it('loads the real highlighter and requested grammar on first use in a compiled web bundle', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'happier-shiki-'));
        try {
            const { outputPath } = await generateShikiGrammarAssets({
                uiPackageDir: process.cwd(), outputDirectory: join(directory, 'assets'), outputPath: join(directory, 'inventory.js'),
            });
            const result = await build({
                entryPoints: [resolve(process.cwd(), 'sources/components/ui/code/highlighting/shiki/shikiTokenize.ts')],
                bundle: true, format: 'cjs', platform: 'node', write: false,
                metafile: true,
                resolveExtensions: ['.web.ts', '.web.tsx', '.ts', '.tsx', '.mjs', '.js', '.json'],
                external: ['react-native', 'expo-asset', 'expo-file-system'],
                plugins: [{
                    name: 'packaged-asset-filesystem-boundary',
                    setup(plugin) {
                        plugin.onResolve({ filter: /generatedShikiGrammarAssets$/ }, () => ({ path: outputPath }));
                        plugin.onLoad({ filter: /\.json\.bundle$/ }, ({ path }) => ({
                            contents: `module.exports = ${JSON.stringify(path)};`, loader: 'js',
                        }));
                    },
                }],
            });
            expect(Object.keys(result.metafile!.inputs).filter(file => /(?:^|\/)node_modules\/@shikijs\/themes\//.test(file)),
                'custom Happier themes must not download Shiki built-in themes').toEqual([]);
            expect(Object.keys(result.metafile!.inputs).filter(file => /(?:^|\/)node_modules\/@shikijs\/langs\//.test(file)),
                'web tokenization must fetch requested grammars as assets instead of including every grammar in JavaScript').toEqual([]);
            const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
            const native = await createReactNativeWebMock();
            const nodeRequire = createRequire(resolve(process.cwd(), 'package.json'));
            const compiled = { exports: {} };
            const reads: string[] = [];
            vi.stubGlobal('fetch', async (url: string) => {
                const path = decodeURIComponent(new URL(url).pathname.slice(1));
                reads.push(path);
                return new Response(new Uint8Array(await readFile(path)));
            });
            // Platform SDKs and asset I/O leave the compiled owner graph; the
            // generated inventory, real Shiki core and grammar payloads remain real.
            new Function('require', 'module', 'exports', result.outputFiles![0].text)(
                (specifier: string) => {
                    if (specifier === 'react-native') return native;
                    if (specifier === 'expo-asset') return { Asset: { fromModule: (path: string) => ({
                        uri: `https://shiki.test/${encodeURIComponent(path)}`, downloadAsync: async () => {},
                    }) } };
                    return nodeRequire(specifier);
                }, compiled, compiled.exports,
            );
            const owner = compiled.exports as typeof import('./shikiTokenize');
            const lines = ['const answer = 42;'];
            const highlighted = await owner.shikiTokenizeLines({ isDark: false, language: 'typescript', lines });
            expect(highlighted.tokensByLine[0].map(token => token.text).join('')).toBe(lines[0]);
            expect(new Set(highlighted.tokensByLine[0].map(token => token.color)).size).toBeGreaterThan(1);
            expect(reads).toHaveLength(1);
            const customized = await owner.shikiTokenizeLines({ isDark: false, language: 'ts', lines,
                colors: { syntax: { keyword: '#123456' } } });
            expect(customized.tokensByLine[0].find(token => token.text === 'const')?.color).toBe('#123456');
            expect(reads).toHaveLength(1);
            const vueLines = ['<template><div>{{ answer }}</div></template>', '<script setup lang="ts">const answer = 42;</script>'];
            const vue = await owner.shikiTokenizeLines({ isDark: false, language: 'vue', lines: vueLines });
            expect(vue.tokensByLine.map(row => row.map(token => token.text).join(''))).toEqual(vueLines);
            expect(new Set(vue.tokensByLine.flat().map(token => token.color)).size).toBeGreaterThan(1);
        } finally {
            vi.unstubAllGlobals();
            await rm(directory, { recursive: true, force: true });
        }
    });
    it('exposes grammar tokens independently of color-token merging', async () => {
        const owner = await import('./shikiTokenize');
        expect(owner).toHaveProperty('shikiTokenizeScopeLines');
        const { shikiTokenizeScopeLines } = owner;
        const rows = await shikiTokenizeScopeLines({ isDark: false, language: 'typescript', lines: ['export class Box {', '    read(): void {}', '}'] });
        expect(rows[0]?.find(token => token.text === 'Box')).toMatchObject({
            column: 13, scopes: expect.arrayContaining(['entity.name.type.class.ts']),
        });
        expect(rows[1]?.find(token => token.text === 'read')).toMatchObject({
            column: 4, scopes: expect.arrayContaining(['meta.definition.method.ts']),
        });
    });

    it('preserves text, custom syntax colors and unknown-language fallback through lazy initialization', async () => {
        const colors = {
            surface: { base: '#ffffff', inset: '#f6f8fa' },
            text: { primary: '#24292f', secondary: '#57606a' },
            syntax: { default: '#24292f', keyword: '#123456', number: '#0550ae', comment: '#6e7781' },
        };
        const themeId = resolveHappierShikiThemeId({ isDark: false, colors });
        try {
            const lines = ['const value = 1;', '', '// hello'];
            const result = await shikiTokenizeLines({ isDark: false, language: 'typescript', lines, colors });
            expect(result.tokensByLine.map(row => row.map(token => token.text).join(''))).toEqual(lines);
            expect(result.tokensByLine[0]?.find(token => token.text === 'const')?.color).toBe('#123456');
            expect(result.tokensByLine[0]?.find(token => token.text === '1')?.color.toLowerCase()).toBe('#0550ae');
            expect(result.tokensByLine[2]?.every(token => token.color.toLowerCase() === '#6e7781')).toBe(true);
            expect(result.fg.toLowerCase()).toBe('#24292f');

            const plain = await shikiTokenizeLines({ isDark: false, language: 'not-a-shiki-language', lines, colors });
            expect(plain.tokensByLine.map(row => row.map(token => token.text).join(''))).toEqual(lines);
            expect(plain.tokensByLine.flat().every(token => token.color === plain.fg)).toBe(true);
        } finally {
            clearShikiCacheForKey(themeId);
        }
    });
});
