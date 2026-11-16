import { readFileSync } from 'node:fs';

import { formatPluginManifestIngestionDiagnostics, readPluginManifestReferencedPluginIdsV2 } from '@happier-dev/protocol/plugins/manifest/ingest';
import type { PluginSourceSpecV1 } from '@happier-dev/protocol';
import { isDynamicPluginResourceContributionV2 } from '@happier-dev/protocol/plugins/contributions/v2';
import { assertHostCanExcludeBundledPlugin } from '@happier-dev/cli-common/bundledPluginPublicationPolicy';
import { readCurrentBundledPluginPublicationFailures, resolveInstalledBundledPluginRootPath } from './publication';
export { readCurrentBundledPluginPublicationFailures, readAdmittedBundledPluginPublicationFailures } from './publication';

import type { LoadedPlugin } from '@/plugins/discovery/load/installed';
import { resolveCliRuntimeAssetPath } from '@/packagedRuntime/assets/resolveCliRuntimeAssetPath';
import { defaultCanImportFirstPartyPluginSource } from '@/packagedRuntime/resolvePackagedRuntimeEntrypoint';
import { readGeneratedPluginUiArtifactsManifestSync, readGeneratedPluginCompiledAccountResourceIdsSync } from '@/plugins/install/ui/generatedArtifacts';
import { projectPluginManifestCompatibilityDiagnostic } from '../../../manifest/diagnostics';
import type { BundledPluginPublicationFailure } from '@/plugins/validation/diagnostics/types';
import * as generatedBundledPluginManifests from '../sources/generatedBundledPluginManifests';
import { ingestBundledPluginManifest, readBundledPluginManifest } from './manifestFile';
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

