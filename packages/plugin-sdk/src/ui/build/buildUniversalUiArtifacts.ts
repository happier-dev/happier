import { lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

import { build } from 'esbuild';

import { PLUGIN_UI_ARTIFACT_GRAMMAR_VERSION_V2, PLUGIN_UI_HOST_API_VERSION_V1, PluginUiArtifactsManifestV2Schema, computePluginUiArtifactFileSetSha256DigestV1, computePluginUiArtifactSha256DigestV1 } from '@happier-dev/protocol/plugins/ui';

import type { PluginUiArtifactsManifestV2 } from '../hostedWebRuntime.js';

import { PluginUiBuildError } from './errors.js';
import {
    discoverExecutablePluginUiArtifacts,
    discoverHostedStaticPluginUiArtifacts,
    type DiscoveredHostedStaticPluginUiArtifact,
} from './manifestArtifactDiscovery.js';
import { compileUniversalPluginUiCommonJs } from './universalCommonJsCompiler.js';

export const PLUGIN_UI_ARTIFACTS_ROOT_RELATIVE_PATH = 'dist/happier-plugin-ui';
export const PLUGIN_UI_ARTIFACTS_MANIFEST_FILE = 'ui-artifacts.json';

function resolvePluginUiArtifactsStagingParent(artifactsRoot: string): string {
    // Atomic rename requires the staged tree and destination to share a
    // filesystem. Author projects may symlink node_modules across devices.
    return join(dirname(artifactsRoot), '.happier-plugin-ui-publications');
}

export type BuildUniversalPluginUiArtifactsResult = Readonly<{
    artifactsRoot: string;
    manifest: PluginUiArtifactsManifestV2;
}>;

type StagedArtifactFile = Readonly<{
    bytes: Uint8Array;
    relativePath: string;
}>;

async function collectHostedStaticFiles(
    declaration: DiscoveredHostedStaticPluginUiArtifact,
): Promise<readonly StagedArtifactFile[]> {
    const files: StagedArtifactFile[] = [];
    const conventionalSourceEntry = join(declaration.sourceRoot, 'entry.ts');
    let hasConventionalSourceEntry = false;
    try {
        const entryStat = await lstat(conventionalSourceEntry);
        if (entryStat.isSymbolicLink() || !entryStat.isFile()) {
            throw new PluginUiBuildError(
                entryStat.isSymbolicLink() ? 'hosted_static_symlink_unsupported' : 'hosted_static_file_type_unsupported',
                `Hosted-static artifact "${declaration.artifactId}" source entry must be a regular file`,
                declaration.artifactId,
            );
        }
        hasConventionalSourceEntry = true;
    } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause;
    }
    async function visit(directoryPath: string, relativeDirectory: string): Promise<void> {
        const entries = await readdir(directoryPath, { withFileTypes: true });
        entries.sort((left, right) => left.name.localeCompare(right.name));
        for (const entry of entries) {
            const sourcePath = join(directoryPath, entry.name);
            const sourceStat = await lstat(sourcePath);
            if (sourceStat.isSymbolicLink()) {
                throw new PluginUiBuildError(
                    'hosted_static_symlink_unsupported',
                    `Hosted-static artifact "${declaration.artifactId}" must not contain symlinks`,
                    declaration.artifactId,
                );
            }
            const nestedRelativePath = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
            if (sourceStat.isDirectory()) {
                await visit(sourcePath, nestedRelativePath);
                continue;
            }
            if (!sourceStat.isFile()) {
                throw new PluginUiBuildError(
                    'hosted_static_file_type_unsupported',
                    `Hosted-static artifact "${declaration.artifactId}" contains a non-regular file`,
                    declaration.artifactId,
                );
            }
            if (hasConventionalSourceEntry && nestedRelativePath === 'entry.ts') continue;
            if (hasConventionalSourceEntry && nestedRelativePath === 'assets/app.js') continue;
            const bytes = await readFile(sourcePath);
            if (bytes.byteLength === 0) {
                throw new PluginUiBuildError(
                    'hosted_static_empty_file_unsupported',
                    `Hosted-static artifact "${declaration.artifactId}" contains an empty file`,
                    declaration.artifactId,
                );
            }
            files.push(Object.freeze({
                bytes,
                relativePath: `hosted-web/${declaration.artifactId}/${nestedRelativePath}`,
            }));
        }
    }
    let rootStat;
    try {
        rootStat = await lstat(declaration.sourceRoot);
    } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code === 'ENOENT') {
            throw new PluginUiBuildError(
                'hosted_static_directory_missing',
                `Hosted-static artifact "${declaration.artifactId}" requires ${declaration.sourceRoot}`,
                declaration.artifactId,
            );
        }
        throw cause;
    }
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
        throw new PluginUiBuildError(
            rootStat.isSymbolicLink() ? 'hosted_static_symlink_unsupported' : 'hosted_static_directory_invalid',
            `Hosted-static artifact "${declaration.artifactId}" source must be a regular directory`,
            declaration.artifactId,
        );
    }
    await visit(declaration.sourceRoot, '');
    if (hasConventionalSourceEntry) {
        let compiled;
        try {
            compiled = await build({
                absWorkingDir: declaration.sourceRoot,
                entryPoints: [conventionalSourceEntry],
                outfile: join(declaration.sourceRoot, 'assets/app.js'),
                bundle: true,
                platform: 'browser',
                format: 'esm',
                minify: true,
                treeShaking: true,
                sourcemap: false,
                legalComments: 'none',
                charset: 'utf8',
                target: 'es2020',
                write: false,
                logLevel: 'silent',
            });
        } catch (cause) {
            const diagnostic = (cause as Readonly<{
                errors?: readonly Readonly<{ text?: string }>[];
            }>).errors?.find((error) => typeof error.text === 'string')?.text
                ?? (cause instanceof Error ? cause.message : undefined);
            throw new PluginUiBuildError(
                'hosted_static_compile_failed',
                `Hosted-static artifact "${declaration.artifactId}" failed to compile${diagnostic ? `: ${diagnostic}` : ''}`,
                declaration.artifactId,
            );
        }
        if (compiled.outputFiles.length !== 1) {
            throw new PluginUiBuildError(
                'hosted_static_output_graph_invalid',
                `Hosted-static artifact "${declaration.artifactId}" source entry must emit one JavaScript file`,
                declaration.artifactId,
            );
        }
        files.push(Object.freeze({
            bytes: new Uint8Array(compiled.outputFiles[0]!.contents),
            relativePath: `hosted-web/${declaration.artifactId}/assets/app.js`,
        }));
        files.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
    }
    const expectedEntry = `hosted-web/${declaration.artifactId}/index.html`;
    if (!files.some((file) => file.relativePath === expectedEntry)) {
        throw new PluginUiBuildError(
            'hosted_static_index_missing',
            `Hosted-static artifact "${declaration.artifactId}" requires a root index.html`,
            declaration.artifactId,
        );
    }
    return Object.freeze(files);
}

