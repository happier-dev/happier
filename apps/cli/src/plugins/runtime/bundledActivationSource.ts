import { existsSync as nodeExistsSync, realpathSync } from 'node:fs';
import { lstat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { isCanonicalAbsolutePathInsideRoot } from '@/utils/path/expandHomeDirPath';

import {
    normalizeBundledWorkspaceNameFromPackageName,
    prepareSourceDevSharedDepsForBundledPluginRuntimeLoad,
    type SourceDevSharedDepsPreflightResult,
} from '@/subprocess/sourceDevSharedDepsPreflight';

import type { PluginDaemonModuleNamespace } from './types';
import type {
    PluginRelativeModuleResolution,
    ValidatedAgentSessionRunnerFactoryFactV1,
} from './activationSources';
import {
    assertContainedRegularGenerationFile,
    persistValidatedAgentSessionRunnerFactories,
    type ImmutablePluginGenerationRecord,
} from '../store/registry/generationStore';
import type { PluginStorePaths } from '../store/paths';
import { resolvePluginModuleCandidatePaths } from './loadPluginModule';

type BundledActivationTarget = Readonly<{
    pluginId: string;
    daemonEntryPath: string | null;
}>;

type BundledActivationSource = Readonly<{
    kind: 'bundled';
    moduleId: string;
    prepare?: () => Promise<void>;
    load: () => Promise<PluginDaemonModuleNamespace>;
    resolveRelativeModule: (
        module: string,
    ) => Promise<PluginRelativeModuleResolution<Record<string, unknown>>>;
    persistValidatedAgentSessionRunnerFactories?: (
        facts: readonly ValidatedAgentSessionRunnerFactoryFactV1[],
    ) => Promise<void>;
}>;

type ImportModule = (specifier: string) => Promise<PluginDaemonModuleNamespace>;

type PrepareSourceDevSharedDeps = (params: Readonly<{
    packageName: string;
    workspaceNames?: readonly string[];
    admittedCopyOnly?: boolean;
}>) => Promise<SourceDevSharedDepsPreflightResult> | SourceDevSharedDepsPreflightResult;

type SourceDevSharedDepsPreflightCacheEntry = {
    promise: Promise<SourceDevSharedDepsPreflightResult> | null;
    result: SourceDevSharedDepsPreflightResult | null;
};

type SourceDevSharedDepsBatchPreflightOutcome =
    | Readonly<{
        type: 'ready';
        result: Extract<SourceDevSharedDepsPreflightResult, { type: 'ready' }>;
    }>
    | Readonly<{
        type: 'targeted-fallback';
    }>;

type BundledExecutablePluginTarget = Readonly<{
    pluginId: string;
    daemonEntryPath: string | null;
    sourceSpec: Readonly<{ kind: string }>;
}>;

function normalizePathSeparators(pathLike: string): string {
    return pathLike.replaceAll('\\', '/');
}

function compareCanonicalStrings(left: string, right: string): number {
    if (left < right) return -1;
    if (left > right) return 1;
    return 0;
}

function parseFirstPartyPluginIdFromPackageName(packageName: string): string | null {
    const prefix = '@happier-dev/plugins-';
    if (!packageName.startsWith(prefix)) {
        return null;
    }
    const pluginId = packageName.slice(prefix.length).trim();
    if (!pluginId) {
        return null;
    }
    return pluginId;
}

async function importModule(specifier: string): Promise<PluginDaemonModuleNamespace> {
    return await import(specifier) as PluginDaemonModuleNamespace;
}

export function resolveBundledActivationSourceRepoRoot(
    moduleUrl: string | URL,
): string {
    const lexicalModulePath = fileURLToPath(moduleUrl);
    let modulePath = lexicalModulePath;
    try {
        modulePath = realpathSync(lexicalModulePath);
    } catch {
        // Packaged virtual filesystems do not necessarily expose a realpath.
    }
    const here = dirname(modulePath);
    return resolve(here, '..', '..', '..', '..', '..');
}

function defaultRepoRoot(): string {
    return resolveBundledActivationSourceRepoRoot(import.meta.url);
}

function defaultCanImportFirstPartyPluginSource(): boolean {
    const currentModulePath = normalizePathSeparators(fileURLToPath(import.meta.url));
    return currentModulePath.endsWith('/src/plugins/runtime/bundledActivationSource.ts');
}

function resolveComparableFileIdentity(path: string): string {
    const absolutePath = resolve(path);
    try {
        return realpathSync(absolutePath);
    } catch {
        return absolutePath;
    }
}

export function resolveSourceDevelopmentBundledPackageNames(params: Readonly<{
    artifacts: readonly Readonly<{
        packageName: string;
        packageEntryRelativePath: string;
    }>[];
    canImportFirstPartyPluginSource?: () => boolean;
    existsSync?: (path: string) => boolean;
    repoRoot?: string;
    resolveBundledPackageEntry?: (packageName: string) => string;
}>): ReadonlySet<string> {
    const canImportFirstPartyPluginSource =
        params.canImportFirstPartyPluginSource ?? defaultCanImportFirstPartyPluginSource;
    if (!canImportFirstPartyPluginSource()) return new Set();
    const repoRoot = params.repoRoot ?? defaultRepoRoot();
    const existsSync = params.existsSync ?? nodeExistsSync;
    const resolveBundledPackageEntry =
        params.resolveBundledPackageEntry
        ?? createRequire(import.meta.url).resolve;
    const sourceDevelopmentPackageNames = new Set<string>();
    for (const artifact of params.artifacts) {
        const pluginId = parseFirstPartyPluginIdFromPackageName(artifact.packageName);
        const workspaceName = normalizeBundledWorkspaceNameFromPackageName(
            artifact.packageName,
        );
        if (!pluginId || !workspaceName) continue;
        const sourceEntryPath = resolve(
            repoRoot,
            'packages',
            'plugins',
            pluginId,
            'src',
            'index.ts',
        );
        if (!existsSync(sourceEntryPath)) continue;
        let resolvedPackageEntry: string;
        try {
            resolvedPackageEntry = resolve(resolveBundledPackageEntry(artifact.packageName));
        } catch {
            continue;
        }
        const sourceDevelopmentCopyEntry = resolve(
            repoRoot,
            'apps',
            'cli',
            'node_modules',
            '@happier-dev',
            workspaceName,
            ...artifact.packageEntryRelativePath.split('/'),
        );
        // The managed source checkout copies workspace output into this exact
        // dependency root. It is a development dependency closure, not the
        // generated immutable artifact whose inventory happens to describe a
        // subset of its files.
        if (
            resolveComparableFileIdentity(resolvedPackageEntry)
            === resolveComparableFileIdentity(sourceDevelopmentCopyEntry)
        ) {
            sourceDevelopmentPackageNames.add(artifact.packageName);
        }
    }
    return sourceDevelopmentPackageNames;
}

export function resolveCurrentHostBundledImmutableArtifacts<
    TArtifact extends Readonly<{
        packageName: string;
        packageEntryRelativePath: string;
    }>,
>(params: Readonly<{
    artifacts: readonly TArtifact[];
    canImportFirstPartyPluginSource?: () => boolean;
    existsSync?: (path: string) => boolean;
    repoRoot?: string;
    resolveBundledPackageEntry?: (packageName: string) => string;
}>): readonly TArtifact[] {
    const sourceDevelopmentBundledPackageNames =
        resolveSourceDevelopmentBundledPackageNames(params);
    return params.artifacts.filter(
        (artifact) => !sourceDevelopmentBundledPackageNames.has(
            artifact.packageName,
        ),
    );
}

/**
 * Keeps immutable admission scoped to actual bundled daemon targets. A
 * declaration without an executable target cannot acquire a generation here.
 */
export function selectBundledExecutableImmutableArtifacts<
    TArtifact extends Readonly<{
        record: Readonly<{ pluginId: string }>;
    }>,
>(params: Readonly<{
    artifacts: readonly TArtifact[];
    activationTargets: readonly BundledExecutablePluginTarget[];
}>): readonly TArtifact[] {
    const executablePluginIds = new Set(
        params.activationTargets.flatMap((target) => (
            target.sourceSpec.kind === 'bundled'
            && typeof target.daemonEntryPath === 'string'
            && target.daemonEntryPath.trim().length > 0
            && target.pluginId.trim().length > 0
                ? [target.pluginId.trim()]
                : []
        )),
    );
    return Object.freeze(params.artifacts.filter((artifact) => (
        executablePluginIds.has(artifact.record.pluginId)
    )));
}

/**
 * The registry must establish every selected executable bundled generation
 * before it projects any consumer. In a source checkout, the generated
 * package overlay is prepared by the source-dev shared-deps owner rather than
 * by a particular contribution family or activation-on-demand.
 */
export async function prepareBundledExecutableGenerationAdmission(params: Readonly<{
    artifacts: readonly Readonly<{
        packageName: string;
        record: Readonly<{ pluginId: string }>;
    }>[];
    canImportFirstPartyPluginSource?: () => boolean;
    prepareSourceDevSharedDeps?: PrepareSourceDevSharedDeps;
}>): Promise<void> {
    const canImportFirstPartyPluginSource =
        params.canImportFirstPartyPluginSource ?? defaultCanImportFirstPartyPluginSource;
    if (!canImportFirstPartyPluginSource()) return;
    const packageNamesByWorkspaceName = new Map<string, string>();
    for (const artifact of params.artifacts) {
        const workspaceName = normalizeBundledWorkspaceNameFromPackageName(
            artifact.packageName,
        );
        if (!workspaceName) continue;
        const existingPackageName = packageNamesByWorkspaceName.get(workspaceName);
        if (
            !existingPackageName
            || compareCanonicalStrings(artifact.packageName, existingPackageName) < 0
        ) {
            packageNamesByWorkspaceName.set(workspaceName, artifact.packageName);
        }
    }

    const workspaceNames = [...packageNamesByWorkspaceName.keys()].sort(
        compareCanonicalStrings,
    );
    const packageName = workspaceNames[0]
        ? packageNamesByWorkspaceName.get(workspaceNames[0])
        : undefined;
    if (!packageName) return;

    const preflight = await (
        params.prepareSourceDevSharedDeps
        ?? prepareSourceDevSharedDepsForBundledPluginRuntimeLoad
    )({
        packageName,
        workspaceNames,
    });
    if (preflight.type === 'error') {
        throw new Error(preflight.errorMessage);
    }
}

export function createBundledActivationSourceResolver(params: Readonly<{
    bundledPackageNames: readonly string[];
    immutableArtifactPackageNames?: readonly string[];
    /**
     * The published daemon runtime bundle for each bundled package: the module that
     * activates the plugin and the directory its staged session-runner leaves live in.
     * It is not the package root export, which stays the compiler's own emit.
     */
    immutableArtifactEntryPathsByPackageName?: ReadonlyMap<string, string>;
    immutableArtifactRootPathsByPackageName?: ReadonlyMap<string, string>;
    immutableArtifactRecordsByPackageName?: ReadonlyMap<
        string,
        ImmutablePluginGenerationRecord
    >;
    unavailableImmutableArtifactPackageNames?: ReadonlySet<string>;
    canImportFirstPartyPluginSource?: () => boolean;
    existsSync?: (path: string) => boolean;
    importModule?: ImportModule;
    prepareSourceDevSharedDeps?: PrepareSourceDevSharedDeps;
    repoRoot?: string;
    pluginStorePaths?: PluginStorePaths;
}>) {
    const bundledPackageNames = new Set(params.bundledPackageNames);
    const immutableArtifactPackageNames = new Set(params.immutableArtifactPackageNames ?? []);
    const immutableArtifactEntryPathsByPackageName = params.immutableArtifactEntryPathsByPackageName ?? new Map();
    const immutableArtifactRootPathsByPackageName = params.immutableArtifactRootPathsByPackageName ?? new Map();
    const immutableArtifactRecordsByPackageName = params.immutableArtifactRecordsByPackageName ?? new Map();
    const unavailableImmutableArtifactPackageNames = params.unavailableImmutableArtifactPackageNames ?? new Set();
    const canImportFirstPartyPluginSource =
        params.canImportFirstPartyPluginSource ?? defaultCanImportFirstPartyPluginSource;
    const existsSync = params.existsSync ?? nodeExistsSync;
    const loadImport = params.importModule ?? importModule;
    const prepareSourceDevSharedDeps =
        params.prepareSourceDevSharedDeps ?? prepareSourceDevSharedDepsForBundledPluginRuntimeLoad;
    const repoRoot = params.repoRoot ?? defaultRepoRoot();
    const sourceDevSharedDepsPreflightByPackageName = new Map<string, SourceDevSharedDepsPreflightCacheEntry>();
    let sourceDevSharedDepsBatchTarget: Readonly<{
        packageName: string;
        workspaceNames: readonly string[];
    }> | null | undefined;
    let sourceDevSharedDepsBatchPreflight: Promise<SourceDevSharedDepsBatchPreflightOutcome> | null = null;
    let sourceDevSharedDepsBatchFallbackReady = false;

    function resolveSourceDevWorkspaceNames(packageName: string): readonly string[] {
        const workspaceName = normalizeBundledWorkspaceNameFromPackageName(packageName);
        return workspaceName ? Object.freeze([workspaceName]) : Object.freeze([]);
    }

    function resolveSourceDevSharedDepsBatchTarget(): typeof sourceDevSharedDepsBatchTarget {
        if (sourceDevSharedDepsBatchTarget !== undefined) {
            return sourceDevSharedDepsBatchTarget;
        }

        const packageNamesByWorkspaceName = new Map<string, string>();
        for (const packageName of bundledPackageNames) {
            if (
                immutableArtifactEntryPathsByPackageName.has(packageName)
                || immutableArtifactPackageNames.has(packageName)
            ) {
                continue;
            }
            const pluginId = parseFirstPartyPluginIdFromPackageName(packageName);
            const workspaceName = normalizeBundledWorkspaceNameFromPackageName(packageName);
            if (!pluginId || !workspaceName) continue;
            const srcCandidate = resolve(repoRoot, 'packages', 'plugins', pluginId, 'src', 'index.ts');
            if (!existsSync(srcCandidate)) continue;

            const existingPackageName = packageNamesByWorkspaceName.get(workspaceName);
            if (!existingPackageName || compareCanonicalStrings(packageName, existingPackageName) < 0) {
                packageNamesByWorkspaceName.set(workspaceName, packageName);
            }
        }

        const workspaceNames = [...packageNamesByWorkspaceName.keys()].sort(compareCanonicalStrings);
        const batchPackageName = workspaceNames[0]
            ? packageNamesByWorkspaceName.get(workspaceNames[0])
            : undefined;
        sourceDevSharedDepsBatchTarget = workspaceNames.length > 1 && batchPackageName
            ? Object.freeze({
                packageName: batchPackageName,
                workspaceNames: Object.freeze(workspaceNames),
            })
            : null;
        return sourceDevSharedDepsBatchTarget;
    }

    async function runSourceDevSharedDepsPreflightForPackage(
        packageName: string,
        options?: Readonly<{ admittedCopyOnly?: boolean }>,
    ): Promise<SourceDevSharedDepsPreflightResult> {
        const existing = sourceDevSharedDepsPreflightByPackageName.get(packageName);
        if (existing?.result) {
            return existing.result;
        }
        if (existing?.promise) {
            return await existing.promise;
        }
        const workspaceNames = resolveSourceDevWorkspaceNames(packageName);
        const preflightPromise = Promise.resolve().then(() => prepareSourceDevSharedDeps({
            packageName,
            ...(workspaceNames.length > 0
                ? { workspaceNames }
                : {}),
            ...(options?.admittedCopyOnly
                ? { admittedCopyOnly: true }
                : {}),
        }));
        const entry: SourceDevSharedDepsPreflightCacheEntry = {
            promise: preflightPromise,
            result: null,
        };
        sourceDevSharedDepsPreflightByPackageName.set(packageName, entry);
        try {
            const result = await preflightPromise;
            if (sourceDevSharedDepsPreflightByPackageName.get(packageName) === entry) {
                entry.promise = null;
                if (result.type === 'error') {
                    sourceDevSharedDepsPreflightByPackageName.delete(packageName);
                } else {
                    entry.result = result;
                }
            }
            return result;
        } catch (error) {
            if (sourceDevSharedDepsPreflightByPackageName.get(packageName) === entry) {
                sourceDevSharedDepsPreflightByPackageName.delete(packageName);
            }
            throw error;
        }
    }

    async function runSourceDevSharedDepsPreflight(
        packageName: string,
        options?: Readonly<{ admittedCopyOnly?: boolean }>,
    ): Promise<SourceDevSharedDepsPreflightResult> {
        if (options?.admittedCopyOnly) {
            return await runSourceDevSharedDepsPreflightForPackage(packageName, options);
        }
        const batchTarget = resolveSourceDevSharedDepsBatchTarget();
        if (!batchTarget) {
            return await runSourceDevSharedDepsPreflightForPackage(packageName);
        }
        if (sourceDevSharedDepsBatchFallbackReady) {
            return await runSourceDevSharedDepsPreflightForPackage(packageName);
        }

        sourceDevSharedDepsBatchPreflight ??= Promise.resolve()
            .then(() => prepareSourceDevSharedDeps(batchTarget))
            .then((result): SourceDevSharedDepsBatchPreflightOutcome => (
                result.type === 'ready'
                    ? { type: 'ready', result }
                    : { type: 'targeted-fallback' }
            ))
            .catch((): SourceDevSharedDepsBatchPreflightOutcome => ({
                type: 'targeted-fallback',
            }));

        const batchOutcome = await sourceDevSharedDepsBatchPreflight;
        if (batchOutcome.type === 'ready') {
            return batchOutcome.result;
        }
        sourceDevSharedDepsBatchFallbackReady = true;
        return await runSourceDevSharedDepsPreflightForPackage(packageName);
    }

    return function resolveBundledActivationSource(target: BundledActivationTarget): BundledActivationSource | null {
        if (!target.daemonEntryPath || !bundledPackageNames.has(target.daemonEntryPath)) {
            return null;
        }
        const daemonEntryPath = target.daemonEntryPath;
        const resolveSourceDevEntry = (): Readonly<{
            entryPath: string;
            rootPath: string;
            loadMode: 'source-ts';
        }> | null => {
            if (!canImportFirstPartyPluginSource()) return null;
            if (immutableArtifactPackageNames.has(daemonEntryPath)) {
                return null;
            }
            const pluginId = parseFirstPartyPluginIdFromPackageName(daemonEntryPath);
            if (!pluginId) return null;
            const packageRoot = resolve(repoRoot, 'packages', 'plugins', pluginId);
            const entryPath = resolve(packageRoot, 'src', 'index.ts');
            return existsSync(entryPath)
                ? { entryPath, rootPath: packageRoot, loadMode: 'source-ts' }
                : null;
        };
        let prepared = false;
        const prepare = async (): Promise<void> => {
            if (prepared) return;
            const pluginId = parseFirstPartyPluginIdFromPackageName(daemonEntryPath);
            const sourceDevEntry = resolveSourceDevEntry();
            const canImportSource = canImportFirstPartyPluginSource();
            if (
                pluginId
                && !immutableArtifactEntryPathsByPackageName.has(daemonEntryPath)
                && canImportSource
                && (
                    sourceDevEntry
                    || !immutableArtifactPackageNames.has(daemonEntryPath)
                )
            ) {
                const preflight = await runSourceDevSharedDepsPreflight(
                    daemonEntryPath,
                    sourceDevEntry ? undefined : { admittedCopyOnly: true },
                );
                if (preflight.type === 'error') {
                    throw new Error(preflight.errorMessage);
                }
            }
            prepared = true;
        };

        const resolveSelectedEntry = (): Readonly<{
            entryPath: string;
            rootPath: string;
            loadMode: 'immutable-js' | 'source-ts';
        }> | null => {
            const immutableArtifactEntryPath = immutableArtifactEntryPathsByPackageName.get(daemonEntryPath);
            if (immutableArtifactEntryPath) {
                return {
                    entryPath: immutableArtifactEntryPath,
                    rootPath: immutableArtifactRootPathsByPackageName.get(daemonEntryPath)
                        ?? dirname(immutableArtifactEntryPath),
                    loadMode: 'immutable-js',
                };
            }
            const sourceDevEntry = resolveSourceDevEntry();
            if (sourceDevEntry) return sourceDevEntry;
            if (
                immutableArtifactPackageNames.has(daemonEntryPath)
                || unavailableImmutableArtifactPackageNames.has(daemonEntryPath)
            ) {
                return null;
            }
            const pluginId = parseFirstPartyPluginIdFromPackageName(daemonEntryPath);
            if (!pluginId) return null;
            const packageRoot = resolve(repoRoot, 'packages', 'plugins', pluginId);
            const distEntryPath = resolve(packageRoot, 'dist', 'index.js');
            if (existsSync(distEntryPath)) {
                return { entryPath: distEntryPath, rootPath: packageRoot, loadMode: 'immutable-js' };
            }
            return null;
        };
        const immutableRootPath =
            immutableArtifactRootPathsByPackageName.get(daemonEntryPath);
        const immutableRecord: ImmutablePluginGenerationRecord | undefined =
            immutableArtifactRecordsByPackageName.get(daemonEntryPath);

        const resolveRelativeModule = async (
            module: string,
        ): Promise<PluginRelativeModuleResolution<Record<string, unknown>>> => {
            await prepare();
            const selected = resolveSelectedEntry();
            if (!selected) {
                throw new Error(`Bundled plugin '${daemonEntryPath}' has no file-backed runner module root`);
            }
            const candidateBase = resolve(dirname(selected.entryPath), module);
            const extensionCandidates = resolvePluginModuleCandidatePaths({
                candidateBase,
                loadMode: selected.loadMode,
            });
            let existingCandidate: string | null = null;
            let lexicalModuleMetadata: Awaited<ReturnType<typeof lstat>> | null = null;
            for (const candidate of extensionCandidates) {
                if (!existsSync(candidate)) continue;
                const candidateMetadata = await lstat(candidate);
                if (
                    !candidateMetadata.isSymbolicLink()
                    && !candidateMetadata.isFile()
                ) {
                    continue;
                }
                existingCandidate = candidate;
                lexicalModuleMetadata = candidateMetadata;
                break;
            }
            if (!existingCandidate || !lexicalModuleMetadata) {
                throw new Error(`Runner module '${module}' was not found in bundled plugin '${daemonEntryPath}'`);
            }
            if (
                lexicalModuleMetadata.isSymbolicLink()
                || !lexicalModuleMetadata.isFile()
            ) {
                throw new Error(`Runner module '${module}' must be a real bundled plugin file`);
            }
            const entryPath = realpathSync(selected.entryPath);
            const modulePath = realpathSync(existingCandidate);
            const rootPath = realpathSync(selected.rootPath);
            const relativeModulePath = relative(rootPath, modulePath);
            if (
                modulePath === rootPath
                || !isCanonicalAbsolutePathInsideRoot(rootPath, modulePath)
            ) {
                throw new Error(`Runner module '${module}' escapes bundled plugin '${daemonEntryPath}'`);
            }
            if (modulePath === entryPath) {
                throw new Error(`Runner module '${module}' must be a leaf distinct from the plugin activation entry`);
            }
            const normalizedModulePath =
                relativeModulePath.split(sep).join('/');
            const immutableInventoryFile = (
                immutableRootPath
                && immutableRecord
                && selected.loadMode === 'immutable-js'
            )
                ? immutableRecord.files.find(
                    (file) => file.relativePath === normalizedModulePath,
                )
                : undefined;
            const assertSelectedImmutableLeaf = async (): Promise<void> => {
                if (!immutableRootPath || !immutableRecord || selected.loadMode !== 'immutable-js') {
                    return;
                }
                const canonicalImmutableRoot = realpathSync(immutableRootPath);
                if (rootPath !== canonicalImmutableRoot || !immutableInventoryFile) {
                    throw new Error(
                        `Runner module '${module}' failed bundled immutable inventory verification`,
                    );
                }
                await assertContainedRegularGenerationFile(
                    canonicalImmutableRoot,
                    normalizedModulePath,
                    `Bundled runner module '${module}'`,
                );
            };
            await assertSelectedImmutableLeaf();
            if (
                immutableInventoryFile
                && lexicalModuleMetadata.size !== immutableInventoryFile.byteLength
            ) {
                throw new Error(
                    `Runner module '${module}' failed bundled immutable inventory verification`,
                );
            }
            const moduleNamespace = (
                await loadImport(pathToFileURL(modulePath).href)
            ) as Record<string, unknown>;
            await assertSelectedImmutableLeaf();
            const afterModuleMetadata = await lstat(existingCandidate);
            if (
                afterModuleMetadata.isSymbolicLink()
                || !afterModuleMetadata.isFile()
                || afterModuleMetadata.dev !== lexicalModuleMetadata.dev
                || afterModuleMetadata.ino !== lexicalModuleMetadata.ino
                || afterModuleMetadata.size !== lexicalModuleMetadata.size
                || (
                    immutableInventoryFile !== undefined
                    && afterModuleMetadata.size !== immutableInventoryFile.byteLength
                )
                || afterModuleMetadata.mtimeMs !== lexicalModuleMetadata.mtimeMs
                || afterModuleMetadata.ctimeMs !== lexicalModuleMetadata.ctimeMs
            ) {
                throw new Error(
                    `Runner module '${module}' changed during bundled import`,
                );
            }
            return Object.freeze({
                module: moduleNamespace,
                normalizedModulePath,
                loadMode: selected.loadMode,
            });
        };

        return {
            kind: 'bundled' as const,
            moduleId: daemonEntryPath,
            prepare,
            resolveRelativeModule,
            ...(params.pluginStorePaths && immutableRootPath && immutableRecord
                ? {
                    persistValidatedAgentSessionRunnerFactories: async (facts) => {
                        await persistValidatedAgentSessionRunnerFactories({
                            paths: params.pluginStorePaths!,
                            record: immutableRecord,
                            manifestAuthority: 'bundled_first_party',
                            factories: facts,
                        });
                    },
                }
                : {}),
            load: async () => {
                await prepare();
                const selectedEntry = resolveSelectedEntry();
                if (selectedEntry) {
                    return await loadImport(
                        pathToFileURL(selectedEntry.entryPath).href,
                    );
                }
                if (
                    immutableArtifactPackageNames.has(daemonEntryPath)
                    || unavailableImmutableArtifactPackageNames.has(daemonEntryPath)
                ) {
                    throw new Error(`Bundled immutable artifact is unavailable for '${daemonEntryPath}'`);
                }

                return await loadImport(daemonEntryPath);
            },
        };
    };
}
