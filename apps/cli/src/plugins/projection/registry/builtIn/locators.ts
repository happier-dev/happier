import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';

import { formatPluginManifestIngestionDiagnostics } from '@happier-dev/protocol/plugins/manifest/ingest';
import type { PluginSourceSpecV1 } from '@happier-dev/protocol';
import { assertHostCanExcludeBundledPlugin } from '@happier-dev/cli-common/bundledPluginPublicationPolicy';
import { readCurrentBundledPluginPublicationFailures } from './publication';
export { readCurrentBundledPluginPublicationFailures, readAdmittedBundledPluginPublicationFailures } from './publication';

import type { LoadedPlugin } from '@/plugins/discovery/load/installed';
import { resolveCliRuntimeAssetPath } from '@/packagedRuntime/assets/resolveCliRuntimeAssetPath';
import { defaultCanImportFirstPartyPluginSource, isExecutingFirstPartySourceRuntime } from '@/packagedRuntime/resolvePackagedRuntimeEntrypoint';
import { readGeneratedPluginUiArtifactsManifestSync } from '@/plugins/install/ui/generatedArtifacts';
import { ingestCanonicalPluginManifest } from '../../../manifest/ingest';
import { projectPluginManifestCompatibilityDiagnostic } from '../../../manifest/diagnostics';
import { pluginSourceProvenanceForKind } from '../../../manifest/sourceProvenance';
import type { BundledPluginPublicationFailure } from '@/plugins/validation/diagnostics/types';
import * as generatedBundledPluginManifests from '../sources/generatedBundledPluginManifests';
import { readBundledPluginManifest, readBundledPluginManifestInput } from './manifestFile';
import { BUNDLED_FIRST_PARTY_AGENT_REGISTRATION_BINDINGS } from '../sources/generatedBundledPlugins';
import { admitPluginContributionGraph, isPluginAdmissionExclusion, type AdmittedPluginContributionGraph } from '../normalize/admission';
import type { BundledAgentRegistrationBinding } from './agentIdentity';
import type { PluginCompatibilityDiagnostic } from '@/plugins/validation/diagnostics/types';
import type { ResolvedPluginEnablement } from '../types';
export { readBundledPluginManifest } from './manifestFile';

export type BundledPluginLocator = Readonly<{
    pluginId: string;
    manifestPath: string;
    daemonEntryPath: string | null;
    devDaemonEntryPath?: string | null;
    sourceSpec: PluginSourceSpecV1;
}> & (Readonly<{ manifestRelativePath: string }> | Readonly<{ manifest: unknown }>);

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
    const packageJson = JSON.parse(readFileSync(resolveCliRuntimeAssetPath('package.json'), 'utf8')) as Readonly<{
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
    const declaration = readBundledPluginManifest(locator);
    if (unavailableProviderKeys.size === 0) return declaration;
    if (!declaration || typeof declaration !== 'object' || Array.isArray(declaration)) {
        return declaration;
    }
    const manifest = declaration as Readonly<Record<string, unknown>>;
    const contributes = manifest.contributes;
    if (!contributes || typeof contributes !== 'object' || Array.isArray(contributes)) return declaration;
    const contributionRecord = contributes as Readonly<Record<string, unknown>>;
    if (!Array.isArray(contributionRecord.providers)) return declaration;

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
    if (!changed) return declaration;
    return {
        ...manifest,
        contributes: { ...contributionRecord, providers },
    };
}

function resolveInstalledBundledPluginRootPath(packageName: string): string | null {
    // Source runtime emission puts the plugin beside its CLI. Its immutable
    // graph and bytes must not come from the moving dependency symlink instead.
    if (isExecutingFirstPartySourceRuntime(import.meta.url) && packageName.startsWith('@happier-dev/plugins-')) {
        return resolveCliRuntimeAssetPath('../../packages/plugins', packageName.slice('@happier-dev/plugins-'.length));
    }
    for (const searchPath of requireFromCli.resolve.paths(packageName) ?? []) {
        const packageRootPath = join(searchPath, ...packageName.split('/'));
        if (existsSync(join(packageRootPath, 'package.json'))) {
            return packageRootPath;
        }
    }
    return null;
}

