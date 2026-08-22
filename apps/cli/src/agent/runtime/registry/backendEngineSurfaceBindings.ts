import type { SessionHandle } from '@happier-dev/plugin-sdk/sessions';
import type {
    ForkAvailabilityRequestV1 as HostForkAvailabilityRequestV1,
    ForkRequestV1 as HostForkRequestV1,
    ReplayForkChildLaunchRequestV1 as HostReplayForkChildLaunchRequestV1,
} from '@happier-dev/agents';
import {
    HostTerminalModelSelectionBlockedError,
    type HostTerminalOrchestration,
    type HostTerminalControlReturnReason,
    type HostTerminalLaunchRequest,
    type HostTerminalProcessTermination,
    type HostTerminalRunResult,
} from '@/agent/runtime/session/terminal/contract';
import type {
    AgentRuntime,
    AgentTerminalControlPresentation,
    AgentTerminalLaunchPlan,
} from '@happier-dev/plugin-sdk/agents/runtime';
import type { PluginInvocationContext } from '@happier-dev/plugin-sdk';
import {
    assertAgentAuthoredSessionStateUpdates,
} from '@/agent/runtime/state/agentAuthoredSessionStateUpdates';

import type { ResolvedAgentRuntimeContribution } from '../../../plugins/projection/registry/types';

import type {
    BackendExecutionSurfaces,
    EngineResolutionDiagnostic,
} from './engineRegistryTypes';
type TerminalRuntimeLaunch = NonNullable<NonNullable<BackendExecutionSurfaces['terminalRuntime']>['launch']>;
type TerminalLaunchMetadata = Parameters<
    NonNullable<NonNullable<AgentRuntime['surfaces']>['terminal']>['resolveLaunch']
>[0]['metadata'];
type TerminalRuntimeLaunchServicesResolver = (
    request: HostTerminalLaunchRequest,
) => SessionHandle | null | Promise<SessionHandle | null>;
type TerminalRuntimeLaunchSignalResolver = (
    request: HostTerminalLaunchRequest,
) => AbortSignal | undefined;
type TerminalRuntimeHostOrchestrationResolver = (
    request: HostTerminalLaunchRequest,
) => HostTerminalOrchestration | null | Promise<HostTerminalOrchestration | null>;
type AgentRuntimeSurfaceInvocationContextResolver = (
    request: Readonly<{
        cwd: string;
        /** A Happier Session id, never a vendor/provider session id. */
        happierSessionId?: string;
    }>,
) => Promise<PluginInvocationContext>;
type AgentRuntimeForkSurface = NonNullable<NonNullable<AgentRuntime['surfaces']>['fork']>;
type AgentRuntimeHandoffSurface = NonNullable<NonNullable<AgentRuntime['surfaces']>['handoff']>;
type AgentRuntimeForkAvailabilityRequest = Parameters<NonNullable<AgentRuntimeForkSurface['evaluateAvailability']>>[0];
type AgentRuntimeForkRequest = Parameters<NonNullable<AgentRuntimeForkSurface['fork']>>[0];
type AgentRuntimeReplayForkChildLaunchRequest = Parameters<NonNullable<AgentRuntimeForkSurface['resolveReplayChildLaunch']>>[0];
type HostAcpSessionOperations = NonNullable<HostForkRequestV1['acp']>;
type HostAcpSessionResult = Awaited<ReturnType<HostAcpSessionOperations['loadSession']>>;
type HostAcpForkSessionResult = Awaited<ReturnType<HostAcpSessionOperations['forkSession']>>;
type AgentRuntimeAcpSessionOperations = NonNullable<AgentRuntimeForkRequest['acp']>;
type AgentRuntimeAcpSessionResult = Awaited<ReturnType<AgentRuntimeAcpSessionOperations['loadSession']>>;
type AgentRuntimeAcpForkSessionResult = Awaited<ReturnType<AgentRuntimeAcpSessionOperations['forkSession']>>;

function normalizeTerminalRuntimeLaunchRequest(request: unknown): HostTerminalLaunchRequest {
    if (!request || typeof request !== 'object' || Array.isArray(request)) {
        throw new Error('Terminal runtime launch request must be an object');
    }
    return request as HostTerminalLaunchRequest;
}

