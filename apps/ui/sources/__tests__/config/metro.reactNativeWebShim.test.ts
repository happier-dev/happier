import { afterEach, describe, expect, it, vi } from 'vitest';
import { dirname, join, relative, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import fs, { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';

import { tmpdir } from 'node:os';
import { resolve as resolveMetro, type ResolutionContext } from 'metro-resolver';

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
    it.each(['ios', 'android', 'web'])('resolves workspace UI sources and React runtime peers on %s despite nested copies', (platform) => {
        const uiDir = getUiDir();
        const config = loadMetroConfig(uiDir);
        const fixture = realpathSync(mkdtempSync(join(tmpdir(), 'happier-metro-peers-')));
        try {
            // Real filesystem boundary and real Metro resolver: nested packages reproduce
            // Yarn's hoisted native dependencies carrying their own runtime peers.
            for (const name of ['react', 'react-dom', 'react-native', 'unrelated-peer']) {
                const root = join(fixture, 'node_modules', name);
                mkdirSync(root, { recursive: true });
                writeFileSync(join(root, 'package.json'), JSON.stringify({ name, main: 'index.js' }));
                writeFileSync(join(root, 'index.js'), 'module.exports = {};');
                if (name === 'react') writeFileSync(join(root, 'jsx-runtime.js'), 'module.exports = {};');
                if (name === 'react-dom') writeFileSync(join(root, 'client.js'), 'module.exports = {};');
            }
            const context: ResolutionContext = {
                ...config.resolver,
                allowHaste: false,
                assetExts: new Set(config.resolver.assetExts),
                customResolverOptions: Object.create(null),
                dev: true,
                mainFields: config.resolver.resolverMainFields,
                nodeModulesPaths: config.resolver.nodeModulesPaths ?? [],
                originModulePath: join(fixture, 'index.js'),
                preferNativePlatform: platform !== 'web',
                resolveRequest: resolveMetro,
                doesFileExist: existsSync,
                fileSystemLookup(filePath) {
                    if (!existsSync(filePath)) return { exists: false };
                    return { exists: true, type: statSync(filePath).isDirectory() ? 'd' : 'f', realPath: realpathSync(filePath) };
                },
                getPackage(filePath) {
                    return existsSync(filePath) ? JSON.parse(readFileSync(filePath, 'utf8')) : null;
                },
                getPackageForModule(filePath) {
                    for (let dir = dirname(filePath); dirname(dir) !== dir; dir = dirname(dir)) {
                        const manifest = join(dir, 'package.json');
                        if (existsSync(manifest)) return { rootPath: dir, packageRelativePath: relative(dir, filePath), packageJson: JSON.parse(readFileSync(manifest, 'utf8')) };
                        if (dir.endsWith('node_modules')) break;
                    }
                    return null;
                },
                resolveAsset: () => null,
                resolveHasteModule: () => null,
                resolveHastePackage: () => null,
                redirectModulePath: (modulePath) => modulePath,
                unstable_logWarning: (message) => { throw new Error(message); },
            };
            const appRequire = createRequire(join(uiDir, 'package.json'));
            writeFileSync(join(fixture, 'generatedBundledPluginUiArtifacts.d.ts'), 'export declare const BUNDLED_PLUGIN_UI_APP_ARTIFACTS: readonly unknown[];');
            expect(() => config.resolver.resolveRequest(context, './generatedBundledPluginUiArtifacts', platform)).toThrow();
            writeFileSync(join(fixture, 'generatedBundledPluginUiArtifacts.js'), 'export const BUNDLED_PLUGIN_UI_APP_ARTIFACTS = [];');
            expect(config.resolver.resolveRequest(context, './generatedBundledPluginUiArtifacts', platform)).toEqual({
                type: 'sourceFile', filePath: join(fixture, 'generatedBundledPluginUiArtifacts.js'),
            });
            expect(resolveMetro(context, 'react', platform)).toEqual({
                type: 'sourceFile', filePath: join(fixture, 'node_modules', 'react', 'index.js'),
            });
            for (const name of ['react', 'react/jsx-runtime', ...(platform === 'web' ? ['react-dom', 'react-dom/client'] : ['react-native'])]) {
                expect(config.resolver.resolveRequest(context, name, platform)).toEqual({
                    type: 'sourceFile', filePath: realpathSync(appRequire.resolve(name)),
                });
            }
            if (platform !== 'web') {
                const subpath = 'react-native/Libraries/Utilities/Platform';
                // Preserve the installed package's exports behavior, including its priority
                // over platform suffixes, rather than resolving this private file with Node.
                expect(config.resolver.resolveRequest(context, subpath, platform)).toEqual(
                    resolveMetro({ ...context, originModulePath: join(uiDir, 'index.ts') }, subpath, platform),
                );
            }
            const repoRoot = resolve(uiDir, '..', '..');
            const publicAuthoringUi = join(repoRoot, 'packages/plugin-sdk/examples/public-authoring/ui');
            const authoringContext = {
                ...context,
                originModulePath: join(publicAuthoringUi, 'reviewPanel.native.tsx'),
            };
            for (const name of ['reviewClientActions', 'reviewOpenableContent']) {
                expect(config.resolver.resolveRequest(authoringContext, `./${name}.js`, platform)).toEqual({
                    type: 'sourceFile', filePath: join(publicAuthoringUi, `${name}.ts`),
                });
            }
            expect(config.resolver.resolveRequest(context, 'unrelated-peer', platform)).toEqual({
                type: 'sourceFile', filePath: join(fixture, 'node_modules', 'unrelated-peer', 'index.js'),
            });
        } finally {
            rmSync(fixture, { recursive: true, force: true });
        }
    });

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

    it('excludes colocated tests from every workspace Metro graph while retaining runtime modules', () => {
        const uiDir = getUiDir();
        const repoRoot = resolve(uiDir, '..', '..');
        const config = loadMetroConfig(uiDir);
        const blockList = Array.isArray(config.resolver.blockList)
            ? config.resolver.blockList
            : [config.resolver.blockList];
        const isBlocked = (candidate: string) => blockList.some(
            (pattern: unknown) => pattern instanceof RegExp && pattern.test(candidate),
        );

        for (const candidate of [
            resolve(uiDir, 'sources/components/markdown/enriched/EnrichedMarkdownText.webStreamingReveal.test.tsx'),
            resolve(uiDir, 'sources/components/markdown/rendering/splitMarkdownRenderSegments.sourceRange.test.ts'),
            resolve(uiDir, 'sources/app/(app)/settings/voice.spec.tsx'),
            resolve(repoRoot, 'packages/plugins/elevenlabs/src/ui/voice/runtime.test.ts'),
            resolve(repoRoot, 'packages/brand/planet.test.mjs'),
            String.raw`C:\repo\apps\ui\sources\voice\runtime\nativeWebRtcRuntime.test.ts`,
        ]) {
            expect(isBlocked(candidate), candidate).toBe(true);
        }
        for (const candidate of [
            resolve(uiDir, 'sources/components/markdown/enriched/EnrichedMarkdownTextAdapter.tsx'),
            resolve(uiDir, 'sources/dev/testkit/harness/useForegroundVoiceTextTurnQaBridge.ts'),
            resolve(repoRoot, 'packages/plugins/elevenlabs/src/ui/voice/runtime.ts'),
            String.raw`C:\repo\apps\ui\sources\voice\runtime\nativeWebRtcRuntime.ts`,
        ]) {
            expect(isBlocked(candidate), candidate).toBe(false);
        }
    });

    it('keeps Expo default workspace watch folders in local development', () => {
        const uiDir = getUiDir();
        const repoRoot = resolve(uiDir, '..', '..');
        const config = loadMetroConfig(uiDir);

        expect(config.watchFolders).toContain(resolve(repoRoot, 'apps/website'));
        expect(config.watchFolders).toContain(resolve(repoRoot, 'apps/docs'));
        expect(config.watchFolders).toContain(resolve(repoRoot, 'packages/tests'));
    });

    it('narrows CI watch folders for UI e2e Metro runs to internal workspace and hoisted Expo packages only', () => {
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
        expect(config.watchFolders).toContain(resolve(repoRoot, 'packages/plugins/opencode'));
        expect(config.resolver.disableHierarchicalLookup).toBe(true);
        expect(config.resolver.nodeModulesPaths).toContain(appNodeModules);
        expect(config.resolver.nodeModulesPaths).toContain(rootNodeModules);
    });

    it('resolves React Native\'s declared private package through the coherent app-level dependency in narrowed native Metro runs', () => {
        const uiDir = getUiDir();
        const reactNativeDir = resolve(uiDir, 'node_modules/react-native');
        const config = loadMetroConfig(uiDir, {
            CI: '1',
            EXPO_NO_METRO_WORKSPACE_ROOT: '1',
            HAPPIER_UI_METRO_NARROW_WATCH_FOLDERS: '1',
        });
        const expectedEntry = createRequire(join(reactNativeDir, 'package.json')).resolve('@react-native/virtualized-lists');
        const reactNativePackage = JSON.parse(
            readFileSync(join(reactNativeDir, 'package.json'), 'utf8'),
        ) as { dependencies?: Record<string, string> };
        const resolvedPackage = JSON.parse(
            readFileSync(join(dirname(expectedEntry), 'package.json'), 'utf8'),
        ) as { version?: string };

        const resolved = config.resolver.resolveRequest(
            {
                originModulePath: join(reactNativeDir, 'Libraries/Modal/Modal.js'),
                resolveRequest: () => {
                    throw new Error('narrowed Metro default resolver cannot use hierarchical lookup');
                },
            },
            '@react-native/virtualized-lists',
            'android',
        );
        const blockList = Array.isArray(config.resolver.blockList)
            ? config.resolver.blockList
            : [config.resolver.blockList];

        expect(resolved).toEqual({
            type: 'sourceFile',
            filePath: expectedEntry,
        });
        expect(resolvedPackage.version).toBe(
            reactNativePackage.dependencies?.['@react-native/virtualized-lists'],
        );
        expect(config.resolver.nodeModulesPaths).toContain(resolve(uiDir, 'node_modules'));
        expect(
            blockList.some((entry: unknown) => entry instanceof RegExp && entry.test(expectedEntry)),
        ).toBe(false);
    });

    it('never prefers native platform files when it resolves for web', () => {
        // Metro hardcodes `preferNativePlatform: true`
        // (`metro/src/node-haste/DependencyGraph.js`), so `foo.native.ts` beats
        // `foo.ts` on EVERY platform unless the resolution context says
        // otherwise. Expo CLI supplies that correction
        // (`preferNativePlatform: platform !== 'web'` in
        // `@expo/cli/.../withMetroMultiPlatform.js`), but it lives in Expo
        // CLI's own pipeline, not in this config — so anything that bundles
        // with this config directly through Metro gets NATIVE resolution for a
        // web bundle. That pulled `react-native-keyboard-controller`'s
        // `bindings.native.ts`, and with it React Native's native renderer and
        // `InitializeCore`, into a web bundle, which throws
        // "__fbBatchedBridgeConfig is not set, cannot invoke native modules"
        // before any app code runs.
        //
        // The platform contract belongs to this config, so it states it here
        // rather than depending on which tool happens to be driving Metro.
        const uiDir = getUiDir();
        const config = loadMetroConfig(uiDir);

        const observed: Array<{ platform: string | null; preferNativePlatform: unknown }> = [];
        const capture = (platform: string | null) => {
            config.resolver.resolveRequest(
                {
                    originModulePath: join(uiDir, 'index.ts'),
                    resolveRequest: (context: { preferNativePlatform?: unknown }) => {
                        observed.push({ platform, preferNativePlatform: context.preferNativePlatform });
                        return { type: 'empty' };
                    },
                    preferNativePlatform: true,
                },
                'react-native-keyboard-controller',
                platform,
            );
        };

        capture('web');
        capture('ios');
        capture('android');

        expect(observed).toEqual([
            { platform: 'web', preferNativePlatform: false },
            { platform: 'ios', preferNativePlatform: true },
            { platform: 'android', preferNativePlatform: true },
        ]);
    });

    it('watches the monorepo root node_modules (SHA-1 hashing for hoisted deps)', () => {
        const uiDir = getUiDir();
        const repoRoot = resolve(uiDir, '..', '..');
        const rootNodeModules = resolve(repoRoot, 'node_modules');
        const config = loadMetroConfig(uiDir);

        expect(config.watchFolders).toContain(rootNodeModules);
    });

    it('resolves internal workspace package source exports through real package paths in local development', () => {
        const uiDir = getUiDir();
        const repoRoot = resolve(uiDir, '..', '..');
        const config = loadMetroConfig(uiDir, {
            HAPPIER_STACK_STACK: null,
            EXPO_NO_METRO_WORKSPACE_ROOT: null,
            HAPPIER_UI_METRO_NARROW_WATCH_FOLDERS: null,
        });
        const symlinkedSourcePath = resolve(
            repoRoot,
            'node_modules/@happier-dev/voice-modelpacks/src/index.ts',
        );

        const resolved = config.resolver.resolveRequest(
            {
                originModulePath: join(uiDir, 'index.ts'),
                resolveRequest: () => ({ type: 'sourceFile', filePath: symlinkedSourcePath }),
            },
            '@happier-dev/voice-modelpacks',
            'web',
        );

        expect(resolved).toEqual({
            type: 'sourceFile',
            filePath: resolve(repoRoot, 'packages/voice-modelpacks/src/index.ts'),
        });
    });

    it('resolves generated bundled Plugin UI asset imports only as packaged Metro assets', () => {
        const uiDir = getUiDir();
        const repoRoot = resolve(uiDir, '..', '..');
        const config = loadMetroConfig(uiDir);
        const defaultResolution = { type: 'empty' };
        const relativeArtifactPath = 'react-native/inspector-app-native/entry.cjs.bundle';

        for (const platform of ['web', 'ios', 'android']) {
            const resolved = config.resolver.resolveRequest(
                {
                    originModulePath: join(
                        uiDir,
                        'sources/sync/domains/plugins/availability/generatedBundledPluginUiArtifacts.js',
                    ),
                    resolveRequest: () => defaultResolution,
                },
                `@happier-dev/plugins-inspector/happier-plugin-ui/${relativeArtifactPath}`,
                platform,
            );

            expect(resolved).toEqual({
                type: 'assetFiles',
                filePaths: [resolve(
                    repoRoot,
                    'packages/plugins/inspector/dist/happier-plugin-ui',
                    relativeArtifactPath,
                )],
            });
        }
    });

    it('keeps packaged Plugin UI artifact bytes hashable while blocking unrelated workspace dist output', () => {
        const uiDir = getUiDir();
        const repoRoot = resolve(uiDir, '..', '..');
        const artifactRoot = resolve(
            repoRoot,
            'packages/plugins/inspector/dist/happier-plugin-ui',
        );
        const config = loadMetroConfig(uiDir, {
            CI: '1',
            EXPO_NO_METRO_WORKSPACE_ROOT: '1',
            HAPPIER_UI_METRO_NARROW_WATCH_FOLDERS: '1',
        });
        const blockList = Array.isArray(config.resolver.blockList)
            ? config.resolver.blockList
            : [config.resolver.blockList];
        const isBlocked = (candidatePath: string) => blockList.some(
            (entry: unknown) => entry instanceof RegExp && entry.test(candidatePath),
        );

        expect(config.watchFolders).toContain(resolve(repoRoot, 'packages/plugins/inspector'));
        expect(isBlocked(join(artifactRoot, 'react-native/inspector-app-native/entry.cjs.bundle'))).toBe(false);
        expect(isBlocked(resolve(repoRoot, 'packages/plugins/inspector/dist/index.js'))).toBe(true);
    });

    it('keeps future bundled Plugin UI artifacts hashable when Metro starts before publication', () => {
        const uiDir = getUiDir();
        const repoRoot = resolve(uiDir, '..', '..');
        const packageRoot = resolve(repoRoot, 'packages/plugins/inspector');
        const artifactRoot = resolve(packageRoot, 'dist/happier-plugin-ui');
        const manifestPath = join(artifactRoot, 'ui-artifacts.json');
        const originalExistsSync = existsSync;
        const existsSyncSpy = vi.spyOn(fs, 'existsSync').mockImplementation(
            (candidatePath: Parameters<typeof existsSync>[0]) => (
                resolve(String(candidatePath)) === manifestPath
                    ? false
                    : originalExistsSync(candidatePath)
            ),
        );

        try {
            const config = loadMetroConfig(uiDir, {
                CI: '1',
                EXPO_NO_METRO_WORKSPACE_ROOT: '1',
                HAPPIER_UI_METRO_NARROW_WATCH_FOLDERS: '1',
            });
            const blockList = Array.isArray(config.resolver.blockList)
                ? config.resolver.blockList
                : [config.resolver.blockList];
            const futureArtifactPath = join(
                artifactRoot,
                'react-native/channels-app-native/ios/src_ui_renderSurface_tsx.chunk.bundle',
            );

            expect(config.watchFolders).toContain(packageRoot);
            // Metro tests directory paths before descending. Blocking `dist`
            // itself prunes the permitted `happier-plugin-ui` subtree even
            // when the eventual artifact path does not match the block list.
            expect(blockList.some(
                (entry: unknown) => entry instanceof RegExp && entry.test(resolve(packageRoot, 'dist')),
            )).toBe(false);
            expect(config.resolver.assetExts).toContain('bundle');
            expect(config.resolver.assetExts).toContain('map');
            expect(blockList.some(
                (entry: unknown) => entry instanceof RegExp && entry.test(futureArtifactPath),
            )).toBe(false);
        } finally {
            existsSyncSpy.mockRestore();
        }
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
        expect(config.watcher?.useWatchman).toBe(false);
        expect(config.watcher).not.toHaveProperty('unstable_workerThreads');
    });

    it('allows local native profiling runs to disable an explicit Watchman opt-in', () => {
        const uiDir = getUiDir();
        const config = loadMetroConfig(uiDir, {
            CI: undefined,
            HAPPIER_STACK_STACK: undefined,
            HAPPIER_UI_METRO_USE_WATCHMAN: 'true',
            HAPPIER_UI_METRO_DISABLE_WATCHMAN: '1',
        });

        expect(config.resolver.useWatchman).toBe(false);
        expect(config.watcher?.useWatchman).toBe(false);
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

    it('blocks generated CLI runner snapshots without hiding CLI source', () => {
        const uiDir = getUiDir();
        const repoRoot = resolve(uiDir, '..', '..');
        const config = loadMetroConfig(uiDir, { HAPPIER_STACK_STACK: 'repo-metro-test' });
        const blockList = Array.isArray(config.resolver.blockList)
            ? config.resolver.blockList
            : [config.resolver.blockList];
        const isBlocked = (candidatePath: string) => (
            blockList.some((entry: unknown) => entry instanceof RegExp && entry.test(candidatePath))
        );
        const cliRoot = resolve(repoRoot, 'apps/cli');

        expect(config.watchFolders).toContain(cliRoot);
        expect(isBlocked(join(cliRoot, '.runner-snapshots', 'current', 'tools', 'unpacked', 'zellij'))).toBe(true);
        expect(isBlocked(String.raw`C:\repo\apps\cli\.runner-snapshots\current\tools\unpacked\zellij`)).toBe(true);
        expect(isBlocked(join(cliRoot, 'src/index.ts'))).toBe(false);
        expect(isBlocked(join(cliRoot, '.runner-snapshot-scratch', 'src/index.ts'))).toBe(false);
    });

    it('blocks transient package build trees and regular internal workspace dist while retaining canonical source', () => {
        const uiDir = getUiDir();
        const repoRoot = resolve(uiDir, '..', '..');
        const config = loadMetroConfig(uiDir);
        const blockList = Array.isArray(config.resolver.blockList)
            ? config.resolver.blockList
            : [config.resolver.blockList];
        const packageRoot = resolve(repoRoot, 'packages/protocol');
        const isBlocked = (candidatePath: string) => (
            blockList.some((entry: unknown) => entry instanceof RegExp && entry.test(candidatePath))
        );

        for (const transientDirectoryName of [
            '.tmp.publish-1',
            '.backup.publish-1',
            '.restore.publish-1',
            '.dist.build.publish-1',
            '.dist.hstack-stage-publish-1',
            '.dist.hstack-backup.1452086.1790630931232',
            'dist.staging.publish-1',
            'dist.probe.publish-1',
            'dist.__finalize_backup__.publish-1',
            '.happier-plugin-ui-stage-publish-1',
            '.happier-plugin-ui-staging',
        ]) {
            expect(
                isBlocked(join(packageRoot, transientDirectoryName, 'src/index.ts')),
                transientDirectoryName,
            ).toBe(true);
        }

        expect(
            isBlocked(String.raw`C:\repo\packages\protocol\.tmp.publish-1\src\index.ts`),
        ).toBe(true);
        expect(
            isBlocked(String.raw`C:\repo\packages\protocol\dist.__finalize_backup__.publish-1\index.js`),
        ).toBe(true);
        expect(
            isBlocked(String.raw`C:\repo\packages\protocol\.dist.hstack-backup.1452086.1790630931232\agents\install\index.js`),
        ).toBe(true);
        expect(
            isBlocked(join(
                packageRoot,
                '.happier',
                'typescript-package-build',
                'compiler-cache',
                'dist',
                'index.js',
            )),
        ).toBe(true);
        expect(
            isBlocked(String.raw`C:\repo\packages\protocol\.happier\typescript-package-build\compiler-cache\dist\index.js`),
        ).toBe(true);
        expect(isBlocked(join(packageRoot, 'src/index.ts'))).toBe(false);
        expect(isBlocked(join(packageRoot, 'dist/index.js'))).toBe(true);
        expect(isBlocked(join(packageRoot, '.tmp/index.ts'))).toBe(false);
        expect(isBlocked(join(packageRoot, 'dist.staging/index.js'))).toBe(false);
    });

    it('excludes workspace-private dependency trees at every discovered package depth while retaining bundle inputs', () => {
        const uiDir = getUiDir();
        const repoRoot = resolve(uiDir, '..', '..');
        const config = loadMetroConfig(uiDir);
        const blockList = Array.isArray(config.resolver.blockList) ? config.resolver.blockList : [config.resolver.blockList];
        const isBlocked = (candidate: string) => blockList.some((entry: unknown) => entry instanceof RegExp && entry.test(candidate));
        for (const packageRoot of ['packages/plugins/openai', 'packages/plugins/inspector', 'packages/protocol']) {
            const privateRoot = resolve(repoRoot, packageRoot, 'node_modules');
            for (const candidate of [join(privateRoot, 'react', 'index.js'), privateRoot]) {
                expect(isBlocked(candidate)).toBe(true);
                expect(isBlocked(candidate.replaceAll('/', '\\'))).toBe(true);
            }
            expect(isBlocked(`C:\\repo\\${packageRoot.replaceAll('/', '\\')}\\node_modules\\react\\index.js`)).toBe(true);
            expect(isBlocked(resolve(repoRoot, packageRoot, 'src/index.ts'))).toBe(false);
        }
        for (const candidate of [
            'node_modules/react/index.js',
            'apps/ui/node_modules/react/index.js',
            'apps/ui/node_modules/react-native/node_modules/@react-native/virtualized-lists/index.js',
            'packages/plugins/inspector/dist/happier-plugin-ui/web.bundle',
        ]) expect(isBlocked(resolve(repoRoot, candidate))).toBe(false);
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

    it('blocks package-manager executable shims from Metro file-map crawls', () => {
        const uiDir = getUiDir();
        const config = loadMetroConfig(uiDir);
        const blockList = Array.isArray(config.resolver.blockList)
            ? config.resolver.blockList
            : [config.resolver.blockList];
        const isBlocked = (candidatePath: string) => blockList.some(
            (entry: unknown) => entry instanceof RegExp && entry.test(candidatePath),
        );

        expect(isBlocked(resolve(uiDir, '..', '..', 'node_modules', '.bin', 'eslint'))).toBe(true);
        expect(isBlocked(resolve(uiDir, 'node_modules', '.bin', 'expo'))).toBe(true);
        expect(isBlocked(String.raw`C:\repo\node_modules\.bin\eslint`)).toBe(true);
        expect(isBlocked(resolve(uiDir, '..', '..', 'node_modules', 'eslint', 'bin', 'eslint.js'))).toBe(false);
    });

    it('allows enabling Watchman via env var on machines where it is stable', () => {
        const uiDir = getUiDir();
        const config = loadMetroConfig(uiDir, {
            CI: null,
            HAPPIER_STACK_STACK: null,
            HAPPIER_UI_METRO_USE_WATCHMAN: '1',
        });

        expect(config.resolver.useWatchman).toBe(true);
        expect(config.watcher).not.toHaveProperty('useWatchman');
    });

    it('keeps Watchman disabled in CI even when HAPPIER_UI_METRO_USE_WATCHMAN=1', () => {
        const uiDir = getUiDir();
        const config = loadMetroConfig(uiDir, { CI: '1', HAPPIER_UI_METRO_USE_WATCHMAN: '1' });

        expect(config.resolver.useWatchman).toBe(false);
        expect(config.watcher?.useWatchman).toBe(false);
    });

    it('keeps Watchman disabled in stack runs even when HAPPIER_UI_METRO_USE_WATCHMAN=1', () => {
        const uiDir = getUiDir();
        const config = loadMetroConfig(uiDir, {
            CI: null,
            HAPPIER_STACK_STACK: 'preview-stack',
            HAPPIER_UI_METRO_USE_WATCHMAN: '1',
        });

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

    it('leaves generated Worklets Bundle Mode imports on the default resolver when the flag is off', () => {
        const uiDir = getUiDir();
        const config = loadMetroConfig(uiDir, { HAPPIER_UI_WORKLETS_BUNDLE_MODE: '0' });
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
            const config = loadMetroConfig(uiDir, { HAPPIER_UI_WORKLETS_BUNDLE_MODE: '1' });

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
        const config = loadMetroConfig(uiDir, { HAPPIER_UI_WORKLETS_BUNDLE_MODE: '1' });

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
        ['0.7 generated worklets', 'react-native-worklets/__generatedWorklets/0.js'],
        ['0.8 generated worklets', 'react-native-worklets/.worklets/0.js'],
    ])('assigns deterministic generated-worklet module ids without colliding with normal modules for %s', (_label, moduleName) => {
        const uiDir = getUiDir();
        const config = loadMetroConfig(uiDir, { HAPPIER_UI_WORKLETS_BUNDLE_MODE: '1' });
        const createModuleId = config.serializer.createModuleIdFactory();
        const normalModuleId = createModuleId(join(uiDir, 'index.ts'));
        const generatedWorkletId = createModuleId(join(uiDir, 'node_modules', moduleName));

        expect(createModuleId(join(uiDir, 'node_modules', moduleName))).toBe(generatedWorkletId);
        expect(generatedWorkletId).not.toBe(normalModuleId);
    });

    it('does not watch generated Worklets Bundle Mode modules by default', () => {
        const uiDir = getUiDir();
        const config = loadMetroConfig(uiDir, { HAPPIER_UI_WORKLETS_BUNDLE_MODE: '0' });

        expect(config.watchFolders).toEqual(expect.not.arrayContaining([
            join(uiDir, 'node_modules/react-native-worklets/__generatedWorklets'),
            join(uiDir, 'node_modules/react-native-worklets/.worklets'),
        ]));
    });

    it('watches generated Worklets Bundle Mode modules when explicitly enabled', () => {
        const uiDir = getUiDir();
        const config = loadMetroConfig(uiDir, { HAPPIER_UI_WORKLETS_BUNDLE_MODE: '1' });

        expect(config.watchFolders).toEqual(expect.arrayContaining([
            join(uiDir, 'node_modules/react-native-worklets/__generatedWorklets'),
            join(uiDir, 'node_modules/react-native-worklets/.worklets'),
        ]));
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

    it.each([
        ['local', {}],
        ['narrow stack', {
            CI: '1',
            EXPO_NO_METRO_WORKSPACE_ROOT: '1',
            HAPPIER_UI_METRO_NARROW_WATCH_FOLDERS: '1',
        }],
    ])('resolves compatible React Navigation history-prevention contracts in %s mode', (_label, env) => {
        const uiDir = getUiDir();
        const config = loadMetroConfig(uiDir, env);
        const nativeResolution = config.resolver.resolveRequest(
            { originModulePath: join(uiDir, 'index.ts') },
            '@react-navigation/native',
            'web',
        );

        expect(nativeResolution).toMatchObject({ type: 'sourceFile' });
        const nativeEntry = nativeResolution.filePath as string;
        const coreResolution = config.resolver.resolveRequest(
            { originModulePath: nativeEntry },
            '@react-navigation/core',
            'web',
        );

        expect(coreResolution).toMatchObject({ type: 'sourceFile' });
        const coreEntry = coreResolution.filePath as string;
        const nativePackageRoot = resolve(dirname(nativeEntry), '..', '..');
        const corePackageRoot = resolve(dirname(coreEntry), '..', '..');
        const nativePackage = JSON.parse(readFileSync(join(nativePackageRoot, 'package.json'), 'utf8'));
        const corePackage = JSON.parse(readFileSync(join(corePackageRoot, 'package.json'), 'utf8'));
        const coreContainerSource = readFileSync(
            join(corePackageRoot, 'src', 'BaseNavigationContainer.tsx'),
            'utf8',
        );

        expect(nativePackage.version).toBe('7.3.8');
        expect(corePackage.version).toBe('7.21.5');
        expect(coreContainerSource).toContain("type: '__unsafe_event__'");
    });

    it('pins React singleton modules to the app workspace when an upstream resolver points at a nested navigation copy', () => {
        const uiDir = getUiDir();
        const repoRoot = resolve(uiDir, '..', '..');
        const requireFromUi = createRequire(join(uiDir, 'package.json'));
        const nestedNavigationReact = resolve(repoRoot, 'node_modules', '@react-navigation', 'native', 'node_modules', 'react', 'index.js');
        const nestedNavigationJsxRuntime = resolve(repoRoot, 'node_modules', '@react-navigation', 'native', 'node_modules', 'react', 'jsx-runtime.js');

        vi.doMock('@sentry/react-native/metro', () => ({
            getSentryExpoConfig: () => ({
                server: { rewriteRequestUrl: (requestUrl: string) => requestUrl },
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
