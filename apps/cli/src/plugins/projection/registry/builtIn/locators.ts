import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';

import { formatPluginManifestIngestionDiagnostics, type PluginSourceSpecV1 } from '@happier-dev/protocol';

import type { LoadedPlugin } from '@/plugins/discovery/load/installed';
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
    return Object.freeze(locators.map((locator): LoadedPlugin => {
        if (seenPluginIds.has(locator.pluginId)) {
            throw new Error(`Duplicate bundled plugin locator '${locator.pluginId}'`);
        }
        seenPluginIds.add(locator.pluginId);

        const ingestion = ingestCanonicalPluginManifest(locator.manifest, {
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
    }));
}
