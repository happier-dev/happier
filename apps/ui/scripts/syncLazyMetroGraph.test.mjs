import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const uiRoot = fileURLToPath(new URL('..', import.meta.url));
const require = createRequire(path.join(uiRoot, 'package.json'));

test('sync consumers and lazy presence never pull the sync implementation into their Metro graph', async () => {
    const cache = mkdtempSync(path.join(tmpdir(), 'happier-sync-lazy-graph-'));
    let server;
    try {
        const config = require(path.join(uiRoot, 'metro.config.js'));
        config.maxWorkers = 2;
        config.cacheStores = [new (require('metro-cache').FileStore)({ root: path.join(cache, 'transforms') })];
        config.fileMapCacheDirectory = path.join(cache, 'filemap');
        mkdirSync(config.fileMapCacheDirectory, { recursive: true });
        config.reporter = { update() {} };
        const Server = require('metro/private/Server').default;
        server = new Server(config, { watch: false });
        for (const entry of [
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
