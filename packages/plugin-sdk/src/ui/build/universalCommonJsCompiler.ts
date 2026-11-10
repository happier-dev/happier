/// <reference path="./babelPluginTransformBlockScoping.d.ts" />
/// <reference path="./babelPluginTransformClasses.d.ts" />
import { readFile, readdir } from 'node:fs/promises';
import { builtinModules } from 'node:module';
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import { transformAsync } from '@babel/core';
import transformBlockScoping from '@babel/plugin-transform-block-scoping';
import transformClasses from '@babel/plugin-transform-classes';
import { build, version as esbuildVersion, type Metafile, type Plugin } from 'esbuild';

import { PLUGIN_UI_HOST_RUNTIME_EXTERNAL_SPECIFIERS } from '@happier-dev/protocol/plugins/ui/hostRuntimeExternals';

export class PluginUiUniversalCompilerError extends Error {
    readonly code: string;
    readonly artifactId: string;

    constructor(code: string, artifactId: string, message: string) {
        super(message);
        this.name = 'PluginUiUniversalCompilerError';
        this.code = code;
        this.artifactId = artifactId;
    }
}

export type UniversalPluginUiCommonJsCompileResult = Readonly<{
    artifactId: string;
    relativePath: `react-native/${string}/entry.cjs.bundle`;
    bytes: Uint8Array;
    exports: readonly string[];
    externalSpecifiers: readonly string[];
    esbuildVersion: string;
    metafile: Metafile;
    outputFiles: readonly Readonly<{ path: string; bytes: Uint8Array }>[];
}>;

const hostExternalSpecifiers = new Set<string>(PLUGIN_UI_HOST_RUNTIME_EXTERNAL_SPECIFIERS);
const nodeBuiltins = new Set(builtinModules.flatMap((name) => [name, `node:${name}`]));
const unsupportedAssetExtension = /\.(?:avif|bmp|gif|ico|jpe?g|mp3|mp4|otf|pdf|png|svg|ttf|wav|webm|webp|woff2?)$/iu;
const platformVariantSourceExtension = /\.(?:[cm]?[jt]sx?|json)$/u;
const platformVariantSuffix = /\.(?:ios|android|native|web)(?=\.[^./\\]+$)/u;
export const UNIVERSAL_PLUGIN_UI_EXPORT_CONDITIONS = Object.freeze([
    'react-native',
    'module',
    'import',
    'default',
] as const);

function isPathWithinRoot(root: string, candidate: string): boolean {
    const relativePath = relative(root, candidate);
    return relativePath === '' || (
        !isAbsolute(relativePath)
        && relativePath !== '..'
        && !relativePath.startsWith(`..${sep}`)
    );
}

function isPluginOwnedInput(projectRoot: string, inputPath: string): boolean {
    if (!isPathWithinRoot(projectRoot, inputPath)) return false;
    return !relative(projectRoot, inputPath).split(/[/\\]/u).includes('node_modules');
}

