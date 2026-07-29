import {
    type InstallablesRegistry,
} from '@happier-dev/protocol';
import type {
    ResolvedAgentContribution,
    ResolvedAgentRuntimeContribution,
    ResolvedCatalogEntry,
    ResolvedContributionRegistry,
} from '@/plugins/projection/registry/types';
import {
    resolveExecutableManagedDependenciesRegistry,
} from '@/plugins/projection/registry/managedDependencyExecutables';
import type { ResolvedExecutablePluginRuntimeRegistry } from '@/plugins/runtime/resolveExecutablePluginRuntimeRegistry';
import {
    createEmptyBackendExecutionSurfaces,
    type BackendExecutionSurfaces,
    type EngineAdapterResolution,
    type EngineResolutionSelectedSource,
} from '../engineRegistryTypes';
import type { RuntimeRegistryBackendEngineEntry } from './runtimeOwnerResolution';

export function readRuntimeRegistryBackendEngineEntry(
    runtimeRegistry: ResolvedExecutablePluginRuntimeRegistry,
    backend: ResolvedAgentRuntimeContribution,
): RuntimeRegistryBackendEngineEntry | undefined {
    const registry = runtimeRegistry.agentRuntimesByAgentId;
    if (!registry || typeof registry.get !== 'function') return undefined;
    const direct = registry.get(backend.id) ?? registry.get(backend.agentId);
    if (direct) return direct;
    if (!backend.pluginId) return undefined;
    const owned = [...registry.values()].filter((entry) => entry.pluginId === backend.pluginId);
    return owned.length === 1 ? owned[0] : undefined;
}

function readCurrentAgentRuntimeKind(agent: ResolvedAgentContribution): string | null {
    const definition = agent.richDefinition?.definition;
    if (!definition || typeof definition !== 'object' || Array.isArray(definition)) return null;
    const runtime = Reflect.get(definition, 'runtime');
    if (!runtime || typeof runtime !== 'object' || Array.isArray(runtime)) return null;
    const kind = Reflect.get(runtime, 'kind');
    return typeof kind === 'string' ? kind : null;
}

/**
 * The engine registry still consumes a backend-shaped execution view, while
 * Manifest V2 now declares one canonical Agent contribution. Keep that shape
 * adaptation at this boundary instead of reviving a second projected runtime
 * registry for current plugins.
 */
export function resolveEngineRuntimeContribution(
    contributions: Pick<ResolvedContributionRegistry, 'agentDefinitionsById'>,
    agentId: string,
): ResolvedAgentRuntimeContribution | null {
    const agent = contributions.agentDefinitionsById.get(agentId);
    if (!agent) return null;
    const runtimeKind = readCurrentAgentRuntimeKind(agent);
    return Object.freeze({
        id: agent.id,
        agentId: agent.id,
        provenance: agent.provenance,
        source: agent.source,
        definition: Object.freeze({
            kindVersion: 1,
            id: agent.id,
            agentId: agent.id,
        }),
        ...(runtimeKind ? { runtimeKind } : {}),
        surfaceHandlers: Object.freeze([]),
        ...(agent.sourceSpec ? { sourceSpec: agent.sourceSpec } : {}),
        ...(agent.pluginId ? { pluginId: agent.pluginId } : {}),
        ...(agent.manifestPath ? { manifestPath: agent.manifestPath } : {}),
        ...(agent.manifestDigest ? { manifestDigest: agent.manifestDigest } : {}),
        ...(agent.daemonEntryPath !== undefined ? { daemonEntryPath: agent.daemonEntryPath } : {}),
        ...(agent.devDaemonEntryPath !== undefined ? { devDaemonEntryPath: agent.devDaemonEntryPath } : {}),
    });
}

export function listEngineRuntimeContributionIds(
    contributions: Pick<ResolvedContributionRegistry, 'agentDefinitionsById'>,
): readonly string[] {
    return Object.freeze([...contributions.agentDefinitionsById.keys()]);
}

export function createPluginExecInstallablesRegistry(
    runtimeRegistry: ResolvedContributionRegistry | null | undefined,
): InstallablesRegistry | undefined {
    const registry = resolveExecutableManagedDependenciesRegistry(
        runtimeRegistry?.managedDependencies ?? [],
    );
    return registry.descriptors.length > 0 ? registry : undefined;
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
    const replayChildLaunch = !omissions.fork && entry.resolveReplayChildLaunch
        ? {
            resolveReplayChildLaunch: async (
                request: Parameters<NonNullable<NonNullable<BackendExecutionSurfaces['fork']>['resolveReplayChildLaunch']>>[0],
            ) => await entry.resolveReplayChildLaunch!(request.parentMetadata),
        }
        : null;
    return {
        terminalRuntime: null,
        externalSession: null,
        attach: !omissions.attach && entry.getProviderAttachOps ? await entry.getProviderAttachOps() : null,
        handoff: !omissions.handoff && entry.getHandoffSurface ? await entry.getHandoffSurface() : null,
        fork: replayChildLaunch,
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
