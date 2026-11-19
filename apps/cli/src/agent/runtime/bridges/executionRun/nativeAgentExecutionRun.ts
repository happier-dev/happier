import { AgentExecutionRunEventSchema } from '@happier-dev/protocol/runtime/agentExecutionRunV1';
import { AgentRuntimeJsonValueV1Schema } from '@happier-dev/protocol/runtime/agentSessionV1';
import { resolveNativeAgentLaunchEnvironment } from '@/agent/runtime/launchEnvironment';
import { sessionProcessEnvironment } from '@/agent/runtime/lifecycle/hostedSessionScope';
import { HappierStructuredInputV1Schema } from '@happier-dev/protocol/runtime/input/structuredInputV1';
import { PluginContributionIdentityV1Schema } from '@happier-dev/protocol/plugins/contribution-identity';
import { renderSessionInputContextPromptV1 } from '@happier-dev/protocol/sessions/messages/sessionInputPromptContextV1';
import { AgentRuntimeDiagnosticDataV1Schema, type AgentRuntimeDiagnosticDataV1 } from '@happier-dev/protocol/runtime/agentRuntimeDiagnosticV1';
import { redactPluginInvocationResultData } from '@happier-dev/cli-common/plugins/registration';
import { materializeActionRequestAttributionV1, type ActionRequestAttributionV1 } from '@happier-dev/protocol/actions/actionRequestAttributionV1';
import type { AccountSettings, ActionExecutorContext, SessionCapabilitySelectionV1 } from '@happier-dev/protocol';
import type {
    AgentExecutionRunEvent,
    AgentExecutionRunConversationEventV1,
    AgentExecutionRunConversationRuntimeV1,
    AgentExecutionRunOpenRequest,
    AgentExecutionRunRuntime,
    AgentExecutionRunRuntimeFactory,
    AgentExecutionRunRuntimeContextV1,
    AgentExecutionRunHostServicesV1,
    AgentSessionExecutionRunRuntimeFactoryV1,
    AgentLaunchEnvironment,
    AgentRuntime,
    AgentRuntimeContext,
    AgentSessionInput,
    AgentSessionOpenRequest,
    AgentSessionRuntime,
    AgentSessionRuntimeContext,
    AgentSessionRuntimeEvent,
} from '@happier-dev/plugin-sdk/agents/runtime';
import type { PluginServices } from '@happier-dev/plugin-sdk';
import type { WorkStateService } from '@happier-dev/plugin-sdk/sessions/work-state';
import { randomUUID } from 'node:crypto';
import { callSessionMcpTool } from '@/cli/commands/toolsSessionMcp';
import { createExecutionRunHostBackendFromSessionRuntime } from './sessionAdapter';
import { buildExecutionRunConfiguration } from './runtime/openInputs';

import type { AgentMessage } from '@/agent/core/AgentMessage';
import type { CreateCliExecutionRunBackendParams, EngineResolutionAgent } from '@/agent/runtime/registry/engineRegistryTypes';
import type { AgentSessionCapabilities } from '@/plugins/projection/registry/agentContributionDefinition';
import { createUnavailablePluginServices } from '@/plugins/runtime/invocation/services/unavailable';
import { continueNativeRuntimeAfterFailure, createRecoveringAgentSessionRuntime } from './hostRuntime/recovery';
import { withRunScopedSessionContext } from './runtime/sessionContext';
import {
    createPluginInteractionsService,
    createPluginInvocationPresentation,
} from '@/plugins/runtime/invocation/services/interactions';
import {
    createNativeAgentCurrentExecutionRunUiServices,
    createNativeAgentExecutionRunPermissions,
} from '@/agent/runtime/registry/engineRegistry/nativeAgentSessionInteractions';
import { createExecutionRunPermissionHandler, resolveExecutionRunInputAuthority, type ExecutionRunPermissionResponder } from '@/agent/executionRuns/policy/executionRunPermissionDecision';
import type { PermissionResult } from '@/agent/permissions/BasePermissionHandler';
import { executionRunPermissionIntentV1 as normalizeExecutionRunPermissionMode } from '@happier-dev/protocol/actions/executionRunActionPermissionMode';
import {
    buildExecutionRunPermissionRequestEnvelope,
    resolveExecutionRunPermissionInteractionMode,
} from '@/agent/executionRuns/policy/executionRunPermissionInteractionPolicy';
import {
    createRunScopedExecutionPermissionHandler,
    readRunScopedExecutionProviderRequestId,
} from '@/agent/executionRuns/policy/runScopedExecutionPermissionHandler';
import type { ResolvedExecutablePluginRuntimeRegistry } from '@/plugins/runtime/resolveExecutablePluginRuntimeRegistry';
import { resolveAgentContributionQualifiedId } from '@/plugins/projection/registry/agentRoutingIdentity';
import { resolveNativeAgentSessionStateSharingPolicy } from '@/agent/runtime/registry/engineRegistry/stateSharingPolicy';
import { createPublicAcpRuntimeProtocols } from '@/agent/acp/runtime/publicSession/createPublicAcpRuntimeProtocols';
import { issueAgentNativeLaunchQualifierForHost, admitAgentNativeMcpPlacementForHost } from '@/plugins/runtime/invocation/services/exec';
import { createNativeRunHappierMcpBridge } from './nativeRunHappierMcpBridge';
import type { SessionMcpLocalContext } from '@/mcp/runtime/sessionMcpLocalContext';
import type { HostAgentIsolationLaunchContext } from '@/daemon/agentIsolation/agentIsolationLaunchPolicy';
import {
    createNativeAgentSessionInteractionOperations,
    applyNativeAgentConfigurationUpdate,
    projectNativeAgentProviderBindingConfiguration,
    assertNativeAgentSessionModeAvailable,
    resolveNativeAgentSessionNativeHomeService,
    resolveAgentSessionMcpLaunchConfigs,
} from '@/agent/runtime/registry/engineRegistry/nativeAgentSession';
import { toNativeAgentUsageObservation, buildNativeAgentUsageAccountingMetadata } from '@/usage/nativeAgentUsageObservation';
import type { NativeAgentSessionPublications } from '@/agent/runtime/registry/engineRegistry/nativeAgentSessionPublications';
import type { UsageObservation } from '@/usage/usageObservation';
import type { UsageObservationPublishResult } from '@/usage/createUsageObservationPublisher';
import {
    normalizeHostProviderInputOutcome,
    type SessionProviderInputOutcome,
} from '@/agent/runtime/session/input/providerInputOutcome';

import type { ExecutionRunHostRuntime, ExecutionRunHostRuntimeEvent } from './executionRunHostRuntime';
import { toRuntimePermissionResponseOutcome } from './executionRunHostRuntime';
import type { ExecutionRunBackendStartContext } from '@/agent/executionRuns/registry/executionRunBackendTypes';
import type { AgentInvocationTurnAdmissionWitness } from '@/plugins/runtime/invocation/services/types';
import type { HostCurrentSessionUiServices } from '@/agent/runtime/state/currentSessionUiTypes';
import { createNativeAgentExecutionRunHostServices } from '@/agent/runtime/registry/engineRegistry/nativeAgentSessionHostServiceOwners';
import type { PluginRuntimeAuthoritySnapshotV1 } from '@/plugins/runtime/lifecycle/activation/runtimeAuthority';
import {
    createRuntimeTurnFailureAlreadySurfacedError,
    readRuntimeTurnFailureAlreadySurfacedEvent,
} from '@/agent/runtime/turns/runtimeTurnOperations';
import { resolveStructuredInputProviderDispatchContext } from '@/agent/runtime/turns/resolveStructuredInputProviderContext';
import { readConnectedServiceChildMemberLogContextFromEnv } from '@/daemon/connectedServices/connectedServiceChildEnvironment';
import { logger } from '@/ui/logger';
import { publishSkillLaunchNotice } from '@/prompts/skills/runtime/publishRunnerSkillNotice';
import { createExecutionRunCodedError, createExecutionRunDiagnosticError, readExecutionRunErrorCode, readExecutionRunRejectedStartDiagnostic, sanitizeExecutionRunError as sanitizeThrownError, type ExecutionRunRejectedStartError } from './errors';
import { McpServerCatalogUnavailableError, readMcpServersSettingsFromAccountSettings } from '@/mcp/servers/readMcpServersSettingsFromAccountSettings';
import { resolveSessionCapabilitiesForDirectory } from '@/mcp/servers/resolveSessionCapabilitiesForDirectory';
import { agentReceivesUserMcpServersV1 } from '@happier-dev/protocol/plugins/contributions/v2';
import { resolveAgentToolsDelivery } from '@/agent/tools/happierTools/runtime/resolveAgentToolsDelivery';
import { listSelectedMcpSharedSecretReferences, materializeMcpServerConfigRecord } from '@/mcp/servers/materializeMcpServerConfigRecord';
import { acquireSavedSecretMaterializerForOperation } from '@/settings/secrets/savedSecretCatalogRead';
import { getActiveAccountSettingsSnapshot, getActiveAccountSettingsSnapshotLifetimeToken } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { projectResolvedMcpServers } from '@/mcp/runtime/projectResolvedMcpServers';
import { applyAttachedPluginMcpTransport } from '@/mcp/runtime/applyAttachedPluginMcpTransport';
import type { ResolvedSessionMcpServer } from '@/mcp/runtimeTypes';
import type { McpToolPolicyContext } from '@/mcp/runtime/resolveMcpToolIdentity';
import { projectMcpToolLaunchPolicies } from '@/mcp/runtime/projectMcpToolLaunchPolicy';
import { parseAgentPermissionIntentV1Alias } from '@happier-dev/protocol/runtime/permissionIntentV1';
import {
    isWorkflowInteractionCapacityError,
    WORKFLOW_INTERACTION_CAPACITY_EXCEEDED,
} from '@/agent/permissions/interactionPersistenceError';
import { assertMcpStdioExecutionSupported, refuseMcpExecutionSource } from '@/mcp/runtime/mcpExecutionSource';

type NativeAgentRunUsagePublisher = Readonly<{
    provider: string;
    publish(input: Readonly<{
        observedAt: number;
        observation: UsageObservation;
        turnId: string | null;
        externalKey: string;
        metadata?: Parameters<ReturnType<typeof import('@/usage/createUsageObservationPublisher').createUsageObservationPublisher>['publish']>[0]['metadata'];
    }>): void | Promise<void | UsageObservationPublishResult>;
}>;

type NativeAgentSessionContextLease = Readonly<{
    context: AgentSessionRuntimeContext;
    /** Current Session transport output, held only by the host lease. */
    sessionMcpContext?: SessionMcpLocalContext;
    agentEnvironment?: Readonly<Record<string, string>>;
    publications?: NativeAgentSessionPublications;
    mcpServers?: AgentSessionOpenRequest['mcpServers'];
    mcpServersStrictMode?: AgentSessionOpenRequest['mcpServersStrictMode'];
    mcpToolPolicy?: AgentSessionOpenRequest['mcpToolPolicy'];
    subscribeMcpToolPolicy?: (listener: (policy: NonNullable<AgentSessionOpenRequest['mcpToolPolicy']>) => void) => () => void;
    skills?: AgentSessionOpenRequest['skills'];
    observeSkillUse?: (event: Extract<AgentSessionRuntimeEvent, { kind: 'skill-usage' }>) => Promise<void>;
    skillIndex?: string;
    capabilityNoticeSession?: Parameters<typeof publishSkillLaunchNotice>[0];
    usagePublisher?: NativeAgentRunUsagePublisher;
    dispose(): Promise<void>;
}>;

function withSessionRunAgentEnvironment<Request extends AgentSessionOpenRequest>(
    request: Request,
    agentEnvironment: Readonly<Record<string, string>> | undefined,
): Request {
    if (!agentEnvironment) return request;
    return {
        ...request,
        launchEnvironment: Object.freeze({
            values: Object.freeze({ ...request.launchEnvironment?.values, ...agentEnvironment }),
            unset: Object.freeze((request.launchEnvironment?.unset ?? []).filter(name => !Object.hasOwn(agentEnvironment, name))),
        }),
    };
}

export type NativeAgentSessionContextLeaseFactory = ((params: Readonly<{
    services: PluginServices;
    signal: AbortSignal;
    onInteractionUnavailable?(): void;
    readSessionRuntime(): AgentSessionRuntime | null;
    readActiveTurnAdmissionWitness?: () => AgentInvocationTurnAdmissionWitness | null;
    actionRequestAttributionV1?: ActionRequestAttributionV1;
}>) => Promise<NativeAgentSessionContextLease> | NativeAgentSessionContextLease) & Readonly<{
    bindInvocationServices?: (params: Readonly<{
        services: PluginServices;
        signal: AbortSignal;
        readActiveTurnAdmissionWitness?: () => AgentInvocationTurnAdmissionWitness | null;
        actionRequestAttributionV1?: ActionRequestAttributionV1;
    }>) => Promise<PluginServices>;
    respondToPermissionRequest?: (requestId: string, approved: boolean, response?: PermissionResult) => ReturnType<ExecutionRunPermissionResponder>;
    abortPendingPermissionRequests?: (reason: string) => Promise<void>;
    onTurnTerminal?: (turnId: string) => Promise<void>;
    resolveStructuredInputForDispatch?: (params: Readonly<{
        input: AgentSessionInput;
        localId: string;
        signal: AbortSignal;
    }>) => Promise<AgentSessionInput>;
}>;

type NativeAgentExecutionRunContextLease = Readonly<{
    context: AgentExecutionRunRuntimeContextV1;
    mcpServers?: AgentSessionOpenRequest['mcpServers'];
    mcpServersStrictMode?: AgentSessionOpenRequest['mcpServersStrictMode'];
    mcpToolPolicy?: AgentSessionOpenRequest['mcpToolPolicy'];
    skills?: AgentSessionOpenRequest['skills'];
    skillIndex?: string;
    dispose(): Promise<void>;
}>;

export type NativeAgentExecutionRunContextLeaseFactory = ((params: Readonly<{
    services: PluginServices;
    signal: AbortSignal;
    onInteractionUnavailable?(): void;
    readActiveTurnAdmissionWitness?: () => AgentInvocationTurnAdmissionWitness | null;
    actionRequestAttributionV1?: ActionRequestAttributionV1;
}>) => Promise<NativeAgentExecutionRunContextLease> | NativeAgentExecutionRunContextLease) & Pick<
    NativeAgentSessionContextLeaseFactory,
    'bindInvocationServices' | 'respondToPermissionRequest' | 'abortPendingPermissionRequests' | 'onTurnTerminal' | 'resolveStructuredInputForDispatch'
>;

export type NativeAgentRuntimeLeaseIdentity = Readonly<{
    pluginId: string;
    pluginVersion: string;
    agentId: string;
    localAgentId: string;
    occurrenceId: string;
    isCurrent(): boolean;
}>;

const RUN_SESSION_PROJECTION_UNAVAILABLE_CODE = 'agent_run_session_projection_unavailable';

export function createRunScopedWorkStateService(signal: AbortSignal): WorkStateService {
    return Object.freeze({
        publisher: () => Object.freeze({
            async publish() {
                signal.throwIfAborted();
                return {
                    status: 'unavailable' as const,
                    diagnostic: {
                        code: RUN_SESSION_PROJECTION_UNAVAILABLE_CODE,
                        severity: 'error' as const,
                    },
                };
            },
        }),
    });
}

/**
 * Owns the detached Run's one truthful interaction/permission binding. The
 * context carries execution-run scope and only scope-neutral host services; it
 * has no ApiSessionClient and cannot create a Happier Session, Pending row,
 * transcript, or Session projection.
 */
