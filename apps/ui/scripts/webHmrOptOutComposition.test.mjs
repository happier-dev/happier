// @happier-test-preparation source
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';
import vm from 'node:vm';

const require = createRequire(import.meta.url);

test('the opted-out web client ignores source updates and reload commands while manual reload remains available', async t => {
    const { build } = require('esbuild');
    const { dirname, resolve } = require('node:path');
    const uiRoot = require('node:url').fileURLToPath(new URL('../', import.meta.url));
    const expoRoot = dirname(require.resolve('expo/package.json'));
    const result = await build({
        stdin: {
            contents: [
                'export * from "./sources/dev/webHmrOptOut/expoAsyncRequireSetupShim";',
                'export * from "./sources/dev/webHmrOptOut/expoMessageSocketShim";',
                `export { default as HMRClient } from ${JSON.stringify(resolve(expoRoot, 'src/async-require/hmr.ts'))};`,
            ].join('\n'),
            resolveDir: uiRoot,
            sourcefile: 'web-hmr-client-fixture.ts',
        },
        bundle: true, platform: 'node', format: 'cjs', write: false, logLevel: 'silent',
        external: ['react-native', 'pretty-format', 'react-refresh/runtime'],
        define: { __DEV__: 'true', 'process.env.EXPO_OS': '"web"', 'process.env.NODE_ENV': '"development"' },
    });
    for (const optOut of [false, true]) {
        let reloads = 0;
        const sockets = [];
        const values = new Map();
        // Browser DOM, network sockets and DeviceEventEmitter are system
        // boundaries. Expo setup/dispatch, Metro injection and our guard stay real.
        const sandbox = {
            module: { exports: {} }, URL, queueMicrotask, console,
            require(id) {
                if (id === 'react-native') return { DeviceEventEmitter: { emit() {} } };
                return require(id);
            },
            location: {
                href: `http://page.invalid/app${optOut ? '?happier_hmr=0' : ''}`,
                host: 'page.invalid', protocol: 'http:', reload() { reloads += 1; },
            },
            document: { currentScript: { src: 'https://bundle.invalid/index.bundle?platform=web&dev=true' } },
            sessionStorage: {
                getItem: key => values.get(key) ?? null,
                setItem: (key, value) => values.set(key, value),
                removeItem: key => values.delete(key),
            },
            history: { replaceState(_data, _unused, url) { sandbox.location.href = String(url); } },
            hmrApplied: 0,
            WebSocket: class {
                static OPEN = 1;
                constructor(url) {
                    this.url = url;
                    sockets.push(this);
                    queueMicrotask(() => this.onopen?.({}));
                }
                send() {}
                close() { this.onclose?.({ code: 1000 }); }
            },
        };
        sandbox.global = sandbox;
        sandbox.window = sandbox;
        vm.runInNewContext(result.outputFiles[0].text, sandbox, { filename: 'web-hmr-client-fixture.cjs' });
        await new Promise(resolve => queueMicrotask(resolve));
        assert.equal(sandbox.__HAPPIER_WEB_HMR_OPT_OUT__, optOut);
        assert.equal(new URL(sandbox.location.href).searchParams.has('happier_hmr'), false);
        assert.equal(values.get('happier.web.hmrOptOut') === 'disabled', optOut);
        assert.ok(sockets.every(socket => new URL(socket.url).host === 'page.invalid'),
            'installed Expo uses the page host even when the script comes from another origin');
        sandbox.module.exports.HMRClient.registerBundle('https://bundle.invalid/lazy-screen.bundle');
        for (let edit = 0; edit < 3; edit += 1) {
            for (const socket of sockets) {
                const message = new URL(socket.url).pathname === '/hot' ? {
                    type: 'update', body: { isInitialUpdate: false, revisionId: `edit-${edit}`, deleted: [], modified: [],
                        added: [{ module: [edit, 'global.hmrApplied += 1;'], sourceURL: 'changed-source.bundle' }] },
                } : { method: 'reload' };
                socket.onmessage({ data: JSON.stringify(message) });
            }
        }
        t.diagnostic(`optOut=${optOut} edits=3 sourceUpdates=${sandbox.hmrApplied} automaticReloads=${reloads} networkSockets=${sockets.length}`);
        assert.equal(sandbox.hmrApplied, optOut ? 0 : 3);
        assert.equal(reloads, optOut ? 0 : 3);
        sandbox.location.reload();
        assert.equal(reloads, optOut ? 1 : 4, 'a deliberate manual reload remains available');
    }
});
