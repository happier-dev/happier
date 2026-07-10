import {
    ExternalSessionsAgentIdSchema,
    resolveInstallablesRegistry,
    type InstallableRegistryContribution,
    type InstallablesRegistry,
} from '@happier-dev/protocol';
import type {
    ResolvedAgentRuntimeContribution,
    ResolvedCatalogEntry,
    ResolvedContributionRegistry,
    ResolvedInstallableContribution,
} from '@/plugins/projection/registry/types';
import type { ResolvedExecutablePluginRuntimeRegistry } from '@/plugins/runtime/resolveExecutablePluginRuntimeRegistry';
import {
    createEmptyBackendExecutionSurfaces,
    type BackendExecutionSurfaces,
    type CliRuntimeCoreGetter,
    type EngineAdapterResolution,
    type EngineResolutionSelectedSource,
} from '../engineRegistryTypes';
import type { RuntimeRegistryBackendEngineEntry } from './runtimeOwnerResolution';

export function readRuntimeRegistryBackendEngineEntry(
    runtimeRegistry: ResolvedExecutablePluginRuntimeRegistry,
    backendId: string,
): RuntimeRegistryBackendEngineEntry | undefined {
    const registry = runtimeRegistry.agentRuntimesByAgentId;
    return registry && typeof registry.get === 'function' ? registry.get(backendId) : undefined;
}

function toPluginExecInstallableRegistryContribution(
    contribution: ResolvedInstallableContribution,
): InstallableRegistryContribution {
    const isBuiltIn = contribution.provenance === 'first_party'
        && !contribution.pluginId
        && !contribution.manifestPath
        && !contribution.manifestDigest
        && !contribution.daemonEntryPath
        && !contribution.sourceSpec;
    return {
        owner: {
            provenance: isBuiltIn
                ? 'built_in'
                : contribution.provenance === 'first_party'
                    ? 'bundled_first_party_plugin'
                    : 'external_plugin',
            ownerId: contribution.pluginId ?? `${contribution.provenance}:${contribution.definition.key}`,
            ...(contribution.pluginId ? { pluginId: contribution.pluginId } : {}),
            ...(contribution.manifestPath ? { manifestPath: contribution.manifestPath } : {}),
            ...(contribution.manifestDigest ? { manifestDigest: contribution.manifestDigest } : {}),
        },
        descriptor: contribution.definition,
    };
}

export function createPluginExecInstallablesRegistry(
    runtimeRegistry: ResolvedContributionRegistry | null | undefined,
): InstallablesRegistry | undefined {
    const installables = runtimeRegistry?.managedDependencies ?? [];
    if (installables.length === 0) return undefined;
    const builtIns: InstallableRegistryContribution[] = [];
    const bundledFirstPartyPlugins: InstallableRegistryContribution[] = [];
    const externalPlugins: InstallableRegistryContribution[] = [];
    for (const installable of installables) {
        const contribution = toPluginExecInstallableRegistryContribution(installable);
        if (contribution.owner.provenance === 'built_in') {
            builtIns.push(contribution);
        } else if (contribution.owner.provenance === 'bundled_first_party_plugin') {
            bundledFirstPartyPlugins.push(contribution);
        } else {
            externalPlugins.push(contribution);
        }
    }
    return resolveInstallablesRegistry({
        builtIns,
        bundledFirstPartyPlugins,
        externalPlugins,
    });
}

type BackendSurfaceKind = NonNullable<ResolvedAgentRuntimeContribution['surfaceHandlers']>[number]['kind'];
type CatalogSurfaceOmissions = Readonly<Partial<Record<BackendSurfaceKind, true>>>;

export function toEngineSelectedSource(
    backendProvenance: EngineAdapterResolution['provenance'],
    providerRuntimePreference?: 'system-first' | 'managed-first' | null,
): EngineResolutionSelectedSource | undefined {
    if (backendProvenance === 'external') {
        return 'plugin';
    }
    if (providerRuntimePreference === 'managed-first') {
        return 'managed';
    }
    if (providerRuntimePreference === 'system-first') {
        return 'system';
    }
    return undefined;
}

function resolveCatalogSurfaceOmissions(backend: ResolvedAgentRuntimeContribution): CatalogSurfaceOmissions {
    const omissions: Partial<Record<BackendSurfaceKind, true>> = {};
    for (const surfaceHandler of backend.surfaceHandlers ?? []) {
        if (surfaceHandler.support === 'unsupported') {
            continue;
        }
        omissions[surfaceHandler.kind] = true;
    }
    return omissions;
}

async function resolveCatalogExecutionSurfacesForEntry(
    entry: ResolvedCatalogEntry,
    omissions: CatalogSurfaceOmissions = {},
): Promise<BackendExecutionSurfaces> {
    const externalSession = !omissions.externalSession
        && ExternalSessionsAgentIdSchema.safeParse(entry.id).success
        && entry.getExternalSessionProviderOps
        ? await entry.getExternalSessionProviderOps()
        : null;

    return {
        terminalRuntime: !omissions.terminalRuntime && entry.getTerminalRuntimeOps ? await entry.getTerminalRuntimeOps() : null,
        externalSession,
        attach: !omissions.attach && entry.getProviderAttachOps ? await entry.getProviderAttachOps() : null,
        handoff: !omissions.handoff && entry.getHandoffSurface ? await entry.getHandoffSurface() : null,
        fork: !omissions.fork && entry.getForkSurface ? await entry.getForkSurface() : null,
        // CHKPT-5 owns product checkpoint/restore orchestration. Catalog-only
        // backend entries must not claim checkpoint readiness from surface shape
        // existence; provider checkpoint leaves are consumed through declared
        // plugin/engine surfaces and operation-specific availability.
        checkpoint: null,
    };
}

export async function resolveCatalogExecutionSurfacesForFirstPartyBackend(params: Readonly<{
    backend: ResolvedAgentRuntimeContribution;
    entry?: ResolvedCatalogEntry | null;
}>): Promise<BackendExecutionSurfaces> {
    return params.entry
        ? await resolveCatalogExecutionSurfacesForEntry(params.entry, resolveCatalogSurfaceOmissions(params.backend))
        : createEmptyBackendExecutionSurfaces();
}

function resolveRuntimeCoreGetter(entry: Readonly<{
    getRuntimeCore?: CliRuntimeCoreGetter | undefined;
}>): CliRuntimeCoreGetter | null {
    return typeof entry.getRuntimeCore === 'function' ? entry.getRuntimeCore : null;
}

export function resolveContributionRuntimeCoreGetter(params: Readonly<{
    backend: ResolvedAgentRuntimeContribution;
    catalogEntry?: ResolvedCatalogEntry | null;
}>): CliRuntimeCoreGetter | null {
    if (params.backend.provenance !== 'first_party') {
        return resolveRuntimeCoreGetter(params.backend);
    }
    return resolveRuntimeCoreGetter(params.catalogEntry ?? {})
        ?? resolveRuntimeCoreGetter(params.backend);
}
