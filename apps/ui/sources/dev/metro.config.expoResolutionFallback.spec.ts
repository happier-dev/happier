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

    it('disables Watchman in stack builds (HAPPIER_STACK_STACK set)', () => {
        process.env.HAPPIER_STACK_STACK = 'qa-test';
        delete process.env.CI;

        const config = requireFreshMetroConfig();
        expect(config?.resolver?.useWatchman).toBe(false);
    });

    it('resolves explicit .js relative imports by file path in CI mode (avoids Metro resolver regressions)', () => {
        process.env.CI = '1';
        delete process.env.HAPPIER_STACK_STACK;
        delete process.env.HAPPIER_STACK_TUI;

        const config = requireFreshMetroConfig();

        const originModulePath = path.resolve(
            __dirname,
            '../../../../packages/cli-common/dist/relayAccess/registry.js',
        );
        const result = config.resolver.resolveRequest(
            { originModulePath },
            './providers/localOnly/index.js',
            'web',
        );

        expect(result).toEqual({
            type: 'sourceFile',
            filePath: path.resolve(path.dirname(originModulePath), './providers/localOnly/index.js'),
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

            expect(resolved.baseUrl).toBe(fresh.baseUrl);
            expect(resolved.hasScriptTags).toBe(true);
        } finally {
            await new Promise<void>((resolve) => stale.server.close(() => resolve()));
            await new Promise<void>((resolve) => fresh.server.close(() => resolve()));
        }
    });
});
