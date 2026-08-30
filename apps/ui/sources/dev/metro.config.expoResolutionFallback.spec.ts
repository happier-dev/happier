import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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

    it('rewrites absolute @noble/hashes/crypto.js file requests before Metro package export validation', () => {
        const config = requireFreshMetroConfig();
        const cryptoJsPath = path.resolve(__dirname, '../../../../node_modules/@noble/hashes/crypto.js');

        expect(() => config.resolver.resolveRequest({}, cryptoJsPath, 'web')).not.toThrow();

        const result = config.resolver.resolveRequest({}, cryptoJsPath, 'web');
        expect(result?.type).toBe('sourceFile');
        expect(typeof result?.filePath).toBe('string');
        expect(fs.existsSync(String(result?.filePath))).toBe(true);
    });

    it('resolves the app-owned enriched-markdown streaming patch before generic Metro resolution', () => {
        const genericResolver = vi.fn(() => {
            throw new Error('generic Metro resolution must not own patched private subpaths');
        });
        // metro.config.js is CommonJS, so replace the already-loaded CommonJS boundary directly;
        // Vitest module mocks do not intercept its `require()` call.
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        require('@sentry/react-native/metro');
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const sentryModulePath = require.resolve('@sentry/react-native/metro');
        const sentryModule = require.cache[sentryModulePath];
        expect(sentryModule).toBeDefined();
        const originalSentryExports = sentryModule?.exports;
        if (!sentryModule) throw new Error('expected cached @sentry/react-native/metro module');
        sentryModule.exports = {
            getSentryExpoConfig: () => ({
                resolver: {
                    assetExts: [],
                    blockList: [],
                    resolveRequest: genericResolver,
                },
                serializer: {},
                transformer: {},
                watchFolders: [],
            }),
        };

        try {
            const config = requireFreshMetroConfig();
            const expectedPath = path.resolve(
                __dirname,
                '../../node_modules/react-native-enriched-markdown/lib/module/web/streamingReveal.js',
            );

            expect(config.resolver.resolveRequest(
                {},
                'react-native-enriched-markdown/lib/module/web/streamingReveal.js',
                'web',
            )).toEqual({ type: 'sourceFile', filePath: expectedPath });
            expect(genericResolver).not.toHaveBeenCalled();
            expect(fs.existsSync(expectedPath)).toBe(true);
        } finally {
            sentryModule.exports = originalSentryExports;
        }
    });

    it('stubs Node os imports before Metro tries to hash builtin module ids', () => {
        const config = requireFreshMetroConfig();
        const expectedShimPath = path.resolve(__dirname, '../platform/nodeShims/nodeOsShim.ts');

        expect(config.resolver.resolveRequest({}, 'node:os', 'ios')).toEqual({
            type: 'sourceFile',
            filePath: expectedShimPath,
        });
        expect(config.resolver.resolveRequest({}, 'os', 'ios')).toEqual({
            type: 'sourceFile',
            filePath: expectedShimPath,
        });
        expect(fs.existsSync(expectedShimPath)).toBe(true);
    });

    it('disables Watchman in stack builds (HAPPIER_STACK_STACK set)', () => {
        process.env.HAPPIER_STACK_STACK = 'qa-test';
        delete process.env.CI;

        const config = requireFreshMetroConfig();
        expect(config?.resolver?.useWatchman).toBe(false);
    });

    it('resolves editable internal workspace packages and their explicit .js imports from source', () => {
        process.env.HAPPIER_STACK_STACK = 'qa-test';
        delete process.env.CI;

        const config = requireFreshMetroConfig();
        const agentsEntry = path.resolve(__dirname, '../../../../packages/agents/src/index.ts');

        expect(config.resolver.resolveRequest({}, '@happier-dev/agents', 'web')).toEqual({
            type: 'sourceFile',
            filePath: agentsEntry,
        });
        expect(config.resolver.resolveRequest(
            { originModulePath: agentsEntry },
            './models.js',
            'web',
        )).toEqual({
            type: 'sourceFile',
            filePath: path.resolve(__dirname, '../../../../packages/agents/src/models.ts'),
        });
    });

    it('blocks generated workspace artifacts while retaining canonical source paths', () => {
        process.env.HAPPIER_STACK_STACK = 'qa-test';
        delete process.env.CI;

        const config = requireFreshMetroConfig();
        const blockList = Array.isArray(config.resolver.blockList)
            ? config.resolver.blockList
            : [config.resolver.blockList];
        const isBlocked = (filePath: string) => blockList.some(
            (pattern: RegExp | undefined) => pattern instanceof RegExp && pattern.test(filePath),
        );

        expect(isBlocked(path.resolve(__dirname, '../../../../packages/agents/dist/models.js'))).toBe(true);
        expect(isBlocked(path.resolve(__dirname, '../../../../packages/agents/src/models.ts'))).toBe(false);

        for (const transientFilePath of [
            '/workspace/.tmp.4182/apps/ui/sources/index.ts',
            String.raw`C:\workspace\.tmp.4182\apps\ui\sources\index.ts`,
            '/workspace/packages/agents/dist.__finalize_backup__.4182/index.js',
            String.raw`C:\workspace\packages\agents\dist.__finalize_backup__.4182\index.js`,
        ]) {
            expect(isBlocked(transientFilePath)).toBe(true);
        }

        for (const sourceFilePath of [
            '/workspace/packages/agents/src/index.ts',
            String.raw`C:\workspace\packages\agents\src\index.ts`,
        ]) {
            expect(isBlocked(sourceFilePath)).toBe(false);
        }
    });
});
