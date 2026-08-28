import type { AgentRuntime } from '@happier-dev/plugin-sdk/agents/runtime';
import type {
    ResolvedAgentContribution,
    ResolvedAgentRuntimeContribution,
} from '@/plugins/projection/registry/types';
import { readAgentExecutionRunCapabilities, readAgentSessionCapabilities } from '@/plugins/projection/registry/agentContributionDefinition';
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
import {
    composeNativeAgentSessionRuntimeContext,
    createNativeAgentRuntimeSessionPlan,
    createNativeAgentSessionHostServices,
    resolveNativeAgentSessionNativeHomeService,
} from './nativeAgentSession';
import { createNativeAgentSessionHostServiceOwners } from './nativeAgentSessionHostServiceOwners';
import { createNativeAgentSessionPublications } from './nativeAgentSessionPublications';
import { createNativeAgentSessionWorkStateService } from './nativeAgentSessionWorkState';
import { createNativeAgentCurrentSessionUiServices } from './nativeAgentSessionInteractions';
import {
    createNativeAgentExecutionRunHostRuntime,
    createNativeAgentSessionExecutionRunHostRuntime,
    createNativeAgentSessionInteractionHostRuntime,
    type NativeAgentSessionContextLeaseFactory,
} from '@/agent/runtime/bridges/executionRun/nativeAgentExecutionRun';
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
import { createPluginInvocationPresentation } from '@/plugins/runtime/invocation/services/interactions';
import { createPublicAcpRuntimeProtocols } from '@/agent/acp/runtime/publicSession/createPublicAcpRuntimeProtocols';
import { resolveAgentToolsDelivery } from '@/agent/tools/happierTools/runtime/resolveAgentToolsDelivery';

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
                                hostSession: {
                                    session: hostRuntimeParams.session,
                                    machineId: hostRuntimeParams.machineId,
                                    ...(hostRuntimeParams.accountSettings !== undefined
                                        ? { accountSettings: hostRuntimeParams.accountSettings }
                                        : {}),
                                    permissionHandler: hostRuntimeParams.permissionHandler,
                                },
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
                        const isVoiceInteraction = options.start?.intent === 'voice_agent';
                        const sessionOpenCapabilities = readAgentSessionCapabilities(
                            params.agent.richDefinition?.definition,
                        )?.open;
                        const host = options.sessionInteractionHost;
                        // Voice and Session-derived finite Runs are non-durable projections over
                        // the parent Session's custody. They share this complete context lease;
                        // the interactive Session loop retains its richer terminal/media/resume
                        // owners while reusing the same facet builders and exhaustive composer.
                        const createSessionContext: NativeAgentSessionContextLeaseFactory | null = host
                            ? async ({ services: invocationServices, signal }) => {
                                    const sessionId = host.session.sessionId;
                                    const contributionId = engineEntry.localAgentId;
                                    const sessionOwners = createNativeAgentSessionHostServiceOwners({
                                        runtimeRegistry,
                                        identity: nativeIdentity,
                                        backend: params.backend,
                                        agent: params.agent,
                                        hostSession: {
                                            session: host.session,
                                            machineId: host.machineId,
                                            ...(options.accountSettings !== undefined
                                                ? { accountSettings: options.accountSettings }
                                                : {}),
                                            permissionHandler: host.permissionHandler,
                                        },
                                        sessionId,
                                        directory: options.cwd,
                                        signal,
                                        ...(params.nativeAgentRuntimeIdentity?.runtimeAuthority
                                            ? { runtimeAuthority: params.nativeAgentRuntimeIdentity.runtimeAuthority }
                                            : {}),
                                        ...(params.happyHomeDir
                                            ? { happyHomeDir: params.happyHomeDir }
                                            : {}),
                                    });
                                    let publications: ReturnType<typeof createNativeAgentSessionPublications> | null = null;
                                    try {
                                        publications = createNativeAgentSessionPublications({
                                            agentId: nativeIdentity.agentId,
                                            session: host.session,
                                            signal,
                                            isCurrent: nativeIdentity.isCurrent,
                                            supportsInFlightSteer: readAgentSessionCapabilities(
                                                params.agent.richDefinition?.definition,
                                            )?.delivery.includes('steer') === true,
                                        });
                                        const currentSession = createNativeAgentCurrentSessionUiServices({
                                            permissionHandler: host.permissionHandler,
                                            pluginId: nativeIdentity.pluginId,
                                            contributionId,
                                            runtimeId: `agent-session-projection:${options.runId ?? sessionId}`,
                                            sessionId,
                                            generationId: nativeIdentity.generation,
                                            isCurrent: nativeIdentity.isCurrent,
                                            signal,
                                        });
                                        const nativeHome = await resolveNativeAgentSessionNativeHomeService({
                                            agent: params.agent,
                                            sourceEnvironment: options.isolation?.env ?? {},
                                        });
                                        const sessionServices = createNativeAgentSessionHostServices({
                                            owners: sessionOwners,
                                            agentId: nativeIdentity.agentId,
                                            sessionId,
                                            directory: options.cwd,
                                            signal,
                                            isCurrent: nativeIdentity.isCurrent,
                                            session: host.session,
                                            publications: publications.services,
                                            readToolExecutionCapability: () => (
                                                nativeAgentRuntime.toolExecution?.capability ?? null
                                            ),
                                            accountSettings: options.accountSettings ?? {},
                                            profileId: options.start?.profileId ?? null,
                                            sessionMachineId: host.machineId,
                                            ...(sessionOwners.terminalHost
                                                ? { terminalHost: sessionOwners.terminalHost }
                                                : {}),
                                            ...(nativeHome ? { nativeHome } : {}),
                                            toolsDelivery: resolveAgentToolsDelivery(nativeIdentity.agentId),
                                        });
                                        const ui = createPluginInvocationPresentation({
                                            currentSession,
                                            signal,
                                            isGenerationCurrent: nativeIdentity.isCurrent,
                                        });
                                        const protocols = createPublicAcpRuntimeProtocols({
                                            pluginId: nativeIdentity.pluginId,
                                            agentId: nativeIdentity.agentId,
                                            signal,
                                            isCurrent: nativeIdentity.isCurrent,
                                            services: invocationServices,
                                            interactions: currentSession.interactions,
                                            models: publications.services.models,
                                            transformAgentRequest: async (payload, options) => (
                                                params.daemonTurnContributionsBridge
                                                    ? await params.daemonTurnContributionsBridge.transformAgentRequest({
                                                        sessionId,
                                                        payload,
                                                        signal: options.signal,
                                                    })
                                                    : await transformAgentRequestThroughPluginHooks(
                                                        payload,
                                                        options.signal ? { signal: options.signal } : undefined,
                                                    )
                                            ),
                                        });
                                        const context = composeNativeAgentSessionRuntimeContext({
                                            identity: nativeIdentity,
                                            contributionId,
                                            invokedAtMs: Date.now(),
                                            sessionId,
                                            signal,
                                            services: invocationServices,
                                            sessionServices,
                                            ui,
                                            protocols,
                                            workState: createNativeAgentSessionWorkStateService({
                                                session: host.session,
                                                pluginId: nativeIdentity.pluginId,
                                                contributionId,
                                                agentId: params.agent.id,
                                                generationId: nativeIdentity.generation,
                                                declarations: readAgentSessionCapabilities(
                                                    params.agent.richDefinition?.definition,
                                                )?.workStateSources ?? [],
                                                isCurrent: nativeIdentity.isCurrent,
                                            }),
                                        });
                                        return Object.freeze({
                                            context,
                                            async dispose() {
                                                publications?.dispose();
                                                await sessionOwners.dispose();
                                            },
                                        });
                                    } catch (error) {
                                        publications?.dispose();
                                        await sessionOwners.dispose();
                                        throw error;
                                    }
                                }
                            : null;
                        if (isVoiceInteraction) {
                            if (!createSessionContext) {
                                throw new Error(
                                    'Voice Agent Session interaction requires parent Session host custody',
                                );
                            }
                            return createNativeAgentSessionInteractionHostRuntime({
                                runtime: nativeAgentRuntime,
                                lease: engineEntry,
                                options,
                                supportsResume: sessionOpenCapabilities?.includes('resume') === true,
                                generationSignal: engineEntry.retirementSignal,
                                ...(services ? { services } : {}),
                                createSessionContext,
                            });
                        }
                        if (nativeAgentRuntime.sessions) {
                            if (!createSessionContext) {
                                throw new Error(
                                    'Session-derived execution run requires parent Session host custody',
                                );
                            }
                            return createNativeAgentSessionExecutionRunHostRuntime({
                                runtime: nativeAgentRuntime,
                                lease: engineEntry,
                                options,
                                supportsResume: sessionOpenCapabilities?.includes('resume') === true,
                                generationSignal: engineEntry.retirementSignal,
                                ...(services ? { services } : {}),
                                createSessionContext,
                            });
                        }
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