export function loadBundledPluginLocatorResult(
    locators: readonly BundledPluginLocator[],
    publicationFailures: readonly BundledPluginPublicationFailure[] = [],
    registrationBindings: readonly BundledAgentRegistrationBinding[] = [],
    selectedPluginIds?: ReadonlySet<string>,
    /** Enabled locators a read declaration may reference; their exact closure is read once each. */
    referencePool?: ReadonlyMap<string, BundledPluginLocator>,
    pluginEnablementById?: Readonly<Record<string, ResolvedPluginEnablement>>,
): Readonly<{
    loadedPlugins: readonly LoadedPlugin[];
    pluginFailures: readonly BundledPluginAdmissionFailure[];
    admittedGraph: AdmittedPluginContributionGraph;
}> {
    const seenPluginIds = new Set<string>();
    const queue = [...locators];
    const inScope = (pluginId: string) => !selectedPluginIds || selectedPluginIds.has(pluginId) || referencePool?.has(pluginId) === true;
    const unavailableProviderKeys = new Set([...readUnavailableManagedProviderKeys()]
        .filter(key => inScope(key.slice(0, key.indexOf('\u0000')))));
    const unmatchedProviderKeys = new Set(unavailableProviderKeys);
    const loadedPlugins: LoadedPlugin[] = [];
    const pluginFailures: BundledPluginAdmissionFailure[] = [...publicationFailures];
    const failedPluginIds = new Set(publicationFailures.map((failure) => failure.pluginId));
    const agentPluginIds = new Set(registrationBindings
        .filter(binding => binding.registrationFamily === 'agents')
        .map(binding => binding.identity.pluginId));
    for (let index = 0; index < queue.length; index += 1) {
        const locator = queue[index]!;
        if (seenPluginIds.has(locator.pluginId)) {
            throw new Error(`Duplicate bundled plugin locator '${locator.pluginId}'`);
        }
        seenPluginIds.add(locator.pluginId);
        if (failedPluginIds.has(locator.pluginId)) continue;

        try {

        const manifest = projectManagedRuntimePublicationManifest(locator, unavailableProviderKeys, unmatchedProviderKeys);
        const ingestion = ingestBundledPluginManifest(locator, manifest);
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
        for (const pluginId of referencePool ? readPluginManifestReferencedPluginIdsV2(ingestion.manifest) : []) {
            const referenced = referencePool?.get(pluginId);
            if (referenced && !queue.includes(referenced)) queue.push(referenced);
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
        const compiledAccountResourceIds = installedPluginRootPath && generatedUiArtifactsManifest
            && ingestion.manifest.contributes.resources.some(resource => isDynamicPluginResourceContributionV2(resource) && resource.execution?.target === 'account')
            ? readGeneratedPluginCompiledAccountResourceIdsSync(installedPluginRootPath, locator.pluginId, 'bundled') : null;

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
            ...(compiledAccountResourceIds ? { compiledAccountResourceIds } : {}),
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
    if (referencePool) {
        // Keys and bindings of pool plugins outside the read closure are not this read's facts.
        for (const key of [...unmatchedProviderKeys]) if (!seenPluginIds.has(key.slice(0, key.indexOf('\u0000')))) unmatchedProviderKeys.delete(key);
    }
    if (unmatchedProviderKeys.size > 0) {
        throw new Error(
            `CLI managed runtime publication references unknown provider facets: ${[...unmatchedProviderKeys].map((key) => key.replace('\u0000', ':')).join(', ')}`,
        );
    }
    for (const binding of registrationBindings) {
        if (binding.registrationFamily !== 'agents' || failedPluginIds.has(binding.identity.pluginId)) continue;
        if (referencePool && !seenPluginIds.has(binding.identity.pluginId)) continue;
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
        pluginEnablementById,
        loadDiagnosticsByPluginId: Object.fromEntries(pluginFailures.map(failure => [failure.pluginId, [failure.diagnostic]])),
        // File declarations were admitted by the bundled publisher (`ingestBundledPluginManifest`).
        declarationAdmittedPluginIds: new Set(queue.filter(locator => 'manifestRelativePath' in locator).map(locator => locator.pluginId)),
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

let admittedBundledPlugins: Readonly<{
    enabledPluginIdsKey: string;
    result: ReturnType<typeof loadBundledPluginLocatorResult>;
}> | null = null;
/** Exact selections admitted for one enabled set; bundled declarations are immutable per runtime. */
let admittedBundledSelections: { enabledPluginIdsKey: string; bySelection: Map<string, ReturnType<typeof loadBundledPluginLocatorResult>> } | null = null;

/** Consume the admitted scope decision before acquiring declarations. */
export function loadEnabledBundledPluginLocatorResult(params?: Readonly<{
    pluginIds?: readonly string[];
    pluginEnablementById?: Readonly<Record<string, ResolvedPluginEnablement>>;
}>): ReturnType<typeof loadBundledPluginLocatorResult> {
    return loadCurrentBundledPluginLocatorResult(params);
}

export function loadCurrentBundledPluginLocatorResult(params?: Readonly<{
    pluginIds?: readonly string[];
    pluginEnablementById?: Readonly<Record<string, ResolvedPluginEnablement>>;
}>): ReturnType<typeof loadBundledPluginLocatorResult> {
    const hasWithdrawal = Object.values(params?.pluginEnablementById ?? {}).some(fact => !fact.enabled);
    const enabledLocators = hasWithdrawal
        ? generatedBundledPluginManifests.BUNDLED_FIRST_PARTY_PLUGIN_LOCATORS.filter(locator =>
            params?.pluginEnablementById?.[locator.pluginId]?.enabled !== false)
        : generatedBundledPluginManifests.BUNDLED_FIRST_PARTY_PLUGIN_LOCATORS;
    const enabledPluginIdsKey = JSON.stringify([
        enabledLocators.map(locator => locator.pluginId),
        Object.entries(params?.pluginEnablementById ?? {}).filter(([, fact]) => !fact.enabled)
            .map(([pluginId, fact]) => [pluginId, fact.unavailableCode ?? 'plugin_disabled']),
    ]);
    const admitted = admittedBundledPlugins?.enabledPluginIdsKey === enabledPluginIdsKey
        ? admittedBundledPlugins.result : null;
    if (params?.pluginIds) {
        const requested = new Set(params.pluginIds);
        const selected = new Set(enabledLocators.filter(locator => requested.has(locator.pluginId))
            .map(locator => locator.pluginId));
        const fromAdmitted = (full: ReturnType<typeof loadBundledPluginLocatorResult>) => {
            const loadedPlugins = Object.freeze(full.loadedPlugins.filter(plugin => selected.has(plugin.pluginId)));
            return Object.freeze({
                loadedPlugins,
                pluginFailures: Object.freeze(full.pluginFailures.filter(failure => selected.has(failure.pluginId))),
                admittedGraph: Object.freeze({ loadedPlugins,
                    unavailablePlugins: full.admittedGraph.unavailablePlugins,
                    diagnosticsByPluginId: Object.freeze(Object.fromEntries(Object.entries(full.admittedGraph.diagnosticsByPluginId)
                        .filter(([pluginId]) => selected.has(pluginId)))),
                }),
            });
        };
        if (admitted) return fromAdmitted(admitted);
        // A declaration is admitted against the plugins its qualified references
        // target, never against unrelated ones. Load that exact enabled closure: a
        // cross-plugin reference (for example a Connected service owned by another
        // plugin) must not widen a narrow read to every bundled manifest.
        const selectionKey = JSON.stringify([...selected].sort());
        if (admittedBundledSelections?.enabledPluginIdsKey !== enabledPluginIdsKey) {
            admittedBundledSelections = { enabledPluginIdsKey, bySelection: new Map() };
        }
        const retained = admittedBundledSelections.bySelection.get(selectionKey);
        if (retained) return retained;
        const enabledById = new Map(enabledLocators.map(locator => [locator.pluginId, locator]));
        const result = fromAdmitted(loadBundledPluginLocatorResult(
            enabledLocators.filter(locator => selected.has(locator.pluginId)),
            defaultCanImportFirstPartyPluginSource()
                ? [] : readCurrentBundledPluginPublicationFailures().filter(failure => enabledById.has(failure.pluginId)),
            BUNDLED_FIRST_PARTY_AGENT_REGISTRATION_BINDINGS.filter(binding => enabledById.has(binding.identity.pluginId)),
            selected,
            enabledById,
            params?.pluginEnablementById,
        ));
        admittedBundledSelections.bySelection.set(selectionKey, result);
        return result;
    }
    // Retain one admission for the current enabled set. Repeated catalog reads
    // reuse it even when a bundled plugin has been withdrawn; a changed set
    // still resolves cross-plugin references against its own enabled graph.
    if (admitted) return admitted;
    // Direct TypeScript loading has no publication claim. Compiled source
    // runtimes carry their own derived declarations and failure inventory,
    // just as package runtimes carry their own publication inventory.
    const enabledPluginIds = new Set(enabledLocators.map(locator => locator.pluginId));
    const result = loadBundledPluginLocatorResult(
        enabledLocators,
        defaultCanImportFirstPartyPluginSource()
            ? [] : readCurrentBundledPluginPublicationFailures().filter(failure => enabledPluginIds.has(failure.pluginId)),
        BUNDLED_FIRST_PARTY_AGENT_REGISTRATION_BINDINGS.filter(binding => enabledPluginIds.has(binding.identity.pluginId)),
        enabledPluginIds,
        undefined,
        params?.pluginEnablementById,
    );
    admittedBundledPlugins = { enabledPluginIdsKey, result };
    return result;
}

export type BundledPluginAdmissionFailure = Readonly<{
    packageName: string;
    pluginId: string;
    diagnostic: PluginCompatibilityDiagnostic;
}>;
