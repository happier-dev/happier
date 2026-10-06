import { AgentExecutionRunEventSchema } from '@happier-dev/protocol/runtime/agentExecutionRunV1';
import { AgentLaunchEnvironmentV1Schema, AgentRuntimeJsonValueV1Schema } from '@happier-dev/protocol/runtime/agentSessionV1';
import { HappierStructuredInputV1Schema } from '@happier-dev/protocol/runtime/input/structuredInputV1';
import { PluginContributionIdentityV1Schema } from '@happier-dev/protocol/plugins/contribution-identity';
import { renderSessionInputContextPromptV1 } from '@happier-dev/protocol/sessions/messages/sessionInputPromptContextV1';
import type { AccountSettings, SessionMcpSelectionV1 } from '@happier-dev/protocol';
import type {
    AgentExecutionRunEvent,
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
import { createExecutionRunHostBackendFromSessionRuntime } from '@happier-dev/plugin-sdk/host/registration';

import type { AgentMessage } from '@/agent/core/AgentMessage';
import type { CreateCliExecutionRunBackendParams } from '@/agent/runtime/registry/engineRegistryTypes';
import type { AgentSessionCapabilities } from '@/plugins/projection/registry/agentContributionDefinition';
import { createUnavailablePluginServices } from '@/plugins/runtime/invocation/services/unavailable';
import {
    createPluginInteractionsService,
    createPluginInvocationPresentation,
} from '@/plugins/runtime/invocation/services/interactions';
import {
    createNativeAgentCurrentExecutionRunUiServices,
} from '@/agent/runtime/registry/engineRegistry/nativeAgentSessionInteractions';
import { createExecutionRunPermissionHandler } from '@/agent/executionRuns/policy/executionRunPermissionDecision';
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
import {
    createNativeAgentSessionInteractionOperations,
    toNativeAgentUsageObservation,
} from '@/agent/runtime/registry/engineRegistry/nativeAgentSession';
import type { UsageObservation } from '@/usage/usageObservation';
import type { UsageObservationPublishResult } from '@/usage/createUsageObservationPublisher';
import {
    normalizeHostProviderInputOutcome,
    type SessionProviderInputOutcome,
} from '@/agent/runtime/session/input/providerInputOutcome';

import type { ExecutionRunHostRuntime } from './executionRunHostRuntime';
import type { ExecutionRunBackendStartContext } from '@/agent/executionRuns/registry/executionRunBackendTypes';
import type { AgentInvocationTurnAdmissionWitness } from '@/plugins/runtime/invocation/services/types';
import type { HostCurrentSessionUiServices } from '@/agent/runtime/state/currentSessionUiTypes';
import { createNativeAgentExecutionRunHostServices } from '@/agent/runtime/registry/engineRegistry/nativeAgentSessionHostServiceOwners';
import type { PluginRuntimeAuthoritySnapshotV1 } from '@/plugins/runtime/lifecycle/activation/runtimeAuthority';
import { readRuntimeTurnFailureAlreadySurfacedEvent } from '@/agent/runtime/turns/runtimeTurnOperations';
import { resolveStructuredInputProviderDispatchContext } from '@/agent/runtime/turns/resolveStructuredInputProviderContext';
import { readConnectedServiceChildMemberLogContextFromEnv } from '@/daemon/connectedServices/connectedServiceChildEnvironment';
import { logger } from '@/ui/logger';
import { createExecutionRunCodedError, readExecutionRunRejectedStartDiagnostic, type ExecutionRunRejectedStartError } from './errors';
import {
    isWorkflowInteractionCapacityError,
    WORKFLOW_INTERACTION_CAPACITY_EXCEEDED,
} from '@/agent/permissions/interactionPersistenceError';

type NativeAgentRunUsagePublisher = Readonly<{
    provider: string;
    publish(input: Readonly<{
        observedAt: number;
        observation: UsageObservation;
        turnId: string | null;
        externalKey: string;
    }>): void | Promise<void | UsageObservationPublishResult>;
}>;

type NativeAgentSessionContextLease = Readonly<{
    context: AgentSessionRuntimeContext;
    mcpServers?: AgentSessionOpenRequest['mcpServers'];
    usagePublisher?: NativeAgentRunUsagePublisher;
    dispose(): Promise<void>;
}>;

export type NativeAgentSessionContextLeaseFactory = ((params: Readonly<{
    services: PluginServices;
    signal: AbortSignal;
    readActiveTurnAdmissionWitness?: () => AgentInvocationTurnAdmissionWitness | null;
}>) => Promise<NativeAgentSessionContextLease> | NativeAgentSessionContextLease) & Readonly<{
    bindInvocationServices?: (params: Readonly<{
        services: PluginServices;
        signal: AbortSignal;
        readActiveTurnAdmissionWitness?: () => AgentInvocationTurnAdmissionWitness | null;
    }>) => Promise<PluginServices>;
    respondToPermissionRequest?: (requestId: string, approved: boolean) => boolean;
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
    dispose(): Promise<void>;
}>;

export type NativeAgentExecutionRunContextLeaseFactory = ((params: Readonly<{
    services: PluginServices;
    signal: AbortSignal;
    readActiveTurnAdmissionWitness?: () => AgentInvocationTurnAdmissionWitness | null;
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
    runId: string;
    controllerOccurrenceId: string;
    callId: string;
    sidechainId: string;
    resolveAcpHostLaunch?: Parameters<typeof createPublicAcpRuntimeProtocols>[0]['resolveHostLaunch'];
    transformAgentRequest?: Parameters<typeof createPublicAcpRuntimeProtocols>[0]['transformAgentRequest'];
    runtimeRegistry: ResolvedExecutablePluginRuntimeRegistry | null;
    runtimeAuthority?: PluginRuntimeAuthoritySnapshotV1;
    directory: string;
    machineId: string;
    accountSettings: AccountSettings | null;
    permissionMode: string;
    workspaceWrites?: 'allow' | 'deny';
    start: ExecutionRunBackendStartContext;
    causalPermissionAuthority?: CreateCliExecutionRunBackendParams['causalPermissionAuthority'];
    getPermissionRequestStore?: CreateCliExecutionRunBackendParams['getPermissionRequestStore'];
    mcpSelection?: SessionMcpSelectionV1;
    happyHomeDir?: string;
    createInvocationServices?: (params: Readonly<{
        currentSession: HostCurrentSessionUiServices;
        signal: AbortSignal;
        readActiveTurnAdmissionWitness?: () => AgentInvocationTurnAdmissionWitness | null;
    }>) => Promise<PluginServices>;
}>): NativeAgentExecutionRunContextLeaseFactory {
    const runId = readRequiredString(params.runId, 'a run id');
    const callId = readRequiredString(params.callId, 'a call id');
    const sidechainId = readRequiredString(params.sidechainId, 'a sidechain id');
    const permissionHandler = createExecutionRunPermissionHandler({
        permissionMode: params.permissionMode,
        workspaceWrites: params.workspaceWrites,
        backendId: params.lease.agentId,
        ...(Object.hasOwn(params, 'causalPermissionAuthority')
            ? { causalPermissionAuthority: params.causalPermissionAuthority }
            : {}),
        publishPendingRequest: async ({ requestId, toolName, toolInput, turnId }) => {
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
                requestId,
                toolName,
                toolInput,
                createdAt: envelope.createdAtMs,
                source: 'execution_run',
                ...(turnId ? { turnId } : {}),
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
        runId,
        controllerOccurrenceId: params.controllerOccurrenceId,
        handler: permissionHandler,
        readInteractionMode: () => {
            const requestStore = params.getPermissionRequestStore?.() ?? null;
            const { intent, runClass, ioMode, retentionPolicy } = params.start;
            if (!intent || !runClass || !ioMode || !retentionPolicy) {
                return 'interaction_unavailable';
            }
            return resolveExecutionRunPermissionInteractionMode({
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
            });
        },
    });
    const bindInvocationServices = async ({
        services,
        signal,
        readActiveTurnAdmissionWitness,
    }: Readonly<{
        services: PluginServices;
        signal: AbortSignal;
        readActiveTurnAdmissionWitness?: () => AgentInvocationTurnAdmissionWitness | null;
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
            occurrenceId: params.lease.occurrenceId,
            isCurrent: params.lease.isCurrent,
            signal,
            readActiveTurnAdmissionWitness,
        });
        const boundServices = params.createInvocationServices
            ? await params.createInvocationServices({
                currentSession,
                signal,
                ...(readActiveTurnAdmissionWitness ? { readActiveTurnAdmissionWitness } : {}),
            })
            : services;
        return Object.freeze({ services: boundServices, currentSession });
    };
    const factory: NativeAgentExecutionRunContextLeaseFactory = async ({ services, signal, readActiveTurnAdmissionWitness }) => {
        const bound = await bindInvocationServices({
            services,
            signal,
            ...(readActiveTurnAdmissionWitness ? { readActiveTurnAdmissionWitness } : {}),
        });
        const executionRunServices = createNativeAgentExecutionRunHostServices({
            signal,
            executionRunId: runId,
            directory: params.directory,
            machineId: params.machineId,
            accountSettings: params.accountSettings,
            ...(params.mcpSelection ? { mcpSelection: params.mcpSelection } : {}),
            runtimeRegistry: params.runtimeRegistry,
            ...(params.runtimeAuthority ? { runtimeAuthority: params.runtimeAuthority } : {}),
            pluginId: params.lease.pluginId,
            agentId: params.lease.agentId,
            ...(params.happyHomeDir ? { happyHomeDir: params.happyHomeDir } : {}),
        });
        let context: AgentExecutionRunRuntimeContextV1;
        try {
            const created = createNativeAgentInvocationContext({
                lease: params.lease,
                runId,
                signal,
                services: bound.services,
                invokedAtMs: Date.now(),
                currentSession: bound.currentSession,
                executionRunServices,
                ...(readActiveTurnAdmissionWitness ? { readActiveTurnAdmissionWitness } : {}),
                ...(params.resolveAcpHostLaunch || params.transformAgentRequest
                    ? {
                        protocolOptions: {
                            ...(params.resolveAcpHostLaunch ? { resolveHostLaunch: params.resolveAcpHostLaunch } : {}),
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
                await executionRunServices.dispose();
            } finally {
                await runPermissionScope.dispose('Execution run context construction failed');
            }
            throw error;
        }
        return Object.freeze({
            context,
            async dispose() {
                try {
                    await executionRunServices.dispose();
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
            if (!parsed.success) return input.input;
            const envelope = parsed.data as Readonly<Record<string, unknown>>;
            if (!Object.hasOwn(envelope, 'mentions') && !Object.hasOwn(envelope, 'composerAttachments')) {
                return input.input;
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
        respondToPermissionRequest(requestId: string, approved: boolean) {
            return runPermissionScope.respondToPermissionRequest(requestId, approved);
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

function sanitizeThrownError(
    error: unknown,
    sanitize: (value: string) => string,
): Error & { code?: string } {
    if (!(error instanceof Error)) {
        return new Error(sanitize(String(error)));
    }
    const sanitized = new Error(sanitize(error.message)) as Error & { code?: string };
    sanitized.name = error.name;
    if ('code' in error && typeof error.code === 'string') {
        sanitized.code = error.code;
    }
    return sanitized;
}

function createDisposedError(): Error {
    const error = new Error('Native Agent execution run disposed');
    error.name = 'AbortError';
    return error;
}

function toHostMessage(
    event: AgentExecutionRunEvent,
    sanitize: (value: string) => string,
): AgentMessage | null {
    switch (event.kind) {
        case 'run-start':
        case 'run-progress':
            return { type: 'status', status: 'running' };
        case 'output-delta':
            return event.channel === 'assistant'
                ? { type: 'model-output', textDelta: event.text }
                : { type: 'event', name: 'thinking', payload: { textDelta: event.text } };
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
    event: AgentSessionRuntimeEvent,
    sanitize: (value: string) => string,
): AgentMessage | null {
    switch (event.kind) {
        case 'message-delta':
            return event.channel === 'assistant'
                ? { type: 'model-output', textDelta: event.text }
                : { type: 'event', name: 'thinking', payload: { textDelta: event.text } };
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
): AgentLaunchEnvironment | undefined {
    if (options.isolation?.env === undefined && options.isolation?.unsetEnvKeys === undefined) {
        return undefined;
    }
    return AgentLaunchEnvironmentV1Schema.parse({
        values: options.isolation.env ?? {},
        unset: options.isolation.unsetEnvKeys ?? [],
    });
}

function createNativeAgentInvocationContext(params: Readonly<{
    lease: NativeAgentRuntimeLeaseIdentity;
    runId: string;
    signal: AbortSignal;
    services: PluginServices;
    invokedAtMs: number;
    protocolOptions?: Pick<
        Parameters<typeof createPublicAcpRuntimeProtocols>[0],
        'resolveHostLaunch' | 'transformAgentRequest'
    >;
    currentSession?: Parameters<typeof createPluginInvocationPresentation>[0]['currentSession'];
    readActiveTurnAdmissionWitness?: () => AgentInvocationTurnAdmissionWitness | null;
    executionRunServices?: AgentExecutionRunHostServicesV1;
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
            pluginId: params.lease.pluginId,
            agentId: params.lease.agentId,
            signal: params.signal,
            isCurrent: params.lease.isCurrent,
            services,
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
        executionRun: Object.freeze({ id: params.runId, services: executionRunServices }),
    });
}

export function createNativeAgentExecutionRunHostRuntime(params: Readonly<{
    runtime: AgentRuntime;
    /** Additive detached facet for a Session-primary Agent. */
    executionRunContextV1?: AgentSessionExecutionRunRuntimeFactoryV1;
    lease: NativeAgentRuntimeLeaseIdentity;
    options: CreateCliExecutionRunBackendParams;
    supportsResume: boolean;
    generationSignal?: AbortSignal;
    services?: Promise<PluginServices>;
    createExecutionRunContext?: NativeAgentExecutionRunContextLeaseFactory;
    bindInvocationServices?: NativeAgentSessionContextLeaseFactory['bindInvocationServices'];
    respondToPermissionRequest?: NativeAgentSessionContextLeaseFactory['respondToPermissionRequest'];
    abortPendingPermissionRequests?: (reason: string) => Promise<void>;
    resolveStructuredInputForDispatch?: NativeAgentSessionContextLeaseFactory['resolveStructuredInputForDispatch'];
}>): ExecutionRunHostRuntime {
    const directExecutionRuns = params.runtime.executionRuns;
    if (!params.executionRunContextV1 && !directExecutionRuns) {
        throw new Error(`Agent runtime '${params.lease.agentId}' does not support execution runs`);
    }
    const runId = readRequiredString(params.options.runId, 'a run id');
    const profileId = readRequiredString(
        params.options.start?.profileId ?? params.options.start?.intent,
        'an execution profile id',
    );
    const profile = resolveExecutionProfileReference(profileId, params.lease.pluginId);
    const launchEnvironment = buildLaunchEnvironment(params.options);
    const boundedOpenInputs = Object.freeze({
        stateSharing: resolveNativeAgentSessionStateSharingPolicy(params.lease.agentId),
        ...(launchEnvironment ? { launchEnvironment } : {}),
        ...(params.options.runtimeDescriptorV1
            ? { runtimeDescriptorV1: params.options.runtimeDescriptorV1 }
            : {}),
        ...(params.options.modelSelection
            ? { modelSelection: params.options.modelSelection }
            : {}),
        ...(params.options.configuration
            ? { configuration: params.options.configuration }
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
    let nativeRuntimePromise: Promise<AgentExecutionRunRuntime> | null = null;
    let nativeRuntime: AgentExecutionRunRuntime | null = null;
    let watchDisposable: { dispose(): void | Promise<void> } | null = null;
    let executionRunContextLease: NativeAgentExecutionRunContextLease | null = null;
    let lastSequence = -1;
    let terminal = false;
    let disposed = false;
    let openingInitialInput = false;
    let providerWorkObserved = false;
    let rejectedStart: ExecutionRunRejectedStartError | null = null;
    let resolveTerminal!: () => void;
    let rejectTerminal!: (error: Error) => void;
    const terminalPromise = new Promise<void>((resolve, reject) => {
        resolveTerminal = resolve;
        rejectTerminal = reject;
    });
    void terminalPromise.catch(() => undefined);

    function logProviderFailure(): void {
        logger.warn('[EXECUTION RUN] provider failure', {
            runId,
            agentId: params.lease.agentId,
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
        return params.resolveStructuredInputForDispatch
            ? await params.resolveStructuredInputForDispatch({ input, localId, signal })
            : input;
    }

    function failRuntime(message: string): void {
        if (terminal) return;
        terminal = true;
        const error = new Error(message);
        emit({ type: 'status', status: 'error', detail: message });
        rejectTerminal(error);
    }

    function handleEvent(event: AgentExecutionRunEvent): void {
        const parsed = AgentExecutionRunEventSchema.safeParse(event);
        if (!parsed.success) {
            failRuntime(`Native Agent execution run '${runId}' emitted an invalid runtime event`);
            return;
        }
        const normalizedEvent = parsed.data;
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
        if (normalizedEvent.kind === 'run-progress' || normalizedEvent.kind === 'output-delta'
            || normalizedEvent.kind === 'run-complete' || normalizedEvent.kind === 'run-cancelled') {
            providerWorkObserved = true;
        }
        if (normalizedEvent.kind === 'run-failed' && openingInitialInput && !providerWorkObserved) {
            const rejection = readExecutionRunRejectedStartDiagnostic(normalizedEvent.diagnostic);
            if (rejection) {
                logProviderFailure();
                rejectedStart = rejection;
                terminal = true;
                rejectTerminal(rejection);
                return;
            }
        }
        if (normalizedEvent.kind === 'run-failed') logProviderFailure();
        const message = toHostMessage(normalizedEvent, sanitizeProviderDiagnosticText);
        if (message) emit(message);
        if (normalizedEvent.kind === 'run-complete' || normalizedEvent.kind === 'run-cancelled') {
            terminal = true;
            resolveTerminal();
        } else if (normalizedEvent.kind === 'run-failed') {
            terminal = true;
            rejectTerminal(createExecutionRunCodedError(
                normalizedEvent.diagnostic?.code ?? 'agent_execution_run_failed',
                diagnosticMessage(normalizedEvent.diagnostic, sanitizeProviderDiagnosticText),
            ));
        }
    }

    async function openNative(request: AgentExecutionRunOpenRequest): Promise<AgentExecutionRunRuntime> {
        assertUsable();
        if (nativeRuntimePromise) return await nativeRuntimePromise;
        const invokedAtMs = Date.now();
        nativeRuntimePromise = (async () => {
            const fallbackServices = await servicesPromise;
            assertUsable();
            const context = params.createExecutionRunContext
                ? (executionRunContextLease = await params.createExecutionRunContext({
                    services: fallbackServices,
                    signal,
                })).context
                : createNativeAgentInvocationContext({
                    lease: params.lease,
                    runId,
                    signal,
                    services: params.bindInvocationServices
                        ? await params.bindInvocationServices({ services: fallbackServices, signal })
                        : fallbackServices,
                    invokedAtMs,
                });
            assertUsable();
            let providerCurrent: Awaited<ReturnType<NonNullable<
                CreateCliExecutionRunBackendParams['revalidateProviderBeforeOpen']
            >>> | undefined;
            try {
                providerCurrent = await params.options.revalidateProviderBeforeOpen?.();
            } catch (error) {
                throw sanitizeThrownError(error, sanitizeProviderDiagnosticText);
            }
            if (providerCurrent && !providerCurrent.ok) {
                throw Object.assign(
                    new Error(providerCurrent.error.code),
                    { code: providerCurrent.error.code },
                );
            }
            assertUsable();
            let opened: AgentExecutionRunRuntime;
            try {
                if (params.executionRunContextV1) {
                    if (!('executionRun' in context)) {
                        throw new Error('Session-primary detached execution requires execution-run scope');
                    }
                    opened = await params.executionRunContextV1.open(request, context);
                } else {
                    opened = await directExecutionRuns!.open(request, context);
                }
            } catch (error) {
                logProviderFailure();
                throw sanitizeThrownError(error, sanitizeProviderDiagnosticText);
            }
            try {
                assertUsable();
                nativeRuntime = opened;
                openingInitialInput = request.kind === 'create';
                watchDisposable = opened.watch(handleEvent);
                if (rejectedStart) throw rejectedStart;
            } catch (error) {
                if (rejectedStart === error) throw error;
                await opened.dispose();
                throw sanitizeThrownError(error, sanitizeProviderDiagnosticText);
            } finally {
                openingInitialInput = false;
            }
            return opened;
        })();
        return await nativeRuntimePromise;
    }

    return Object.freeze({
        permissionCapability: params.respondToPermissionRequest ? 'responds' as const : 'static' as const,
        ...(params.respondToPermissionRequest
            ? {
                async respondToPermission(requestId: string, approved: boolean) {
                    return params.respondToPermissionRequest!(requestId, approved)
                        ? { delivered: true as const }
                        : { delivered: false as const, reason: 'unknown_request' as const };
                },
            }
            : {}),
        ...(params.abortPendingPermissionRequests
            ? { abortPendingPermissionRequests: params.abortPendingPermissionRequests }
            : {}),
        async readResumeSupport() {
            return params.supportsResume;
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
                            params.options.start?.structuredInput ?? params.options.start?.intentInput,
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
        async deliverInput(runtimeId, admittedInput, meta) {
            assertUsable();
            if (!provisionPromise || runtimeId !== runId) {
                throw new Error(`Native Agent execution run '${runId}' is not provisioned for runtime '${runtimeId}'`);
            }
            await provisionPromise;
            if (terminal) throw new Error(`Native Agent execution run '${runId}' has already terminated`);
            const localId = meta?.localId ?? params.options.start?.localInputId ?? `${runId}-input`;
            const carriedInput = admittedInput.structuredInput === undefined
                ? buildInput(
                    admittedInput.text,
                    params.options.start?.structuredInput ?? params.options.start?.intentInput,
                )
                : admittedInput;
            let input: AgentSessionInput;
            try {
                input = await resolveInputForDispatch(carriedInput, localId);
            } catch (error) {
                return rejectStructuredInputBeforeProviderEffect(error);
            }
            if (!nativeRuntimePromise) {
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
            let result: Awaited<ReturnType<AgentExecutionRunRuntime['send']>>;
            try {
                result = await opened.send(input, {
                    signal,
                    ...(meta?.localId ? { localInputId: meta.localId } : {}),
                    ...(meta?.resultContract ? { resultContract: meta.resultContract } : {}),
                    ...(meta?.causalPermissionAuthority
                        ? { causalPermissionAuthority: meta.causalPermissionAuthority }
                        : {}),
                });
            } catch (error) {
                logProviderFailure();
                throw sanitizeThrownError(error, sanitizeProviderDiagnosticText);
            }
            if (result.status !== 'admitted') {
                logProviderFailure();
                throw new Error(diagnosticMessage(
                    result.diagnostic,
                    sanitizeProviderDiagnosticText,
                ));
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
            const opened = nativeRuntime ?? (nativeRuntimePromise ? await nativeRuntimePromise : null);
            if (!opened) return;
            let result: Awaited<ReturnType<AgentExecutionRunRuntime['stop']>>;
            try {
                result = await opened.stop({ signal });
            } catch (error) {
                logProviderFailure();
                throw sanitizeThrownError(error, sanitizeProviderDiagnosticText);
            }
            if (result.status === 'unavailable' || result.status === 'unsupported') {
                throw new Error(`Native Agent execution run stop is ${result.status}`);
            }
        },
        subscribeMessages(handler) {
            listeners.add(handler);
            return () => listeners.delete(handler);
        },
        async waitForTurnCompletion() {
            if (!nativeRuntimePromise) return;
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
                rejectTerminal(createDisposedError());
            }
            ownedAbortController.abort(new Error('Native Agent execution run disposed'));
            const watch = watchDisposable;
            watchDisposable = null;
            listeners.clear();
            // Cleanup is attempted exactly once, best effort: it must not
            // block this return on a provider open that never settles, and a
            // provider cleanup failure is logged nowhere the caller depends
            // on. A late-settling open is disposed when it settles.
            const cleanupOpened = (opened: AgentExecutionRunRuntime | null): void => {
                if (!opened) return;
                void Promise.resolve().then(() => opened.dispose()).catch(() => undefined);
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
                void contextLease.dispose().catch(() => undefined);
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
    generationSignal?: AbortSignal;
    services?: Promise<PluginServices>;
    createSessionContext: NativeAgentSessionContextLeaseFactory;
}>): ExecutionRunHostRuntime {
    const sessions = params.runtime.sessions;
    if (!sessions) {
        throw new Error(`Agent runtime '${params.lease.agentId}' does not support sessions`);
    }
    const executionRuns: AgentExecutionRunRuntimeFactory = Object.freeze({
        async open(
            request: AgentExecutionRunOpenRequest,
            executionContext: AgentRuntimeContext,
        ) {
                if (request.kind === 'fork') {
                    throw new Error('Host-derived Session execution runs do not support fork');
                }
                const sessionContext = await params.createSessionContext({
                    services: executionContext.services,
                    signal: executionContext.signal,
                });
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
                try {
                    const runScopedContext: AgentSessionRuntimeContext = Object.freeze({
                        ...sessionContext.context,
                        // A finite child Run may reuse its parent's Session context
                        // services, but it never owns the parent's published work state.
                        workState: createRunScopedWorkStateService(executionContext.signal),
                    });
                    execution = await createExecutionRunHostBackendFromSessionRuntime({
                        request: sessionContext.mcpServers
                            ? { ...request, mcpServers: sessionContext.mcpServers }
                            : request,
                        sessionId: sessionContext.context.session.id,
                        openSession: async (sessionRequest) => {
                            const opened = await sessions.open(sessionRequest, runScopedContext);
                            const boundaryError = readBoundaryError();
                            if (boundaryError) {
                                void Promise.resolve()
                                    .then(() => opened.dispose('runtime_recovery'))
                                    .catch(() => {
                                        // Preserve the refusal when provider cleanup fails or never settles.
                                    });
                                throw boundaryError;
                            }
                            return opened;
                        },
                        readCheckpointId: (event) => event.kind === 'provider-session-id'
                            ? event.providerSessionId
                            : null,
                        ...(sessionContext.usagePublisher || params.options.start?.observeWorkflowUsage ? {
                            observeSessionUsage: (event: Extract<AgentSessionRuntimeEvent, { kind: 'usage-observed' }>) => {
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
                                    })).catch(() => undefined);
                                }
                            },
                        } : {}),
                    });
                } catch (error) {
                    try {
                        await sessionContext.dispose();
                    } catch {
                        // Preserve the Session open/admission failure after cleanup was attempted.
                    }
                    throw error;
                }
                let disposed = false;
                return Object.freeze({
                    send: execution.send.bind(execution),
                    stop: execution.stop.bind(execution),
                    watch: execution.watch.bind(execution),
                    async dispose() {
                        if (disposed) return;
                        disposed = true;
                        // The SDK lifecycle has already settled terminal truth.
                        // Both native cleanup leaves are exactly-once, detached,
                        // and best effort so neither can retain the controller.
                        void Promise.resolve().then(() => execution.dispose())
                            .catch(() => undefined);
                        void Promise.resolve().then(() => sessionContext.dispose())
                            .catch(() => undefined);
                    },
                });
        },
    });
    const derivedRuntime: AgentRuntime = Object.freeze({
        executionRuns,
    });
    return createNativeAgentExecutionRunHostRuntime({
        runtime: derivedRuntime,
        lease: params.lease,
        options: params.options,
        supportsResume: params.supportsResume,
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
    const runtimeEventListeners = new Set<(event: AgentSessionRuntimeEvent) => void>();
    let operations: ReturnType<typeof createNativeAgentSessionInteractionOperations> | null = null;
    let unsubscribeEvents: (() => void) | null = null;
    let disposeSessionContext: (() => Promise<void>) | null = null;
    let openPromise: Promise<void> | null = null;
    let provisionPromise: Promise<Readonly<{ runtimeId: string }>> | null = null;
    let disposed = false;
    let turnOrdinal = 0;
    let pendingTurnTerminalSettlement: Promise<void> | null = null;
    let resumedProviderSessionId: string | null = null;

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
    const open = async (resumeSessionId?: string): Promise<void> => {
        assertUsable();
        if (openPromise) return await openPromise;
        openPromise = (async () => {
            const services = await servicesPromise;
            assertUsable();
            const sessionContext = await params.createSessionContext({
                services,
                signal,
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
            const context = sessionContext.context;
            disposeSessionContext = sessionContext.dispose;
            const common = {
                sessionId: context.session.id,
                cwd: params.options.cwd,
                ...(sessionContext.mcpServers ? { mcpServers: sessionContext.mcpServers } : {}),
                stateSharing: resolveNativeAgentSessionStateSharingPolicy(params.lease.agentId),
                ...(launchEnvironment ? { launchEnvironment } : {}),
                ...(params.options.runtimeDescriptorV1
                    ? { runtimeDescriptorV1: params.options.runtimeDescriptorV1 }
                    : {}),
                ...(params.options.modelSelection ? { modelSelection: params.options.modelSelection } : {}),
                ...(params.options.configuration ? { configuration: params.options.configuration } : {}),
                ...(params.options.providerBinding ? { providerBinding: params.options.providerBinding } : {}),
            };
            const request: AgentSessionOpenRequest = resumeSessionId
                ? { ...common, kind: 'resume', providerSessionId: resumeSessionId }
                : { ...common, kind: 'create' };
            let opened: AgentSessionRuntime | null = null;
            try {
                opened = await sessions.open(request, context);
                assertUsable();
                operations = createNativeAgentSessionInteractionOperations({
                    session: opened,
                    sessionId: context.session.id,
                    cwd: params.options.cwd,
                    context,
                    capabilities: params.sessionCapabilities,
                    ...(resumeSessionId ? { expectedProviderSessionId: resumeSessionId } : {}),
                    ...(params.options.configuration
                        ? { initialConfiguration: params.options.configuration }
                        : {}),
                });
                // A successful native resume admitted this existing vendor id.
                // Fresh sessions remain unknown until validated provider evidence.
                resumedProviderSessionId = resumeSessionId ?? null;
                operations.setOnPromptDeliveryOutcome((evidence) => {
                    const outcome = normalizeHostProviderInputOutcome(evidence);
                    if (!outcome) return;
                    for (const listener of inputOutcomeListeners) listener(outcome);
                });
                unsubscribeEvents = operations.subscribeRuntimeEvents((event) => {
                    if ('type' in event) return;
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
        })();
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
        if (event?.diagnostic.code !== WORKFLOW_INTERACTION_CAPACITY_EXCEEDED) throw completionError;
        throw Object.assign(
            createExecutionRunCodedError(
                WORKFLOW_INTERACTION_CAPACITY_EXCEEDED,
                event.diagnostic.message ?? WORKFLOW_INTERACTION_CAPACITY_EXCEEDED,
            ),
            { code: WORKFLOW_INTERACTION_CAPACITY_EXCEEDED, recoverable: true as const },
        );
    };

    return Object.freeze({
        permissionCapability: params.createSessionContext.respondToPermissionRequest ? 'responds' as const : 'static' as const,
        ...(params.createSessionContext.abortPendingPermissionRequests
            ? { abortPendingPermissionRequests: params.createSessionContext.abortPendingPermissionRequests }
            : {}),
        ...(params.createSessionContext.respondToPermissionRequest
            ? {
                async respondToPermission(requestId: string, approved: boolean) {
                    return params.createSessionContext.respondToPermissionRequest!(requestId, approved)
                        ? { delivered: true as const }
                        : { delivered: false as const, reason: 'unknown_request' as const };
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
                    operations!.beginTurnLifecycle();
                    await operations!.sendTurnPrompt(options.initialPrompt, {
                        turnId,
                        localId: `${runId}-input-${turnOrdinal}`,
                        ...(params.options.causalPermissionAuthority
                            ? { causalPermissionAuthority: params.options.causalPermissionAuthority }
                            : {}),
                    });
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
            let resolvedInput: AgentSessionInput;
            try {
                resolvedInput = params.createSessionContext.resolveStructuredInputForDispatch
                    ? await params.createSessionContext.resolveStructuredInputForDispatch({ input, localId, signal })
                    : input;
            } catch (error) {
                return rejectStructuredInputBeforeProviderEffect(error);
            }
            operations!.beginTurnLifecycle();
            await operations!.sendTurnPrompt(resolvedInput.text, {
                ...meta,
                localId,
                ...(resolvedInput.structuredInput === undefined ? {} : { structuredInput: resolvedInput.structuredInput }),
                ...(meta?.userMessageSeq !== undefined ? { userMessageSeq: meta.userMessageSeq } : {}),
                ...(meta?.userMessageSeqs ? { userMessageSeqs: meta.userMessageSeqs } : {}),
                ...(meta?.causalPermissionAuthority
                    ? { causalPermissionAuthority: meta.causalPermissionAuthority }
                    : {}),
            });
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
                await operations.steerInFlightTurn(resolvedInput.text, {
                    ...meta,
                    localId,
                    ...(resolvedInput.structuredInput === undefined ? {} : { structuredInput: resolvedInput.structuredInput }),
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
