#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { access, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { basename, dirname, extname, isAbsolute, join, resolve, sep, relative } from 'node:path';

import { defineHostedWebViteBuildPreset } from '../hostedWebBuild.js';
import { defineReactNativeRepackBuildPreset } from '../reactNativeBuild.js';
import { defineReactNativeWebViteBuildPreset } from '../reactNativeWebBuild.js';
import {
    buildUiArtifacts,
    PluginUiBuildError,
    type BuildUiArtifactsResultV1,
    type PluginUiBuildSurfaceV1,
} from './buildUiArtifacts.js';
import {
    PLUGIN_UI_BUILD_CONFIG_BASENAMES,
    type PluginUiBuildConfig,
    type PluginUiBuildTarget,
} from './config.js';
import {
    createManagedRuntimeBundlerRunner,
    resolveManagedPluginUiBuildVersions,
    type ManagedBundlerExecResult,
    type ManagedBundlerExecService,
    type ManagedPluginUiBuildVersionsV1,
} from './managedBundler.js';

export type PluginBuildUiCliLoadConfigV1 = (
    context: Readonly<{ projectRoot: string; configPath: string | null }>,
) => Promise<unknown>;

export type RunPluginBuildUiCliInputV1 = Readonly<{
    argv: readonly string[];
    cwd?: string;
    loadConfig?: PluginBuildUiCliLoadConfigV1;
    /** Host-managed execution boundary; the direct bin supplies its packaged adapter. */
    exec?: ManagedBundlerExecService;
    resolveManagedBuildVersions?: (
        projectRoot: string,
        targets: readonly PluginUiBuildTarget[],
    ) => ManagedPluginUiBuildVersionsV1;
    onError?: (message: string) => void;
    onInfo?: (message: string) => void;
    onSuccess?: (result: BuildUiArtifactsResultV1) => void;
}>;

type ParsedArgs = Readonly<{
    projectRoot: string;
    configPath: string | null;
    help: boolean;
}>;

function helpText(): string {
    return [
        'happier-plugin-build-ui',
        '',
        'Builds and stages plugin UI artifacts under dist/happier-plugin-ui.',
        '',
        'Usage:',
        '  happier-plugin-build-ui [--project-root <dir>] [--config <path>]',
        '  happier-plugin-build-ui --help',
        '',
        'Config discovery:',
        `  ${PLUGIN_UI_BUILD_CONFIG_BASENAMES.join(', ')}`,
        '',
        'Config export contract:',
        '  export default definePluginUiBuildConfig({ projectRoot?, outDir?, targets: [...] })',
        '',
        'outDir is managed bundler work output, not the install artifact root.',
        'The host selects Vite/Re.Pack and stages verified files into dist/happier-plugin-ui.',
    ].join('\n');
}

function readFlagValue(argv: readonly string[], index: number, flag: string): string {
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) {
        throw new PluginUiBuildError('missing_flag_value', `Missing value for ${flag}`);
    }
    return value;
}

function parseArgs(argv: readonly string[], cwd: string): ParsedArgs {
    let projectRoot = cwd;
    let configPath: string | null = null;
    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index]!;
        switch (arg) {
            case '--help':
            case '-h':
                return { projectRoot: cwd, configPath: null, help: true };
            case '--project-root':
                projectRoot = readFlagValue(argv, index, arg);
                index += 1;
                break;
            case '--config':
                configPath = readFlagValue(argv, index, arg);
                index += 1;
                break;
            default:
                throw new PluginUiBuildError('unknown_flag', `Unknown argument: ${arg}`);
        }
    }
    const absoluteRoot = isAbsolute(projectRoot) ? projectRoot : resolve(cwd, projectRoot);
    const absoluteConfig = configPath === null
        ? null
        : (isAbsolute(configPath) ? configPath : resolve(absoluteRoot, configPath));
    return { projectRoot: absoluteRoot, configPath: absoluteConfig, help: false };
}

async function pathExists(path: string): Promise<boolean> {
    try {
        await access(path);
        return true;
    } catch (cause) {
        if ((cause as NodeJS.ErrnoException)?.code === 'ENOENT') {
            return false;
        }
        throw cause;
    }
}

type TypeScriptModule = Readonly<{
    transpileModule(source: string, options: Readonly<{ compilerOptions: Record<string, unknown>; fileName: string }>): {
        outputText: string;
    };
    ModuleKind: Readonly<{ ESNext: unknown }>;
    ScriptTarget: Readonly<{ ES2022: unknown }>;
    ModuleResolutionKind: Readonly<{ Bundler: unknown }>;
}>;