export function createNativeAgentExecutionRunContextLeaseFactory(params: Readonly<{
    lease: NativeAgentRuntimeLeaseIdentity;
    onToolNormalizationSource?: CreateCliExecutionRunBackendParams['onToolNormalizationSource'];
    runId: string;
    controllerOccurrenceId: string;
    callId: string;
    sidechainId: string;
    resolveAcpHostLaunch?: Parameters<typeof createPublicAcpRuntimeProtocols>[0]['resolveHostLaunch'];
    acpRuntimeDefinition?: Parameters<typeof createPublicAcpRuntimeProtocols>[0]['runtimeDefinition'];
    transformAgentRequest?: Parameters<typeof createPublicAcpRuntimeProtocols>[0]['transformAgentRequest'];
    runtimeRegistry: ResolvedExecutablePluginRuntimeRegistry | null;
    runtimeAuthority?: PluginRuntimeAuthoritySnapshotV1;
    directory: string;
    machineId: string;
    accountSettings: AccountSettings | null;
    resolveAccountSettingsSnapshot?: import('@/settings/accountSettings/activeAccountSettingsSnapshot').AccountSettingsSnapshotResolver;
    permissionMode: string;
    workspaceWrites?: 'allow' | 'deny';
    start: ExecutionRunBackendStartContext;
    causalPermissionAuthority?: CreateCliExecutionRunBackendParams['causalPermissionAuthority'];
    getPermissionRequestStore?: CreateCliExecutionRunBackendParams['getPermissionRequestStore'];
    capabilitySelection?: SessionCapabilitySelectionV1;
    happyHomeDir?: string;
    agent?: EngineResolutionAgent;
    sourceEnvironment?: Readonly<Record<string, string>>;
    refreshRuntimeAuthViaDaemon?: CreateCliExecutionRunBackendParams['connectedServiceRuntimeAuthRefresh'];
    createInvocationServices?: (params: Readonly<{
        currentSession: HostCurrentSessionUiServices;
        actionTarget: NonNullable<ActionExecutorContext['externalActionTarget']>;
        signal: AbortSignal;
        readActiveTurnAdmissionWitness?: () => AgentInvocationTurnAdmissionWitness | null;
        actionRequestAttributionV1?: ActionRequestAttributionV1;
    }>) => Promise<PluginServices>;
}>): NativeAgentExecutionRunContextLeaseFactory {
    const runId = readRequiredString(params.runId, 'a run id');
    const callId = readRequiredString(params.callId, 'a call id');
    const sidechainId = readRequiredString(params.sidechainId, 'a sidechain id');
    let readMcpToolContext: () => McpToolPolicyContext | null = () => null;
    const permissionHandler = createExecutionRunPermissionHandler({
        permissionMode: params.permissionMode,
        ...(params.start.allowedTools !== undefined ? { allowedTools: params.start.allowedTools } : {}),
        ...(params.start.unlistedTools !== undefined ? { unlistedTools: params.start.unlistedTools } : {}),
        workspaceWrites: params.workspaceWrites,
        backendId: params.lease.agentId,
        getMcpToolContext: () => readMcpToolContext(),
        getPermissionRequestStore: params.getPermissionRequestStore,
        ...(Object.hasOwn(params, 'causalPermissionAuthority')
            ? { causalPermissionAuthority: params.causalPermissionAuthority }
            : {}),
        publishPendingRequest: async (request) => {
            const { requestId, toolName, toolInput } = request;
            const requestStore = params.getPermissionRequestStore?.() ?? null;
            if (!requestStore) {
                throw Object.assign(
                    new Error('Execution-run permission interaction target is unavailable'),
                    { code: 'execution_run_interaction_unavailable' },
                );
            }
            const providerRequestId = readRunScopedExecutionProviderRequestId({
                runId,
                controllerOccurrenceId: params.controllerOccurrenceId,
                requestId,
            });
            if (!providerRequestId) {
                throw new Error('Execution-run permission request id does not belong to this run');
            }
            const envelope = buildExecutionRunPermissionRequestEnvelope({
                sessionId: null,
                runId,
                callId,
                sidechainId,
                backendId: params.lease.agentId,
                runtimeKind: 'native_agent_session',
                permissionMode: params.permissionMode,
                providerRequestId,
                controllerOccurrenceId: params.controllerOccurrenceId,
                providerPayload: toolInput,
                toolName,
                reason: toolName,
            });
            const publication = {
                ...request,
                createdAt: envelope.createdAtMs,
                source: request.source ?? 'execution_run',
                responseTarget: envelope.responseTarget,
                sidechainId,
            };
            if (requestStore.publishRequestAndWait) {
                await requestStore.publishRequestAndWait(publication);
            } else {
                requestStore.publishRequest(publication);
            }
        },
    });
    const runPermissionScope = createRunScopedExecutionPermissionHandler({
        parentSessionId: null,
        runId,
        controllerOccurrenceId: params.controllerOccurrenceId,
        handler: permissionHandler,
        readInteractionMode: (requestKind) => {
            const requestStore = params.getPermissionRequestStore?.() ?? null;
            const { intent, runClass, ioMode, retentionPolicy } = params.start;
            if (!intent || !runClass || !ioMode || !retentionPolicy) {
                return 'interaction_unavailable';
            }
            return resolveExecutionRunPermissionInteractionMode({
                requestKind,
                intent,
                runClass,
                ioMode,
                retentionPolicy,
                permissionMode: params.permissionMode,
                parentSessionId: null,
                interactionTargetAvailable: requestStore !== null,
                backendCapabilities: {
                    canRespondToPermission: true,
                    canSurfaceParentSessionPrompt: true,
                    runtimeKind: 'native_agent_session',
                    backendId: params.lease.agentId,
                },
            });
        },
        onPendingRequestAborted: async ({ requestId, reason }) => {
            await params.getPermissionRequestStore?.()?.completeRequest?.({
                requestId,
                status: 'canceled',
                decision: 'abort',
                reason,
                extraCompletedFields: { responseTarget: undefined },
            });
        },
    });
    const bindInvocationServices = async ({
        services,
        signal,
        onInteractionUnavailable,
        readActiveTurnAdmissionWitness,
        actionRequestAttributionV1,
    }: Readonly<{
        services: PluginServices;
        signal: AbortSignal;
        onInteractionUnavailable?: () => void;
        readActiveTurnAdmissionWitness?: () => AgentInvocationTurnAdmissionWitness | null;
        actionRequestAttributionV1?: ActionRequestAttributionV1;
    }>): Promise<Readonly<{
        services: PluginServices;
        currentSession: HostCurrentSessionUiServices;
    }>> => {
        const currentSession = createNativeAgentCurrentExecutionRunUiServices({
            permissionHandler: runPermissionScope.handler,
            pluginId: params.lease.pluginId,
            contributionId: params.lease.localAgentId,
            runtimeId: `native-agent-run:${runId}`,
            executionRunId: runId,
            ...(onInteractionUnavailable ? { onUnavailable: onInteractionUnavailable } : {}),
            occurrenceId: params.lease.occurrenceId,
            isCurrent: params.lease.isCurrent,
            signal,
            readActiveTurnAdmissionWitness,
        });
        const boundServices = params.createInvocationServices
            ? await params.createInvocationServices({
                currentSession,
                actionTarget: { kind: 'machine', machineId: params.machineId,
                    project: { machineId: params.machineId, directory: params.directory } },
                signal,
                ...(readActiveTurnAdmissionWitness ? { readActiveTurnAdmissionWitness } : {}),
                ...(!readActiveTurnAdmissionWitness && actionRequestAttributionV1 ? { actionRequestAttributionV1 } : {}),
            })
            : services;
        return Object.freeze({ services: boundServices, currentSession });
    };
    const factory: NativeAgentExecutionRunContextLeaseFactory = async ({ services, signal, onInteractionUnavailable, readActiveTurnAdmissionWitness, actionRequestAttributionV1 }) => {
        const bound = await bindInvocationServices({
            services,
            signal,
            ...(onInteractionUnavailable ? { onInteractionUnavailable } : {}),
            ...(readActiveTurnAdmissionWitness ? { readActiveTurnAdmissionWitness } : {}),
            ...(!readActiveTurnAdmissionWitness && actionRequestAttributionV1 ? { actionRequestAttributionV1 } : {}),
        });
        const nativeHome = params.agent ? await resolveNativeAgentSessionNativeHomeService({
            agent: params.agent,
            sourceEnvironment: params.sourceEnvironment ?? {},
        }) : null;
        signal.throwIfAborted();
        let resolvedRunMcpServers: readonly ResolvedSessionMcpServer[] = [];
        const pluginAttachments: Readonly<{ dispose(): void | Promise<void> }>[] = [];
        const disposeAttachments = async () => { await Promise.all(pluginAttachments.splice(0).map(attachment => attachment.dispose())); };
        const executionRunServices = createNativeAgentExecutionRunHostServices({
            permissions: createNativeAgentExecutionRunPermissions({
                permissionHandler: {
                    handleToolCall: runPermissionScope.handler.handleToolCall,
                    settleObservedDecision: runPermissionScope.settleObservedDecision,
                },
                pluginId: params.lease.pluginId,
                runtimeId: `native-agent-run:${runId}`,
                isCurrent: params.lease.isCurrent,
                signal,
                readPermissionMode: () => params.permissionMode,
                ...(onInteractionUnavailable ? { onUnavailable: onInteractionUnavailable } : {}),
                ...(readActiveTurnAdmissionWitness ? { readActiveTurnAdmissionWitness } : {}),
            }),
            readResolvedMcpServers: () => resolvedRunMcpServers,
            signal,
            executionRunId: runId,
            directory: params.directory,
            machineId: params.machineId,
            accountSettings: params.accountSettings,
            resolveAccountSettingsSnapshot: params.resolveAccountSettingsSnapshot,
            ...(params.capabilitySelection ? { capabilitySelection: params.capabilitySelection } : {}),
            runtimeRegistry: params.runtimeRegistry,
            ...(params.runtimeAuthority ? { runtimeAuthority: params.runtimeAuthority } : {}),
            pluginId: params.lease.pluginId,
            agentId: params.lease.agentId,
            ...(params.happyHomeDir ? { happyHomeDir: params.happyHomeDir } : {}),
            ...(nativeHome ? { nativeHome } : {}),
            ...(params.refreshRuntimeAuthViaDaemon ? { refreshRuntimeAuthViaDaemon: params.refreshRuntimeAuthViaDaemon } : {}),
        });
        let context: AgentExecutionRunRuntimeContextV1;
        let happierBridge: Awaited<ReturnType<typeof createNativeRunHappierMcpBridge>> | undefined;
        let mcpMaterial: Awaited<ReturnType<typeof materializeMcpServerConfigRecord>> | null = null;
        let mcpServers: AgentSessionOpenRequest['mcpServers'];
        let mcpServersStrictMode: AgentSessionOpenRequest['mcpServersStrictMode'];
        let mcpToolPolicy: AgentSessionOpenRequest['mcpToolPolicy'];
        try {
            if (params.capabilitySelection?.mcp && (params.capabilitySelection.mcp.managedServersEnabled || params.capabilitySelection.mcp.forceIncludeServerIds.length > 0)) {
                const readExecutionContext = async () => {
                    signal.throwIfAborted();
                    const context = await params.resolveAccountSettingsSnapshot?.readAgentExecutionContext?.(signal);
                    signal.throwIfAborted();
                    if (!context) return refuseMcpExecutionSource('requester_authority_unavailable');
                    return context;
                };
                // The parent host already qualified this Agent and holds its
                // isolation preference. Runs do not reconstruct either from
                // credentials, Session ids or an ambient daemon catalog.
                await readExecutionContext();
                const assertExecutionSupported = async () => {
                    const context = await readExecutionContext();
                    await assertMcpStdioExecutionSupported({ kind: 'requester', identity: context.requesterIdentity },
                        context.isolationEnabled, signal);
                };
                let snapshot = await params.resolveAccountSettingsSnapshot?.({ mcpServerCatalog: true, signal }) ?? null;
                signal.throwIfAborted();
                if (!snapshot) throw new McpServerCatalogUnavailableError('catalog-unobserved');
                const pluginItems = await params.runtimeRegistry?.projectMcpServerItems?.(readMcpServersSettingsFromAccountSettings(snapshot)) ?? [];
                const agentCatalogEntry = params.agent?.catalogEntry;
                const agentToolsDelivery = resolveAgentToolsDelivery(params.lease.agentId, {
                    catalogEntriesById: agentCatalogEntry ? { [params.lease.agentId]: agentCatalogEntry } : {},
                });
                const select = (admitted: NonNullable<typeof snapshot>) => resolveSessionCapabilitiesForDirectory({
                    settings: readMcpServersSettingsFromAccountSettings(admitted),
                    machineId: params.machineId, directory: params.directory, selection: params.capabilitySelection,
                    agentId: params.lease.agentId, agentAcceptsUserMcp: agentReceivesUserMcpServersV1(agentToolsDelivery),
                    mcpPluginItems: pluginItems,
                });
                let selected = select(snapshot);
                if (Object.values(selected.selectedServersByName).some(server => server.enabled)) {
                    await assertExecutionSupported();
                }
                const references = listSelectedMcpSharedSecretReferences(selected.selectedServersByName);
                if (references.length > 0) {
                    snapshot = await params.resolveAccountSettingsSnapshot?.({ mcpServerCatalog: true, savedSecretReferences: references, signal }) ?? null;
                    signal.throwIfAborted();
                    if (!snapshot) throw new McpServerCatalogUnavailableError('catalog-unobserved');
                    selected = select(snapshot);
                }
                if (Object.values(selected.selectedServersByName).some(server => server.enabled)) {
                    await assertExecutionSupported();
                }
                if (params.runtimeRegistry?.materializePluginMcpServers) {
                    const attached = await params.runtimeRegistry.materializePluginMcpServers({ scope: { kind: 'execution_run', executionRunId: runId },
                        directory: params.directory, signal, currentSession: bound.currentSession,
                        servers: Object.values(selected.selectedServersByName).map(server => ({ id: server.serverId, name: server.name,
                            transport: server.config.remote ? { kind: 'http' as const, url: server.config.remote.url } : { kind: 'stdio' as const },
                            scope: { executionRunId: runId, directory: params.directory } })),
                        addDisposable: attachment => pluginAttachments.push(attachment) });
                    selected = { ...selected, selectedServersByName: Object.fromEntries(attached.map(server => [server.name,
                        applyAttachedPluginMcpTransport(selected.selectedServersByName[server.name]!, server.transport)])) };
                }
                mcpMaterial = await materializeMcpServerConfigRecord({
                    resolved: { directory: params.directory, strictMode: selected.strictMode, serversByName: selected.selectedServersByName },
                    savedSecretMaterializer: await acquireSavedSecretMaterializerForOperation({ snapshot,
                        references: listSelectedMcpSharedSecretReferences(selected.selectedServersByName),
                        operationContext: params.resolveAccountSettingsSnapshot?.readOperationContext?.() ?? undefined,
                        secretSources: params.runtimeRegistry?.secretSources, signal }),
                    processEnv: { ...sessionProcessEnvironment(), ...params.sourceEnvironment }, tmpDir: null,
                });
                const settings = readMcpServersSettingsFromAccountSettings(snapshot);
                const identities = { mcpServerIdentities: Object.fromEntries(Object.entries(selected.mcpServerIdentities)
                    .filter(([name]) => Object.hasOwn(mcpMaterial!.mcpServers, name))) };
                mcpServers = await resolveAgentSessionMcpLaunchConfigs(mcpMaterial.mcpServers, params.start, signal);
                mcpServersStrictMode = selected.strictMode;
                resolvedRunMcpServers = projectResolvedMcpServers({ mcpServers: mcpMaterial.mcpServers,
                    identities: identities.mcpServerIdentities, scope: { executionRunId: runId, directory: params.directory } });
                const capturedMcpAccount = params.resolveAccountSettingsSnapshot?.readOperationContext?.();
                const activeScope = getActiveAccountSettingsSnapshot()?.scopeKey;
                const activeLifetime = getActiveAccountSettingsSnapshotLifetimeToken();
                if (capturedMcpAccount && capturedMcpAccount.readSnapshot()?.scopeKey === snapshot.scopeKey) {
                    readMcpToolContext = () => ({ mcpServerIdentities: identities.mcpServerIdentities, catalog: capturedMcpAccount.readSnapshot()?.mcpServerCatalog ?? null });
                } else if (activeScope && activeScope === snapshot.scopeKey && getActiveAccountSettingsSnapshot()?.mcpServerCatalog?.status === 'ready') {
                    readMcpToolContext = () => ({ mcpServerIdentities: identities.mcpServerIdentities,
                        prepareCatalog: async () => params.resolveAccountSettingsSnapshot?.({ mcpServerCatalog: true, signal }),
                        catalog: getActiveAccountSettingsSnapshot()?.scopeKey === activeScope
                            && getActiveAccountSettingsSnapshotLifetimeToken() === activeLifetime
                            ? getActiveAccountSettingsSnapshot()?.mcpServerCatalog ?? null : null });
                }
                if (readMcpToolContext()) {
                    const control = agentCatalogEntry?.mcpToolControl;
                    if (control?.approval === 'host') {
                        mcpToolPolicy = projectMcpToolLaunchPolicies({ catalog: { v: 1, servers: settings.servers, bindings: settings.bindings,
                            ...(settings.pluginServers ? { pluginServers: settings.pluginServers } : {}) },
                            mcpServerIdentities: identities.mcpServerIdentities, control,
                            permissionMode: parseAgentPermissionIntentV1Alias(params.permissionMode) ?? 'default' });
                    }
                }
                signal.throwIfAborted();
            }
            const placement = await admitAgentNativeMcpPlacementForHost(bound.services.exec, signal);
            if (placement) {
                happierBridge = await createNativeRunHappierMcpBridge({ services: bound.services, placement,
                    signal, directory: params.directory, machineId: params.machineId });
                mcpServers = { ...mcpServers, happier: happierBridge.mcpServer };
            }
            const created = createNativeAgentInvocationContext({
                lease: params.lease,
                onToolNormalizationSource: params.onToolNormalizationSource,
                runId,
                signal,
                services: bound.services,
                invokedAtMs: Date.now(),
                currentSession: bound.currentSession,
                executionRunServices,
                ...(happierBridge ? { readSessionMcpContext: happierBridge.readContext } : {}),
                ...(placement?.kind === 'prepared' ? { nativeOperation: placement.nativeAdmission } : {}),
                ...(placement ? { nativeAdmission: placement.nativeAdmission } : {}),
                ...(readActiveTurnAdmissionWitness ? { readActiveTurnAdmissionWitness } : {}),
                ...(params.resolveAcpHostLaunch || params.transformAgentRequest || params.acpRuntimeDefinition
                    ? {
                        protocolOptions: {
                            ...(params.resolveAcpHostLaunch ? { resolveHostLaunch: params.resolveAcpHostLaunch } : {}),
                            ...(params.acpRuntimeDefinition ? { runtimeDefinition: params.acpRuntimeDefinition } : {}),
                            ...(params.transformAgentRequest ? { transformAgentRequest: params.transformAgentRequest } : {}),
                        },
                    }
                    : {}),
            });
            if (!('executionRun' in created)) {
                throw new Error('Detached execution-run context was not constructed');
            }
            context = created;
        } catch (error) {
            try {
                try { mcpMaterial?.cleanup(); }
                finally { try { await happierBridge?.dispose(); } finally { try { await disposeAttachments(); } finally { await executionRunServices.dispose(); } } }
            } finally {
                await runPermissionScope.dispose('Execution run context construction failed');
            }
            throw error;
        }
        return Object.freeze({
            context,
            ...(mcpServers ? { mcpServers } : {}),
            ...(mcpServersStrictMode !== undefined ? { mcpServersStrictMode } : {}),
            ...(mcpToolPolicy ? { mcpToolPolicy } : {}),
            async dispose() {
                try {
                    try { mcpMaterial?.cleanup(); }
                    finally { try { await happierBridge?.dispose(); } finally { try { await disposeAttachments(); } finally { await executionRunServices.dispose(); } } }
                } finally {
                    await runPermissionScope.dispose('Execution run disposed');
                }
            },
        });
    };
    Object.assign(factory, {
        async resolveStructuredInputForDispatch(input: Readonly<{
            input: AgentSessionInput;
            localId: string;
            signal: AbortSignal;
        }>) {
            const parsed = HappierStructuredInputV1Schema.safeParse(input.input.structuredInput);
            if (!parsed.success) return { ...input.input, text: renderSessionInputContextPromptV1({ transformedUserText: input.input.text }) };
            const envelope = parsed.data as Readonly<Record<string, unknown>>;
            if (!Object.hasOwn(envelope, 'mentions') && !Object.hasOwn(envelope, 'composerAttachments')) {
                return { ...input.input, text: renderSessionInputContextPromptV1({ transformedUserText: input.input.text }) };
            }
            const resolved = await resolveStructuredInputProviderDispatchContext({
                structuredInput: parsed.data,
                ...(params.runtimeRegistry?.composerReferences
                    ? {
                        composerReferences: {
                            resolve: params.runtimeRegistry.composerReferences.resolve,
                            signal: input.signal,
                        },
                    }
                    : {}),
                ...(params.runtimeRegistry?.composerAttachments
                    ? {
                        composerAttachments: {
                            scope: { kind: 'execution_run', executionRunId: runId },
                            localId: input.localId,
                            resolve: params.runtimeRegistry.composerAttachments.resolveForDispatch,
                            signal: input.signal,
                        },
                    }
                    : {}),
            });
            return Object.freeze({
                text: renderSessionInputContextPromptV1({
                    ...resolved.promptContext,
                    transformedUserText: input.input.text,
                }),
                ...(resolved.structuredInput ? { structuredInput: resolved.structuredInput } : {}),
            });
        },
        async bindInvocationServices(input: Readonly<{
            services: PluginServices;
            signal: AbortSignal;
            readActiveTurnAdmissionWitness?: () => AgentInvocationTurnAdmissionWitness | null;
        }>) {
            return (await bindInvocationServices(input)).services;
        },
        respondToPermissionRequest(requestId: string, approved: boolean, response?: PermissionResult) {
            return runPermissionScope.respondToPermissionRequest(requestId, response ?? approved);
        },
        async abortPendingPermissionRequests(reason: string) {
            await runPermissionScope.dispose(reason);
        },
        async onTurnTerminal(turnId: string) {
            await params.getPermissionRequestStore?.()?.retireCompletedRequestsForTurn?.(turnId);
        },
    });
    return factory;
}

