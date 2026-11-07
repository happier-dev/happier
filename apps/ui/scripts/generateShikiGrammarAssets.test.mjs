// @happier-test-preparation source
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';
import { build } from 'esbuild';
import { bundledLanguages, bundledLanguagesInfo } from 'shiki/langs';

import { generateShikiGrammarAssets } from './generateShikiGrammarAssets.mjs';

const require = createRequire(import.meta.url);
const { resolveShikiGrammarRegistry } = require('./shikiGrammarRegistry.cjs');
const uiRoot = fileURLToPath(new URL('..', import.meta.url));

test('only the web grammar registry changes while native and upstream highlighter modules keep their resolver', () => {
    const config = require('../metro.config.js');
    const registryPath = resolveShikiGrammarRegistry(uiRoot);
    const context = {
        originModulePath: require.resolve('shiki/langs'),
        resolveRequest: (_context, moduleName) => ({ type: 'sourceFile', filePath: resolve(_context.originModulePath, '..', moduleName) }),
    };
    const registryImport = `./${basename(registryPath)}`;
    assert.ok(config.resolver.resolveRequest(context, registryImport, 'web').filePath.endsWith('shikiGrammarRegistry.web.ts'));
    for (const platform of ['ios', 'android']) {
        assert.equal(config.resolver.resolveRequest(context, registryImport, platform).filePath, registryPath);
    }
    assert.equal(config.resolver.resolveRequest(context, './bundle-full.mjs', 'web').filePath,
        resolve(context.originModulePath, '..', 'bundle-full.mjs'));
});

