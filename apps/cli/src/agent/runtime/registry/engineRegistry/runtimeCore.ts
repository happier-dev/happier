import type { AgentRuntime } from '@happier-dev/plugin-sdk/agents/runtime';
import { materializeActionRequestAttributionV1 } from '@happier-dev/protocol/actions/actionRequestAttributionV1';
import type {
    ResolvedAgentRuntimeContribution,
} from '@/plugins/projection/registry/types';
import {
    readAgentExecutionRunCapabilities,
    readAgentSessionCapabilities,
    type AgentSessionCapabilities,
} from '@/plugins/projection/registry/agentContributionDefinition';
import type { ResolvedExecutablePluginRuntimeRegistry } from '@/plugins/runtime/resolveExecutablePluginRuntimeRegistry';
import { buildPluginSessionBindingInput } from '@/plugins/runtime/runtimeCore/plugin/sessionLaunch';
import {
    type BackendExecutionSurfaces,
    type CliEngineAdapter,
    type CliRuntimeCore,
    type EngineResolutionAgent,
    type EngineResolutionBackend,
    type CreateCliExecutionRunBackendParams,
} from '../engineRegistryTypes';
import type {
    BackendRuntimeOwnerResolution,
    NativeAgentSessionRunToolBinding,
} from '../engineRegistryTypes';
import type { RuntimeRegistryBackendEngineEntry } from './runtimeOwnerResolution';
import {
    composeNativeAgentSessionRuntimeContext,
    createNativeAgentRuntimeSessionPlan,
    createNativeAgentSessionHostServices,
    resolveNativeAgentSessionNativeHomeService,
    resolveAgentSessionMcpLaunchConfigs,
    readConfiguredExternalSessionProviderOps,
} from './nativeAgentSession';
import { createNativeAgentSessionHostServiceOwners } from './nativeAgentSessionHostServiceOwners';
import { createNativeAgentSessionPublications } from './nativeAgentSessionPublications';
import {
    bindNativeAgentSessionServices,
    createNativeAgentCurrentSessionUiServices,
    createNativeAgentSessionServices,
} from './nativeAgentSessionInteractions';
import {
    createNativeAgentExecutionRunHostRuntime,
    createNativeAgentExecutionRunContextLeaseFactory,
    createNativeAgentSessionExecutionRunHostRuntime,
    createNativeAgentSessionInteractionHostRuntime,
    createRunScopedWorkStateService,
    type NativeAgentRuntimeLeaseIdentity,
    type NativeAgentSessionContextLeaseFactory,
} from '@/agent/runtime/bridges/executionRun/nativeAgentExecutionRun';
import { selectExecutionRunSessionAdapter } from '@/agent/runtime/bridges/executionRun/retainedInteractionEligibility';
import { createLazyExecutionRunHostRuntime } from '@/agent/runtime/bridges/executionRun/hostRuntime/lazy';
import type { ExecutionRunHostRuntime } from '@/agent/runtime/bridges/executionRun/executionRunHostRuntime';
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
import { createRunScopedExecutionPermissionHandler } from '@/agent/executionRuns/policy/runScopedExecutionPermissionHandler';
import { resolveExecutionRunPermissionInteractionMode } from '@/agent/executionRuns/policy/executionRunPermissionInteractionPolicy';
import { createExecutionRunCodedError } from '@/agent/runtime/bridges/executionRun/errors';
import { resolveAgentToolsDelivery } from '@/agent/tools/happierTools/runtime/resolveAgentToolsDelivery';
import type { PublicAcpHostLaunchResolver } from '@/agent/acp/runtime/publicSession/createPublicAcpSession';
import { readSessionWorkspaceWritesV1 } from '@happier-dev/protocol/prompts/roles/resolveRoleSelectionV1';
import { createHostTerminalTranscriptFollowService } from '@/agent/runtime/session/terminal/transcriptFollow';
import { HostTerminalTranscriptFollowAdmissionError } from '@/agent/runtime/session/terminal/contract';
import { createExternalSessionTerminalFollowProjector } from '@/session/external/terminalFollowProjection';
import { shareSessionCommittedTranscriptLocalIds } from '@/api/session/client/transcript/committedTranscriptLocalIdBaseline';
import { projectRuntimeTranscriptEvent } from '@/agent/runtime/session/transcripts/projectRuntimeTranscriptEvent';
import { logger } from '@/ui/logger';
import { createRunnerAgentProjectLaunchInvocation } from '@/daemon/agentRuntime/runnerAgentProjectLaunch';
import { withExecutionRunHostRuntimeCleanup } from '@/agent/runtime/bridges/executionRun/hostRuntime/cleanup';
import { issueAgentNativeLaunchQualifierForHost } from '@/plugins/runtime/invocation/services/exec';

export function resolveSessionOwnedRunToolPolicy(params: Readonly<{
    options: Pick<CreateCliExecutionRunBackendParams, 'permissionMode' | 'workspaceWrites' | 'start' | 'causalPermissionAuthority'>;
    parentMetadata: Parameters<typeof readSessionWorkspaceWritesV1>[0];
    agentId: string;
}>): Parameters<typeof createRunScopedExecutionPermissionHandler>[0]['toolPolicy'] {
    const { options } = params;
    return {
        permissionMode: options.permissionMode,
        backendId: params.agentId,
        workspaceWrites: readSessionWorkspaceWritesV1(params.parentMetadata) === 'deny' ? 'deny' : options.workspaceWrites,
        allowedTools: options.start?.allowedTools,
        unlistedTools: options.start?.unlistedTools,
        ...(Object.hasOwn(options, 'causalPermissionAuthority') ? { causalPermissionAuthority: options.causalPermissionAuthority } : {}),
    };
}

export function shouldNormalizeManifestOnlyAcpBackend(backend: ResolvedAgentRuntimeContribution): boolean {
    return backend.runtimeKind === 'acp';
}

