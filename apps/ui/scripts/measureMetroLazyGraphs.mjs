import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';

const root = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(path.join(root, 'package.json'));
const cli = path.dirname(require.resolve('@expo/cli/package.json'));
const { loadMetroConfigAsync } = require(path.join(cli, 'build/src/start/server/metro/instantiateMetro.js'));
const { getConfig } = require('@expo/config');
const Server = require('metro/private/Server').default;
const mode = process.argv[2] ?? 'lazy';
if (!['lazy', 'single', 'rebuild-lazy', 'rebuild-single'].includes(mode)) {
    throw new Error('Expected lazy|single|rebuild-lazy|rebuild-single');
}
const cache = path.join(os.tmpdir(), 'happier-metro-lazy-measure-20261005');
let server;
let rebuildFixture;
const log = (value) => process.stdout.write(JSON.stringify({ at: new Date().toISOString(), mode, ...value }) + '\n');
function stats() {
    global.gc?.();
    const graphs = [...server.getBundler().getDeltaBundler()._deltaCalculators.keys()];
    return { memory: process.memoryUsage(), graphs: graphs.length, modules: graphs.reduce((n, g) => n + g.dependencies.size, 0) };
}
function pathsTo(graph) {
    const targets = ['/sync/domains/state/storage.ts', '/sync/syncEngine.ts', '/text/index.ts', '/expo-router/_ctx', '/agents/registry/', '/providers/'];
    const queue = [...graph.entryPoints].map(p => [p]);
    const seen = new Set(graph.entryPoints);
    const found = {};
    for (let i = 0; i < queue.length; i++) {
        const chain = queue[i];
        const file = chain.at(-1);
        for (const target of targets) if (!found[target] && file.includes(target)) found[target] = chain.map(p => path.relative(root, p));
        for (const dependency of graph.dependencies.get(file)?.dependencies.values() ?? []) {
            const next = dependency.absolutePath;
            if (graph.dependencies.has(next) && !seen.has(next)) { seen.add(next); queue.push([...chain, next]); }
        }
    }
    return found;
}

try {
    log({ phase: 'identity', host: os.hostname(), node: process.version, pid: process.pid, cwd: process.cwd(), metro: require('metro/package.json').version });
    const { config } = await loadMetroConfigAsync(root, { maxWorkers: 2, resetCache: false }, {
        exp: getConfig(root).exp, isExporting: false, getMetroBundler: () => server.getBundler().getBundler(),
    });
    config.cacheStores = [new (require('metro-cache').FileStore)({ root: path.join(cache, 'transforms') })];
    config.fileMapCacheDirectory = path.join(cache, 'filemap');
    mkdirSync(config.fileMapCacheDirectory, { recursive: true });
    config.reporter = { update(event) { if (event.type === 'bundling_error') log({ phase: 'error', error: String(event.error) }); } };
    const rebuilding = mode.startsWith('rebuild-');
    let rebuildEntry;
    if (rebuilding) {
        rebuildFixture = mkdtempSync(path.join(cache, 'rebuild-'));
        rebuildEntry = path.join(rebuildFixture, 'index.js');
        writeFileSync(rebuildEntry, `import ${JSON.stringify(path.join(root, 'index.ts'))}; globalThis.__happierMetroMeasureRevision = "before";`);
        config.watchFolders = [...config.watchFolders, rebuildFixture];
    }
    server = new Server(config, { watch: rebuilding });
    const entries = ['index.ts',
        'sources/sync/api/account/apiAccountEncryptionMode.ts',
        'sources/sync/domains/session/humanPresence/sessionHumanPresenceRuntime.ts',
        'sources/sync/runtime/getSyncSingleton.ts',
        'sources/components/sessions/shell/SessionDestinationBody.tsx',
        'sources/components/appShell/workspace/workspaceRouteBodies.ts',
        'sources/app/(app)/settings/index.tsx'];
    let main;
    for (const entry of rebuilding ? [rebuildEntry] : mode === 'single' ? entries.slice(0, 1) : entries) {
        log({ phase: 'building', entry });
        const start = performance.now();
        const options = { ...Server.DEFAULT_BUNDLE_OPTIONS,
            entryFile: path.resolve(root, entry), platform: 'web', dev: true, minify: false, lazy: !mode.endsWith('single'),
            customTransformOptions: { engine: 'hermes', routerRoot: './sources/app' }, unstable_transformProfile: 'hermes-stable',
        };
        let result = await server.build(options);
        const bundleBytes = result.code.length;
        result = null;
        const graph = [...server.getBundler().getDeltaBundler()._deltaCalculators.keys()].at(-1);
        if (!main) main = new Set(graph.dependencies.keys());
        const modules = [...graph.dependencies.values()];
        log({ phase: 'built', entry, ms: performance.now() - start, bundleBytes, graphModules: graph.dependencies.size,
            overlap: modules.filter(m => main.has(m.path)).length,
            mapEntries: modules.reduce((n, m) => n + m.output.reduce((a, o) => a + (o.data.map?.length ?? 0), 0), 0),
            vendorMapEntries: modules.filter(m => m.path.includes('/node_modules/')).reduce((n, m) => n + m.output.reduce((a, o) => a + (o.data.map?.length ?? 0), 0), 0),
            paths: pathsTo(graph), ...stats() });
        if (rebuilding) {
            const watcher = server.getBundler().getBundler().getWatcher();
            const changed = new Promise(resolve => {
                const onChange = event => {
                    if (!event.eventsQueue.some(change => change.filePath === rebuildEntry)) return;
                    watcher.removeListener('change', onChange);
                    resolve();
                };
                watcher.on('change', onChange);
            });
            const editAt = performance.now();
            writeFileSync(rebuildEntry, `import ${JSON.stringify(path.join(root, 'index.ts'))}; globalThis.__happierMetroMeasureRevision = "after";`);
            await changed;
            const rebuildAt = performance.now();
            result = await server.build(options);
            if (!result.code.includes('__happierMetroMeasureRevision = "after"')) throw new Error('Rebuild did not consume edited fixture');
            result = null;
            log({ phase: 'rebuilt', ms: performance.now() - rebuildAt, editToBundleMs: performance.now() - editAt, ...stats() });
        }
    }
    log({ phase: 'complete', ...stats() });
} finally {
    if (server) await server.end();
    if (rebuildFixture) rmSync(rebuildFixture, { recursive: true, force: true });
}
// Expo's config loader also installs tsconfig observers outside Metro's Server.
// This one-shot diagnostic owns its process, including those remaining handles.
process.exit(0);
