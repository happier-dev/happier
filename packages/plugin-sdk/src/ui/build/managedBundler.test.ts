import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
    PLUGIN_UI_HOST_RUNTIME_GLOBAL_KEY,
    PluginUiArtifactsManifestV1Schema,
} from '@happier-dev/protocol/plugins/ui';

import { defineHostedWebViteBuildPreset } from '../hostedWebBuild.js';
import { defineReactNativeRepackBuildPreset } from '../reactNativeBuild.js';
import {
    createReactNativeWebVitePlugins,
    defineReactNativeWebViteBuildPreset,
} from '../reactNativeWebBuild.js';
import { buildUiArtifacts, type PluginUiBuildSurfaceV1 } from './buildUiArtifacts.js';
import {
    createManagedRuntimeBundlerRunner,
    resolvePluginUiBundlerInvocation,
    resolveManagedPluginUiBuildVersions,
    resolveRepackBundleCommandOptions,
    type ManagedBundlerExecResult,
    type ManagedBundlerExecService,
} from './managedBundler.js';

type ManagedBundlerLaunch = Parameters<ManagedBundlerExecService['run']>[0];

const hostUiApiVersion = '1.0.0';
const reactVersion = '19.2.0';

describe('resolveManagedPluginUiBuildVersions', () => {
    let projectRoot: string;

    beforeEach(async () => {
        projectRoot = await mkdtemp(join(tmpdir(), 'happier-managed-bundler-versions-'));
        const versions = [
            ['vite', '7.3.1'],
            ['react', reactVersion],
            ['react-native', '0.83.4'],
            ['@callstack/repack', '5.2.5'],
        ] as const;
        for (const [packageName, version] of versions) {
            const packageRoot = join(projectRoot, 'node_modules', ...packageName.split('/'));
            await mkdir(packageRoot, { recursive: true });
            await writeFile(join(packageRoot, 'package.json'), JSON.stringify({ name: packageName, version }), 'utf8');
        }
    });

    afterEach(async () => {
        await rm(projectRoot, { recursive: true, force: true });
    });

    it('derives exact provenance and compatibility versions from the managed project packages', () => {
        expect(resolveManagedPluginUiBuildVersions(projectRoot, [{
            rendererId: 'native',
            entry: 'ui/native.tsx',
            kind: 'reactNative',
            platforms: ['web', 'ios', 'android'],
        }])).toEqual({
            hostUiApiVersion: '1.0.0',
            viteVersion: '7.3.1',
            repackVersion: '5.2.5',
            reactVersion,
            reactNativeVersion: '0.83.4',
        });
    });
});

/**
 * Captures every launch handed to `exec.run` without spawning anything, so
 * the "which installable / which argv" dispatch decision can be asserted in
 * isolation from process I/O.
 */
function createCapturingExec(runResult: ManagedBundlerExecResult): Readonly<{
    exec: ManagedBundlerExecService;
    calls: ManagedBundlerLaunch[];
}> {
    const calls: ManagedBundlerLaunch[] = [];
    const exec: ManagedBundlerExecService = {
        async run(input) {
            calls.push(input);
            return runResult;
        },
    };
    return { exec, calls };
}