export async function resolveBackendRuntimeCore(params: Readonly<{
    backend: EngineResolutionBackend;
    agent: EngineResolutionAgent;
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
    startupRuntimeDescriptorV1?: import('@happier-dev/plugin-sdk/agents/runtime').AgentSessionOpenRequest['runtimeDescriptorV1'];
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
    prepareNativeTeamCredentialProviderBinding?: NonNullable<
        import('./types').RunnerAgentSessionRuntimeSource[
            'prepareTeamCredentialProviderBinding'
        ]
    >;
    managedProviderRunServices?: import('./types').RunnerAgentSessionRuntimeSource['managedProviderRunServices'];
    createNativeAgentInvocationServices?: CreateAgentInvocationServices;
    nativeAgentScmCommandRunner?: import('@/scm/runtime').ScmCommandRunner;
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
    resolveProviderCliAttachManagedServiceAccess?: import('./types').RunnerAgentSessionRuntimeSource['resolveProviderCliAttachManagedServiceAccess'];
    nativeAgentRuntimeIdentity?: Readonly<{
        pluginId: string;
        pluginVersion: string;
        agentId: string;
        localAgentId?: string;
        occurrenceId: string;
        sourceCustody?: import('@happier-dev/protocol').PluginSourceCustodyV1;
        immutableGenerationId?: string | null;
        runtimeAuthority?: PluginRuntimeAuthoritySnapshotV1;
        retirementSignal?: AbortSignal;
        isCurrent(): boolean;
    }>;
    nativeAgentSessionCapabilities?: AgentSessionCapabilities;
    nativeAgentTerminalHostOwner?: 'startup' | 'runtime';
    nativeAgentPolicyAgentId?: string;
    nativeAgentSessionProjection?: NonNullable<
        Parameters<typeof createNativeAgentRuntimeSessionPlan>[0]['sessionProjection']
    >;
    resolveNativeAgentAcpHostLaunch?: PublicAcpHostLaunchResolver;
    nativeAgentAcpRuntimeDefinition?: Parameters<typeof createPublicAcpRuntimeProtocols>[0]['runtimeDefinition'];
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
                    ?? (params.agent.identity && nativeIdentity.sourceCustody
                        ? resolveAgentSessionRealtimeVoiceAuthority({
                            runtimeRegistry: params.runtimeRegistry,
                            policyAgentRef: params.agent.identity,
                            agentRuntimeIdentity: {
                                ...nativeIdentity,
                                sourceCustody: nativeIdentity.sourceCustody,
                            },
                            ...(agentRetirementSignal
                                ? { agentRetirementSignal }
                                : {}),
                        })
                        : null);
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
                            scmCommandRunner: params.nativeAgentScmCommandRunner ?? runtimeRegistry?.scmCommandRunner,
                            pluginMcpRuntimeRegistry: runtimeRegistry ?? undefined,
                            ...(runtimeRegistry?.resolveServerFeaturesSnapshot
                                ? {
                                    resolveServerFeaturesSnapshot:
                                        runtimeRegistry.resolveServerFeaturesSnapshot,
                                }
                                : {}),
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
                            ...(params.nativeAgentSessionCapabilities
                                ? { sessionCapabilities: params.nativeAgentSessionCapabilities }
                                : {}),
                            ...(params.nativeAgentPolicyAgentId
                                ? { policyAgentId: params.nativeAgentPolicyAgentId }
                                : {}),
                            ...(params.nativeAgentSessionProjection
                                ? { sessionProjection: params.nativeAgentSessionProjection }
                                : {}),
                            ...(params.resolveNativeAgentAcpHostLaunch
                                ? { resolveAcpHostLaunch: params.resolveNativeAgentAcpHostLaunch }
                                : {}),
                            ...(params.nativeAgentAcpRuntimeDefinition
                                ? { acpRuntimeDefinition: params.nativeAgentAcpRuntimeDefinition }
                                : {}),
                            executionSurfaces: params.executionSurfaces,
                            terminalHostOwner: params.nativeAgentTerminalHostOwner,
                            externalSessionHostOperations:
                                params.externalSessionHostOperations,
                            managedServiceEndpointReadPort:
                                params.managedServiceEndpointReadPort,
                            managedServicesCustodyPort:
                                params.managedServicesCustodyPort,
                            resolveProviderCliAttachManagedServiceAccess:
                                params.resolveProviderCliAttachManagedServiceAccess,
                            ...(params.prepareNativeManagedProviderBinding
                                ? {
                                    prepareManagedProviderBinding:
                                        params.prepareNativeManagedProviderBinding,
                                }
                                : {}),
                            ...(params.prepareNativeTeamCredentialProviderBinding
                                ? {
                                    prepareTeamCredentialProviderBinding:
                                        params.prepareNativeTeamCredentialProviderBinding,
                                }
                                : {}),
                            ...(params.managedProviderRunServices ? { managedProviderRunServices: params.managedProviderRunServices } : {}),
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
                                    resolveAccountSettingsSnapshot: hostRuntimeParams.resolveAccountSettingsSnapshot,
                                    ...(hostRuntimeParams.accountSettings !== undefined
                                        ? { accountSettings: hostRuntimeParams.accountSettings }
                                        : {}),
                                    ...(hostRuntimeParams.accountSettingsAuthority
                                        ? { accountSettingsAuthority: hostRuntimeParams.accountSettingsAuthority }
                                        : {}),
                                    permissionHandler: hostRuntimeParams.permissionHandler,
                                    readResolvedMcpServers: () => hostRuntimeParams.resolvedMcpServers ?? [],
                                    resolveMcpToolNaming: hostRuntimeParams.resolveMcpToolNaming,
                                },
                                ...(hostRuntimeParams.currentTerminalMetadata
                                    ? { currentTerminalMetadata: hostRuntimeParams.currentTerminalMetadata }
                                    : {}),
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
                                        agentCliLaunch,
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
                                                occurrenceId:
                                                    nativeIdentity.occurrenceId,
                                                correlationId,
                                                cwd,
                                                environment,
                                                ...(agentCliLaunch ? { agentCliLaunch } : {}),
                                                providerBindingActive,
                                                signal,
                                                session,
                                                readActiveTurnAdmissionWitness,
                                                isOccurrenceCurrent:
                                                    nativeIdentity.isCurrent,
                                            }),
                                }
                                : runtimeRegistry?.createAgentInvocationServices
                                    && engineEntry
                                ? {
                                createInvocationServices: ({ correlationId, cwd, environment, agentCliLaunch, providerBindingActive, signal, session, readActiveTurnAdmissionWitness }) => (
                                    runtimeRegistry.createAgentInvocationServices!({
                                        pluginId: engineEntry.pluginId,
                                        pluginVersion: engineEntry.pluginVersion,
                                        agentId: engineEntry.agentId,
                                        occurrenceId: engineEntry.occurrenceId,
                                        correlationId,
                                        cwd,
                                        environment,
                                        ...(agentCliLaunch ? { agentCliLaunch } : {}),
                                        providerBindingActive,
                                        signal,
                                        session,
                                        readActiveTurnAdmissionWitness,
                                        isOccurrenceCurrent: engineEntry.isCurrent,
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
                            sessionInput: (() => {
                                const input = buildPluginSessionBindingInput(sessionParams);
                                return params.startupRuntimeDescriptorV1
                                    ? { ...input, bootstrap: { ...input.bootstrap, runtimeDescriptorV1: params.startupRuntimeDescriptorV1 } }
                                    : input;
                            })(),
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
                        if (options.actionRequestAttributionV1) options = { ...options,
                            actionRequestAttributionV1: materializeActionRequestAttributionV1(options.actionRequestAttributionV1) };
                        const host = options.scope === 'session_owned' ? options.sessionInteractionHost : undefined;
                        if (options.scope === 'session_owned' && !host) {
                            throw Object.assign(
                                new Error('Execution-run parent Session host custody is unavailable'),
                                { code: 'execution_run_interaction_unavailable' },
                            );
                        }
                        if (!nativeAgentRuntime) {
                            const createRuntime = params.createNativeAgentRuntime;
                            if (!createRuntime) throw new Error('Daemon execution-run runtime is unavailable');
                            const lazy = createLazyExecutionRunHostRuntime({
                                async resolveRuntime() {
                                    const signal = agentRetirementSignal
                                        ? AbortSignal.any([lazy.getRuntimeLifetimeSignal(), agentRetirementSignal])
                                        : lazy.getRuntimeLifetimeSignal();
                                    signal.throwIfAborted();
                                    if (!nativeIdentity.isCurrent()) throw new Error('Native Agent runtime generation retired');
                                    if (host) await params.prepareNativeAgentRuntimeSource?.({ sessionId: host.session.sessionId, signal });
                                    signal.throwIfAborted();
                                    if (!nativeIdentity.isCurrent()) throw new Error('Native Agent runtime generation retired');
                                    const runtime = await createRuntime({ signal });
                                    signal.throwIfAborted();
                                    if (!nativeIdentity.isCurrent()) throw new Error('Native Agent runtime generation retired');
                                    const adapter = await resolveBackendRuntimeCore({ ...params, nativeAgentRuntime: runtime });
                                    signal.throwIfAborted();
                                    const run = adapter?.runtimeCore.createExecutionRunBackend(options);
                                    if (!run) throw new Error('Native Agent execution-run runtime is unavailable');
                                    return run;
                                },
                            });
                            return lazy;
                        }
                        const runtimeLease: NativeAgentRuntimeLeaseIdentity = engineEntry ?? Object.freeze({
                            pluginId: nativeIdentity.pluginId,
                            pluginVersion: nativeIdentity.pluginVersion,
                            agentId: nativeIdentity.agentId,
                            localAgentId: params.nativeAgentRuntimeIdentity?.localAgentId
                                ?? params.agent.identity?.localId
                                ?? nativeIdentity.agentId,
                            occurrenceId: nativeIdentity.occurrenceId,
                            isCurrent: nativeIdentity.isCurrent,
                        });
                        const baseCreateRunInvocationServices = runtimeRegistry?.createAgentInvocationServices
                            ? runtimeRegistry.createAgentInvocationServices.bind(runtimeRegistry)
                            : params.createNativeAgentInvocationServices;
                        const projectInvocations = new Set<ReturnType<typeof createRunnerAgentProjectLaunchInvocation>>();
                        const createRunInvocationServices: CreateAgentInvocationServices | undefined = baseCreateRunInvocationServices
                            ? async input => {
                                const captured = options.projectLaunchContext;
                                const projectSetupOperation = options.resolveProjectSetupOperation?.() ?? captured?.operation ?? options.projectSetupOperation;
                                const operationInput = projectSetupOperation ? { ...input, projectSetupOperation } : input;
                                if (!captured) return await baseCreateRunInvocationServices(operationInput);
                                const invocation = createRunnerAgentProjectLaunchInvocation({ ...captured, cwd: input.cwd, signal: input.signal,
                                    ...(projectSetupOperation ? { operation: projectSetupOperation } : {}),
                                    ...(host ? { sessionId: host.session.sessionId } : {}),
                                    isCurrent: async () => input.isOccurrenceCurrent() && await captured.isCurrent() });
                                projectInvocations.add(invocation);
                                try { return await baseCreateRunInvocationServices({ ...operationInput, prepareAgentNativeLaunch: invocation.prepareAgentNativeLaunch }); }
                                catch (error) { projectInvocations.delete(invocation); await invocation.disposeProjectAgentLaunch(); throw error; }
                            }
                            : undefined;
                        const retainProjectLaunch = (runtime: ExecutionRunHostRuntime) => withExecutionRunHostRuntimeCleanup(runtime, async () => {
                            await Promise.all([...projectInvocations].map(invocation => invocation.disposeProjectAgentLaunch()));
                            projectInvocations.clear();
                        });
                        const invocationIdentity = engineEntry ?? nativeIdentity;
                        const openCapabilities = readAgentExecutionRunCapabilities(
                            params.agent.richDefinition?.definition,
                        )?.open;
                        const runId = options.runId?.trim();
                        const parentToolPolicy = host?.session.getMetadataSnapshot();
                        if (parentToolPolicy?.unlistedTools === 'deny') {
                            const parentTools = new Set(parentToolPolicy.allowedTools ?? []);
                            const runTools = new Set(options.start?.allowedTools ?? []);
                            if (options.start?.unlistedTools !== 'deny'
                                || parentTools.size !== runTools.size
                                || [...parentTools].some((tool) => !runTools.has(tool))) {
                                throw createExecutionRunCodedError('execution_run_not_allowed',
                                    'Execution Run tool policy does not match its confined parent Session');
                            }
                        }
                        const hasDetachedInteractionIdentity = options.scope === 'detached'
                            && Boolean(
                                runId
                                && options.controllerOccurrenceId?.trim()
                                && options.callId?.trim()
                                && options.sidechainId?.trim(),
                            );
                        const services = !host
                            && !hasDetachedInteractionIdentity
                            && runId
                            && createRunInvocationServices
                            && engineEntry
                            ? createRunInvocationServices({
                                pluginId: engineEntry.pluginId,
                                pluginVersion: engineEntry.pluginVersion,
                                agentId: engineEntry.agentId,
                                occurrenceId: engineEntry.occurrenceId,
                                correlationId: runId,
                                processOwner: { kind: 'run', runId },
                                ...(options.actionRequestAttributionV1 ? { actionRequestAttributionV1: options.actionRequestAttributionV1 } : {}),
                                cwd: options.cwd,
                                ...(options.isolation?.env ? { environment: options.isolation.env } : {}),
                                signal: engineEntry.retirementSignal,
                                isOccurrenceCurrent: engineEntry.isCurrent,
                            })
                            : undefined;
                        const effectiveSessionCapabilities = params.nativeAgentSessionCapabilities
                            ?? readAgentSessionCapabilities(params.agent.richDefinition?.definition);
                        if (options.workspaceWrites === 'deny' && effectiveSessionCapabilities?.workspaceWrites !== 'deny') {
                            throw createExecutionRunCodedError('role_policy_unenforceable', 'Agent cannot enforce the role workspace-write policy');
                        }
                        const sessionOpenCapabilities = effectiveSessionCapabilities?.open;
                        const detachedSessionPrimary = options.scope === 'detached'
                            && nativeAgentRuntime.sessions !== undefined;
                        const executionRunContextV1 = detachedSessionPrimary
                            ? nativeAgentRuntime.sessions?.executionRunContextV1
                            : undefined;
                        if (
                            detachedSessionPrimary
                            && (
                                effectiveSessionCapabilities?.executionRunContext?.versions[0] !== 1
                                || !executionRunContextV1
                            )
                        ) {
                            throw createExecutionRunCodedError(
                                'execution_run_protocol_unsupported',
                                `Agent runtime '${nativeIdentity.agentId}' does not support detached execution-run context v1`,
                            );
                        }
                        const adapterSelection = selectExecutionRunSessionAdapter({
                                scope: options.scope,
                                hasParentSessionCustody: host !== undefined && host !== null,
                                agentExposesSessionRuntime: Boolean(nativeAgentRuntime.sessions),
                                agentExposesDetachedConversation: typeof executionRunContextV1?.openConversation === 'function',
                                sessionCapabilities: effectiveSessionCapabilities ?? null,
                                intent: options.start?.intent ?? null,
                                runClass: options.start?.runClass ?? null,
                                retentionPolicy: options.start?.retentionPolicy ?? null,
                            });
                        const transformNativeAgentRequest = async (
                            payload: Readonly<Record<string, unknown>>,
                            transformOptions: Readonly<{ signal: AbortSignal }>,
                        ): Promise<Readonly<Record<string, unknown>>> => (
                            params.daemonTurnContributionsBridge && host
                                ? await params.daemonTurnContributionsBridge.transformAgentRequest({
                                    sessionId: host.session.sessionId,
                                    payload,
                                    signal: transformOptions.signal,
                                })
                                : await transformAgentRequestThroughPluginHooks(
                                    payload,
                                    transformOptions.signal ? { signal: transformOptions.signal } : undefined,
                                )
                        );
                        // Voice and Session-scoped finite Runs reuse the parent Session's complete
                        // custody context. Detached finite Runs select the run-scoped context below;
                        // the interactive Session loop retains its richer terminal/media/resume
                        // owners while reusing the same facet builders and exhaustive composer.
                        const runScope = options.sessionOwnedRunScope ?? null;
                        let readRunMcpToolContext: NativeAgentSessionRunToolBinding['getMcpToolContext'];
                        const runPermissionScope = host && options.runId
                            ? createRunScopedExecutionPermissionHandler({
                                runId: options.runId,
                                controllerOccurrenceId: options.controllerOccurrenceId ?? '',
                                handler: host.permissionHandler,
                                toolPolicy: resolveSessionOwnedRunToolPolicy({ options, parentMetadata: parentToolPolicy, agentId: nativeIdentity.agentId }),
                                mcpToolPolicy: { permissionMode: options.permissionMode, readContext: () => readRunMcpToolContext?.() ?? null },
                                readInteractionMode: () => {
                                    const { intent, runClass, ioMode, retentionPolicy } = options.start ?? {};
                                    if (!intent || !runClass || !ioMode || !retentionPolicy) {
                                        return 'interaction_unavailable';
                                    }
                                    return resolveExecutionRunPermissionInteractionMode({
                                        intent,
                                        runClass,
                                        ioMode,
                                        retentionPolicy,
                                        permissionMode: options.permissionMode,
                                        parentSessionId: host.session.sessionId,
                                        interactionTargetAvailable: true,
                                        backendCapabilities: {
                                            canRespondToPermission: true,
                                            canSurfaceParentSessionPrompt: true,
                                            runtimeKind: 'native_agent_session',
                                            backendId: nativeIdentity.agentId,
                                        },
                                    });
                                },
                            })
                            : null;
                        const executionPermissionHandler = runPermissionScope?.handler ?? host?.permissionHandler;
                        const createSessionContext: NativeAgentSessionContextLeaseFactory | null = host
                            ? async ({ services: fallbackServices, signal: runtimeSignal, readActiveTurnAdmissionWitness, readSessionRuntime, actionRequestAttributionV1 }) => {
                                    const sourceLifetime = new AbortController();
                                    const signal = AbortSignal.any([runtimeSignal, sourceLifetime.signal]);
                                    const sessionId = host.session.sessionId;
                                    const contributionId = runtimeLease.localAgentId;
                                    // A Session-owned Run writes into its own sidechain. The bridge's
                                    // target re-reads controller custody per write and refuses there,
                                    // so no path silently reaches the parent's main transcript.
                                    const runTranscriptSession = runScope?.projectRunTranscriptSession() ?? null;
                                    if (runTranscriptSession) shareSessionCommittedTranscriptLocalIds(runTranscriptSession, host.session);
                                    const externalSessionHostOperations = params.externalSessionHostOperations?.bindSession(sessionId) ?? null;
                                    const providerOps = readConfiguredExternalSessionProviderOps(params.executionSurfaces.externalSession);
                                    const loadBaseline = host.session.fetchCommittedTranscriptLocalIdBaseline;
                                    const sourceFollow = externalSessionHostOperations && runTranscriptSession
                                        ? createHostTerminalTranscriptFollowService({
                                            signal,
                                            ...(loadBaseline ? { loadCommittedLocalIdBaseline: (input) => loadBaseline.call(host.session, input) } : {}),
                                            followProviderSession: (request, listener) => externalSessionHostOperations.executeProviderSessionFollow({
                                                agentId: request.agentId,
                                                providerSessionId: request.providerSessionId,
                                                ...(providerOps?.resolveLinkIdentity && providerOps.readAfterTranscript ? { providerOps: {
                                                    validateSource: providerOps.validateSource,
                                                    resolveLinkIdentity: providerOps.resolveLinkIdentity,
                                                    pageTranscript: providerOps.pageTranscript,
                                                    readAfterTranscript: providerOps.readAfterTranscript,
                                                } } : {}),
                                                options: { projection: 'terminal', initialReplay: request.initialReplay,
                                                    ...(request.replay ? { replay: request.replay } : {}), signal: request.signal },
                                                listener,
                                            }),
                                            publish: createExternalSessionTerminalFollowProjector({
                                                sessionId, agentId: nativeIdentity.agentId,
                                                materializeTranscriptMedia: async request => {
                                                    if (!providerOps?.materializeTranscriptMedia) {
                                                        throw new Error('external_session_transcript_media_unavailable');
                                                    }
                                                    await providerOps.materializeTranscriptMedia(request);
                                                },
                                                observeSourceTranscript: async (input) => {
                                                    const session = readSessionRuntime();
                                                    if (!session?.observeSourceTranscript) throw new Error('external_session_terminal_source_observation_unavailable');
                                                    await session.observeSourceTranscript(input);
                                                },
                                                projectRuntimeEvent: (event, admission, sourceReplayLocalId) => projectRuntimeTranscriptEvent({
                                                    session: runTranscriptSession, provider: nativeIdentity.agentId, event,
                                                    ...(sourceReplayLocalId === undefined ? {} : { sourceReplayLocalId }),
                                                    ...(admission ? { admission } : {}),
                                                }),
                                            }),
                                        }) : null;
                                    const disposeSourceFollow = async () => {
                                        try { await sourceFollow?.releaseActiveBindings(); }
                                        finally { await externalSessionHostOperations?.retire(); }
                                    };
                                    let runToolBinding: NativeAgentSessionRunToolBinding | null = null;
                                    const sessionOwners = createNativeAgentSessionHostServiceOwners({
                                        executionRunId: runId,
                                        runtimeRegistry,
                                        identity: nativeIdentity,
                                        backend: params.backend,
                                        agent: params.agent,
                                        hostSession: {
                                            session: host.session,
                                            machineId: host.machineId,
                                            resolveAccountSettingsSnapshot: options.resolveAccountSettingsSnapshot,
                                            ...(options.accountSettings !== undefined
                                                ? { accountSettings: options.accountSettings }
                                                : {}),
                                            permissionHandler: executionPermissionHandler ?? host.permissionHandler,
                                            readResolvedMcpServers: () => runToolBinding?.resolvedMcpServers ?? [],
                                            resolveMcpToolNaming: async (request, options) => runToolBinding?.resolveMcpToolNaming
                                                ? await runToolBinding.resolveMcpToolNaming(request, options) : null,
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
                                        // The parent Session's materialization owner resolves the profile;
                                        // only its Happier bridge entry is rebound to this Run occurrence.
                                        runToolBinding = runScope && host.composeRunToolBinding
                                            ? await host.composeRunToolBinding({
                                                mcpPermissionHandler: executionPermissionHandler,
                                                runId: runScope.runId,
                                                agentId: params.agent.id,
                                                workDepth: runScope.workDepth,
                                                cwd: options.cwd,
                                                signal,
                                                isCurrent: () => (
                                                    runScope.readCurrentRunOccurrence(runScope.runId) !== null
                                                ),
                                                getPermissionMode: () => options.permissionMode,
                                                readActiveTurnAdmissionWitness: () => (
                                                    readActiveTurnAdmissionWitness?.() ?? null
                                                ),
                                                readCurrentRunOccurrence: runScope.readCurrentRunOccurrence,
                                            })
                                            : null;
                                        readRunMcpToolContext = runToolBinding?.getMcpToolContext;
                                        if (runToolBinding?.mcpServers) {
                                            runToolBinding = { ...runToolBinding, mcpServers: await resolveAgentSessionMcpLaunchConfigs(
                                                runToolBinding.mcpServers, options.start ?? {}, signal,
                                            ) };
                                        }
                                        if (runToolBinding) {
                                            runScope?.publishSupportedSessionReadActions(
                                                runToolBinding.supportedSessionReadActions,
                                                runtimeSignal,
                                            );
                                        }
                                        publications = createNativeAgentSessionPublications({
                                            agentId: nativeIdentity.agentId,
                                            session: null,
                                            signal,
                                            isCurrent: nativeIdentity.isCurrent,
                                            supportsInFlightSteer: readAgentSessionCapabilities(
                                                params.agent.richDefinition?.definition,
                                            )?.delivery.includes('steer') === true
                                                || effectiveSessionCapabilities?.delivery.includes('steer') === true,
                                        });
                                        const sourceCustody = nativeIdentity.sourceCustody;
                                        const nativeSessionServiceParams = {
                                            permissionHandler: executionPermissionHandler,
                                            pluginId: nativeIdentity.pluginId,
                                            contributionId,
                                            runtimeId: `agent-session-projection:${options.runId ?? sessionId}`,
                                            sessionId,
                                            occurrenceId: nativeIdentity.occurrenceId,
                                            ...(sourceCustody ? { sourceCustody } : {}),
                                            isCurrent: nativeIdentity.isCurrent,
                                            signal,
                                            readPermissionMode: () => options.permissionMode,
                                            readActiveTurnAdmissionWitness,
                                        };
                                        const currentSession = createNativeAgentCurrentSessionUiServices(nativeSessionServiceParams);
                                        const operationServices = runId && createRunInvocationServices
                                            ? await createRunInvocationServices({
                                                pluginId: invocationIdentity.pluginId,
                                                pluginVersion: invocationIdentity.pluginVersion,
                                                agentId: invocationIdentity.agentId,
                                                occurrenceId: invocationIdentity.occurrenceId,
                                                correlationId: runId,
                                                processOwner: { kind: 'run', runId, sessionId },
                                                cwd: options.cwd,
                                                ...(options.isolation?.env ? { environment: options.isolation.env } : {}),
                                                signal,
                                                session: { id: sessionId, current: currentSession },
                                                readActiveTurnAdmissionWitness,
                                                ...(!readActiveTurnAdmissionWitness && actionRequestAttributionV1 ? { actionRequestAttributionV1 } : {}),
                                                isOccurrenceCurrent: invocationIdentity.isCurrent,
                                            })
                                            : fallbackServices;
                                        const credentials = await host.readOwnerAccountCredentials?.();
                                        signal.throwIfAborted();
                                        const invocationServices = bindNativeAgentSessionServices(operationServices, createNativeAgentSessionServices({
                                            ...nativeSessionServiceParams,
                                            ...(credentials ? { credentials } : {}),
                                            ...(host.readOwnerAccountCredentials ? { readCredentials: host.readOwnerAccountCredentials } : {}),
                                            currentSessionUi: currentSession,
                                        }));
                                        const nativeHome = await resolveNativeAgentSessionNativeHomeService({
                                            agent: params.agent,
                                            sourceEnvironment: options.isolation?.env ?? {},
                                        });
                                        const nativeLaunch = issueAgentNativeLaunchQualifierForHost(invocationServices.exec);
                                        const sessionServices = Object.freeze({ ...createNativeAgentSessionHostServices({
                                            owners: sessionOwners,
                                            agentId: nativeIdentity.agentId,
                                            sessionId,
                                            directory: options.cwd,
                                            signal,
                                            isCurrent: nativeIdentity.isCurrent,
                                            // A Session-owned Run publishes provider transcript facts into
                                            // its own sidechain through the bridge's projection owner.
                                            session: runTranscriptSession ?? host.session,
                                            followSource: async (request) => {
                                                signal.throwIfAborted();
                                                if (!sourceFollow) throw new HostTerminalTranscriptFollowAdmissionError('plugin_external_follow_unavailable', 'bind');
                                                const result = await sourceFollow.bindProviderSession({
                                                    agentId: nativeIdentity.agentId, providerSessionId: request.providerSessionId,
                                                    replay: request.replay, signal,
                                                });
                                                if (result.status === 'unavailable') throw new HostTerminalTranscriptFollowAdmissionError(result.code, 'bind');
                                                let active = true;
                                                void result.binding.failure.then(error => {
                                                    if (!active) return;
                                                    logger.warn('[NativeAgentRun] source transcript follow failed', { error });
                                                });
                                                return { failure: result.binding.failure, dispose: async () => { active = false; await result.binding.dispose(); } };
                                            },
                                            publications: publications.services,
                                            readToolExecutionCapability: () => (
                                                nativeAgentRuntime.toolExecution?.capability ?? null
                                            ),
                                            accountSettings: options.accountSettings ?? {},
                                            readCodingPromptBehavior: () => host.readCodingPromptBehavior?.() ?? null,
                                            sessionMachineId: host.machineId,
                                            ...(sessionOwners.terminalHost
                                                ? { terminalHost: sessionOwners.terminalHost }
                                                : {}),
                                            ...(nativeHome ? { nativeHome } : {}),
                                            toolsDelivery: resolveAgentToolsDelivery(nativeIdentity.agentId),
                                        }), nativeLaunch });
                                        const ui = createPluginInvocationPresentation({
                                            currentSession,
                                            signal,
                                            isOccurrenceCurrent: nativeIdentity.isCurrent,
                                        });
                                        const protocols = createPublicAcpRuntimeProtocols({
                                            pluginId: nativeIdentity.pluginId,
                                            agentId: nativeIdentity.agentId,
                                            signal,
                                            isCurrent: nativeIdentity.isCurrent,
                                            services: invocationServices,
                                            nativeLaunch,
                                            interactions: currentSession.interactions,
                                            models: publications.services.models,
                                            modes: publications.services.modes,
                                            transformAgentRequest: transformNativeAgentRequest,
                                            ...(params.resolveNativeAgentAcpHostLaunch
                                                ? { resolveHostLaunch: params.resolveNativeAgentAcpHostLaunch }
                                                : {}),
                                            ...(params.nativeAgentAcpRuntimeDefinition
                                                ? { runtimeDefinition: params.nativeAgentAcpRuntimeDefinition }
                                                : {}),
                                        });
                                        const context = composeNativeAgentSessionRuntimeContext({
                                            identity: nativeIdentity,
                                            contributionId,
                                            invokedAtMs: Date.now(),
                                            sessionId,
                                            signal,
                                            services: invocationServices,
                                            ...(options.connectedServiceRuntimeAuthRefresh
                                                ? { refreshRuntimeAuthViaDaemon: options.connectedServiceRuntimeAuthRefresh }
                                                : {}),
                                            sessionServices,
                                            ui,
                                            protocols,
                                            workState: createRunScopedWorkStateService(signal),
                                        });
                                        const disposeRunToolBinding = runToolBinding?.dispose ?? null;
                                        const enqueueSessionEventCommitted = runToolBinding?.skills
                                            ? host.session.enqueueSessionEventCommitted?.bind(host.session) : undefined;
                                        return Object.freeze({
                                            context,
                                            publications,
                                            ...(host.session.publishUsageObservation ? {
                                                usagePublisher: Object.freeze({
                                                    provider: nativeIdentity.agentId,
                                                    publish: (input: Parameters<NonNullable<
                                                        typeof host.session.publishUsageObservation
                                                    >>[0]) => host.session.publishUsageObservation!(input),
                                                }),
                                            } : {}),
                                            ...(runToolBinding?.mcpServers
                                                ? { mcpServers: runToolBinding.mcpServers }
                                                : {}),
                                            ...(runToolBinding?.mcpToolPolicy ? { mcpToolPolicy: runToolBinding.mcpToolPolicy } : {}),
                                            ...(runToolBinding?.mcpServersStrictMode !== undefined ? { mcpServersStrictMode: runToolBinding.mcpServersStrictMode } : {}),
                                            ...(runToolBinding?.subscribeMcpToolPolicy ? { subscribeMcpToolPolicy: runToolBinding.subscribeMcpToolPolicy } : {}),
                                            ...(runToolBinding?.skills ? { skills: runToolBinding.skills } : {}),
                                            ...(runToolBinding?.observeSkillUse ? { observeSkillUse: runToolBinding.observeSkillUse } : {}),
                                            ...(enqueueSessionEventCommitted ? {
                                                capabilityNoticeSession: { enqueueSessionEventCommitted },
                                            } : {}),
                                            ...(runToolBinding?.skillIndex ? { skillIndex: runToolBinding.skillIndex } : {}),
                                            async dispose() {
                                                // Only this Run's binding; the parent Session bridge and
                                                // sibling Run bindings keep their own leases.
                                                disposeRunToolBinding?.();
                                                publications?.dispose();
                                                try {
                                                    try { await disposeSourceFollow(); }
                                                    finally { await sessionOwners.dispose(); }
                                                } finally {
                                                    await runPermissionScope?.dispose('Execution run disposed');
                                                }
                                            },
                                        });
                                    } catch (error) {
                                        runToolBinding?.dispose();
                                        publications?.dispose();
                                        try {
                                            try { await disposeSourceFollow(); }
                                            finally { await sessionOwners.dispose(); }
                                        } finally {
                                            await runPermissionScope?.dispose('Execution run context failed');
                                        }
                                        throw error;
                                    }
                                }
                            : null;
                        if (createSessionContext && runPermissionScope) {
                            Object.assign(createSessionContext, {
                                async abortPendingPermissionRequests(reason: string) {
                                    await runPermissionScope.dispose(reason);
                                },
                            });
                        }
                        const detachedContextLeaseFactory = hasDetachedInteractionIdentity
                            ? createNativeAgentExecutionRunContextLeaseFactory({
                                lease: runtimeLease,
                                runId: options.runId!,
                                controllerOccurrenceId: options.controllerOccurrenceId!,
                                callId: options.callId!,
                                sidechainId: options.sidechainId!,
                                runtimeRegistry,
                                ...(params.nativeAgentRuntimeIdentity?.runtimeAuthority
                                    ? { runtimeAuthority: params.nativeAgentRuntimeIdentity.runtimeAuthority }
                                    : {}),
                                directory: options.cwd,
                                machineId: options.machineId ?? '',
                                accountSettings: options.accountSettings ?? null,
                                resolveAccountSettingsSnapshot: options.resolveAccountSettingsSnapshot,
                                agent: params.agent,
                                sourceEnvironment: options.isolation?.env ?? {},
                                ...(options.connectedServiceRuntimeAuthRefresh ? { refreshRuntimeAuthViaDaemon: options.connectedServiceRuntimeAuthRefresh } : {}),
                                permissionMode: options.permissionMode,
                                workspaceWrites: options.workspaceWrites,
                                start: options.start ?? {},
                                ...(options.getPermissionRequestStore
                                    ? { getPermissionRequestStore: options.getPermissionRequestStore }
                                    : {}),
                                ...(options.causalPermissionAuthority
                                    ? { causalPermissionAuthority: options.causalPermissionAuthority }
                                    : {}),
                                ...(options.start?.capabilitySelection
                                    ? { capabilitySelection: options.start.capabilitySelection }
                                    : {}),
                                ...(params.happyHomeDir ? { happyHomeDir: params.happyHomeDir } : {}),
                                transformAgentRequest: transformNativeAgentRequest,
                                ...(params.resolveNativeAgentAcpHostLaunch
                                    ? { resolveAcpHostLaunch: params.resolveNativeAgentAcpHostLaunch }
                                    : {}),
                                ...(params.nativeAgentAcpRuntimeDefinition
                                    ? { acpRuntimeDefinition: params.nativeAgentAcpRuntimeDefinition }
                                    : {}),
                                ...(createRunInvocationServices
                                    ? {
                                        createInvocationServices: async ({
                                            currentSession,
                                            signal,
                                            readActiveTurnAdmissionWitness,
                                            actionRequestAttributionV1,
                                        }) => await createRunInvocationServices({
                                            pluginId: invocationIdentity.pluginId,
                                            pluginVersion: invocationIdentity.pluginVersion,
                                            agentId: invocationIdentity.agentId,
                                            occurrenceId: invocationIdentity.occurrenceId,
                                            correlationId: options.runId!,
                                            processOwner: { kind: 'run', runId: options.runId! },
                                            cwd: options.cwd,
                                            ...(options.isolation?.env
                                                ? { environment: options.isolation.env }
                                                : {}),
                                            signal,
                                            currentSession,
                                            ...(readActiveTurnAdmissionWitness
                                                ? { readActiveTurnAdmissionWitness }
                                                : {}),
                                            ...(!readActiveTurnAdmissionWitness && actionRequestAttributionV1 ? { actionRequestAttributionV1 } : {}),
                                            isOccurrenceCurrent: invocationIdentity.isCurrent,
                                        }),
                                    }
                                    : {}),
                            })
                            : null;
                        const effectiveCreateSessionContext = createSessionContext;
                        if (options.start?.intent === 'voice_agent' && (!host || adapterSelection !== 'retained_agent_session')) {
                            // Voice's intent policy already fixes long-lived/resumable/streaming, so a
                            // missing custody or capability here is a loud composition defect rather
                            // than a run that should quietly degrade to a finite adapter.
                            throw new Error(
                                    !effectiveCreateSessionContext
                                    ? 'Voice Agent Session interaction requires parent Session host custody'
                                    : 'Voice Agent Session interaction requires declared Session capabilities',
                            );
                        }
                        if (adapterSelection === 'retained_agent_session') {
                            if (!effectiveCreateSessionContext) {
                                throw new Error(
                                    'Retained Agent Session interaction requires parent Session host custody',
                                );
                            }
                            if (!effectiveSessionCapabilities) {
                                throw new Error(
                                    'Retained Agent Session interaction requires declared Session capabilities',
                                );
                            }
                            return retainProjectLaunch(createNativeAgentSessionInteractionHostRuntime({
                                runtime: nativeAgentRuntime,
                                lease: runtimeLease,
                                options,
                                sessionCapabilities: effectiveSessionCapabilities,
                                ...(agentRetirementSignal ? { generationSignal: agentRetirementSignal } : {}),
                                ...(services ? { services } : {}),
                                createSessionContext: effectiveCreateSessionContext,
                            }));
                        }
                        if (nativeAgentRuntime.sessions && options.scope === 'session_owned') {
                            return retainProjectLaunch(createNativeAgentSessionExecutionRunHostRuntime({
                                runtime: nativeAgentRuntime,
                                lease: runtimeLease,
                                options,
                                supportsResume: sessionOpenCapabilities?.includes('resume') === true,
                                ...(agentRetirementSignal ? { generationSignal: agentRetirementSignal } : {}),
                                ...(services ? { services } : {}),
                                createSessionContext: effectiveCreateSessionContext!,
                            }));
                        }
                        return retainProjectLaunch(createNativeAgentExecutionRunHostRuntime({
                            runtime: nativeAgentRuntime,
                            ...(executionRunContextV1 ? { executionRunContextV1 } : {}),
                            ...(adapterSelection === 'retained_agent_conversation' ? { retainedConversation: true } : {}),
                            lease: runtimeLease,
                            options,
                            supportsResume: (detachedSessionPrimary ? sessionOpenCapabilities : openCapabilities)?.includes('resume') === true,
                            ...(agentRetirementSignal ? { generationSignal: agentRetirementSignal } : {}),
                            ...(services ? { services } : {}),
                            ...(detachedContextLeaseFactory
                                ? { createExecutionRunContext: detachedContextLeaseFactory }
                                : {}),
                            ...(detachedContextLeaseFactory?.respondToPermissionRequest
                                ? { respondToPermissionRequest: detachedContextLeaseFactory.respondToPermissionRequest }
                                : {}),
                            ...(detachedContextLeaseFactory?.abortPendingPermissionRequests
                                ? { abortPendingPermissionRequests: detachedContextLeaseFactory.abortPendingPermissionRequests }
                                : {}),
                            ...(detachedContextLeaseFactory?.resolveStructuredInputForDispatch
                                ? { resolveStructuredInputForDispatch: detachedContextLeaseFactory.resolveStructuredInputForDispatch }
                                : {}),
                        }));
                    },
                });
                return { runtimeCore };
            }
        }

        return null;
    }
    return null;
}
