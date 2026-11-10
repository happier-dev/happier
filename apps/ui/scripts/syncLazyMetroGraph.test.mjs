// @happier-test-preparation source
// Builds authored UI entries with installed tooling; no workspace publication outputs are consumed.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { Script, createContext } from 'node:vm';
import { createServer } from 'node:http';
import test from 'node:test';

const uiRoot = fileURLToPath(new URL('..', import.meta.url));
const require = createRequire(path.join(uiRoot, 'package.json'));

test('New app starter gallery does not pull the whole protocol into the runtime bundle', async () => {
    const { build } = require('esbuild');
    const result = await build({
        entryPoints: [path.join(uiRoot, 'sources/components/projects/starters/NewAppScreen.tsx')],
        bundle: false, format: 'esm', platform: 'browser',
        outdir: path.join(tmpdir(), 'happier-new-app-graph'),
        metafile: true, write: false, logLevel: 'silent',
    });
    const imports = Object.values(result.metafile.outputs).flatMap(output => output.imports);
    assert.equal(imports.filter(item => item.path === '@happier-dev/protocol').length, 0,
        'the starter gallery needs its catalog, not every protocol schema and Action');
    assert.ok(imports.some(item => item.path === '@happier-dev/protocol/projects/starters/bundledProjectStartersV1'),
        'the real bundled starter catalog remains reachable');
});

