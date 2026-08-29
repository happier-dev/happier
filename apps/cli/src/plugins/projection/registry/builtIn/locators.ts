import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';

import { formatPluginManifestIngestionDiagnostics, type PluginSourceSpecV1 } from '@happier-dev/protocol';

import type { LoadedPlugin } from '@/plugins/discovery/load/installed';
import { projectPath } from '@/projectPath';
import { readGeneratedPluginUiArtifactsManifestSync } from '@/plugins/install/ui/generatedArtifacts';
import { ingestCanonicalPluginManifest } from '../../../manifest/ingest';
import { pluginSourceProvenanceForKind } from '../../../manifest/sourceProvenance';

export type BundledPluginLocator = Readonly<{
    pluginId: string;
    manifest: unknown;
    manifestPath: string;
    daemonEntryPath: string | null;
    devDaemonEntryPath?: string | null;
    sourceSpec: PluginSourceSpecV1;
}>;

function readBundledPluginRootPath(locator: BundledPluginLocator): string {
    if (locator.sourceSpec.kind !== 'bundled' || !locator.sourceSpec.locator.trim()) {
        throw new Error(`Invalid bundled source locator for plugin '${locator.pluginId}'`);
    }
    return locator.sourceSpec.locator;
}

const requireFromCli = createRequire(import.meta.url);

function managedProviderKey(pluginId: string, providerId: string): string {
    return `${pluginId}\u0000${providerId}`;
}

function readUnavailableManagedProviderKeys(): ReadonlySet<string> {
    const packageJson = JSON.parse(readFileSync(join(projectPath(), 'package.json'), 'utf8')) as Readonly<{
        happier?: Readonly<{ managedRuntimePublication?: unknown }>;
    }>;
    const metadata = packageJson.happier?.managedRuntimePublication;
    // An unmaterialized source checkout has no pack claim and retains its normal
    // developer runtime. Every tarball produced by packTarball carries metadata.
    if (metadata === undefined) return new Set();
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
        throw new Error('Invalid CLI managed runtime publication metadata');
    }
    const record = metadata as Readonly<Record<string, unknown>>;
    if (
        record.v !== 1
        || (record.mode !== 'source-only' && record.mode !== 'complete')
        || !Array.isArray(record.unavailableProviderRefs)
        || Object.keys(record).sort().join(',') !== 'mode,unavailableProviderRefs,v'
    ) {
        throw new Error('Invalid CLI managed runtime publication metadata');
    }
    const keys = new Set<string>();
    for (const value of record.unavailableProviderRefs) {
        if (!value || typeof value !== 'object' || Array.isArray(value)) {
            throw new Error('Invalid CLI managed runtime publication provider reference');
        }
        const ref = value as Readonly<Record<string, unknown>>;
        const pluginId = typeof ref.pluginId === 'string' ? ref.pluginId.trim() : '';
        const providerId = typeof ref.providerId === 'string' ? ref.providerId.trim() : '';
        if (!pluginId || !providerId || Object.keys(ref).sort().join(',') !== 'pluginId,providerId') {
            throw new Error('Invalid CLI managed runtime publication provider reference');
        }
        const key = managedProviderKey(pluginId, providerId);
        if (keys.has(key)) {
            throw new Error(`Duplicate CLI managed runtime publication provider reference '${pluginId}:${providerId}'`);
        }
        keys.add(key);
    }
    if (record.mode === 'complete' && keys.size > 0) {
        throw new Error('Complete CLI managed runtime publication cannot suppress provider facets');
    }
    if (record.mode === 'source-only' && keys.size === 0) {
        throw new Error('Source-only CLI managed runtime publication must identify unavailable provider facets');
    }
    return record.mode === 'source-only' ? keys : new Set();
}

