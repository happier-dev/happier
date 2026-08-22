import type { AgentRuntime } from '@happier-dev/plugin-sdk/agents/runtime';
import type {
    ResolvedAgentContribution,
    ResolvedAgentRuntimeContribution,
} from '@/plugins/projection/registry/types';
import { readAgentExecutionRunCapabilities } from '@/plugins/projection/registry/agentContributionDefinition';
import type { ResolvedExecutablePluginRuntimeRegistry } from '@/plugins/runtime/resolveExecutablePluginRuntimeRegistry';
import { buildPluginSessionBindingInput } from '@/plugins/runtime/runtimeCore/plugin/sessionLaunch';
import {
    type BackendExecutionSurfaces,
    type CliEngineAdapter,
    type CliRuntimeCore,
} from '../engineRegistryTypes';
import type {
    BackendRuntimeOwnerResolution,
} from '../engineRegistryTypes';
import type { RuntimeRegistryBackendEngineEntry } from './runtimeOwnerResolution';
import { createNativeAgentRuntimeSessionPlan } from './nativeAgentSession';
import { createNativeAgentSessionHostServiceOwners } from './nativeAgentSessionHostServiceOwners';
import { createNativeAgentExecutionRunHostRuntime } from '@/agent/runtime/bridges/executionRun/nativeAgentExecutionRun';
import { resolveAgentSessionRealtimeVoiceAuthority } from '@/agent/runtime/session/realtime/resolveAgentSessionRealtimeVoiceAuthority';
import type {
    PluginRuntimeAuthoritySnapshotV1,
} from '@/plugins/runtime/lifecycle/activation/runtimeAuthority';
import type { ExternalSessionHostOperationPortFactory } from './types';
import type {
    AgentSessionRealtimeVoiceAuthority,
} from '@/agent/runtime/session/realtime/registerAgentSessionRealtimeVoiceRpc';
import type {
    CreateAgentInvocationServices,
} from '@/plugins/runtime/invocation/services/types';
import type {
    DaemonAgentRuntimeTurnContributionsBridge,
} from '@/agent/runtime/session/process/agentRuntimeDaemonTurnContributionsBridge';
import type {
    SessionModelTransitionProviderTargetAuthorizer,
} from '@/providers/sessions/authorizeSessionModelTransitionTarget';
import { transformAgentRequestThroughPluginHooks } from '@/plugins/runtime/hooks/execution/dispatchAgentTurnHooks';

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function shouldNormalizeManifestOnlyAcpBackend(backend: ResolvedAgentRuntimeContribution): boolean {
    if (backend.runtimeKind === 'acp') {
        return true;
    }
    const richDefinition = backend.richDefinition;
    if (richDefinition?.provenance !== 'external' || !isRecord(richDefinition.definition)) {
        return false;
    }
    if (richDefinition.definition.runtimeKind === 'acp' || Object.prototype.hasOwnProperty.call(richDefinition.definition, 'acp')) {
        return true;
    }
    const engine = richDefinition.definition.engine;
    return isRecord(engine) && engine.kind === 'acp';
}