function readTerminalRuntimeLaunchSessionId(request: HostTerminalLaunchRequest): string | null {
    const sessionId = typeof request.sessionId === 'string' ? request.sessionId.trim() : '';
    return sessionId.length > 0 ? sessionId : null;
}

function hasTerminalRuntimeHostProjection(host: HostTerminalOrchestration): boolean {
    const projection = host.projection;
    return typeof projection?.publishControlState === 'function'
        && typeof projection.publishProviderSessionId === 'function'
        && typeof projection.publishSubagentStarted === 'function'
        && typeof projection.publishSubagentCompleted === 'function';
}

async function resolveTerminalRuntimeLaunchRequestContext(params: Readonly<{
    request: HostTerminalLaunchRequest;
    resolveServices?: TerminalRuntimeLaunchServicesResolver;
    resolveSignal?: TerminalRuntimeLaunchSignalResolver;
    resolveHostOrchestration?: TerminalRuntimeHostOrchestrationResolver;
}>): Promise<HostTerminalLaunchRequest> {
    const sessionId = readTerminalRuntimeLaunchSessionId(params.request);
    const resolvedServices = params.resolveServices && sessionId
        ? await params.resolveServices(params.request)
        : params.request.services;
    if (params.resolveServices && sessionId && !resolvedServices) {
        throw new Error(`Terminal runtime launch for session '${sessionId}' requires session-scoped services`);
    }
    const host = params.resolveHostOrchestration && sessionId
        ? await params.resolveHostOrchestration(params.request)
        : params.request.host;
    if (params.resolveHostOrchestration && sessionId && !host) {
        throw new Error(`Terminal runtime launch for session '${sessionId}' requires terminal host orchestration`);
    }
    if (host && !hasTerminalRuntimeHostProjection(host)) {
        throw new Error(`Terminal runtime launch for session '${sessionId ?? 'unknown'}' requires terminal host projection`);
    }
    const signal = params.request.signal ?? params.resolveSignal?.(params.request);
    return {
        ...params.request,
        ...(resolvedServices ? { services: resolvedServices } : {}),
        ...(host ? { host } : {}),
        ...(signal ? { signal } : {}),
    };
}

function assertCurrentNativeAgentTerminalGeneration(params: Readonly<{
    agentId: string;
    isCurrent: () => boolean;
}>): void {
    if (!params.isCurrent()) {
        throw new Error(`Native Agent terminal launch for '${params.agentId}' belongs to a retired runtime generation`);
    }
}

function assertStringArray(value: unknown, field: string): asserts value is readonly string[] {
    if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
        throw new Error(`Native Agent terminal launch plan '${field}' must be an array of strings`);
    }
}

function assertPlainRecord(value: unknown, field: string): asserts value is Readonly<Record<string, unknown>> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error(`Native Agent terminal launch plan '${field}' must be an object`);
    }
}

function assertOnlyKeys(value: Readonly<Record<string, unknown>>, allowed: readonly string[], field: string): void {
    const allowedKeys = new Set(allowed);
    const unexpected = Object.keys(value).find((key) => !allowedKeys.has(key));
    if (unexpected) {
        throw new Error(`Native Agent terminal launch plan '${field}' contains unsupported field '${unexpected}'`);
    }
}

function assertTerminalControlPresentation(
    value: unknown,
    field: string,
): asserts value is AgentTerminalControlPresentation {
    assertPlainRecord(value, field);
    assertOnlyKeys(value, ['target', 'reason'], field);
    if (value.target !== 'local' && value.target !== 'remote') {
        throw new Error(`Native Agent terminal launch plan '${field}.target' must be 'local' or 'remote'`);
    }
    if (value.reason !== undefined && typeof value.reason !== 'string') {
        throw new Error(`Native Agent terminal launch plan '${field}.reason' must be a string`);
    }
}