function diagnosticMessage(
    diagnostic: Readonly<{ code: string; message?: string }> | undefined,
    sanitize: (value: string) => string,
): string {
    return sanitize(diagnostic?.message ?? diagnostic?.code ?? 'Native Agent execution run failed');
}

function createDisposedError(): Error {
    const error = new Error('Native Agent execution run disposed');
    error.name = 'AbortError';
    return error;
}

function toHostMessage(
    event: Exclude<AgentExecutionRunEvent, { kind: 'usage-observed' }>,
    sanitize: (value: string) => string,
): AgentMessage | null {
    switch (event.kind) {
        case 'run-start':
        case 'run-progress':
            return { type: 'status', status: 'running' };
        case 'output-delta':
            return event.channel === 'assistant'
                ? { type: 'model-output', textDelta: event.text,
                    ...(event.messageId ? { messageId: event.messageId } : {}) }
                : { type: 'event', name: 'thinking', payload: { textDelta: event.text } };
        case 'output-message-committed':
            return { type: 'model-output', messageId: event.messageId, fullText: event.text };
        case 'checkpoint':
            return {
                type: 'event',
                name: 'provider_session_id',
                payload: { sessionId: event.checkpointId },
            };
        case 'run-complete':
        case 'run-cancelled':
            return { type: 'status', status: 'stopped' };
        case 'run-failed':
            return {
                type: 'status',
                status: 'error',
                detail: diagnosticMessage(event.diagnostic, sanitize),
            };
    }
}

function sessionEventToHostMessage(
    event: AgentExecutionRunConversationEventV1,
    sanitize: (value: string) => string,
): AgentMessage | null {
    switch (event.kind) {
        case 'tool-call':
            return event.turnId !== undefined && event.sidechainId === undefined
                ? { type: 'tool-call', callId: event.toolCallId, toolName: event.toolName, args: event.input }
                : null;
        case 'tool-result':
            return event.turnId !== undefined && event.sidechainId === undefined
                ? { type: 'tool-result', callId: event.toolCallId, result: event.output,
                    ...(event.isError === undefined ? {} : { isError: event.isError }) }
                : null;
        case 'message-delta':
            if (event.turnId === undefined || event.sidechainId !== undefined) return null;
            return event.channel === 'assistant'
                ? { type: 'model-output', textDelta: event.text,
                    ...(event.messageId ? { messageId: event.messageId } : {}) }
                : { type: 'event', name: 'thinking', payload: { textDelta: event.text } };
        case 'transcript-message-committed':
            return event.role === 'assistant' && event.turnId !== undefined && event.sidechainId === undefined
                ? { type: 'model-output', messageId: event.messageId, fullText: event.text }
                : null;
        case 'provider-session-id':
            return { type: 'event', name: 'provider_session_id', payload: { sessionId: event.providerSessionId } };
        case 'turn-start':
        case 'turn-progress':
            return { type: 'status', status: 'running' };
        case 'turn-complete':
        case 'turn-cancelled':
            return { type: 'status', status: 'stopped' };
        case 'turn-failed':
            return {
                type: 'status',
                status: 'error',
                detail: sanitize(event.diagnostic.message ?? event.diagnostic.code),
            };
        case 'runtime-ended':
            return {
                type: 'status',
                status: 'error',
                detail: sanitize(event.diagnostic?.message ?? event.diagnostic?.code ?? event.cause),
            };
        default:
            return null;
    }
}

function buildInput(prompt: string, structuredInput: unknown): AgentSessionInput {
    const parsed = AgentRuntimeJsonValueV1Schema.safeParse(structuredInput);
    return Object.freeze({
        text: prompt,
        ...(structuredInput !== undefined && parsed.success ? { structuredInput: parsed.data } : {}),
    });
}

/** Consume the selected model's admission fact; unsupported models keep the prompt contract. */
function withSupportedNativeOutputSchema(input: AgentSessionInput, supported: boolean | undefined): AgentSessionInput {
    if (supported === true || input.outputSchema === undefined) return input;
    const { outputSchema: _outputSchema, ...promptInput } = input;
    return promptInput;
}

/** The Run's prepared metadata-only index follows its own Agent and selection. */
function withRunSkillIndex(input: AgentSessionInput, skillIndex: string | undefined): AgentSessionInput {
    return skillIndex ? { ...input, text: `${skillIndex}\n\n${input.text}` } : input;
}

function sanitizeNativeProviderDiagnostic(
    diagnostic: AgentRuntimeDiagnosticDataV1,
    sanitize: (value: string) => string,
): AgentRuntimeDiagnosticDataV1 {
    const { remediation, ...withoutRemediation } = diagnostic;
    const projected = { ...withoutRemediation, code: sanitize(diagnostic.code),
        ...(diagnostic.message === undefined ? {} : { message: sanitize(diagnostic.message) }),
        ...(diagnostic.details === undefined ? {} : { details: redactPluginInvocationResultData(diagnostic.details, sanitize) }),
    };
    const parsed = AgentRuntimeDiagnosticDataV1Schema.safeParse({ ...projected,
        ...(remediation ? { remediation: redactPluginInvocationResultData(remediation, sanitize) } : {}),
    });
    if (parsed.success) return parsed.data;
    // A redacted URL or identifier can cease to satisfy the remediation schema.
    const fallback = AgentRuntimeDiagnosticDataV1Schema.safeParse(projected);
    return fallback.success ? fallback.data : { code: 'agent_execution_run_failed', severity: diagnostic.severity };
}

function runInputBudget(maxInputUnicodeCharacters: number, skillIndex: string | undefined): number {
    let reservation = 0;
    for (const _character of withRunSkillIndex({ text: '' }, skillIndex).text) reservation++;
    return Math.max(0, maxInputUnicodeCharacters - reservation);
}

function rejectStructuredInputBeforeProviderEffect(error: unknown) {
    const candidate = error && typeof error === 'object'
        ? error as Readonly<{ code?: unknown; message?: unknown; retryable?: unknown }>
        : null;
    return Object.freeze({
        status: 'rejected' as const,
        diagnostic: Object.freeze({
            code: typeof candidate?.code === 'string'
                ? candidate.code
                : 'session_structured_input_resolution_unavailable',
            ...(typeof candidate?.message === 'string' ? { message: candidate.message } : {}),
            severity: 'error' as const,
        }),
        retryable: candidate?.retryable === true,
    });
}

function readRequiredString(value: string | undefined, field: string): string {
    const normalized = value?.trim();
    if (!normalized) {
        throw new Error(`Native Agent execution run requires ${field}`);
    }
    return normalized;
}

function resolveExecutionProfileReference(
    profileId: string,
    fallbackPluginId: string,
): Readonly<{ pluginId: string; localId: string }> {
    const separatorIndex = profileId.indexOf('/');
    if (separatorIndex > 0) {
        const qualified = PluginContributionIdentityV1Schema.safeParse({
            pluginId: profileId.slice(0, separatorIndex),
            localId: profileId.slice(separatorIndex + 1),
        });
        if (qualified.success) return Object.freeze(qualified.data);
    }
    return Object.freeze(PluginContributionIdentityV1Schema.parse({
        pluginId: fallbackPluginId,
        localId: profileId,
    }));
}

function buildLaunchEnvironment(
    options: CreateCliExecutionRunBackendParams,
): AgentLaunchEnvironment {
    return resolveNativeAgentLaunchEnvironment({
        processEnv: sessionProcessEnvironment(),
        environmentVariables: options.isolation?.env,
        unsetEnvironmentVariables: options.isolation?.unsetEnvKeys,
    });
}