export async function resolveBackendRuntimeCore(params: Readonly<{
    backend: ResolvedAgentRuntimeContribution;
    agent: ResolvedAgentContribution;
    executionSurfaces: BackendExecutionSurfaces;
    runtimeOwner: BackendRuntimeOwnerResolution;
    engineEntry?: RuntimeRegistryBackendEngineEntry;
    runtimeRegistry: ResolvedExecutablePluginRuntimeRegistry | null;
    resolveCurrentPluginMaterializationRef?: NonNullable<
        ResolvedExecutablePluginRuntimeRegistry['resolveCurrentPluginMaterializationRef']
    >;
    resolveCurrentMediatorContributionMaterializationRef?: NonNullable<
        ResolvedExecutablePluginRuntimeRegistry['resolveCurrentMediatorContributionMaterializationRef']
    >;
    nativeAgentRuntimeVoiceAuthority?:
        AgentSessionRealtimeVoiceAuthority | null;
    happyHomeDir?: string;
    nativeAgentRuntime?: AgentRuntime | null;
    createNativeAgentRuntime?: (params: Readonly<{
        signal: AbortSignal;
    }>) => Promise<AgentRuntime>;
    prepareNativeAgentRuntimeSource?: (params: Readonly<{
        sessionId: string;
        signal: AbortSignal;
    }>) => Promise<void>;
    prepareNativeManagedProviderBinding?: NonNullable<
        import('./types').RunnerAgentSessionRuntimeSource[
            'prepareManagedProviderBinding'
        ]
    >;
    createNativeAgentInvocationServices?: CreateAgentInvocationServices;
    authorizeNativeAgentNewTurn?: NonNullable<
        import('./types').RunnerAgentSessionRuntimeSource[
            'authorizeNewTurn'
        ]
    >;
    retireNativeAgentRuntimeSource?: () => Promise<void>;
    attestNativeAgentSessionOpen?: NonNullable<
        import('./types').RunnerAgentSessionRuntimeSource[
            'attestSessionOpen'
        ]
    >;
    daemonTurnContributionsBridge?:
        DaemonAgentRuntimeTurnContributionsBridge;
    daemonModelTransitionAuthorizer?:
        SessionModelTransitionProviderTargetAuthorizer;
    externalSessionHostOperations?: ExternalSessionHostOperationPortFactory | null;
    managedServiceEndpointReadPort?: NonNullable<
        import('./types').RunnerAgentSessionRuntimeSource[
            'managedServiceEndpointReadPort'
        ]
    >;
    managedServicesCustodyPort?: NonNullable<
        import('./types').RunnerAgentSessionRuntimeSource[
            'managedServicesCustodyPort'
        ]
    >;
    nativeAgentRuntimeIdentity?: Readonly<{
        pluginId: string;
        pluginVersion: string;
        agentId: string;
        generation: string;
        immutableGenerationId?: string | null;
        runtimeAuthority?: PluginRuntimeAuthoritySnapshotV1;
        retirementSignal?: AbortSignal;
        isCurrent(): boolean;
    }>;
}>): Promise<CliEngineAdapter | null> {
    const selectedOwnerKind = params.runtimeOwner.selected?.kind ?? null;
    if (!selectedOwnerKind) {
        return null;
    }
    const resolveCurrentPluginMaterializationRef =
        params.resolveCurrentPluginMaterializationRef
        ?? params.runtimeRegistry?.resolveCurrentPluginMaterializationRef;
    const resolveCurrentMediatorContributionMaterializationRef =
        params.resolveCurrentMediatorContributionMaterializationRef
        ?? params.runtimeRegistry?.resolveCurrentMediatorContributionMaterializationRef;

    if (selectedOwnerKind === 'plugin_engine') {
        const runtimeRegistry = params.runtimeRegistry;
        const engineEntry = params.engineEntry;
        if ((runtimeRegistry && engineEntry)
            || (
                (params.nativeAgentRuntime || params.createNativeAgentRuntime)
                && params.nativeAgentRuntimeIdentity
            )) {
            const nativeAgentRuntime = params.nativeAgentRuntime ?? null;
            if (nativeAgentRuntime || params.createNativeAgentRuntime) {
                const nativeIdentity = params.nativeAgentRuntimeIdentity ?? engineEntry;
                if (!nativeIdentity) {
                    throw new Error('Native Agent runtime identity is unavailable');
                }
                const agentRetirementSignal =
                    nativeIdentity.retirementSignal
                    ?? engineEntry?.retirementSignal;
                const agentSessionRealtimeVoiceAuthority =
                    params.nativeAgentRuntimeVoiceAuthority
                    ?? resolveAgentSessionRealtimeVoiceAuthority({
                        runtimeRegistry: params.runtimeRegistry,
                        policyAgentRef: params.agent.identity ?? null,
                        agentRuntimeIdentity: nativeIdentity,
                        ...(agentRetirementSignal
                            ? { agentRetirementSignal }
                            : {}),
                    });
                const runtimeCore: CliRuntimeCore = Object.freeze({
                    async createSessionRuntime(sessionParams: unknown) {
                        const plan =
                            await createNativeAgentRuntimeSessionPlan({
                            ...(params.createNativeAgentRuntime
                                ? {
                                    createRuntime:
                                        params.createNativeAgentRuntime,
                                }
                                : { runtime: nativeAgentRuntime! }),
                            identity: nativeIdentity,
                            ...(resolveCurrentPluginMaterializationRef
                                ? {
                                    resolveCallerMaterialization: () => (
                                        resolveCurrentPluginMaterializationRef(
                                            nativeIdentity.pluginId,
                                        )
                                    ),
                                }
                                : {}),
                            ...(resolveCurrentPluginMaterializationRef
                                ? {
                                    isMediatorPluginCurrent: (pluginId: string) => (
                                        resolveCurrentPluginMaterializationRef(pluginId) !== null
                                    ),
                                }
                                : {}),
                            ...(resolveCurrentMediatorContributionMaterializationRef
                                ? {
                                    isMediatorContributionCurrent: (mediator: Readonly<{
                                        pluginId: string;
                                        contributionLocalId: string;
                                    }>) => (
                                        resolveCurrentMediatorContributionMaterializationRef(mediator) !== null
                                    ),
                                }
                                : {}),
                            ...(params.prepareNativeAgentRuntimeSource
                                ? {
                                    prepareRuntimeSource:
                                        params.prepareNativeAgentRuntimeSource,
                                }
                                : {}),
                            backend: params.backend,
                            agent: params.agent,
                            executionSurfaces: params.executionSurfaces,
                            externalSessionHostOperations:
                                params.externalSessionHostOperations,
                            managedServiceEndpointReadPort:
                                params.managedServiceEndpointReadPort,
                            managedServicesCustodyPort:
                                params.managedServicesCustodyPort,
                            ...(params.prepareNativeManagedProviderBinding
                                ? {
                                    prepareManagedProviderBinding:
                                        params.prepareNativeManagedProviderBinding,
                                }
                                : {}),
                            ...(runtimeRegistry?.publishHostEvent
                                ? { publishHostEvent: runtimeRegistry.publishHostEvent }
                                : {}),
                            createSessionHostServiceOwners: ({
                                hostRuntimeParams,
                                sessionId,
                                directory,
                                signal,
                            }) => createNativeAgentSessionHostServiceOwners({
                                runtimeRegistry,
                                identity: nativeIdentity,
                                backend: params.backend,
                                agent: params.agent,
                                hostRuntimeParams,
                                sessionId,
                                directory,
                                signal,
                                ...(params.nativeAgentRuntimeIdentity
                                    ?.runtimeAuthority
                                    ? {
                                        runtimeAuthority:
                                            params.nativeAgentRuntimeIdentity
                                                .runtimeAuthority,
                                    }
                                    : {}),
                                ...(params.happyHomeDir
                                    ? { happyHomeDir: params.happyHomeDir }
                                    : {}),
                            }),
                            ...(
                                params.createNativeAgentInvocationServices
                                ? {
                                    createInvocationServices: ({
                                        correlationId,
                                        cwd,
                                        environment,
                                        providerBindingActive,
                                        signal,
                                        session,
                                        readActiveTurnAdmissionWitness,
                                    }) =>
                                        params
                                            .createNativeAgentInvocationServices!({
                                                pluginId:
                                                    nativeIdentity.pluginId,
                                                pluginVersion:
                                                    nativeIdentity
                                                        .pluginVersion,
                                                agentId:
                                                    nativeIdentity.agentId,
                                                generation:
                                                    nativeIdentity.generation,
                                                correlationId,
                                                cwd,
                                                environment,
                                                providerBindingActive,
                                                signal,
                                                session,
                                                readActiveTurnAdmissionWitness,
                                                isGenerationCurrent:
                                                    nativeIdentity.isCurrent,
                                            }),
                                }
                                : runtimeRegistry?.createAgentInvocationServices
                                    && engineEntry
                                ? {
                                createInvocationServices: ({ correlationId, cwd, environment, providerBindingActive, signal, session, readActiveTurnAdmissionWitness }) => (
                                    runtimeRegistry.createAgentInvocationServices!({
                                        pluginId: engineEntry.pluginId,
                                        pluginVersion: engineEntry.pluginVersion,
                                        agentId: engineEntry.agentId,
                                        generation: engineEntry.generation,
                                        correlationId,
                                        cwd,
                                        environment,
                                        providerBindingActive,
                                        signal,
                                        session,
                                        readActiveTurnAdmissionWitness,
                                        isGenerationCurrent: engineEntry.isCurrent,
                                    })
                                ),
                            }
                                : {}),
                            ...(agentRetirementSignal
                                ? { generationSignal: agentRetirementSignal }
                                : {}),
                            ...(agentSessionRealtimeVoiceAuthority
                                ? { agentSessionRealtimeVoiceAuthority }
                                : {}),
                            ...(params.authorizeNativeAgentNewTurn
                                ? {
                                    authorizeNewTurn:
                                        params.authorizeNativeAgentNewTurn,
                                }
                                : {}),
                            ...(params.retireNativeAgentRuntimeSource
                                ? {
                                    retireRuntimeSource:
                                        params
                                            .retireNativeAgentRuntimeSource,
                                }
                                : {}),
                            ...(params.attestNativeAgentSessionOpen
                                ? {
                                    attestSessionOpen:
                                        params
                                            .attestNativeAgentSessionOpen,
                                }
                                : {}),
                            transformAgentRequest: params.daemonTurnContributionsBridge
                                ? async (transformParams) =>
                                    await params.daemonTurnContributionsBridge!
                                        .transformAgentRequest(transformParams)
                                : async (transformParams) =>
                                    await transformAgentRequestThroughPluginHooks(
                                        transformParams.payload,
                                        transformParams.signal
                                            ? { signal: transformParams.signal }
                                            : undefined,
                                    ),
                            sessionInput: buildPluginSessionBindingInput(sessionParams),
                        });
                        if (
                            !params.daemonTurnContributionsBridge
                            && !params.daemonModelTransitionAuthorizer
                        ) return plan;
                        return {
                            ...plan,
                            deps: {
                                ...plan.deps,
                                ...(params.daemonModelTransitionAuthorizer
                                    ? {
                                        daemonModelTransitionAuthorizer:
                                            params
                                                .daemonModelTransitionAuthorizer,
                                    }
                                    : {}),
                                sessionLoopLifecycleDeps: {
                                    ...plan.deps
                                        ?.sessionLoopLifecycleDeps,
                                    ...(params.daemonTurnContributionsBridge
                                        ? {
                                            daemonTurnContributionsBridge:
                                                params
                                                    .daemonTurnContributionsBridge,
                                        }
                                        : {}),
                                },
                            },
                        };
                    },
                    createExecutionRunBackend(options) {
                        if (!engineEntry || !runtimeRegistry) {
                            throw new Error('Runner Agent session runtime does not own execution runs');
                        }
                        if (!nativeAgentRuntime) {
                            throw new Error(
                                'Daemon execution-run runtime is unavailable',
                            );
                        }
                        const openCapabilities = readAgentExecutionRunCapabilities(
                            params.agent.richDefinition?.definition,
                        )?.open;
                        const runId = options.runId?.trim();
                        const services = runId && runtimeRegistry.createAgentInvocationServices
                            ? runtimeRegistry.createAgentInvocationServices({
                                pluginId: engineEntry.pluginId,
                                pluginVersion: engineEntry.pluginVersion,
                                agentId: engineEntry.agentId,
                                generation: engineEntry.generation,
                                correlationId: runId,
                                cwd: options.cwd,
                                ...(options.isolation?.env ? { environment: options.isolation.env } : {}),
                                signal: engineEntry.retirementSignal,
                                isGenerationCurrent: engineEntry.isCurrent,
                            })
                            : undefined;
                        return createNativeAgentExecutionRunHostRuntime({
                            runtime: nativeAgentRuntime,
                            lease: engineEntry,
                            options,
                            supportsResume: openCapabilities?.includes('resume') === true,
                            generationSignal: engineEntry.retirementSignal,
                            ...(services ? { services } : {}),
                        });
                    },
                });
                return { runtimeCore };
            }
        }

        return null;
    }
    return null;
}
