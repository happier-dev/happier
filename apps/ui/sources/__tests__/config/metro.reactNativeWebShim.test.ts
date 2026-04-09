import { afterEach, describe, expect, it, vi } from 'vitest';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';

function getUiDir(): string {
    return join(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..');
}

function loadMetroConfig(uiDir: string, envOverrides: Record<string, string | null | undefined> = {}) {
    const require = createRequire(import.meta.url);
    const configPath = join(uiDir, 'metro.config.js');
    const resolved = require.resolve(configPath);
    const previousEnv = new Map<string, string | undefined>();
    for (const [key, value] of Object.entries(envOverrides)) {
        previousEnv.set(key, process.env[key]);
        if (value == null) {
            delete process.env[key];
        } else {
            process.env[key] = String(value);
        }
    }

    delete require.cache[resolved];
    try {
        return require(configPath);
    } finally {
        delete require.cache[resolved];
        for (const [key, prev] of previousEnv.entries()) {
            if (typeof prev === 'undefined') {
                delete process.env[key];
            } else {
                process.env[key] = prev;
            }
        }
    }
}

describe('metro.config.js (web)', () => {
    afterEach(() => {
        vi.doUnmock('@sentry/react-native/metro');
        vi.resetModules();
    });

    it('enables require.context for Expo Router lazy route loading on web', () => {
        const uiDir = getUiDir();
        const config = loadMetroConfig(uiDir);

        // Expo Router uses `require.context` for lazy route module discovery on web.
        // If disabled, deep-link routes (e.g. `/terminal/connect`) can resolve to undefined components at runtime.
        expect(config.transformer?.unstable_allowRequireContext).toBe(true);
    });

    it('keeps Expo default workspace watch folders in local development', () => {
        const uiDir = getUiDir();
        const repoRoot = resolve(uiDir, '..', '..');
        const config = loadMetroConfig(uiDir);

        expect(config.watchFolders).toContain(resolve(repoRoot, 'apps/website'));
        expect(config.watchFolders).toContain(resolve(repoRoot, 'apps/docs'));
        expect(config.watchFolders).toContain(resolve(repoRoot, 'packages/tests'));
    });

    it('narrows CI watch folders for UI e2e Metro runs to internal package deps and hoisted Expo packages only', () => {
        const uiDir = getUiDir();
        const repoRoot = resolve(uiDir, '..', '..');
        const rootNodeModules = resolve(repoRoot, 'node_modules');
        const appNodeModules = resolve(uiDir, 'node_modules');
        const config = loadMetroConfig(uiDir, {
            CI: '1',
            EXPO_NO_METRO_WORKSPACE_ROOT: '1',
            HAPPIER_UI_METRO_NARROW_WATCH_FOLDERS: '1',
        });

        expect(config.watchFolders).not.toContain(resolve(repoRoot, 'apps/website'));
        expect(config.watchFolders).not.toContain(resolve(repoRoot, 'apps/docs'));
        expect(config.watchFolders).not.toContain(resolve(repoRoot, 'packages/tests'));
        expect(config.watchFolders).toContain(rootNodeModules);
        expect(config.watchFolders).toContain(resolve(repoRoot, 'packages/protocol'));
        expect(config.watchFolders).toContain(resolve(repoRoot, 'packages/cli-common'));
        expect(config.resolver.disableHierarchicalLookup).toBe(true);
        expect(config.resolver.nodeModulesPaths).toContain(appNodeModules);
        expect(config.resolver.nodeModulesPaths).toContain(rootNodeModules);
    });

    it('watches the monorepo root node_modules (SHA-1 hashing for hoisted deps)', () => {
        const uiDir = getUiDir();
        const repoRoot = resolve(uiDir, '..', '..');
        const rootNodeModules = resolve(repoRoot, 'node_modules');
        const config = loadMetroConfig(uiDir);

        expect(config.watchFolders).toContain(rootNodeModules);
    });

    it('watches hoisted Expo packages when monorepo root node_modules is excluded (SHA-1 hashing)', () => {
        const uiDir = getUiDir();
        const repoRoot = resolve(uiDir, '..', '..');
        const rootNodeModules = resolve(repoRoot, 'node_modules');
        const config = loadMetroConfig(uiDir, { HAPPIER_UI_METRO_WATCH_MONOREPO_ROOT_NODE_MODULES: '0' });

        const hoistedExpoModulesCore = resolve(rootNodeModules, 'expo-modules-core');
        if (existsSync(hoistedExpoModulesCore)) {
            expect(config.watchFolders).toContain(hoistedExpoModulesCore);
        } else {
            expect(config.watchFolders).not.toContain(hoistedExpoModulesCore);
        }

        const hoistedExpoSystemUi = resolve(rootNodeModules, 'expo-system-ui');
        if (existsSync(hoistedExpoSystemUi)) {
            expect(config.watchFolders).toContain(hoistedExpoSystemUi);
        } else {
            expect(config.watchFolders).not.toContain(hoistedExpoSystemUi);
        }

        const hoistedExpoConstants = resolve(rootNodeModules, 'expo-constants');
        if (existsSync(hoistedExpoConstants)) {
            expect(config.watchFolders).toContain(hoistedExpoConstants);
        } else {
            expect(config.watchFolders).not.toContain(hoistedExpoConstants);
        }

        const hoistedExpoCrypto = resolve(rootNodeModules, 'expo-crypto');
        if (existsSync(hoistedExpoCrypto)) {
            expect(config.watchFolders).toContain(hoistedExpoCrypto);
        } else {
            expect(config.watchFolders).not.toContain(hoistedExpoCrypto);
        }
    });

    it('disables Watchman by default in local development', () => {
        const uiDir = getUiDir();
        const config = loadMetroConfig(uiDir);

        expect(config.resolver.useWatchman).toBe(false);
        expect(config.watcher).not.toHaveProperty('useWatchman');
        expect(config.watcher).not.toHaveProperty('unstable_workerThreads');
    });

    it('blocks transient hstack web artifact exports from Metro crawling', () => {
        const uiDir = getUiDir();
        const config = loadMetroConfig(uiDir);
        const blockList = Array.isArray(config.resolver.blockList)
            ? config.resolver.blockList
            : [config.resolver.blockList];
        const artifactPath = join(
            uiDir,
            '.expo',
            'hstack',
            'web-artifact-export',
            'run-1',
            'monaco',
            'vs',
            'editor',
            'editor.main.js',
        );

        expect(
            blockList.some((entry: unknown) => entry instanceof RegExp && entry.test(artifactPath)),
        ).toBe(true);
    });

    it('blocks nested dependency node_modules trees under watched app/root node_modules', () => {
        const uiDir = getUiDir();
        const config = loadMetroConfig(uiDir);
        const blockList = Array.isArray(config.resolver.blockList)
            ? config.resolver.blockList
            : [config.resolver.blockList];
        const nestedNodeModulesPath = join(
            uiDir,
            '..',
            'node_modules',
            '@react-native-async-storage',
            'async-storage',
            'node_modules',
            'metro-config',
            'node_modules',
        );

        expect(
            blockList.some((entry: unknown) => entry instanceof RegExp && entry.test(nestedNodeModulesPath)),
        ).toBe(true);
    });

    it('allows enabling Watchman via env var on machines where it is stable', () => {
        const uiDir = getUiDir();
        const config = loadMetroConfig(uiDir, { CI: null, HAPPIER_UI_METRO_USE_WATCHMAN: '1' });

        expect(config.resolver.useWatchman).toBe(true);
        expect(config.watcher).not.toHaveProperty('useWatchman');
    });

    it('keeps Watchman disabled in CI even when HAPPIER_UI_METRO_USE_WATCHMAN=1', () => {
        const uiDir = getUiDir();
        const config = loadMetroConfig(uiDir, { CI: '1', HAPPIER_UI_METRO_USE_WATCHMAN: '1' });

        expect(config.resolver.useWatchman).toBe(false);
        expect(config.watcher).not.toHaveProperty('useWatchman');
    });

    it('shims react-native to provide unstable_batchedUpdates (LegendList compatibility)', () => {
        const uiDir = getUiDir();
        const config = loadMetroConfig(uiDir);

        const resolved = config.resolver.resolveRequest(
            { originModulePath: join(uiDir, 'index.ts') },
            'react-native',
            'web',
        );

        expect(resolved).toEqual({
            type: 'sourceFile',
            filePath: join(uiDir, 'sources/platform/shims/reactNativeWebShim.ts'),
        });
    });

    it('keeps @react-navigation/native on the canonical package entry when it already exports NavigationProvider', () => {
        const uiDir = getUiDir();
        const config = loadMetroConfig(uiDir);
        const requireFromUi = createRequire(join(uiDir, 'package.json'));

        const resolved = config.resolver.resolveRequest(
            { originModulePath: join(uiDir, 'index.ts') },
            '@react-navigation/native',
            'web',
        );

        expect(resolved).toEqual({
            type: 'sourceFile',
            filePath: requireFromUi.resolve('@react-navigation/native'),
        });
    });

    it('pins React singleton modules to the app workspace when an upstream resolver points at a nested navigation copy', () => {
        const uiDir = getUiDir();
        const repoRoot = resolve(uiDir, '..', '..');
        const requireFromUi = createRequire(join(uiDir, 'package.json'));
        const nestedNavigationReact = resolve(repoRoot, 'node_modules', '@react-navigation', 'native', 'node_modules', 'react', 'index.js');
        const nestedNavigationJsxRuntime = resolve(repoRoot, 'node_modules', '@react-navigation', 'native', 'node_modules', 'react', 'jsx-runtime.js');

        vi.doMock('@sentry/react-native/metro', () => ({
            getSentryExpoConfig: () => ({
                resolver: {
                    assetExts: [],
                    blockList: null,
                    resolveRequest(_context: unknown, moduleName: string) {
                        if (moduleName === 'react') {
                            return { type: 'sourceFile', filePath: nestedNavigationReact };
                        }
                        if (moduleName === 'react/jsx-runtime') {
                            return { type: 'sourceFile', filePath: nestedNavigationJsxRuntime };
                        }
                        return { type: 'empty' };
                    },
                },
                transformer: {},
                watchFolders: [],
            }),
        }));

        const config = loadMetroConfig(uiDir, {
            CI: '1',
            EXPO_NO_METRO_WORKSPACE_ROOT: '1',
            HAPPIER_UI_METRO_NARROW_WATCH_FOLDERS: '1',
        });

        const navigationEntry = requireFromUi.resolve('@react-navigation/native');

        expect(config.resolver.resolveRequest(
            { originModulePath: navigationEntry },
            'react',
            'web',
        )).toEqual({
            type: 'sourceFile',
            filePath: requireFromUi.resolve('react'),
        });

        expect(config.resolver.resolveRequest(
            { originModulePath: navigationEntry },
            'react/jsx-runtime',
            'web',
        )).toEqual({
            type: 'sourceFile',
            filePath: requireFromUi.resolve('react/jsx-runtime'),
        });
    });

    it('throws unresolved package errors instead of returning null from the custom resolver', () => {
        const uiDir = getUiDir();
        const config = loadMetroConfig(uiDir);

        expect(() => config.resolver.resolveRequest(
            { originModulePath: join(uiDir, 'index.ts') },
            '@happier-dev/definitely-missing-package',
            'web',
        )).toThrow();
    });
});
