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
import { readRelativeBuildPath } from '../buildPaths.js';
import {
    buildUiArtifacts,
    PluginUiBuildError,
    type BuildUiArtifactsResultV1,
    type PluginUiBuildSurfaceV1,
} from './buildUiArtifacts.js';
import {
    BUILD_CONFIG_BASENAMES,
    DEFAULT_PLUGIN_UI_BUILD_OUT_DIR,
    resolvePluginUiSurfaceOutDir,
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
import { prepareManagedPluginUiBuildOperation } from './managedBuildConfig.js';

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
        `  ${BUILD_CONFIG_BASENAMES.join(', ')}`,
        '',
        'Config export contract:',
        '  export default defineBuildConfig({ projectRoot?, outDir?, targets: [...] })',
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

function createManagedBundlerChildEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
    const childEnv = { ...env };
    // The workspace builder grants this process authority over its staged dist
    // tree. Vite/Re.Pack are work-artifact producers, not nested package
    // builders, so passing that authority through lets their dependency
    // lifecycle scripts replace the parent package's staged TypeScript output.
    // Environment names are case-insensitive on Windows; clear every alias.
    for (const name of Object.keys(childEnv)) {
        if (name.toLowerCase() === 'happier_workspace_dist_output_dir') {
            delete childEnv[name];
        }
    }
    return childEnv;
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
            env: createManagedBundlerChildEnv(),
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
        : BUILD_CONFIG_BASENAMES.map((name) => resolve(projectRoot, name));
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
            'Create pluginUiBuild.mjs (or .js/.ts) exporting defineBuildConfig({ targets }), or pass --config <path>.',
        ].join('. '),
    );
};

function normalizeBundlerConfigPath(value: unknown, targetIndex: number): string {
    if (typeof value !== 'string') {
        throw new PluginUiBuildError(
            'config_invalid',
            `Plugin UI build config target[${targetIndex}] bundlerConfig must be a string`,
        );
    }
    try {
        return readRelativeBuildPath(value, 'bundlerConfig');
    } catch (cause) {
        throw new PluginUiBuildError(
            'config_invalid',
            `Plugin UI build config target[${targetIndex}] ${(cause as Error).message}`,
        );
    }
}

