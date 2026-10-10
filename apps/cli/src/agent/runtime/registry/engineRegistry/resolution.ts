import type {
    ResolvedAgentContribution,
    ResolvedAgentRuntimeContribution,
    ResolvedContributionRegistry,
} from '@/plugins/projection/registry/types';
import type { ResolvedExecutablePluginRuntimeRegistry } from '@/plugins/runtime/resolveExecutablePluginRuntimeRegistry';
import { createMissingCliEngineAdapter } from '../createCliRuntimeCore';
import {
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
    projectEngineRuntimeContributionFromAgent,
    resolveEngineRuntimeContribution,
    toEngineSelectedSource,
} from './contributions';
import { resolveLeasedAgentRuntime } from './agentRuntimeLease';
import { resolveAccountConfiguredAcpLaunchForAgent } from './accountConfiguredAcp';
import { buildQualifiedPluginContributionKey } from '@happier-dev/protocol/plugins/contribution-identity';
import { createAgentExternalSessionsExecutionSurface } from '../agentExternalSessionsExecutionSurface';
import type { ExternalSessionExecutionSurface } from '@/session/external/providerOps';
import type {
    ResolveEngineRegistryParams,
} from './types';

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

function declaresAgentExternalSessionSurface(
    agent: ResolvedAgentContribution,
): boolean {
    const capabilities =
        agent.richDefinition?.definition.capabilities;
    return capabilities?.surfaces?.includes(
        'externalSessions',
    ) === true
        && agent.richDefinition?.definition.surfaces
            ?.externalSession !== undefined;
}