function loadTypeScript(projectRoot: string): TypeScriptModule {
    const require = createRequire(join(projectRoot, 'package.json'));
    try {
        return require('typescript') as TypeScriptModule;
    } catch (cause) {
        throw new PluginUiBuildError(
            'typescript_config_loader_missing',
            `TypeScript config files require a project-local typescript dependency (${(cause as Error).message})`,
        );
    }
}

async function importTypeScriptConfig(modulePath: string, projectRoot: string): Promise<Record<string, unknown>> {
    const ts = loadTypeScript(projectRoot);
    const source = await readFile(modulePath, 'utf8');
    const transpiled = ts.transpileModule(source, {
        fileName: modulePath,
        compilerOptions: {
            target: ts.ScriptTarget.ES2022,
            module: ts.ModuleKind.ESNext,
            moduleResolution: ts.ModuleResolutionKind.Bundler,
        },
    }).outputText;
    const compiledPath = join(
        dirname(modulePath),
        `.${basename(modulePath).replace(/[^a-zA-Z0-9._-]/gu, '-')}.${process.pid}.${randomUUID()}.mjs`,
    );
    await writeFile(compiledPath, transpiled, 'utf8');
    try {
        return (await import(pathToFileURL(compiledPath).href)) as Record<string, unknown>;
    } finally {
        await rm(compiledPath, { force: true }).catch(() => undefined);
    }
}

async function importDefaultExport(modulePath: string, projectRoot: string): Promise<unknown> {
    const imported = extname(modulePath).toLowerCase() === '.ts'
        ? await importTypeScriptConfig(modulePath, projectRoot)
        : (await import(pathToFileURL(modulePath).href)) as Record<string, unknown>;
    return imported.default ?? imported.pluginUiBuildConfig ?? imported.config ?? imported;
}

function resolvePackageBin(
    packageName: string,
    binRelativePath: string,
    cwd: string,
): string {
    const require = createRequire(join(cwd, 'package.json'));
    return join(dirname(require.resolve(`${packageName}/package.json`)), binRelativePath);
}

