#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { access, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { basename, dirname, extname, isAbsolute, join, resolve, sep, relative } from 'node:path';

import type { ExecRuntimeServiceV1, ExecRunResultV1 } from '../../exec.js';
import {
    PLUGIN_UI_ARTIFACTS_ROOT_RELATIVE_PATH,
    buildUiArtifacts,
    PluginUiBuildError,
    type BuildUiArtifactsResultV1,
    type PluginUiBuildSurfaceV1,
    type PluginUiBundlerRunnerV1,
} from './buildUiArtifacts.js';

/**
 * Author-provided build configuration consumed by `happier-plugin-build-ui`.
 * Authors declare their UI surfaces (built from the `define*BuildPreset`
 * helpers) and the bundler runner. Real authors construct the runner with
 * `createManagedRuntimeBundlerRunner` so the bundler is invoked through the
 * managed runtime (binary-safe — never raw node/npm/npx).
 */
export type PluginBuildUiCliConfigV1 = Readonly<{
    surfaces: readonly PluginUiBuildSurfaceV1[];
    runBundler: PluginUiBundlerRunnerV1;
}>;

export type PluginBuildUiCliLoadConfigV1 = (
    context: PluginBuildUiCliConfigContextV1,
) => Promise<PluginBuildUiCliConfigV1>;

export type PluginBuildUiCliConfigContextV1 = Readonly<{
    projectRoot: string;
    configPath: string | null;
    exec: ExecRuntimeServiceV1;
    emittedRoot: string;
    listEmittedFiles: (
        surface: PluginUiBuildSurfaceV1,
        context: Readonly<{ projectRoot: string; emittedRoot: string }>,
    ) => Promise<readonly string[]>;
}>;

export type RunPluginBuildUiCliInputV1 = Readonly<{
    argv: readonly string[];
    cwd?: string;
    loadConfig?: PluginBuildUiCliLoadConfigV1;
    onError?: (message: string) => void;
    onInfo?: (message: string) => void;
    onSuccess?: (result: BuildUiArtifactsResultV1) => void;
}>;

const DEFAULT_CONFIG_BASENAMES = Object.freeze([
    'pluginUiBuild.mjs',
    'pluginUiBuild.js',
    'pluginUiBuild.ts',
    'happier-plugin-ui.config.mjs',
    'happier-plugin-ui.config.js',
    'happier-plugin-ui.config.ts',
] as const);

type ParsedArgs = Readonly<{
    projectRoot: string;
    configPath: string | null;
    help: boolean;
}>;

