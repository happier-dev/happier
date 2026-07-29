import type {
    ResolvedAgentContribution,
    ResolvedAgentRuntimeContribution,
    ResolvedContributionRegistry,
} from '@/plugins/projection/registry/types';
import type { ResolvedExecutablePluginRuntimeRegistry } from '@/plugins/runtime/resolveExecutablePluginRuntimeRegistry';
import { createMissingCliEngineAdapter } from '../createCliRuntimeCore';
import {
    mergeBackendExecutionSurfaces,
    resolveBackendExecutionSurfacesFromNativeAgentRuntime,
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
    resolveEngineRuntimeContribution,
    resolveCatalogExecutionSurfacesForFirstPartyBackend,
    toEngineSelectedSource,
} from './contributions';
import {
    resolveBackendRuntimeCore,
    shouldNormalizeManifestOnlyAcpBackend,
} from './runtimeCore';
import { resolveLeasedAgentRuntime } from './agentRuntimeLease';
import { createAgentExternalSessionsExecutionSurface } from '../agentExternalSessionsExecutionSurface';
import type { ResolveEngineRegistryParams } from './types';

function resolveDeclaredAgentSurfaceFamilies(
    agent: ResolvedAgentContribution,
): ReadonlySet<'terminalRuntime'> {
    const definition = agent.richDefinition?.definition;
    if (!definition || typeof definition !== 'object' || Array.isArray(definition)) return new Set();
    const capabilities = Reflect.get(definition, 'capabilities');
    if (!capabilities || typeof capabilities !== 'object' || Array.isArray(capabilities)) return new Set();
    const surfaces = Reflect.get(capabilities, 'surfaces');
    if (!Array.isArray(surfaces)) return new Set();
    const families = new Set<'terminalRuntime'>();
    if (surfaces.includes('terminal')) families.add('terminalRuntime');
    return families;
}

export function resolveFirstPartyCatalogEntryForBackend(params: Readonly<{
    backend: ResolvedAgentRuntimeContribution;
    contributions: ResolvedContributionRegistry;
}>) {
    if (params.backend.provenance !== 'first_party') {
        return null;
    }
    return params.contributions.catalogEntriesById[params.backend.agentId] ?? null;
}

function resolveRegisteredAgentAuxiliarySurfaces(
    engineEntry: Readonly<{
        pluginId: string;
        generation: string;
        retirementSignal: AbortSignal;
        isCurrent(): boolean;
        externalSessions?: Parameters<typeof createAgentExternalSessionsExecutionSurface>[0];
    }> | undefined,
    agent: ResolvedAgentContribution,
) {
    const surfaces = createEmptyBackendExecutionSurfaces();
    const writerSafety = agent.richDefinition?.definition
        .surfaces?.externalSession.externalLinkedTakeover?.writerSafety
        ?? 'unsupported';
    return engineEntry?.externalSessions
        ? {
            ...surfaces,
            externalSession: createAgentExternalSessionsExecutionSurface(
                engineEntry.externalSessions,
                writerSafety,
            ),
        }
        : surfaces;
}