export function projectManagedRuntimePublicationManifest(
    locator: BundledPluginLocator,
    unavailableProviderKeys: ReadonlySet<string>,
    unmatchedProviderKeys: Set<string>,
): unknown {
    if (unavailableProviderKeys.size === 0) return locator.manifest;
    if (!locator.manifest || typeof locator.manifest !== 'object' || Array.isArray(locator.manifest)) {
        return locator.manifest;
    }
    const manifest = locator.manifest as Readonly<Record<string, unknown>>;
    const contributes = manifest.contributes;
    if (!contributes || typeof contributes !== 'object' || Array.isArray(contributes)) return locator.manifest;
    const contributionRecord = contributes as Readonly<Record<string, unknown>>;
    if (!Array.isArray(contributionRecord.providers)) return locator.manifest;

    let changed = false;
    const providers = contributionRecord.providers.map((value) => {
        if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
        const provider = value as Readonly<Record<string, unknown>>;
        const providerId = typeof provider.id === 'string' ? provider.id : '';
        const key = managedProviderKey(locator.pluginId, providerId);
        if (!unavailableProviderKeys.has(key) || !Object.hasOwn(provider, 'managedRuntime')) return value;
        const { managedRuntime: _unavailableManagedRuntime, ...providerWithoutManagedRuntime } = provider;
        changed = true;
        unmatchedProviderKeys.delete(key);
        return providerWithoutManagedRuntime;
    });
    if (!changed) return locator.manifest;
    return {
        ...manifest,
        contributes: { ...contributionRecord, providers },
    };
}

function resolveInstalledBundledPluginRootPath(packageName: string): string | null {
    for (const searchPath of requireFromCli.resolve.paths(packageName) ?? []) {
        const packageRootPath = join(searchPath, ...packageName.split('/'));
        if (existsSync(join(packageRootPath, 'package.json'))) {
            return packageRootPath;
        }
    }
    return null;
}

export function loadBundledPluginLocators(
    locators: readonly BundledPluginLocator[],
): readonly LoadedPlugin[] {
    const seenPluginIds = new Set<string>();
    const unavailableProviderKeys = readUnavailableManagedProviderKeys();
    const unmatchedProviderKeys = new Set(unavailableProviderKeys);
    const loadedPlugins = locators.map((locator): LoadedPlugin => {
        if (seenPluginIds.has(locator.pluginId)) {
            throw new Error(`Duplicate bundled plugin locator '${locator.pluginId}'`);
        }
        seenPluginIds.add(locator.pluginId);

        const manifest = projectManagedRuntimePublicationManifest(
            locator,
            unavailableProviderKeys,
            unmatchedProviderKeys,
        );
        const ingestion = ingestCanonicalPluginManifest(manifest, {
            manifestAuthority: 'bundled_first_party',
            sourceProvenance: pluginSourceProvenanceForKind('bundled'),
        });
        if (!ingestion.ok) {
            throw new Error(
                `Invalid bundled plugin manifest '${locator.pluginId}': ${formatPluginManifestIngestionDiagnostics(ingestion.diagnostics)}`,
            );
        }
        if (ingestion.manifest.id !== locator.pluginId) {
            throw new Error(
                `Bundled plugin manifest id '${ingestion.manifest.id}' does not match '${locator.pluginId}'`,
            );
        }
        const declaredDaemon = ingestion.manifest.entrypoints?.daemon;
        if ((declaredDaemon !== undefined) !== (locator.daemonEntryPath !== null)) {
            throw new Error(
                `Bundled plugin '${locator.pluginId}' daemon locator does not match its manifest entrypoint`,
            );
        }
        const bundledPluginLocator = readBundledPluginRootPath(locator);
        const installedPluginRootPath = resolveInstalledBundledPluginRootPath(bundledPluginLocator);
        const generatedUiArtifactsManifest = installedPluginRootPath
            ? readGeneratedPluginUiArtifactsManifestSync(installedPluginRootPath)
            : null;

        return Object.freeze({
            pluginId: locator.pluginId,
            pluginRootPath: generatedUiArtifactsManifest && installedPluginRootPath
                ? installedPluginRootPath
                : bundledPluginLocator,
            manifestPath: locator.manifestPath,
            daemonEntryPath: locator.daemonEntryPath,
            devDaemonEntryPath: locator.devDaemonEntryPath ?? null,
            manifest: ingestion.manifest,
            sourceSpec: locator.sourceSpec,
            ...(generatedUiArtifactsManifest ? { generatedUiArtifactsManifest } : {}),
        });
    });
    if (unmatchedProviderKeys.size > 0) {
        throw new Error(
            `CLI managed runtime publication references unknown provider facets: ${[...unmatchedProviderKeys].map((key) => key.replace('\u0000', ':')).join(', ')}`,
        );
    }
    return Object.freeze(loadedPlugins);
}