function resolveRegisteredAgentAuxiliarySurfaces(
    engineEntry: Readonly<{
        pluginId: string;
        occurrenceId: string;
        retirementSignal: AbortSignal;
        isCurrent(): boolean;
        externalSessions?: Parameters<typeof createAgentExternalSessionsExecutionSurface>[0];
    }> | undefined,
    agent: ResolvedAgentContribution,
    /**
     * A retained runner composes External Sessions from the exact immutable
     * generation that admitted its Session, never from the daemon's current
     * generation. The daemon itself has no runner source and keeps composing
     * from its own current registry entry below.
     */
    runnerRetainedExternalSession:
        ExternalSessionExecutionSurface | null | undefined,
) {
    const surfaces = createEmptyBackendExecutionSurfaces();
    const writerSafety = agent.richDefinition?.definition
        .surfaces?.externalSession.externalLinkedTakeover?.writerSafety
        ?? 'unsupported';
    return (
        runnerRetainedExternalSession
        && declaresAgentExternalSessionSurface(agent)
    )
        ? {
            ...surfaces,
            externalSession: runnerRetainedExternalSession,
        }
        : engineEntry?.externalSessions
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
    agentTarget?: ResolveEngineRegistryParams['agentTarget'];
    startupRuntimeDescriptorV1?: ResolveEngineRegistryParams['startupRuntimeDescriptorV1'];
    savedSecretOperationContext?: ResolveEngineRegistryParams['savedSecretOperationContext'];
    contributions: ResolvedContributionRegistry;
    runtimeRegistry: ResolvedExecutablePluginRuntimeRegistry | null;
    resolveCurrentPluginMaterializationRef?: NonNullable<
        ResolvedExecutablePluginRuntimeRegistry['resolveCurrentPluginMaterializationRef']
    >;
    resolveCurrentMediatorContributionMaterializationRef?: NonNullable<
        ResolvedExecutablePluginRuntimeRegistry['resolveCurrentMediatorContributionMaterializationRef']
    >;
    happyHomeDir?: string;
    runnerAgentSessionRuntimeSource?:
        ResolveEngineRegistryParams['runnerAgentSessionRuntimeSource'];
    prepareTeamCredentialProviderBinding?:
        ResolveEngineRegistryParams['prepareTeamCredentialProviderBinding'];
}>): Promise<EngineAdapterResolution | null> {
    const matchingRunnerSource =
        params.runnerAgentSessionRuntimeSource?.identity.backendId
                === params.backendId
            ? params.runnerAgentSessionRuntimeSource
            : null;
    const backend = matchingRunnerSource
        ? projectEngineRuntimeContributionFromAgent(
            matchingRunnerSource.agentContribution,
            params.backendId,
        )
        : resolveEngineRuntimeContribution(
            params.contributions,
            params.backendId,
        );
    if (!backend) {
        return null;
    }

    const resolveCurrentPluginMaterializationRef =
        params.resolveCurrentPluginMaterializationRef
        ?? params.runtimeRegistry?.resolveCurrentPluginMaterializationRef;
    const resolveCurrentMediatorContributionMaterializationRef =
        params.resolveCurrentMediatorContributionMaterializationRef
        ?? params.runtimeRegistry?.resolveCurrentMediatorContributionMaterializationRef;

    const agent = matchingRunnerSource?.agentContribution
        ?? params.contributions.agentDefinitionsById.get(backend.agentId);
    if (!agent) return null;
    if (params.agentTarget && (!agent.identity || buildQualifiedPluginContributionKey(agent.identity) !== buildQualifiedPluginContributionKey(params.agentTarget.identity))) {
        throw Object.assign(new Error('Selected Agent target does not match its contributed runtime'), { code: 'AGENT_TARGET_CONTRIBUTION_MISMATCH' });
    }
    const runnerRuntimeSource =
        matchingRunnerSource;
    const startupRuntimeDescriptorV1 = runnerRuntimeSource?.startupRuntimeDescriptorV1
        ?? params.startupRuntimeDescriptorV1;
    // A Session runner never co-locates the daemon/machine execution runtime.
    // Combined Agents resolve that bounded lifecycle separately without the
    // runner source, preserving one runtime owner per process lifetime.
    const shouldLeaseDaemonRuntime = !runnerRuntimeSource;
    const runnerRuntimeCoreParams = runnerRuntimeSource
        ? {
            startupRuntimeDescriptorV1: runnerRuntimeSource.startupRuntimeDescriptorV1,
            nativeAgentRuntimeVoiceAuthority:
                runnerRuntimeSource.agentSessionRealtimeVoiceAuthority,
            createNativeAgentRuntime:
                runnerRuntimeSource.createRuntime,
            prepareNativeAgentRuntimeSource:
                runnerRuntimeSource.prepareForSession,
            prepareNativeManagedProviderBinding:
                runnerRuntimeSource.prepareManagedProviderBinding,
            prepareNativeTeamCredentialProviderBinding:
                runnerRuntimeSource.prepareTeamCredentialProviderBinding,
            managedProviderRunServices: runnerRuntimeSource.managedProviderRunServices,
            createNativeAgentInvocationServices:
                runnerRuntimeSource.createInvocationServices,
            authorizeNativeAgentNewTurn:
                runnerRuntimeSource.authorizeNewTurn,
            retireNativeAgentRuntimeSource:
                runnerRuntimeSource.retire,
            attestNativeAgentSessionOpen:
                runnerRuntimeSource.attestSessionOpen,
            daemonTurnContributionsBridge:
                runnerRuntimeSource.daemonTurnContributionsBridge,
            daemonModelTransitionAuthorizer:
                runnerRuntimeSource.daemonModelTransitionAuthorizer,
            externalSessionHostOperations:
                runnerRuntimeSource.externalSessionHostOperations,
            resolveProviderCliAttachManagedServiceAccess:
                runnerRuntimeSource.resolveProviderCliAttachManagedServiceAccess,
            ...(runnerRuntimeSource.managedServiceEndpointReadPort
                ? {
                    managedServiceEndpointReadPort:
                        runnerRuntimeSource.managedServiceEndpointReadPort,
                }
                : {}),
            ...(runnerRuntimeSource.managedServicesCustodyPort
                ? {
                    managedServicesCustodyPort:
                        runnerRuntimeSource.managedServicesCustodyPort,
                }
                : {}),
            nativeAgentRuntimeIdentity:
                runnerRuntimeSource.identity,
        }
        : params.prepareTeamCredentialProviderBinding
            ? {
                prepareNativeTeamCredentialProviderBinding:
                    params.prepareTeamCredentialProviderBinding,
            }
            : {};

    const runtimeRegistry = params.runtimeRegistry;
    if (!runtimeRegistry && !runnerRuntimeSource) {
        return {
            backendId: backend.id,
            agentId: agent.id,
            provenance: backend.provenance,
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

    const {
        resolveBackendRuntimeCore,
        shouldNormalizeManifestOnlyAcpBackend,
    } = await import('./runtimeCore');
    const engineEntry = runtimeRegistry
        ? readRuntimeRegistryBackendEngineEntry(runtimeRegistry, backend)
        : undefined;
    const entry = runtimeRegistry?.acquireAgentCatalogEntry
        ? await runtimeRegistry.acquireAgentCatalogEntry(agent.id)
        : agent.catalogEntry ?? null;
    const runtimeOwner = resolveBackendRuntimeOwner({
        backend,
        agent,
        engineEntry,
        manifestOnlyPluginRuntime: shouldNormalizeManifestOnlyAcpBackend(backend),
        runnerAgentSessionRuntimeSource: runnerRuntimeSource !== null,
    });
    const leasedRuntime = shouldLeaseDaemonRuntime
        && runtimeOwner.selected?.kind === 'plugin_engine'
        && engineEntry
        ? await resolveLeasedAgentRuntime({
            lease: engineEntry,
            ...(entry?.resolveHostAgentRuntimeSurfaces
                ? { resolveHostSurfaces: entry.resolveHostAgentRuntimeSurfaces }
                : {}),
        })
        : null;
    const pluginRuntimeDiagnostics = runtimeRegistry
        ? await resolvePluginBackendSurfaceHandlers({
            backend,
            agent,
            runtimeRegistry,
            hasRegisteredAgentRuntime: engineEntry?.hasPrimaryRuntime === true,
        })
        : { diagnostics: [] };
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
            createAgentRuntimeSurfaceInvocationContext:
                engineEntry!.createAgentRuntimeSurfaceInvocationContext,
            terminalPresentationFeatures: (await import('./nativeAgentSessionHostServiceOwners'))
                .createNativeAgentFeatureService(runtimeRegistry),
        })
        : createEmptyBackendExecutionSurfaces();
    const registeredAgentSurfaces = resolveRegisteredAgentAuxiliarySurfaces(
        engineEntry,
        agent,
        runnerRuntimeSource
            ?.retainedExternalSessionProviderOps,
    );
    const executionSurfaces = {
        ...engineSurfaces,
        externalSession: registeredAgentSurfaces.externalSession,
    };
    const configuredLaunch = agent.identity
        ? await resolveAccountConfiguredAcpLaunchForAgent({
            identity: agent.identity,
            agentTarget: params.agentTarget,
            startupRuntimeDescriptorV1,
            savedSecretOperationContext: params.savedSecretOperationContext,
        })
        : null;
    const engineAdapter = await resolveBackendRuntimeCore({
        backend,
        agent,
        executionSurfaces,
        runtimeOwner,
        engineEntry,
        runtimeRegistry,
        ...(resolveCurrentPluginMaterializationRef
            ? { resolveCurrentPluginMaterializationRef }
            : {}),
        ...(resolveCurrentMediatorContributionMaterializationRef
            ? { resolveCurrentMediatorContributionMaterializationRef }
            : {}),
        ...(params.happyHomeDir ? { happyHomeDir: params.happyHomeDir } : {}),
        nativeAgentRuntime: leasedRuntime,
        ...runnerRuntimeCoreParams,
        ...(startupRuntimeDescriptorV1 ? { startupRuntimeDescriptorV1 } : {}),
        ...(configuredLaunch ? {
            nativeAgentSessionCapabilities: configuredLaunch.sessionCapabilities,
            nativeAgentSessionProjection: configuredLaunch.sessionProjection,
            nativeAgentAcpRuntimeDefinition: configuredLaunch.runtimeDefinition,
            resolveNativeAgentAcpHostLaunch: configuredLaunch.resolveHostLaunch,
        } : {}),
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
        ...(runtimeRegistry?.publishHostEvent
            ? { publishHostEvent: runtimeRegistry.publishHostEvent }
            : {}),
    };

}
