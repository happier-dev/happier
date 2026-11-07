// @happier-test-preparation source
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { generateShikiGrammarAssets } from './generateShikiGrammarAssets.mjs';

const require = createRequire(import.meta.url);
const uiRoot = fileURLToPath(new URL('..', import.meta.url));

test('the complete non-lazy web tokenization graph carries packaged grammar references without grammar or theme JavaScript', async () => {
    const scratch = await mkdtemp(join(tmpdir(), 'happier-shiki-metro-'));
    let server;
    try {
        const { assetPaths } = await generateShikiGrammarAssets({ uiPackageDir: uiRoot });
        const config = require('../metro.config.js');
        config.maxWorkers = 2;
        config.cacheStores = [new (require('metro-cache').FileStore)({ root: join(scratch, 'transforms') })];
        config.fileMapCacheDirectory = join(scratch, 'filemap');
        await mkdir(config.fileMapCacheDirectory, { recursive: true });
        config.reporter = { update() {} };
        const Server = require('metro/private/Server').default;
        server = new Server(config, { watch: false });
        const result = await server.build({ ...Server.DEFAULT_BUNDLE_OPTIONS,
            entryFile: join(uiRoot, 'sources/components/ui/code/highlighting/shiki/shikiTokenize.ts'),
            platform: 'web', dev: true, minify: false, lazy: false,
        });
        const graph = [...server.getBundler().getDeltaBundler()._deltaCalculators.keys()].at(-1);
        const paths = [...graph.dependencies.keys()].map(path => path.replaceAll('\\', '/'));
        assert.deepEqual(paths.filter(path => /\/node_modules\/@shikijs\/(?:langs|themes)\//.test(path)), []);
        assert.ok(paths.some(path => /\/node_modules\/@shikijs\/core\//.test(path)), 'the real highlighter core remains reachable');
        assert.equal(paths.filter(path => path.endsWith('.json.bundle')).length, assetPaths.length,
            'every supported grammar must remain an exported Expo asset');
        new Function(result.code);
        console.log(JSON.stringify({ lazy: false, modules: paths.length, bytes: Buffer.byteLength(result.code),
            grammarAssets: assetPaths.length, grammarJavascriptModules: 0, themeJavascriptModules: 0 }));
    } finally {
        if (server) await server.end();
        await rm(scratch, { recursive: true, force: true });
    }
});