function escapeRegularExpression(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

async function assertPortablePluginOwnedInputs(
    projectRoot: string,
    artifactId: string,
    metafileInputs: Readonly<Record<string, unknown>>,
): Promise<void> {
    const directoryEntries = new Map<string, readonly string[]>();
    for (const metafileInput of Object.keys(metafileInputs)) {
        const inputPath = isAbsolute(metafileInput) ? metafileInput : resolve(projectRoot, metafileInput);
        if (!isPluginOwnedInput(projectRoot, inputPath)) continue;
        const inputName = basename(inputPath);
        const displayPath = relative(projectRoot, inputPath);
        if (platformVariantSuffix.test(inputName)) {
            throw new PluginUiUniversalCompilerError(
                'platform_variant_unsupported',
                artifactId,
                `Executable Plugin UI artifact "${artifactId}" reaches platform-specific source "${displayPath}"; use one portable source graph and branch on Platform.OS at runtime`,
            );
        }
        const extension = extname(inputName);
        if (!platformVariantSourceExtension.test(extension)) continue;
        const stem = inputName.slice(0, -extension.length);
        const directoryPath = dirname(inputPath);
        let siblingNames = directoryEntries.get(directoryPath);
        if (!siblingNames) {
            siblingNames = await readdir(directoryPath);
            directoryEntries.set(directoryPath, siblingNames);
        }
        const platformSiblingPattern = new RegExp(
            `^${escapeRegularExpression(stem)}\\.(?:ios|android|native|web)\\.(?:[cm]?[jt]sx?|json)$`,
            'u',
        );
        const platformSibling = siblingNames.find((candidate) => platformSiblingPattern.test(candidate));
        if (platformSibling) {
            throw new PluginUiUniversalCompilerError(
                'platform_variant_ambiguous',
                artifactId,
                `Executable Plugin UI artifact "${artifactId}" reaches portable source "${displayPath}" beside platform variant "${relative(projectRoot, join(directoryPath, platformSibling))}"; remove the ambiguous platform sibling and branch on Platform.OS at runtime`,
            );
        }
    }
}

function compilerPolicyPlugin(artifactId: string, resolveSourceImport?: (specifier: string) => string | undefined): Plugin {
    return {
        name: 'happier-plugin-ui-universal-cjs-policy',
        setup(pluginBuild) {
            pluginBuild.onResolve({ filter: /.*/ }, async (args) => {
                if (args.path === '@happier-dev/plugin-ui/presentation'
                    || args.path.startsWith('@happier-dev/plugin-ui/presentation/')) {
                    throw new PluginUiUniversalCompilerError(
                        'host_private_import_unsupported',
                        artifactId,
                        `Executable Plugin UI artifact "${artifactId}" imports host-private "${args.path}"; use @happier-dev/plugin-ui/components`,
                    );
                }
                if (args.path === 'react-native-web' && args.kind !== 'entry-point') {
                    throw new PluginUiUniversalCompilerError(
                        'direct_react_native_web_import',
                        artifactId,
                        `Executable Plugin UI artifact "${artifactId}" must import react-native, not react-native-web`,
                    );
                }
                if (
                    (args.path === 'crypto' || args.path === 'buffer')
                    && /[/\\]tweetnacl[/\\]/u.test(args.importer)
                ) {
                    return { path: args.path, namespace: 'happier-tweetnacl-browser-false' };
                }
                if (nodeBuiltins.has(args.path)) {
                    throw new PluginUiUniversalCompilerError(
                        'node_builtin_unsupported',
                        artifactId,
                        `Executable Plugin UI artifact "${artifactId}" imports unsupported Node built-in "${args.path}"`,
                    );
                }
                if (hostExternalSpecifiers.has(args.path)) {
                    return { path: args.path, external: true };
                }
                if (unsupportedAssetExtension.test(args.path)) {
                    throw new PluginUiUniversalCompilerError(
                        'binary_asset_import_unsupported',
                        artifactId,
                        `Executable Plugin UI artifact "${artifactId}" imports a binary asset; use Plugin Resources, a bounded data representation, or hosted static UI`,
                    );
                }
                if (/^[^./#]/u.test(args.path)) {
                    const sourcePath = resolveSourceImport?.(args.path);
                    if (sourcePath) {
                        // Let esbuild retain package-owned sideEffects metadata
                        // when authoring builds redirect a package to its source.
                        return pluginBuild.resolve(sourcePath, {
                            kind: args.kind, resolveDir: args.resolveDir, importer: args.importer,
                        });
                    }
                }
                return null;
            });
            pluginBuild.onLoad(
                { filter: /.*/, namespace: 'happier-tweetnacl-browser-false' },
                () => ({ contents: 'module.exports = {};', loader: 'js' }),
            );
        },
    };
}

/**
 * The native app evaluates artifacts with Hermes, whose `new Function` compiles `let`/`const` to one
 * function-scoped binding: every closure created in a loop shares it. esbuild keeps those loops at any target,
 * including its own namespace helper, so a plugin's `React.useMemo` would read React's last export. Lower them
 * here, once, for the one universal artifact. Class syntax also needs lowering: this evaluator rejects
 * small class bodies at parse time and can miscompile construction in large ones as undefined.prototype.
 */
async function lowerHermesSyntax(artifactId: string, source: string): Promise<Uint8Array> {
    const lowered = await transformAsync(source, {
        configFile: false, babelrc: false, sourceType: 'script', minified: true,
        shouldPrintComment: comment => /@license|@preserve|^!/u.test(comment),
        plugins: [transformClasses, transformBlockScoping],
    }).catch((cause: unknown) => {
        throw new PluginUiUniversalCompilerError('compile_failed', artifactId,
            `Executable Plugin UI artifact "${artifactId}" failed to compile: ${cause instanceof Error ? cause.message : String(cause)}`);
    });
    if (typeof lowered?.code !== 'string') {
        throw new PluginUiUniversalCompilerError('compile_failed', artifactId, `Executable Plugin UI artifact "${artifactId}" produced no output`);
    }
    return new TextEncoder().encode(lowered.code);
}

async function reportBundledHostModules(projectRoot: string, artifactId: string, metafile: Metafile): Promise<void> {
    const packages = new Map<string, Readonly<{ name: string; root: string }> | null>();
    async function packageAt(directory: string): Promise<Readonly<{ name: string; root: string }> | null> {
        if (packages.has(directory)) return packages.get(directory)!;
        let owner = null;
        try {
            const manifest: unknown = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'));
            if (manifest && typeof manifest === 'object' && 'name' in manifest && typeof manifest.name === 'string') {
                owner = { name: manifest.name, root: directory };
            }
        } catch (cause) {
            if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause;
            const parent = dirname(directory);
            if (parent !== directory) owner = await packageAt(parent);
        }
        packages.set(directory, owner);
        return owner;
    }
    const modules = new Set<string>();
    for (const output of Object.values(metafile.outputs)) {
        for (const [path, contribution] of Object.entries(output.inputs)) {
            if (contribution.bytesInOutput === 0) continue;
            const absolutePath = resolve(projectRoot, path);
            const owner = await packageAt(dirname(absolutePath));
            if (!owner) continue;
            if (hostExternalSpecifiers.has(owner.name)) modules.add(owner.name);
            else if (owner.name === '@happier-dev/plugin-sdk'
                && /^(?:src|dist)[/\\]ui[/\\]client[/\\]/u.test(relative(owner.root, absolutePath))) {
                modules.add('@happier-dev/plugin-sdk/ui/client');
            }
        }
    }
    if (modules.size > 0) {
        console.warn('[bundled_host_module] Plugin UI artifact includes host-provided module code', {
            artifactId, modules: [...modules].sort(),
        });
    }
}

export async function compileUniversalPluginUiCommonJs(input: Readonly<{
    projectRoot: string;
    entryPath: string;
    artifactId: string;
    requestedExports: readonly string[];
    exportConditions?: readonly string[];
    resolveSourceImport?: (specifier: string) => string | undefined;
    collectionMigrationManifest?: Readonly<Record<string, unknown>>;
}>): Promise<UniversalPluginUiCommonJsCompileResult> {
    const projectRoot = resolve(input.projectRoot);
    const entryPath = isAbsolute(input.entryPath) ? input.entryPath : resolve(projectRoot, input.entryPath);
    const relativePath = `react-native/${input.artifactId}/entry.cjs.bundle` as const;
    const outputPath = join(projectRoot, relativePath);
    // Discovery supplies the same captured declaration used to select this
    // artifact. Its authored entry returns only callbacks, so portable code
    // never has to evaluate the daemon's full plugin definition.
    const entry = input.collectionMigrationManifest
        ? { stdin: {
            contents: [
                `export * from ${JSON.stringify(entryPath)};`,
                ...(input.requestedExports.includes('default')
                    ? [`export { default } from ${JSON.stringify(entryPath)};`]
                    : []),
                `import { collectionMigrations as callbacks } from ${JSON.stringify(entryPath)};`,
                `const manifest = JSON.parse(${JSON.stringify(JSON.stringify(input.collectionMigrationManifest))});`,
                'export function collectionMigrations() { return { manifest, collectionMigrations: callbacks() }; }',
            ].join('\n'),
            resolveDir: projectRoot,
            sourcefile: 'collection-migration-artifact.js',
            loader: 'js' as const,
        } }
        : { entryPoints: [entryPath] };
    let result;
    try {
        result = await build({
            absWorkingDir: projectRoot,
            ...entry,
            outfile: outputPath,
            bundle: true,
            packages: 'bundle',
            platform: 'neutral',
            format: 'cjs',
            splitting: false,
            minify: true,
            treeShaking: true,
            jsx: 'automatic',
            sourcemap: false,
            legalComments: 'eof',
            charset: 'utf8',
            target: 'es2020',
            // Hermes's dynamic evaluator leaves async arrows undefined in large
            // artifacts. esbuild lowers them to supported generator functions.
            supported: { 'async-await': false },
            mainFields: ['module', 'main'],
            conditions: [...(input.exportConditions ?? []), ...UNIVERSAL_PLUGIN_UI_EXPORT_CONDITIONS],
            metafile: true,
            write: false,
            plugins: [
                compilerPolicyPlugin(input.artifactId, input.resolveSourceImport),
            ],
            logLevel: 'silent',
        });
    } catch (cause) {
        if (cause instanceof PluginUiUniversalCompilerError) throw cause;
        const policyError = (cause as Readonly<{
            errors?: readonly Readonly<{ detail?: unknown; text?: string }>[];
        }>).errors?.find((error) => error.detail instanceof PluginUiUniversalCompilerError)?.detail;
        if (policyError instanceof PluginUiUniversalCompilerError) throw policyError;
        const diagnostic = (cause as Readonly<{
            errors?: readonly Readonly<{ text?: string }>[];
        }>).errors?.find((error) => typeof error.text === 'string')?.text
            ?? (cause instanceof Error ? cause.message : undefined);
        throw new PluginUiUniversalCompilerError(
            'compile_failed',
            input.artifactId,
            `Executable Plugin UI artifact "${input.artifactId}" failed to compile${diagnostic ? `: ${diagnostic}` : ''}`,
        );
    }

    if (result.outputFiles.length !== 1) {
        throw new PluginUiUniversalCompilerError(
            'unexpected_output_graph',
            input.artifactId,
            `Executable Plugin UI artifact "${input.artifactId}" must emit exactly one file`,
        );
    }
    await assertPortablePluginOwnedInputs(projectRoot, input.artifactId, result.metafile.inputs);
    const output = result.outputFiles[0]!;
    const bytes = await lowerHermesSyntax(input.artifactId, output.text);
    const externalSpecifiers = [...new Set(
        Object.values(result.metafile.outputs).flatMap((metafileOutput) => (
            metafileOutput.imports
                .filter((importRecord) => importRecord.external)
                .map((importRecord) => importRecord.path)
        )),
    )].sort();
    const unexpectedExternal = externalSpecifiers.find((specifier) => !hostExternalSpecifiers.has(specifier));
    if (unexpectedExternal) {
        throw new PluginUiUniversalCompilerError(
            'unexpected_external',
            input.artifactId,
            `Executable Plugin UI artifact "${input.artifactId}" retained unexpected external import "${unexpectedExternal}"`,
        );
    }
    await reportBundledHostModules(projectRoot, input.artifactId, result.metafile);
    const exportAnalysis = await build({
        absWorkingDir: projectRoot,
        // Check the authored entry too: the wrapper must not fabricate an
        // export that the plugin failed to provide.
        entryPoints: [entryPath],
        outfile: join(projectRoot, '.happier-plugin-ui-export-analysis.mjs'),
        bundle: false,
        platform: 'neutral',
        format: 'esm',
        jsx: 'automatic',
        target: 'es2020',
        metafile: true,
        write: false,
        logLevel: 'silent',
    });
    const emittedExports = [...(Object.values(exportAnalysis.metafile.outputs)[0]?.exports ?? [])].sort();
    const requestedExports = [...new Set(input.requestedExports)].sort();
    const missingExport = requestedExports.find((name) => !emittedExports.includes(name));
    if (missingExport) {
        throw new PluginUiUniversalCompilerError(
            'requested_export_missing',
            input.artifactId,
            `Executable Plugin UI artifact "${input.artifactId}" does not export "${missingExport}"`,
        );
    }

    return Object.freeze({
        artifactId: input.artifactId,
        relativePath,
        bytes,
        exports: Object.freeze(requestedExports),
        externalSpecifiers: Object.freeze(externalSpecifiers),
        esbuildVersion,
        metafile: result.metafile,
        outputFiles: Object.freeze([Object.freeze({
            path: output.path,
            bytes: bytes.slice(),
        })]),
    });
}
