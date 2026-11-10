// @happier-test-preparation source
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { generateShikiGrammarAssets } from './generateShikiGrammarAssets.mjs';

const require = createRequire(import.meta.url);
const uiRoot = fileURLToPath(new URL('..', import.meta.url));
const { resolveShikiGrammarRegistry } = require('./shikiGrammarRegistry.cjs');

test('native tokenization exports every packaged grammar without bundling grammar JavaScript', async () => {
    const scratch = await mkdtemp(join(tmpdir(), 'happier-shiki-native-metro-'));
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
            platform: 'ios', dev: true, minify: false, lazy: false,
        });
        const graph = [...server.getBundler().getDeltaBundler()._deltaCalculators.keys()].at(-1);
        const paths = [...graph.dependencies.keys()].map(path => path.replaceAll('\\', '/'));
        const grammarPaths = paths.filter(path => /\/node_modules\/@shikijs\/(?:langs|themes)\//.test(path));
        console.log(JSON.stringify({ platform: 'ios', modules: paths.length, bytes: Buffer.byteLength(result.code),
            grammarAssets: paths.filter(path => path.endsWith('.json.bundle')).length,
            grammarJavascriptModules: grammarPaths.length }));
        assert.equal(grammarPaths.length, 0, 'native must use the existing packaged grammar owner');
        assert.equal(paths.filter(path => path.endsWith('.json.bundle')).length, assetPaths.length);
        assert.ok(paths.some(path => /\/node_modules\/@shikijs\/core\//.test(path)));
        new Function(result.code);
    } finally {
        if (server) await server.end();
        await rm(scratch, { recursive: true, force: true });
    }
});

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
        const pierreOptions = { ...Server.DEFAULT_BUNDLE_OPTIONS,
            entryFile: join(uiRoot, 'sources/components/ui/code/diff/pierre/pierreWorkerPool.web.ts'),
            platform: 'web', dev: true, minify: false, lazy: false,
        };
        await server.end();
        const registryPath = resolveShikiGrammarRegistry(uiRoot);
        const resolveWithAssets = config.resolver.resolveRequest;
        server = new Server({ ...config, resolver: { ...config.resolver, resolveRequest(context, moduleName, platform) {
            if (platform === 'web' && context?.originModulePath && moduleName.startsWith('.')
                && resolve(dirname(context.originModulePath), moduleName) === registryPath) {
                return { type: 'sourceFile', filePath: registryPath };
            }
            return resolveWithAssets(context, moduleName, platform);
        } } }, { watch: false });
        const before = await server.build(pierreOptions);
        const beforeGraph = [...server.getBundler().getDeltaBundler()._deltaCalculators.keys()].at(-1);
        const beforePaths = [...beforeGraph.dependencies.keys()].map(path => path.replaceAll('\\', '/'));
        const beforeGrammars = beforePaths.filter(path => /\/node_modules\/@shikijs\/langs\//.test(path));
        assert.ok(beforeGrammars.length > 0, 'the matched upstream registry baseline must reproduce the grammar payload');
        console.log(JSON.stringify({ entry: 'pierreWorkerPool', registry: 'upstream', lazy: false,
            modules: beforePaths.length, bytes: Buffer.byteLength(before.code), grammarJavascriptModules: beforeGrammars.length }));
        await server.end();
        server = new Server(config, { watch: false });
        const pierre = await server.build(pierreOptions);
        const pierreGraph = [...server.getBundler().getDeltaBundler()._deltaCalculators.keys()].at(-1);
        const pierrePaths = [...pierreGraph.dependencies.keys()].map(path => path.replaceAll('\\', '/'));
        const grammarPaths = pierrePaths.filter(path => /\/node_modules\/@shikijs\/langs\//.test(path));
        console.log(JSON.stringify({ entry: 'pierreWorkerPool', registry: 'packaged-assets', lazy: false, modules: pierrePaths.length,
            bytes: Buffer.byteLength(pierre.code), grammarJavascriptModules: grammarPaths.length }));
        assert.equal(grammarPaths.length, 0, 'Pierre must consume the packaged grammar registry through upstream Shiki');
        assert.equal(pierrePaths.filter(path => path.endsWith('.json.bundle')).length, assetPaths.length);
        assert.ok(pierrePaths.some(path => path.endsWith('/shiki/dist/index.mjs')), 'upstream Shiki root remains the owner');
        assert.ok(pierrePaths.some(path => path.endsWith('/shiki/dist/bundle-full.mjs')), 'upstream singleton remains the owner');
        new Function(pierre.code);
    } finally {
        if (server) await server.end();
        await rm(scratch, { recursive: true, force: true });
    }
});
