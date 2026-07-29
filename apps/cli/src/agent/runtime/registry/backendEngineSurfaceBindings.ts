import type { SessionScopedServicesV1 } from '@happier-dev/agents';
import type {
    HostTerminalOrchestration,
    HostTerminalControlReturnReason,
    HostTerminalLaunchRequest,
    HostTerminalProcessTermination,
    HostTerminalRunResult,
} from '@/agent/runtime/session/terminal/contract';
import type {
    AgentRuntime,
    AgentTerminalControlPresentation,
    AgentTerminalLaunchPlan,
} from '@happier-dev/plugin-sdk/agent-runtime';

import type { ResolvedAgentRuntimeContribution } from '../../../plugins/projection/registry/types';
import { projectAgentVisibleSessionMetadata } from '../sessionMetadataVisibility';

import type {
    BackendExecutionSurfaces,
    EngineResolutionDiagnostic,
} from './engineRegistryTypes';
type TerminalRuntimeLaunch = NonNullable<NonNullable<BackendExecutionSurfaces['terminalRuntime']>['launch']>;
type TerminalRuntimeLaunchServicesResolver = (
    request: HostTerminalLaunchRequest,
) => SessionScopedServicesV1 | null | Promise<SessionScopedServicesV1 | null>;
type TerminalRuntimeLaunchSignalResolver = (
    request: HostTerminalLaunchRequest,
) => AbortSignal | undefined;
type TerminalRuntimeHostOrchestrationResolver = (
    request: HostTerminalLaunchRequest,
) => HostTerminalOrchestration | null | Promise<HostTerminalOrchestration | null>;

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
        if (
            value.resultMetadata.sessionStateUpdates !== undefined
            && !Array.isArray(value.resultMetadata.sessionStateUpdates)
        ) {
            throw new Error("Native Agent terminal launch plan 'resultMetadata.sessionStateUpdates' must be an array");
        }
    }
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
}>): BackendExecutionSurfaces {
    const terminal = params.runtime.surfaces?.terminal;
    if (!terminal) return {
        terminalRuntime: null,
        externalSession: null,
        attach: null,
        handoff: null,
        fork: null,
        checkpoint: null,
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
            attach: null,
            handoff: null,
            fork: null,
            checkpoint: null,
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
            metadata: projectAgentVisibleSessionMetadata(request.metadata),
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
            const processHandle = await host.process.launch({
                executable: executable.executable,
                args: [...executable.args, ...plan.argv],
                cwd: request.directory,
                ...(Object.keys(environment).length > 0 ? { env: environment } : {}),
                ...(unsetEnvKeys.length > 0 ? { unsetEnvKeys } : {}),
                stdio: plan.process?.stdio,
                windowsHide: plan.process?.windowsHide,
                windowsVerbatimArguments: plan.process?.windowsVerbatimArguments,
                signal: request.signal,
            });
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
            await host.transcriptFollow?.releaseActiveBindings().catch(() => undefined);
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
        attach: null,
        handoff: null,
        fork: null,
        checkpoint: null,
    };
}

function assertNoDuplicateSurfaceOperations<TSurface extends object>(
    surfaceName: keyof BackendExecutionSurfaces,
    handlerSurface: TSurface | null,
    engineSurface: TSurface | null,
): void {
    if (!handlerSurface || !engineSurface) {
        return;
    }
    for (const operation of Object.keys(handlerSurface) as Array<keyof TSurface & string>) {
        if (
            typeof handlerSurface[operation] === 'function'
            && typeof engineSurface[operation] === 'function'
        ) {
            throw new Error(`Duplicate backend surface operation '${String(surfaceName)}.${operation}' from handler and engine surfaces`);
        }
    }
}

function mergeSurface<TSurface extends object>(
    surfaceName: keyof BackendExecutionSurfaces,
    handlerSurface: TSurface | null,
    engineSurface: TSurface | null,
): TSurface | null {
    assertNoDuplicateSurfaceOperations(surfaceName, handlerSurface, engineSurface);
    if (!handlerSurface) {
        return engineSurface;
    }
    if (!engineSurface) {
        return handlerSurface;
    }
    return {
        ...handlerSurface,
        ...engineSurface,
    } as TSurface;
}

export function mergeBackendExecutionSurfaces(
    handlerSurfaces: BackendExecutionSurfaces,
    engineSurfaces: BackendExecutionSurfaces,
): BackendExecutionSurfaces {
    return {
        terminalRuntime: mergeSurface('terminalRuntime', handlerSurfaces.terminalRuntime, engineSurfaces.terminalRuntime),
        externalSession: null,
        attach: mergeSurface('attach', handlerSurfaces.attach, engineSurfaces.attach),
        handoff: mergeSurface('handoff', handlerSurfaces.handoff, engineSurfaces.handoff),
        fork: mergeSurface('fork', handlerSurfaces.fork, engineSurfaces.fork),
        checkpoint: mergeSurface('checkpoint', handlerSurfaces.checkpoint, engineSurfaces.checkpoint),
    };
}