function createNativeAgentInvocationContext(params: Readonly<{
    lease: NativeAgentRuntimeLeaseIdentity;
    onToolNormalizationSource?: CreateCliExecutionRunBackendParams['onToolNormalizationSource'];
    runId: string;
    signal: AbortSignal;
    services: PluginServices;
    invokedAtMs: number;
    protocolOptions?: Pick<
        Parameters<typeof createPublicAcpRuntimeProtocols>[0],
        'resolveHostLaunch' | 'transformAgentRequest' | 'runtimeDefinition'
    >;
    currentSession?: Parameters<typeof createPluginInvocationPresentation>[0]['currentSession'];
    readActiveTurnAdmissionWitness?: () => AgentInvocationTurnAdmissionWitness | null;
    executionRunServices?: AgentExecutionRunHostServicesV1;
    readSessionMcpContext?: () => SessionMcpLocalContext | undefined;
    nativeOperation?: HostAgentIsolationLaunchContext;
    nativeAdmission?: HostAgentIsolationLaunchContext;
}>): AgentExecutionRunRuntimeContextV1 {
    const interactions = params.currentSession
        ? createPluginInteractionsService({
            currentSession: params.currentSession,
            signal: params.signal,
            isOccurrenceCurrent: params.lease.isCurrent,
            ...(params.readActiveTurnAdmissionWitness
                ? { readActiveTurnAdmissionWitness: params.readActiveTurnAdmissionWitness }
                : {}),
        })
        : null;
    const services = interactions
        ? Object.freeze({ ...params.services, interactions })
        : params.services;
    const nativeLaunch = issueAgentNativeLaunchQualifierForHost(services.exec, params.readSessionMcpContext, undefined,
        params.nativeOperation, 'auxiliary', params.nativeAdmission);
    const base = Object.freeze({
        plugin: Object.freeze({ id: params.lease.pluginId, version: params.lease.pluginVersion }),
        contribution: Object.freeze({
            id: params.lease.localAgentId,
            qualifiedId: resolveAgentContributionQualifiedId({
                pluginId: params.lease.pluginId,
                localId: params.lease.localAgentId,
            }),
        }),
        surface: 'agent' as const,
        invokedAtMs: params.invokedAtMs,
        signal: params.signal,
        services,
        ui: createPluginInvocationPresentation({
            currentSession: params.currentSession ?? null,
            signal: params.signal,
            isOccurrenceCurrent: params.lease.isCurrent,
        }),
        agent: Object.freeze({ id: params.lease.agentId }),
        protocols: createPublicAcpRuntimeProtocols({
            onSessionOpening: () => params.onToolNormalizationSource?.({
                protocol: 'acp', agent: { pluginId: params.lease.pluginId, localId: params.lease.localAgentId },
            }),
            pluginId: params.lease.pluginId,
            agentId: params.lease.agentId,
            signal: params.signal,
            isCurrent: params.lease.isCurrent,
            services,
            nativeLaunch,
            ...(params.currentSession
                ? { interactions: params.currentSession.interactions }
                : {}),
            ...(params.protocolOptions ?? {}),
        }),
    });
    const unavailable = (): never => {
        throw new Error('Detached execution-run host service is unavailable');
    };
    const executionRunServices = params.executionRunServices ?? Object.freeze({
        features: Object.freeze({ isEnabled: () => false }),
        hooks: Object.freeze({
            observeSessionHook: unavailable,
            startServer: unavailable,
            resolveForwarderAssets: unavailable,
            createPluginDir: unavailable,
            disposePluginDir: unavailable,
        }),
        fileFollow: Object.freeze({ follow: unavailable }),
        mcp: Object.freeze({ resolveServers: async () => Object.freeze([]) }),
        toolExecution: Object.freeze({
            async before(request: Parameters<AgentExecutionRunHostServicesV1['toolExecution']['before']>[0]) {
                return Object.freeze({ status: 'continue' as const, input: request.input });
            },
        }),
    });
    return Object.freeze({
        ...base,
        scope: Object.freeze({ kind: 'execution_run' as const, executionRunId: params.runId }),
        executionRun: Object.freeze({ id: params.runId, services: Object.freeze({ ...executionRunServices, nativeLaunch }) }),
    });
}