function assertNativeAgentTerminalLaunchPlan(value: unknown): asserts value is AgentTerminalLaunchPlan {
    assertPlainRecord(value, 'root');
    assertOnlyKeys(value, ['argv', 'environment', 'process', 'presentation', 'resultMetadata'], 'root');
    assertStringArray(value.argv, 'argv');
    if (value.environment !== undefined) {
        assertPlainRecord(value.environment, 'environment');
        assertOnlyKeys(value.environment, ['values', 'unset'], 'environment');
        assertPlainRecord(value.environment.values, 'environment.values');
        if (Object.values(value.environment.values).some((entry) => typeof entry !== 'string')) {
            throw new Error("Native Agent terminal launch plan 'environment.values' must contain only strings");
        }
        assertStringArray(value.environment.unset, 'environment.unset');
    }
    if (value.process !== undefined) {
        assertPlainRecord(value.process, 'process');
        assertOnlyKeys(value.process, ['stdio', 'windowsHide', 'windowsVerbatimArguments'], 'process');
        if (value.process.stdio !== undefined && value.process.stdio !== 'inherit' && value.process.stdio !== 'pipe') {
            throw new Error("Native Agent terminal launch plan 'process.stdio' must be 'inherit' or 'pipe'");
        }
        if (value.process.windowsHide !== undefined && typeof value.process.windowsHide !== 'boolean') {
            throw new Error("Native Agent terminal launch plan 'process.windowsHide' must be a boolean");
        }
        if (
            value.process.windowsVerbatimArguments !== undefined
            && typeof value.process.windowsVerbatimArguments !== 'boolean'
        ) {
            throw new Error("Native Agent terminal launch plan 'process.windowsVerbatimArguments' must be a boolean");
        }
    }
    if (value.presentation !== undefined) {
        assertPlainRecord(value.presentation, 'presentation');
        assertOnlyKeys(value.presentation, ['onLaunch', 'onExit'], 'presentation');
        if (value.presentation.onLaunch !== undefined) {
            assertTerminalControlPresentation(value.presentation.onLaunch, 'presentation.onLaunch');
        }
        if (value.presentation.onExit !== undefined) {
            assertTerminalControlPresentation(value.presentation.onExit, 'presentation.onExit');
        }
    }
    if (value.resultMetadata !== undefined) {
        assertPlainRecord(value.resultMetadata, 'resultMetadata');
        assertOnlyKeys(value.resultMetadata, ['sessionStateUpdates'], 'resultMetadata');
        if (value.resultMetadata.sessionStateUpdates !== undefined) {
            assertAgentAuthoredSessionStateUpdates(
                value.resultMetadata.sessionStateUpdates,
                'resultMetadata.sessionStateUpdates',
            );
        }
    }
}

function readString(value: unknown): string | undefined {
    return typeof value === 'string' ? value : undefined;
}

function readBoolean(value: unknown): boolean | undefined {
    return typeof value === 'boolean' ? value : undefined;
}

function readStringArray(value: unknown): readonly string[] | undefined {
    return Array.isArray(value) && value.every((entry) => typeof entry === 'string') ? value : undefined;
}

function projectTerminalRuntimeMetadata(value: unknown): TerminalLaunchMetadata['terminalRuntime'] {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
    assertPlainRecord(value, 'metadata.terminalRuntime');
    const metadata = value;
    const projected = {
        ...(readStringArray(metadata.claudeArgs) ? { claudeArgs: readStringArray(metadata.claudeArgs) } : {}),
        ...(readStringArray(metadata.codexArgs) ? { codexArgs: readStringArray(metadata.codexArgs) } : {}),
        ...(readBoolean(metadata.promptInteractive) !== undefined ? { promptInteractive: readBoolean(metadata.promptInteractive) } : {}),
        ...(readString(metadata.conversationId) !== undefined ? { conversationId: readString(metadata.conversationId) } : {}),
        ...(readBoolean(metadata.continueLatest) !== undefined ? { continueLatest: readBoolean(metadata.continueLatest) } : {}),
        ...(readBoolean(metadata.sandbox) !== undefined ? { sandbox: readBoolean(metadata.sandbox) } : {}),
        ...(readString(metadata.logFile) !== undefined ? { logFile: readString(metadata.logFile) } : {}),
        ...(readBoolean(metadata.print) !== undefined ? { print: readBoolean(metadata.print) } : {}),
        ...(readBoolean(metadata.unsafeSkipPermissions) !== undefined ? { unsafeSkipPermissions: readBoolean(metadata.unsafeSkipPermissions) } : {}),
    };
    return Object.keys(projected).length > 0 ? Object.freeze(projected) : undefined;
}