export async function resolveEngineAdapterResolutionFromRegistry(params: Readonly<{
    backendId: string;
    contributions: ResolvedContributionRegistry;
    runtimeRegistry: ResolvedExecutablePluginRuntimeRegistry | null;
    happyHomeDir?: string;
    nativeAgentRuntimeCarrier?: ResolveEngineRegistryParams['nativeAgentRuntimeCarrier'];
}>): Promise<EngineAdapterResolution | null> {
    const backend = resolveEngineRuntimeContribution(params.contributions, params.backendId);
    if (!backend) {
        return null;
    }

    const agent = params.contributions.agentDefinitionsById.get(backend.agentId);
    if (!agent) return null;

    if (backend.provenance === 'first_party') {
        const entry = resolveFirstPartyCatalogEntryForBackend({
            backend,
            contributions: params.contributions,
        });
        const runtimeRegistry = params.runtimeRegistry;
        const engineEntry = runtimeRegistry
            ? readRuntimeRegistryBackendEngineEntry(runtimeRegistry, backend)
            : undefined;
        const runtimeOwner = resolveBackendRuntimeOwner({
            backend,
            agent,
            engineEntry,
            manifestOnlyPluginRuntime: false,
            nativeAgentRuntimeCarrier:
                params.nativeAgentRuntimeCarrier?.descriptor.backendId === backend.id,
        });
        const catalogExecutionSurfaces = await resolveCatalogExecutionSurfacesForFirstPartyBackend({
            backend,
            entry,
        });
        const carriedRuntime = params.nativeAgentRuntimeCarrier?.descriptor.backendId === backend.id
            ? params.nativeAgentRuntimeCarrier.runtime
            : null;
        const leasedRuntime = carriedRuntime ?? (runtimeOwner.selected?.kind === 'plugin_engine'
            && engineEntry
            ? await resolveLeasedAgentRuntime({ lease: engineEntry })
            : null);
        const diagnostics: EngineResolutionDiagnostic[] = [];
        const declaredAgentSurfaceFamilies = resolveDeclaredAgentSurfaceFamilies(agent);
        const engineSurfaces = leasedRuntime
            ? resolveBackendExecutionSurfacesFromNativeAgentRuntime({
                backend,
                runtime: leasedRuntime,
                agentId: carriedRuntime
                    ? params.nativeAgentRuntimeCarrier!.descriptor.agentId
                    : engineEntry!.agentId,
                isCurrent: carriedRuntime
                    ? params.nativeAgentRuntimeCarrier!.isCurrent
                    : engineEntry!.isCurrent,
                declaredAgentSurfaceFamilies,
                diagnostics,
            })
            : createEmptyBackendExecutionSurfaces();
        const combinedExecutionSurfaces = mergeBackendExecutionSurfaces(
            catalogExecutionSurfaces,
            engineSurfaces,
        );
        const registeredAgentSurfaces = resolveRegisteredAgentAuxiliarySurfaces(
            engineEntry,
            agent,
        );
        const executionSurfaces = {
            ...combinedExecutionSurfaces,
            externalSession: registeredAgentSurfaces.externalSession,
        };
        const engineAdapter = await resolveBackendRuntimeCore({
                backend,
                agent,
                executionSurfaces,
                runtimeOwner,
                engineEntry,
                runtimeRegistry: params.runtimeRegistry,
                nativeAgentRuntimeVoiceAuthority:
                    params.nativeAgentRuntimeCarrier?.descriptor.backendId
                        === backend.id
                        ? params.nativeAgentRuntimeCarrier
                            .agentSessionRealtimeVoiceAuthority
                        : null,
                ...(params.happyHomeDir ? { happyHomeDir: params.happyHomeDir } : {}),
                nativeAgentRuntime: leasedRuntime,
                externalSessionHostOperations:
                    params.nativeAgentRuntimeCarrier?.descriptor.backendId
                        === backend.id
                        ? params.nativeAgentRuntimeCarrier
                            .externalSessionHostOperations
                        : null,
                nativeAgentRuntimeIdentity: params.nativeAgentRuntimeCarrier?.descriptor.backendId === backend.id
                    ? {
                        ...params.nativeAgentRuntimeCarrier.descriptor,
                        ...(params.nativeAgentRuntimeCarrier.retirementSignal
                            ? {
                                retirementSignal:
                                  params.nativeAgentRuntimeCarrier
                                    .retirementSignal,
                              }
                            : {}),
                        isCurrent: params.nativeAgentRuntimeCarrier.isCurrent,
                    }
                    : undefined,
            });
        return {
            backendId: backend.id,
            agentId: agent.id,
            provenance: backend.provenance,
            selectedSource: runtimeOwner.selected?.kind === 'plugin_engine'
                ? 'plugin'
                : toEngineSelectedSource(
                    backend.provenance,
                    agent.runtimeSpec?.sourcePreferenceDefault,
                ),
            runtimeOwner,
            backend,
            agent,
            engineAdapter: engineAdapter ?? createMissingCliEngineAdapter({ backend }),
            executionSurfaces,
            diagnostics: Object.freeze(diagnostics),
        };
    }

    const runtimeRegistry = params.runtimeRegistry;
    if (!runtimeRegistry) {
        return {
            backendId: backend.id,
            agentId: agent.id,
            provenance: backend.provenance,
            selectedSource: 'plugin',
            runtimeOwner: createEmptyBackendRuntimeOwnerResolution(backend.id),
            backend,
            agent,
            engineAdapter: createMissingCliEngineAdapter({ backend }),
            executionSurfaces: createEmptyBackendExecutionSurfaces(),
            diagnostics: Object.freeze([{
                code: 'engine_backend_missing',
                message: `No executable runtime registry available for plugin backend '${backend.id}'`,
                backendId: backend.id,
                agentId: agent.id,
                pluginId: backend.pluginId,
            }]),
        };
    }

    const engineEntry = readRuntimeRegistryBackendEngineEntry(runtimeRegistry, backend);
    const runtimeOwner = resolveBackendRuntimeOwner({
        backend,
        agent,
        engineEntry,
        manifestOnlyPluginRuntime: shouldNormalizeManifestOnlyAcpBackend(backend),
    });
    const leasedRuntime = runtimeOwner.selected?.kind === 'plugin_engine' && engineEntry
        ? await resolveLeasedAgentRuntime({ lease: engineEntry })
        : null;
    const pluginRuntimeDiagnostics = await resolvePluginBackendSurfaceHandlers({
        backend,
        agent,
        runtimeRegistry,
        hasRegisteredAgentRuntime: engineEntry?.hasPrimaryRuntime === true,
    });
    const diagnostics = [...pluginRuntimeDiagnostics.diagnostics];
    const declaredAgentSurfaceFamilies = resolveDeclaredAgentSurfaceFamilies(agent);
    const engineSurfaces = leasedRuntime
        ? resolveBackendExecutionSurfacesFromNativeAgentRuntime({
            backend,
            runtime: leasedRuntime,
            agentId: engineEntry!.agentId,
            isCurrent: engineEntry!.isCurrent,
            declaredAgentSurfaceFamilies,
            diagnostics,
        })
        : createEmptyBackendExecutionSurfaces();
    const registeredAgentSurfaces = resolveRegisteredAgentAuxiliarySurfaces(
        engineEntry,
        agent,
    );
    const executionSurfaces = {
        ...engineSurfaces,
        externalSession: registeredAgentSurfaces.externalSession,
    };
    const engineAdapter = await resolveBackendRuntimeCore({
        backend,
        agent,
        executionSurfaces,
        runtimeOwner,
        engineEntry,
        runtimeRegistry,
        ...(params.happyHomeDir ? { happyHomeDir: params.happyHomeDir } : {}),
        nativeAgentRuntime: leasedRuntime,
    });
    return {
        backendId: backend.id,
        agentId: agent.id,
        provenance: backend.provenance,
        selectedSource: 'plugin',
        runtimeOwner,
        backend,
        agent,
        engineAdapter: engineAdapter ?? createMissingCliEngineAdapter({ backend }),
        executionSurfaces,
        diagnostics: Object.freeze(diagnostics),
    };
}
