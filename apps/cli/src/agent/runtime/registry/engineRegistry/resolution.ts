import type { PluginContextV1, RegisterAgentRuntimeV1 } from '@happier-dev/plugin-sdk';
import type {
    ResolvedAgentContribution,
    ResolvedAgentRuntimeContribution,
    ResolvedContributionRegistry,
} from '@/plugins/projection/registry/types';
import type { ResolvedExecutablePluginRuntimeRegistry } from '@/plugins/runtime/resolveExecutablePluginRuntimeRegistry';
import { createMissingCliEngineAdapter } from '../createCliRuntimeCore';
import {
    collectEngineImplementedBackendSurfaceOperations,
    mergeBackendExecutionSurfaces,
    resolveBackendExecutionSurfacesFromEngine,
} from '../backendEngineSurfaceBindings';
import { resolvePluginBackendSurfaceHandlers } from '../resolvePluginBackendSurfaceHandlers';
import {
    createEmptyBackendExecutionSurfaces,
    type EngineAdapterResolution,
    type EngineResolutionDiagnostic,
} from '../engineRegistryTypes';
import {
    createEmptyBackendRuntimeOwnerResolution,
    resolveBackendRuntimeOwner,
} from './runtimeOwnerResolution';
import {
    readRuntimeRegistryBackendEngineEntry,
    resolveCatalogExecutionSurfacesForFirstPartyBackend,
    resolveContributionRuntimeCoreGetter,
    toEngineSelectedSource,
} from './contributions';
import { createEngineSurfaceContextResolvers } from './surfaceContext';
import {
    resolveBackendRuntimeCore,
    shouldNormalizeManifestOnlyAcpBackend,
} from './runtimeCore';

export function resolveFirstPartyCatalogEntryForBackend(params: Readonly<{
    backend: ResolvedAgentRuntimeContribution;
    contributions: ResolvedContributionRegistry;
}>) {
    if (params.backend.provenance !== 'first_party') {
        return null;
    }
    return params.contributions.catalogEntriesById[params.backend.agentId] ?? null;
}

function createMissingProviderContribution(params: Readonly<{
    backend: ResolvedAgentRuntimeContribution;
}>): ResolvedAgentContribution {
    return {
        id: params.backend.agentId,
        provenance: params.backend.provenance,
        source: params.backend.source,
        definition: {
            kindVersion: 1,
            id: params.backend.agentId,
            ownedBackendIds: Object.freeze([]),
        },
    };
}

