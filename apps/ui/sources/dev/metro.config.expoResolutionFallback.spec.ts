import fs from 'node:fs';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { __testables as uiWebMetroTestables } from '../../../../packages/tests/src/testkit/process/uiWebMetro';

describe('apps/ui/metro.config.js (Expo resolution fallbacks)', () => {
    const envSnapshot = { ...process.env };

    function requireFreshMetroConfig() {
        // Metro expects a CommonJS config, so this file uses `require`. Vitest does not reliably clear
        // the CommonJS require cache via `vi.resetModules()`, so clear it manually to allow per-test env.
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const resolved = require.resolve('../../metro.config.js');
        // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
        delete require.cache[resolved];
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        return require('../../metro.config.js');
    }

    beforeEach(() => {
        vi.resetModules();
        process.env = { ...envSnapshot };
    });

    afterEach(() => {
        vi.resetModules();
        process.env = { ...envSnapshot };
    });

    it('stubs `expo-system-ui` on web', () => {
        const config = requireFreshMetroConfig();

        const expectedStubPath = path.resolve(__dirname, '../platform/stubs/expoSystemUiWebStub.ts');
        const result = config.resolver.resolveRequest(
            { resolveRequest: () => ({ type: 'empty' }) },
            'expo-system-ui',
            'web',
        );

        expect(result).toEqual({ type: 'sourceFile', filePath: expectedStubPath });
        expect(fs.existsSync(expectedStubPath)).toBe(true);
    });

    it('stubs the missing React Native devtools settings manager on web', () => {
        const config = requireFreshMetroConfig();

        const expectedStubPath = path.resolve(__dirname, '../platform/stubs/reactNativeDevToolsSettingsManagerWebStub.ts');
        const originModulePath = path.resolve(
            __dirname,
            '../../node_modules/react-native/Libraries/Core/setUpReactDevTools.js',
        );

        const result = config.resolver.resolveRequest(
            { originModulePath, resolveRequest: () => ({ type: 'empty' }) },
            '../../src/private/devsupport/rndevtools/ReactDevToolsSettingsManager',
            'web',
        );

        expect(result).toEqual({ type: 'sourceFile', filePath: expectedStubPath });
        expect(fs.existsSync(expectedStubPath)).toBe(true);
    });

    it('falls back to resolving hoisted Expo modules from the monorepo root node_modules', () => {
        const config = requireFreshMetroConfig();

        const result = config.resolver.resolveRequest(
            // Provide a minimal context; the default resolver can throw in this unit-test harness,
            // and the config should fall back to Node resolution rooted at the monorepo `node_modules`.
            {},
            'expo-modules-core',
            'web',
        );

        expect(result?.type).toBe('sourceFile');
        expect(String(result?.filePath)).toMatch(/[/\\\\]expo-modules-core[/\\\\].+[/\\\\]index\.ts$/u);
        expect(fs.existsSync(String(result?.filePath))).toBe(true);
    });

    it('rewrites @noble/hashes/crypto.js to an exported subpath', () => {
        const config = requireFreshMetroConfig();

        expect(() => config.resolver.resolveRequest({}, '@noble/hashes/crypto.js', 'web')).not.toThrow();

        const result = config.resolver.resolveRequest({}, '@noble/hashes/crypto.js', 'web');
        expect(result?.type).toBe('sourceFile');
        expect(typeof result?.filePath).toBe('string');
        expect(fs.existsSync(String(result?.filePath))).toBe(true);
    });

    it('rewrites absolute @noble/hashes/crypto.js file requests before Metro package export validation', () => {
        const config = requireFreshMetroConfig();
        const cryptoJsPath = path.resolve(__dirname, '../../../../node_modules/@noble/hashes/crypto.js');

        expect(() => config.resolver.resolveRequest({}, cryptoJsPath, 'web')).not.toThrow();

        const result = config.resolver.resolveRequest({}, cryptoJsPath, 'web');
        expect(result?.type).toBe('sourceFile');
        expect(typeof result?.filePath).toBe('string');
        expect(fs.existsSync(String(result?.filePath))).toBe(true);
    });

    it('disables Watchman in stack builds (HAPPIER_STACK_STACK set)', () => {
        process.env.HAPPIER_STACK_STACK = 'qa-test';
        delete process.env.CI;

        const config = requireFreshMetroConfig();
        expect(config?.resolver?.useWatchman).toBe(false);
    });

    it('resolves internal workspace subpath exports through root node_modules in stack builds', () => {
        process.env.HAPPIER_STACK_STACK = 'qa-test';
        delete process.env.CI;
        delete process.env.EXPO_NO_METRO_WORKSPACE_ROOT;
        delete process.env.HAPPIER_UI_METRO_NARROW_WATCH_FOLDERS;

        const config = requireFreshMetroConfig();

        const relayAccessCatalogResult = config.resolver.resolveRequest({}, '@happier-dev/cli-common/relayAccess/catalog', 'web');
        expect(relayAccessCatalogResult).toEqual({
            type: 'sourceFile',
            filePath: path.resolve(__dirname, '../../../../node_modules/@happier-dev/cli-common/dist/relayAccess/catalog.js'),
        });
    });

    it('resolves explicit .js relative imports by file path in CI mode (avoids Metro resolver regressions)', () => {
        process.env.CI = '1';
        delete process.env.HAPPIER_STACK_STACK;
        delete process.env.HAPPIER_STACK_TUI;

        const config = requireFreshMetroConfig();

        const sandboxDir = fs.mkdtempSync(path.join(tmpdir(), 'happier-metro-explicit-js-'));
        const originModulePath = path.resolve(sandboxDir, 'relayAccess', 'registry.js');
        const targetModulePath = path.resolve(
            sandboxDir,
            'relayAccess',
            'providers',
            'localOnly',
            'index.js',
        );
        fs.mkdirSync(path.dirname(targetModulePath), { recursive: true });
        fs.writeFileSync(originModulePath, 'export {};\n', 'utf8');
        fs.writeFileSync(targetModulePath, 'export {};\n', 'utf8');
        const result = config.resolver.resolveRequest(
            { originModulePath },
            './providers/localOnly/index.js',
            'web',
        );

        expect(result).toEqual({
            type: 'sourceFile',
            filePath: targetModulePath,
        });

        fs.rmSync(sandboxDir, { recursive: true, force: true });
    });

    it('resolves internal workspace packages through root node_modules symlink paths when Metro workspace root is disabled', () => {
        process.env.CI = '1';
        process.env.EXPO_NO_METRO_WORKSPACE_ROOT = '1';
        process.env.HAPPIER_UI_METRO_NARROW_WATCH_FOLDERS = '1';
        delete process.env.HAPPIER_STACK_STACK;
        delete process.env.HAPPIER_STACK_TUI;

        const config = requireFreshMetroConfig();

        const protocolResult = config.resolver.resolveRequest({}, '@happier-dev/protocol', 'web');
        expect(protocolResult).toEqual({
            type: 'sourceFile',
            filePath: path.resolve(__dirname, '../../../../node_modules/@happier-dev/protocol/dist/index.js'),
        });

        const socketRpcResult = config.resolver.resolveRequest({}, '@happier-dev/protocol/socketRpc', 'web');
        expect(socketRpcResult).toEqual({
            type: 'sourceFile',
            filePath: path.resolve(__dirname, '../../../../node_modules/@happier-dev/protocol/dist/socketRpc.js'),
        });
    });

    it('maps explicit .node.js relative imports to their browser variants in CI mode', () => {
        process.env.CI = '1';
        delete process.env.HAPPIER_STACK_STACK;
        delete process.env.HAPPIER_STACK_TUI;

        const config = requireFreshMetroConfig();

        const originModulePath = path.resolve(
            __dirname,
            '../../../../node_modules/engine.io-client/build/esm/index.js',
        );
        const result = config.resolver.resolveRequest(
            { originModulePath },
            './globals.node.js',
            'web',
        );

        expect(result).toEqual({
            type: 'sourceFile',
            filePath: path.resolve(path.dirname(originModulePath), './globals.js'),
        });
    });

    it('keeps Expo CLI runtime port dependencies resolvable from the workspace install', () => {
        const expoPortUtilPath = require.resolve('@expo/cli/build/src/utils/port.js');
        expect(() =>
            require.resolve('freeport-async', { paths: [path.dirname(expoPortUtilPath)] }),
        ).not.toThrow();
    });

    it('allows cache busting Metro via HAPPIER_UI_METRO_CACHE_VERSION_BUST', () => {
        process.env.HAPPIER_UI_METRO_CACHE_VERSION_BUST = 'test-bust';

        const config = requireFreshMetroConfig();
        expect(String(config.cacheVersion)).toContain('test-bust');
    });
});

