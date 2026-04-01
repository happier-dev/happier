import { describe, expect, it } from 'vitest';
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

        const hoistedExpoConstants = resolve(rootNodeModules, 'expo-constants');
        if (existsSync(hoistedExpoConstants)) {
            expect(config.watchFolders).toContain(hoistedExpoConstants);
        }

        const hoistedExpoCrypto = resolve(rootNodeModules, 'expo-crypto');
        if (existsSync(hoistedExpoCrypto)) {
            expect(config.watchFolders).toContain(hoistedExpoCrypto);
        }
    });

    it('disables Watchman by default (reliability in large monorepos)', () => {
        const uiDir = getUiDir();
        const config = loadMetroConfig(uiDir);

        expect(config.resolver.useWatchman).toBe(false);
        expect(config.watcher?.useWatchman).toBe(false);
    });

    it('allows enabling Watchman via env var (fast incremental rebuilds on stable machines)', () => {
        const uiDir = getUiDir();
        const config = loadMetroConfig(uiDir, { HAPPIER_UI_METRO_USE_WATCHMAN: '1' });

        expect(config.resolver.useWatchman).toBe(true);
        expect(config.watcher?.useWatchman).toBe(true);
    });

    it('keeps Watchman disabled in CI even when HAPPIER_UI_METRO_USE_WATCHMAN=1 (deterministic runners)', () => {
        const uiDir = getUiDir();
        const config = loadMetroConfig(uiDir, { CI: '1', HAPPIER_UI_METRO_USE_WATCHMAN: '1' });

        expect(config.resolver.useWatchman).toBe(false);
        expect(config.watcher?.useWatchman).toBe(false);
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