async function compileRegistry(publicationPath) {
    const registryPath = resolveShikiGrammarRegistry(uiRoot);
    const result = await build({
        stdin: { contents: `export * as registry from ${JSON.stringify(registryPath)};
            export { getSharedHighlighter, registerCustomTheme } from '@pierre/diffs';`, resolveDir: uiRoot },
        bundle: true, platform: 'node', format: 'cjs', write: false, metafile: true,
        plugins: [{ name: 'packaged-grammar-system-boundaries', setup(plugin) {
            plugin.onResolve({ filter: /./ }, args => {
                if (resolve(args.resolveDir, args.path) === registryPath) {
                    return { path: join(uiRoot, 'sources/components/ui/code/highlighting/shiki/shikiGrammarRegistry.web.ts') };
                }
            });
            plugin.onResolve({ filter: /generatedShikiGrammarAssets$/ }, () => ({ path: publicationPath }));
            // Substitute only the Expo/native filesystem boundary with Node's filesystem.
            plugin.onResolve({ filter: /readBundledAssetBytes$/ }, () => ({ path: 'asset-reader', namespace: 'test-os' }));
            plugin.onLoad({ filter: /.*/, namespace: 'test-os' }, () => ({
                contents: 'export async function readBundledAssetBytes(path) { return require("node:fs/promises").readFile(path); }',
            }));
            plugin.onLoad({ filter: /\.json\.bundle$/ }, ({ path }) => ({
                contents: `module.exports = ${JSON.stringify(path)};`, loader: 'js',
            }));
        } }],
    });
    assert.deepEqual(Object.keys(result.metafile.inputs).filter(path => /node_modules\/@shikijs\/langs\//.test(path)), []);
    const module = { exports: {} };
    new Function('module', 'exports', 'require', result.outputFiles[0].text)(module, module.exports, require);
    const upstream = await import(pathToFileURL(registryPath).href);
    assert.deepEqual(Object.keys(module.exports.registry).sort(), Object.keys(upstream).sort(),
        'the replacement must match the exact installed internal export contract');
    return module.exports;
}

test('packaged grammar assets preserve every installed alias and embedded closure without duplicate payloads', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'happier-shiki-assets-'));
    try {
        const options = {
            uiPackageDir: fileURLToPath(new URL('..', import.meta.url)),
            outputDirectory: join(directory, 'assets'),
            outputPath: join(directory, 'stage/inventory.js'),
            publicationPath: join(directory, 'inventory.js'),
        };
        const generated = await generateShikiGrammarAssets(options);
        await writeFile(options.publicationPath, await readFile(generated.outputPath));
        const result = await build({
            entryPoints: [options.publicationPath], bundle: true, format: 'cjs', write: false,
            plugins: [{ name: 'asset-filesystem-boundary', setup(plugin) {
                plugin.onLoad({ filter: /\.json\.bundle$/ }, ({ path }) => ({
                    contents: `module.exports = ${JSON.stringify(path)};`, loader: 'js',
                }));
            } }],
        });
        const module = { exports: {} };
        new Function('module', 'exports', result.outputFiles[0].text)(module, module.exports);
        const { SHIKI_LANGUAGE_ASSETS: inventory, SHIKI_LANGUAGE_INFO: info } = module.exports;
        assert.deepEqual(info, bundledLanguagesInfo.map(({ import: _load, ...metadata }) => metadata),
            'the complete installed metadata must survive independently from executable grammar imports');
        const runtime = await compileRegistry(options.publicationPath);
        const { registry } = runtime;
        assert.deepEqual(registry.i.map(({ import: _load, ...metadata }) => metadata), info);
        assert.deepEqual(Object.keys(registry.t).sort(), Object.keys(bundledLanguages).sort());
        assert.deepEqual(Object.keys(registry.r).sort(), bundledLanguagesInfo.map(info => info.id).sort());
        assert.deepEqual(Object.keys(registry.n).sort(), bundledLanguagesInfo.flatMap(info => info.aliases ?? []).sort());
        assert.deepEqual(Object.keys(inventory).sort(), Object.keys(bundledLanguages).sort());
        let registrationOccurrences = 0;
        for (const [id, load] of Object.entries(bundledLanguages)) {
            const { default: expected } = await load();
            const actual = await Promise.all(inventory[id].map(async path => JSON.parse(await readFile(path, 'utf8'))));
            assert.deepEqual(actual, expected, `${id} must retain its entire installed grammar closure`);
            assert.deepEqual((await registry.t[id]()).default, expected,
                `${id} must retain the upstream dynamic-import result shape for Pierre`);
            registrationOccurrences += expected.length;
        }
        const payloads = await Promise.all(generated.assetPaths.map(path => readFile(path, 'utf8')));
        assert.equal(new Set(payloads).size, generated.assetPaths.length);
        assert.ok(generated.assetPaths.length < registrationOccurrences, 'embedded grammars must be shared across languages and aliases');
        for (const metadata of registry.i) {
            for (const alias of metadata.aliases ?? []) assert.equal(registry.n[alias], registry.r[metadata.id]);
        }
        const themeName = 'happier-registry-delivery-test';
        runtime.registerCustomTheme(themeName, async () => ({
            name: themeName, type: 'dark', colors: { 'editor.background': '#000000', 'editor.foreground': '#ffffff' },
            tokenColors: [{ scope: 'keyword', settings: { foreground: '#ff0000' } }],
        }));
        const highlighter = await runtime.getSharedHighlighter({ themes: [themeName], langs: ['ts', 'vue', 'emacs-lisp'] });
        assert.ok(highlighter.codeToTokens('const value = 1;', { lang: 'ts', theme: themeName }).tokens[0]
            .some(token => token.content === '=' && token.color.toLowerCase() === '#ff0000'));
        const vue = '<script lang="ts">const value = 1;</script><template><div>{{ value }}</div></template>';
        assert.equal(highlighter.codeToTokens(vue, { lang: 'vue', theme: themeName }).tokens.flat().map(token => token.content).join(''), vue);
        assert.equal(highlighter.codeToTokens('(setq value 1)', { lang: 'emacs-lisp', theme: themeName }).tokens.flat().map(token => token.content).join(''), '(setq value 1)');
        const timestamp = new Date('2000-01-01T00:00:00Z');
        await utimes(generated.outputPath, timestamp, timestamp);
        await generateShikiGrammarAssets(options);
        assert.equal((await stat(generated.outputPath)).mtimeMs, timestamp.getTime(), 'unchanged preparation must not republish the inventory');
        console.log(JSON.stringify({ aliases: Object.keys(inventory).length, grammarAssets: payloads.length,
            registrationOccurrences, assetBytes: payloads.reduce((sum, payload) => sum + Buffer.byteLength(payload), 0) }));
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});