function targetProducesViteSurface(target: PluginUiBuildTarget): boolean {
    if (target.kind === 'hostedWeb') return true;
    return target.platforms.some((platform) => platform === 'web' || platform === 'desktop');
}

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
    const normalizedTargets: PluginUiBuildTarget[] = [];
    for (const [index, target] of config.targets.entries()) {
        if (typeof target !== 'object' || target === null) {
            throw new PluginUiBuildError('config_invalid', `Plugin UI build config target[${index}] must be an object`);
        }
        // `loadConfig` is an untrusted module boundary. Keep the narrow cast
        // local and validate every field before it reaches the typed builder.
        const targetRecord = target as Record<string, unknown>;
        if (targetRecord.kind !== 'hostedWeb' && targetRecord.kind !== 'reactNative') {
            throw new PluginUiBuildError('config_invalid', `Plugin UI build config target[${index}] has unsupported kind`);
        }
        const allowedTargetKeys = targetRecord.kind === 'hostedWeb'
            ? ['rendererId', 'entry', 'kind', 'bundlerConfig']
            : ['rendererId', 'entry', 'kind', 'platforms', 'bundlerConfig', 'module', 'collectionMigrations'];
        const unknownTargetKey = Object.keys(targetRecord).find((key) => !allowedTargetKeys.includes(key));
        if (unknownTargetKey) {
            if (targetRecord.kind === 'hostedWeb' && unknownTargetKey === 'platforms') {
                throw new PluginUiBuildError(
                    'config_invalid',
                    `Plugin UI build config target[${index}] hostedWeb does not accept platforms; it emits one portable web graph`,
                );
            }
            throw new PluginUiBuildError('config_invalid', `Plugin UI build config target[${index}] contains unknown field "${unknownTargetKey}"`);
        }
        if (typeof targetRecord.rendererId !== 'string' || targetRecord.rendererId.trim() === '') {
            throw new PluginUiBuildError('config_invalid', `Plugin UI build config target[${index}] must declare rendererId`);
        }
        if (typeof targetRecord.entry !== 'string' || targetRecord.entry.trim() === '') {
            throw new PluginUiBuildError('config_invalid', `Plugin UI build config target[${index}] must declare entry`);
        }
        const rendererId = targetRecord.rendererId;
        const entry = targetRecord.entry;
        const bundlerConfig = targetRecord.bundlerConfig === undefined
            ? undefined
            : normalizeBundlerConfigPath(targetRecord.bundlerConfig, index);
        const identity = `${targetRecord.kind}:${rendererId}`;
        if (targetIdentities.has(identity)) {
            throw new PluginUiBuildError('config_invalid', `Plugin UI build config contains duplicate target "${identity}"`);
        }
        targetIdentities.add(identity);

        if (targetRecord.kind === 'hostedWeb') {
            normalizedTargets.push(Object.freeze({
                rendererId,
                entry,
                kind: 'hostedWeb',
                ...(bundlerConfig === undefined ? {} : { bundlerConfig }),
            }));
            continue;
        }

        const platforms = targetRecord.platforms;
        if (!Array.isArray(platforms) || platforms.length === 0) {
            throw new PluginUiBuildError('config_invalid', `Plugin UI build config target[${index}] must declare platforms[]`);
        }
        const invalidPlatform = platforms.find(
            (platform: unknown) => typeof platform !== 'string'
                || !['web', 'ios', 'android', 'desktop'].includes(platform),
        );
        if (invalidPlatform) {
            throw new PluginUiBuildError('config_invalid', `Plugin UI build config target[${index}] has unsupported platform "${invalidPlatform}"`);
        }
        if (new Set(platforms).size !== platforms.length) {
            throw new PluginUiBuildError('config_invalid', `Plugin UI build config target[${index}] contains duplicate platforms`);
        }
        const moduleValue = targetRecord.module;
        let module: Readonly<{ containerName: string; modulePath: string; exportName: string }> | undefined;
        if (moduleValue !== undefined) {
            if (
                typeof moduleValue !== 'object'
                || moduleValue === null
                || Array.isArray(moduleValue)
                || Object.keys(moduleValue).some((key) => !['containerName', 'modulePath', 'exportName'].includes(key))
            ) {
                throw new PluginUiBuildError('config_invalid', `Plugin UI build config target[${index}] must declare exact module containerName/modulePath/exportName for native platforms`);
            }
            const moduleRecord = moduleValue as Record<string, unknown>;
            for (const key of ['containerName', 'modulePath', 'exportName'] as const) {
                if (typeof moduleRecord[key] !== 'string' || moduleRecord[key].trim() === '') {
                    throw new PluginUiBuildError('config_invalid', `Plugin UI build config target[${index}] module.${key} must be a non-empty string`);
                }
            }
            module = Object.freeze({
                containerName: moduleRecord.containerName as string,
                modulePath: moduleRecord.modulePath as string,
                exportName: moduleRecord.exportName as string,
            });
        }
        if (platforms.some((platform: unknown) => platform === 'ios' || platform === 'android') && !module) {
            throw new PluginUiBuildError('config_invalid', `Plugin UI build config target[${index}] must declare exact module containerName/modulePath/exportName for native platforms`);
        }
        const collectionMigrationsValue = targetRecord.collectionMigrations;
        let collectionMigrations: Readonly<{ exportName: string }> | undefined;
        if (collectionMigrationsValue !== undefined) {
            if (
                typeof collectionMigrationsValue !== 'object'
                || collectionMigrationsValue === null
                || Array.isArray(collectionMigrationsValue)
                || Object.keys(collectionMigrationsValue).some((key) => key !== 'exportName')
            ) {
                throw new PluginUiBuildError(
                    'config_invalid',
                    `Plugin UI build config target[${index}] must declare exact collectionMigrations.exportName`,
                );
            }
            const collectionMigrationsRecord = collectionMigrationsValue as Record<string, unknown>;
            if (
                typeof collectionMigrationsRecord.exportName !== 'string'
                || collectionMigrationsRecord.exportName.trim() === ''
            ) {
                throw new PluginUiBuildError(
                    'config_invalid',
                    `Plugin UI build config target[${index}] collectionMigrations.exportName must be a non-empty string`,
                );
            }
            collectionMigrations = Object.freeze({ exportName: collectionMigrationsRecord.exportName });
        }
        normalizedTargets.push(Object.freeze({
            rendererId,
            entry,
            kind: 'reactNative',
            platforms: Object.freeze([...platforms]) as readonly ('web' | 'ios' | 'android' | 'desktop')[],
            ...(bundlerConfig === undefined ? {} : { bundlerConfig }),
            ...(module === undefined ? {} : { module }),
            ...(collectionMigrations === undefined ? {} : { collectionMigrations }),
        }));
    }
    return Object.freeze({
        ...(config.projectRoot === undefined ? {} : { projectRoot: config.projectRoot }),
        ...(config.outDir === undefined ? {} : { outDir: config.outDir }),
        targets: Object.freeze(normalizedTargets),
    });
}