export function createNativeAgentExecutionRunHostRuntime(params: Readonly<{
    runtime: AgentRuntime;
    /** Additive detached facet for a Session-primary Agent. */
    executionRunContextV1?: AgentSessionExecutionRunRuntimeFactoryV1;
    /** Host-selected retained interaction; never changes the finite V1 facet. */
    retainedConversation?: boolean;
    lease: NativeAgentRuntimeLeaseIdentity;
    options: CreateCliExecutionRunBackendParams;
    supportsResume: boolean;
    readMaxInputUnicodeCharacters?: () => number | null | Promise<number | null>;
    /** Session-derived carriers intercept native turn failures before this projection. */
    sessionTurnRecoveryOwned?: boolean;
    generationSignal?: AbortSignal;
    services?: Promise<PluginServices>;
    createExecutionRunContext?: NativeAgentExecutionRunContextLeaseFactory;
    bindInvocationServices?: NativeAgentSessionContextLeaseFactory['bindInvocationServices'];
    respondToPermissionRequest?: NativeAgentSessionContextLeaseFactory['respondToPermissionRequest'];
    abortPendingPermissionRequests?: (reason: string) => Promise<void>;
    resolveStructuredInputForDispatch?: NativeAgentSessionContextLeaseFactory['resolveStructuredInputForDispatch'];
}>): ExecutionRunHostRuntime {
    const directExecutionRuns = params.runtime.executionRuns;
    // Session-derived Runs receive intent through the host profile's prepared prompt.
    // Only the explicit executionRuns facet (e.g. native review engines) consumes
    // intent metadata as its own structured payload; Session media is separate.
    const structuredInput = params.options.start?.structuredInput
        ?? (!params.executionRunContextV1 && !params.sessionTurnRecoveryOwned
            ? params.options.start?.intentInput : undefined);

    if (!params.executionRunContextV1 && !directExecutionRuns) {
        throw new Error(`Agent runtime '${params.lease.agentId}' does not support execution runs`);
    }
    if (params.retainedConversation && !params.executionRunContextV1?.openConversation) {
        throw createExecutionRunCodedError('execution_run_protocol_unsupported', 'Agent does not support retained detached conversations');
    }
    const runId = readRequiredString(params.options.runId, 'a run id');
    const profileId = readRequiredString(
        // Host intent keys use underscores; portable contribution ids use hyphens.
        params.options.start?.profileId ?? params.options.start?.intent?.replaceAll('_', '-'),
        'an execution profile id',
    );
    const profile = resolveExecutionProfileReference(profileId, params.lease.pluginId);
    const launchEnvironment = buildLaunchEnvironment(params.options);
    const configuration = params.options.configuration
        ?? (params.options.workspaceWrites === undefined ? undefined : buildExecutionRunConfiguration({
            backendTarget: params.options.backendTarget ?? { kind: 'backend', backendId: params.options.backendId },
            modelId: params.options.modelId,
            modelSelection: params.options.modelSelection,
            modelSelectionSource: params.options.modelSelectionSource,
            sessionConfigOptionOverrides: params.options.sessionConfigOptionOverrides,
            acpSessionModeId: params.options.start?.acpSessionModeId,
            permissionMode: params.options.permissionMode,
            workspaceWrites: params.options.workspaceWrites,
            updatedAtMs: 0,
        }).configuration);
    const boundedOpenInputs = Object.freeze({
        stateSharing: resolveNativeAgentSessionStateSharingPolicy(params.lease.agentId),
        ...(launchEnvironment ? { launchEnvironment } : {}),
        ...(params.options.runtimeDescriptorV1
            ? { runtimeDescriptorV1: params.options.runtimeDescriptorV1 }
            : {}),
        ...(params.options.modelSelection
            ? { modelSelection: params.options.modelSelection }
            : {}),
        ...(configuration
            ? { configuration: projectNativeAgentProviderBindingConfiguration({ ...configuration,
                ...(params.options.workspaceWrites !== undefined ? { workspaceWrites: params.options.workspaceWrites } : {}),
            }, params.options.providerBinding) }
            : {}),
        ...(params.options.providerBinding
            ? { providerBinding: params.options.providerBinding }
            : {}),
        ...(params.options.causalPermissionAuthority
            ? { causalPermissionAuthority: params.options.causalPermissionAuthority }
            : {}),
    });
    const sanitizeProviderDiagnosticText =
        params.options.sanitizeProviderDiagnosticText ?? ((value: string) => value);
    const ownedAbortController = new AbortController();
    const signal = params.generationSignal
        ? AbortSignal.any([ownedAbortController.signal, params.generationSignal])
        : ownedAbortController.signal;
    const servicesPromise =
        params.services
        ?? Promise.resolve(createUnavailablePluginServices());
    const listeners = new Set<(message: AgentMessage) => void>();
    let provisionPromise: Promise<Readonly<{ runtimeId: string }>> | null = null;
    let openRequest: AgentExecutionRunOpenRequest | null = null;
    type NativeRun =
        | Readonly<{ kind: 'finite'; runtime: AgentExecutionRunRuntime }>
        | Readonly<{ kind: 'conversation'; runtime: AgentExecutionRunConversationRuntimeV1 }>;
    let nativeRuntimePromise: Promise<NativeRun> | null = null;
    let nativeRuntime: NativeRun | null = null;
    let watchDisposable: { dispose(): void | Promise<void> } | null = null;
    let executionRunContextLease: NativeAgentExecutionRunContextLease | null = null;
    let nativeContextPromise: Promise<AgentExecutionRunRuntimeContextV1> | null = null;
    let lastSequence = -1;
    let terminal = false;
    let disposed = false;
    let openingInitialInput = false;
    let providerWorkObserved = false;
    let rejectedStart: ExecutionRunRejectedStartError | null = null;
    let checkpointId: string | null = null;
    let recovery: AbortController | null = null;
    let admittedInputMeta: (NonNullable<Parameters<AgentExecutionRunRuntime['send']>[1]> & Readonly<{
        effectiveCallerPermissionMode?: string;
        actionRequestAttributionV1?: ActionRequestAttributionV1;
    }>) | undefined;
    let inputTurnOrdinal = 0;
    let activeInputTurn: Readonly<{ turnId: string; inputIds: readonly [string] }> | null = null;
    let conversationTurnSettlement: Promise<void> | null = null;
    const runtimeEventListeners = new Set<(event: ExecutionRunHostRuntimeEvent) => void>();
    let turnSettled = false;
    let resolveTerminal!: () => void;
    let rejectTerminal!: (error: Error) => void;
    let terminalPromise!: Promise<void>;
    function resetTurnCompletion(): void {
        terminalPromise = new Promise<void>((resolve, reject) => {
            resolveTerminal = resolve;
            rejectTerminal = reject;
        });
        void terminalPromise.catch(() => undefined);
    }
    resetTurnCompletion();

    function rejectTurnCompletion(error: Error): void {
        // A later native death cannot change a completed turn's promise, but
        // must remain a failure for the next input's completion observer.
        if (turnSettled) { resetTurnCompletion(); turnSettled = false; }
        rejectTerminal(error);
    }

    function logProviderFailure(phase: 'open' | 'send' | 'stop' | 'event', code: string): void {
        logger.warn('[EXECUTION RUN] provider failure', {
            runId,
            agentId: params.lease.agentId,
            phase,
            // Typed cause only: provider text/details may contain Account data or credentials.
            code: sanitizeProviderDiagnosticText(code),
            selectedMembers: readConnectedServiceChildMemberLogContextFromEnv(launchEnvironment?.values ?? {}),
        });
    }

    function assertUsable(): void {
        if (disposed) throw new Error('Native Agent execution run is disposed');
        if (!params.lease.isCurrent()) {
            throw new Error(`Agent runtime '${params.lease.agentId}' belongs to a retired generation`);
        }
        signal.throwIfAborted();
    }

    function emit(message: AgentMessage): void {
        for (const listener of listeners) {
            try {
                listener(message);
            } catch {
                // One host projection cannot interrupt terminal settlement or later listeners.
            }
        }
    }

    async function resolveInputForDispatch(input: AgentSessionInput, localId: string): Promise<AgentSessionInput> {
        const resolved = params.resolveStructuredInputForDispatch
            ? await params.resolveStructuredInputForDispatch({ input, localId, signal })
            : input;
        return withSupportedNativeOutputSchema(resolved, params.options.selectedModelSupportsStructuredOutput);
    }

    function beginInputTurn(localInputId?: string): Readonly<{ turnId: string; inputIds: readonly [string] }> {
        // This labels host input admission, not the finite SDK adapter's native
        // transport turn. The shared local input id correlates those contexts.
        const ordinal = ++inputTurnOrdinal;
        const turn = { turnId: `${runId}-turn-${ordinal}`,
            inputIds: [localInputId ?? `${runId}-input-${ordinal}`] as const };
        activeInputTurn = turn;
        return turn;
    }

    function readActiveTurnAdmissionWitness(): AgentInvocationTurnAdmissionWitness | null {
        if (!activeInputTurn || terminal || disposed) return null;
        return {
            inputId: activeInputTurn.inputIds[0], turnId: activeInputTurn.turnId,
            userMessageSeq: null, userMessageSeqs: [],
            callerPermissionMode: normalizeExecutionRunPermissionMode(admittedInputMeta?.effectiveCallerPermissionMode ?? params.options.permissionMode),
            ...(admittedInputMeta?.causalPermissionAuthority
                ? { causalPermissionAuthority: admittedInputMeta.causalPermissionAuthority } : {}),
            ...(admittedInputMeta?.actionRequestAttributionV1
                ? { actionRequestAttributionV1: admittedInputMeta.actionRequestAttributionV1 } : {}),
        };
    }

    function failRuntime(message: string, code?: string): void {
        if (terminal) return;
        terminal = true;
        const error = code ? createExecutionRunCodedError(code, message) : new Error(message);
        emit({ type: 'status', status: 'error', detail: message });
        rejectTurnCompletion(error);
    }

    function settleEvent(normalizedEvent: Exclude<AgentExecutionRunEvent, { kind: 'usage-observed' }>): void {
        const message = toHostMessage(normalizedEvent, sanitizeProviderDiagnosticText);
        if (message) emit(message);
        if (normalizedEvent.kind === 'run-complete' || normalizedEvent.kind === 'run-cancelled') {
            activeInputTurn = null;
            // A retained conversation settles this input, while its host Run
            // remains available. Only the finite facet equates the two lifetimes.
            terminal = !params.retainedConversation;
            turnSettled = true;
            if (normalizedEvent.kind === 'run-complete' && !params.sessionTurnRecoveryOwned && params.options.connectedServiceRuntimeTurnCompleted) {
                void params.options.connectedServiceRuntimeTurnCompleted().then(resolveTerminal, resolveTerminal);
            } else resolveTerminal();
        } else if (normalizedEvent.kind === 'run-failed') {
            activeInputTurn = null;
            terminal = true;
            rejectTurnCompletion(normalizedEvent.diagnostic ? createExecutionRunDiagnosticError({
                ...normalizedEvent.diagnostic,
                message: diagnosticMessage(normalizedEvent.diagnostic, sanitizeProviderDiagnosticText),
            }, normalizedEvent.emittedAtMs, params.lease.agentId) : createExecutionRunCodedError(
                'agent_execution_run_failed', diagnosticMessage(undefined, sanitizeProviderDiagnosticText)));
        }
    }

    async function recoverNativeFailure(
        failure: Extract<AgentExecutionRunEvent, { kind: 'run-failed' | 'run-cancelled' }>,
        nativeIdentity: string,
        attempt: AbortController,
    ): Promise<void> {
        const recoverySignal = AbortSignal.any([signal, attempt.signal]);
        try {
            const continued = await continueNativeRuntimeAfterFailure({
                input: {
                    diagnostic: failure.diagnostic!,
                    providerSessionId: nativeIdentity,
                    interruptedOriginId: admittedInputMeta?.localInputId ?? params.options.start?.localInputId ?? `${runId}-initial-input`,
                    signal: recoverySignal,
                },
                prepare: params.options.prepareRuntimeFailureRecovery!,
                async retireNative() {
                    const previous = await nativeRuntimePromise;
                    await watchDisposable?.dispose();
                    watchDisposable = null;
                    nativeRuntime = null;
                    nativeRuntimePromise = null;
                    await previous?.runtime.dispose();
                    await executionRunContextLease?.dispose();
                    executionRunContextLease = null;
                    nativeContextPromise = null;
                },
                async resumeNative(environment) {
                    lastSequence = -1;
                    openRequest = {
                        kind: 'resume', runId, cwd: params.options.cwd, profile,
                        ...boundedOpenInputs,
                        ...(environment ? { launchEnvironment: environment } : {}),
                        checkpointId: nativeIdentity,
                    };
                    await openNative(openRequest);
                },
                async sendContinuation(input) {
                    recovery = null;
                    admittedInputMeta = {
                        ...admittedInputMeta,
                        localInputId: `runtime-continuation:${randomUUID()}`,
                    };
                    const result = await sendNative(nativeRuntime!, { text: input }, {
                        ...admittedInputMeta,
                        signal: recoverySignal,
                    });
                    if (result.status !== 'admitted' && !terminal) {
                        settleEvent({ ...failure, ...(result.diagnostic ? { diagnostic: result.diagnostic } : {}) });
                    }
                },
            });
            if (!continued && !terminal && recovery === attempt) {
                recovery = null;
                settleEvent(failure);
            }
        } catch (error) {
            if (terminal || disposed || recoverySignal.aborted) return;
            recovery = null;
            const diagnostic = error instanceof Error && 'code' in error && typeof error.code === 'string'
                ? sanitizeNativeProviderDiagnostic({ code: error.code, message: error.message, severity: 'error' }, sanitizeProviderDiagnosticText)
                : failure.diagnostic;
            settleEvent({ ...failure, ...(diagnostic ? { diagnostic } : {}) });
        }
    }

    function handleEvent(event: AgentExecutionRunEvent, allowRecovery = true): void {
        const parsed = AgentExecutionRunEventSchema.safeParse(event);
        if (!parsed.success) {
            failRuntime(`Native Agent execution run '${runId}' emitted an invalid runtime event`);
            return;
        }
        const normalizedEvent = 'diagnostic' in parsed.data && parsed.data.diagnostic
            ? { ...parsed.data, diagnostic: sanitizeNativeProviderDiagnostic(parsed.data.diagnostic, sanitizeProviderDiagnosticText) }
            : parsed.data;
        if (normalizedEvent.runId !== runId) {
            failRuntime(`Native Agent execution run emitted an event for unexpected run '${normalizedEvent.runId}'`);
            return;
        }
        if (normalizedEvent.sequence <= lastSequence) {
            failRuntime(`Native Agent execution run '${runId}' emitted a non-monotonic event sequence`);
            return;
        }
        if (terminal) return;
        lastSequence = normalizedEvent.sequence;
        if (normalizedEvent.kind === 'usage-observed') {
            try {
                params.options.start?.observeWorkflowUsage?.({
                    turnId: normalizedEvent.turnId ?? null,
                    observation: toNativeAgentUsageObservation(normalizedEvent, params.lease.agentId),
                });
            } catch {
                // Usage publication cannot change the Run's lifecycle.
            }
            return;
        }
        if (normalizedEvent.kind === 'checkpoint') checkpointId = normalizedEvent.checkpointId;
        if (recovery && normalizedEvent.kind === 'run-cancelled') return;
        if (normalizedEvent.kind === 'run-progress' || normalizedEvent.kind === 'output-delta'
            || normalizedEvent.kind === 'output-message-committed'
            || normalizedEvent.kind === 'run-complete' || normalizedEvent.kind === 'run-cancelled') {
            providerWorkObserved = true;
        }
        if (normalizedEvent.kind === 'run-failed' && openingInitialInput && !providerWorkObserved) {
            const rejection = readExecutionRunRejectedStartDiagnostic(normalizedEvent.diagnostic);
            if (rejection) {
                logProviderFailure('event', rejection.executionRunErrorCode);
                rejectedStart = rejection;
                terminal = true;
                rejectTurnCompletion(rejection);
                return;
            }
        }
        if (normalizedEvent.kind === 'run-failed') {
            activeInputTurn = null;
            logProviderFailure('event', normalizedEvent.diagnostic?.code ?? 'agent_execution_run_failed');
        }
        if (allowRecovery && normalizedEvent.kind === 'run-failed' && normalizedEvent.diagnostic && checkpointId
            // This typed ACP outcome is admission uncertainty, not an accepted
            // turn failure. Provider health facts cannot authorize continuation.
            && normalizedEvent.diagnostic.code !== 'acp_input_custody_unknown'
            && normalizedEvent.diagnostic.code !== 'acp_input_rejected_before_effect'
            && params.supportsResume && params.options.prepareRuntimeFailureRecovery
            && !params.sessionTurnRecoveryOwned && !recovery) {
            const attempt = new AbortController();
            recovery = attempt;
            void recoverNativeFailure(normalizedEvent, checkpointId, attempt);
            return;
        }
        settleEvent(normalizedEvent);
    }

    function handleConversationEvent(event: AgentExecutionRunConversationEventV1): void {
        if (terminal || disposed) return;
        if ('diagnostic' in event && event.diagnostic) {
            event = { ...event, diagnostic: sanitizeNativeProviderDiagnostic(event.diagnostic, sanitizeProviderDiagnosticText) };
        } else if ('issue' in event) {
            event = { ...event, issue: sanitizeNativeProviderDiagnostic(event.issue, sanitizeProviderDiagnosticText) };
        }
        type RunEventInput<Event = AgentExecutionRunEvent> = Event extends AgentExecutionRunEvent
            ? Omit<Event, 'sequence' | 'runId' | 'emittedAtMs'> : never;
        const emitRunEvent = (value: RunEventInput, allowRecovery = true): void => {
            handleEvent({ ...value, runId, sequence: lastSequence + 1, emittedAtMs: event.emittedAtMs ?? Date.now() }, allowRecovery);
        };
        if (event.kind === 'usage-observed') {
            emitRunEvent(event);
            return;
        }
        if (event.kind === 'provider-session-id') {
            emitRunEvent({ kind: 'checkpoint', checkpointId: event.providerSessionId });
            return;
        }
        if (event.kind === 'runtime-ended') {
            // A correlated turn failure already owns recovery; native process
            // exit can repeat that failure while the old runtime is retiring.
            if (recovery) return;
            const allowRecovery = activeInputTurn !== null;
            activeInputTurn = null;
            const fail = () => {
                emitRunEvent({ kind: 'run-failed',
                    diagnostic: event.diagnostic ?? { code: 'agent_execution_run_ended', severity: 'error' } }, allowRecovery);
                // A recovered turn keeps its controller. A definitive end also
                // wakes the Run owner when no turn-completion waiter is active.
                if (terminal) for (const listener of runtimeEventListeners) listener({
                    ...event, emittedAtMs: event.emittedAtMs ?? Date.now(),
                });
            };
            // Native completion can precede its durable host acknowledgement.
            // Preserve that completed input, then expose idle death to future
            // observers without replaying the previous input through recovery.
            if (!allowRecovery && conversationTurnSettlement) void conversationTurnSettlement.then(fail);
            else fail();
            return;
        }
        const active = activeInputTurn;
        if (!active) return;
        if (event.kind === 'input-rejected' || event.kind === 'input-custody-unknown' || event.kind === 'input-delivery-failed') {
            if (event.inputIds.length !== active.inputIds.length || !event.inputIds.every(id => active.inputIds.includes(id))) return;
            if (event.kind === 'input-delivery-failed' && event.delivery.turnId !== active.turnId) return;
            activeInputTurn = null;
            // Typed non-admission/custody facts prohibit continuation regardless
            // of the provider diagnostic's vocabulary or retryability.
            emitRunEvent({ kind: 'run-failed', diagnostic: event.kind === 'input-rejected' ? event.diagnostic : event.issue }, false);
            return;
        }
        if (!('turnId' in event) || event.turnId !== active.turnId) return;
        switch (event.kind) {
            case 'tool-call':
            case 'tool-result': {
                const message = sessionEventToHostMessage(event, sanitizeProviderDiagnosticText);
                if (message) emit(message);
                return;
            }
            case 'message-delta':
                if (event.sidechainId !== undefined) return;
                emitRunEvent({ kind: 'output-delta', channel: event.channel, text: event.text, ...(event.messageId ? { messageId: event.messageId } : {}) });
                return;
            case 'transcript-message-committed':
                if (event.sidechainId !== undefined || event.role !== 'assistant') return;
                emitRunEvent({ kind: 'output-message-committed', channel: 'assistant', text: event.text, messageId: event.messageId });
                return;
            case 'turn-start':
            case 'turn-progress':
                emitRunEvent({ kind: 'run-progress' });
                return;
            case 'turn-complete':
            case 'turn-cancelled':
            case 'turn-failed': {
                activeInputTurn = null;
                const settle = () => emitRunEvent(event.kind === 'turn-failed'
                    ? { kind: 'run-failed', diagnostic: event.diagnostic }
                    : event.kind === 'turn-cancelled'
                        ? { kind: 'run-cancelled', ...(event.diagnostic ? { diagnostic: event.diagnostic } : {}) }
                        : { kind: 'run-complete' });
                const custody = params.createExecutionRunContext?.onTurnTerminal?.(active.turnId);
                if (custody) {
                    const settlement = custody.then(settle, error => {
                        const failure = sanitizeThrownError(error, sanitizeProviderDiagnosticText, { runId });
                        failRuntime(failure.message, readExecutionRunErrorCode(failure) ?? undefined);
                    });
                    conversationTurnSettlement = settlement;
                    void settlement.then(() => { if (conversationTurnSettlement === settlement) conversationTurnSettlement = null; });
                } else settle();
                return;
            }
        }
    }

    async function sendNative(
        opened: NativeRun,
        input: AgentSessionInput,
        options: Parameters<AgentExecutionRunRuntime['send']>[1],
    ): Promise<Awaited<ReturnType<AgentExecutionRunRuntime['send']>>> {
        // The caller's current mode is host-private admission metadata. Only
        // the existing public SDK options cross the Agent boundary, including
        // when recovery resends the host's admitted input metadata.
        const providerOptions = {
            ...(options?.signal ? { signal: options.signal } : {}),
            ...(options?.localInputId ? { localInputId: options.localInputId } : {}),
            ...(options?.resultContract ? { resultContract: options.resultContract } : {}),
            ...(options?.causalPermissionAuthority ? { causalPermissionAuthority: options.causalPermissionAuthority } : {}),
        };
        if (opened.kind === 'finite') {
            const turn = beginInputTurn(options?.localInputId);
            try {
                const result = await opened.runtime.send(input, { ...providerOptions, localInputId: turn.inputIds[0] });

                if (result.status !== 'admitted') activeInputTurn = null;
                return result.status !== 'admitted' && result.diagnostic
                    ? { ...result, diagnostic: sanitizeNativeProviderDiagnostic(result.diagnostic, sanitizeProviderDiagnosticText) }
                    : result;
            } catch (error) {
                activeInputTurn = null;
                throw error;
            }
        }
        if (terminal) {
            await terminalPromise;
            throw new Error(`Native Agent execution run '${runId}' has already terminated`);
        }
        if (activeInputTurn) return { status: 'unavailable' as const };
        const authority = resolveExecutionRunInputAuthority({
            permissionMode: params.options.permissionMode,
            ...(options?.causalPermissionAuthority !== undefined
                ? { causalPermissionAuthority: options.causalPermissionAuthority } : {}),
            ...(admittedInputMeta?.effectiveCallerPermissionMode !== undefined
                ? { effectiveCallerPermissionMode: admittedInputMeta.effectiveCallerPermissionMode } : {}),
        });
        if (!authority.ok) return { status: 'rejected', diagnostic: {
            code: authority.errorCode, message: authority.error, severity: 'error',
        } };
        if (turnSettled) { resetTurnCompletion(); turnSettled = false; }
        const { turnId, inputIds } = beginInputTurn(options?.localInputId);
        try {
            const result = await opened.runtime.send({ inputIds: [...inputIds], input, delivery: { kind: 'newTurn', turnId },
                ...(options?.causalPermissionAuthority ? { causalPermissionAuthority: options.causalPermissionAuthority } : {}) }, {
                ...providerOptions, permissionIntent: normalizeExecutionRunPermissionMode(authority.effectiveCallerPermissionMode),
            });

            return result.status !== 'admitted' && result.diagnostic
                ? { ...result, diagnostic: sanitizeNativeProviderDiagnostic(result.diagnostic, sanitizeProviderDiagnosticText) }
                : result;
        } catch (error) {
            activeInputTurn = null;
            const failure = sanitizeThrownError(error, sanitizeProviderDiagnosticText, { runId });
            failRuntime(failure.message, readExecutionRunErrorCode(failure) ?? undefined);
            throw failure;
        }
    }

    async function prepareNativeContext(): Promise<AgentExecutionRunRuntimeContextV1> {
        assertUsable();
        nativeContextPromise ??= (async () => {
            const fallbackServices = await servicesPromise;
            assertUsable();
            const initialActionAttribution = admittedInputMeta
                ? admittedInputMeta.actionRequestAttributionV1
                : params.options.actionRequestAttributionV1;
            const context = params.createExecutionRunContext
                ? (executionRunContextLease = await params.createExecutionRunContext({
                    services: fallbackServices,
                    signal,
                    ...(!params.retainedConversation ? { onInteractionUnavailable: () => failRuntime(
                        'Execution-run permission interaction target is unavailable',
                        'execution_run_interaction_unavailable',
                    ) } : {}),
                    ...(params.retainedConversation ? { readActiveTurnAdmissionWitness } : {}),
                    ...(!params.retainedConversation && initialActionAttribution
                        ? { actionRequestAttributionV1: materializeActionRequestAttributionV1(initialActionAttribution) } : {}),
                })).context
                : createNativeAgentInvocationContext({
                    lease: params.lease,
                    onToolNormalizationSource: params.options.onToolNormalizationSource,
                    runId,
                    signal,
                    services: params.bindInvocationServices
                        ? await params.bindInvocationServices({ services: fallbackServices, signal,
                            ...(!params.retainedConversation && initialActionAttribution
                                ? { actionRequestAttributionV1: materializeActionRequestAttributionV1(initialActionAttribution) } : {}),
                            ...(params.retainedConversation ? { readActiveTurnAdmissionWitness } : {}) })
                        : fallbackServices,
                    invokedAtMs: Date.now(),
                });
            try {
                assertUsable();
            } catch (error) {
                const lease = executionRunContextLease;
                executionRunContextLease = null;
                await lease?.dispose();
                throw error;
            }
            return context;
        })();
        return await nativeContextPromise;
    }

    async function openNative(request: AgentExecutionRunOpenRequest): Promise<NativeRun> {
        assertUsable();
        if (nativeRuntimePromise) return await nativeRuntimePromise;
        nativeRuntimePromise = (async () => {
            const context = await prepareNativeContext();
            const initialActionAttribution = admittedInputMeta
                ? admittedInputMeta.actionRequestAttributionV1
                : params.options.actionRequestAttributionV1;
            assertUsable();
            let providerCurrent: Awaited<ReturnType<NonNullable<
                CreateCliExecutionRunBackendParams['revalidateProviderBeforeOpen']
            >>> | undefined;
            try {
                providerCurrent = await params.options.revalidateProviderBeforeOpen?.();
            } catch (error) {
                throw sanitizeThrownError(error, sanitizeProviderDiagnosticText, { runId });
            }
            if (providerCurrent && !providerCurrent.ok) {
                throw Object.assign(
                    new Error(providerCurrent.error.code),
                    { code: providerCurrent.error.code },
                );
            }
            assertUsable();
            let opened: NativeRun;
            const initialTurn = !params.retainedConversation && request.kind === 'create'
                ? beginInputTurn(request.localInputId) : null;
            const admittedRequest = {
                ...request,
                ...(request.kind === 'create' ? {
                    input: withRunSkillIndex(request.input, executionRunContextLease?.skillIndex),
                    ...(initialTurn ? { localInputId: initialTurn.inputIds[0] } : {}),
                } : {}),
                ...(executionRunContextLease?.mcpServers ? { mcpServers: executionRunContextLease.mcpServers } : {}),
                ...(executionRunContextLease?.mcpToolPolicy ? { mcpToolPolicy: executionRunContextLease.mcpToolPolicy } : {}),
                ...(executionRunContextLease?.mcpServersStrictMode !== undefined ? { mcpServersStrictMode: executionRunContextLease.mcpServersStrictMode } : {}),
                ...(executionRunContextLease?.skills ? { skills: executionRunContextLease.skills } : {}),
            };
            if (params.executionRunContextV1) {
                if (!('scope' in context) || context.scope.kind !== 'execution_run') {
                    throw new Error('Session-primary detached execution requires execution-run scope');
                }
                opened = params.retainedConversation
                    ? { kind: 'conversation', runtime: await params.executionRunContextV1.openConversation!(admittedRequest, context) }
                    : { kind: 'finite', runtime: await params.executionRunContextV1.open(admittedRequest, context) };
            } else {
                opened = { kind: 'finite', runtime: await directExecutionRuns!.open(admittedRequest, context) };
            }

            try {
                assertUsable();
                nativeRuntime = opened;
                openingInitialInput = request.kind === 'create';
                if (request.kind === 'resume') checkpointId = request.checkpointId;
                if (request.kind === 'create') admittedInputMeta = {
                    ...(initialActionAttribution
                        ? { actionRequestAttributionV1: materializeActionRequestAttributionV1(initialActionAttribution) } : {}),
                    ...(admittedInputMeta?.effectiveCallerPermissionMode !== undefined
                        ? { effectiveCallerPermissionMode: admittedInputMeta.effectiveCallerPermissionMode } : {}),
                    ...(initialTurn ? { localInputId: initialTurn.inputIds[0] }
                        : request.localInputId ? { localInputId: request.localInputId } : {}),
                    ...(request.resultContract ? { resultContract: request.resultContract } : {}),
                    ...(request.causalPermissionAuthority ? { causalPermissionAuthority: request.causalPermissionAuthority } : {}),
                };
                watchDisposable = opened.kind === 'finite'
                    ? opened.runtime.watch(event => { if (nativeRuntime === opened) handleEvent(event); })
                    : opened.runtime.watch(event => { if (nativeRuntime === opened) handleConversationEvent(event); });
                if (opened.kind === 'conversation' && request.kind === 'create') {
                    const result = await sendNative(opened, withRunSkillIndex(request.input, executionRunContextLease?.skillIndex), { ...admittedInputMeta, signal });
                    if (result.status !== 'admitted') throw createExecutionRunCodedError(result.diagnostic?.code ?? 'agent_execution_run_input_rejected', diagnosticMessage(result.diagnostic, sanitizeProviderDiagnosticText));
                }
                if (rejectedStart) throw rejectedStart;
            } catch (error) {
                if (nativeRuntime === opened) nativeRuntime = null;
                if (rejectedStart === error) {
                    // The rejected member's handle is released for finite and retained Runs alike.
                    try { await opened.runtime.dispose(); } catch { /* Preserve the classified pre-start refusal. */ }
                    throw error;
                }
                await opened.runtime.dispose();
                throw sanitizeThrownError(error, sanitizeProviderDiagnosticText, { runId });
            } finally {
                openingInitialInput = false;
            }
            return opened;
        })().catch((error: unknown) => {
            // An open that failed cannot supply future terminal events. Settle
            // the same completion fence observed by long-lived input custody.
            // The explicit pre-start rejection retains its identity for pool recovery.
            if (error === rejectedStart) throw error;
            const failure = sanitizeThrownError(error, sanitizeProviderDiagnosticText, { runId });
            const code = readExecutionRunErrorCode(failure) ?? 'agent_execution_run_open_failed';
            logProviderFailure('open', code);
            failRuntime(failure.message, code);
            throw failure;
        });
        return await nativeRuntimePromise;
    }

    return Object.freeze({
        permissionCapability: params.respondToPermissionRequest ? 'responds' as const : 'static' as const,
        ...(params.respondToPermissionRequest
            ? {
                async respondToPermission(requestId: string, approved: boolean, response?: PermissionResult) {
                    return toRuntimePermissionResponseOutcome(await params.respondToPermissionRequest!(requestId, approved, response));
                },
            }
            : {}),
        ...(params.abortPendingPermissionRequests
            ? { abortPendingPermissionRequests: params.abortPendingPermissionRequests }
            : {}),
        async readResumeSupport() {
            return params.supportsResume;
        },
        async prepareInputBudget() {
            assertUsable();
            const maxInputUnicodeCharacters = await params.readMaxInputUnicodeCharacters?.();
            assertUsable();
            if (maxInputUnicodeCharacters == null) return undefined;
            await prepareNativeContext();
            assertUsable();
            return runInputBudget(maxInputUnicodeCharacters, executionRunContextLease?.skillIndex);
        },
        async provisionRuntime(options) {
            assertUsable();
            provisionPromise ??= (async () => {
                if (options?.resumeRuntimeId) {
                    if (!params.supportsResume) throw new Error('Backend does not support resume');
                    openRequest = Object.freeze({
                        kind: 'resume' as const,
                        runId,
                        cwd: params.options.cwd,
                        profile,
                        ...boundedOpenInputs,
                        checkpointId: options.resumeRuntimeId,
                    });
                    await openNative(openRequest);
                } else if (options?.initialPrompt !== undefined) {
                    const localId = params.options.start?.localInputId ?? `${runId}-initial-input`;
                    const input = await resolveInputForDispatch(
                        buildInput(
                            options.initialPrompt,
                            structuredInput,
                        ),
                        localId,
                    );
                    openRequest = Object.freeze({
                        kind: 'create' as const,
                        runId,
                        cwd: params.options.cwd,
                        profile,
                        ...boundedOpenInputs,
                        input,
                        ...(params.options.start?.localInputId
                            ? { localInputId: params.options.start.localInputId }
                            : {}),
                        ...(params.options.start?.resultContract
                            ? { resultContract: params.options.start.resultContract }
                            : {}),
                    });
                    await openNative(openRequest);
                }
                return Object.freeze({ runtimeId: runId });
            })();
            return await provisionPromise;
        },
        getRuntimeLifetimeSignal: () => signal,
        readActiveTurnAdmissionWitness,
        async deliverInput(runtimeId, admittedInput, meta) {
            if (meta?.actionRequestAttributionV1) meta = { ...meta,
                actionRequestAttributionV1: materializeActionRequestAttributionV1(meta.actionRequestAttributionV1) };
            assertUsable();
            if (!provisionPromise || runtimeId !== runId) {
                throw new Error(`Native Agent execution run '${runId}' is not provisioned for runtime '${runtimeId}'`);
            }
            await provisionPromise;
            if (terminal) throw new Error(`Native Agent execution run '${runId}' has already terminated`);
            const localId = meta?.localId ?? params.options.start?.localInputId ?? `${runId}-input`;
            const carriedInput = admittedInput.structuredInput === undefined
                ? { ...admittedInput, ...buildInput(
                    admittedInput.text,
                    structuredInput,
                ) }
                : admittedInput;
            let input: AgentSessionInput;
            try {
                input = await resolveInputForDispatch(carriedInput, localId);
            } catch (error) {
                return rejectStructuredInputBeforeProviderEffect(error);
            }
            if (!nativeRuntimePromise) {
                // This private admission field must survive deferred first
                // opening without entering the public SDK open request.
                admittedInputMeta = { ...meta, localInputId: localId };
                openRequest = Object.freeze({
                    kind: 'create' as const,
                    runId,
                    cwd: params.options.cwd,
                    profile,
                    ...boundedOpenInputs,
                    ...(meta?.causalPermissionAuthority
                        ? { causalPermissionAuthority: meta.causalPermissionAuthority }
                        : {}),
                    ...(meta?.localId || params.options.start?.localInputId
                        ? { localInputId: meta?.localId ?? params.options.start?.localInputId }
                        : {}),
                    ...(meta?.resultContract || params.options.start?.resultContract
                        ? { resultContract: meta?.resultContract ?? params.options.start?.resultContract }
                        : {}),
                    input,
                });
                await openNative(openRequest);
                return { status: 'admitted' as const };
            }
            const opened = await nativeRuntimePromise;
            admittedInputMeta = { ...meta, localInputId: localId };
            let result: Awaited<ReturnType<AgentExecutionRunRuntime['send']>>;
            try {
                result = await sendNative(opened, input, {
                    signal,
                    ...(meta?.localId ? { localInputId: meta.localId } : {}),
                    ...(meta?.resultContract ? { resultContract: meta.resultContract } : {}),
                    ...(meta?.causalPermissionAuthority
                        ? { causalPermissionAuthority: meta.causalPermissionAuthority }
                        : {}),
                });
            } catch (error) {
                logProviderFailure('send', readExecutionRunErrorCode(error) ?? 'agent_execution_run_send_failed');
                throw sanitizeThrownError(error, sanitizeProviderDiagnosticText, { runId });
            }
            if (result.status !== 'admitted') {
                const message = diagnosticMessage(result.diagnostic, sanitizeProviderDiagnosticText);
                const code = result.diagnostic?.code ?? 'agent_execution_run_failed';
                logProviderFailure('send', code);
                failRuntime(message, code);
                throw createExecutionRunCodedError(code, message);
            }
            // The execution-run-native surface has a deliberately looser
            // refusal shape than Agent Session delivery. Non-admission was
            // converted to an exception above, so expose only the proven
            // admitted arm at this adapter boundary.
            return { status: 'admitted' as const };
        },
        async cancel(runtimeId) {
            assertUsable();
            if (!provisionPromise || runtimeId !== runId) return;
            if (recovery) {
                recovery.abort(new Error('Execution Run recovery cancelled'));
                recovery = null;
                terminal = true;
                emit({ type: 'status', status: 'stopped' });
                resolveTerminal();
                return;
            }
            const opened = nativeRuntime ?? (nativeRuntimePromise ? await nativeRuntimePromise : null);
            if (!opened) return;
            let result: Awaited<ReturnType<AgentExecutionRunRuntime['stop']>>;
            try {
                result = opened.kind === 'finite'
                    ? await opened.runtime.stop({ signal })
                    : activeInputTurn
                        ? await opened.runtime.cancel?.({ turnId: activeInputTurn.turnId, reason: 'user' }, { signal }) ?? { status: 'unsupported' }
                        : { status: 'notRunning' };
            } catch (error) {
                logProviderFailure('stop', readExecutionRunErrorCode(error) ?? 'agent_execution_run_stop_failed');
                throw sanitizeThrownError(error, sanitizeProviderDiagnosticText, { runId });
            }
            if (result.status === 'unavailable' || result.status === 'unsupported') {
                throw new Error(`Native Agent execution run stop is ${result.status}`);
            }
            activeInputTurn = null;
        },
        subscribeMessages(handler) {
            listeners.add(handler);
            return () => listeners.delete(handler);
        },
        subscribeRuntimeEvents(handler) {
            runtimeEventListeners.add(handler);
            return () => runtimeEventListeners.delete(handler);
        },
        async waitForTurnCompletion() {
            if (!nativeRuntimePromise && !recovery) return;
            await terminalPromise;
        },
        async dispose() {
            if (disposed) return;
            disposed = true;
            // The existing terminal fence settles completion waiters first, so
            // waiter settlement and controller retirement are independent of
            // any never-settling provider open or dispose below.
            if (nativeRuntimePromise && !terminal) {
                terminal = true;
                rejectTurnCompletion(createDisposedError());
            }
            ownedAbortController.abort(new Error('Native Agent execution run disposed'));
            recovery?.abort(new Error('Execution Run recovery disposed'));
            recovery = null;
            const watch = watchDisposable;
            watchDisposable = null;
            listeners.clear();
            runtimeEventListeners.clear();
            // Cleanup is attempted exactly once, best effort: it must not
            // block this return on a provider open that never settles, and a
            // provider cleanup failure is logged nowhere the caller depends
            // on. A late-settling open is disposed when it settles.
            const cleanupOpened = (opened: NativeRun | null): void => {
                if (!opened) return;
                void Promise.resolve().then(() => opened.runtime.dispose()).catch(() => undefined);
            };
            if (nativeRuntime) {
                cleanupOpened(nativeRuntime);
            } else if (nativeRuntimePromise) {
                void nativeRuntimePromise.then(cleanupOpened, () => undefined);
            }
            if (watch) {
                void Promise.resolve().then(() => watch.dispose()).catch(() => undefined);
            }
            const contextLease = executionRunContextLease;
            executionRunContextLease = null;
            if (contextLease) {
                if (params.sessionTurnRecoveryOwned) await contextLease.dispose();
                else void contextLease.dispose().catch(() => undefined);
            }
        },
    });
}