export function loadBundledPluginLocatorResult(
    locators: readonly BundledPluginLocator[],
    publicationFailures: readonly BundledPluginPublicationFailure[] = [],
    registrationBindings: readonly BundledAgentRegistrationBinding[] = [],
    selectedPluginIds?: ReadonlySet<string>,
): Readonly<{
    loadedPlugins: readonly LoadedPlugin[];
    pluginFailures: readonly BundledPluginAdmissionFailure[];
    admittedGraph: AdmittedPluginContributionGraph;
}> {
    const seenPluginIds = new Set<string>();
    const unavailableProviderKeys = new Set([...readUnavailableManagedProviderKeys()]
        .filter(key => !selectedPluginIds || selectedPluginIds.has(key.slice(0, key.indexOf('\u0000')))));
    const unmatchedProviderKeys = new Set(unavailableProviderKeys);
    const loadedPlugins: LoadedPlugin[] = [];
    const pluginFailures: BundledPluginAdmissionFailure[] = [...publicationFailures];
    const failedPluginIds = new Set(publicationFailures.map((failure) => failure.pluginId));
    const agentPluginIds = new Set(registrationBindings
        .filter(binding => binding.registrationFamily === 'agents')
        .map(binding => binding.identity.pluginId));
    for (const locator of locators) {
        if (seenPluginIds.has(locator.pluginId)) {
            throw new Error(`Duplicate bundled plugin locator '${locator.pluginId}'`);
        }
        seenPluginIds.add(locator.pluginId);
        if (failedPluginIds.has(locator.pluginId)) continue;

        try {

        // File JSON already supplies the data boundary. Avoid decoding it into
        // an object only for ingress to normalize, serialize and decode again.
        // A managed-facet rewrite still needs the parsed declaration.
        const manifest = unavailableProviderKeys.size === 0
            ? readBundledPluginManifestInput(locator)
            : projectManagedRuntimePublicationManifest(locator, unavailableProviderKeys, unmatchedProviderKeys);
        const ingestion = ingestCanonicalPluginManifest(manifest, {
            purpose: 'installedRead',
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

        loadedPlugins.push(Object.freeze({
            pluginId: locator.pluginId,
            pluginRootPath: installedPluginRootPath ?? bundledPluginLocator,
            manifestPath: locator.manifestPath,
            daemonEntryPath: locator.daemonEntryPath,
            devDaemonEntryPath: locator.devDaemonEntryPath ?? null,
            manifest: ingestion.manifest,
            ...(ingestion.diagnostics?.length ? { admissionDiagnostics: ingestion.diagnostics.map(projectPluginManifestCompatibilityDiagnostic) } : {}),
            sourceSpec: locator.sourceSpec,
            ...(generatedUiArtifactsManifest ? { generatedUiArtifactsManifest } : {}),
        }));
        } catch (error) {
            // Required package imports/builds remain host obligations. An
            // unavailable Agent declaration cannot authorize that Agent, but
            // does not remove its package's independent host-imported code.
            if (!agentPluginIds.has(locator.pluginId)) {
                assertHostCanExcludeBundledPlugin('', locator.sourceSpec.locator, error);
            }
            failedPluginIds.add(locator.pluginId);
            pluginFailures.push(Object.freeze({
                packageName: locator.sourceSpec.locator,
                pluginId: locator.pluginId,
                diagnostic: Object.freeze({
                    code: 'plugin_manifest_invalid',
                    message: error instanceof Error ? error.message : String(error),
                }),
            }));
        }
    }
    if (unmatchedProviderKeys.size > 0) {
        throw new Error(
            `CLI managed runtime publication references unknown provider facets: ${[...unmatchedProviderKeys].map((key) => key.replace('\u0000', ':')).join(', ')}`,
        );
    }
    for (const binding of registrationBindings) {
        if (binding.registrationFamily !== 'agents' || failedPluginIds.has(binding.identity.pluginId)) continue;
        const plugin = loadedPlugins.find(candidate => candidate.pluginId === binding.identity.pluginId);
        // A host binding is a locator, not a registration. An unavailable Agent
        // contribution must not withdraw this plugin's healthy siblings; the
        // actual activation scope still refuses anything outside admitted rights.
        if (plugin) continue;
        failedPluginIds.add(binding.identity.pluginId);
        pluginFailures.push({
            pluginId: binding.identity.pluginId,
            packageName: locators.find(locator => locator.pluginId === binding.identity.pluginId)?.sourceSpec.locator
                ?? generatedBundledPluginManifests.BUNDLED_FIRST_PARTY_PLUGIN_METADATA.find(metadata => metadata.pluginId === binding.identity.pluginId)?.packageName
                ?? binding.identity.pluginId,
            diagnostic: { code: 'plugin_manifest_missing', stage: 'normalization',
                message: `Missing bundled manifest for agent '${binding.implementationOwnerId}'`,
                details: { reason: 'plugin_manifest_missing', agentId: binding.implementationOwnerId } },
        });
    }
    const admittedGraph = admitPluginContributionGraph({
        loadedPlugins: loadedPlugins.filter(plugin => !failedPluginIds.has(plugin.pluginId)),
    });
    for (const [pluginId, diagnostics] of Object.entries(admittedGraph.diagnosticsByPluginId)) {
        const fatal = diagnostics.find(isPluginAdmissionExclusion);
        if (!fatal) continue;
        const plugin = loadedPlugins.find(candidate => candidate.pluginId === pluginId)!;
        if (!agentPluginIds.has(pluginId)) {
            assertHostCanExcludeBundledPlugin('', plugin.sourceSpec.locator, new Error(fatal.message));
        }
        pluginFailures.push({ packageName: plugin.sourceSpec.locator, pluginId, diagnostic: fatal });
    }
    return Object.freeze({
        loadedPlugins: admittedGraph.loadedPlugins,
        pluginFailures: Object.freeze(pluginFailures),
        admittedGraph,
    });
}

export function loadBundledPluginLocators(
    locators: readonly BundledPluginLocator[],
): readonly LoadedPlugin[] {
    const result = loadBundledPluginLocatorResult(locators);
    if (result.pluginFailures.length > 0) {
        throw new Error(result.pluginFailures[0]!.diagnostic.message);
    }
    return result.loadedPlugins;
}

let admittedBundledPlugins: ReturnType<typeof loadBundledPluginLocatorResult> | null = null;

/** Scope intent withdraws declarations from the existing admission graph. */
export function loadEnabledBundledPluginLocatorResult(params?: Readonly<{
    pluginIds?: readonly string[];
    pluginEnablementById?: Readonly<Record<string, ResolvedPluginEnablement>>;
}>): ReturnType<typeof loadBundledPluginLocatorResult> {
    // Withdrawals can affect references outside an exact selection; admit that
    // universe once before the existing family projection selects its output.
    const hasWithdrawal = Object.values(params?.pluginEnablementById ?? {}).some(fact => !fact.enabled);
    const bundled = loadCurrentBundledPluginLocatorResult(!hasWithdrawal && params?.pluginIds
        ? { pluginIds: params.pluginIds } : undefined);
    if (!hasWithdrawal) return bundled;
    const admittedGraph = admitPluginContributionGraph({ loadedPlugins: bundled.loadedPlugins,
        pluginEnablementById: params?.pluginEnablementById });
    return Object.freeze({ ...bundled, loadedPlugins: admittedGraph.loadedPlugins, admittedGraph });
}

export function loadCurrentBundledPluginLocatorResult(params?: Readonly<{ pluginIds: readonly string[] }>): ReturnType<typeof loadBundledPluginLocatorResult> {
    if (params) {
        const selected = new Set(params.pluginIds);
        if (!admittedBundledPlugins) {
            const result = loadBundledPluginLocatorResult(
                generatedBundledPluginManifests.BUNDLED_FIRST_PARTY_PLUGIN_LOCATORS.filter(locator => selected.has(locator.pluginId)),
                defaultCanImportFirstPartyPluginSource()
                    ? [] : readCurrentBundledPluginPublicationFailures().filter(failure => selected.has(failure.pluginId)),
                BUNDLED_FIRST_PARTY_AGENT_REGISTRATION_BINDINGS.filter(binding => selected.has(binding.identity.pluginId)),
                selected,
            );
            // A real cross-plugin reference demands its existing full admission
            // universe. Never withdraw a valid selected declaration just because
            // a narrow read omitted its dependency, or bypass graph validation.
            if (Object.keys(result.admittedGraph.diagnosticsByPluginId).length === 0) return result;
        }
        const full = loadCurrentBundledPluginLocatorResult();
        const loadedPlugins = Object.freeze(full.loadedPlugins.filter(plugin => selected.has(plugin.pluginId)));
        return Object.freeze({
            loadedPlugins,
            pluginFailures: Object.freeze(full.pluginFailures.filter(failure => selected.has(failure.pluginId))),
            admittedGraph: Object.freeze({ loadedPlugins,
                diagnosticsByPluginId: Object.freeze(Object.fromEntries(Object.entries(full.admittedGraph.diagnosticsByPluginId)
                    .filter(([pluginId]) => selected.has(pluginId)))),
            }),
        });
    }
    // Admit the executing closure's bundled declarations on the first catalog
    // demand. Installed-plugin discovery then reuses that graph instead of
    // rereading and validating every bundled manifest on each refresh.
    if (admittedBundledPlugins) return admittedBundledPlugins;
    // Direct TypeScript loading has no publication claim. Compiled source
    // runtimes carry their own derived declarations and failure inventory,
    // just as package runtimes carry their own publication inventory.
    return admittedBundledPlugins = loadBundledPluginLocatorResult(
        generatedBundledPluginManifests.BUNDLED_FIRST_PARTY_PLUGIN_LOCATORS,
        defaultCanImportFirstPartyPluginSource()
            ? [] : readCurrentBundledPluginPublicationFailures(),
        BUNDLED_FIRST_PARTY_AGENT_REGISTRATION_BINDINGS,
    );
}

export type BundledPluginAdmissionFailure = Readonly<{
    packageName: string;
    pluginId: string;
    diagnostic: PluginCompatibilityDiagnostic;
}>;
