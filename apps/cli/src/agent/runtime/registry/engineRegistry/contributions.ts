import {
    type InstallablesRegistry,
} from '@happier-dev/protocol';
import type {
    ResolvedAgentContribution,
    ResolvedAgentRuntimeContribution,
    ResolvedContributionRegistry,
} from '@/plugins/projection/registry/types';
import {
    resolveExecutableManagedDependenciesRegistry,
} from '@/plugins/projection/registry/managedDependencyExecutables';
import type { ResolvedExecutablePluginRuntimeRegistry } from '@/plugins/runtime/resolveExecutablePluginRuntimeRegistry';
import type {
    EngineAdapterResolution,
    EngineResolutionSelectedSource,
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
    backendId: string,
): ResolvedAgentRuntimeContribution | null {
    const direct =
        contributions.agentDefinitionsById.get(backendId);
    const owned = direct
        ? []
        : [...contributions.agentDefinitionsById.values()]
            .filter((candidate) =>
                candidate.definition.ownedBackendIds
                    ?.includes(backendId)
            );
    if (!direct && owned.length !== 1) return null;
    const agent = direct ?? owned[0];
    if (!agent) return null;
    return projectEngineRuntimeContributionFromAgent(agent, backendId);
}

/**
 * Resolves the one execution backend that a catalog Agent can safely address.
 *
 * An Agent id is a direct engine key only when the canonical Agent projection
 * declares no distinct backend ids. A sole declared backend is authoritative;
 * ambiguous aliases intentionally fail closed rather than making consumers
 * infer that an Agent id and backend id are interchangeable.
 */
export function resolveEngineBackendIdForCatalogAgent(
    contributions: Pick<ResolvedContributionRegistry, 'agentDefinitionsById'>,
    agentId: string,
): string | null {
    const agent = contributions.agentDefinitionsById.get(agentId);
    if (!agent) return null;

    const declaredBackendIds = agent.definition.ownedBackendIds ?? [];
    const backendId = declaredBackendIds.length === 0
        ? agentId
        : declaredBackendIds.includes(agentId)
            ? agentId
            : declaredBackendIds.length === 1
                ? declaredBackendIds[0] ?? null
                : null;
    if (!backendId) return null;

    const resolved = resolveEngineRuntimeContribution(contributions, backendId);
    return resolved?.agentId === agentId ? resolved.id : null;
}

export function projectEngineRuntimeContributionFromAgent(
    agent: ResolvedAgentContribution,
    backendId: string,
): ResolvedAgentRuntimeContribution {
    const runtimeKind = readCurrentAgentRuntimeKind(agent);
    return Object.freeze({
        id: backendId,
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
