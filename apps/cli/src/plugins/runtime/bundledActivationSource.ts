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
    daemonEntryPath: string;
}>;

type BundledActivationSource = Readonly<{
    kind: 'bundled';
    moduleId: string;
    load: () => Promise<PluginDaemonModuleNamespace>;
}>;

type ImportModule = (specifier: string) => Promise<PluginDaemonModuleNamespace>;

type PrepareSourceDevSharedDeps = (params: Readonly<{
    packageName: string;
    workspaceNames?: readonly string[];
}>) => Promise<SourceDevSharedDepsPreflightResult> | SourceDevSharedDepsPreflightResult;

type SourceDevSharedDepsPreflightCacheEntry = {
    promise: Promise<SourceDevSharedDepsPreflightResult> | null;
    result: SourceDevSharedDepsPreflightResult | null;
};

function normalizePathSeparators(pathLike: string): string {
    return pathLike.replaceAll('\\', '/');
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
    canImportFirstPartyPluginSource?: () => boolean;
    existsSync?: (path: string) => boolean;
    importModule?: ImportModule;
    prepareSourceDevSharedDeps?: PrepareSourceDevSharedDeps;
    repoRoot?: string;
}>) {
    const bundledPackageNames = new Set(params.bundledPackageNames);
    const canImportFirstPartyPluginSource =
        params.canImportFirstPartyPluginSource ?? defaultCanImportFirstPartyPluginSource;
    const existsSync = params.existsSync ?? nodeExistsSync;
    const loadImport = params.importModule ?? importModule;
    const prepareSourceDevSharedDeps =
        params.prepareSourceDevSharedDeps ?? prepareSourceDevSharedDepsForBundledPluginRuntimeLoad;
    const repoRoot = params.repoRoot ?? defaultRepoRoot();
    const sourceDevSharedDepsPreflightByPackageName = new Map<string, SourceDevSharedDepsPreflightCacheEntry>();

    function resolveSourceDevWorkspaceNames(packageName: string): readonly string[] {
        const workspaceName = normalizeBundledWorkspaceNameFromPackageName(packageName);
        return workspaceName ? Object.freeze([workspaceName]) : Object.freeze([]);
    }

    async function runSourceDevSharedDepsPreflight(packageName: string): Promise<SourceDevSharedDepsPreflightResult> {
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

    return function resolveBundledActivationSource(target: BundledActivationTarget): BundledActivationSource | null {
        if (!bundledPackageNames.has(target.daemonEntryPath)) {
            return null;
        }

        return {
            kind: 'bundled' as const,
            moduleId: target.daemonEntryPath,
            load: async () => {
                const pluginId = parseFirstPartyPluginIdFromPackageName(target.daemonEntryPath);
                if (pluginId) {
                    const distCandidate = resolve(repoRoot, 'packages', 'plugins', pluginId, 'dist', 'index.js');
                    const srcCandidate = resolve(repoRoot, 'packages', 'plugins', pluginId, 'src', 'index.ts');

                    if (canImportFirstPartyPluginSource() && existsSync(srcCandidate)) {
                        const preflight = await runSourceDevSharedDepsPreflight(target.daemonEntryPath);
                        if (preflight.type === 'error') {
                            throw new Error(preflight.errorMessage);
                        }
                        // Dev/test local plugins must share the host's TS module graph; dist can carry a second SDK runtime context.
                        return await loadImport(pathToFileURL(srcCandidate).href);
                    }
                    if (existsSync(distCandidate)) {
                        return await loadImport(pathToFileURL(distCandidate).href);
                    }
                }

                return await loadImport(target.daemonEntryPath);
            },
        };
    };
}
