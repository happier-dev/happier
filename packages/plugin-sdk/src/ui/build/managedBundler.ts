import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';

import { PLUGIN_UI_HOST_API_VERSION_V1 } from '@happier-dev/protocol/plugins/ui';

import type { PluginUiBuildTarget } from './config.js';
import type { ReactNativeRepackBuildPreset } from '../reactNativeBuild.js';
import type {
    PluginUiBuildSurfaceV1,
    PluginUiBundlerRunResultV1,
    PluginUiBundlerRunnerV1,
    PluginUiReactNativeBuildSurfaceV1,
} from './buildUiArtifacts.js';

export type ManagedBundlerExecResult = Readonly<{
    exitCode: number | null;
    signal: string | null;
    stdout: string;
    stderr: string;
}>;

export type ManagedBundlerExecService = Readonly<{
    run(input: Readonly<{
        kind: 'managed-installable';
        installableId: string;
        args?: readonly string[];
        cwd?: string;
        sourcePreference?: 'managed-first' | 'system-first';
    }>, options?: Readonly<{ timeoutMs?: number }>): Promise<ManagedBundlerExecResult>;
}>;

/**
 * Managed-runtime-backed bundler runner. The author build is a
 * "managed JS-runtime-dependent" path (docs/binary-runtime.md): it MUST route
 * the bundler invocation through the centralized managed runtime/tool
 * abstraction rather than spawning raw
 * node/npm/npx/pnpm/yarn/bunx. The bundler (Vite for web tiers, Re.Pack for
 * React Native) is launched as a managed installable; its emitted dist files
 * are then read back so the executor can digest the real bytes.
 */
export type ManagedBundlerRunnerInputV1 = Readonly<{
    exec: ManagedBundlerExecService;
    /**
     * Absolute path the bundler writes its emitted artifact tree into. Files are
     * read back relative to `<emittedRoot>` and keyed by their relative path.
     */
    emittedRoot: string;
    /** Installable id of the bundler launched through the managed runtime. */
    viteInstallableId?: string;
    repackInstallableId?: string;
    /** Absolute paths of the files the bundler emitted for the given surface. */
    listEmittedFiles: (
        surface: PluginUiBuildSurfaceV1,
        context: Readonly<{ projectRoot: string; emittedRoot: string }>,
    ) => Promise<readonly string[]>;
    toArtifactRelativePath?: (
        surface: PluginUiBuildSurfaceV1,
        absolutePath: string,
        context: Readonly<{ projectRoot: string; emittedRoot: string }>,
    ) => string;
    timeoutMs?: number;
}>;

const DEFAULT_VITE_INSTALLABLE_ID = 'plugin-ui.bundler.vite';
const DEFAULT_REPACK_INSTALLABLE_ID = 'plugin-ui.bundler.repack';

export type ManagedPluginUiBuildVersionsV1 = Readonly<{
    hostUiApiVersion: string;
    viteVersion?: string;
    repackVersion?: string;
    reactVersion?: string;
    reactNativeVersion?: string;
}>;

function readInstalledPackageVersion(projectRoot: string, packageName: string): string {
    const require = createRequire(join(projectRoot, 'package.json'));
    let packageJson: unknown;
    try {
        packageJson = require(`${packageName}/package.json`) as unknown;
    } catch (cause) {
        throw new Error(
            `Managed plugin UI build requires project dependency "${packageName}" (${(cause as Error).message})`,
        );
    }
    const version = typeof packageJson === 'object' && packageJson !== null
        ? (packageJson as { version?: unknown }).version
        : undefined;
    if (typeof version !== 'string' || version.trim() === '') {
        throw new Error(`Managed plugin UI build could not resolve an exact version for "${packageName}"`);
    }
    return version;
}

/**
 * Resolves artifact provenance/compatibility from the exact packages consumed
 * by the managed bundler. Authors do not repeat runner or version decisions in
 * `PluginUiBuildConfig`.
 */
