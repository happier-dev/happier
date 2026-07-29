import { existsSync as nodeExistsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
    normalizeBundledWorkspaceNameFromPackageName,
    prepareSourceDevSharedDepsForBundledPluginRuntimeLoad,
    type SourceDevSharedDepsPreflightResult,
} from '@/subprocess/sourceDevSharedDepsPreflight';

import type { PluginDaemonModuleNamespace } from './types';

type BundledActivationTarget = Readonly<{
    pluginId: string;
    daemonEntryPath: string | null;
}>;

type BundledActivationSource = Readonly<{
    kind: 'bundled';
    moduleId: string;
    prepare?: () => Promise<void>;
    load: () => Promise<PluginDaemonModuleNamespace>;
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

function defaultRepoRoot(): string {
    const here = dirname(fileURLToPath(import.meta.url));
    return resolve(here, '..', '..', '..', '..', '..');
}

function defaultCanImportFirstPartyPluginSource(): boolean {
    const currentModulePath = normalizePathSeparators(fileURLToPath(import.meta.url));
    return currentModulePath.endsWith('/src/plugins/runtime/bundledActivationSource.ts');
}

export function createBundledActivationSourceResolver(params: Readonly<{
    bundledPackageNames: readonly string[];
    immutableArtifactPackageNames?: readonly string[];
    immutableArtifactEntryPathsByPackageName?: ReadonlyMap<string, string>;
    unavailableImmutableArtifactPackageNames?: ReadonlySet<string>;
    canImportFirstPartyPluginSource?: () => boolean;
    existsSync?: (path: string) => boolean;
    importModule?: ImportModule;
    prepareSourceDevSharedDeps?: PrepareSourceDevSharedDeps;
    repoRoot?: string;
}>) {
    const bundledPackageNames = new Set(params.bundledPackageNames);
    const immutableArtifactPackageNames = new Set(params.immutableArtifactPackageNames ?? []);
    const immutableArtifactEntryPathsByPackageName = params.immutableArtifactEntryPathsByPackageName ?? new Map();
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
                immutableArtifactPackageNames.has(packageName)
                || immutableArtifactEntryPathsByPackageName.has(packageName)
                || unavailableImmutableArtifactPackageNames.has(packageName)
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
        let prepared = false;
        const prepare = async (): Promise<void> => {
            if (prepared) return;
            const pluginId = parseFirstPartyPluginIdFromPackageName(daemonEntryPath);
            const srcCandidate = pluginId
                ? resolve(repoRoot, 'packages', 'plugins', pluginId, 'src', 'index.ts')
                : null;
            const canImportSource = canImportFirstPartyPluginSource();
            const sourceExists = Boolean(srcCandidate && existsSync(srcCandidate));
            if (
                pluginId
                && srcCandidate
                && !immutableArtifactPackageNames.has(daemonEntryPath)
                && !immutableArtifactEntryPathsByPackageName.has(daemonEntryPath)
                && !unavailableImmutableArtifactPackageNames.has(daemonEntryPath)
                && canImportSource
            ) {
                const preflight = await runSourceDevSharedDepsPreflight(
                    daemonEntryPath,
                    sourceExists ? undefined : { admittedCopyOnly: true },
                );
                if (preflight.type === 'error') {
                    throw new Error(preflight.errorMessage);
                }
            }
            prepared = true;
        };

        return {
            kind: 'bundled' as const,
            moduleId: daemonEntryPath,
            prepare,
            load: async () => {
                await prepare();
                const immutableArtifactEntryPath = immutableArtifactEntryPathsByPackageName.get(daemonEntryPath);
                if (immutableArtifactEntryPath) {
                    return await loadImport(pathToFileURL(immutableArtifactEntryPath).href);
                }
                if (unavailableImmutableArtifactPackageNames.has(daemonEntryPath)) {
                    throw new Error(`Bundled immutable artifact is unavailable for '${daemonEntryPath}'`);
                }
                const pluginId = parseFirstPartyPluginIdFromPackageName(daemonEntryPath);
                if (pluginId) {
                    const distCandidate = resolve(repoRoot, 'packages', 'plugins', pluginId, 'dist', 'index.js');
                    const srcCandidate = resolve(repoRoot, 'packages', 'plugins', pluginId, 'src', 'index.ts');

                    if (
                        !immutableArtifactPackageNames.has(daemonEntryPath)
                        && canImportFirstPartyPluginSource()
                        && existsSync(srcCandidate)
                    ) {
                        // Dev/test local plugins must share the host's TS module graph; dist can carry a second SDK runtime context.
                        return await loadImport(pathToFileURL(srcCandidate).href);
                    }
                    if (existsSync(distCandidate)) {
                        return await loadImport(pathToFileURL(distCandidate).href);
                    }
                }

                return await loadImport(daemonEntryPath);
            },
        };
    };
}
