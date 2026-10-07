import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { Script } from 'node:vm';
import test from 'node:test';

const uiRoot = fileURLToPath(new URL('..', import.meta.url));
const require = createRequire(path.join(uiRoot, 'package.json'));

test('web math consumers share one KaTeX implementation for import and require', async () => {
    const fixture = mkdtempSync(path.join(tmpdir(), 'happier-web-math-'));
    let server;
    try {
        const markdownLoader = require.resolve('react-native-enriched-markdown/lib/module/web/katex.js');
        writeFileSync(path.join(fixture, 'index.js'), `import katex from 'katex';
import { loadKaTeX } from ${JSON.stringify(markdownLoader)};
globalThis.mathResult = loadKaTeX().then(markdownKatex => ({ katex, markdownKatex }));`);
        delete require.cache[require.resolve(path.join(uiRoot, 'metro.config.js'))];
        const config = require(path.join(uiRoot, 'metro.config.js'));
        config.watchFolders = [...config.watchFolders, fixture];
        config.maxWorkers = 2;
        config.cacheStores = [new (require('metro-cache').FileStore)({ root: path.join(fixture, 'transforms') })];
        config.fileMapCacheDirectory = path.join(fixture, 'filemap');
        mkdirSync(config.fileMapCacheDirectory, { recursive: true });
        config.reporter = { update() {} };
        const Server = require('metro/private/Server').default;
        server = new Server(config, { watch: false });
        const result = await server.build({ ...Server.DEFAULT_BUNDLE_OPTIONS,
            entryFile: path.join(fixture, 'index.js'), platform: 'web', dev: true, minify: false, lazy: false,
        });
        const graph = [...server.getBundler().getDeltaBundler()._deltaCalculators.keys()].at(-1);
        const implementations = [...graph.dependencies.keys()].filter(file => /[\\/]katex[\\/]dist[\\/]katex\.(?:m?js)$/.test(file));
        console.log(JSON.stringify({ entry: 'math consumers', implementations, bytes: Buffer.byteLength(result.code) }));
        assert.equal(implementations.length, 1, 'the same math renderer must not be bundled twice as ESM and CommonJS');
        const sandbox = { console, setTimeout, clearTimeout };
        sandbox.global = sandbox;
        new Script(result.code).runInNewContext(sandbox);
        const { katex, markdownKatex } = await sandbox.mathResult;
        assert.equal(markdownKatex, katex, 'markdown and diagram math must share the real renderer');
        const rendered = markdownKatex.renderToString('x^2', { output: 'mathml' });
        assert.match(rendered, /<math/);
        assert.match(rendered, /<msup>/);
        assert.throws(() => katex.renderToString('\\unknownAuditCommand'), katex.ParseError);
    } finally {
        if (server) await server.end();
        rmSync(fixture, { recursive: true, force: true });
    }
});

test('language lookup and tokenization defer the highlighter runtime and themes', async () => {
    const cache = mkdtempSync(path.join(tmpdir(), 'happier-language-lookup-'));
    let server;
    try {
        delete require.cache[require.resolve(path.join(uiRoot, 'metro.config.js'))];
        const config = require(path.join(uiRoot, 'metro.config.js'));
        config.maxWorkers = 2;
        config.cacheStores = [new (require('metro-cache').FileStore)({ root: path.join(cache, 'transforms') })];
        config.fileMapCacheDirectory = path.join(cache, 'filemap');
        mkdirSync(config.fileMapCacheDirectory, { recursive: true });
        config.reporter = { update() {} };
        const Server = require('metro/private/Server').default;
        server = new Server(config, { watch: false });
        for (const entry of [
            'sources/components/ui/code/highlighting/resolveShikiLanguageId.ts',
            'sources/components/ui/code/highlighting/shiki/shikiTokenize.web.ts',
        ]) {
            const result = await server.build({ ...Server.DEFAULT_BUNDLE_OPTIONS,
                entryFile: path.join(uiRoot, entry), platform: 'web', dev: true, minify: false, lazy: true,
            });
            const graph = [...server.getBundler().getDeltaBundler()._deltaCalculators.keys()].at(-1);
            const paths = [...graph.dependencies.keys()].map(file => file.replaceAll('\\', '/'));
            console.log(JSON.stringify({ entry, modules: paths.length, bytes: Buffer.byteLength(result.code) }));
            assert.deepEqual(paths.filter(file => /\/node_modules\/(?:@shikijs\/(?:themes|core|engine-[^/]+)\/|shiki\/dist\/(?:themes|bundle-full)\.mjs$)/.test(file)), [],
                'the highlighter runtime must load only when tokenization is requested');
            assert.equal(paths.some(file => file.endsWith('/shiki/dist/langs.mjs')), true,
                'use the package-owned complete language and alias inventory');
        }
    } finally {
        if (server) await server.end();
        rmSync(cache, { recursive: true, force: true });
    }
});