function replaceOutputRoot<TSurface extends PluginUiBuildSurfaceV1>(
    surface: TSurface,
    outputRoot: string,
    bundlerConfigPath?: string,
): TSurface {
    return Object.freeze({
        ...surface,
        ...(bundlerConfigPath === undefined ? {} : { bundlerConfigPath }),
        preset: Object.freeze({
            ...surface.preset,
            output: Object.freeze({ ...surface.preset.output, root: outputRoot }),
        }),
    }) as TSurface;
}

function resolveTargetViteConfigPath(
    projectRoot: string,
    target: PluginUiBuildTarget,
): string | undefined {
    if (target.bundlerConfig === undefined) {
        return undefined;
    }
    const bundlerConfigPath = resolve(projectRoot, target.bundlerConfig);
    const relativeConfigPath = relative(projectRoot, bundlerConfigPath);
    if (
        relativeConfigPath === '..'
        || relativeConfigPath.startsWith(`..${sep}`)
        || isAbsolute(relativeConfigPath)
    ) {
        throw new PluginUiBuildError(
            'config_invalid',
            `Plugin UI build target "${target.rendererId}" bundlerConfig must remain inside projectRoot`,
            target.rendererId,
        );
    }
    return bundlerConfigPath;
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
        // Public `bundlerConfig` selects only an advanced Vite extension. Native
        // Re.Pack always receives the builder-materialized config later in
        // this operation; one path cannot safely represent both formats.
        const viteConfigPath = targetProducesViteSurface(target)
            ? resolveTargetViteConfigPath(projectRoot, target)
            : undefined;
        if (target.kind === 'hostedWeb') {
            if (!versions.viteVersion) throw new PluginUiBuildError('bundler_version_missing', 'Managed Vite version is unavailable');
            const preset = defineHostedWebViteBuildPreset({
                contributionId: target.rendererId,
                sourceEntry: target.entry,
                viteVersion: versions.viteVersion,
                hostUiApiVersion: versions.hostUiApiVersion,
            });
            surfaces.push(replaceOutputRoot({
                kind: 'hostedWeb',
                preset,
                hostUiApiVersion: versions.hostUiApiVersion,
            }, resolvePluginUiSurfaceOutDir({
                kind: 'hostedWeb',
                rendererId: target.rendererId,
                outDir: relativeWorkRoot,
            }), viteConfigPath));
            continue;
        }
        if (!versions.reactNativeVersion) throw new PluginUiBuildError('bundler_version_missing', 'Managed React Native version is unavailable');
        if (!versions.reactVersion) throw new PluginUiBuildError('bundler_version_missing', 'Managed React version is unavailable');
        if (target.platforms.some((platform) => platform === 'web' || platform === 'desktop')) {
            if (!versions.viteVersion) throw new PluginUiBuildError('bundler_version_missing', 'Managed Vite version is unavailable');
            const preset = defineReactNativeWebViteBuildPreset({
                contributionId: target.rendererId,
                sourceEntry: target.entry,
                viteVersion: versions.viteVersion,
                hostUiApiVersion: versions.hostUiApiVersion,
                ...(target.collectionMigrations ? { collectionMigrations: target.collectionMigrations } : {}),
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
            }, resolvePluginUiSurfaceOutDir({
                kind: 'reactNative',
                rendererId: target.rendererId,
                platform: 'web',
                outDir: relativeWorkRoot,
            }), viteConfigPath));
        }
        for (const platform of target.platforms) {
            if (platform !== 'ios' && platform !== 'android') continue;
            if (!versions.repackVersion) throw new PluginUiBuildError('bundler_version_missing', 'Managed Re.Pack version is unavailable');
            const preset = defineReactNativeRepackBuildPreset({
                contributionId: target.rendererId,
                platform,
                sourceEntry: target.entry,
                module: target.module!,
                ...(target.collectionMigrations ? { collectionMigrations: target.collectionMigrations } : {}),
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
            }, resolvePluginUiSurfaceOutDir({
                kind: 'reactNative',
                rendererId: target.rendererId,
                platform,
                outDir: relativeWorkRoot,
            })));
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
        const workRoot = resolve(projectRoot, config.outDir ?? DEFAULT_PLUGIN_UI_BUILD_OUT_DIR);
        const resolveVersions = input.resolveManagedBuildVersions ?? resolveManagedPluginUiBuildVersions;
        const versions = resolveVersions(projectRoot, config.targets);
        const surfaces = createManagedBuildSurfaces(config, projectRoot, workRoot, versions);
        const prepared = await prepareManagedPluginUiBuildOperation({ projectRoot, surfaces });
        try {
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
                surfaces: prepared.surfaces,
                runBundler,
            });
            assertDeclarationArtifactEquality(prepared.surfaces, result);
            input.onSuccess?.(result);
            return 0;
        } finally {
            await prepared.cleanup();
        }
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