export async function resolveEngineAdapterResolutionFromRegistry(params: Readonly<{
    backendId: string;
    contributions: ResolvedContributionRegistry;
    runtimeRegistry: ResolvedExecutablePluginRuntimeRegistry | null;
    pluginContext: PluginContextV1;
}>): Promise<EngineAdapterResolution | null> {
    const backend = params.contributions.agentRuntimeDefinitionsById.get(params.backendId);
    if (!backend) {
        return null;
    }

    const provider = params.contributions.agentDefinitionsById.get(backend.agentId);
    if (!provider) {
        const missingProvider = createMissingProviderContribution({ backend });
        const catalogEntry = resolveFirstPartyCatalogEntryForBackend({
            backend,
            contributions: params.contributions,
        });
        const runtimeCoreGetter = resolveContributionRuntimeCoreGetter({
            backend,
            catalogEntry,
        });
        const engineEntry = params.runtimeRegistry
            ? readRuntimeRegistryBackendEngineEntry(params.runtimeRegistry, backend.id)
            : undefined;
        const runtimeOwner = resolveBackendRuntimeOwner({
            backend,
            provider: null,
            runtimeCoreGetter,
            engineEntry,
            manifestOnlyPluginRuntime: shouldNormalizeManifestOnlyAcpBackend(backend),
        });
        const executionSurfaces = createEmptyBackendExecutionSurfaces();
        const engineAdapter = await resolveBackendRuntimeCore({
            backend,
            provider: missingProvider,
            executionSurfaces,
            runtimeCoreGetter,
            runtimeOwner,
            engineEntry,
            runtimeRegistry: params.runtimeRegistry,
            pluginContext: params.pluginContext,
        });
        return {
            backendId: backend.id,
            agentId: backend.agentId,
            provenance: backend.provenance,
            selectedSource: toEngineSelectedSource(backend.provenance, undefined),
            runtimeOwner,
            backend,
            provider: missingProvider,
            engineAdapter: engineAdapter ?? createMissingCliEngineAdapter({ backend }),
            executionSurfaces,
            diagnostics: Object.freeze([{
                code: 'engine_provider_missing',
                message: `Missing provider contribution '${backend.agentId}' for backend '${backend.id}'`,
                backendId: backend.id,
                agentId: backend.agentId,
                pluginId: backend.pluginId,
            }]),
        };
    }

    if (backend.provenance === 'first_party') {
        const entry = resolveFirstPartyCatalogEntryForBackend({
            backend,
            contributions: params.contributions,
        });
        const runtimeCoreGetter = resolveContributionRuntimeCoreGetter({
            backend,
            catalogEntry: entry ?? null,
        });
        const runtimeRegistry = params.runtimeRegistry;
        const engineEntry = runtimeRegistry
            ? readRuntimeRegistryBackendEngineEntry(runtimeRegistry, backend.id)
            : undefined;
        const runtimeOwner = resolveBackendRuntimeOwner({
            backend,
            provider,
            runtimeCoreGetter,
            engineEntry,
            manifestOnlyPluginRuntime: false,
        });
        const catalogExecutionSurfaces = await resolveCatalogExecutionSurfacesForFirstPartyBackend({
            backend,
            entry,
        });
        const canResolvePluginEngineSurfaces = Boolean(
            runtimeOwner.conflictDiagnostic
            && engineEntry?.registration
            && (backend.surfaceHandlers?.length ?? 0) > 0,
        );
        const registration = runtimeOwner.selected?.kind === 'plugin_engine' || canResolvePluginEngineSurfaces
            ? engineEntry?.registration as RegisterAgentRuntimeV1 | undefined
            : undefined;
        const pluginEngine = registration ? await registration.create(params.pluginContext) : null;
        const diagnostics: EngineResolutionDiagnostic[] = runtimeOwner.conflictDiagnostic
            ? [runtimeOwner.conflictDiagnostic]
            : [];
        const engineSurfaces = pluginEngine
            ? resolveBackendExecutionSurfacesFromEngine({
                backend,
                engine: pluginEngine,
                diagnostics,
                ...createEngineSurfaceContextResolvers(params.pluginContext, {
                    contributions: params.contributions,
                }),
            })
            : createEmptyBackendExecutionSurfaces();
        const executionSurfaces = mergeBackendExecutionSurfaces(catalogExecutionSurfaces, engineSurfaces);
        const engineAdapter = runtimeOwner.conflictDiagnostic
            ? null
            : await resolveBackendRuntimeCore({
                backend,
                provider,
                executionSurfaces,
                runtimeCoreGetter,
                runtimeOwner,
                engineEntry,
                runtimeRegistry: params.runtimeRegistry,
                pluginContext: params.pluginContext,
                pluginEngine,
            });
        return {
            backendId: backend.id,
            agentId: provider.id,
            provenance: backend.provenance,
            selectedSource: runtimeOwner.selected?.kind === 'plugin_engine'
                ? 'plugin'
                : toEngineSelectedSource(
                    backend.provenance,
                    provider.runtimeSpec?.sourcePreferenceDefault,
                ),
            runtimeOwner,
            backend,
            provider,
            engineAdapter: engineAdapter ?? createMissingCliEngineAdapter({ backend }),
            executionSurfaces,
            diagnostics: Object.freeze(diagnostics),
        };
    }

    const runtimeRegistry = params.runtimeRegistry;
    if (!runtimeRegistry) {
        return {
            backendId: backend.id,
            agentId: provider.id,
            provenance: backend.provenance,
            selectedSource: 'plugin',
            runtimeOwner: createEmptyBackendRuntimeOwnerResolution(backend.id),
            backend,
            provider,
            engineAdapter: createMissingCliEngineAdapter({ backend }),
            executionSurfaces: createEmptyBackendExecutionSurfaces(),
            diagnostics: Object.freeze([{
                code: 'engine_backend_missing',
                message: `No executable runtime registry available for plugin backend '${backend.id}'`,
                backendId: backend.id,
                agentId: provider.id,
                pluginId: backend.pluginId,
            }]),
        };
    }

    const engineEntry = readRuntimeRegistryBackendEngineEntry(runtimeRegistry, backend.id);
    const runtimeCoreGetter = resolveContributionRuntimeCoreGetter({
        backend,
        catalogEntry: null,
    });
    const runtimeOwner = resolveBackendRuntimeOwner({
        backend,
        provider,
        runtimeCoreGetter,
        engineEntry,
        manifestOnlyPluginRuntime: shouldNormalizeManifestOnlyAcpBackend(backend),
    });
    const registration = runtimeOwner.selected?.kind === 'plugin_engine'
        ? engineEntry?.registration as RegisterAgentRuntimeV1 | undefined
        : undefined;
    const pluginEngine = registration ? await registration.create(params.pluginContext) : null;
    const engineImplementedBackendSurfaceOperations = pluginEngine
        ? collectEngineImplementedBackendSurfaceOperations(pluginEngine)
        : undefined;
    const engineSurfaceContextResolvers = createEngineSurfaceContextResolvers(params.pluginContext, {
        contributions: params.contributions,
    });
    const pluginResolution = await resolvePluginBackendSurfaceHandlers({
        backend,
        provider,
        runtimeRegistry,
        engineImplementedBackendSurfaceOperations,
        ...engineSurfaceContextResolvers,
    });
    const diagnostics = [...pluginResolution.diagnostics];
    const engineSurfaces = pluginEngine
        ? resolveBackendExecutionSurfacesFromEngine({
            backend,
            engine: pluginEngine,
            diagnostics,
            ...engineSurfaceContextResolvers,
        })
        : createEmptyBackendExecutionSurfaces();
    const executionSurfaces = mergeBackendExecutionSurfaces(pluginResolution.surfaces, engineSurfaces);
    const engineAdapter = await resolveBackendRuntimeCore({
        backend,
        provider,
        executionSurfaces,
        runtimeCoreGetter,
        runtimeOwner,
        engineEntry,
        runtimeRegistry,
        pluginContext: params.pluginContext,
        pluginEngine,
    });
    return {
        backendId: backend.id,
        agentId: provider.id,
        provenance: backend.provenance,
        selectedSource: 'plugin',
        runtimeOwner,
        backend,
        provider,
        engineAdapter: engineAdapter ?? createMissingCliEngineAdapter({ backend }),
        executionSurfaces,
        diagnostics: Object.freeze(diagnostics),
    };
}
