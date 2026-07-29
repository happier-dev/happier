import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
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

const hostUiApiVersion = '1.0.0';
const reactVersion = '19.2.0';

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
            platforms: ['web'],
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

beforeEach(async () => {
    projectRoot = await mkdtemp(join(tmpdir(), 'happier-plugin-build-ui-cli-'));
});

afterEach(async () => {
    await rm(projectRoot, { recursive: true, force: true });
});

describe('runPluginBuildUiCli', () => {
    it('runs the canonical public targets config through the shipped bin and stages every declared web/iOS/Android artifact', async () => {
        const canonicalExampleSource = await readFile(
            join(process.cwd(), 'examples/public-authoring/pluginUiBuild.ts'),
            'utf8',
        );
        await writeFile(join(projectRoot, 'pluginUiBuild.mjs'), canonicalExampleSource, 'utf8');
        const packageScope = join(projectRoot, 'node_modules/@happier-dev');
        await mkdir(packageScope, { recursive: true });
        await symlink(process.cwd(), join(packageScope, 'plugin-sdk'), 'dir');
        const workRoot = join(projectRoot, 'dist/ui');
        const emitted = [
            ['react-native-web/voice-runtime-web/entry.mjs', 'voice web'],
            ['hosted-web/review-web/index.html', '<!doctype html>'],
            ['react-native-web/review-native/entry.mjs', 'review web'],
            ['react-native/review-native/ios/ios.bundle.js', 'review ios'],
            ['react-native/review-native/android/android.bundle.js', 'review android'],
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
        expect(calls.map((call) => call.kind === 'managed-installable'
            ? { installableId: call.installableId, args: call.args }
            : { installableId: null, args: null })).toEqual([
            { installableId: 'plugin-ui.bundler.vite', args: ['build'] },
            { installableId: 'plugin-ui.bundler.vite', args: ['build'] },
            { installableId: 'plugin-ui.bundler.vite', args: ['build'] },
            {
                installableId: 'plugin-ui.bundler.repack',
                args: ['bundle', '--platform', 'ios', '--dev', 'false', '--minify', 'false', '--reset-cache'],
            },
            {
                installableId: 'plugin-ui.bundler.repack',
                args: ['bundle', '--platform', 'android', '--dev', 'false', '--minify', 'false', '--reset-cache'],
            },
        ]);
        const manifest = PluginUiArtifactsManifestV1Schema.parse(JSON.parse(await readFile(
            join(projectRoot, 'dist/happier-plugin-ui/ui-artifacts.json'),
            'utf8',
        )));
        expect(manifest.entries.map((entry) => `${entry.tier}:${entry.contributionId}:${entry.platform}`).sort()).toEqual([
            'hostedWeb:review-web:web',
            'reactNative:review-native:android',
            'reactNative:review-native:ios',
            'reactNative:review-native:web',
            'reactNative:voice-runtime-web:web',
        ]);
        expect(await readFile(
            join(projectRoot, 'dist/happier-plugin-ui/react-native/review-native/ios/ios.bundle.js'),
            'utf8',
        )).toBe('review ios');
    }, 30_000);

    it('builds the declared surfaces and exits 0', async () => {
        const output = join(projectRoot, 'dist/ui/hosted-web/examples.reviewWeb/index.html');
        await mkdir(dirname(output), { recursive: true });
        await writeFile(output, emitted[0]!.bytes);
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

        expect(exitCode).toBe(0);
        const manifestRaw = await readFile(
            join(projectRoot, 'dist/happier-plugin-ui/ui-artifacts.json'),
            'utf8',
        );
        const manifest = PluginUiArtifactsManifestV1Schema.parse(JSON.parse(manifestRaw));
        expect(manifest.entries[0]?.digest).toBe(
            computePluginUiArtifactFileSetSha256DigestV1(emitted),
        );
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
        const iosOutput = join(projectRoot, 'dist/ui/react-native/native/ios/ios.bundle.js');
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
        expect(successes.join('\n')).toContain('definePluginUiBuildConfig');
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
        expect(errors.join('\n')).toContain('definePluginUiBuildConfig');
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
                "    platforms: ['web'],",
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