describe('createManagedRuntimeBundlerRunner dispatch', () => {
    const OK: ManagedBundlerExecResult = { exitCode: 0, signal: null, stdout: '', stderr: '' };

    it('routes a hostedWeb surface to the vite installable with the real `vite build` argv', async () => {
        const { exec, calls } = createCapturingExec(OK);
        const surface: PluginUiBuildSurfaceV1 = {
            kind: 'hostedWeb',
            preset: defineHostedWebViteBuildPreset({
                contributionId: 'fixtureHostedWeb',
                sourceEntry: 'ui/panel.web.tsx',
                viteVersion: '7.3.1',
                hostUiApiVersion,
                reactVersion,
            }),
            hostUiApiVersion,
            reactVersion,
        };
        const runner = createManagedRuntimeBundlerRunner({
            exec,
            emittedRoot: '/fixture/dist/happier-plugin-ui',
            listEmittedFiles: async () => [],
        });

        await runner(surface, { projectRoot: '/fixture/project' });

        expect(calls).toHaveLength(1);
        expect(calls[0]).toMatchObject({
            kind: 'managed-installable',
            installableId: 'plugin-ui.bundler.vite',
            // Real `vite build` takes no bundler-agnostic entry/outDir flags for
            // this contract — it auto-discovers the project-root vite.config.
            args: ['build'],
            cwd: '/fixture/project',
            sourcePreference: 'managed-first',
        });
    });

    it('routes a reactNative/vite (react-native-web tier) surface to the vite installable, not repack', async () => {
        // Regression coverage: `surface.kind === 'reactNative'` does NOT imply
        // Re.Pack — `defineReactNativeWebViteBuildPreset` builds the SAME
        // sourceEntry through Vite (LEDGER DEC-6's web tier). The previous
        // dispatch switched on `surface.kind` alone and misrouted this surface
        // to the repack installable.
        const { exec, calls } = createCapturingExec(OK);
        const surface: PluginUiBuildSurfaceV1 = {
            kind: 'reactNative',
            preset: defineReactNativeWebViteBuildPreset({
                contributionId: 'fixtureReactNativeWeb',
                sourceEntry: 'ui/panel.native.tsx',
                viteVersion: '7.3.1',
                hostUiApiVersion,
                compatibility: { reactVersion, reactNativeVersion: '0.83.4' },
            }),
            hostUiApiVersion,
            compatibility: { reactVersion, reactNativeVersion: '0.83.4' },
        };
        const runner = createManagedRuntimeBundlerRunner({
            exec,
            emittedRoot: '/fixture/dist/happier-plugin-ui',
            listEmittedFiles: async () => [],
        });

        await runner(surface, { projectRoot: '/fixture/project' });

        expect(calls).toHaveLength(1);
        expect(calls[0]).toMatchObject({
            kind: 'managed-installable',
            installableId: 'plugin-ui.bundler.vite',
            args: ['build'],
        });
    });

    it('routes a reactNative/repack surface to the repack installable with the real `bundle` command argv', async () => {
        const { exec, calls } = createCapturingExec(OK);
        const surface: PluginUiBuildSurfaceV1 = {
            kind: 'reactNative',
            preset: defineReactNativeRepackBuildPreset({
                contributionId: 'fixtureReactNativeNative',
                platform: 'ios',
                sourceEntry: 'ui/panel.native.tsx',
                module: { containerName: 'fixture_native', modulePath: './renderSurface', exportName: 'renderSurface' },
                repackVersion: '5.2.5',
                hostUiApiVersion,
                compatibility: { reactVersion, reactNativeVersion: '0.83.4' },
            }),
            hostUiApiVersion,
            compatibility: { reactVersion, reactNativeVersion: '0.83.4' },
        };
        const runner = createManagedRuntimeBundlerRunner({
            exec,
            emittedRoot: '/fixture/dist/happier-plugin-ui',
            listEmittedFiles: async () => [],
        });

        await runner(surface, { projectRoot: '/fixture/project' });

        expect(calls).toHaveLength(1);
        expect(calls[0]).toMatchObject({
            kind: 'managed-installable',
            installableId: 'plugin-ui.bundler.repack',
            // Real flags accepted by @callstack/repack's `bundle` command
            // (verified against `@callstack/repack/dist/commands/options.js`'s
            // `bundleCommandOptions`: --platform, --dev, --minify,
            // --bundle-output, --reset-cache, --config, --entry-file). Entry/
            // output are intentionally NOT forwarded as flags — every
            // plugin-UI reactNative surface builds as a Module Federation
            // remote container whose entry/output are baked into the
            // author's rspack.config.mjs, not a standalone app entry.
            args: ['bundle', '--platform', 'ios', '--dev', 'false', '--minify', 'false', '--reset-cache'],
            cwd: '/fixture/project',
            sourcePreference: 'managed-first',
        });
    });

    it('honors per-bundler installable id overrides', async () => {
        const { exec, calls } = createCapturingExec(OK);
        const surface: PluginUiBuildSurfaceV1 = {
            kind: 'reactNative',
            preset: defineReactNativeRepackBuildPreset({
                contributionId: 'fixtureOverride',
                platform: 'android',
                sourceEntry: 'ui/panel.native.tsx',
                module: { containerName: 'fixture_override', modulePath: './renderSurface', exportName: 'renderSurface' },
                repackVersion: '5.2.5',
                hostUiApiVersion,
                compatibility: { reactVersion, reactNativeVersion: '0.83.4' },
            }),
            hostUiApiVersion,
            compatibility: { reactVersion, reactNativeVersion: '0.83.4' },
        };
        const runner = createManagedRuntimeBundlerRunner({
            exec,
            emittedRoot: '/fixture/dist/happier-plugin-ui',
            repackInstallableId: 'custom.repack',
            viteInstallableId: 'custom.vite',
            listEmittedFiles: async () => [],
        });

        await runner(surface, { projectRoot: '/fixture/project' });

        expect(calls[0]).toMatchObject({
            installableId: 'custom.repack',
            args: ['bundle', '--platform', 'android', '--dev', 'false', '--minify', 'false', '--reset-cache'],
        });
    });

    it('throws with the bundler stderr when the managed installable exits non-zero', async () => {
        const { exec } = createCapturingExec({ exitCode: 1, signal: null, stdout: '', stderr: 'boom' });
        const surface: PluginUiBuildSurfaceV1 = {
            kind: 'hostedWeb',
            preset: defineHostedWebViteBuildPreset({
                contributionId: 'fixtureFailingBuild',
                sourceEntry: 'ui/panel.web.tsx',
                viteVersion: '7.3.1',
                hostUiApiVersion,
                reactVersion,
            }),
            hostUiApiVersion,
            reactVersion,
        };
        const runner = createManagedRuntimeBundlerRunner({
            exec,
            emittedRoot: '/fixture/dist/happier-plugin-ui',
            listEmittedFiles: async () => [],
        });

        await expect(runner(surface, { projectRoot: '/fixture/project' })).rejects.toThrow(/boom/u);
    });
});

