import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';

const root = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(path.join(root, 'package.json'));
const cli = path.dirname(require.resolve('@expo/cli/package.json'));
const { loadMetroConfigAsync } = require(path.join(cli, 'build/src/start/server/metro/instantiateMetro.js'));
const { getConfig } = require('@expo/config');
const Server = require('metro/private/Server').default;
const mode = process.argv[2] ?? 'lazy';
if (!['lazy', 'single', 'navigate-lazy', 'navigate-single', 'rebuild-lazy', 'rebuild-single'].includes(mode)) {
    throw new Error('Expected lazy|single|navigate-lazy|navigate-single|rebuild-lazy|rebuild-single');
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

async function navigate() {
    // Scratch-only Expo instance: no Stack, server, daemon, Account or database.
    // Use Expo's own startup/resolver/middleware rather than plain Metro, which
    // cannot resolve the Node builtins used by Expo's web winter runtime.
    const minutes = Number(process.argv[3] ?? 31);
    if (!Number.isFinite(minutes) || minutes < 0) throw new Error('Invalid measurement duration');
    // Exercise the app's canonical request rewrite in the corrected run rather
    // than making Expo disable lazy graphs through a diagnostic-only override.
    if (mode === 'navigate-single') delete process.env.EXPO_NO_METRO_LAZY;
    else process.env.EXPO_NO_METRO_LAZY = '0';
    process.env.EXPO_NO_TELEMETRY = '1';
    const config = require(path.join(root, 'metro.config.js'));
    config.cacheStores = [new (require('metro-cache').FileStore)({ root: path.join(cache, 'transforms') })];
    config.fileMapCacheDirectory = path.join(cache, 'filemap');
    mkdirSync(config.fileMapCacheDirectory, { recursive: true });
    const portProbe = net.createServer();
    await new Promise(resolve => portProbe.listen(0, '127.0.0.1', resolve));
    const port = portProbe.address().port;
    await new Promise(resolve => portProbe.close(resolve));
    const { MetroBundlerDevServer } = require(path.join(cli, 'build/src/start/server/metro/MetroBundlerDevServer.js'));
    const expo = new MetroBundlerDevServer(root, { web: 'metro' }, { isDevClient: true });
    let instance;
    let browser;
    try {
        instance = await expo.startImplementationAsync({ port, maxWorkers: 2, mode: 'development', location: { hostType: 'localhost' } });
        expo.setInstance(instance);
        server = expo.metro;
        log({ phase: 'scratch-ready', port, webRequest: server._config.server.rewriteRequestUrl(
            '/apps/ui/index.bundle?platform=web&dev=true&lazy=true'), ...stats() });
        const { chromium } = require('playwright');
        browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
        const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
        const page = await context.newPage();
        const errors = [];
        const bundles = [];
        page.on('pageerror', error => {
            errors.push(String(error));
            log({ phase: 'page-error', error: error.stack || String(error) });
            if (String(error).includes('import.meta')) {
                for (const graph of server.getBundler().getDeltaBundler()._deltaCalculators.keys()) {
                    for (const module of graph.dependencies.values()) {
                        for (const output of module.output) {
                            const code = output.data.code ?? '';
                            const index = code.indexOf('import.meta');
                            if (index >= 0) log({ phase: 'untransformed-import-meta', path: module.path,
                                code: code.slice(Math.max(0, index - 100), index + 200) });
                        }
                    }
                }
            }
        });
        page.on('response', response => {
            if (response.url().includes('.bundle?')) bundles.push({ path: new URL(response.url()).pathname, status: response.status() });
        });
        const frames = ['sessions-list.hero', 'session-view.hero', 'relay-settings.hero', 'machines-settings.hero',
            'subagents.hero', 'source-control.hero', 'mcp-servers.hero', 'connected-services.hero', 'theme-profiles.hero'];
        const started = performance.now();
        let firstContentAt;
        let cycle = 0;
        do {
            for (const frame of frames) {
                const start = performance.now();
                await page.goto(`http://127.0.0.1:${port}/dev/stage-dperf?frame=${frame}&happier_hmr=0`, {
                    // Cold compilation on a shared worker is outside the loaded
                    // navigation interval. Its duration is measured, not capped.
                    waitUntil: 'domcontentloaded', timeout: 0,
                });
                await page.waitForSelector(`[data-testid="demo-stage-frame-${frame}-content"]`, { timeout: 60 * 1000 });
                if (cycle === 0 && frame === frames[0]) {
                    const welcomeSkip = page.getByTestId('onboarding-showcase-story-skip');
                    await welcomeSkip.waitFor({ state: 'visible', timeout: 30 * 1000 });
                    await welcomeSkip.click();
                    await welcomeSkip.waitFor({ state: 'hidden' });
                    log({ phase: 'welcome-dismissed' });
                }
                firstContentAt ??= performance.now();
                log({ phase: 'navigation', cycle, frame, ms: performance.now() - start,
                    content: (await page.locator('body').innerText()).slice(0, 220), bundles: bundles.splice(0), ...stats() });
                if (cycle === 0) await page.screenshot({ path: path.join(cache, `${mode}-${frame}.png`) });
            }
            cycle++;
            if (performance.now() - firstContentAt < minutes * 60 * 1000) await delay(60 * 1000);
        } while (performance.now() - firstContentAt < minutes * 60 * 1000);
        log({ phase: 'navigation-complete', ms: performance.now() - started, loadedNavigationMs: performance.now() - firstContentAt,
            cycles: cycle, errors, ...stats(), artifacts: cache });
    } finally {
        if (browser) await browser.close();
        if (instance) await new Promise(resolve => instance.server.close(resolve));
        server = null;
    }
}
try {
    log({ phase: 'identity', host: os.hostname(), node: process.version, pid: process.pid, cwd: process.cwd(), metro: require('metro/package.json').version });
    if (mode.startsWith('navigate-')) {
        await navigate();
        process.exit(0);
    }
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