function helpText(): string {
    return [
        'happier-plugin-build-ui',
        '',
        'Builds plugin UI artifact files under dist/happier-plugin-ui.',
        '',
        'Usage:',
        '  happier-plugin-build-ui [--project-root <dir>] [--config <path>]',
        '  happier-plugin-build-ui --help',
        '',
        'Config discovery:',
        `  ${DEFAULT_CONFIG_BASENAMES.join(', ')}`,
        '',
        'Config export contract:',
        '  export function definePluginUiBuildConfig(context) { return { surfaces, runBundler }; }',
        '  export default { surfaces, runBundler }',
        '',
        'The context supplies projectRoot, configPath, emittedRoot, listEmittedFiles, and exec.',
        'Use createManagedRuntimeBundlerRunner(context) for Vite/Re.Pack managed-bundler dispatch.',
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
    return imported.default ?? imported.config ?? imported.definePluginUiBuildConfig ?? imported;
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
): Promise<ExecRunResultV1> {
    return await new Promise<ExecRunResultV1>((resolveResult, reject) => {
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

function createStandaloneManagedBundlerExec(projectRoot: string): ExecRuntimeServiceV1 {
    const unavailableHandle = {
        pid: null,
        exit: Promise.resolve({ exitCode: null, signal: null, stdout: '', stderr: '' }),
        async writeStdin() {
            throw new Error('happier-plugin-build-ui does not expose interactive bundler stdin');
        },
        kill() {},
        async dispose() {},
    };
    return {
        systemTools: {
            async resolve() {
                throw new Error('happier-plugin-build-ui only resolves managed plugin UI bundlers');
            },
        },
        async run(input, options) {
            if (input.kind !== 'managed-installable') {
                throw new Error(`happier-plugin-build-ui only supports managed-installable launches, received "${input.kind}"`);
            }
            const cwd = input.cwd ?? projectRoot;
            if (input.installableId === 'plugin-ui.bundler.vite') {
                const viteBin = resolvePackageBin('vite', join('bin', 'vite.js'), cwd);
                return await runNodeBin(viteBin, input.args ?? [], cwd, options?.timeoutMs);
            }
            if (input.installableId === 'plugin-ui.bundler.repack') {
                throw new Error(
                    'Re.Pack plugin UI builds require a host-managed runtime or a custom runBundler; use Vite/react-native-web with this standalone bin.',
                );
            }
            throw new Error(`Unknown plugin UI bundler installable: ${input.installableId}`);
        },
        async spawn() {
            return unavailableHandle;
        },
        spawnClient: (() => {
            throw new Error('happier-plugin-build-ui does not expose managed exec clients');
        }) as ExecRuntimeServiceV1['spawnClient'],
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
    const files = await listFilesRecursive(outputRoot);
    return files.filter((file) => {
        const relativePath = relative(context.emittedRoot, file).split(sep).join('/');
        return relativePath && !relativePath.startsWith('../') && relativePath !== '..';
    });
}

const defaultLoadConfig: PluginBuildUiCliLoadConfigV1 = async ({ projectRoot, configPath }) => {
    const candidates = configPath
        ? [configPath]
        : DEFAULT_CONFIG_BASENAMES.map((name) => resolve(projectRoot, name));
    for (const candidate of candidates) {
        if (!await pathExists(candidate)) {
            continue;
        }
        const loaded = await importDefaultExport(candidate, projectRoot);
        const context = createConfigContext(projectRoot, candidate);
        const config = typeof loaded === 'function'
            ? await (loaded as (configContext: PluginBuildUiCliConfigContextV1) => Promise<PluginBuildUiCliConfigV1> | PluginBuildUiCliConfigV1)(context)
            : loaded;
        return assertConfig(config, candidate);
    }
    throw new PluginUiBuildError(
        'config_not_found',
        [
            `No plugin UI build config found (looked for ${candidates.join(', ')})`,
            'Create pluginUiBuild.mjs (or .js/.ts) exporting definePluginUiBuildConfig(context), or pass --config <path>.',
        ].join('. '),
    );
};

function createConfigContext(projectRoot: string, configPath: string | null): PluginBuildUiCliConfigContextV1 {
    const emittedRoot = resolve(projectRoot, ...PLUGIN_UI_ARTIFACTS_ROOT_RELATIVE_PATH.split('/'));
    return {
        projectRoot,
        configPath,
        emittedRoot,
        exec: createStandaloneManagedBundlerExec(projectRoot),
        listEmittedFiles: defaultListEmittedFiles,
    };
}

function assertConfig(input: unknown, configPath: string): PluginBuildUiCliConfigV1 {
    if (typeof input !== 'object' || input === null) {
        throw new PluginUiBuildError('config_invalid', `Plugin UI build config ${configPath} must export an object`);
    }
    const config = input as Partial<PluginBuildUiCliConfigV1>;
    if (!Array.isArray(config.surfaces)) {
        throw new PluginUiBuildError('config_invalid', `Plugin UI build config ${configPath} must export surfaces[]`);
    }
    if (config.surfaces.length === 0) {
        throw new PluginUiBuildError('no_surfaces', `Plugin UI build config ${configPath} did not declare any surfaces`);
    }
    if (typeof config.runBundler !== 'function') {
        throw new PluginUiBuildError('config_invalid', `Plugin UI build config ${configPath} must export runBundler`);
    }
    return config as PluginBuildUiCliConfigV1;
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
        const config = await loadConfig(createConfigContext(parsed.projectRoot, parsed.configPath));
        const result = await buildUiArtifacts({
            projectRoot: parsed.projectRoot,
            surfaces: config.surfaces,
            runBundler: config.runBundler,
        });
        input.onSuccess?.(result);
        return 0;
    } catch (cause) {
        const code = cause instanceof PluginUiBuildError ? `[${cause.code}] ` : '';
        reportError(`happier-plugin-build-ui: ${code}${(cause as Error).message}`);
        return 1;
    }
}

function isDirectInvocation(): boolean {
    const entry = process.argv[1];
    if (!entry) return false;
    return import.meta.url === pathToFileURL(entry).href;
}

if (isDirectInvocation()) {
    void runPluginBuildUiCli({ argv: process.argv.slice(2) }).then((exitCode) => {
        process.exitCode = exitCode;
    });
}
