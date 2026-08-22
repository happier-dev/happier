import { spawn } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, win32 } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createServer } from 'vite';
import {
    PLUGIN_UI_HOST_API_VERSION_V1,
    PluginUiArtifactsManifestV1Schema,
    computePluginUiArtifactFileSetSha256DigestV1,
} from '@happier-dev/protocol/plugins/ui';

import { isBinDirectInvocation, runPluginBuildUiCli } from './bin.js';
import type { PluginUiBuildConfig } from './config.js';
import type {
    ManagedBundlerExecResult,
    ManagedBundlerExecService,
} from './managedBundler.js';

type ManagedBundlerLaunch = Parameters<ManagedBundlerExecService['run']>[0];

const hostUiApiVersion = PLUGIN_UI_HOST_API_VERSION_V1;
const reactVersion = '19.2.0';
const pluginSdkRoot = fileURLToPath(new URL('../../../', import.meta.url));
const protocolSourceDirectory = fileURLToPath(new URL('../../../../protocol/src/', import.meta.url));
const protocolSourceEntrypoint = fileURLToPath(new URL('../../../../protocol/src/index.ts', import.meta.url));

let projectRoot: string;

function encode(text: string): Uint8Array {
    return new TextEncoder().encode(text);
}

const emitted = [
    {
        relativePath: 'hosted-web/examples.reviewWeb/index.html',
        bytes: encode('<!doctype html><html></html>'),
    },
];

function config(): PluginUiBuildConfig {
    return {
        outDir: 'dist/ui',
        targets: [{
            rendererId: 'examples.reviewWeb',
            entry: 'ui/reviewPanel.web.tsx',
            kind: 'hostedWeb',
        }],
    };
}

function createSuccessfulManagedExec(calls: ManagedBundlerLaunch[]): ManagedBundlerExecService {
    const result: ManagedBundlerExecResult = { exitCode: 0, signal: null, stdout: '', stderr: '' };
    return {
        async run(input) {
            calls.push(input);
            return result;
        },
    };
}

function resolveRealViteBinPath(): string {
    const require = createRequire(import.meta.url);
    const packageJsonPath = require.resolve('vite/package.json');
    return join(dirname(packageJsonPath), 'bin', 'vite.js');
}

function createRealViteExec(): ManagedBundlerExecService {
    const viteBinPath = resolveRealViteBinPath();
    return {
        async run(input) {
            return await new Promise<ManagedBundlerExecResult>((resolve, reject) => {
                const child = spawn(process.execPath, [viteBinPath, ...(input.args ?? [])], {
                    cwd: input.cwd,
                    stdio: ['ignore', 'pipe', 'pipe'],
                });
                let stdout = '';
                let stderr = '';
                child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8'); });
                child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
                child.once('error', reject);
                child.once('close', (exitCode) => {
                    resolve({ exitCode, signal: null, stdout, stderr });
                });
            });
        },
    };
}

function resolveInstalledPackageRoot(packageName: string): string {
    const require = createRequire(import.meta.url);
    return dirname(require.resolve(`${packageName}/package.json`));
}

async function symlinkInstalledPackage(projectRoot: string, packageName: string): Promise<void> {
    const destination = join(projectRoot, 'node_modules', packageName);
    await mkdir(dirname(destination), { recursive: true });
    await symlink(resolveInstalledPackageRoot(packageName), destination, 'dir');
}

/**
 * The managed CLI injects the Re.Pack process boundary. This test preserves
 * that boundary but drives the generated config through the real Rspack
 * compiler in-process, so Vite can evaluate the current SDK source rather
 * than a stale workspace `dist` copy.
 */
function createRealRepackExec(operationRoots: string[] = []): ManagedBundlerExecService {
    return {
        async run(input) {
            const configFlagIndex = input.args?.indexOf('--config') ?? -1;
            const configPath = configFlagIndex < 0 ? undefined : input.args?.[configFlagIndex + 1];
            const platformFlagIndex = input.args?.indexOf('--platform') ?? -1;
            const platform = platformFlagIndex < 0 ? undefined : input.args?.[platformFlagIndex + 1];
            const operationRoot = input.cwd;
            if (!configPath || !operationRoot || (platform !== 'ios' && platform !== 'android')) {
                throw new Error('Real Re.Pack test execution requires a generated native config and platform');
            }
            const sourceLoader = await createServer({
                appType: 'custom',
                root: input.cwd,
                logLevel: 'error',
                server: { middlewareMode: true },
                resolve: {
                    alias: [
                        {
                            find: '@happier-dev/plugin-sdk/ui/build',
                            replacement: join(pluginSdkRoot, 'src', 'ui', 'build', 'index.ts'),
                        },
                        {
                            find: /^@happier-dev\/protocol\/(.+)$/u,
                            replacement: `${protocolSourceDirectory}$1`,
                        },
                        {
                            find: '@happier-dev/protocol',
                            replacement: protocolSourceEntrypoint,
                        },
                    ],
                },
            });
            let generatedConfig: unknown;
            try {
                const generatedConfigModule = await sourceLoader.ssrLoadModule(configPath) as Readonly<{
                    default?: (env: Readonly<{ platform: 'ios' | 'android'; mode: 'production' }>) => unknown;
                }>;
                if (typeof generatedConfigModule.default !== 'function') {
                    throw new Error('Generated Re.Pack config did not export a config function');
                }
                generatedConfig = generatedConfigModule.default({ platform, mode: 'production' });
            } finally {
                await sourceLoader.close();
            }
            const generatedConfigRecord = generatedConfig as Readonly<Record<string, unknown>>;
            const configProjectRoot = generatedConfigRecord.context;
            if (typeof configProjectRoot !== 'string') {
                throw new Error('Generated Re.Pack config did not provide the author project root');
            }
            // The managed CLI runs Re.Pack from its ephemeral operation root.
            // Materialize the same logical author entry there so the real
            // compiler exercises that operation-local boundary.
            await mkdir(join(operationRoot, 'ui'), { recursive: true });
            await writeFile(
                join(operationRoot, 'ui', 'nativeEntry.js'),
                await readFile(join(configProjectRoot, 'ui', 'nativeEntry.js'), 'utf8'),
                'utf8',
            );
            operationRoots.push(operationRoot);
            const { rspack } = await import('@rspack/core');
            // Re.Pack's bundle command supplies this default before applying
            // the generated config. Keep that order so the generated config
            // remains the canonical production decision for source maps.
            const compiler = rspack({
                devtool: 'source-map',
                ...generatedConfigRecord,
                context: operationRoot,
            });
            return await new Promise<ManagedBundlerExecResult>((resolve) => {
                compiler.run((runError, stats) => {
                    const diagnostic = runError?.stack
                        ?? (stats?.hasErrors() ? stats.toString({ all: false, errors: true }) : '');
                    compiler.close((closeError) => {
                        resolve({
                            exitCode: runError || closeError || stats?.hasErrors() ? 1 : 0,
                            signal: null,
                            stdout: '',
                            stderr: [diagnostic, closeError?.stack ?? ''].filter(Boolean).join('\n'),
                        });
                    });
                });
            });
        },
    };
}

beforeEach(async () => {
    projectRoot = await mkdtemp(join(tmpdir(), 'happier-plugin-build-ui-cli-'));
});

afterEach(async () => {
    await rm(projectRoot, { recursive: true, force: true });
});