async function runNodeBin(
    binPath: string,
    args: readonly string[],
    cwd: string | undefined,
    timeoutMs: number | undefined,
): Promise<ManagedBundlerExecResult> {
    return await new Promise<ManagedBundlerExecResult>((resolveResult, reject) => {
        const child = spawn(process.execPath, [binPath, ...args], {
            cwd,
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        const timeout = timeoutMs
            ? setTimeout(() => child.kill('SIGTERM'), timeoutMs)
            : null;
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8'); });
        child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
        child.once('error', reject);
        child.once('close', (exitCode, signal) => {
            if (timeout) clearTimeout(timeout);
            resolveResult({ exitCode, signal, stdout, stderr });
        });
    });
}

function createStandaloneManagedBundlerExec(projectRoot: string): ManagedBundlerExecService {
    return {
        async run(input, options) {
            const cwd = input.cwd ?? projectRoot;
            if (input.installableId === 'plugin-ui.bundler.vite') {
                const viteBin = resolvePackageBin('vite', join('bin', 'vite.js'), cwd);
                return await runNodeBin(viteBin, input.args ?? [], cwd, options?.timeoutMs);
            }
            if (input.installableId === 'plugin-ui.bundler.repack') {
                const reactNativeBin = resolvePackageBin('react-native', 'cli.js', cwd);
                return await runNodeBin(reactNativeBin, input.args ?? [], cwd, options?.timeoutMs);
            }
            throw new Error(`Unknown plugin UI bundler installable: ${input.installableId}`);
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

async function defaultListEmittedFiles(
    surface: PluginUiBuildSurfaceV1,
    context: Readonly<{ projectRoot: string; emittedRoot: string }>,
): Promise<readonly string[]> {
    const outputRoot = resolve(context.projectRoot, surface.preset.output.root);
    let files: readonly string[];
    try {
        files = await listFilesRecursive(outputRoot);
    } catch (cause) {
        if ((cause as NodeJS.ErrnoException)?.code === 'ENOENT'
            && surface.kind === 'reactNative'
            && surface.preset.bundler === 'repack') {
            throw new PluginUiBuildError(
                'native_artifact_missing',
                `Managed Re.Pack build did not emit the declared ${surface.preset.platform} artifact for "${surface.preset.contributionId}"`,
                surface.preset.contributionId,
            );
        }
        throw cause;
    }
    return files.filter((file) => {
        const relativePath = relative(context.emittedRoot, file).split(sep).join('/');
        return relativePath && !relativePath.startsWith('../') && relativePath !== '..';
    });
}

const defaultLoadConfig: PluginBuildUiCliLoadConfigV1 = async ({ projectRoot, configPath }) => {
    const candidates = configPath
        ? [configPath]
        : PLUGIN_UI_BUILD_CONFIG_BASENAMES.map((name) => resolve(projectRoot, name));
    for (const candidate of candidates) {
        if (!await pathExists(candidate)) {
            continue;
        }
        return await importDefaultExport(candidate, projectRoot);
    }
    throw new PluginUiBuildError(
        'config_not_found',
        [
            `No plugin UI build config found (looked for ${candidates.join(', ')})`,
            'Create pluginUiBuild.mjs (or .js/.ts) exporting definePluginUiBuildConfig({ targets }), or pass --config <path>.',
        ].join('. '),
    );
};

function assertConfig(input: unknown, configPath: string): PluginUiBuildConfig {
    if (typeof input !== 'object' || input === null) {
        throw new PluginUiBuildError('config_invalid', `Plugin UI build config ${configPath} must export an object`);
    }
    const config = input as Partial<PluginUiBuildConfig>;
    const unknownConfigKey = Object.keys(config).find((key) => !['projectRoot', 'outDir', 'targets'].includes(key));
    if (unknownConfigKey) {
        throw new PluginUiBuildError('config_invalid', `Plugin UI build config ${configPath} contains unknown field "${unknownConfigKey}"`);
    }
    if (config.projectRoot !== undefined && typeof config.projectRoot !== 'string') {
        throw new PluginUiBuildError('config_invalid', `Plugin UI build config ${configPath} projectRoot must be a string`);
    }
    if (config.outDir !== undefined && typeof config.outDir !== 'string') {
        throw new PluginUiBuildError('config_invalid', `Plugin UI build config ${configPath} outDir must be a string`);
    }
    if (!Array.isArray(config.targets)) {
        throw new PluginUiBuildError('config_invalid', `Plugin UI build config ${configPath} must export targets[]`);
    }
    if (config.targets.length === 0) {
        throw new PluginUiBuildError('no_targets', `Plugin UI build config ${configPath} did not declare any targets`);
    }
    const targetIdentities = new Set<string>();
    for (const [index, target] of config.targets.entries()) {
        if (typeof target !== 'object' || target === null) {
            throw new PluginUiBuildError('config_invalid', `Plugin UI build config target[${index}] must be an object`);
        }
        const unknownTargetKey = Object.keys(target).find((key) => !['rendererId', 'entry', 'kind', 'platforms', 'module'].includes(key));
        if (unknownTargetKey) {
            throw new PluginUiBuildError('config_invalid', `Plugin UI build config target[${index}] contains unknown field "${unknownTargetKey}"`);
        }
        if (typeof target.rendererId !== 'string' || target.rendererId.trim() === '') {
            throw new PluginUiBuildError('config_invalid', `Plugin UI build config target[${index}] must declare rendererId`);
        }
        if (typeof target.entry !== 'string' || target.entry.trim() === '') {
            throw new PluginUiBuildError('config_invalid', `Plugin UI build config target[${index}] must declare entry`);
        }
        if (target.kind !== 'hostedWeb' && target.kind !== 'reactNative') {
            throw new PluginUiBuildError('config_invalid', `Plugin UI build config target[${index}] has unsupported kind`);
        }
        if (!Array.isArray(target.platforms) || target.platforms.length === 0) {
            throw new PluginUiBuildError('config_invalid', `Plugin UI build config target[${index}] must declare platforms[]`);
        }
        const invalidPlatform = target.platforms.find(
            (platform: unknown) => typeof platform !== 'string'
                || !['web', 'ios', 'android', 'desktop'].includes(platform),
        );
        if (invalidPlatform) {
            throw new PluginUiBuildError('config_invalid', `Plugin UI build config target[${index}] has unsupported platform "${invalidPlatform}"`);
        }
        if (new Set(target.platforms).size !== target.platforms.length) {
            throw new PluginUiBuildError('config_invalid', `Plugin UI build config target[${index}] contains duplicate platforms`);
        }
        if (target.kind === 'reactNative' && target.platforms.some((platform: unknown) => platform === 'ios' || platform === 'android')) {
            const module = target.module as Record<string, unknown> | undefined;
            if (!module || Object.keys(module).some((key) => !['containerName', 'modulePath', 'exportName'].includes(key))) {
                throw new PluginUiBuildError('config_invalid', `Plugin UI build config target[${index}] must declare exact module containerName/modulePath/exportName for native platforms`);
            }
            for (const key of ['containerName', 'modulePath', 'exportName'] as const) {
                if (typeof module[key] !== 'string' || module[key].trim() === '') {
                    throw new PluginUiBuildError('config_invalid', `Plugin UI build config target[${index}] module.${key} must be a non-empty string`);
                }
            }
        }
        const identity = `${target.kind}:${target.rendererId}`;
        if (targetIdentities.has(identity)) {
            throw new PluginUiBuildError('config_invalid', `Plugin UI build config contains duplicate target "${identity}"`);
        }
        targetIdentities.add(identity);
    }
    return config as PluginUiBuildConfig;
}

function replaceOutputRoot<TSurface extends PluginUiBuildSurfaceV1>(
    surface: TSurface,
    outputRoot: string,
): TSurface {
    return Object.freeze({
        ...surface,
        preset: Object.freeze({
            ...surface.preset,
            output: Object.freeze({ ...surface.preset.output, root: outputRoot }),
        }),
    }) as TSurface;
}

function createManagedBuildSurfaces(
    config: PluginUiBuildConfig,
    projectRoot: string,
    workRoot: string,
    versions: ManagedPluginUiBuildVersionsV1,
): readonly PluginUiBuildSurfaceV1[] {
    const rawRelativeWorkRoot = relative(projectRoot, workRoot);
    if (rawRelativeWorkRoot === '..' || rawRelativeWorkRoot.startsWith(`..${sep}`) || isAbsolute(rawRelativeWorkRoot)) {
        throw new PluginUiBuildError('config_invalid', 'Plugin UI build outDir must remain inside projectRoot');
    }
    const relativeWorkRoot = (rawRelativeWorkRoot || '.').split(sep).join('/');
    const surfaces: PluginUiBuildSurfaceV1[] = [];
    for (const target of config.targets) {
        if (target.kind === 'hostedWeb') {
            if (!versions.viteVersion) throw new PluginUiBuildError('bundler_version_missing', 'Managed Vite version is unavailable');
            const preset = defineHostedWebViteBuildPreset({
                contributionId: target.rendererId,
                sourceEntry: target.entry,
                viteVersion: versions.viteVersion,
                hostUiApiVersion: versions.hostUiApiVersion,
                reactVersion: versions.reactVersion,
            });
            surfaces.push(replaceOutputRoot({
                kind: 'hostedWeb',
                preset,
                hostUiApiVersion: versions.hostUiApiVersion,
                reactVersion: versions.reactVersion,
            }, `${relativeWorkRoot}/hosted-web/${target.rendererId}`));
            continue;
        }
        if (!versions.reactNativeVersion) throw new PluginUiBuildError('bundler_version_missing', 'Managed React Native version is unavailable');
        if (target.platforms.some((platform) => platform === 'web' || platform === 'desktop')) {
            if (!versions.viteVersion) throw new PluginUiBuildError('bundler_version_missing', 'Managed Vite version is unavailable');
            const preset = defineReactNativeWebViteBuildPreset({
                contributionId: target.rendererId,
                sourceEntry: target.entry,
                viteVersion: versions.viteVersion,
                hostUiApiVersion: versions.hostUiApiVersion,
                compatibility: {
                    reactVersion: versions.reactVersion,
                    reactNativeVersion: versions.reactNativeVersion,
                },
            });
            surfaces.push(replaceOutputRoot({
                kind: 'reactNative',
                preset,
                hostUiApiVersion: versions.hostUiApiVersion,
                compatibility: {
                    reactVersion: versions.reactVersion,
                    reactNativeVersion: versions.reactNativeVersion,
                },
            }, `${relativeWorkRoot}/react-native-web/${target.rendererId}`));
        }
        for (const platform of target.platforms) {
            if (platform !== 'ios' && platform !== 'android') continue;
            if (!versions.repackVersion) throw new PluginUiBuildError('bundler_version_missing', 'Managed Re.Pack version is unavailable');
            const preset = defineReactNativeRepackBuildPreset({
                contributionId: target.rendererId,
                platform,
                sourceEntry: target.entry,
                module: target.module!,
                repackVersion: versions.repackVersion,
                hostUiApiVersion: versions.hostUiApiVersion,
                compatibility: {
                    reactVersion: versions.reactVersion,
                    reactNativeVersion: versions.reactNativeVersion,
                },
            });
            surfaces.push(replaceOutputRoot({
                kind: 'reactNative',
                preset,
                hostUiApiVersion: versions.hostUiApiVersion,
                compatibility: {
                    reactVersion: versions.reactVersion,
                    reactNativeVersion: versions.reactNativeVersion,
                },
            }, `${relativeWorkRoot}/react-native/${target.rendererId}/${platform}`));
        }
    }
    return Object.freeze(surfaces);
}

function assertDeclarationArtifactEquality(
    surfaces: readonly PluginUiBuildSurfaceV1[],
    result: BuildUiArtifactsResultV1,
): void {
    const expected = surfaces.map((surface) => [
        surface.preset.tier,
        surface.preset.contributionId,
        surface.kind === 'reactNative' ? surface.preset.platform : 'web',
    ].join(':')).sort();
    const actual = result.manifest.entries.map((entry) => [entry.tier, entry.contributionId, entry.platform].join(':')).sort();
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        throw new PluginUiBuildError(
            'artifact_target_mismatch',
            `Staged plugin UI artifacts do not exactly match declared targets (expected ${expected.join(', ')}, received ${actual.join(', ')})`,
        );
    }
}

export async function runPluginBuildUiCli(input: RunPluginBuildUiCliInputV1): Promise<number> {
    const cwd = input.cwd ?? process.cwd();
    const reportError = input.onError ?? ((message: string) => process.stderr.write(`${message}\n`));
    const reportInfo = input.onInfo ?? ((message: string) => process.stdout.write(`${message}\n`));
    let parsed: ParsedArgs;
    try {
        parsed = parseArgs(input.argv, cwd);
    } catch (cause) {
        reportError(`happier-plugin-build-ui: ${(cause as Error).message}`);
        return 2;
    }
    if (parsed.help) {
        reportInfo(helpText());
        return 0;
    }

    const loadConfig = input.loadConfig ?? defaultLoadConfig;
    try {
        const loaded = await loadConfig({ projectRoot: parsed.projectRoot, configPath: parsed.configPath });
        const config = assertConfig(loaded, parsed.configPath ?? '<injected>');
        const configBase = parsed.configPath === null ? parsed.projectRoot : dirname(parsed.configPath);
        const projectRoot = resolve(configBase, config.projectRoot ?? '.');
        const workRoot = resolve(projectRoot, config.outDir ?? 'dist/ui');
        const resolveVersions = input.resolveManagedBuildVersions ?? resolveManagedPluginUiBuildVersions;
        const versions = resolveVersions(projectRoot, config.targets);
        const surfaces = createManagedBuildSurfaces(config, projectRoot, workRoot, versions);
        const runBundler = createManagedRuntimeBundlerRunner({
            exec: input.exec ?? createStandaloneManagedBundlerExec(projectRoot),
            emittedRoot: workRoot,
            listEmittedFiles: defaultListEmittedFiles,
            toArtifactRelativePath: (surface, absolutePath) => {
                const surfaceOutputRoot = resolve(projectRoot, surface.preset.output.root);
                const relativeToSurface = relative(surfaceOutputRoot, absolutePath).split(sep).join('/');
                const artifactDirectory = dirname(surface.preset.output.entry).split(sep).join('/');
                return `${artifactDirectory}/${relativeToSurface}`;
            },
        });
        const result = await buildUiArtifacts({
            projectRoot,
            surfaces,
            runBundler,
        });
        assertDeclarationArtifactEquality(surfaces, result);
        input.onSuccess?.(result);
        return 0;
    } catch (cause) {
        const code = cause instanceof PluginUiBuildError ? `[${cause.code}] ` : '';
        reportError(`happier-plugin-build-ui: ${code}${(cause as Error).message}`);
        return 1;
    }
}

/**
 * Whether this module is the process entry point. The bin is launched through
 * an npm `.bin` symlink, and under a `file:` dependency also through a
 * `node_modules` package symlink into the source checkout — so `argvEntry` and
 * the symlink-resolved `moduleUrl` differ by raw path while resolving to the
 * same real file. A raw string compare (the previous behavior) silently
 * no-ops the CLI (exit 0, zero output); compare canonical real paths instead,
 * falling back to a raw URL compare only when a path cannot be resolved.
 */
export function isBinDirectInvocation(params: Readonly<{
    argvEntry: string | undefined;
    moduleUrl: string;
}>): boolean {
    const entry = params.argvEntry;
    if (!entry) return false;
    try {
        return realpathSync(entry) === realpathSync(fileURLToPath(params.moduleUrl));
    } catch {
        return params.moduleUrl === pathToFileURL(entry).href;
    }
}

if (isBinDirectInvocation({ argvEntry: process.argv[1], moduleUrl: import.meta.url })) {
    void runPluginBuildUiCli({ argv: process.argv.slice(2) }).then((exitCode) => {
        process.exitCode = exitCode;
    });
}
