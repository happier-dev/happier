import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import * as state from '@codemirror/state';
import * as view from '@codemirror/view';
import * as commands from '@codemirror/commands';
import * as autocomplete from '@codemirror/autocomplete';

import { buildCodeMirrorWebViewBundle } from './buildCodeMirrorWebViewBundle.mjs';

let tempDir: string | null = null;

afterEach(async () => {
    if (!tempDir) return;
    await fs.rm(tempDir, { recursive: true, force: true });
    tempDir = null;
});

describe('buildCodeMirrorWebViewBundle', () => {
    it('exposes CodeMirror syntax theme primitives in the generated bundle', async () => {
        tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'happier-codemirror-bundle-'));
        const testDir = path.dirname(fileURLToPath(import.meta.url));
        const repoNodeModules = path.resolve(testDir, '../../../..', 'node_modules');
        await fs.symlink(repoNodeModules, path.join(tempDir, 'node_modules'), 'dir');

        const result = await buildCodeMirrorWebViewBundle({
            expoAppDir: tempDir,
            repoRootDir: path.resolve(tempDir, '..'),
        });

        const generated = await fs.readFile(result.outFile, 'utf8');

        const encodedChunks = generated.match(/const CODEMIRROR_WEBVIEW_BUNDLE_CHUNKS = (\[[\s\S]*?\n\]);/);
        expect(encodedChunks).not.toBeNull();
        // Generated JavaScript is the WebView system boundary; inspect its real ABI, not minifier spelling.
        // The generator emits a JavaScript array (including its trailing comma), not JSON.
        const chunks: unknown = new Function(`return (${encodedChunks![1]});`)();
        if (!Array.isArray(chunks) || chunks.some(chunk => typeof chunk !== 'string')) throw new Error('Invalid generated bundle chunks');
        const bundleTarget: Record<string, unknown> = {};
        new Function('globalThis', chunks.join(''))(bundleTarget);
        const abi = bundleTarget.HAPPIER_CODEMIRROR_WEBVIEW;
        for (const primitive of ['HighlightStyle', 'tags', 'SearchQuery', 'setSearchQuery', 'openSearchPanel', 'createCodeMirrorDecorations', 'createCodeMirrorLanguageIntelligence',
            'StateField', 'StateEffect', 'RangeSet', 'RangeSetBuilder', 'RangeValue', 'MapMode', 'Decoration', 'gutter', 'GutterMarker', 'ViewPlugin', 'undoDepth']) {
            expect(abi).toHaveProperty(primitive);
        }
        const fallback = generated.match(/export const CODEMIRROR_INLINE_SUGGESTIONS_FACTORY_JS = (".*");/);
        expect(fallback).not.toBeNull();
        const target: Record<string, unknown> = {};
        new Function('globalThis', JSON.parse(fallback![1]!))(target);
        const factory = target.HAPPIER_CODEMIRROR_INLINE_FACTORY;
        expect(typeof factory).toBe('function');
        const runtime = (factory as typeof import('../../sources/components/ui/code/editor/bridge/codeMirrorInlineSuggestions').createCodeMirrorInlineSuggestions)(
            { ...state, ...view, ...commands, ...autocomplete },
            { separator: () => '\n', context() {}, event() {}, requestAccept() {} });
        expect(() => state.EditorState.create({ doc: 'fallback', extensions: runtime.extensions })).not.toThrow();
        const checked = await buildCodeMirrorWebViewBundle({ expoAppDir: tempDir, repoRootDir: path.resolve(tempDir, '..'), check: true });
        expect(checked.wrote).toBe(false);
        await fs.writeFile(result.outFile, 'outdated bundle');
        await expect(buildCodeMirrorWebViewBundle({ expoAppDir: tempDir, repoRootDir: path.resolve(tempDir, '..'), check: true }))
            .rejects.toThrow(/out of date/i);
        expect(await fs.readFile(result.outFile, 'utf8')).toBe('outdated bundle');
    });

    it('checks the repository bundle against the current editor sources', async () => {
        const testDir = path.dirname(fileURLToPath(import.meta.url));
        const expoAppDir = path.resolve(testDir, '../..');
        const result = await buildCodeMirrorWebViewBundle({ expoAppDir, repoRootDir: path.resolve(expoAppDir, '../..'), check: true });
        expect(result.wrote).toBe(false);
    });
});