describe('runPluginBuildUiCli', () => {
    it('runs the canonical public targets config through the shipped bin and stages every declared web/iOS/Android artifact', async () => {
        const canonicalExampleSource = await readFile(
            join(pluginSdkRoot, 'examples/public-authoring/pluginUiBuild.ts'),
            'utf8',
        );
        await writeFile(join(projectRoot, 'pluginUiBuild.mjs'), canonicalExampleSource, 'utf8');
        const packageScope = join(projectRoot, 'node_modules/@happier-dev');
        await mkdir(packageScope, { recursive: true });
        await symlink(pluginSdkRoot, join(packageScope, 'plugin-sdk'), 'dir');
        const workRoot = join(projectRoot, 'dist/ui');
        const emitted = [
            ['react-native-web/voice-runtime-web/entry.mjs.bundle', 'voice web'],
            ['hosted-web/review-web/index.html', '<!doctype html>'],
            ['hosted-web/review-openable-web/index.html', '<!doctype html>'],
            ['react-native-web/review-native/entry.mjs.bundle', 'review web'],
            ['react-native/review-native/ios/ios.bundle', 'review ios'],
            ['react-native/review-native/android/android.bundle', 'review android'],
            ['react-native-web/review-openable-native/entry.mjs.bundle', 'review openable web'],
            ['react-native/review-openable-native/ios/ios.bundle', 'review openable ios'],
            ['react-native/review-openable-native/android/android.bundle', 'review openable android'],
        ] as const;
        for (const [relativePath, contents] of emitted) {
            const absolutePath = join(workRoot, relativePath);
            await mkdir(dirname(absolutePath), { recursive: true });
            await writeFile(absolutePath, contents, 'utf8');
        }
        const calls: ManagedBundlerLaunch[] = [];
        const runInput = {
            argv: ['--project-root', projectRoot],
            exec: createSuccessfulManagedExec(calls),
            resolveManagedBuildVersions: () => ({
                hostUiApiVersion,
                viteVersion: '7.3.1',
                repackVersion: '5.2.5',
                reactVersion,
                reactNativeVersion: '0.83.4',
            }),
        };

        const exitCode = await runPluginBuildUiCli(runInput);

        expect(exitCode).toBe(0);
        const viteCalls = calls.filter((call) => call.installableId === 'plugin-ui.bundler.vite');
        expect(viteCalls).toHaveLength(5);
        for (const contributionId of [
            'voice-runtime-web',
            'review-web',
            'review-openable-web',
            'review-native',
            'review-openable-native',
        ]) {
            const call = viteCalls.find((candidate) => candidate.args?.[2]?.includes(`vite.${contributionId}.config.mjs`));
            expect(call?.args?.slice(0, 2)).toEqual(['build', '--config']);
            expect(call?.args?.[2]).toContain('.happier-plugin-ui-build-');
        }
        const repackCalls = calls.filter((call) => call.installableId === 'plugin-ui.bundler.repack');
        expect(repackCalls).toHaveLength(4);
        for (const [contributionId, platform] of [
            ['review-native', 'ios'],
            ['review-native', 'android'],
            ['review-openable-native', 'ios'],
            ['review-openable-native', 'android'],
        ] as const) {
            const call = repackCalls.find((candidate) => candidate.args?.[9]?.includes(
                `repack.${contributionId}.${platform}.config.mjs`,
            ));
            expect(call?.installableId).toBe('plugin-ui.bundler.repack');
            expect(call?.args?.slice(0, 8)).toEqual([
                'bundle', '--platform', platform, '--dev', 'false', '--minify', 'false', '--reset-cache',
            ]);
            expect(call?.args?.[8]).toBe('--config');
            expect(call?.args?.[9]).toContain(`repack.${contributionId}.${platform}.config.mjs`);
            expect(call?.cwd).not.toBe(projectRoot);
        }
        const manifest = PluginUiArtifactsManifestV1Schema.parse(JSON.parse(await readFile(
            join(projectRoot, 'dist/happier-plugin-ui/ui-artifacts.json'),
            'utf8',
        )));
        expect(manifest.entries.map((entry) => `${entry.tier}:${entry.contributionId}:${entry.platform}`).sort()).toEqual([
            'hostedWeb:review-openable-web:web',
            'hostedWeb:review-web:web',
            'reactNative:review-native:android',
            'reactNative:review-native:ios',
            'reactNative:review-native:web',
            'reactNative:review-openable-native:android',
            'reactNative:review-openable-native:ios',
            'reactNative:review-openable-native:web',
            'reactNative:voice-runtime-web:web',
        ]);
        expect(await readFile(
            join(projectRoot, 'dist/happier-plugin-ui/react-native/review-native/ios/ios.bundle'),
            'utf8',
        )).toBe('review ios');
    }, 30_000);

    it('loads one exact collection migration export into the RN web and native build artifacts', async () => {
        await writeFile(join(projectRoot, 'pluginUiBuild.mjs'), [
            "import { defineBuildConfig } from '@happier-dev/plugin-sdk/ui/build';",
            'export default defineBuildConfig({',
            "  outDir: 'dist/ui',",
            '  targets: [{',
            "    rendererId: 'migration-native',",
            "    entry: 'ui/migration.native.tsx',",
            "    kind: 'reactNative',",
            "    platforms: ['web', 'ios'],",
            "    module: { containerName: 'migration_native', modulePath: './renderSurface', exportName: 'renderSurface' },",
            "    collectionMigrations: { exportName: 'applyCollectionMigrations' },",
            '  }],',
            '});',
        ].join('\n'), 'utf8');
        const packageScope = join(projectRoot, 'node_modules/@happier-dev');
        await mkdir(packageScope, { recursive: true });
        await symlink(pluginSdkRoot, join(packageScope, 'plugin-sdk'), 'dir');
        const workRoot = join(projectRoot, 'dist/ui');
        for (const [relativePath, contents] of [
            ['react-native-web/migration-native/entry.mjs.bundle', 'web'],
            ['react-native/migration-native/ios/ios.bundle', 'ios'],
        ] as const) {
            const output = join(workRoot, relativePath);
            await mkdir(dirname(output), { recursive: true });
            await writeFile(output, contents, 'utf8');
        }

        const exitCode = await runPluginBuildUiCli({
            argv: ['--project-root', projectRoot],
            exec: createSuccessfulManagedExec([]),
            resolveManagedBuildVersions: () => ({
                hostUiApiVersion,
                viteVersion: '7.3.1',
                repackVersion: '5.2.5',
                reactVersion,
                reactNativeVersion: '0.83.5',
            }),
        });

        expect(exitCode).toBe(0);
        const manifest = PluginUiArtifactsManifestV1Schema.parse(JSON.parse(await readFile(
            join(projectRoot, 'dist/happier-plugin-ui/ui-artifacts.json'),
            'utf8',
        )));
        const webArtifact = manifest.entries.find((entry) => entry.platform === 'web');
        const nativeArtifact = manifest.entries.find((entry) => entry.platform === 'ios');
        expect(webArtifact?.collectionMigrations).toEqual({ exportName: 'applyCollectionMigrations' });
        expect(nativeArtifact?.collectionMigrations).toEqual({
            containerName: 'migration_native',
            modulePath: './renderSurface',
            exportName: 'applyCollectionMigrations',
        });
    });

    it('fails closed for malformed or hosted-web collection migration declarations', async () => {
        const targets = [
            {
                target: {
                    kind: 'reactNative',
                    platforms: ['web'],
                    collectionMigrations: { exportName: 'applyCollectionMigrations', unknown: true },
                },
            },
            {
                target: {
                    kind: 'reactNative',
                    platforms: ['web'],
                    collectionMigrations: {},
                },
            },
            {
                target: {
                    kind: 'reactNative',
                    platforms: ['web'],
                    collectionMigrations: { exportName: ' ' },
                },
            },
            {
                target: {
                    kind: 'hostedWeb',
                    collectionMigrations: { exportName: 'applyCollectionMigrations' },
                },
            },
        ];

        for (const { target } of targets) {
            const errors: string[] = [];
            const exitCode = await runPluginBuildUiCli({
                argv: ['--project-root', projectRoot],
                loadConfig: async () => ({
                    targets: [{
                        rendererId: 'migration-target',
                        entry: 'ui/migration.tsx',
                        ...target,
                    }],
                }),
                onError: (message) => errors.push(message),
            });

            expect(exitCode).toBe(1);
            expect(errors.join('\n')).toContain('[config_invalid]');
        }
    });

    it('materializes standard RNW and Re.Pack configs inside one ephemeral builder work root', async () => {
        const workRoot = join(projectRoot, 'dist/ui');
        const emitted = [
            ['react-native-web/native-panel/entry.mjs.bundle', 'web'],
            ['react-native/native-panel/ios/ios.bundle', 'ios'],
            ['react-native/native-panel/android/android.bundle', 'android'],
        ] as const;
        for (const [relativePath, contents] of emitted) {
            const output = join(workRoot, relativePath);
            await mkdir(dirname(output), { recursive: true });
            await writeFile(output, contents, 'utf8');
        }
        const calls: ManagedBundlerLaunch[] = [];
        const generatedSources = new Map<string, string>();
        const repackOperationRoots = new Set<string>();
        const exec: ManagedBundlerExecService = {
            async run(input) {
                calls.push(input);
                const configFlagIndex = input.args?.indexOf('--config') ?? -1;
                const configPath = configFlagIndex < 0 ? undefined : input.args?.[configFlagIndex + 1];
                if (configPath) {
                    generatedSources.set(configPath, await readFile(configPath, 'utf8'));
                }
                if (input.installableId === 'plugin-ui.bundler.repack') {
                    repackOperationRoots.add(input.cwd ?? '');
                    await expect(readFile(join(input.cwd ?? '', 'package.json'), 'utf8')).resolves.toContain('private');
                    await expect(readFile(join(input.cwd ?? '', 'react-native.config.cjs'), 'utf8')).resolves.toContain(
                        '@callstack/repack/commands/rspack',
                    );
                }
                return { exitCode: 0, signal: null, stdout: '', stderr: '' };
            },
        };

        const exitCode = await runPluginBuildUiCli({
            argv: ['--project-root', projectRoot],
            loadConfig: async () => ({
                outDir: 'dist/ui',
                targets: [{
                    rendererId: 'native-panel',
                    entry: 'ui/nativePanel.tsx',
                    kind: 'reactNative',
                    platforms: ['web', 'ios', 'android'],
                    module: {
                        containerName: 'native_panel',
                        modulePath: './renderSurface',
                        exportName: 'renderSurface',
                    },
                }],
            }),
            exec,
            resolveManagedBuildVersions: () => ({
                hostUiApiVersion,
                viteVersion: '7.3.1',
                repackVersion: '5.2.5',
                reactVersion,
                reactNativeVersion: '0.83.5',
            }),
        });

        expect(exitCode).toBe(0);
        expect(calls).toHaveLength(3);
        for (const call of calls) {
            expect(call.args).toContain('--config');
        }
        expect(repackOperationRoots).toHaveLength(1);
        const [operationRoot] = [...repackOperationRoots];
        expect(operationRoot).not.toBe(projectRoot);
        const configSources = [...generatedSources.values()].join('\n');
        expect(configSources).toContain('createReactNativeWebVitePlugins');
        expect(configSources).toContain('createPluginUiPackageInstanceRepackPlugin');
        expect(configSources).toContain('native_panel');
        expect(configSources).toContain(join(projectRoot, 'ui/nativePanel.tsx'));
        expect(configSources).toContain(join(workRoot, 'react-native/native-panel/ios'));
        expect(configSources).toContain(join(workRoot, 'react-native/native-panel/android'));
        await expect(access(operationRoot!)).rejects.toMatchObject({ code: 'ENOENT' });
    });

    it('emits source-free real iOS Re.Pack maps while keeping artifacts deterministic across author roots, aliases, and packed dependency symlinks', async () => {
        const firstRootPath = join(projectRoot, 'external-author-a');
        const secondRootPath = join(projectRoot, 'external-author-b');
        const firstRootAlias = join(projectRoot, 'external-author-a-alias');
        const firstPackedDependencyRoot = join(projectRoot, 'hstack-pack-a', 'external-dependencies', 'portable-native-dependency');
        const secondPackedDependencyRoot = join(projectRoot, 'hstack-pack-b', 'external-dependencies', 'portable-native-dependency');
        await Promise.all([
            mkdir(firstRootPath, { recursive: true }),
            mkdir(secondRootPath, { recursive: true }),
        ]);
        const [firstRoot, secondRoot] = await Promise.all([
            realpath(firstRootPath),
            realpath(secondRootPath),
        ]);
        await symlink(firstRoot, firstRootAlias, process.platform === 'win32' ? 'junction' : 'dir');
        const operationRoots: string[] = [];
        const realRepackExec = createRealRepackExec(operationRoots);

        async function prepareFixture(root: string, packedDependencyRoot: string): Promise<void> {
            const entryPath = join(root, 'ui', 'nativeEntry.js');
            await Promise.all([
                mkdir(dirname(entryPath), { recursive: true }),
                mkdir(packedDependencyRoot, { recursive: true }),
            ]);
            await Promise.all([
                symlinkInstalledPackage(root, '@callstack/repack'),
                symlinkInstalledPackage(root, '@rspack/core'),
                symlinkInstalledPackage(root, 'react'),
                symlinkInstalledPackage(root, 'react-native'),
                writeFile(join(root, 'package.json'), '{"name":"portable-native-author","private":true,"type":"module"}\n', 'utf8'),
                writeFile(join(entryPath), [
                    "import { portableDependency } from 'portable-native-dependency';",
                    'export function renderSurface() { return portableDependency; }',
                    '',
                ].join('\n'), 'utf8'),
                writeFile(join(packedDependencyRoot, 'package.json'), JSON.stringify({
                    name: 'portable-native-dependency',
                    type: 'module',
                    exports: './index.js',
                }), 'utf8'),
                writeFile(join(packedDependencyRoot, 'index.js'), [
                    "const metadata = require('./metadata.json');",
                    'export const portableDependency = metadata.value;',
                    '',
                ].join('\n'), 'utf8'),
                writeFile(join(packedDependencyRoot, 'metadata.json'), '{"value":"packed-symlink"}\n', 'utf8'),
            ]);
            await symlink(
                packedDependencyRoot,
                join(root, 'node_modules', 'portable-native-dependency'),
                'dir',
            );
        }

        async function buildPreparedFixture(root: string, packedDependencyRoot: string) {
            const errors: string[] = [];
            const exitCode = await runPluginBuildUiCli({
                argv: ['--project-root', root],
                loadConfig: async () => ({
                    outDir: 'dist/ui',
                    targets: [{
                        rendererId: 'portable-native',
                        entry: 'ui/nativeEntry.js',
                        kind: 'reactNative',
                        platforms: ['ios'],
                        module: {
                            containerName: 'portable_native',
                            modulePath: './renderSurface',
                            exportName: 'renderSurface',
                        },
                    }],
                }),
                exec: realRepackExec,
                resolveManagedBuildVersions: () => ({
                    hostUiApiVersion,
                    repackVersion: '5.2.5',
                    reactVersion,
                    reactNativeVersion: '0.83.5',
                }),
                onError: (message) => errors.push(message),
            });

            expect(errors).toEqual([]);
            expect(exitCode).toBe(0);
            const manifest = PluginUiArtifactsManifestV1Schema.parse(JSON.parse(await readFile(
                join(root, 'dist/happier-plugin-ui/ui-artifacts.json'),
                'utf8',
            )));
            const entry = manifest.entries.find((candidate) => (
                candidate.tier === 'reactNative'
                && candidate.contributionId === 'portable-native'
                && candidate.platform === 'ios'
            ));
            expect(entry).toBeDefined();
            const files = await Promise.all(entry!.files.map(async (file) => ({
                relativePath: file.relativePath,
                bytes: await readFile(join(root, 'dist/happier-plugin-ui', file.relativePath)),
            })));
            const sourceMaps = files.filter((file) => file.relativePath.endsWith('.map'));
            expect(sourceMaps).not.toHaveLength(0);
            for (const sourceMap of sourceMaps) {
                const parsed = JSON.parse(sourceMap.bytes.toString('utf8')) as Readonly<{
                    mappings?: string;
                    sources?: readonly string[];
                    sourcesContent?: unknown;
                }>;
                expect(parsed.sources).not.toHaveLength(0);
                expect(parsed.mappings).not.toBe('');
                expect(parsed).not.toHaveProperty('sourcesContent');
            }
            return {
                entry,
                files,
                sourceMaps,
                forbiddenPaths: [
                    root,
                    await realpath(root),
                    packedDependencyRoot,
                    await realpath(packedDependencyRoot),
                ],
            };
        }

        async function buildFixture(root: string, packedDependencyRoot: string) {
            await prepareFixture(root, packedDependencyRoot);
            return await buildPreparedFixture(root, packedDependencyRoot);
        }

        const first = await buildFixture(firstRoot, firstPackedDependencyRoot);
        const alias = await buildPreparedFixture(firstRootAlias, firstPackedDependencyRoot);
        const second = await buildFixture(secondRoot, secondPackedDependencyRoot);
        expect(operationRoots).toHaveLength(3);
        expect(new Set(operationRoots)).toHaveLength(3);

        // A native Artifact graph is identified by its complete emitted tree,
        // not by the author root or a pack staging symlink target.
        for (const forbiddenPath of new Set([
            ...first.forbiddenPaths,
            ...alias.forbiddenPaths,
            ...second.forbiddenPaths,
            ...operationRoots,
        ])) {
            const portableForbiddenPath = forbiddenPath.replace(/\\/gu, '/');
            for (const snapshot of [first, alias, second]) {
                for (const file of snapshot.files) {
                    expect(file.relativePath).not.toContain(portableForbiddenPath);
                }
                for (const sourceMap of snapshot.sourceMaps) {
                    expect(sourceMap.bytes.toString('utf8')).not.toContain(portableForbiddenPath);
                }
            }
        }
        for (const operationRoot of operationRoots) {
            const operationRootIdentity = basename(operationRoot);
            for (const snapshot of [first, alias, second]) {
                for (const sourceMap of snapshot.sourceMaps) {
                    expect(sourceMap.bytes.toString('utf8')).not.toContain(operationRootIdentity);
                }
            }
        }
        const aliasToPhysicalRoot = relative(firstRootAlias, firstRoot).replace(/\\/gu, '/');
        expect(aliasToPhysicalRoot).not.toBe('');
        for (const sourceMap of alias.sourceMaps) {
            expect(sourceMap.bytes.toString('utf8')).not.toContain(aliasToPhysicalRoot);
        }
        expect(first.entry).toEqual(alias.entry);
        expect(first.files).toEqual(alias.files);
        expect(first.entry).toEqual(second.entry);
        expect(first.files).toEqual(second.files);
    }, 180_000);

    it('recognizes cross-volume Windows relative paths as absolute before source-map normalization', () => {
        const crossVolumePath = win32.relative(
            'C:\\plugin-alias',
            'D:\\plugin-physical\\.happier-plugin-ui-build-fixed\\repack\\init',
        );

        expect(win32.isAbsolute(crossVolumePath)).toBe(true);
    });

    it('builds the declared surfaces and exits 0', async () => {
        const output = join(projectRoot, 'dist/ui/hosted-web/examples.reviewWeb/index.html');
        await mkdir(dirname(output), { recursive: true });
        await writeFile(output, emitted[0]!.bytes);
        const calls: ManagedBundlerLaunch[] = [];
        const exitCode = await runPluginBuildUiCli({
            argv: ['--project-root', projectRoot],
            loadConfig: async () => config(),
            exec: createSuccessfulManagedExec(calls),
            resolveManagedBuildVersions: () => ({
                hostUiApiVersion,
                viteVersion: '7.3.1',
                reactVersion,
            }),
        });

        expect(exitCode).toBe(0);
        const manifestRaw = await readFile(
            join(projectRoot, 'dist/happier-plugin-ui/ui-artifacts.json'),
            'utf8',
        );
        const manifest = PluginUiArtifactsManifestV1Schema.parse(JSON.parse(manifestRaw));
        expect(manifest.entries[0]?.digest).toBe(
            computePluginUiArtifactFileSetSha256DigestV1(emitted),
        );
        expect(calls).toHaveLength(1);
        expect(calls[0]).toMatchObject({ installableId: 'plugin-ui.bundler.vite' });
        expect(calls[0]?.args?.[0]).toBe('build');
        expect(calls[0]?.args).toContain('--config');
    });

    it('builds a standard hosted surface through its generated Vite config without author config files', async () => {
        const require = createRequire(import.meta.url);
        const vitePackageRoot = dirname(require.resolve('vite/package.json'));
        await mkdir(join(projectRoot, 'node_modules'), { recursive: true });
        await symlink(vitePackageRoot, join(projectRoot, 'node_modules', 'vite'), 'dir');
        await mkdir(join(projectRoot, 'ui'), { recursive: true });
        await writeFile(join(projectRoot, 'ui', 'surface.js'), 'document.body.dataset.surface = "standard";\n', 'utf8');
        const launches: ManagedBundlerLaunch[] = [];
        const generatedConfigSources = new Map<string, string>();
        const realExec = createRealViteExec();

        const exitCode = await runPluginBuildUiCli({
            argv: ['--project-root', projectRoot],
            loadConfig: async () => ({
                outDir: 'dist/ui',
                targets: [{
                    rendererId: 'standard-hosted',
                    entry: 'ui/surface.js',
                    kind: 'hostedWeb',
                }],
            }),
            exec: {
                async run(input, options) {
                    launches.push(input);
                    const configFlagIndex = input.args?.indexOf('--config') ?? -1;
                    const configPath = configFlagIndex < 0 ? undefined : input.args?.[configFlagIndex + 1];
                    if (configPath) generatedConfigSources.set(configPath, await readFile(configPath, 'utf8'));
                    return await realExec.run(input, options);
                },
            },
            resolveManagedBuildVersions: () => ({
                hostUiApiVersion,
                viteVersion: '7.3.1',
                reactVersion,
            }),
        });

        expect(launches).toHaveLength(1);
        expect(launches[0]?.cwd).toContain('.happier-plugin-ui-build-');
        expect(launches[0]?.cwd).toContain('hosted-web.standard-hosted');
        expect([...generatedConfigSources.values()].join('\n')).toContain(
            `root: ${JSON.stringify(launches[0]?.cwd)},`,
        );
        expect(exitCode).toBe(0);
        const indexHtml = await readFile(
            join(projectRoot, 'dist/happier-plugin-ui/hosted-web/standard-hosted/index.html'),
            'utf8',
        );
        expect(indexHtml).toContain('<script');
        expect(indexHtml).toContain('assets/');
    }, 60_000);

    it('builds and stages a plain-DOM hosted artifact from an SDK-and-Vite-only project', async () => {
        const require = createRequire(import.meta.url);
        const vitePackageRoot = dirname(require.resolve('vite/package.json'));
        const packageScope = join(projectRoot, 'node_modules', '@happier-dev');
        await mkdir(packageScope, { recursive: true });
        await symlink(vitePackageRoot, join(projectRoot, 'node_modules', 'vite'), 'dir');
        await symlink(process.cwd(), join(packageScope, 'plugin-sdk'), 'dir');
        await writeFile(join(projectRoot, 'package.json'), '{"name":"plain-dom-hosted-fixture","type":"module"}\n', 'utf8');
        await writeFile(join(projectRoot, 'pluginUiBuild.mjs'), [
            "import { defineBuildConfig } from '@happier-dev/plugin-sdk/ui/build';",
            'export default defineBuildConfig({',
            "  outDir: 'dist/ui',",
            "  targets: [{ rendererId: 'plain-dom', entry: 'ui/surface.js', kind: 'hostedWeb' }],",
            '});',
            '',
        ].join('\n'), 'utf8');
        await mkdir(join(projectRoot, 'ui'), { recursive: true });
        await writeFile(
            join(projectRoot, 'ui', 'surface.js'),
            "const panel = document.createElement('main'); panel.textContent = 'plain DOM'; document.body.append(panel);\n",
            'utf8',
        );
        await expect(access(join(projectRoot, 'node_modules', 'react'))).rejects.toMatchObject({ code: 'ENOENT' });

        const exitCode = await runPluginBuildUiCli({
            argv: ['--project-root', projectRoot],
            exec: createRealViteExec(),
        });

        expect(exitCode).toBe(0);
        const manifest = PluginUiArtifactsManifestV1Schema.parse(JSON.parse(await readFile(
            join(projectRoot, 'dist/happier-plugin-ui/ui-artifacts.json'),
            'utf8',
        )));
        expect(manifest.entries).toEqual([expect.objectContaining({
            contributionId: 'plain-dom',
            tier: 'hostedWeb',
            platform: 'web',
            compat: {},
        })]);
        await expect(readFile(
            join(projectRoot, 'dist/happier-plugin-ui/hosted-web/plain-dom/index.html'),
            'utf8',
        )).resolves.toContain('<script');
    }, 60_000);

    it('wraps an advanced RNW Vite config with the canonical host-runtime and package-instance checks', async () => {
        const workRoot = join(projectRoot, 'dist/ui');
        const emittedEntry = join(workRoot, 'react-native-web/advanced-native/entry.mjs.bundle');
        const authorConfigPath = join(projectRoot, 'build/vite.advanced.config.mjs');
        await mkdir(dirname(emittedEntry), { recursive: true });
        await writeFile(emittedEntry, 'export const advanced = true;\n', 'utf8');
        await mkdir(dirname(authorConfigPath), { recursive: true });
        // A real external author may need this option, but must not have to
        // remember the SDK-owned host-runtime or physical-package guards.
        await writeFile(authorConfigPath, "export default { esbuild: { jsx: 'automatic' } };\n", 'utf8');

        const calls: ManagedBundlerLaunch[] = [];
        const generatedConfigSources = new Map<string, string>();
        const exitCode = await runPluginBuildUiCli({
            argv: ['--project-root', projectRoot],
            loadConfig: async () => ({
                outDir: 'dist/ui',
                targets: [{
                    rendererId: 'advanced-native',
                    entry: 'ui/advanced.native.tsx',
                    kind: 'reactNative',
                    platforms: ['web'],
                    bundlerConfig: 'build/vite.advanced.config.mjs',
                }],
            }),
            exec: {
                async run(input) {
                    calls.push(input);
                    const configFlagIndex = input.args?.indexOf('--config') ?? -1;
                    const configPath = configFlagIndex < 0 ? undefined : input.args?.[configFlagIndex + 1];
                    if (configPath) generatedConfigSources.set(configPath, await readFile(configPath, 'utf8'));
                    return { exitCode: 0, signal: null, stdout: '', stderr: '' };
                },
            },
            resolveManagedBuildVersions: () => ({
                hostUiApiVersion,
                viteVersion: '7.3.1',
                reactVersion,
                reactNativeVersion: '0.83.5',
            }),
        });

        expect(exitCode).toBe(0);
        expect(calls).toHaveLength(1);
        const generatedConfigPath = calls[0]?.args?.[2];
        expect(generatedConfigPath).toContain('.happier-plugin-ui-build-');
        expect(generatedConfigPath).not.toBe(authorConfigPath);
        const generatedConfigSource = generatedConfigSources.get(generatedConfigPath ?? '');
        expect(generatedConfigSource).toContain(JSON.stringify(authorConfigPath));
        expect(generatedConfigSource).toContain('mergeConfig');
        expect(generatedConfigSource).toContain('createReactNativeWebVitePlugins');
    });

    it('keeps RNW root, entry, output, externals, and the physical plugin-ui guard canonical after post-order author hooks', async () => {
        const require = createRequire(import.meta.url);
        const vitePackageRoot = dirname(require.resolve('vite/package.json'));
        const viteReactPackageRoot = dirname(dirname(require.resolve('@vitejs/plugin-react')));
        const authorConfigPath = join(projectRoot, 'build/vite.hook.config.mjs');
        const incorrectRoot = join(projectRoot, 'incorrect-author-root');
        const incorrectOutputRoot = join(projectRoot, 'incorrect-author-output');
        const incorrectClientOutputRoot = join(projectRoot, 'incorrect-author-client-output');
        const authorEntryPath = join(projectRoot, 'ui/author-entry.js');
        const packageScope = join(projectRoot, 'node_modules', '@happier-dev');
        const pluginUiRoot = join(packageScope, 'plugin-ui');
        const reactPackageRoot = dirname(require.resolve('react/package.json'));
        const incorrectReactRoot = join(incorrectRoot, 'node_modules', 'react');
        await Promise.all([
            mkdir(packageScope, { recursive: true }),
            mkdir(join(projectRoot, 'node_modules', '@vitejs'), { recursive: true }),
            mkdir(join(projectRoot, 'ui'), { recursive: true }),
            mkdir(dirname(authorConfigPath), { recursive: true }),
            mkdir(pluginUiRoot, { recursive: true }),
            mkdir(incorrectReactRoot, { recursive: true }),
        ]);
        await Promise.all([
            symlink(vitePackageRoot, join(projectRoot, 'node_modules', 'vite'), 'dir'),
            symlink(viteReactPackageRoot, join(projectRoot, 'node_modules', '@vitejs', 'plugin-react'), 'dir'),
            symlink(pluginSdkRoot, join(packageScope, 'plugin-sdk'), 'dir'),
            symlink(reactPackageRoot, join(projectRoot, 'node_modules', 'react'), 'dir'),
            writeFile(join(projectRoot, 'package.json'), '{"name":"rnw-config-hook-fixture","type":"module"}\n', 'utf8'),
            writeFile(join(pluginUiRoot, 'package.json'), '{"name":"@happier-dev/plugin-ui","type":"module","exports":"./index.js"}\n', 'utf8'),
            writeFile(join(pluginUiRoot, 'index.js'), 'export const pluginUiSentinel = "bundled-plugin-ui";\n', 'utf8'),
            writeFile(join(incorrectReactRoot, 'package.json'), '{"name":"react","type":"module","exports":"./index.js"}\n', 'utf8'),
            writeFile(join(incorrectReactRoot, 'index.js'), 'export const notUseState = true;\n', 'utf8'),
            writeFile(authorEntryPath, 'export const authorEntry = true;\n', 'utf8'),
            writeFile(join(projectRoot, 'ui', 'surface.js'), [
                "import { pluginUiSentinel } from '@happier-dev/plugin-ui';",
                "import { useState } from 'react';",
                'export const renderSurface = () => [pluginUiSentinel, useState];',
                '',
            ].join('\n'), 'utf8'),
            writeFile(authorConfigPath, [
                'export default {',
                '  plugins: [{',
                "    name: 'author-attempted-managed-config-override',",
                '    config: {',
                "      order: 'post',",
                '      handler() {',
                '        return {',
                `          root: ${JSON.stringify(incorrectRoot)},`,
                '          build: {',
                `            outDir: ${JSON.stringify(incorrectOutputRoot)},`,
                '            lib: {',
                `              entry: ${JSON.stringify(authorEntryPath)},`,
                "              formats: ['es', 'cjs'],",
                "              fileName: () => 'author-entry.mjs',",
                '            },',
                '            rollupOptions: {',
                `              input: ${JSON.stringify(authorEntryPath)},`,
                "              external: ['@happier-dev/plugin-ui'],",
                `              output: { dir: ${JSON.stringify(incorrectOutputRoot)} },`,
                '            },',
                '          },',
                '        };',
                '      },',
                '    },',
                '    configEnvironment: {',
                "      order: 'post',",
                '      handler(name) {',
                "        if (name !== 'client') return;",
                '        return {',
                '          build: {',
                `            outDir: ${JSON.stringify(incorrectClientOutputRoot)},`,
                '            lib: {',
                `              entry: ${JSON.stringify(authorEntryPath)},`,
                "              formats: ['es', 'cjs'],",
                "              fileName: () => 'author-entry.mjs',",
                '            },',
                '            rollupOptions: {',
                `              input: ${JSON.stringify(authorEntryPath)},`,
                "              external: ['@happier-dev/plugin-ui'],",
                `              output: { dir: ${JSON.stringify(incorrectClientOutputRoot)} },`,
                '            },',
                '          },',
                '        };',
                '      },',
                '    },',
                '  }],',
                '};',
                '',
            ].join('\n'), 'utf8'),
        ]);

        const launches: ManagedBundlerLaunch[] = [];
        const exitCode = await runPluginBuildUiCli({
            argv: ['--project-root', projectRoot],
            loadConfig: async () => ({
                outDir: 'dist/ui',
                targets: [{
                    rendererId: 'hook-guarded-native',
                    entry: 'ui/surface.js',
                    kind: 'reactNative',
                    platforms: ['web'],
                    bundlerConfig: 'build/vite.hook.config.mjs',
                }],
            }),
            exec: {
                async run(input, options) {
                    launches.push(input);
                    return await createRealViteExec().run(input, options);
                },
            },
            resolveManagedBuildVersions: () => ({
                hostUiApiVersion,
                viteVersion: '7.3.1',
                reactVersion,
                reactNativeVersion: '0.83.5',
            }),
        });

        expect(exitCode).toBe(0);
        await expect(access(incorrectOutputRoot)).rejects.toMatchObject({ code: 'ENOENT' });
        await expect(access(incorrectClientOutputRoot)).rejects.toMatchObject({ code: 'ENOENT' });
        expect(launches[0]?.cwd).toContain('.happier-plugin-ui-build-');
        const builtSource = await readFile(
            join(projectRoot, 'dist/happier-plugin-ui/react-native-web/hook-guarded-native/entry.mjs.bundle'),
            'utf8',
        );
        expect(builtSource).toContain('bundled-plugin-ui');
        expect(builtSource).not.toContain('@happier-dev/plugin-ui');
        expect(builtSource).not.toContain('author-entry');
    }, 60_000);

    it('keeps hosted Vite root, output, artifact closure, and client environment canonical after post-order author hooks', async () => {
        const require = createRequire(import.meta.url);
        const vitePackageRoot = dirname(require.resolve('vite/package.json'));
        const authorConfigPath = join(projectRoot, 'build/vite.extension.config.ts');
        const incorrectRoot = join(projectRoot, 'incorrect-author-root');
        const incorrectOutputRoot = join(projectRoot, 'incorrect-author-output');
        const incorrectClientOutputRoot = join(projectRoot, 'incorrect-author-client-output');
        const incorrectInputPath = join(projectRoot, 'author-input.html');
        const externalPackageRoot = join(projectRoot, 'node_modules', 'plain-dom-sentinel');
        await mkdir(join(projectRoot, 'node_modules'), { recursive: true });
        await symlink(vitePackageRoot, join(projectRoot, 'node_modules', 'vite'), 'dir');
        await Promise.all([
            mkdir(join(projectRoot, 'ui'), { recursive: true }),
            mkdir(externalPackageRoot, { recursive: true }),
        ]);
        await mkdir(dirname(authorConfigPath), { recursive: true });
        await Promise.all([
            writeFile(
                join(projectRoot, 'ui', 'surface.js'),
                [
                    "import { plainDomSentinel } from 'plain-dom-sentinel';",
                    "import { rootMarker } from '/root-marker.js';",
                    'document.body.dataset.authorExtension = __AUTHOR_EXTENSION__;',
                    'document.body.dataset.external = plainDomSentinel;',
                    'document.body.dataset.root = rootMarker;',
                    '',
                ].join('\n'),
                'utf8',
            ),
            writeFile(
                join(externalPackageRoot, 'package.json'),
                '{"name":"plain-dom-sentinel","type":"module","exports":"./index.js"}\n',
                'utf8',
            ),
            writeFile(
                join(externalPackageRoot, 'index.js'),
                'export const plainDomSentinel = "plain-dom-dependency";\n',
                'utf8',
            ),
            writeFile(
                incorrectInputPath,
                '<!doctype html><html><body>author input</body></html>\n',
                'utf8',
            ),
        ]);
        await writeFile(authorConfigPath, [
            "import { writeFileSync } from 'node:fs';",
            "import { join } from 'node:path';",
            'export default () => ({',
            "  define: { __AUTHOR_EXTENSION__: JSON.stringify('extension-applied') },",
            '  plugins: [{',
            "    name: 'author-post-order-managed-config-override',",
            '    config: {',
            "      order: 'post',",
            '      handler(config) {',
            "        writeFileSync(join(config.root, 'root-marker.js'), 'export const rootMarker = \\\"managed-root\\\";\\n', 'utf8');",
            '        return {',
            `          root: ${JSON.stringify(incorrectRoot)},`,
            '          build: {',
            `            outDir: ${JSON.stringify(incorrectOutputRoot)},`,
            '            lib: { entry: ' + JSON.stringify(incorrectInputPath) + ' },',
            '            rollupOptions: {',
            `              input: ${JSON.stringify(incorrectInputPath)},`,
            "              external: ['plain-dom-sentinel'],",
            `              output: { dir: ${JSON.stringify(incorrectOutputRoot)} },`,
            '            },',
            '          },',
            '        };',
            '      },',
            '    },',
            '    configEnvironment: {',
            "      order: 'post',",
            '      handler(name) {',
            "        if (name !== 'client') return;",
            '        return {',
            '          build: {',
            `            outDir: ${JSON.stringify(incorrectClientOutputRoot)},`,
            '            lib: { entry: ' + JSON.stringify(incorrectInputPath) + ' },',
            '            rollupOptions: {',
            `              input: ${JSON.stringify(incorrectInputPath)},`,
            "              external: ['plain-dom-sentinel'],",
            `              output: { dir: ${JSON.stringify(incorrectClientOutputRoot)} },`,
            '            },',
            '          },',
            '        };',
            '      },',
            '    },',
            '  }],',
            '});',
            '',
        ].join('\n'), 'utf8');

        const launches: ManagedBundlerLaunch[] = [];
        const realExec = createRealViteExec();
        const exitCode = await runPluginBuildUiCli({
            argv: ['--project-root', projectRoot],
            loadConfig: async () => ({
                outDir: 'dist/ui',
                targets: [{
                    rendererId: 'advanced-hosted',
                    entry: 'ui/surface.js',
                    kind: 'hostedWeb',
                    bundlerConfig: 'build/vite.extension.config.ts',
                }],
            }),
            exec: {
                async run(input, options) {
                    launches.push(input);
                    return await realExec.run(input, options);
                },
            },
            resolveManagedBuildVersions: () => ({
                hostUiApiVersion,
                viteVersion: '7.3.1',
                reactVersion,
            }),
        });

        expect(exitCode).toBe(0);
        expect(launches[0]?.args?.[2]).toContain('.happier-plugin-ui-build-');
        await expect(access(incorrectOutputRoot)).rejects.toMatchObject({ code: 'ENOENT' });
        await expect(access(incorrectClientOutputRoot)).rejects.toMatchObject({ code: 'ENOENT' });
        expect(launches[0]?.cwd).toContain('.happier-plugin-ui-build-');
        const outputRoot = join(projectRoot, 'dist/happier-plugin-ui/hosted-web/advanced-hosted');
        const indexHtml = await readFile(join(outputRoot, 'index.html'), 'utf8');
        const scriptPath = indexHtml.match(/src="\.\/([^"]+\.js)"/u)?.[1];
        expect(scriptPath).toBeDefined();
        const builtSource = await readFile(join(outputRoot, scriptPath!), 'utf8');
        expect(builtSource).toContain('extension-applied');
        expect(builtSource).toContain('managed-root');
        expect(builtSource).toContain('plain-dom-dependency');
        expect(builtSource).not.toContain('plain-dom-sentinel');
    }, 60_000);

    it('rejects an author configResolved hook before it can mutate managed hosted Vite ownership', async () => {
        const require = createRequire(import.meta.url);
        const vitePackageRoot = dirname(require.resolve('vite/package.json'));
        const authorConfigPath = join(projectRoot, 'build/vite.config-resolved.config.mjs');
        const mutationReachedPath = join(projectRoot, 'author-config-resolved-ran');
        const incorrectRoot = join(projectRoot, 'incorrect-author-root');
        const incorrectOutputRoot = join(projectRoot, 'incorrect-author-output');
        const incorrectInputPath = join(projectRoot, 'author-input.html');
        await Promise.all([
            mkdir(join(projectRoot, 'node_modules'), { recursive: true }),
            mkdir(join(projectRoot, 'ui'), { recursive: true }),
            mkdir(dirname(authorConfigPath), { recursive: true }),
            mkdir(incorrectRoot, { recursive: true }),
        ]);
        await Promise.all([
            symlink(vitePackageRoot, join(projectRoot, 'node_modules', 'vite'), 'dir'),
            writeFile(join(projectRoot, 'package.json'), '{"name":"config-resolved-rejection-fixture","type":"module"}\n', 'utf8'),
            writeFile(join(projectRoot, 'ui', 'surface.js'), 'document.body.dataset.surface = "managed";\n', 'utf8'),
            writeFile(incorrectInputPath, '<!doctype html><html><body>author input</body></html>\n', 'utf8'),
            writeFile(authorConfigPath, [
                "import { writeFile } from 'node:fs/promises';",
                `const mutationReachedPath = ${JSON.stringify(mutationReachedPath)};`,
                'export default {',
                '  plugins: [{',
                "    name: 'author-config-resolved-mutation',",
                "    enforce: 'post',",
                '    configResolved: {',
                "      order: 'post',",
                '      async handler(config) {',
                `        config.root = ${JSON.stringify(incorrectRoot)};`,
                '        config.build.outDir = ' + JSON.stringify(incorrectOutputRoot) + ';',
                '        config.build.rollupOptions ??= {};',
                '        config.build.rollupOptions.input = ' + JSON.stringify(incorrectInputPath) + ';',
                "        config.build.rollupOptions.external = ['plain-dom-sentinel'];",
                '        config.environments.client.build.outDir = ' + JSON.stringify(incorrectOutputRoot) + ';',
                '        config.environments.client.build.rollupOptions ??= {};',
                '        config.environments.client.build.rollupOptions.input = ' + JSON.stringify(incorrectInputPath) + ';',
                "        config.environments.client.build.rollupOptions.external = ['plain-dom-sentinel'];",
                '        config.plugins = [];',
                '        config.environments.client.plugins = [];',
                "        await writeFile(mutationReachedPath, 'author configResolved ran\\n', 'utf8');",
                '      },',
                '    },',
                '  }],',
                '};',
                '',
            ].join('\n'), 'utf8'),
        ]);
        const errors: string[] = [];

        const exitCode = await runPluginBuildUiCli({
            argv: ['--project-root', projectRoot],
            loadConfig: async () => ({
                outDir: 'dist/ui',
                targets: [{
                    rendererId: 'config-resolved-hosted',
                    entry: 'ui/surface.js',
                    kind: 'hostedWeb',
                    bundlerConfig: 'build/vite.config-resolved.config.mjs',
                }],
            }),
            exec: createRealViteExec(),
            resolveManagedBuildVersions: () => ({
                hostUiApiVersion,
                viteVersion: '7.3.1',
                reactVersion,
            }),
            onError: (message) => errors.push(message),
        });

        expect(exitCode).toBe(1);
        expect(errors.join('\n')).toContain('must not register configResolved');
        await expect(access(mutationReachedPath)).rejects.toMatchObject({ code: 'ENOENT' });
        await expect(access(join(projectRoot, 'dist/happier-plugin-ui/hosted-web/config-resolved-hosted')))
            .rejects.toMatchObject({ code: 'ENOENT' });
    }, 60_000);

    it('does not leak the parent staged-dist authority into managed Vite or Re.Pack children', async () => {
        const stagedDist = join(projectRoot, '.workspace-staged-dist');
        const capturesRoot = join(projectRoot, 'captures');
        const viteCapture = join(capturesRoot, 'vite.json');
        const repackCapture = (platform: string) => join(capturesRoot, `repack-${platform}.json`);
        const vitePackageRoot = join(projectRoot, 'node_modules', 'vite');
        const reactNativePackageRoot = join(projectRoot, 'node_modules', 'react-native');
        await Promise.all([
            mkdir(join(vitePackageRoot, 'bin'), { recursive: true }),
            mkdir(reactNativePackageRoot, { recursive: true }),
            mkdir(stagedDist, { recursive: true }),
        ]);
        await writeFile(join(projectRoot, 'package.json'), '{"name":"plugin-ui-child-env-fixture"}\n', 'utf8');
        await writeFile(join(vitePackageRoot, 'package.json'), '{"name":"vite","version":"7.3.1"}\n', 'utf8');
        await writeFile(join(reactNativePackageRoot, 'package.json'), '{"name":"react-native","version":"0.83.5"}\n', 'utf8');
        await writeFile(
            join(vitePackageRoot, 'bin', 'vite.js'),
            [
                "const { mkdirSync, writeFileSync } = require('node:fs');",
                "const { dirname } = require('node:path');",
                `const capture = ${JSON.stringify(viteCapture)};`,
                `const output = ${JSON.stringify(join(projectRoot, 'work/react-native-web/native/entry.mjs.bundle'))};`,
                "mkdirSync(dirname(capture), { recursive: true });",
                "writeFileSync(capture, JSON.stringify({ stagedOutput: process.env.HAPPIER_WORKSPACE_DIST_OUTPUT_DIR ?? null, stagedOutputAlias: process.env.Happier_Workspace_Dist_Output_Dir ?? null }));",
                "mkdirSync(dirname(output), { recursive: true });",
                "writeFileSync(output, 'export const platform = \\\"web\\\";\\n');",
            ].join('\n'),
            'utf8',
        );
        await writeFile(
            join(reactNativePackageRoot, 'cli.js'),
            [
                "const { mkdirSync, writeFileSync } = require('node:fs');",
                "const { dirname, join } = require('node:path');",
                "const platform = process.argv[process.argv.indexOf('--platform') + 1];",
                `const capture = ${JSON.stringify(capturesRoot)} + '/repack-' + platform + '.json';`,
                `const output = join(${JSON.stringify(join(projectRoot, 'work', 'react-native', 'native'))}, platform, platform + '.bundle');`,
                "mkdirSync(dirname(capture), { recursive: true });",
                "writeFileSync(capture, JSON.stringify({ stagedOutput: process.env.HAPPIER_WORKSPACE_DIST_OUTPUT_DIR ?? null, stagedOutputAlias: process.env.Happier_Workspace_Dist_Output_Dir ?? null }));",
                "mkdirSync(dirname(output), { recursive: true });",
                "writeFileSync(output, 'export const platform = ' + JSON.stringify(platform) + ';\\n');",
            ].join('\n'),
            'utf8',
        );
        await writeFile(join(stagedDist, 'index.js'), 'export const stagedTypeScriptOutput = true;\n', 'utf8');

        const previousStagedOutput = process.env.HAPPIER_WORKSPACE_DIST_OUTPUT_DIR;
        const previousStagedOutputAlias = process.env.Happier_Workspace_Dist_Output_Dir;
        process.env.HAPPIER_WORKSPACE_DIST_OUTPUT_DIR = stagedDist;
        process.env.Happier_Workspace_Dist_Output_Dir = `${stagedDist}-mixed-case-alias`;
        try {
            const exitCode = await runPluginBuildUiCli({
                argv: ['--project-root', projectRoot],
                loadConfig: async () => ({
                    outDir: 'work',
                    targets: [{
                        rendererId: 'native',
                        entry: 'ui/native.tsx',
                        kind: 'reactNative',
                        platforms: ['web', 'ios', 'android'],
                        module: {
                            containerName: 'fixture_native',
                            modulePath: './renderSurface',
                            exportName: 'renderSurface',
                        },
                    }],
                }),
                resolveManagedBuildVersions: () => ({
                    hostUiApiVersion,
                    viteVersion: '7.3.1',
                    repackVersion: '5.2.5',
                    reactVersion,
                    reactNativeVersion: '0.83.5',
                }),
            });

            expect(exitCode).toBe(0);
            const captures = await Promise.all([
                viteCapture,
                repackCapture('ios'),
                repackCapture('android'),
            ].map(async (capture) => JSON.parse(await readFile(capture, 'utf8')) as Readonly<{
                stagedOutput: string | null;
                stagedOutputAlias: string | null;
            }>));
            expect(captures).toEqual([
                { stagedOutput: null, stagedOutputAlias: null },
                { stagedOutput: null, stagedOutputAlias: null },
                { stagedOutput: null, stagedOutputAlias: null },
            ]);
            await expect(readFile(join(stagedDist, 'index.js'), 'utf8')).resolves.toContain('stagedTypeScriptOutput');
            await expect(readFile(join(stagedDist, 'happier-plugin-ui/ui-artifacts.json'), 'utf8')).resolves.toContain('"version": 1');
        } finally {
            if (previousStagedOutput === undefined) {
                delete process.env.HAPPIER_WORKSPACE_DIST_OUTPUT_DIR;
            } else {
                process.env.HAPPIER_WORKSPACE_DIST_OUTPUT_DIR = previousStagedOutput;
            }
            if (previousStagedOutputAlias === undefined) {
                delete process.env.Happier_Workspace_Dist_Output_Dir;
            } else {
                process.env.Happier_Workspace_Dist_Output_Dir = previousStagedOutputAlias;
            }
        }
    }, 10_000);

    it('treats hosted-web as one portable web graph without an author-owned platform list', async () => {
        const output = join(projectRoot, 'dist/ui/hosted-web/examples.reviewWeb/index.html');
        await mkdir(dirname(output), { recursive: true });
        await writeFile(output, emitted[0]!.bytes);
        const errors: string[] = [];

        const exitCode = await runPluginBuildUiCli({
            argv: ['--project-root', projectRoot],
            loadConfig: async () => ({
                outDir: 'dist/ui',
                targets: [{
                    rendererId: 'examples.reviewWeb',
                    entry: 'ui/reviewPanel.web.tsx',
                    kind: 'hostedWeb',
                }],
            }),
            exec: createSuccessfulManagedExec([]),
            resolveManagedBuildVersions: () => ({
                hostUiApiVersion,
                viteVersion: '7.3.1',
                reactVersion,
            }),
            onError: (message) => errors.push(message),
        });

        expect(exitCode).toBe(0);
        expect(errors).toEqual([]);
    });

    it('rejects a retired hosted-web platforms field before invoking a bundler', async () => {
        const errors: string[] = [];
        const calls: ManagedBundlerLaunch[] = [];

        const exitCode = await runPluginBuildUiCli({
            argv: ['--project-root', projectRoot],
            loadConfig: async () => ({
                targets: [{
                    rendererId: 'examples.reviewWeb',
                    entry: 'ui/reviewPanel.web.tsx',
                    kind: 'hostedWeb',
                    platforms: ['web'],
                }],
            }),
            exec: createSuccessfulManagedExec(calls),
            resolveManagedBuildVersions: () => ({
                hostUiApiVersion,
                viteVersion: '7.3.1',
                reactVersion,
            }),
            onError: (message) => errors.push(message),
        });

        expect(exitCode).toBe(1);
        expect(calls).toEqual([]);
        expect(errors.join('\n')).toContain('[config_invalid]');
        expect(errors.join('\n')).toContain('does not accept platforms');
    });

    it('materializes distinct Vite configs for multiple standard surfaces without author config files', async () => {
        const firstOutput = join(projectRoot, 'dist/ui/hosted-web/first-web/index.html');
        const secondOutput = join(projectRoot, 'dist/ui/hosted-web/second-web/index.html');
        await mkdir(dirname(firstOutput), { recursive: true });
        await mkdir(dirname(secondOutput), { recursive: true });
        await writeFile(firstOutput, '<!doctype html><title>first</title>', 'utf8');
        await writeFile(secondOutput, '<!doctype html><title>second</title>', 'utf8');
        const calls: ManagedBundlerLaunch[] = [];

        const exitCode = await runPluginBuildUiCli({
            argv: ['--project-root', projectRoot],
            loadConfig: async () => ({
                targets: [
                    {
                        rendererId: 'first-web',
                        entry: 'ui/first.tsx',
                        kind: 'hostedWeb',
                    },
                    {
                        rendererId: 'second-web',
                        entry: 'ui/second.tsx',
                        kind: 'hostedWeb',
                    },
                ],
            }),
            exec: createSuccessfulManagedExec(calls),
            resolveManagedBuildVersions: () => ({
                hostUiApiVersion,
                viteVersion: '7.3.1',
                reactVersion,
            }),
        });

        expect(exitCode).toBe(0);
        expect(calls).toHaveLength(2);
        const configPaths = calls.map((call) => {
            expect(call.installableId).toBe('plugin-ui.bundler.vite');
            expect(call.args?.[0]).toBe('build');
            expect(call.args?.[1]).toBe('--config');
            return call.args?.[2];
        });
        expect(new Set(configPaths).size).toBe(2);
    });

    it('allows one advanced Vite extension to serve multiple generated surfaces', async () => {
        const firstOutput = join(projectRoot, 'dist/ui/hosted-web/first-web/index.html');
        const secondOutput = join(projectRoot, 'dist/ui/hosted-web/second-web/index.html');
        await mkdir(dirname(firstOutput), { recursive: true });
        await mkdir(dirname(secondOutput), { recursive: true });
        await writeFile(firstOutput, '<!doctype html><title>first</title>', 'utf8');
        await writeFile(secondOutput, '<!doctype html><title>second</title>', 'utf8');
        const calls: ManagedBundlerLaunch[] = [];

        const exitCode = await runPluginBuildUiCli({
            argv: ['--project-root', projectRoot],
            loadConfig: async () => ({
                targets: [
                    {
                        rendererId: 'first-web',
                        entry: 'ui/first.tsx',
                        kind: 'hostedWeb',
                        bundlerConfig: 'build/vite.shared.config.ts',
                    },
                    {
                        rendererId: 'second-web',
                        entry: 'ui/second.tsx',
                        kind: 'hostedWeb',
                        bundlerConfig: './build/vite.shared.config.ts',
                    },
                ],
            }),
            exec: createSuccessfulManagedExec(calls),
            resolveManagedBuildVersions: () => ({
                hostUiApiVersion,
                viteVersion: '7.3.1',
                reactVersion,
            }),
        });

        expect(exitCode).toBe(0);
        expect(calls).toHaveLength(2);
        const configPaths = calls.map((call) => call.args?.[2]);
        expect(new Set(configPaths).size).toBe(2);
        expect(configPaths.every((configPath) => configPath?.includes('.happier-plugin-ui-build-'))).toBe(true);
    });

    it('uses distinct generated config paths for every Vite surface in a multi-surface build', async () => {
        const firstOutput = join(projectRoot, 'dist/ui/hosted-web/first-web/index.html');
        const secondOutput = join(projectRoot, 'dist/ui/hosted-web/second-web/index.html');
        await mkdir(dirname(firstOutput), { recursive: true });
        await mkdir(dirname(secondOutput), { recursive: true });
        await writeFile(firstOutput, '<!doctype html><title>first</title>', 'utf8');
        await writeFile(secondOutput, '<!doctype html><title>second</title>', 'utf8');
        const calls: ManagedBundlerLaunch[] = [];

        const exitCode = await runPluginBuildUiCli({
            argv: ['--project-root', projectRoot],
            loadConfig: async () => ({
                targets: [
                    {
                        rendererId: 'first-web',
                        entry: 'ui/first.tsx',
                        kind: 'hostedWeb',
                        bundlerConfig: 'build/vite.first.config.ts',
                    },
                    {
                        rendererId: 'second-web',
                        entry: 'ui/second.tsx',
                        kind: 'hostedWeb',
                        bundlerConfig: 'build/vite.second.config.ts',
                    },
                ],
            }),
            exec: createSuccessfulManagedExec(calls),
            resolveManagedBuildVersions: () => ({
                hostUiApiVersion,
                viteVersion: '7.3.1',
                reactVersion,
            }),
        });

        expect(exitCode).toBe(0);
        expect(calls.map((call) => call.installableId)).toEqual([
            'plugin-ui.bundler.vite',
            'plugin-ui.bundler.vite',
        ]);
        expect(calls.map((call) => call.args?.slice(0, 2))).toEqual([
            ['build', '--config'],
            ['build', '--config'],
        ]);
        const configPaths = calls.map((call) => call.args?.[2]);
        expect(new Set(configPaths).size).toBe(2);
        expect(configPaths[0]).toContain('.happier-plugin-ui-build-');
        expect(configPaths[0]).toContain('vite.first-web.config.mjs');
        expect(configPaths[1]).toContain('.happier-plugin-ui-build-');
        expect(configPaths[1]).toContain('vite.second-web.config.mjs');
    });

    it.each([
        '../outside/vite.config.ts',
        'C:/outside/vite.config.ts',
    ])('rejects an unsafe bundler config path before it can escape the project root (%s)', async (bundlerConfig) => {
        const errors: string[] = [];
        const exitCode = await runPluginBuildUiCli({
            argv: ['--project-root', projectRoot],
            loadConfig: async () => ({
                targets: [{
                    rendererId: 'preview-web',
                    entry: 'ui/preview.tsx',
                    kind: 'hostedWeb',
                    bundlerConfig,
                }],
            }),
            exec: createSuccessfulManagedExec([]),
            resolveManagedBuildVersions: () => ({
                hostUiApiVersion,
                viteVersion: '7.3.1',
                reactVersion,
            }),
            onError: (message) => errors.push(message),
        });

        expect(exitCode).toBe(1);
        expect(errors.join('\n')).toContain('[config_invalid]');
        expect(errors.join('\n')).toContain('bundlerConfig must be a relative path without parent traversal');
    });

    it('fails the selected-config build when its declared surface entry is not emitted', async () => {
        const output = join(projectRoot, 'dist/ui/hosted-web/examples.reviewWeb/other.html');
        await mkdir(dirname(output), { recursive: true });
        await writeFile(output, 'x', 'utf8');
        const calls: ManagedBundlerLaunch[] = [];
        const errors: string[] = [];

        const exitCode = await runPluginBuildUiCli({
            argv: ['--project-root', projectRoot],
            loadConfig: async () => ({
                outDir: 'dist/ui',
                targets: [{
                    rendererId: 'examples.reviewWeb',
                    entry: 'ui/reviewPanel.web.tsx',
                    kind: 'hostedWeb',
                    bundlerConfig: 'build/vite.review.config.ts',
                }],
            }),
            exec: createSuccessfulManagedExec(calls),
            resolveManagedBuildVersions: () => ({
                hostUiApiVersion,
                viteVersion: '7.3.1',
                reactVersion,
            }),
            onError: (message) => errors.push(message),
        });

        expect(exitCode).toBe(1);
        expect(calls).toHaveLength(1);
        expect(calls[0]?.installableId).toBe('plugin-ui.bundler.vite');
        expect(calls[0]?.args?.slice(0, 2)).toEqual(['build', '--config']);
        expect(calls[0]?.args?.[2]).toContain('.happier-plugin-ui-build-');
        expect(errors.join('\n')).toContain('[entry_not_emitted]');
    });

    it('exits non-zero when the bundler emits an entry mismatch', async () => {
        const output = join(projectRoot, 'dist/ui/hosted-web/examples.reviewWeb/other.html');
        await mkdir(dirname(output), { recursive: true });
        await writeFile(output, 'x', 'utf8');
        const exitCode = await runPluginBuildUiCli({
            argv: ['--project-root', projectRoot],
            loadConfig: async () => config(),
            exec: createSuccessfulManagedExec([]),
            resolveManagedBuildVersions: () => ({
                hostUiApiVersion,
                viteVersion: '7.3.1',
                reactVersion,
            }),
        });
        expect(exitCode).not.toBe(0);
    });

    it('rejects a declared native platform when the managed bundler omits its artifact', async () => {
        const iosOutput = join(projectRoot, 'dist/ui/react-native/native/ios/ios.bundle');
        await mkdir(dirname(iosOutput), { recursive: true });
        await writeFile(iosOutput, 'ios', 'utf8');
        const errors: string[] = [];

        const exitCode = await runPluginBuildUiCli({
            argv: ['--project-root', projectRoot],
            loadConfig: async () => ({
                outDir: 'dist/ui',
                targets: [{
                    rendererId: 'native',
                    entry: 'ui/native.tsx',
                    kind: 'reactNative',
                    platforms: ['ios', 'android'],
                    module: {
                        containerName: 'native_container',
                        modulePath: './renderSurface',
                        exportName: 'renderSurface',
                    },
                }],
            }),
            exec: createSuccessfulManagedExec([]),
            resolveManagedBuildVersions: () => ({
                hostUiApiVersion,
                repackVersion: '5.2.5',
                reactVersion,
                reactNativeVersion: '0.83.4',
            }),
            onError: (message) => errors.push(message),
        });

        expect(exitCode).toBe(1);
        expect(errors).toEqual([
            'happier-plugin-build-ui: [native_artifact_missing] Managed Re.Pack build did not emit the declared android artifact for "native"',
        ]);
        await expect(readFile(
            join(projectRoot, 'dist/happier-plugin-ui/ui-artifacts.json'),
            'utf8',
        )).rejects.toMatchObject({ code: 'ENOENT' });
    });

    it('rejects the retired author-owned surfaces/runBundler config shape', async () => {
        const errors: string[] = [];
        const exitCode = await runPluginBuildUiCli({
            argv: ['--project-root', projectRoot],
            loadConfig: async () => ({
                surfaces: [],
                runBundler: async () => ({ files: [] }),
            }),
            onError: (message) => errors.push(message),
        });

        expect(exitCode).toBe(1);
        expect(errors.join('\n')).toContain('[config_invalid]');
        expect(errors.join('\n')).toContain('unknown field "surfaces"');
    });

    it('exits non-zero when config loading fails', async () => {
        const exitCode = await runPluginBuildUiCli({
            argv: ['--project-root', projectRoot],
            loadConfig: async () => {
                throw new Error('no config');
            },
        });
        expect(exitCode).not.toBe(0);
    });

    it('prints help and exits 0', async () => {
        const errors: string[] = [];
        const successes: string[] = [];
        const exitCode = await runPluginBuildUiCli({
            argv: ['--help'],
            onError: (message) => errors.push(message),
            onInfo: (message) => successes.push(message),
        });

        expect(exitCode).toBe(0);
        expect(errors).toEqual([]);
        expect(successes.join('\n')).toContain('happier-plugin-build-ui');
        expect(successes.join('\n')).toContain('pluginUiBuild');
        expect(successes.join('\n')).toContain('defineBuildConfig');
    });

    it('fails loudly when no config exists and names the discovered config contract', async () => {
        const errors: string[] = [];
        const exitCode = await runPluginBuildUiCli({
            argv: ['--project-root', projectRoot],
            onError: (message) => errors.push(message),
        });

        expect(exitCode).toBe(1);
        expect(errors.join('\n')).toContain('config_not_found');
        expect(errors.join('\n')).toContain('pluginUiBuild');
        expect(errors.join('\n')).toContain('defineBuildConfig');
    });

    it('discovers the public targets config and keeps work output separate from staged artifacts', async () => {
        await mkdir(join(projectRoot, 'ui'), { recursive: true });
        await writeFile(
            join(projectRoot, 'pluginUiBuild.mjs'),
            [
                'export default {',
                "  outDir: 'dist/ui',",
                '  targets: [{',
                "    rendererId: 'examples.reviewWeb',",
                "    entry: 'ui/reviewPanel.web.tsx',",
                "    kind: 'hostedWeb',",
                '  }],',
                '};',
                '',
            ].join('\n'),
            'utf8',
        );
        const output = join(projectRoot, 'dist/ui/hosted-web/examples.reviewWeb/index.html');
        await mkdir(dirname(output), { recursive: true });
        await writeFile(output, emitted[0]!.bytes);

        const exitCode = await runPluginBuildUiCli({
            argv: ['--project-root', projectRoot],
            exec: createSuccessfulManagedExec([]),
            resolveManagedBuildVersions: () => ({
                hostUiApiVersion,
                viteVersion: '7.3.1',
                reactVersion,
            }),
        });

        expect(exitCode).toBe(0);
        const manifestRaw = await readFile(
            join(projectRoot, 'dist/happier-plugin-ui/ui-artifacts.json'),
            'utf8',
        );
        const manifest = PluginUiArtifactsManifestV1Schema.parse(JSON.parse(manifestRaw));
        expect(manifest.entries[0]?.contributionId).toBe('examples.reviewWeb');
    });
});

