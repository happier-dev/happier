import { describe, expect, it, vi } from 'vitest';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';

const require = createRequire(import.meta.url);

function getUiDir(): string {
    return join(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..');
}

function loadMetroConfig(envOverrides: Record<string, string | undefined> = {}) {
    const uiDir = getUiDir();
    const configPath = join(uiDir, 'metro.config.js');
    const previous = new Map<string, string | undefined>();
    for (const [key, value] of Object.entries(envOverrides)) {
        previous.set(key, process.env[key]);
        if (value === undefined) {
            delete process.env[key];
        } else {
            process.env[key] = value;
        }
    }

    try {
        delete require.cache[require.resolve(configPath)];
        return require(configPath);
    } finally {
        delete require.cache[require.resolve(configPath)];
        for (const [key, value] of previous.entries()) {
            if (value === undefined) {
                delete process.env[key];
            } else {
                process.env[key] = value;
            }
        }
    }
}

async function loadMetroConfigWithSentryFactory(
    createModuleIdFactory: () => (moduleName: string) => number,
    envOverrides: Record<string, string | undefined> = {},
) {
    vi.resetModules();
    vi.doMock('@sentry/react-native/metro', () => ({
        getSentryExpoConfig: () => ({
            resolver: {
                assetExts: [],
                resolveRequest: (_context: unknown, moduleName: string) => ({
                    type: 'sourceFile',
                    filePath: moduleName,
                }),
            },
            serializer: {
                createModuleIdFactory,
            },
        }),
    }));

    try {
        return loadMetroConfig(envOverrides);
    } finally {
        vi.doUnmock('@sentry/react-native/metro');
        vi.resetModules();
    }
}

describe('metro.config.js (web)', () => {
    it('shims react-native to provide unstable_batchedUpdates (LegendList compatibility)', () => {
        const uiDir = getUiDir();
        const config = loadMetroConfig();

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
        const config = loadMetroConfig();

        expect(() => config.resolver.resolveRequest(
            { originModulePath: join(uiDir, 'index.ts') },
            '@happier-dev/definitely-missing-package',
            'web',
        )).toThrow();
    });

    it('leaves generated Worklets Bundle Mode imports on the default resolver when the flag is off', () => {
        const uiDir = getUiDir();
        const config = loadMetroConfig({ HAPPIER_UI_WORKLETS_BUNDLE_MODE: '0' });
        const defaultResolution = {
            type: 'sourceFile',
            filePath: join(uiDir, 'default-worklets-resolution.js'),
        };

        const resolved = config.resolver.resolveRequest(
            {
                originModulePath: join(uiDir, 'index.ts'),
                resolveRequest: () => defaultResolution,
            },
            'react-native-worklets/.worklets/123.js',
            'ios',
        );

        expect(resolved).toBe(defaultResolution);
    });

    it('keeps the Worklets Bundle Mode generated-worklet resolver available when explicitly enabled', () => {
        const uiDir = getUiDir();
        const moduleName = 'react-native-worklets/.worklets/metro-fixture.js';
        const generatedWorkletPath = join(uiDir, 'node_modules', moduleName);
        mkdirSync(dirname(generatedWorkletPath), { recursive: true });
        writeFileSync(generatedWorkletPath, 'export default null;\n');

        try {
            const config = loadMetroConfig({ HAPPIER_UI_WORKLETS_BUNDLE_MODE: '1' });

            expect(existsSync(generatedWorkletPath)).toBe(true);

            const resolved = config.resolver.resolveRequest(
                {
                    originModulePath: join(uiDir, 'index.ts'),
                    resolveRequest: () => {
                        throw new Error('default resolver should not receive generated worklets');
                    },
                },
                moduleName,
                'ios',
            );

            expect(resolved).toEqual({
                type: 'sourceFile',
                filePath: generatedWorkletPath,
            });
        } finally {
            rmSync(generatedWorkletPath, { force: true });
        }
    });

    it('reports stale Metro cache when a generated Worklets Bundle Mode import points at a missing file', () => {
        const uiDir = getUiDir();
        const config = loadMetroConfig({ HAPPIER_UI_WORKLETS_BUNDLE_MODE: '1' });

        expect(() => config.resolver.resolveRequest(
            {
                originModulePath: join(uiDir, 'index.ts'),
                resolveRequest: () => {
                    throw new Error('default resolver should not receive generated worklets');
                },
            },
            'react-native-worklets/.worklets/123.js',
            'ios',
        )).toThrow(/generated Worklets Bundle Mode module.*does not exist.*clear Metro/i);
    });

    it.each([
        ['0.7 generated worklets', 'react-native-worklets/__generatedWorklets/123.js'],
        ['0.8 generated worklets', 'react-native-worklets/.worklets/123.js'],
    ])('assigns numeric module ids to absolute generated worklet paths for %s', (_label, moduleName) => {
        const uiDir = getUiDir();
        const config = loadMetroConfig({ HAPPIER_UI_WORKLETS_BUNDLE_MODE: '1' });
        const createModuleId = config.serializer.createModuleIdFactory();

        expect(createModuleId(join(uiDir, 'node_modules', moduleName))).toBe(123);
    });

    it('avoids collisions between generated worklet ids and ordinary module ids', async () => {
        const uiDir = getUiDir();
        const config = await loadMetroConfigWithSentryFactory(
            () => (moduleName) => moduleName.endsWith('ordinary-collision.js') ? 123 : 7,
            { HAPPIER_UI_WORKLETS_BUNDLE_MODE: '1' },
        );
        const createModuleId = config.serializer.createModuleIdFactory();
        const generatedId = createModuleId(join(uiDir, 'node_modules/react-native-worklets/.worklets/123.js'));
        const ordinaryId = createModuleId(join(uiDir, 'sources/ordinary-collision.js'));

        expect(generatedId).toBe(123);
        expect(ordinaryId).not.toBe(generatedId);
        expect(createModuleId(join(uiDir, 'sources/ordinary-collision.js'))).toBe(ordinaryId);
    });

    it('does not watch generated Worklets Bundle Mode modules by default', () => {
        const uiDir = getUiDir();
        const config = loadMetroConfig({ HAPPIER_UI_WORKLETS_BUNDLE_MODE: '0' });

        expect(config.watchFolders).toEqual(expect.not.arrayContaining([
            join(uiDir, 'node_modules/react-native-worklets/__generatedWorklets'),
            join(uiDir, 'node_modules/react-native-worklets/.worklets'),
        ]));
    });

    it('watches generated Worklets Bundle Mode modules when explicitly enabled', () => {
        const uiDir = getUiDir();
        const config = loadMetroConfig({ HAPPIER_UI_WORKLETS_BUNDLE_MODE: '1' });

        expect(config.watchFolders).toEqual(expect.arrayContaining([
            join(uiDir, 'node_modules/react-native-worklets/__generatedWorklets'),
            join(uiDir, 'node_modules/react-native-worklets/.worklets'),
        ]));
    });

    it('watches the resolved react-native-worklets package root when bundle-mode runtime entrypoints are configured', () => {
        const uiDir = getUiDir();
        const config = loadMetroConfig({ HAPPIER_UI_WORKLETS_BUNDLE_MODE: '1' });
        const workletsPackageRoot = dirname(require.resolve('react-native-worklets/package.json', { paths: [uiDir] }));

        expect(config.serializer.getModulesRunBeforeMainModule(uiDir)).toEqual(expect.arrayContaining([
            require.resolve('react-native-worklets/src/initializers/workletRuntimeEntry.native.ts', { paths: [uiDir] }),
            require.resolve('react-native-worklets/lib/module/initializers/workletRuntimeEntry.native.js', { paths: [uiDir] }),
        ]));
        expect(config.watchFolders).toContain(workletsPackageRoot);
    });

    it('allows local native profiling runs to disable Watchman without CI mode', () => {
        const config = loadMetroConfig({
            CI: undefined,
            HAPPIER_STACK_STACK: undefined,
            HAPPIER_UI_METRO_DISABLE_WATCHMAN: '1',
        });

        expect(config.resolver.useWatchman).toBe(false);
        expect(config.watcher?.useWatchman).toBe(false);
    });

});