test('compiled web clipboard hook starts its platform write in the gesture and honors cancellation', async () => {
    const { build } = require('esbuild');
    const result = await build({
        entryPoints: [path.join(uiRoot, 'sources/hooks/ui/useClipboardWrite.web.ts')],
        bundle: true, format: 'cjs', platform: 'browser', packages: 'external',
        write: false, metafile: true, logLevel: 'silent',
    });
    assert.deepEqual(Object.keys(result.metafile.inputs).filter(file =>
        /\/(?:components\/approvals|sync\/ops\/actions)\//.test(file)), []);
    const React = require('react');
    const { act, create } = require('react-test-renderer');
    const writes = [];
    // Browser and native clipboard modules are platform boundaries; all hook and effect code is real.
    const sandbox = {
        module: { exports: {} }, navigator: { clipboard: { writeText: async text => { writes.push(text); } } },
        require: name => name === 'react-native' ? { Platform: { OS: 'web' } }
            : name === 'expo-clipboard' ? {} : require(name),
        console,
    };
    sandbox.exports = sandbox.module.exports;
    new Script(result.outputFiles[0].text).runInNewContext(sandbox);
    const { useClipboardWrite } = sandbox.module.exports;
    let write;
    const Probe = () => { write = useClipboardWrite(); return null; };
    const previousActEnvironment = globalThis.IS_REACT_ACT_ENVIRONMENT;
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    let screen;
    try {
        await act(async () => { screen = create(React.createElement(Probe)); });
        const copied = write('compiled gesture');
        assert.deepEqual(writes, ['compiled gesture'], 'the browser write must start before the caller can await');
        assert.equal(await copied, true);
        const cancellation = new AbortController();
        cancellation.abort();
        assert.equal(await write('canceled gesture', { signal: cancellation.signal }), false);
        assert.deepEqual(writes, ['compiled gesture'], 'an already canceled copy has no platform effect');
    } finally {
        if (screen) await act(async () => screen.unmount());
        globalThis.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
    }
});

test('default Action factory keeps capture runtimes outside startup and preserves the compiled annotation import', async () => {
    const { build } = require('esbuild');
    const result = await build({
        entryPoints: [path.join(uiRoot, 'sources/sync/ops/actions/defaultActionExecutor.ts')],
        outdir: path.join(tmpdir(), 'happier-action-startup-graph'),
        bundle: true, splitting: true, format: 'esm', platform: 'browser', packages: 'external',
        resolveExtensions: ['.web.tsx', '.web.ts', '.web.js', '.tsx', '.ts', '.js', '.json'],
        loader: { '.png': 'file', '.jpg': 'file', '.jpeg': 'file', '.gif': 'file', '.webp': 'file',
            '.svg': 'file', '.ttf': 'file', '.otf': 'file', '.wav': 'file' },
        metafile: true, write: false, logLevel: 'silent',
    });
    const outputs = result.metafile.outputs;
    const entry = Object.keys(outputs).find(file => outputs[file].entryPoint?.endsWith('/defaultActionExecutor.ts'));
    assert.ok(entry, 'inspect the real default factory entry');
    const startupInputs = new Set();
    const visited = new Set();
    const visit = file => {
        if (visited.has(file)) return;
        visited.add(file);
        for (const input of Object.keys(outputs[file].inputs)) startupInputs.add(input.replaceAll('\\', '/'));
        for (const dependency of outputs[file].imports) {
            if (!dependency.external && dependency.kind !== 'dynamic-import') visit(dependency.path);
        }
    };
    visit(entry);
    const captureRuntimes = [...startupInputs].filter(file =>
        /\/sources\/(?:components\/screenCapture\/|desktop\/capture\/)/.test(`/${file}`)
        || /\/(?:mediaAnnotationActionRuntime|recordingActionRuntime|prepareRecordingDelivery|screenCaptureActions)\.ts$/.test(file));
    console.log(JSON.stringify({ entry: 'default Action factory', startupCaptureModules: captureRuntimes.length, captureRuntimes }));
    assert.deepEqual(captureRuntimes, [], 'before a capture or annotation Action, startup must evaluate zero capture runtimes');
    const annotation = Object.values(outputs).find(output => output.entryPoint?.endsWith('/mediaAnnotationActionRuntime.ts'));
    assert.ok(annotation?.exports.includes('executeMediaAnnotationAction'),
        'the compiled deferred module must retain the real Action callback export');
});

test('compiled machine directory utilities avoid the protocol root barrel', async () => {
    const { build } = require('esbuild');
    const { sourcePluginUiBuildOptions } = await import('../../../scripts/workspaces/sourcePluginUiBuildOptions.mjs');
    const sourceOptions = await sourcePluginUiBuildOptions({ repoRoot: path.resolve(uiRoot, '../..') });
    const result = await build({
        entryPoints: [path.join(uiRoot, 'sources/utils/sessions/machineDefaultDirectory.ts')],
        bundle: true, format: 'cjs', platform: 'browser', packages: 'external',
        write: false, metafile: true, logLevel: 'silent',
        plugins: [{ name: 'authored-workspace-source', setup(builder) {
            builder.onResolve({ filter: /^@happier-dev\// }, args => {
                const resolved = sourceOptions.resolveSourceImport(args.path);
                return resolved ? { path: resolved } : undefined;
            });
        } }],
    });
    const inputs = Object.keys(result.metafile.inputs).map(file => file.replaceAll('\\', '/'));
    const protocolInputs = inputs.filter(file => /(?:^|\/)packages\/protocol\/src\//.test(file));
    const rootBarrels = protocolInputs.filter(file => file.endsWith('/protocol/src/index.ts'));
    console.log(JSON.stringify({ entry: 'machine directory utilities', inputModules: inputs.length,
        protocolModules: protocolInputs.length, compiledBytes: result.outputFiles[0].contents.length, rootBarrels }));
    const externalProtocolImports = Object.values(result.metafile.inputs).flatMap(input =>
        input.imports.filter(dependency => dependency.external && dependency.path.startsWith('@happier-dev/protocol')));
    assert.deepEqual(externalProtocolImports, [], 'traverse protocol source instead of hiding it behind an external import');
    assert.deepEqual(rootBarrels, [], 'directory defaults must not traverse every unrelated protocol export');
});

test('base translation import synchronously loads only its initial locale bundle', async () => {
    const { build } = require('esbuild');
    const result = await build({
        entryPoints: [path.join(uiRoot, 'sources/text/i18n.ts')],
        outdir: path.join(tmpdir(), 'happier-i18n-static-graph'),
        bundle: true, splitting: true, format: 'esm', platform: 'node',
        metafile: true, write: false,
    });
    const outputs = result.metafile.outputs;
    const entry = Object.keys(outputs).find(file => outputs[file].entryPoint?.endsWith('/i18n.ts'));
    assert.ok(entry);
    const inputs = new Set();
    const visited = new Set();
    const visit = file => {
        if (visited.has(file)) return;
        visited.add(file);
        for (const input of Object.keys(outputs[file].inputs)) inputs.add(input);
        for (const dependency of outputs[file].imports) {
            if (!dependency.external && dependency.kind !== 'dynamic-import') visit(dependency.path);
        }
    };
    visit(entry);
    const locales = [...inputs].filter(file => /\/text\/translations\/(?:ca|de|en|es|fr|it|ja|pl|pt|ru|zh-Hans|zh-Hant)\.ts$/.test(file));
    console.log(JSON.stringify({ entry: 'base translation import', staticModules: inputs.size, synchronousLocales: locales }));
    assert.deepEqual(locales.map(file => path.basename(file)).sort(), ['en.ts'],
        'importing i18n must not evaluate every unselected locale before settings readiness');
    assert.deepEqual([...inputs].filter(file => file.endsWith('/bundledPluginTranslations.generated.ts')), [],
        'the aggregate plugin translation payload must not enter the initial locale graph');
});

for (const platform of ['ios', 'web']) test(`${platform} development translation assets keep unselected locales outside the single Metro graph`, async () => {
    const fixture = mkdtempSync(path.join(tmpdir(), 'happier-locale-dev-assets-'));
    let server;
    try {
        const { prepareLocaleAssets } = await import('./prepareLocaleAssets.mjs');
        const { assetPaths } = await prepareLocaleAssets({ uiPackageDir: uiRoot });
        writeFileSync(path.join(fixture, 'index.js'), `import * as text from ${JSON.stringify(path.join(uiRoot, 'sources/text/i18n.ts'))};\nglobalThis.localeText = text;`);
        delete require.cache[require.resolve(path.join(uiRoot, 'metro.config.js'))];
        const config = require(path.join(uiRoot, 'metro.config.js'));
        config.watchFolders = [...config.watchFolders, fixture];
        config.maxWorkers = 2;
        config.cacheStores = [new (require('metro-cache').FileStore)({ root: path.join(fixture, 'transforms') })];
        config.fileMapCacheDirectory = path.join(fixture, 'filemap');
        mkdirSync(config.fileMapCacheDirectory, { recursive: true });
        config.reporter = { update() {} };
        let modulePaths;
        let transformedBytes;
        config.serializer.customSerializer = async (_entry, _prepend, graph) => {
            modulePaths = [...graph.dependencies.keys()].map(file => file.replaceAll('\\', '/'));
            transformedBytes = [...graph.dependencies.values()].reduce((total, module) => total + module.output
                .filter(output => output.type.startsWith('js/'))
                .reduce((bytes, output) => bytes + Buffer.byteLength(output.data.code), 0), 0);
            return { code: '', map: '{}' };
        };
        const Server = require('metro/private/Server').default;
        server = new Server(config, { watch: false });
        await server.build({ ...Server.DEFAULT_BUNDLE_OPTIONS,
            entryFile: path.join(fixture, 'index.js'), platform, dev: true, minify: false, lazy: false,
        });
        const unselected = modulePaths.filter(file =>
            /\/text\/(?:translations\/(?:features\/)?(?:ca|de|es|fr|it|ja|pl|pt|ru|zh-Hans|zh-Hant)(?:Overrides)?\.ts|bundledPluginTranslations\/(?:ca|de|es|fr|it|ja|pl|pt|ru|zh-Hans|zh-Hant)\.generated\.ts)$/.test(file));
        const after = { modules: modulePaths.length, transformedBytes };
        assert.deepEqual(unselected, [], 'single-graph development must deliver only English fallback until a locale is requested');
        assert.ok(modulePaths.some(file => file.endsWith('/text/translations/en.ts')), 'English fallback remains synchronous');
        assert.equal(modulePaths.filter(file => file.endsWith('.locale.bundle')).length, assetPaths.length,
            'all supported non-English locales remain packaged assets');
        console.log(JSON.stringify({ entry: 'single-graph development translations', platform, after, unselected }));
    } finally {
        if (server) await server.end();
        rmSync(fixture, { recursive: true, force: true });
    }
});

for (const platform of ['ios', 'web']) test(`compiled ${platform} locale demand preserves formatters, coalesces reads and retries an unavailable asset`, async () => {
    const { prepareLocaleAssets } = await import('./prepareLocaleAssets.mjs');
    await prepareLocaleAssets({ uiPackageDir: uiRoot });
    const { build } = require('esbuild');
    const result = await build({
        stdin: { contents: "export * from './sources/text/localeBundlesSync';", resolveDir: uiRoot },
        bundle: true, format: 'cjs', platform: 'browser', packages: 'external', write: false,
        supported: { 'dynamic-import': false },
        resolveExtensions: [platform === 'web' ? '.web.ts' : '.native.ts', '.ts', '.js'],
        plugins: [{ name: 'expo-asset-registry-boundary', setup(builder) {
            builder.onLoad({ filter: /\.locale\.bundle$/ }, args => ({
                contents: `module.exports = ${JSON.stringify(args.path)};`, loader: 'js',
            }));
        } }],
    });
    const reads = [];
    let unavailable = false;
    const sandbox = {
        module: { exports: {} }, TextEncoder, TextDecoder, Uint8Array, console,
        require: name => name === 'expo-asset' ? { Asset: { fromModule: uri => ({
            uri, localUri: platform === 'ios' ? `file://${uri}` : undefined, downloadAsync: async () => {},
        }) } } : name === 'expo-file-system' ? { File: class {
            constructor(uri) { this.path = fileURLToPath(uri); }
            get exists() { return !unavailable; }
            async bytes() { reads.push(this.path); return readFileSync(this.path); }
        } } : require(name),
        fetch: async uri => {
            reads.push(uri);
            return unavailable ? { ok: false } : new Response(readFileSync(uri));
        },
    };
    sandbox.exports = sandbox.module.exports;
    new Script(result.outputFiles[0].text).runInNewContext(sandbox);
    const loader = sandbox.module.exports;
    assert.equal(loader.readLocaleBundle('en').host.common.submit, 'Submit');
    assert.equal(reads.length, 0, 'English boot must not read any optional locale assets');
    assert.ok(loader.readLocaleBundle('es') === undefined, 'unselected copy is acquired at the existing preload boundary');
    const spanish = loader.preloadLocaleBundle('es');
    assert.equal(loader.preloadLocaleBundle('es'), spanish, 'concurrent demand shares the existing locale owner');
    await spanish;
    const host = loader.readLocaleBundle('es').host;
    assert.equal(host.common.submit, 'Enviar');
    const find = node => {
        for (const [key, value] of Object.entries(node)) {
            if (key === 'mcpServersStatusDetected') return value;
            if (value && typeof value === 'object') { const result = find(value); if (result) return result; }
        }
    };
    const formatter = find(host);
    assert.equal(typeof formatter, 'function', 'executable translation assets must preserve callable formatting');
    assert.ok(formatter({ provider: 'locale-format-control' }).includes('locale-format-control'));
    await loader.preloadLocaleBundle('es');
    assert.equal(reads.length, 1, 'settled locale demand does not reread its asset');
    unavailable = true;
    await assert.rejects(loader.preloadLocaleBundle('fr'), /Translation asset unavailable: fr/);
    assert.equal(loader.readLocaleBundle('fr'), undefined, 'failed copy never replaces a usable locale');
    unavailable = false;
    await loader.preloadLocaleBundle('fr');
    assert.equal(typeof loader.readLocaleBundle('fr').host.common.submit, 'string');
    assert.equal(reads.length, 3, 'a failed demand remains retryable without an automatic retry loop');
    await loader.preloadLocaleBundle('zh-Hant');
    const traditionalInbox = loader.readLocaleBundle('zh-Hant').host.tabs.inbox;
    assert.equal(typeof traditionalInbox, 'string');
    assert.ok(readFileSync(reads.at(-1), 'utf8').includes(traditionalInbox),
        'executable locale assets must retain UTF-8 copy without expanding each character into an escape');
});

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

test('language lookup and tokenization defer the highlighter runtime, grammars and themes', async () => {
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
            'sources/components/ui/code/highlighting/shiki/shikiTokenize.ts',
        ]) {
            const result = await server.build({ ...Server.DEFAULT_BUNDLE_OPTIONS,
                entryFile: path.join(uiRoot, entry), platform: 'web', dev: true, minify: false, lazy: true,
            });
            const graph = [...server.getBundler().getDeltaBundler()._deltaCalculators.keys()].at(-1);
            const paths = [...graph.dependencies.keys()].map(file => file.replaceAll('\\', '/'));
            console.log(JSON.stringify({ entry, modules: paths.length, bytes: Buffer.byteLength(result.code) }));
            assert.deepEqual(paths.filter(file => /\/node_modules\/(?:@shikijs\/(?:themes|core|engine-[^/]+)\/|shiki\/dist\/(?:themes|bundle-full)\.mjs$)/.test(file)), [],
                'the highlighter runtime must load only when tokenization is requested');
            assert.deepEqual(paths.filter(file => /\/node_modules\/(?:@shikijs\/langs\/|shiki\/dist\/langs\.mjs$)/.test(file)), [],
                'synchronous language recognition must carry ids only, without grammar import edges');
        }
    } finally {
        if (server) await server.end();
        rmSync(cache, { recursive: true, force: true });
    }
});