function projectAntigravityTerminalMetadata(value: unknown) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
    assertPlainRecord(value, 'metadata.antigravity');
    const metadata = value;
    const projected = {
        ...(readBoolean(metadata.promptInteractive) !== undefined ? { promptInteractive: readBoolean(metadata.promptInteractive) } : {}),
        ...(readString(metadata.conversationId) !== undefined ? { conversationId: readString(metadata.conversationId) } : {}),
        ...(readBoolean(metadata.continueLatest) !== undefined ? { continueLatest: readBoolean(metadata.continueLatest) } : {}),
        ...(readBoolean(metadata.sandbox) !== undefined ? { sandbox: readBoolean(metadata.sandbox) } : {}),
        ...(readString(metadata.logFile) !== undefined ? { logFile: readString(metadata.logFile) } : {}),
        ...(readBoolean(metadata.print) !== undefined ? { print: readBoolean(metadata.print) } : {}),
        ...(readBoolean(metadata.unsafeSkipPermissions) !== undefined ? { unsafeSkipPermissions: readBoolean(metadata.unsafeSkipPermissions) } : {}),
    };
    return Object.keys(projected).length > 0 ? Object.freeze(projected) : undefined;
}

function projectTerminalAgentLaunchMetadata(
    metadata: Readonly<Record<string, unknown>>,
): TerminalLaunchMetadata {
    const terminalRuntime = projectTerminalRuntimeMetadata(metadata.terminalRuntime);
    const antigravity = projectAntigravityTerminalMetadata(metadata.antigravity);
    return Object.freeze({
        ...(terminalRuntime ? { terminalRuntime } : {}),
        ...(antigravity ? { antigravity } : {}),
        ...(readString(metadata.providerSessionId) !== undefined ? { providerSessionId: readString(metadata.providerSessionId) } : {}),
        ...(readString(metadata.codexSessionId) !== undefined ? { codexSessionId: readString(metadata.codexSessionId) } : {}),
        ...(readString(metadata.resumeId) !== undefined ? { resumeId: readString(metadata.resumeId) } : {}),
        ...(readString(metadata.permissionMode) !== undefined ? { permissionMode: readString(metadata.permissionMode) } : {}),
        ...(readStringArray(metadata.codexArgs) ? { codexArgs: readStringArray(metadata.codexArgs) } : {}),
        ...(readStringArray(metadata.claudeArgs) ? { claudeArgs: readStringArray(metadata.claudeArgs) } : {}),
        ...(readString(metadata.fallbackModel) !== undefined ? { fallbackModel: readString(metadata.fallbackModel) } : {}),
        ...(readString(metadata.customSystemPrompt) !== undefined ? { customSystemPrompt: readString(metadata.customSystemPrompt) } : {}),
        ...(readString(metadata.appendSystemPrompt) !== undefined ? { appendSystemPrompt: readString(metadata.appendSystemPrompt) } : {}),
    });
}

function assertCurrentNativeAgentSurfaceGeneration(params: Readonly<{
    agentId: string;
    isCurrent: () => boolean;
}>): void {
    if (!params.isCurrent()) {
        throw new Error(`Native Agent surface operation for '${params.agentId}' belongs to a retired runtime generation`);
    }
}

async function resolveNativeAgentSurfaceInvocationContext(params: Readonly<{
    agentId: string;
    isCurrent: () => boolean;
    createInvocationContext?: AgentRuntimeSurfaceInvocationContextResolver;
    cwd: string;
    happierSessionId?: string;
}>): Promise<PluginInvocationContext> {
    assertCurrentNativeAgentSurfaceGeneration(params);
    if (!params.createInvocationContext) {
        throw new Error(`Native Agent surface operation for '${params.agentId}' requires host invocation services`);
    }
    const context = await params.createInvocationContext({
        cwd: params.cwd,
        ...(params.happierSessionId ? { happierSessionId: params.happierSessionId } : {}),
    });
    assertCurrentNativeAgentSurfaceGeneration(params);
    return context;
}

function assertCurrentNativeAgentSurfaceInvocation(
    params: Readonly<{
        agentId: string;
        isCurrent: () => boolean;
    }>,
    context: PluginInvocationContext,
): void {
    assertCurrentNativeAgentSurfaceGeneration(params);
    if (context.signal.aborted) {
        throw context.signal.reason instanceof Error
            ? context.signal.reason
            : new Error(`Native Agent surface operation for '${params.agentId}' was cancelled`);
    }
}