describe('isBinDirectInvocation', () => {
    // The bin is invoked through an npm `.bin` symlink AND, under a `file:`
    // dependency, through a `node_modules` package symlink into the source
    // checkout. In both cases `process.argv[1]` and the symlink-resolved
    // `import.meta.url` differ by raw path but resolve to the same real file.
    // A raw string compare silently no-ops the CLI (exit 0, zero output); the
    // check must compare canonical real paths.
    it('treats a symlinked argv entry pointing at the module file as a direct invocation', async () => {
        const realEntry = join(projectRoot, 'bin.js');
        const symlinkEntry = join(projectRoot, 'linked-bin.js');
        await writeFile(realEntry, '// bin', 'utf8');
        await symlink(realEntry, symlinkEntry);

        expect(isBinDirectInvocation({
            argvEntry: symlinkEntry,
            moduleUrl: pathToFileURL(realEntry).href,
        })).toBe(true);
    });

    it('returns false for an unrelated argv entry', () => {
        expect(isBinDirectInvocation({
            argvEntry: join(projectRoot, 'other.js'),
            moduleUrl: pathToFileURL(join(projectRoot, 'bin.js')).href,
        })).toBe(false);
    });

    it('returns false when there is no argv entry', () => {
        expect(isBinDirectInvocation({
            argvEntry: undefined,
            moduleUrl: pathToFileURL(join(projectRoot, 'bin.js')).href,
        })).toBe(false);
    });
});