test('web translation lookup keeps unselected locales outside required production chunks', async () => {
    const fixture = mkdtempSync(path.join(tmpdir(), 'happier-locale-chunks-'));
    let server;
    try {
        const { prepareLocaleAssets } = await import('./prepareLocaleAssets.mjs');
        await prepareLocaleAssets({ uiPackageDir: uiRoot });
        writeFileSync(path.join(fixture, 'index.js'), `import * as text from ${JSON.stringify(path.join(uiRoot, 'sources/text/i18n.ts'))};
globalThis.text = text;`);
        delete require.cache[require.resolve(path.join(uiRoot, 'metro.config.js'))];
        const config = require(path.join(uiRoot, 'metro.config.js'));
        config.watchFolders = [...config.watchFolders, fixture];
        config.maxWorkers = 2;
        config.cacheStores = [new (require('metro-cache').FileStore)({ root: path.join(fixture, 'transforms') })];
        config.fileMapCacheDirectory = path.join(fixture, 'filemap');
        mkdirSync(config.fileMapCacheDirectory, { recursive: true });
        config.reporter = { update() {} };
        const originalSerializer = config.serializer.customSerializer;
        let artifacts;
        config.serializer.customSerializer = async (entry, prepend, graph, options) => {
            const result = await originalSerializer(entry, prepend, graph, {
                ...options,
                serializerOptions: { output: 'static', splitChunks: true, exporting: true, includeSourceMaps: false },
            });
            artifacts = (typeof result === 'string' ? JSON.parse(result) : result).artifacts;
            return { code: '', map: '{}' };
        };
        const Server = require('metro/private/Server').default;
        server = new Server(config, { watch: false });
        await server.build({ ...Server.DEFAULT_BUNDLE_OPTIONS,
            entryFile: path.join(fixture, 'index.js'), platform: 'web', dev: false, minify: true, lazy: false,
        });
        const javascript = artifacts.filter(artifact => artifact.type === 'js');
        const required = javascript.filter(artifact => artifact.metadata.isAsync !== true);
        const paths = required.flatMap(artifact => artifact.metadata.modulePaths.map(file => file.replaceAll('\\', '/')));
        const unselected = paths.filter(file =>
            /\/text\/(?:translations\/(?:features\/)?(?:[^/]*\.)?(?:ca|de|es|fr|it|ja|pl|pt|ru|zh-Hans|zh-Hant)(?:Overrides)?\.ts|bundledPluginTranslations\/(?:ca|de|es|fr|it|ja|pl|pt|ru|zh-Hans|zh-Hant)\.generated\.ts|bundledPluginTranslations\.generated\.ts)$/.test(file));
        console.log(JSON.stringify({ entry: 'translation lookup', requiredChunks: required.map(artifact => ({
            file: artifact.filename, bytes: Buffer.byteLength(artifact.source),
        })), unselected }));
        assert.deepEqual(unselected, [], 'startup must not download unselected host or aggregate plugin locales');
        assert.ok(paths.some(file => file.endsWith('/text/translations/en.ts')), 'English fallback remains synchronous');
        assert.ok(paths.some(file => file.endsWith('.locale.bundle')),
            'approved active-locale delivery retains Expo asset references for selected-language demand');
    } finally {
        if (server) await server.end();
        rmSync(fixture, { recursive: true, force: true });
    }
});