function projectHostAcpSessionResultForAgentRuntime(
    result: HostAcpSessionResult,
): AgentRuntimeAcpSessionResult {
    if (result.ok) {
        return {
            ok: true,
            value: {
                providerSessionId: result.value.providerSessionId,
            },
        };
    }
    return {
        ok: false,
        code: result.code,
        ...(result.message !== undefined ? { message: result.message } : {}),
        ...(result.retryable !== undefined ? { retryable: result.retryable } : {}),
    };
}

function projectHostAcpForkSessionResultForAgentRuntime(
    result: HostAcpForkSessionResult,
): AgentRuntimeAcpForkSessionResult {
    if (result.ok) {
        return {
            ok: true,
            value: {
                providerSessionId: result.value.providerSessionId,
            },
        };
    }
    return {
        ok: false,
        code: result.code,
        ...(result.message !== undefined ? { message: result.message } : {}),
        ...(result.retryable !== undefined ? { retryable: result.retryable } : {}),
    };
}

function projectHostAcpSessionOperationsForAgentRuntime(params: Readonly<{
    operations: HostAcpSessionOperations;
    agentId: string;
    isCurrent: () => boolean;
    context: PluginInvocationContext;
}>): AgentRuntimeAcpSessionOperations {
    const invokeLoadSession = async (
        request: Parameters<HostAcpSessionOperations['loadSession']>[0],
    ): Promise<AgentRuntimeAcpSessionResult> => {
        assertCurrentNativeAgentSurfaceInvocation(params, params.context);
        const result = await params.operations.loadSession({
            ...request,
            signal: params.context.signal,
        });
        assertCurrentNativeAgentSurfaceInvocation(params, params.context);
        return projectHostAcpSessionResultForAgentRuntime(result);
    };
    const invokeForkSession = async (
        request: Parameters<HostAcpSessionOperations['forkSession']>[0],
    ): Promise<AgentRuntimeAcpForkSessionResult> => {
        assertCurrentNativeAgentSurfaceInvocation(params, params.context);
        const result = await params.operations.forkSession({
            ...request,
            signal: params.context.signal,
        });
        assertCurrentNativeAgentSurfaceInvocation(params, params.context);
        return projectHostAcpForkSessionResultForAgentRuntime(result);
    };
    return Object.freeze({
        loadSession: async (request) => await invokeLoadSession({
            backendId: request.backendId,
            ...(request.directory !== undefined ? { directory: request.directory } : {}),
            providerSessionId: request.providerSessionId,
        }),
        forkSession: async (request) => await invokeForkSession({
            backendId: request.backendId,
            ...(request.directory !== undefined ? { directory: request.directory } : {}),
            sourceProviderSessionId: request.sourceProviderSessionId,
        }),
    });
}

function projectHostForkAvailabilityRequestForAgentRuntime(
    request: HostForkAvailabilityRequestV1,
): AgentRuntimeForkAvailabilityRequest {
    return {
        operation: request.operation,
        parentSessionId: request.parentSessionId,
        parentMetadata: request.parentMetadata,
        directory: request.directory,
        forkPoint: request.forkPoint,
    };
}

function projectHostForkRequestForAgentRuntime(params: Readonly<{
    request: HostForkRequestV1;
    agentId: string;
    isCurrent: () => boolean;
    context: PluginInvocationContext;
}>): AgentRuntimeForkRequest {
    const { request } = params;
    return {
        parentSessionId: request.parentSessionId,
        parentMetadata: request.parentMetadata,
        directory: request.directory,
        forkPoint: request.forkPoint,
        ...(request.acp
            ? {
                acp: projectHostAcpSessionOperationsForAgentRuntime({
                    operations: request.acp,
                    agentId: params.agentId,
                    isCurrent: params.isCurrent,
                    context: params.context,
                }),
            }
            : {}),
    };
}

function projectHostReplayForkChildLaunchRequestForAgentRuntime(
    request: HostReplayForkChildLaunchRequestV1,
): AgentRuntimeReplayForkChildLaunchRequest {
    return {
        parentSessionId: request.parentSessionId,
        parentMetadata: request.parentMetadata,
        directory: request.directory,
        forkPoint: request.forkPoint,
    };
}