/**
 * Host-owned finite Run projection for an Agent whose provider-native owner is
 * a Session runtime. A parent Session supplies its complete host context;
 * detached Runs supply only the run-scoped context required by the runtime.
 */
export function createNativeAgentSessionExecutionRunHostRuntime(params: Readonly<{
    runtime: AgentRuntime;
    lease: NativeAgentRuntimeLeaseIdentity;
    options: CreateCliExecutionRunBackendParams;
    supportsResume: boolean;
    readMaxInputUnicodeCharacters?: () => number | null | Promise<number | null>;
    generationSignal?: AbortSignal;
    services?: Promise<PluginServices>;
    createSessionContext: NativeAgentSessionContextLeaseFactory;
}>): ExecutionRunHostRuntime {
    const sessions = params.runtime.sessions;
    if (!sessions) {
        throw new Error(`Agent runtime '${params.lease.agentId}' does not support sessions`);
    }
    let preparedSessionContext: Readonly<{
        lease: NativeAgentSessionContextLease;
        executionRunContext: AgentExecutionRunRuntimeContextV1;
    }> | null = null;
    let sourceSession: AgentSessionRuntime | null = null;
    const executionRuns: AgentExecutionRunRuntimeFactory = Object.freeze({
        async open(
            request: AgentExecutionRunOpenRequest,
            executionContext: AgentExecutionRunRuntimeContextV1,
        ) {
                if (request.kind === 'fork') {
                    throw new Error('Host-derived Session execution runs do not support fork');
                }
                const sessionContext = preparedSessionContext?.lease;
                if (!sessionContext || preparedSessionContext?.executionRunContext !== executionContext) {
                    throw new Error('Session Run context was not prepared by its host');
                }
                const readBoundaryError = (): Error | null => {
                    if (!params.lease.isCurrent()) {
                        return new Error(
                            `Agent runtime '${params.lease.agentId}' belongs to a retired generation`,
                        );
                    }
                    if (!executionContext.signal.aborted) return null;
                    return executionContext.signal.reason instanceof Error
                        ? executionContext.signal.reason
                        : Object.assign(
                            new Error('Agent execution run was aborted'),
                            { name: 'AbortError' },
                        );
                };
                const contextBoundaryError = readBoundaryError();
                if (contextBoundaryError) {
                    try {
                        await sessionContext.dispose();
                    } catch {
                        // Preserve the currentness/abort refusal after host-context cleanup was attempted.
                    }
                    throw contextBoundaryError;
                }
                let execution: AgentExecutionRunRuntime;
                const initialAdmission: { result?: Awaited<ReturnType<AgentSessionRuntime['send']>> } = {};
                let unsubscribeMcpToolPolicy: (() => void) | undefined;
                try {
                    const runScopedContext: AgentSessionRuntimeContext = Object.freeze({
                        ...withRunScopedSessionContext(sessionContext.context, request.runId),
                        // A finite child Run may reuse its parent's Session context
                        // services, but it never owns the parent's published work state.
                        workState: createRunScopedWorkStateService(executionContext.signal),
                    });
                    const openNativeSession = async (sessionRequest: Extract<AgentSessionOpenRequest, { kind: 'create' | 'resume' }>) => {
                        sessionRequest = withSessionRunAgentEnvironment(sessionRequest, sessionContext.agentEnvironment);
                        const opened = await sessions.open(sessionRequest, runScopedContext);
                        sourceSession = opened;
                        let boundaryError = readBoundaryError();
                        if (!boundaryError) {
                            try { assertNativeAgentSessionModeAvailable(sessionRequest.configuration, sessionContext.publications); }
                            catch (error) {
                                await opened.dispose('runtime_recovery');
                                throw error;
                            }
                        }
                        if (!boundaryError && opened.skillsDelivered === false && sessionContext.skills && sessionContext.capabilityNoticeSession) {
                            await publishSkillLaunchNotice(sessionContext.capabilityNoticeSession, sessionContext.skills);
                            boundaryError = readBoundaryError();
                        }
                        if (boundaryError) {
                            void Promise.resolve().then(() => opened.dispose('runtime_recovery')).catch(() => undefined);
                            throw boundaryError;
                        }
                        return opened;
                    };
                    execution = await createExecutionRunHostBackendFromSessionRuntime({
                        request: {
                            ...request,
                            ...(sessionContext.mcpServers ? { mcpServers: sessionContext.mcpServers } : {}),
                            ...(sessionContext.mcpToolPolicy ? { mcpToolPolicy: sessionContext.mcpToolPolicy } : {}),
                            ...(sessionContext.mcpServersStrictMode !== undefined ? { mcpServersStrictMode: sessionContext.mcpServersStrictMode } : {}),
                            ...(sessionContext.skills ? { skills: sessionContext.skills } : {}),
                        },
                        sessionId: sessionContext.context.session.id,
                        openSession: async (sessionRequest) => {
                            const native = await openNativeSession(sessionRequest);
                            const opened = params.supportsResume && params.options.prepareRuntimeFailureRecovery
                                ? createRecoveringAgentSessionRuntime({
                                    session: native,
                                    request: sessionRequest,
                                    openSession: openNativeSession,
                                    recover: params.options.prepareRuntimeFailureRecovery,
                                    ...(params.options.connectedServiceRuntimeTurnCompleted ? { onTurnCompleted: params.options.connectedServiceRuntimeTurnCompleted } : {}),
                                    signal: executionContext.signal,
                                })
                                : native;
                            unsubscribeMcpToolPolicy = sessionContext.subscribeMcpToolPolicy?.(mcpToolPolicy => {
                                if (readBoundaryError()) return;
                                const configuration = sessionRequest.configuration;
                                if (!configuration || !opened.updateConfiguration) {
                                    logger.warn('[MCP] Native Session Run configuration update is unavailable');
                                    return;
                                }
                                const update = applyNativeAgentConfigurationUpdate(configuration, { mcpToolPolicy });
                                void opened.updateConfiguration(update.request).then(result => {
                                    if (result.status !== 'applied' && result.status !== 'deferred') logger.warn('[MCP] Native Session Run policy update was not applied');
                                }).catch(() => { logger.warn('[MCP] Native Session Run policy update failed'); });
                            });
                            return request.kind === 'create' ? Object.freeze({
                                ...opened,
                                async send(input: Parameters<AgentSessionRuntime['send']>[0], options?: Parameters<AgentSessionRuntime['send']>[1]) {
                                    const result = await opened.send(input, options);
                                    initialAdmission.result ??= result;
                                    return result;
                                },
                            }) : opened;
                        },
                        readCheckpointId: (event) => event.kind === 'provider-session-id'
                            ? event.providerSessionId
                            : null,
                        ...(sessionContext.usagePublisher || params.options.start?.observeWorkflowUsage || sessionContext.observeSkillUse ? {
                            observeSessionUsage: (event: Extract<AgentSessionRuntimeEvent, { kind: 'usage-observed' | 'skill-usage' }>) => {
                                if (event.kind === 'skill-usage') {
                                    if (!readBoundaryError() && sourceSession?.skillsDelivered !== false) {
                                        void sessionContext.observeSkillUse?.(event).catch(() => undefined);
                                    }
                                    return;
                                }
                                const publisher = sessionContext.usagePublisher;
                                const observation = toNativeAgentUsageObservation(
                                    event,
                                    publisher?.provider ?? params.lease.agentId,
                                );
                                params.options.start?.observeWorkflowUsage?.({
                                    turnId: event.turnId ?? null,
                                    observation,
                                });
                                if (publisher) {
                                    void Promise.resolve(publisher.publish({
                                        observedAt: event.emittedAtMs,
                                        observation,
                                        turnId: event.turnId ?? null,
                                        externalKey: event.observationId,
                                        metadata: buildNativeAgentUsageAccountingMetadata(event),
                                    })).catch(() => undefined);
                                }
                            },
                        } : {}),
                    });
                    // The SDK retains a terminal Run handle on initial refusal.
                    // Preserve the Session's actual admission result at this
                    // host boundary instead of treating handle creation as acceptance.
                    const initialInputResult = initialAdmission.result;
                    if (initialInputResult && initialInputResult.status !== 'admitted') {
                        throw createExecutionRunCodedError(
                            initialInputResult.diagnostic?.code ?? 'agent_execution_run_input_rejected',
                            diagnosticMessage(initialInputResult.diagnostic, params.options.sanitizeProviderDiagnosticText ?? (value => value)),
                        );
                    }
                } catch (error) {
                    unsubscribeMcpToolPolicy?.();
                    try {
                        await sessionContext.dispose();
                    } catch {
                        // Preserve the Session open/admission failure after cleanup was attempted.
                    }
                    throw error;
                }
                let disposed = false;
                return Object.freeze({
                    send: (input: AgentSessionInput, options?: Parameters<AgentExecutionRunRuntime['send']>[1]) =>
                        execution.send(withRunSkillIndex(input, sessionContext.skillIndex), options),
                    stop: execution.stop.bind(execution),
                    watch: execution.watch.bind(execution),
                    async dispose() {
                        if (disposed) return;
                        disposed = true;
                        unsubscribeMcpToolPolicy?.();
                        // The SDK lifecycle has already settled terminal truth.
                        // Provider cleanup cannot retain the controller. Session
                        // authority must finish retiring before this lease returns.
                        void Promise.resolve().then(() => execution.dispose())
                            .catch(() => undefined);
                        await sessionContext.dispose();
                    },
                });
        },
    });
    const derivedRuntime: AgentRuntime = Object.freeze({
        executionRuns,
    });
    return createNativeAgentExecutionRunHostRuntime({
        runtime: derivedRuntime,
        sessionTurnRecoveryOwned: true,
        lease: params.lease,
        options: params.options,
        supportsResume: params.supportsResume,
        readMaxInputUnicodeCharacters: params.readMaxInputUnicodeCharacters,
        async createExecutionRunContext(input) {
            sourceSession = null;
            const lease = await params.createSessionContext({
                ...input,
                readSessionRuntime: () => sourceSession,
            });
            let disposal: Promise<void> | null = null;
            const sessionContext = Object.freeze({
                ...lease,
                get agentEnvironment() { return lease.agentEnvironment; },
                get sessionMcpContext() { return lease.sessionMcpContext; },
                dispose() {
                    disposal ??= Promise.resolve().then(() => lease.dispose());
                    return disposal;
                },
            });
            const executionRunContext = createNativeAgentInvocationContext({
                lease: params.lease,
                onToolNormalizationSource: params.options.onToolNormalizationSource,
                runId: readRequiredString(params.options.runId, 'a run id'),
                signal: lease.context.signal,
                services: lease.context.services,
                invokedAtMs: lease.context.invokedAtMs,
            });
            preparedSessionContext = { lease: sessionContext, executionRunContext };
            return { ...sessionContext, context: executionRunContext };
        },
        ...(params.generationSignal ? { generationSignal: params.generationSignal } : {}),
        ...(params.services ? { services: params.services } : {}),
        ...(params.createSessionContext.respondToPermissionRequest
            ? { respondToPermissionRequest: params.createSessionContext.respondToPermissionRequest }
            : {}),
        ...(params.createSessionContext.abortPendingPermissionRequests
            ? { abortPendingPermissionRequests: params.createSessionContext.abortPendingPermissionRequests }
            : {}),
        ...(params.createSessionContext.resolveStructuredInputForDispatch
            ? { resolveStructuredInputForDispatch: params.createSessionContext.resolveStructuredInputForDispatch }
            : {}),
    });
}