test('web markdown consumers keep their shared engine outside required production chunks', async () => {
    const fixture = mkdtempSync(path.join(tmpdir(), 'happier-markdown-chunks-'));
    let server;
    try {
        const preparation = await import('./ensureWorkspacePackagesBuilt.mjs');
        if (!(await preparation.hasUsableUiWorkspaceLastGreen({ uiPackageDir: uiRoot }))) {
            await preparation.ensureUiWorkspacePackagesBuilt({ uiPackageDir: uiRoot });
        }
        writeFileSync(path.join(fixture, 'index.js'), `import { MarkdownEditor } from ${JSON.stringify(path.join(uiRoot, 'sources/components/ui/markdown/editor/MarkdownEditor.web.tsx'))};
import { useRichEligibility } from ${JSON.stringify(path.join(uiRoot, 'sources/components/ui/markdown/editor/core/eligibility/richEligibility.web.ts'))};
globalThis.markdownConsumers = [MarkdownEditor, useRichEligibility];`);
        delete require.cache[require.resolve(path.join(uiRoot, 'metro.config.js'))];
        const config = require(path.join(uiRoot, 'metro.config.js'));
        config.watchFolders = [...config.watchFolders, fixture];
        config.maxWorkers = 2;
        config.cacheStores = [new (require('metro-cache').FileStore)({ root: path.join(fixture, 'transforms') })];
        config.fileMapCacheDirectory = path.join(fixture, 'filemap');
        mkdirSync(config.fileMapCacheDirectory, { recursive: true });
        config.reporter = { update() {} };
        const originalSerializer = config.serializer.customSerializer;
        let artifacts;
        config.serializer.customSerializer = async (entry, prepend, graph, options) => {
            const result = await originalSerializer(entry, prepend, graph, {
                ...options,
                serializerOptions: { output: 'static', splitChunks: true, exporting: true, includeSourceMaps: false },
            });
            artifacts = (typeof result === 'string' ? JSON.parse(result) : result).artifacts;
            return { code: '', map: '{}' };
        };
        const Server = require('metro/private/Server').default;
        server = new Server(config, { watch: false });
        await server.build({ ...Server.DEFAULT_BUNDLE_OPTIONS,
            entryFile: path.join(fixture, 'index.js'), platform: 'web', dev: false, minify: false, lazy: false,
            customTransformOptions: { engine: 'hermes', routerRoot: './sources/app' },
            unstable_transformProfile: 'hermes-stable',
        });
        assert.ok(Array.isArray(artifacts), 'inspect the actual production serializer artifacts');
        const javascript = artifacts.filter((artifact) => artifact.type === 'js');
        const required = javascript.filter((artifact) => artifact.metadata.isAsync !== true);
        const engines = (artifact) => artifact.metadata.modulePaths.filter((file) =>
            /\/node_modules\/(?:@tiptap|prosemirror-[^/]+)\//.test(file.replaceAll('\\', '/')));
        assert.ok(required.length > 0, 'the real entry chunk must be serialized');
        assert.ok(javascript.some((artifact) => artifact.metadata.isAsync === true && engines(artifact).length > 0),
            'the demanded engine must remain present in an async chunk');
        const eager = required.flatMap((artifact) => engines(artifact));
        console.log(JSON.stringify({ entry: 'markdown surface and HTML eligibility',
            requiredChunks: required.map((artifact) => ({ file: artifact.filename, bytes: Buffer.byteLength(artifact.source) })),
            eagerEngineModules: eager.length }));
        assert.deepEqual(eager, [], 'two demand consumers must not hoist their shared engine into required startup chunks');
    } finally {
        if (server) await server.end();
        rmSync(fixture, { recursive: true, force: true });
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

test('stale web lazy chunks share the canonical root entry without executing it', () => {
    delete require.cache[require.resolve(path.join(uiRoot, 'metro.config.js'))];
    const config = require(path.join(uiRoot, 'metro.config.js'));
    const rewrite = config.server.rewriteRequestUrl;
    const root = new URL(rewrite('/.expo/.virtual-metro-entry.bundle?platform=web&dev=true&lazy=true'), 'http://localhost');
    const overridden = new URL(rewrite('/other.bundle?platform=web&dev=true&lazy=true&bundleEntry=obsolete'), 'http://localhost');
    assert.equal(overridden.searchParams.has('bundleEntry'), false, 'the query must not override the canonical root entry');
    for (const entry of ['defaultActionExecutor', 'sessionFollowApi', 'actionAccountContext']) {
        const chunk = new URL(rewrite(`/apps/ui/sources/${entry}.bundle?platform=web&dev=true&lazy=true&modulesOnly=true&runModule=false`), 'http://localhost');
        assert.equal(chunk.pathname, root.pathname, 'stale chunks must reuse the app entry graph');
        assert.equal(chunk.searchParams.get('lazy'), 'false');
        assert.equal(chunk.searchParams.get('modulesOnly'), 'true', 'a chunk response must not reinstall the runtime');
        assert.equal(chunk.searchParams.get('runModule'), 'false', 'a chunk response must not remount the app');
    }
});

test('three stale web chunk requests and a warm root reuse one real Metro graph', async () => {
    const fixture = mkdtempSync(path.join(tmpdir(), 'happier-web-shared-root-'));
    let metro;
    let http;
    try {
        delete require.cache[require.resolve(path.join(uiRoot, 'metro.config.js'))];
        const config = require(path.join(uiRoot, 'metro.config.js'));
        const canonical = new URL(config.server.rewriteRequestUrl('/.expo/.virtual-metro-entry.bundle?platform=web&dev=true'), 'http://localhost').pathname;
        const entry = path.join(fixture, canonical.slice(1).replace(/\.bundle$/, '.js'));
        mkdirSync(path.dirname(entry), { recursive: true });
        writeFileSync(entry, `globalThis.appStarts = (globalThis.appStarts || 0) + 1;
            globalThis.loadA = () => import('./a'); globalThis.loadB = () => import('./b'); globalThis.loadC = () => import('./c');`);
        writeFileSync(path.join(path.dirname(entry), 'shared.js'), 'export const shared = "shared-value";');
        for (const name of ['a', 'b', 'c']) writeFileSync(path.join(path.dirname(entry), `${name}.js`),
            `import { shared } from './shared'; export const value = ${JSON.stringify(name)} + shared;`);
        config.projectRoot = fixture;
        config.server.unstable_serverRoot = fixture;
        config.watchFolders = [...config.watchFolders, fixture];
        config.maxWorkers = 2;
        config.cacheStores = [new (require('metro-cache').FileStore)({ root: path.join(fixture, 'transforms') })];
        config.fileMapCacheDirectory = path.join(fixture, 'filemap');
        mkdirSync(config.fileMapCacheDirectory, { recursive: true });
        config.reporter = { update() {} };
        config.serializer.getModulesRunBeforeMainModule = () => [];
        const Server = require('metro/private/Server').default;
        metro = new Server(config, { watch: false });
        http = createServer((request, response) => metro.processRequest(request, response, error => {
            response.statusCode = error ? 500 : 404;
            response.end(error ? String(error.message) : 'Not found');
        }));
        await new Promise(resolve => http.listen(0, '127.0.0.1', resolve));
        const base = `http://127.0.0.1:${http.address().port}`;
        const query = '?platform=web&dev=true&lazy=true&hot=false';
        const initial = await fetch(base + canonical + query);
        assert.equal(initial.status, 200);
        const context = createContext({ console, setTimeout, clearTimeout });
        new Script(await initial.text()).runInContext(context);
        assert.equal(context.appStarts, 1);
        const start = performance.now();
        const responses = await Promise.all([
            fetch(base + canonical + query),
            ...['a', 'b', 'c'].map(name => fetch(`${base}/obsolete/${name}.bundle${query}&modulesOnly=true&runModule=false`)),
        ]);
        const bodies = await Promise.all(responses.map(async response => {
            assert.equal(response.status, 200);
            return response.text();
        }));
        const graphs = [...metro.getBundler().getDeltaBundler()._deltaCalculators.keys()];
        assert.equal(graphs.length, 1, 'stale dependency entry paths must not retain overlapping graphs');
        for (const body of bodies.slice(1)) new Script(body).runInContext(context);
        assert.equal(context.appStarts, 1, 'module-only responses must not execute the app entry again');
        for (const [name, load] of [['a', context.loadA], ['b', context.loadB], ['c', context.loadC]]) {
            assert.equal((await load()).value, `${name}shared-value`, 'demand imports retain their real exports');
        }
        console.log(JSON.stringify({ entry: 'warm root plus three stale chunks', graphs: graphs.length,
            milliseconds: performance.now() - start, responseBytes: bodies.map(body => Buffer.byteLength(body)) }));
    } finally {
        if (http) await new Promise((resolve, reject) => http.close(error => error ? reject(error) : resolve()));
        if (metro) await metro.end();
        rmSync(fixture, { recursive: true, force: true });
    }
});

test('development includes dynamic imports in one graph on web and native', async () => {
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
        for (const platform of ['ios', 'android']) {
            assert.equal(new URL(rewrite(`/index.bundle?platform=${platform}&dev=true&lazy=true`), 'http://localhost').searchParams.get('lazy'), 'false',
                'native development must not retain another overlapping graph for each dynamic import');
        }
        for (const unchanged of [
            '/index.bundle?platform=ios&dev=false&lazy=true',
            '/index.bundle?platform=android&dev=0&lazy=true',
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
        for (const [platformIndex, platform] of ['web', 'ios', 'android'].entries()) {
            const request = new URL(rewrite(`/index.bundle?platform=${platform}&dev=true&lazy=true`), 'http://localhost');
            const result = await server.build({ ...Server.DEFAULT_BUNDLE_OPTIONS,
                entryFile: path.join(fixture, 'index.js'), platform, dev: true, minify: false,
                ...(platform === 'web' ? {} : {
                    customTransformOptions: { engine: 'hermes', bytecode: '1' },
                    unstable_transformProfile: 'hermes-stable',
                }),
                lazy: request.searchParams.get('lazy') === 'true',
                sourceUrl: request.toString(),
            });
            const graphs = [...server.getBundler().getDeltaBundler()._deltaCalculators.keys()];
            assert.equal(graphs.length, platformIndex + 1);
            const graph = graphs.at(-1);
            assert.equal(graph.dependencies.has(path.join(fixture, 'detail.js')), true,
                'development includes the dynamic module in the shared graph');
            assert.equal(JSON.parse(result.map).sources.includes(path.join(fixture, 'detail.js')), true,
                'source maps follow the modules actually delivered in this response');
            assert.equal(result.code.includes('detail.bundle?'), false,
                'dynamic imports resolve locally without another entry graph');
            assert.doesNotThrow(() => new Script(result.code),
                'the complete Metro script must parse even when a dynamic dependency uses import.meta');
        }
    } finally {
        if (server) await server.end();
        rmSync(fixture, { recursive: true, force: true });
    }
});

test('local settings parsing does not load folder mutations or the plugin UI contribution catalog', async () => {
    const cache = mkdtempSync(path.join(tmpdir(), 'happier-local-settings-graph-'));
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
        const entry = 'sources/sync/domains/settings/localSettings.ts';
        await server.build({ ...Server.DEFAULT_BUNDLE_OPTIONS,
            entryFile: path.join(uiRoot, entry), platform: 'web', dev: true, minify: false, lazy: true,
        });
        const graph = [...server.getBundler().getDeltaBundler()._deltaCalculators.keys()].at(-1);
        const paths = [...graph.dependencies.keys()].map(file => file.replaceAll('\\', '/'));
        const unrelated = paths.filter(file =>
            /\/sync\/domains\/session\/folders\/(?:mutations|sessionListFolders|tree)\.ts$/.test(file)
            || /\/plugins\/contributions\/ui\/v2\.(?:ts|js)$/.test(file));
        console.log(JSON.stringify({ entry, modules: paths.length, unrelated }));
        assert.deepEqual(unrelated, [], 'device settings must use their canonical schema owners without evaluating unrelated catalogs');
    } finally {
        if (server) await server.end();
        rmSync(cache, { recursive: true, force: true });
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