function bindNativeAgentForkSurface(params: Readonly<{
    runtime: AgentRuntime;
    agentId: string;
    isCurrent: () => boolean;
    createInvocationContext?: AgentRuntimeSurfaceInvocationContextResolver;
}>): BackendExecutionSurfaces['fork'] {
    const fork = params.runtime.surfaces?.fork;
    if (!fork || (!fork.evaluateAvailability && !fork.fork && !fork.resolveReplayChildLaunch)) {
        return null;
    }
    return Object.freeze({
        ...(fork.evaluateAvailability
            ? {
                evaluateAvailability: async (
                    request: HostForkAvailabilityRequestV1,
                ) => {
                    const context = await resolveNativeAgentSurfaceInvocationContext({
                        ...params,
                        cwd: request.directory,
                        happierSessionId: request.parentSessionId,
                    });
                    const result = await fork.evaluateAvailability!(
                        projectHostForkAvailabilityRequestForAgentRuntime(request),
                        context,
                    );
                    assertCurrentNativeAgentSurfaceGeneration(params);
                    return result;
                },
            }
            : {}),
        ...(fork.fork
            ? {
                fork: async (
                    request: HostForkRequestV1,
                ) => {
                    const context = await resolveNativeAgentSurfaceInvocationContext({
                        ...params,
                        cwd: request.directory,
                        happierSessionId: request.parentSessionId,
                    });
                    const result = await fork.fork!(
                        projectHostForkRequestForAgentRuntime({
                            request,
                            agentId: params.agentId,
                            isCurrent: params.isCurrent,
                            context,
                        }),
                        context,
                    );
                    assertCurrentNativeAgentSurfaceGeneration(params);
                    return result;
                },
            }
            : {}),
        ...(fork.resolveReplayChildLaunch
            ? {
                resolveReplayChildLaunch: async (
                    request: HostReplayForkChildLaunchRequestV1,
                ) => {
                    const context = await resolveNativeAgentSurfaceInvocationContext({
                        ...params,
                        cwd: request.directory,
                        happierSessionId: request.parentSessionId,
                    });
                    const result = await fork.resolveReplayChildLaunch!(
                        projectHostReplayForkChildLaunchRequestForAgentRuntime(request),
                        context,
                    );
                    assertCurrentNativeAgentSurfaceGeneration(params);
                    return result;
                },
            }
            : {}),
    });
}

function bindNativeAgentHandoffSurface(params: Readonly<{
    runtime: AgentRuntime;
    agentId: string;
    isCurrent: () => boolean;
    createInvocationContext?: AgentRuntimeSurfaceInvocationContextResolver;
}>): BackendExecutionSurfaces['handoff'] {
    const handoff = params.runtime.surfaces?.handoff;
    if (!handoff) return null;
    return Object.freeze({
        ...(handoff.evaluateAvailability
            ? {
                evaluateAvailability: async (
                    request: Parameters<NonNullable<AgentRuntimeHandoffSurface['evaluateAvailability']>>[0],
                ) => {
                    const context = await resolveNativeAgentSurfaceInvocationContext({
                        ...params,
                        cwd: process.cwd(),
                    });
                    const result = await handoff.evaluateAvailability!(request, context);
                    assertCurrentNativeAgentSurfaceGeneration(params);
                    return result;
                },
            }
            : {}),
        exportBundle: async (request) => {
            const context = await resolveNativeAgentSurfaceInvocationContext({
                ...params,
                cwd: request.directory,
            });
            const result = await handoff.exportBundle(request, context);
            assertCurrentNativeAgentSurfaceGeneration(params);
            return result;
        },
        importBundle: async (request) => {
            const context = await resolveNativeAgentSurfaceInvocationContext({
                ...params,
                cwd: request.targetDirectory,
            });
            const result = await handoff.importBundle(request, context);
            assertCurrentNativeAgentSurfaceGeneration(params);
            return result;
        },
    });
}

function mapTerminalProcessTerminationToExitCode(termination: HostTerminalProcessTermination): number {
    if (termination.type === 'exited') return termination.code;
    if (termination.type === 'missing') return 127;
    return 1;
}

async function publishNativeAgentTerminalControlPresentation(params: Readonly<{
    host: HostTerminalOrchestration;
    presentation: AgentTerminalControlPresentation | undefined;
}>): Promise<void> {
    if (!params.presentation) return;
    await Promise.resolve(params.host.projection.publishControlState(params.presentation)).catch(() => undefined);
}