export function resolveManagedPluginUiBuildVersions(
    projectRoot: string,
    targets: readonly PluginUiBuildTarget[],
): ManagedPluginUiBuildVersionsV1 {
    const needsVite = targets.some((target) => target.kind === 'hostedWeb'
        || (target.kind === 'reactNative'
            && target.platforms.some((platform) => platform === 'web' || platform === 'desktop')));
    const needsRepack = targets.some((target) => target.kind === 'reactNative'
        && target.platforms.some((platform) => platform === 'ios' || platform === 'android'));
    const needsReactNative = targets.some((target) => target.kind === 'reactNative');
    return Object.freeze({
        hostUiApiVersion: PLUGIN_UI_HOST_API_VERSION_V1,
        ...(needsVite ? { viteVersion: readInstalledPackageVersion(projectRoot, 'vite') } : {}),
        ...(needsRepack ? { repackVersion: readInstalledPackageVersion(projectRoot, '@callstack/repack') } : {}),
        ...(needsReactNative ? { reactVersion: readInstalledPackageVersion(projectRoot, 'react') } : {}),
        ...(needsReactNative
            ? { reactNativeVersion: readInstalledPackageVersion(projectRoot, 'react-native') }
            : {}),
    });
}

/**
 * A build surface is repack-bundled iff it is a `reactNative`-kind surface
 * whose preset explicitly declares `bundler: 'repack'`. A `reactNative`-kind
 * surface can ALSO carry `preset.bundler === 'vite'` (the react-native-web
 * tier defined by `defineReactNativeWebViteBuildPreset` — LEDGER DEC-6's
 * "same sourceEntry, one more manifest entry" story): switching on
 * `surface.kind` alone (the previous implementation) misrouted that tier's
 * installable resolution AND its CLI args to Re.Pack. `preset.bundler` is
 * the only field that actually discriminates the real bundler.
 */
function isRepackSurface(
    surface: PluginUiBuildSurfaceV1,
): surface is PluginUiReactNativeBuildSurfaceV1 & {
    readonly preset: ReactNativeRepackBuildPreset;
} {
    return surface.kind === 'reactNative' && surface.preset.bundler === 'repack';
}

/**
 * Deterministic production-build settings shared by EVERY Re.Pack invocation
 * of the plugin UI build pipeline — the generic managed-installable CLI
 * dispatch (`resolvePluginUiBundlerInvocation`) AND any in-process invocation
 * of Re.Pack's exported `bundle` command function
 * (`resolveRepackBundleCommandOptions`). One source of truth so the two
 * invocation shapes cannot drift apart.
 */
export const PLUGIN_UI_REPACK_BUNDLE_SETTINGS_V1 = Object.freeze({
    dev: false,
    minify: false,
    resetCache: true,
} as const);

export type PluginUiBundlerInvocationV1 = Readonly<{
    installableId: string;
    args: readonly string[];
}>;

export type PluginUiBundlerInstallableOverridesV1 = Readonly<{
    viteInstallableId?: string;
    repackInstallableId?: string;
}>;

/**
 * THE canonical bundler-invocation resolution for a plugin UI build surface:
 * which managed installable to launch, and the exact argv that binary
 * actually accepts. The previous implementation forwarded a single invented
 * `build --contribution <id> --entry <src> --out <root>` shape to BOTH
 * bundlers; neither real CLI accepts those flags (verified against the
 * installed `vite@7.3.1` and `@callstack/repack@5.2.5` in this repo — the
 * residual NATIVE-PIPELINE.md documented). Each preset's own build config,
 * not CLI flags, owns entry/output wiring:
 *
 * - Vite (`hostedWeb`, and the `reactNative` web/vite tier): every target
 *   receives a builder-materialized, operation-local config through
 *   `vite build --config <path>`. An explicit, project-contained advanced
 *   Vite config is merged only as an extension; it cannot replace the SDK's
 *   canonical entry/root/output, while the React Native Web tier also keeps
 *   its SDK-owned host-runtime and physical-package plugins.
 * - Re.Pack (`reactNative` ios/android tier): Re.Pack ships no standalone
 *   bin at all; the resolved `plugin-ui.bundler.repack` installable is the
 *   react-native-community-cli entry point (`binary.commands:
 *   ['react-native']` on the descriptor). The builder registers Re.Pack's
 *   `commands/rspack` only in its operation-local work root and always passes
 *   the materialized Re.Pack config through `--config`; no author-owned
 *   React Native CLI config or Rspack auto-discovery participates. The `bundle`
 *   subcommand's REAL flags are `--platform`, `--dev`, `--minify`,
 *   `--reset-cache`, `--config`, `--entry-file`, `--bundle-output` (verified
 *   against `@callstack/repack/dist/commands/options.js`'s
 *   `bundleCommandOptions`). Every plugin-UI `reactNative` build surface
 *   ships as a Module Federation "remote" container (never a standalone RN
 *   app entry — see the inspector's `rspack.config.mjs` doc comment), so
 *   entry/output are baked into the builder-materialized `rspack.config.*`
 *   rather than passed as
 *   `--entry-file`/`--bundle-output` flags — those would inject an unwanted
 *   standalone-app entry into what is actually an exposed-module container.
 */
