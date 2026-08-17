import { mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';

import {
    PluginUiArtifactsManifestV1Schema,
    computePluginUiArtifactFileSetSha256DigestV1,
    computePluginUiArtifactSha256DigestV1,
    type PluginUiArtifactsManifestEntryV1,
    type PluginUiArtifactsManifestV1,
} from '@happier-dev/protocol/plugins/ui';

import { readRelativeBuildPath } from '../buildPaths.js';
import {
    defineHostedWebViteBuildArtifact,
    type HostedWebViteBuildPreset,
} from '../hostedWebBuild.js';
import {
    defineReactNativeBundleBuildArtifact,
    type ReactNativeRepackBuildPreset,
} from '../reactNativeBuild.js';
import {
    defineReactNativeWebViteBuildArtifact,
    type ReactNativeWebViteBuildPreset,
} from '../reactNativeWebBuild.js';
import { applyStrictSafeGuardedRequireTransform } from '../reactNativeRepackStrictSafety.js';

/**
 * Canonical on-disk artifact root the daemon static-asset source reads
 * (`apps/cli/src/daemon/local/services/plugins/staticAssets/source.ts`).
 */
export const PLUGIN_UI_ARTIFACTS_ROOT_RELATIVE_PATH = 'dist/happier-plugin-ui';
export const PLUGIN_UI_ARTIFACTS_MANIFEST_FILE = 'ui-artifacts.json';

export type PluginUiBuiltFileV1 = Readonly<{
    /** Path relative to the artifact root (`dist/happier-plugin-ui`). */
    relativePath: string;
    bytes: Uint8Array;
}>;

export type PluginUiBundlerRunResultV1 = Readonly<{
    files: readonly PluginUiBuiltFileV1[];
}>;

/**
 * System-boundary seam: invokes the author-declared bundler (Vite / Re.Pack)
 * and returns the emitted bytes. Real callers route this through the
 * centralized managed runtime/tool abstraction (never raw node/npm/npx) so the
 * bin stays binary-safe; tests inject a fake that emits known bytes.
 */
export type PluginUiBundlerRunnerV1 = (
    surface: PluginUiBuildSurfaceV1,
    context: Readonly<{ projectRoot: string }>,
) => Promise<PluginUiBundlerRunResultV1>;

export type PluginUiHostedWebBuildSurfaceV1 = Readonly<{
    kind: 'hostedWeb';
    preset: HostedWebViteBuildPreset;
    hostUiApiVersion: string;
    /** Absolute generated execution config; before preparation this can identify an author Vite extension. */
    bundlerConfigPath?: string;
    /** Builder-owned operation cwd for a generated bundler config, when needed. */
    bundlerWorkingDirectory?: string;
}>;

export type PluginUiReactNativeBuildSurfaceV1 = Readonly<{
    kind: 'reactNative';
    /**
     * LEDGER DEC-6: a `reactNative`-mode plugin ships one build surface per
     * platform — ios/android compile through `ReactNativeRepackBuildPresetV1`
     * (Re.Pack), web compiles the SAME `sourceEntry` through
     * `ReactNativeWebViteBuildPresetV1` (Vite + react-native-web). Both
     * presets share the `reactNative` build-surface `kind`; `buildManifestEntry`
     * dispatches on `preset.bundler` to call the matching artifact helper.
     */
    preset: ReactNativeRepackBuildPreset | ReactNativeWebViteBuildPreset;
    hostUiApiVersion: string;
    compatibility: Readonly<{
        reactVersion: string;
        reactNativeVersion: string;
        expoRuntimeVersion?: string;
        hermesVersion?: string;
    }>;
    /** Absolute generated execution config; before preparation this can identify an author Vite extension. */
    bundlerConfigPath?: string;
    /** Builder-owned operation cwd for a generated bundler config, when needed. */
    bundlerWorkingDirectory?: string;
}>;

export type PluginUiBuildSurfaceV1 =
    | PluginUiHostedWebBuildSurfaceV1
    | PluginUiReactNativeBuildSurfaceV1;

export type BuildUiArtifactsInputV1 = Readonly<{
    /** Plugin project root; the artifact tree is written under `<projectRoot>/dist/happier-plugin-ui`. */
    projectRoot: string;
    surfaces: readonly PluginUiBuildSurfaceV1[];
    runBundler: PluginUiBundlerRunnerV1;
}>;

export type BuildUiArtifactsResultV1 = Readonly<{
    artifactsRoot: string;
    manifest: PluginUiArtifactsManifestV1;
}>;

export class PluginUiBuildError extends Error {
    readonly code: string;
    readonly contributionId?: string;

    constructor(code: string, message: string, contributionId?: string) {
        super(message);
        this.name = 'PluginUiBuildError';
        this.code = code;
        this.contributionId = contributionId;
    }
}

function contributionIdOf(surface: PluginUiBuildSurfaceV1): string {
    return surface.preset.contributionId;
}

function normalizeEmittedFiles(
    surface: PluginUiBuildSurfaceV1,
    result: PluginUiBundlerRunResultV1,
): readonly PluginUiBuiltFileV1[] {
    const contributionId = contributionIdOf(surface);
    if (result.files.length === 0) {
        throw new PluginUiBuildError(
            'bundler_emitted_no_files',
            `Bundler for "${contributionId}" emitted no files`,
            contributionId,
        );
    }
    const seen = new Set<string>();
    const normalized: PluginUiBuiltFileV1[] = [];
    for (let index = 0; index < result.files.length; index += 1) {
        const file = result.files[index]!;
        let relativePath: string;
        try {
            relativePath = readRelativeBuildPath(file.relativePath, `files[${index}]`);
        } catch (cause) {
            throw new PluginUiBuildError(
                'unsafe_artifact_path',
                `Bundler for "${contributionId}" emitted unsafe path "${file.relativePath}": ${(cause as Error).message}`,
                contributionId,
            );
        }
        if (seen.has(relativePath)) {
            throw new PluginUiBuildError(
                'duplicate_artifact_path',
                `Bundler for "${contributionId}" emitted duplicate path "${relativePath}"`,
                contributionId,
            );
        }
        seen.add(relativePath);
        const bytes = surface.kind === 'reactNative'
            && surface.preset.bundler === 'repack'
            && relativePath.endsWith('.js')
            ? new TextEncoder().encode(
                applyStrictSafeGuardedRequireTransform(new TextDecoder().decode(file.bytes)).source,
            )
            : file.bytes;
        normalized.push(Object.freeze({ relativePath, bytes }));
    }
    return Object.freeze(normalized);
}

function assertEntryEmitted(
    surface: PluginUiBuildSurfaceV1,
    files: readonly PluginUiBuiltFileV1[],
): string {
    const entry = readRelativeBuildPath(surface.preset.output.entry, 'preset.output.entry');
    if (!files.some((file) => file.relativePath === entry)) {
        throw new PluginUiBuildError(
            'entry_not_emitted',
            `Bundler for "${contributionIdOf(surface)}" did not emit the declared entry "${entry}"`,
            contributionIdOf(surface),
        );
    }
    return entry;
}

function buildManifestEntry(
    surface: PluginUiBuildSurfaceV1,
    files: readonly PluginUiBuiltFileV1[],
): PluginUiArtifactsManifestEntryV1 {
    const entry = assertEntryEmitted(surface, files);
    const manifestFiles = files.map((file) => Object.freeze({
        relativePath: file.relativePath,
        digest: computePluginUiArtifactSha256DigestV1(file.bytes),
        byteSize: file.bytes.byteLength,
    }));
    const digest = computePluginUiArtifactFileSetSha256DigestV1(files);

    if (surface.kind === 'reactNative') {
        if (surface.preset.bundler === 'vite') {
            return defineReactNativeWebViteBuildArtifact({
                contributionId: surface.preset.contributionId,
                entry,
                files: manifestFiles,
                digest,
                viteVersion: surface.preset.vite.version,
                hostUiApiVersion: surface.hostUiApiVersion,
                ...(surface.preset.collectionMigrations
                    ? { collectionMigrations: surface.preset.collectionMigrations }
                    : {}),
                compatibility: surface.compatibility,
            });
        }
        return defineReactNativeBundleBuildArtifact({
            contributionId: surface.preset.contributionId,
            platform: surface.preset.platform,
            entry,
            files: manifestFiles,
            digest,
            repackVersion: surface.preset.repack.version,
            hostUiApiVersion: surface.hostUiApiVersion,
            module: surface.preset.module,
            ...(surface.preset.collectionMigrations
                ? { collectionMigrations: surface.preset.collectionMigrations }
                : {}),
            compatibility: surface.compatibility,
        });
    }

    return defineHostedWebViteBuildArtifact({
        contributionId: surface.preset.contributionId,
        entry,
        files: manifestFiles,
        digest,
        viteVersion: surface.preset.vite.version,
        hostUiApiVersion: surface.hostUiApiVersion,
    });
}

async function writeArtifactFile(
    artifactsRoot: string,
    file: PluginUiBuiltFileV1,
): Promise<void> {
    // `relativePath` is already validated by readRelativeBuildPath (no `..`,
    // no absolute, no backslashes), so the join cannot escape the root.
    const absolutePath = join(artifactsRoot, ...file.relativePath.split('/'));
    const rootPrefix = artifactsRoot.endsWith(sep) ? artifactsRoot : `${artifactsRoot}${sep}`;
    if (!absolutePath.startsWith(rootPrefix)) {
        throw new PluginUiBuildError(
            'artifact_escapes_root',
            `Refusing to write "${file.relativePath}" outside the artifact root`,
        );
    }
    await mkdir(dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, file.bytes);
}

export async function buildUiArtifacts(
    input: BuildUiArtifactsInputV1,
): Promise<BuildUiArtifactsResultV1> {
    if (input.surfaces.length === 0) {
        throw new PluginUiBuildError('no_surfaces', 'No plugin UI build surfaces were declared');
    }

    // The repository workspace builder publishes `dist` atomically. Keep the
    // generated UI graph inside that same staged tree so its final swap cannot
    // replace a just-generated live graph with TypeScript-only output.
    const workspaceDistOutputDir = process.env.HAPPIER_WORKSPACE_DIST_OUTPUT_DIR?.trim();
    const artifactsRoot = workspaceDistOutputDir
        ? join(resolve(workspaceDistOutputDir), 'happier-plugin-ui')
        : join(input.projectRoot, ...PLUGIN_UI_ARTIFACTS_ROOT_RELATIVE_PATH.split('/'));
    const entries: PluginUiArtifactsManifestEntryV1[] = [];
    const filesToWrite: PluginUiBuiltFileV1[] = [];
    const claimedPaths = new Set<string>();
    const claimedContributions = new Set<string>();

    for (const surface of input.surfaces) {
        const contributionId = contributionIdOf(surface);
        const claimKey = `${surface.kind === 'reactNative' ? surface.preset.platform : 'web'}:${contributionId}`;
        if (claimedContributions.has(claimKey)) {
            throw new PluginUiBuildError(
                'duplicate_surface',
                `Duplicate build surface for "${contributionId}"`,
                contributionId,
            );
        }
        claimedContributions.add(claimKey);

        const bundled = await input.runBundler(surface, { projectRoot: input.projectRoot });
        const files = normalizeEmittedFiles(surface, bundled);
        const entry = buildManifestEntry(surface, files);
        entries.push(entry);

        for (const file of files) {
            if (claimedPaths.has(file.relativePath)) {
                throw new PluginUiBuildError(
                    'conflicting_artifact_path',
                    `Two surfaces emitted the same artifact path "${file.relativePath}"`,
                    contributionId,
                );
            }
            claimedPaths.add(file.relativePath);
            filesToWrite.push(file);
        }
    }

    // Validate the full manifest BEFORE writing anything to disk so a
    // schema-invalid or digest-inconsistent build never leaves a partial tree.
    const manifest = PluginUiArtifactsManifestV1Schema.parse({ version: 1, entries });

    const artifactsParent = dirname(artifactsRoot);
    await mkdir(artifactsParent, { recursive: true });
    const stagedRoot = await mkdtemp(join(artifactsParent, '.happier-plugin-ui-stage-'));
    const previousRoot = `${stagedRoot}.previous`;
    let previousMoved = false;
    try {
        for (const file of filesToWrite) {
            await writeArtifactFile(stagedRoot, file);
        }
        await writeFile(
            join(stagedRoot, PLUGIN_UI_ARTIFACTS_MANIFEST_FILE),
            `${JSON.stringify(manifest, null, 2)}\n`,
        );

        try {
            await rename(artifactsRoot, previousRoot);
            previousMoved = true;
        } catch (cause) {
            if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') {
                throw cause;
            }
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
