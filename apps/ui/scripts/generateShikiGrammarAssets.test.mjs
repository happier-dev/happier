// @happier-test-preparation source
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { build } from 'esbuild';
import { bundledLanguages } from 'shiki/langs';

import { generateShikiGrammarAssets } from './generateShikiGrammarAssets.mjs';

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
        const { SHIKI_LANGUAGE_ASSETS: inventory } = module.exports;
        assert.deepEqual(Object.keys(inventory).sort(), Object.keys(bundledLanguages).sort());
        let registrationOccurrences = 0;
        for (const [id, load] of Object.entries(bundledLanguages)) {
            const { default: expected } = await load();
            const actual = await Promise.all(inventory[id].map(async path => JSON.parse(await readFile(path, 'utf8'))));
            assert.deepEqual(actual, expected, `${id} must retain its entire installed grammar closure`);
            registrationOccurrences += expected.length;
        }
        const payloads = await Promise.all(generated.assetPaths.map(path => readFile(path, 'utf8')));
        assert.equal(new Set(payloads).size, generated.assetPaths.length);
        assert.ok(generated.assetPaths.length < registrationOccurrences, 'embedded grammars must be shared across languages and aliases');
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