export async function buildUniversalPluginUiArtifacts(
    projectRootInput: string,
    manifestPath?: string,
): Promise<BuildUniversalPluginUiArtifactsResult> {
    const projectRoot = resolve(projectRootInput);
    const [declarations, hostedStaticDeclarations] = await Promise.all([
        discoverExecutablePluginUiArtifacts(projectRoot, manifestPath),
        discoverHostedStaticPluginUiArtifacts(projectRoot, manifestPath),
    ]);
    const compiled = [];
    for (const declaration of declarations) {
        compiled.push(await compileUniversalPluginUiCommonJs({
            projectRoot,
            entryPath: declaration.entryPath,
            artifactId: declaration.artifactId,
            requestedExports: declaration.requestedExports,
        }));
    }

    const stagedHostedStatic = [];
    for (const declaration of hostedStaticDeclarations) {
        stagedHostedStatic.push(Object.freeze({
            artifactId: declaration.artifactId,
            files: await collectHostedStaticFiles(declaration),
        }));
    }
    const entries: unknown[] = compiled.map((artifact) => {
        const file = Object.freeze({
            relativePath: artifact.relativePath,
            bytes: artifact.bytes,
        });
        return Object.freeze({
            artifactId: artifact.artifactId,
            tier: 'reactNative' as const,
            entry: artifact.relativePath,
            files: [Object.freeze({
                relativePath: artifact.relativePath,
                digest: computePluginUiArtifactSha256DigestV1(artifact.bytes),
                byteSize: artifact.bytes.byteLength,
            })] as const,
            digest: computePluginUiArtifactFileSetSha256DigestV1([file]),
            builtWith: Object.freeze({ bundler: 'esbuild' as const, version: artifact.esbuildVersion }),
            executable: Object.freeze({ exports: artifact.exports }),
            hostUiApiRange: `^${PLUGIN_UI_HOST_API_VERSION_V1}`,
        });
    });
    for (const artifact of stagedHostedStatic) {
        const files = artifact.files.map((file) => Object.freeze({
            relativePath: file.relativePath,
            digest: computePluginUiArtifactSha256DigestV1(file.bytes),
            byteSize: file.bytes.byteLength,
        }));
        entries.push(Object.freeze({
            artifactId: artifact.artifactId,
            tier: 'hostedWeb' as const,
            entry: `hosted-web/${artifact.artifactId}/index.html`,
            files,
            digest: computePluginUiArtifactFileSetSha256DigestV1(artifact.files),
            builtWith: Object.freeze({ staging: 'staticDirectory' as const }),
            hostUiApiRange: `^${PLUGIN_UI_HOST_API_VERSION_V1}`,
        }));
    }
    const manifest = PluginUiArtifactsManifestV2Schema.parse({
        version: PLUGIN_UI_ARTIFACT_GRAMMAR_VERSION_V2,
        entries,
    });

    const workspaceDistOutputDir = process.env.HAPPIER_WORKSPACE_DIST_OUTPUT_DIR?.trim();
    const artifactsRoot = workspaceDistOutputDir
        ? join(resolve(workspaceDistOutputDir), 'happier-plugin-ui')
        : join(projectRoot, ...PLUGIN_UI_ARTIFACTS_ROOT_RELATIVE_PATH.split('/'));
    await mkdir(dirname(artifactsRoot), { recursive: true });
    const stagingParent = resolvePluginUiArtifactsStagingParent(artifactsRoot);
    await mkdir(stagingParent, { recursive: true });
    const stagedRoot = await mkdtemp(join(stagingParent, 'publication-'));
    const previousRoot = `${stagedRoot}.previous`;
    let previousMoved = false;
    try {
        for (const artifact of compiled) {
            const path = join(stagedRoot, ...artifact.relativePath.split('/'));
            await mkdir(dirname(path), { recursive: true });
            await writeFile(path, artifact.bytes);
        }
        for (const artifact of stagedHostedStatic) {
            for (const file of artifact.files) {
                const path = join(stagedRoot, ...file.relativePath.split('/'));
                await mkdir(dirname(path), { recursive: true });
                await writeFile(path, file.bytes);
            }
        }
        await writeFile(
            join(stagedRoot, PLUGIN_UI_ARTIFACTS_MANIFEST_FILE),
            `${JSON.stringify(manifest, null, 2)}\n`,
            'utf8',
        );
        try {
            await rename(artifactsRoot, previousRoot);
            previousMoved = true;
        } catch (cause) {
            if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause;
        }
        try {
            await rename(stagedRoot, artifactsRoot);
        } catch (cause) {
            if (previousMoved) {
                await rename(previousRoot, artifactsRoot);
                previousMoved = false;
            }
            throw cause;
        }
        if (previousMoved) {
            await rm(previousRoot, { recursive: true, force: true });
            previousMoved = false;
        }
    } finally {
        await rm(stagedRoot, { recursive: true, force: true });
    }
    return Object.freeze({ artifactsRoot, manifest });
}