describe('resolveRepackBundleCommandOptions (direct-path parity)', () => {
    const repackSurface: PluginUiBuildSurfaceV1 = {
        kind: 'reactNative',
        preset: defineReactNativeRepackBuildPreset({
            contributionId: 'fixtureParity',
            platform: 'ios',
            sourceEntry: 'ui/panel.native.tsx',
            module: { containerName: 'fixture_parity', modulePath: './renderSurface', exportName: 'renderSurface' },
            repackVersion: '5.2.5',
            hostUiApiVersion,
            compatibility: { reactVersion, reactNativeVersion: '0.83.4' },
        }),
        hostUiApiVersion,
        compatibility: { reactVersion, reactNativeVersion: '0.83.4' },
    };

    it('mirrors the generic CLI argv exactly — one shared settings source, no drift', () => {
        const options = resolveRepackBundleCommandOptions(repackSurface, {
            configPath: '/plugin/rspack.config.mjs',
        });
        expect(options).toEqual({
            platform: 'ios',
            dev: false,
            minify: false,
            resetCache: true,
            config: '/plugin/rspack.config.mjs',
        });

        const { installableId, args } = resolvePluginUiBundlerInvocation(repackSurface);
        expect(installableId).toBe('plugin-ui.bundler.repack');
        expect(args[args.indexOf('--platform') + 1]).toBe(options.platform);
        expect(args[args.indexOf('--dev') + 1]).toBe(String(options.dev));
        expect(args[args.indexOf('--minify') + 1]).toBe(String(options.minify));
        expect(args.includes('--reset-cache')).toBe(options.resetCache);
    });

    it('omits the config path when the author relies on rspack.config auto-discovery', () => {
        expect(resolveRepackBundleCommandOptions(repackSurface)).not.toHaveProperty('config');
    });

    it('rejects non-repack surfaces instead of inventing repack options', () => {
        const webTierSurface: PluginUiBuildSurfaceV1 = {
            kind: 'reactNative',
            preset: defineReactNativeWebViteBuildPreset({
                contributionId: 'fixtureParity',
                sourceEntry: 'ui/panel.native.tsx',
                viteVersion: '7.3.1',
                hostUiApiVersion,
                compatibility: { reactVersion, reactNativeVersion: '0.83.4' },
            }),
            hostUiApiVersion,
            compatibility: { reactVersion, reactNativeVersion: '0.83.4' },
        };
        expect(() => resolveRepackBundleCommandOptions(webTierSurface)).toThrow(/not a Re\.Pack build surface/u);
    });
});

