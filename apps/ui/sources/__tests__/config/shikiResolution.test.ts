import assert from 'node:assert/strict';
import { readFileSync, realpathSync } from 'node:fs';
import { build } from 'esbuild';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'vitest';

const uiRoot = fileURLToPath(new URL('../../..', import.meta.url));

test('UI highlighting and Pierre bundle exactly one copy of each Shiki package', async () => {
    const result = await build({
        stdin: {
            contents: "export * as highlighting from 'shiki'; export * as diffs from '@pierre/diffs';",
            resolveDir: uiRoot,
        },
        absWorkingDir: uiRoot,
        bundle: true, format: 'esm', platform: 'browser',
        metafile: true, write: false, logLevel: 'silent',
    });
    const packages = new Map<string, Map<string, string>>();
    for (const input of Object.keys(result.metafile.inputs)) {
        const match = input.replaceAll('\\', '/').match(/^(.*node_modules\/(shiki|@shikijs\/[^/]+))\//);
        if (!match) continue;
        const root = realpathSync(path.resolve(uiRoot, match[1]!));
        const manifest: { name: string; version: string } = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
        const copies = packages.get(manifest.name) ?? new Map();
        copies.set(root, manifest.version);
        packages.set(manifest.name, copies);
    }
    assert.ok(packages.has('shiki'), 'the composed graph must include the real highlighter');
    assert.ok(packages.has('@shikijs/langs'), 'the composed graph must include real grammars');
    for (const [name, copies] of packages) {
        assert.equal(copies.size, 1, `${name} must have one physical copy in the UI graph: ${[...copies.values()].join(', ')}`);
    }
});