export function resolveBackendExecutionSurfacesFromNativeAgentRuntime(params: Readonly<{
    backend: ResolvedAgentRuntimeContribution;
    runtime: AgentRuntime;
    agentId: string;
    isCurrent: () => boolean;
    declaredAgentSurfaceFamilies: ReadonlySet<'terminalRuntime'>;
    diagnostics: EngineResolutionDiagnostic[];
    resolveTerminalRuntimeLaunchServices?: TerminalRuntimeLaunchServicesResolver;
    resolveTerminalRuntimeLaunchSignal?: TerminalRuntimeLaunchSignalResolver;
    resolveTerminalRuntimeHostOrchestration?: TerminalRuntimeHostOrchestrationResolver;
    createAgentRuntimeSurfaceInvocationContext?: AgentRuntimeSurfaceInvocationContextResolver;
}>): BackendExecutionSurfaces {
    const runtimeSurfaces = params.runtime.surfaces;
    const attach = runtimeSurfaces?.attach ?? null;
    const checkpoint = runtimeSurfaces?.checkpoint ?? null;
    const surfaceBindingParams = {
        runtime: params.runtime,
        agentId: params.agentId,
        isCurrent: params.isCurrent,
        createInvocationContext: params.createAgentRuntimeSurfaceInvocationContext,
    };
    const fork = bindNativeAgentForkSurface(surfaceBindingParams);
    const handoff = bindNativeAgentHandoffSurface(surfaceBindingParams);
    const terminal = runtimeSurfaces?.terminal;
    if (!terminal) return {
        terminalRuntime: null,
        externalSession: null,
        attach,
        handoff,
        fork,
        checkpoint,
    };
    if (!params.declaredAgentSurfaceFamilies.has('terminalRuntime')) {
        params.diagnostics.push({
            code: 'engine_plugin_backend_surface_static_mismatch',
            message: `Backend '${params.backend.id}' returned native Agent terminal launch behavior that is not declared by the Agent contribution`,
            backendId: params.backend.id,
            agentId: params.agentId,
            pluginId: params.backend.pluginId,
        });
        return {
            terminalRuntime: null,
            externalSession: null,
            attach,
            handoff,
            fork,
            checkpoint,
        };
    }

    const activeLaunchesBySessionId = new Map<string, Promise<HostTerminalRunResult>>();
    const runLaunch = async (
        normalizedRequest: HostTerminalLaunchRequest,
    ): Promise<HostTerminalRunResult> => {
        assertCurrentNativeAgentTerminalGeneration(params);
        const request = await resolveTerminalRuntimeLaunchRequestContext({
            request: normalizedRequest,
            resolveServices: params.resolveTerminalRuntimeLaunchServices,
            resolveSignal: params.resolveTerminalRuntimeLaunchSignal,
            resolveHostOrchestration: params.resolveTerminalRuntimeHostOrchestration,
        });
        const host = request.host;
        if (!host?.process.resolveAgentCliExecutable) {
            throw new Error(`Native Agent terminal launch for '${params.agentId}' requires host Agent CLI executable resolution`);
        }
        const plan = await terminal.resolveLaunch({
            sessionId: request.sessionId,
            cwd: request.directory,
            metadata: projectTerminalAgentLaunchMetadata(request.metadata),
            modelSelection: request.modelSelection,
        });
        assertNativeAgentTerminalLaunchPlan(plan);
        assertCurrentNativeAgentTerminalGeneration(params);

        const planValues = plan.environment?.values ?? {};
        const environment = {
            ...(request.env ?? {}),
            ...(request.isolation?.env ?? {}),
            ...planValues,
        };
        const unsetEnvKeys = [...new Set([
            ...(request.isolation?.unsetEnvKeys ?? []),
            ...(plan.environment?.unset ?? []),
        ])];
        const executable = await host.process.resolveAgentCliExecutable({
            agentId: params.agentId,
            cwd: request.directory,
            ...(Object.keys(environment).length > 0 ? { env: environment } : {}),
            signal: request.signal,
        });
        assertCurrentNativeAgentTerminalGeneration(params);

        await publishNativeAgentTerminalControlPresentation({
            host,
            presentation: plan.presentation?.onLaunch,
        });
        try {
            // Keep every awaited preparation step above this permit. Its
            // exact-current check linearizes the launch, and the first local
            // effect must be the process-owner invocation with no intervening
            // await or competing currentness decision.
            const permittedLaunch =
                await request.runWithCurrentPublisherPermit(
                    () => host.process.launch({
                        executable: executable.executable,
                        args: [...executable.args, ...plan.argv],
                        cwd: request.directory,
                        ...(Object.keys(environment).length > 0 ? { env: environment } : {}),
                        ...(unsetEnvKeys.length > 0 ? { unsetEnvKeys } : {}),
                        stdio: plan.process?.stdio,
                        windowsHide: plan.process?.windowsHide,
                        windowsVerbatimArguments: plan.process?.windowsVerbatimArguments,
                        signal: request.signal,
                    }),
                );
            if (permittedLaunch.status === 'blocked') {
                throw new HostTerminalModelSelectionBlockedError();
            }
            const processHandle = permittedLaunch.value;
            if (!params.isCurrent()) {
                await processHandle.stop().catch(() => undefined);
                assertCurrentNativeAgentTerminalGeneration(params);
            }
            let requestedControlReason: HostTerminalControlReturnReason | null = null;
            let confirmedControlReason: HostTerminalControlReturnReason | null = null;
            let stopForControlPromise: Promise<void> | null = null;
            const requestControlReturn = async (
                reason: HostTerminalControlReturnReason,
            ): Promise<void> => {
                requestedControlReason ??= reason;
                stopForControlPromise ??= processHandle.stop();
                await stopForControlPromise;
                confirmedControlReason = requestedControlReason;
            };
            const inputSubscription = host.input.subscribe(
                async () => await requestControlReturn('pending_input'),
            );
            let switchSubscription: ReturnType<typeof host.switching.register> | null = null;
            try {
                switchSubscription = host.switching.register(async (request) => {
                    if (request.target !== 'remote') return false;
                    try {
                        await requestControlReturn('switch_requested');
                        return true;
                    } catch {
                        return false;
                    }
                });
                const termination = await processHandle.waitForTermination();
                const pendingControlStop = stopForControlPromise;
                if (pendingControlStop) {
                    await pendingControlStop;
                    confirmedControlReason ??= requestedControlReason;
                }
                assertCurrentNativeAgentTerminalGeneration(params);
                if (confirmedControlReason) {
                    return {
                        type: 'control_returned',
                        reason: confirmedControlReason,
                        ...(plan.resultMetadata?.sessionStateUpdates
                            ? { sessionStateUpdates: plan.resultMetadata.sessionStateUpdates }
                            : {}),
                    };
                }
                return {
                    type: 'process_exited',
                    exitCode: mapTerminalProcessTerminationToExitCode(termination),
                    ...(plan.resultMetadata?.sessionStateUpdates
                        ? { sessionStateUpdates: plan.resultMetadata.sessionStateUpdates }
                        : {}),
                };
            } finally {
                switchSubscription?.unsubscribe();
                inputSubscription?.unsubscribe();
            }
        } finally {
            // `ES-PEP-EU2` removes the redundant readiness path now that one
            // terminal-follow barrier exists. The barrier that admits the
            // binding before launch is the same owner that releases it exactly
            // once, and it races the ready binding against this launch; a second
            // release here would dispose a binding that owner still holds.
            await publishNativeAgentTerminalControlPresentation({
                host,
                presentation: plan.presentation?.onExit,
            });
        }
    };
    const launch = (async (rawRequest: unknown): Promise<HostTerminalRunResult> => {
        const request = normalizeTerminalRuntimeLaunchRequest(rawRequest);
        const sessionId = readTerminalRuntimeLaunchSessionId(request);
        if (!sessionId) return runLaunch(request);
        assertCurrentNativeAgentTerminalGeneration(params);
        const activeLaunch = activeLaunchesBySessionId.get(sessionId);
        if (activeLaunch) return activeLaunch;

        let launchPromise: Promise<HostTerminalRunResult>;
        launchPromise = runLaunch(request).finally(() => {
            if (activeLaunchesBySessionId.get(sessionId) === launchPromise) {
                activeLaunchesBySessionId.delete(sessionId);
            }
        });
        activeLaunchesBySessionId.set(sessionId, launchPromise);
        return launchPromise;
    }) satisfies TerminalRuntimeLaunch;

    return {
        terminalRuntime: Object.freeze({ launch }),
        externalSession: null,
        attach,
        handoff,
        fork,
        checkpoint,
    };
}