/**
 * End-to-end coverage against a REAL, spawned `vite` process — not a fake.
 * `vite` is hoisted at the workspace root (used by `apps/ui` and
 * `packages/plugins/inspector`); this resolves and spawns that real binary
 * exactly as the managed-installable host runtime would (see
 * `apps/cli/src/plugins/runtime/context/exec.ts`'s `resolveManagedInstallableLaunch`
 * + `createSpawnedPluginProcess`), proving `bundlerArgs()`'s `['build']`
 * argv is a real, correct `vite build` invocation and not just a plausible
 * guess.
 */
function resolveRealViteBinPath(): string {
    const require = createRequire(import.meta.url);
    // `vite`'s own `exports` map does not expose `./bin/vite.js` as a
    // subpath (it is only reachable via the package's `bin` field), so
    // resolve it relative to the package root rather than `require.resolve`.
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

async function listFilesRecursive(root: string): Promise<readonly string[]> {
    const entries = await readdir(root, { withFileTypes: true });
    const files = await Promise.all(entries.map(async (entry) => {
        const absolute = join(root, entry.name);
        return entry.isDirectory() ? listFilesRecursive(absolute) : [absolute];
    }));
    return files.flat();
}

describe('createManagedRuntimeBundlerRunner (real vite build)', () => {
    let projectRoot: string;

    beforeEach(async () => {
        const projectParent = fileURLToPath(new URL(
            '../../../../plugins/inspector/node_modules/.cache/',
            import.meta.url,
        ));
        await mkdir(projectParent, { recursive: true });
        projectRoot = await mkdtemp(join(projectParent, 'happier-managed-bundler-vite-'));
    });

    afterEach(async () => {
        await rm(projectRoot, { recursive: true, force: true });
    });

    it('produces real emitted files + a valid ui-artifacts manifest through the generic managed-installable dispatch', async () => {
        const contributionId = 'fixtureRealVite';
        const preset = defineHostedWebViteBuildPreset({
            contributionId,
            sourceEntry: 'src/main.js',
            viteVersion: '7.3.1',
            hostUiApiVersion,
            reactVersion,
        });

        // Author-owned vite.config.mjs, auto-discovered by `vite build` from
        // `cwd` — exactly the contract `bundlerArgs()` now relies on instead
        // of forwarding (unsupported) `--entry`/`--out` CLI flags.
        await writeFile(
            join(projectRoot, 'vite.config.mjs'),
            `export default {\n  base: './',\n  build: {\n    outDir: ${JSON.stringify(preset.output.root)},\n    assetsDir: 'assets',\n    emptyOutDir: true,\n    minify: false,\n  },\n};\n`,
        );
        await writeFile(
            join(projectRoot, 'index.html'),
            '<!doctype html><html><body><script type="module" src="/src/main.js"></script></body></html>\n',
        );
        await mkdir(join(projectRoot, 'src'), { recursive: true });
        await writeFile(join(projectRoot, 'src/main.js'), 'console.log("happier plugin ui fixture");\n');

        const surface: PluginUiBuildSurfaceV1 = {
            kind: 'hostedWeb',
            preset,
            hostUiApiVersion,
            reactVersion,
        };

        const artifactsRoot = join(projectRoot, 'dist/happier-plugin-ui');
        const runBundler = createManagedRuntimeBundlerRunner({
            exec: createRealViteExec(),
            emittedRoot: artifactsRoot,
            viteInstallableId: 'plugin-ui.bundler.vite',
            listEmittedFiles: async (_surface, context) =>
                listFilesRecursive(join(context.projectRoot, preset.output.root)),
            timeoutMs: 60_000,
        });

        const result = await buildUiArtifacts({ projectRoot, surfaces: [surface], runBundler });

        expect(result.manifest.entries).toHaveLength(1);
        const entry = result.manifest.entries[0];
        expect(entry?.contributionId).toBe(contributionId);
        expect(entry?.entry).toBe(`hosted-web/${contributionId}/index.html`);
        expect(entry?.builtWith.bundler).toBe('vite');

        const manifestOnDisk = PluginUiArtifactsManifestV1Schema.parse(
            JSON.parse(await readFile(join(artifactsRoot, 'ui-artifacts.json'), 'utf8')),
        );
        expect(manifestOnDisk.entries).toHaveLength(1);

        const indexHtml = await readFile(
            join(artifactsRoot, `hosted-web/${contributionId}/index.html`),
            'utf8',
        );
        expect(indexHtml).toContain('<script');
    }, 60_000);

    it('routes automatic JSX from a transitive module through the host runtime shim without bundling React JSX runtime', async () => {
        const contributionId = 'fixtureAutomaticJsx';
        const preset = defineReactNativeWebViteBuildPreset({
            contributionId,
            sourceEntry: 'src/main.tsx',
            viteVersion: '7.3.1',
            hostUiApiVersion,
            compatibility: { reactVersion, reactNativeVersion: '0.83.4' },
        });
        const sdkBuildModuleUrl = new URL('../../../dist/ui/reactNativeWebBuild.js', import.meta.url).href;

        await writeFile(
            join(projectRoot, 'vite.config.mjs'),
            [
                `import { createReactNativeWebVitePlugins } from ${JSON.stringify(sdkBuildModuleUrl)};`,
                'export default {',
                "  base: './',",
                '  plugins: [...createReactNativeWebVitePlugins()],',
                "  esbuild: { jsx: 'automatic' },",
                '  build: {',
                `    outDir: ${JSON.stringify(preset.output.root)},`,
                '    emptyOutDir: true,',
                '    minify: false,',
                "    lib: { entry: 'src/main.tsx', formats: ['es'], fileName: () => 'entry.mjs' },",
                '  },',
                '};',
                '',
            ].join('\n'),
        );
        await mkdir(join(projectRoot, 'src'), { recursive: true });
        await writeFile(
            join(projectRoot, 'src', 'main.tsx'),
            "export { renderAutomaticJsx, renderExplicitJsx } from './transitive';\n",
        );
        await writeFile(
            join(projectRoot, 'src', 'transitive.tsx'),
            [
                "import { jsx } from 'react/jsx-runtime';",
                '',
                'export function renderAutomaticJsx() {',
                '  return <section data-owner="host-jsx-runtime">shared</section>;',
                '}',
                '',
                'export function renderExplicitJsx() {',
                '  return jsx("section", { children: "shared" });',
                '}',
                '',
            ].join('\n'),
        );

        const surface: PluginUiBuildSurfaceV1 = {
            kind: 'reactNative',
            preset,
            hostUiApiVersion,
            compatibility: { reactVersion, reactNativeVersion: '0.83.4' },
        };
        const artifactsRoot = join(projectRoot, 'dist/happier-plugin-ui');
        const runBundler = createManagedRuntimeBundlerRunner({
            exec: createRealViteExec(),
            emittedRoot: artifactsRoot,
            viteInstallableId: 'plugin-ui.bundler.vite',
            listEmittedFiles: async (_surface, context) =>
                listFilesRecursive(join(context.projectRoot, preset.output.root)),
            timeoutMs: 60_000,
        });

        await buildUiArtifacts({ projectRoot, surfaces: [surface], runBundler });
        const entrySource = await readFile(join(artifactsRoot, preset.output.entry), 'utf8');
        expect(entrySource).toContain(PLUGIN_UI_HOST_RUNTIME_GLOBAL_KEY);
        expect(entrySource).toContain('"react/jsx-runtime"');
        expect(entrySource).toContain('"react/jsx-dev-runtime"');
        expect(entrySource).not.toContain('reactJsxRuntime_production');
        expect(entrySource).not.toContain('reactJsxDevRuntime_production');
        expect(entrySource).not.toContain('REACT_ELEMENT_TYPE');

        const sentinel = Object.freeze({ owner: 'host-jsx-runtime' });
        (globalThis as unknown as Record<string, unknown>)[PLUGIN_UI_HOST_RUNTIME_GLOBAL_KEY] = {
            'react/jsx-runtime': {
                Fragment: Symbol.for('fixture.fragment'),
                jsx: () => sentinel,
                jsxs: () => sentinel,
            },
            'react/jsx-dev-runtime': {
                Fragment: Symbol.for('fixture.fragment'),
                jsxDEV: () => sentinel,
            },
        };
        try {
            const builtModule = await import(
                /* @vite-ignore */ `data:text/javascript,${encodeURIComponent(entrySource)}`
            ) as Readonly<{
                renderAutomaticJsx: () => unknown;
                renderExplicitJsx: () => unknown;
            }>;
            expect(builtModule.renderAutomaticJsx()).toBe(sentinel);
            expect(builtModule.renderExplicitJsx()).toBe(sentinel);
        } finally {
            delete (globalThis as unknown as Record<string, unknown>)[PLUGIN_UI_HOST_RUNTIME_GLOBAL_KEY];
        }
    }, 60_000);
});