/**
 * Host-owned retained Session interaction used by multi-turn consumers such as
 * Voice. It deliberately bypasses finite Execution Run terminal semantics and
 * reuses the canonical native Session turn/custody controller for every turn.
 */
export function createNativeAgentSessionInteractionHostRuntime(params: Readonly<{
    runtime: AgentRuntime;
    lease: NativeAgentRuntimeLeaseIdentity;
    options: CreateCliExecutionRunBackendParams;
    readMaxInputUnicodeCharacters?: () => number | null | Promise<number | null>;
    /**
     * One declared capability set owns both resume admission and the controls
     * this retained interaction may offer.
     */
    sessionCapabilities: AgentSessionCapabilities;
    generationSignal?: AbortSignal;
    services?: Promise<PluginServices>;
    createSessionContext: NativeAgentSessionContextLeaseFactory;
}>): ExecutionRunHostRuntime {
    const sessions = params.runtime.sessions;
    if (!sessions) {
        throw new Error(`Agent runtime '${params.lease.agentId}' does not support sessions`);
    }
    const supportsResume = params.sessionCapabilities.open.includes('resume');
    const runId = readRequiredString(params.options.runId, 'a run id');
    const launchEnvironment = buildLaunchEnvironment(params.options);
    const sanitize = params.options.sanitizeProviderDiagnosticText ?? ((value: string) => value);
    const ownedAbortController = new AbortController();
    const signal = params.generationSignal
        ? AbortSignal.any([ownedAbortController.signal, params.generationSignal])
        : ownedAbortController.signal;
    const servicesPromise = params.services ?? Promise.resolve(createUnavailablePluginServices());
    const listeners = new Set<(message: AgentMessage) => void>();
    const inputOutcomeListeners = new Set<(outcome: SessionProviderInputOutcome) => void>();
    const runtimeEventListeners = new Set<(event: ExecutionRunHostRuntimeEvent) => void>();
    let recoveringSession: ReturnType<typeof createRecoveringAgentSessionRuntime> | null = null;
    let operations: ReturnType<typeof createNativeAgentSessionInteractionOperations> | null = null;
    let unsubscribeEvents: (() => void) | null = null;
    let disposeSessionContext: (() => Promise<void>) | null = null;
    let openPromise: Promise<void> | null = null;
    let provisionPromise: Promise<Readonly<{ runtimeId: string }>> | null = null;
    let disposed = false;
    let turnOrdinal = 0;
    let pendingTurnTerminalSettlement: Promise<void> | null = null;
    let pendingTurnInputId: string | null = null;
    let pendingTurnAdmissionFailure: Error | null = null;
    let resumedProviderSessionId: string | null = null;
    let skillIndex: string | undefined;
    let sessionContextPromise: Promise<NativeAgentSessionContextLease> | null = null;
    let sourceSession: AgentSessionRuntime | null = null;

    const assertUsable = (): void => {
        if (disposed) throw new Error('Native Agent Session interaction is disposed');
        if (!params.lease.isCurrent()) {
            throw new Error(`Agent runtime '${params.lease.agentId}' belongs to a retired generation`);
        }
        signal.throwIfAborted();
    };
    const emit = (message: AgentMessage): void => {
        for (const listener of listeners) {
            try {
                listener(message);
            } catch {
                // One Voice projection cannot interrupt the retained Session owner.
            }
        }
    };
    const prepareSessionContext = async (): Promise<NativeAgentSessionContextLease> => {
        assertUsable();
        sessionContextPromise ??= (async () => {
            const services = await servicesPromise;
            assertUsable();
            const sessionContext = await params.createSessionContext({
                services,
                signal,
                readSessionRuntime: () => sourceSession,
                readActiveTurnAdmissionWitness: () => operations?.readActiveTurnAdmissionWitness?.() ?? null,
            });
            // Context acquisition can await plugin/daemon work. Re-check the
            // generation before invoking the provider so retirement cannot
            // trigger a native open side effect after this host is unusable.
            try {
                assertUsable();
            } catch (error) {
                await sessionContext.dispose();
                throw error;
            }
            skillIndex = sessionContext.skillIndex;
            disposeSessionContext = () => sessionContext.dispose();
            return sessionContext;
        })();
        return await sessionContextPromise;
    };
    const open = async (resumeSessionId?: string): Promise<void> => {
        assertUsable();
        if (openPromise) return await openPromise;
        openPromise = (async () => {
            const sessionContext = await prepareSessionContext();
            assertUsable();
            const context = withRunScopedSessionContext(sessionContext.context, runId);
            let unsubscribeMcpToolPolicy: (() => void) | undefined;
            disposeSessionContext = async () => { unsubscribeMcpToolPolicy?.(); await sessionContext.dispose(); };
            const common = {
                sessionId: context.session.id,
                ...(params.options.start?.intent === 'voice_agent' ? { promptProfile: 'conversation' as const } : {}),
                ...(params.options.functionTools ? { functionTools: params.options.functionTools } : {}),
                cwd: params.options.cwd,
                ...(sessionContext.mcpServers ? { mcpServers: sessionContext.mcpServers } : {}),
                ...(sessionContext.mcpToolPolicy ? { mcpToolPolicy: sessionContext.mcpToolPolicy } : {}),
                ...(sessionContext.mcpServersStrictMode !== undefined ? { mcpServersStrictMode: sessionContext.mcpServersStrictMode } : {}),
                ...(sessionContext.skills ? { skills: sessionContext.skills } : {}),
                stateSharing: resolveNativeAgentSessionStateSharingPolicy(params.lease.agentId),
                ...(launchEnvironment ? { launchEnvironment } : {}),
                ...(params.options.runtimeDescriptorV1
                    ? { runtimeDescriptorV1: params.options.runtimeDescriptorV1 }
                    : {}),
                ...(params.options.modelSelection ? { modelSelection: params.options.modelSelection } : {}),
                ...(params.options.configuration ? { configuration: projectNativeAgentProviderBindingConfiguration(params.options.configuration, params.options.providerBinding) } : {}),
                ...(params.options.providerBinding ? { providerBinding: params.options.providerBinding } : {}),
            };
            const request = withSessionRunAgentEnvironment<Extract<AgentSessionOpenRequest, { kind: 'create' | 'resume' }>>(resumeSessionId
                ? { ...common, kind: 'resume', providerSessionId: resumeSessionId }
                : { ...common, kind: 'create' }, sessionContext.agentEnvironment);
            let opened: AgentSessionRuntime | null = null;
            try {
                opened = await sessions.open(request, context);
                sourceSession = opened;
                if (request.functionTools?.length && opened.functionToolsDelivered !== true) {
                    throw createExecutionRunCodedError('VOICE_AGENT_UNSUPPORTED',
                        'This Agent conversation cannot receive native Voice Action functions. Start a fresh Voice conversation with a supported Agent.');
                }
                assertUsable();
                assertNativeAgentSessionModeAvailable(request.configuration, sessionContext.publications);
                if (opened.skillsDelivered === false && sessionContext.skills && sessionContext.capabilityNoticeSession) {
                    await publishSkillLaunchNotice(sessionContext.capabilityNoticeSession, sessionContext.skills);
                    assertUsable();
                }
                if (supportsResume && params.options.prepareRuntimeFailureRecovery) {
                    recoveringSession = createRecoveringAgentSessionRuntime({
                        session: opened,
                        request,
                        openSession: async request => {
                            request = withSessionRunAgentEnvironment(request, sessionContext.agentEnvironment);
                            const resumed = await sessions.open(request, context);
                            sourceSession = resumed;
                            try {
                                if (request.functionTools?.length && resumed.functionToolsDelivered !== true) {
                                    throw createExecutionRunCodedError('VOICE_AGENT_UNSUPPORTED',
                                        'This retained Agent conversation cannot receive native Voice Action functions. Start a fresh Voice conversation.');
                                }
                                assertUsable();
                                assertNativeAgentSessionModeAvailable(request.configuration, sessionContext.publications);
                                if (resumed.skillsDelivered === false && sessionContext.skills && sessionContext.capabilityNoticeSession) {
                                    await publishSkillLaunchNotice(sessionContext.capabilityNoticeSession, sessionContext.skills);
                                    assertUsable();
                                }
                                return resumed;
                            } catch (error) {
                                void Promise.resolve().then(() => resumed.dispose('runtime_recovery')).catch(() => undefined);
                                throw error;
                            }
                        },
                        recover: params.options.prepareRuntimeFailureRecovery,
                        onRecoveryWaiting: (turnId, recovery) => {
                            for (const listener of runtimeEventListeners) listener({ kind: 'recovery-waiting', turnId, recovery });
                        },
                        ...(params.options.connectedServiceRuntimeTurnCompleted ? { onTurnCompleted: params.options.connectedServiceRuntimeTurnCompleted } : {}),
                        signal,
                    });
                    opened = recoveringSession;
                }
                operations = createNativeAgentSessionInteractionOperations({
                    session: opened,
                    sessionId: context.session.id,
                    cwd: params.options.cwd,
                    context,
                    capabilities: params.sessionCapabilities,
                    ...(sessionContext.publications ? { publications: sessionContext.publications } : {}),
                    ...(sessionContext.usagePublisher || params.options.start?.observeWorkflowUsage ? {
                        usagePublisher: {
                            provider: sessionContext.usagePublisher?.provider ?? params.lease.agentId,
                            publish(input) {
                                params.options.start?.observeWorkflowUsage?.({
                                    turnId: input.turnId,
                                    observation: input.observation,
                                });
                                return sessionContext.usagePublisher?.publish(input);
                            },
                        },
                    } : {}),
                    ...(resumeSessionId ? { expectedProviderSessionId: resumeSessionId } : {}),
                    ...(request.configuration
                        ? { initialConfiguration: request.configuration }
                        : {}),
                });
                unsubscribeMcpToolPolicy = sessionContext.subscribeMcpToolPolicy?.(mcpToolPolicy => {
                    if (!operations || disposed || signal.aborted || !params.lease.isCurrent()) return;
                    void operations.updateSessionRuntimeConfig({ mcpToolPolicy }).then(result => {
                        if (!result || result.status !== 'applied') logger.warn('[MCP] Retained Session Run policy update was not applied');
                    }).catch(() => { logger.warn('[MCP] Retained Session Run policy update failed'); });
                });
                // A successful native resume admitted this existing vendor id.
                // Fresh sessions remain unknown until validated provider evidence.
                resumedProviderSessionId = resumeSessionId ?? null;
                operations.setOnPromptDeliveryOutcome((evidence) => {
                    const outcome = normalizeHostProviderInputOutcome(evidence);
                    if (!outcome) return;
                    if (outcome.localId === pendingTurnInputId && outcome.kind === 'rejected_before_effect') {
                        pendingTurnAdmissionFailure = createExecutionRunCodedError(
                            outcome.diagnostic.code,
                            diagnosticMessage(outcome.diagnostic, sanitize),
                        );
                    }
                    for (const listener of inputOutcomeListeners) listener(outcome);
                });
                unsubscribeEvents = operations.subscribeRuntimeEvents((event) => {
                    if ('type' in event) return;
                    if (event.kind === 'skill-usage' && !disposed && !signal.aborted && params.lease.isCurrent()
                        && sourceSession?.skillsDelivered !== false) {
                        void sessionContext.observeSkillUse?.(event).catch(() => undefined);
                    }
                    for (const listener of runtimeEventListeners) listener(event);
                    if (
                        event.kind === 'turn-complete'
                        || event.kind === 'turn-failed'
                        || event.kind === 'turn-cancelled'
                    ) {
                        const settlement = Promise.resolve(
                            params.createSessionContext.onTurnTerminal?.(event.turnId),
                        );
                        pendingTurnTerminalSettlement = settlement;
                        // The turn-completion waiter below owns propagation. Attach
                        // an observer immediately so a synchronous persistence
                        // rejection cannot become an unhandled promise first.
                        void settlement.catch(() => undefined);
                    }
                    const message = sessionEventToHostMessage(event, sanitize);
                    if (message) emit(message);
                });
            } catch (error) {
                try {
                    await opened?.dispose('runtime_recovery');
                } finally {
                    await disposeSessionContext?.();
                    disposeSessionContext = null;
                }
                throw error;
            }
        })().catch(error => {
            throw sanitizeThrownError(error, sanitize, { runId });
        });
        return await openPromise;
    };

    const waitForTurnCompletion = async (timeoutMs?: number | null): Promise<void> => {
        if (!operations) return;
        let completionError: unknown = null;
        try {
            await operations.waitForTurnCompletion({ timeoutMs: timeoutMs ?? null });
        } catch (error) {
            completionError = error;
        }
        // A native refusal never started a turn. The Session owner returns to
        // idle, but this Run still owes its caller a failed operation/result.
        completionError ??= pendingTurnAdmissionFailure;
        pendingTurnInputId = null;
        const settlement = pendingTurnTerminalSettlement;
        if (settlement) {
            try {
                await settlement;
            } catch (error) {
                if (!isWorkflowInteractionCapacityError(error)) throw error;
                throw Object.assign(
                    createExecutionRunCodedError(WORKFLOW_INTERACTION_CAPACITY_EXCEEDED, error.message),
                    { code: WORKFLOW_INTERACTION_CAPACITY_EXCEEDED, recoverable: true as const },
                );
            } finally {
                if (pendingTurnTerminalSettlement === settlement) pendingTurnTerminalSettlement = null;
            }
        }
        if (!completionError) return;
        const event = readRuntimeTurnFailureAlreadySurfacedEvent(completionError);
        if (event?.diagnostic.code !== WORKFLOW_INTERACTION_CAPACITY_EXCEEDED) {
            if (!event) throw sanitizeThrownError(completionError, sanitize, { runId });
            throw createRuntimeTurnFailureAlreadySurfacedError({
                message: sanitize(completionError instanceof Error ? completionError.message : event.diagnostic.code),
                event: {
                    ...event,
                    diagnostic: {
                        ...event.diagnostic,
                        ...(event.diagnostic.message ? { message: sanitize(event.diagnostic.message) } : {}),
                    },
                },
            });
        }
        throw Object.assign(
            createExecutionRunCodedError(
                WORKFLOW_INTERACTION_CAPACITY_EXCEEDED,
                sanitize(event.diagnostic.message ?? WORKFLOW_INTERACTION_CAPACITY_EXCEEDED),
            ),
            { code: WORKFLOW_INTERACTION_CAPACITY_EXCEEDED, recoverable: true as const },
        );
    };

    return Object.freeze({
        async executeAction(actionId: string, input: unknown, actionRequestId: string) {
            const { sessionMcpContext } = await prepareSessionContext();
            if (!sessionMcpContext) return { ok: false as const, errorCode: 'not_authenticated', error: 'Authenticated Session MCP context is required.' };
            return await callSessionMcpTool({ source: 'happier', toolName: 'action_execute', args: { actionId, input },
                actionRequestId, sessionContext: sessionMcpContext, signal });
        },
        permissionCapability: params.createSessionContext.respondToPermissionRequest ? 'responds' as const : 'static' as const,
        ...(params.createSessionContext.abortPendingPermissionRequests
            ? { abortPendingPermissionRequests: params.createSessionContext.abortPendingPermissionRequests }
            : {}),
        ...(params.createSessionContext.respondToPermissionRequest
            ? {
                async respondToPermission(requestId: string, approved: boolean, response?: PermissionResult) {
                    return toRuntimePermissionResponseOutcome(await params.createSessionContext.respondToPermissionRequest!(requestId, approved, response));
                },
            }
            : {}),
        getRuntimeLifetimeSignal: () => signal,
        readActiveTurnAdmissionWitness: () => operations?.readActiveTurnAdmissionWitness?.() ?? null,
        subscribeProviderInputOutcomes(handler) {
            inputOutcomeListeners.add(handler);
            return () => inputOutcomeListeners.delete(handler);
        },
        subscribeRuntimeEvents(handler) {
            runtimeEventListeners.add(handler);
            const waiting = recoveringSession?.readRecoveryWaiting();
            if (waiting) handler(waiting);
            return () => runtimeEventListeners.delete(handler);
        },
        // The exact adapter choice is the projection. A finite or native Execution
        // Run adapter never carries it, so a transcript-only or reconstructed run
        // cannot appear interactive.
        interaction: Object.freeze({
            kind: 'retained_agent_session.v1' as const,
            capabilities: params.sessionCapabilities,
        }),
        async readResumeSupport() {
            return supportsResume;
        },
        async prepareInputBudget() {
            assertUsable();
            const maxInputUnicodeCharacters = await params.readMaxInputUnicodeCharacters?.();
            assertUsable();
            if (maxInputUnicodeCharacters == null) return undefined;
            await prepareSessionContext();
            assertUsable();
            return runInputBudget(maxInputUnicodeCharacters, skillIndex);
        },
        readProviderSessionId() {
            if (!supportsResume) return null;
            return operations?.readSessionIdentity?.().sessionId ?? resumedProviderSessionId;
        },
        async canContinueAfterCancellation(timeoutMs) {
            if (!params.sessionCapabilities.cancel || !params.sessionCapabilities.delivery.includes('newTurn')) return false;
            try {
                assertUsable();
                // A never-delivered first turn has no completion to join. For
                // delivered turns the canonical owner also retires interactions.
                if (turnOrdinal > 0) await waitForTurnCompletion(timeoutMs);
                assertUsable();
                return operations?.canStartNewTurn?.() === true;
            } catch {
                return false;
            }
        },
        async provisionRuntime(options) {
            assertUsable();
            provisionPromise ??= (async () => {
                if (options?.resumeRuntimeId && !supportsResume) {
                    throw new Error('Backend does not support resume');
                }
                await open(options?.resumeRuntimeId);
                if (options?.initialPrompt !== undefined) {
                    const turnId = `${runId}-turn-${++turnOrdinal}`;
                    pendingTurnInputId = `${runId}-input-${turnOrdinal}`;
                    pendingTurnAdmissionFailure = null;
                    operations!.beginTurnLifecycle();
                    try {
                        await operations!.sendTurnPrompt(withRunSkillIndex({ text: options.initialPrompt }, skillIndex).text, {
                            turnId,
                            localId: pendingTurnInputId,
                            ...(params.options.causalPermissionAuthority
                                ? { causalPermissionAuthority: params.options.causalPermissionAuthority }
                                : {}),
                            ...(params.options.actionRequestAttributionV1
                                ? { actionRequestAttributionV1: params.options.actionRequestAttributionV1 } : {}),
                        });
                    } catch (error) {
                        throw pendingTurnAdmissionFailure ?? error;
                    }
                }
                return Object.freeze({ runtimeId: runId });
            })();
            return await provisionPromise;
        },
        async deliverInput(runtimeId, input, meta) {
            assertUsable();
            if (!provisionPromise || runtimeId !== runId) {
                throw new Error(`Native Agent Session interaction '${runId}' is not provisioned for runtime '${runtimeId}'`);
            }
            await provisionPromise;
            await open();
            const inputOrdinal = ++turnOrdinal;
            const localId = meta?.localId ?? `${runId}-input-${inputOrdinal}`;
            const userMessageSeq = meta?.userMessageSeq !== undefined
                ? meta.userMessageSeq
                : params.options.scope === 'session_owned'
                    ? params.options.sessionInteractionHost?.session.getCommittedUserMessageSeq?.(localId) ?? null
                    : null;
            let resolvedInput: AgentSessionInput;
            try {
                resolvedInput = params.createSessionContext.resolveStructuredInputForDispatch
                    ? await params.createSessionContext.resolveStructuredInputForDispatch({ input, localId, signal })
                    : input;
            } catch (error) {
                return rejectStructuredInputBeforeProviderEffect(error);
            }
            pendingTurnInputId = localId;
            pendingTurnAdmissionFailure = null;
            operations!.beginTurnLifecycle();
            try {
                resolvedInput = withSupportedNativeOutputSchema(resolvedInput, params.options.selectedModelSupportsStructuredOutput);
                await operations!.sendTurnPrompt(withRunSkillIndex(resolvedInput, skillIndex).text, {
                    ...meta,
                    localId,
                    ...(resolvedInput.structuredInput === undefined ? {} : { structuredInput: resolvedInput.structuredInput }),
                    ...(resolvedInput.outputSchema === undefined ? {} : { outputSchema: resolvedInput.outputSchema }),
                    userMessageSeq,
                    ...(meta?.userMessageSeqs ? { userMessageSeqs: meta.userMessageSeqs } : {}),
                    ...(meta?.causalPermissionAuthority
                        ? { causalPermissionAuthority: meta.causalPermissionAuthority }
                        : {}),
                });
            } catch (error) {
                throw pendingTurnAdmissionFailure ?? error;
            }
            return { status: 'admitted' as const };
        },
        ...(params.sessionCapabilities.delivery.includes('steer') ? {
            async steerInput(runtimeId: string, input: AgentSessionInput, meta?: Parameters<ExecutionRunHostRuntime['deliverInput']>[2]) {
                assertUsable();
                if (!provisionPromise || runtimeId !== runId || !operations) {
                    throw new Error(`Native Agent Session interaction '${runId}' is not provisioned for runtime '${runtimeId}'`);
                }
                await provisionPromise;
                const inputOrdinal = ++turnOrdinal;
                const localId = meta?.localId ?? `${runId}-input-${inputOrdinal}`;
                let resolvedInput: AgentSessionInput;
                try {
                    resolvedInput = params.createSessionContext.resolveStructuredInputForDispatch
                        ? await params.createSessionContext.resolveStructuredInputForDispatch({ input, localId, signal })
                        : input;
                } catch (error) {
                    return rejectStructuredInputBeforeProviderEffect(error);
                }
                resolvedInput = withSupportedNativeOutputSchema(resolvedInput, params.options.selectedModelSupportsStructuredOutput);
                await operations.steerInFlightTurn(resolvedInput.text, {
                    ...meta,
                    localId,
                    ...(resolvedInput.structuredInput === undefined ? {} : { structuredInput: resolvedInput.structuredInput }),
                    ...(resolvedInput.outputSchema === undefined ? {} : { outputSchema: resolvedInput.outputSchema }),
                    ...(meta?.userMessageSeq !== undefined ? { userMessageSeq: meta.userMessageSeq } : {}),
                    ...(meta?.userMessageSeqs ? { userMessageSeqs: meta.userMessageSeqs } : {}),
                    ...(meta?.causalPermissionAuthority ? { causalPermissionAuthority: meta.causalPermissionAuthority } : {}),
                });
                return { status: 'admitted' as const };
            },
        } : {}),
        async cancel(runtimeId) {
            assertUsable();
            if (!provisionPromise || runtimeId !== runId || !operations) return;
            await operations.cancelTurn();
        },
        subscribeMessages(handler) {
            listeners.add(handler);
            return () => listeners.delete(handler);
        },
        waitForTurnCompletion,
        async dispose() {
            if (disposed) return;
            disposed = true;
            ownedAbortController.abort(new Error('Native Agent Session interaction disposed'));
            unsubscribeEvents?.();
            unsubscribeEvents = null;
            listeners.clear();
            inputOutcomeListeners.clear();
            runtimeEventListeners.clear();
            try {
                await operations?.resetOrDisposeRuntime('session_closed');
            } finally {
                await disposeSessionContext?.();
            }
        },
    });
}