export function resolvePluginUiBundlerInvocation(
    surface: PluginUiBuildSurfaceV1,
    overrides?: PluginUiBundlerInstallableOverridesV1,
): PluginUiBundlerInvocationV1 {
    if (isRepackSurface(surface)) {
        return Object.freeze({
            installableId: overrides?.repackInstallableId ?? DEFAULT_REPACK_INSTALLABLE_ID,
            args: Object.freeze([
                'bundle',
                '--platform',
                surface.preset.platform,
                '--dev',
                String(PLUGIN_UI_REPACK_BUNDLE_SETTINGS_V1.dev),
                '--minify',
                String(PLUGIN_UI_REPACK_BUNDLE_SETTINGS_V1.minify),
                ...(PLUGIN_UI_REPACK_BUNDLE_SETTINGS_V1.resetCache ? ['--reset-cache'] : []),
                ...(surface.bundlerConfigPath === undefined ? [] : ['--config', surface.bundlerConfigPath]),
            ]),
        });
    }
    return Object.freeze({
        installableId: overrides?.viteInstallableId ?? DEFAULT_VITE_INSTALLABLE_ID,
        args: Object.freeze([
            'build',
            ...(surface.bundlerConfigPath === undefined ? [] : ['--config', surface.bundlerConfigPath]),
        ]),
    });
}

export type RepackBundleCommandOptionsV1 = Readonly<{
    platform: 'ios' | 'android';
    dev: false;
    minify: false;
    resetCache: true;
    config?: string;
}>;

/**
 * The in-process equivalent of the repack CLI argv above, for callers that
 * invoke Re.Pack's exported `bundle` command function directly instead of
 * launching the react-native-community-cli binary (e.g. host-owned build
 * tooling that already loaded Re.Pack in-process). Derives from the SAME
 * `PLUGIN_UI_REPACK_BUNDLE_SETTINGS_V1` as the CLI argv so the two
 * invocation paths cannot drift.
 */
export function resolveRepackBundleCommandOptions(
    surface: PluginUiBuildSurfaceV1,
    input?: Readonly<{ configPath?: string }>,
): RepackBundleCommandOptionsV1 {
    if (!isRepackSurface(surface)) {
        throw new Error(
            `Surface "${surface.preset.contributionId}" is not a Re.Pack build surface (bundler: '${surface.preset.bundler}')`,
        );
    }
    const configPath = input?.configPath ?? surface.bundlerConfigPath;
    return Object.freeze({
        platform: surface.preset.platform,
        ...PLUGIN_UI_REPACK_BUNDLE_SETTINGS_V1,
        ...(configPath === undefined ? {} : { config: configPath }),
    });
}

function toRelativeArtifactPath(emittedRoot: string, absolutePath: string): string {
    return relative(emittedRoot, absolutePath).split(sep).join('/');
}

export function createManagedRuntimeBundlerRunner(
    input: ManagedBundlerRunnerInputV1,
): PluginUiBundlerRunnerV1 {
    return async (surface, context): Promise<PluginUiBundlerRunResultV1> => {
        const invocation = resolvePluginUiBundlerInvocation(surface, {
            viteInstallableId: input.viteInstallableId,
            repackInstallableId: input.repackInstallableId,
        });
        const result = await input.exec.run(
            {
                kind: 'managed-installable',
                installableId: invocation.installableId,
                args: invocation.args,
                cwd: surface.bundlerWorkingDirectory ?? context.projectRoot,
                sourcePreference: 'managed-first',
            },
            { timeoutMs: input.timeoutMs },
        );
        if (result.exitCode !== 0) {
            throw new Error(
                `Bundler for "${surface.preset.contributionId}" exited with ${String(result.exitCode)}: ${result.stderr.trim()}`,
            );
        }

        const absoluteFiles = await input.listEmittedFiles(surface, {
            projectRoot: context.projectRoot,
            emittedRoot: input.emittedRoot,
        });
        const files = await Promise.all(absoluteFiles.map(async (absolutePath) => ({
            relativePath: input.toArtifactRelativePath
                ? input.toArtifactRelativePath(surface, absolutePath, {
                    projectRoot: context.projectRoot,
                    emittedRoot: input.emittedRoot,
                })
                : toRelativeArtifactPath(input.emittedRoot, absolutePath),
            bytes: new Uint8Array(await readFile(join(absolutePath))),
        })));
        return { files };
    };
}
