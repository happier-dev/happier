import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

const require = createRequire(new URL('../../package.json', import.meta.url));
const { build } = require('esbuild');

test('markdown downloads KaTeX only on math demand and shares the real renderer', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'happier-math-delivery-'));
    try {
        const loader = require.resolve('react-native-enriched-markdown/lib/module/web/katex.js');
        const result = await build({
            entryPoints: [loader], outdir: directory, outExtension: { '.js': '.mjs' },
            bundle: true, splitting: true, format: 'esm', platform: 'node', metafile: true,
        });
        const [entryPath, entry] = Object.entries(result.metafile.outputs).find(([, output]) =>
            output.entryPoint && resolve(output.entryPoint) === loader);
        const staticInputs = new Set();
        const visit = (file) => {
            const output = result.metafile.outputs[file];
            for (const input of Object.keys(output.inputs)) staticInputs.add(input);
            for (const dependency of output.imports) {
                if (dependency.kind !== 'dynamic-import' && !dependency.external) visit(dependency.path);
            }
        };
        visit(entryPath);
        assert.deepEqual([...staticInputs].filter(file => /[\\/]katex[\\/]dist[\\/]/.test(file)), [],
            'non-math markdown must not download the math renderer');
        const { loadKaTeX } = await import(pathToFileURL(entryPath).href);
        const first = loadKaTeX();
        assert.equal(loadKaTeX(), first, 'concurrent math demand shares initialization');
        const renderer = await first;
        assert.equal(await loadKaTeX(), renderer);
        assert.match(renderer.renderToString('x^2', { output: 'mathml' }), /<msup>/);
        assert.throws(() => renderer.renderToString('\\unknownAuditCommand'), renderer.ParseError);
        console.log(JSON.stringify({ entryBytes: entry.bytes, chunks: Object.keys(result.metafile.outputs).length }));
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});