test('optional web renderers stay outside their entry static closures', async () => {
    const cache = mkdtempSync(path.join(tmpdir(), 'happier-optional-renderers-'));
    let server;
    try {
        delete require.cache[require.resolve(path.join(uiRoot, 'metro.config.js'))];
        const config = require(path.join(uiRoot, 'metro.config.js'));
        config.maxWorkers = 2;
        config.cacheStores = [new (require('metro-cache').FileStore)({ root: path.join(cache, 'transforms') })];
        config.fileMapCacheDirectory = path.join(cache, 'filemap');
        mkdirSync(config.fileMapCacheDirectory, { recursive: true });
        config.reporter = { update() {} };
        const Server = require('metro/private/Server').default;
        server = new Server(config, { watch: false });
        const eagerlyLoaded = [];
        for (const [entry, packagePattern] of [
            ['sources/components/ui/markdown/editor/MarkdownEditor.web.tsx', /\/node_modules\/(?:@tiptap|prosemirror-[^/]+)\//],
            ['sources/components/ui/code/diff/DiffViewer.web.tsx', /\/node_modules\/@pierre\/diffs\//],
            ['sources/components/ui/code/diff/pierre/PierreScrollRootVirtualizerProvider.web.tsx', /\/node_modules\/@pierre\/diffs\//],
            ['sources/components/terminal/embedded/EmbeddedTerminalPane.web.tsx', /\/node_modules\/@xterm\//],
        ]) {
            const result = await server.build({ ...Server.DEFAULT_BUNDLE_OPTIONS,
                entryFile: path.join(uiRoot, entry), platform: 'web', dev: true, minify: false, lazy: true,
                customTransformOptions: { engine: 'hermes', routerRoot: './sources/app' },
                unstable_transformProfile: 'hermes-stable',
            });
            const graph = [...server.getBundler().getDeltaBundler()._deltaCalculators.keys()].at(-1);
            const paths = [...graph.dependencies.keys()].map(file => file.replaceAll('\\', '/'));
            const payloads = paths.filter(file => packagePattern.test(file));
            console.log(JSON.stringify({ entry, modules: paths.length, bytes: Buffer.byteLength(result.code), payloadCount: payloads.length }));
            if (payloads.length) eagerlyLoaded.push({ entry, payloads });
        }
        assert.deepEqual(eagerlyLoaded, [], 'optional engines must be admitted only on renderer demand');
    } finally {
        if (server) await server.end();
        rmSync(cache, { recursive: true, force: true });
    }
});

test('web development includes dynamic imports in one graph while native keeps lazy bundles', async () => {
    const fixture = mkdtempSync(path.join(tmpdir(), 'happier-web-single-graph-'));
    let server;
    try {
        writeFileSync(path.join(fixture, 'index.js'), 'globalThis.loadDetail = () => import("./detail");');
        writeFileSync(path.join(fixture, 'detail.js'), 'export const value = 42; export const bundleUrl = import.meta.url;');
        delete require.cache[require.resolve(path.join(uiRoot, 'metro.config.js'))];
        const config = require(path.join(uiRoot, 'metro.config.js'));
        const rewrite = config.server.rewriteRequestUrl;
        const entryUrl = '/index.bundle?platform=web&dev=true&lazy=true&hot=false';
        const rewritten = new URL(rewrite(entryUrl), 'http://localhost');
        assert.equal(rewritten.searchParams.get('lazy'), 'false',
            'web development must not retain a second transitive graph for each dynamic import');
        assert.equal(rewritten.searchParams.get('hot'), 'false');
        for (const unchanged of [
            '/index.bundle?platform=ios&dev=true&lazy=true',
            '/index.bundle?platform=android&dev=true&lazy=true',
            '/index.bundle?platform=web&dev=false&lazy=true',
            '/index.bundle?platform=web&dev=0&lazy=true',
            '/assets/icon.png?platform=web&dev=true&lazy=true',
        ]) assert.equal(rewrite(unchanged), unchanged);
        assert.equal(new URL(rewrite('http://localhost' + entryUrl), 'http://localhost').searchParams.get('lazy'), 'false');
        assert.equal(new URL(rewrite('/index.map?platform=web&dev=true&lazy=true'), 'http://localhost').searchParams.get('lazy'), 'false');
        assert.equal(new URL(rewrite('/index.bundle?platform=web&lazy=true'), 'http://localhost').searchParams.get('lazy'), 'false');
        config.watchFolders = [...config.watchFolders, fixture];
        config.maxWorkers = 2;
        config.cacheStores = [new (require('metro-cache').FileStore)({ root: path.join(fixture, 'transforms') })];
        config.fileMapCacheDirectory = path.join(fixture, 'filemap');
        mkdirSync(config.fileMapCacheDirectory, { recursive: true });
        config.reporter = { update() {} };
        const Server = require('metro/private/Server').default;
        server = new Server(config, { watch: false });
        const result = await server.build({ ...Server.DEFAULT_BUNDLE_OPTIONS,
            entryFile: path.join(fixture, 'index.js'), platform: 'web', dev: true, minify: false,
            lazy: rewritten.searchParams.get('lazy') === 'true',
        });
        const graphs = [...server.getBundler().getDeltaBundler()._deltaCalculators.keys()];
        assert.equal(graphs.length, 1);
        assert.equal(graphs[0].dependencies.has(path.join(fixture, 'detail.js')), true,
            'the dynamic module must already be in the initial graph');
        assert.equal(graphs[0].dependencies.get(path.join(fixture, 'detail.js')).output.some(
            (output) => output.data.map?.length > 0), true,
            'app dynamic-module source maps remain available for debugging');
        assert.equal(result.code.includes('detail.bundle?'), false,
            'dynamic import must resolve locally without requesting another lazy graph');
        assert.doesNotThrow(() => new Script(result.code),
            'the complete Metro script must parse even when a dynamic dependency uses import.meta');
    } finally {
        if (server) await server.end();
        rmSync(fixture, { recursive: true, force: true });
    }
});

test('sync consumers and lazy presence never pull the sync implementation into their Metro graph', async () => {
    const cache = mkdtempSync(path.join(tmpdir(), 'happier-sync-lazy-graph-'));
    let server;
    try {
        delete require.cache[require.resolve(path.join(uiRoot, 'metro.config.js'))];
        const config = require(path.join(uiRoot, 'metro.config.js'));
        config.maxWorkers = 2;
        config.cacheStores = [new (require('metro-cache').FileStore)({ root: path.join(cache, 'transforms') })];
        config.fileMapCacheDirectory = path.join(cache, 'filemap');
        mkdirSync(config.fileMapCacheDirectory, { recursive: true });
        config.reporter = { update() {} };
        const Server = require('metro/private/Server').default;
        server = new Server(config, { watch: false });
        for (const entry of [
            'sources/sync/domains/sessionHandoff/workspaceSyncStatusStore.ts',
            'sources/sync/runtime/getSyncSingleton.ts',
            'sources/sync/domains/session/humanPresence/sessionHumanPresenceRuntime.ts',
            'sources/voice/tools/currentUiContextToolPort.ts',
            'sources/components/appShell/workspace/workspaceRouteBodies.ts',
            'sources/components/onboarding/tour/stage/StageAppShell.tsx',
            'sources/app/(app)/settings/index.tsx',
        ]) {
            await server.build({
                ...Server.DEFAULT_BUNDLE_OPTIONS,
                entryFile: path.join(uiRoot, entry),
                platform: 'web', dev: true, minify: false, lazy: true,
                customTransformOptions: { engine: 'hermes', routerRoot: './sources/app' },
                unstable_transformProfile: 'hermes-stable',
            });
            const graph = [...server.getBundler().getDeltaBundler()._deltaCalculators.keys()].at(-1);
            const paths = [...graph.dependencies.keys()].map((file) => file.replaceAll('\\', '/'));
            console.log(JSON.stringify({ entry, modules: paths.length }));
            if (entry.includes('workspaceSyncStatusStore')) {
                assert.equal(paths.some((file) => file.endsWith('/sync/ops/actions/defaultActionExecutor.ts')), false,
                    'workspace status observation must not retain the command-only Action executor graph');
            }
            // Before the split, sync.ts itself contains the implementation. After
            // it, the public handle remains reachable but the implementation may not.
            const implementations = paths.filter((file) => /\/sources\/sync\/(?:syncEngine|sync)\.ts$/.test(file));
            assert.deepEqual(implementations.filter((file) => /class Sync\b/.test(readFileSync(file, 'utf8'))), [],
                `${entry} must use the public sync handle without retaining the implementation graph`);
            if (entry.includes('sessionHumanPresenceRuntime')) {
                assert.equal(paths.some((file) => /\/sources\/sync\/domains\/state\/storage(?:Store)?\.ts$/.test(file)), false,
                    'presence must read the registered local-state projection without loading the store/hooks graph');
            }
            if (entry.includes('voice/tools/currentUiContextToolPort')) {
                assert.equal(paths.some((file) => file.endsWith('/currentUiContext/CurrentUiContextProvider.tsx')), false,
                    'Voice admission binding must not load the AppShell presentation provider');
            }
            if (entry.includes('workspaceRouteBodies') || entry.includes('StageAppShell')) {
                assert.equal(paths.some((file) => /\/expo-router\/_ctx(?:\.[\w-]+)?\.js$/.test(file)), false,
                    'workspace body selection must use the registered Expo context without importing the app tree');
            }
        }
    } finally {
        if (server) await server.end();
        rmSync(cache, { recursive: true, force: true });
    }
});