describe('packages/tests uiWebMetro (Expo web baseUrl resolution)', () => {
    async function startHtmlServer(html: string): Promise<{ server: ReturnType<typeof createServer>; baseUrl: string }> {
        const server = createServer((req, res) => {
            if (req.url === '/' || req.url === '/index.html') {
                res.writeHead(200, { 'content-type': 'text/html' });
                res.end(html);
                return;
            }
            res.writeHead(404);
            res.end();
        });

        await new Promise<void>((resolve) => {
            server.listen(0, '127.0.0.1', () => resolve());
        });
        const addr = server.address();
        if (!addr || typeof addr !== 'object') {
            await new Promise<void>((resolve) => server.close(() => resolve()));
            throw new Error('missing server address');
        }

        return { server, baseUrl: `http://localhost:${addr.port}` };
    }

    it('prefers entry pages whose primary script targets the expected Metro port', async () => {
        const expectedMetroPort = 45678;

        const stale = await startHtmlServer(
            `<!doctype html><html><head></head><body><div id="root"></div><script src="http://localhost:11111/index.bundle?platform=web"></script></body></html>`,
        );
        const fresh = await startHtmlServer(
            `<!doctype html><html><head></head><body><div id="root"></div><script src="http://localhost:${expectedMetroPort}/index.bundle?platform=web"></script></body></html>`,
        );

        try {
            const dir = await mkdtemp(path.join(tmpdir(), 'happier-uiwebmetro-baseurl-'));
            const stdoutPath = path.join(dir, 'ui.web.stdout.log');
            await writeFile(stdoutPath, `stale ${stale.baseUrl}\nfresh ${fresh.baseUrl}\n`, 'utf8');

            const resolved = await uiWebMetroTestables.resolveExpoWebBaseUrl({
                stdoutPath,
                timeoutMs: 350,
                expectedPort: expectedMetroPort,
                env: { NODE_ENV: 'test' },
            });

            const normalizeLoopbackHost = (raw: string) => {
                const url = new URL(raw);
                if (url.hostname === '127.0.0.1') {
                    url.hostname = 'localhost';
                }
                return url.toString();
            };

            // We treat localhost and 127.0.0.1 as interchangeable loopback carriers; only the port matters.
            expect(normalizeLoopbackHost(resolved.baseUrl)).toBe(normalizeLoopbackHost(fresh.baseUrl));
            expect(resolved.hasScriptTags).toBe(true);
        } finally {
            await new Promise<void>((resolve) => stale.server.close(() => resolve()));
            await new Promise<void>((resolve) => fresh.server.close(() => resolve()));
        }
    });
});
