import type { HostSessionRuntimeFactoryParams } from '@/agent/runtime/session/loop/runHostSessionRuntime';
import type { RuntimeTurnOperations } from '@/agent/runtime/turns/runtimeTurnOperations';
import {
    readExecutionRunSessionStateTarget,
    type ExecutionRunSessionStateTarget,
} from '@/agent/runtime/bridges/executionRun/sessionStateDelivery';
import { wrapExecutionRunHostRuntime } from '@/agent/runtime/bridges/executionRun/hostRuntime/wrap';
import type {
    CliExecutionRunRuntime,
    CliRuntimeCore,
    CreateCliExecutionRunBackendParams,
} from '../engineRegistryTypes';
import type {
    ExecutionRunContextScope,
    HostSessionContextScope,
    PluginContextV1Binder,
} from './pluginContext/binder';
import {
    isRecord,
    readTrimmedString,
} from './pluginContext/values';

function readExecutionRunScopeRootPath(opts: unknown): string | null {
    if (!isRecord(opts)) return null;
    return readTrimmedString(opts.cwd) ?? readTrimmedString(opts.directory);
}

function bindExecutionRunHostRuntimeToScope(
    runtime: CliExecutionRunRuntime,
    scope: ExecutionRunContextScope,
    runWithScope: PluginContextV1Binder['runWithScope'],
): CliExecutionRunRuntime {
    return wrapExecutionRunHostRuntime({
        passthrough: runtime as unknown as Readonly<Record<string, unknown>>,
        readPermissionCapability: () => runtime.permissionCapability,
        readResumeSupport: (opts) => runWithScope(scope, () => runtime.readResumeSupport(opts)),
        provisionSession: (opts) => runWithScope(scope, () => runtime.provisionSession(opts)),
        sendPrompt: (sessionId, prompt, meta) => runWithScope(scope, () => runtime.sendPrompt(sessionId, prompt, meta)),
        readSendSteerPrompt: () => runtime.sendSteerPrompt
            ? (sessionId, prompt, meta) => runWithScope(scope, () => runtime.sendSteerPrompt!(sessionId, prompt, meta))
            : undefined,
        cancel: (sessionId) => runWithScope(scope, () => runtime.cancel(sessionId)),
        subscribeMessages: (handler) => runWithScope(scope, () => runtime.subscribeMessages(handler)),
        readRespondToPermission: () => runtime.permissionCapability === 'responds' && runtime.respondToPermission
            ? (requestId, approved) => runWithScope(scope, () => runtime.respondToPermission!(requestId, approved))
            : undefined,
        readWaitForTurnCompletion: () => runtime.waitForTurnCompletion
            ? (timeoutMs) => runWithScope(scope, () => runtime.waitForTurnCompletion!(timeoutMs))
            : undefined,
        readProbeTurnLiveness: () => runtime.probeTurnLiveness
            ? (sessionId) => runWithScope(scope, () => runtime.probeTurnLiveness!(sessionId))
            : undefined,
        dispose: () => runWithScope(scope, () => runtime.dispose()),
    });
}

function bindHostSessionRuntimeResultToTranscriptGrantScope(params: Readonly<{
    createdRuntime: unknown;
    binder: PluginContextV1Binder;
    scope: HostSessionContextScope;
    sessionId: string | null;
}>): unknown {
    if (!isRecord(params.createdRuntime)) {
        return params.createdRuntime;
    }
    const operations = bindHostSessionRuntimeOperationsToScope({
        runtime: params.createdRuntime.operations,
        binder: params.binder,
        scope: params.scope,
        revokeTranscriptSessionIdOnDispose: params.sessionId,
    });
    const nativeRuntime = bindHostSessionRuntimeOperationsToScope({
        runtime: params.createdRuntime.nativeRuntime,
        binder: params.binder,
        scope: params.scope,
        revokeTranscriptSessionIdOnDispose: operations === params.createdRuntime.operations
            ? params.sessionId
            : null,
    });
    return Object.freeze({
        ...params.createdRuntime,
        ...(operations === params.createdRuntime.operations ? {} : { operations }),
        ...(nativeRuntime === params.createdRuntime.nativeRuntime ? {} : { nativeRuntime }),
    });
}

function bindHostSessionRuntimeOperationsToScope(params: Readonly<{
    runtime: unknown;
    binder: PluginContextV1Binder;
    scope: HostSessionContextScope;
    revokeTranscriptSessionIdOnDispose?: string | null;
}>): unknown {
    if (!isRecord(params.runtime)) return params.runtime;
    const runtime = params.runtime as Partial<RuntimeTurnOperations>;
    const compactContext = runtime.compactContext;
    const respondToPermission = runtime.respondToPermission;
    const resetOrDisposeRuntime = runtime.resetOrDisposeRuntime;

    return Object.freeze({
        ...params.runtime,
        get permissionCapability() {
            return runtime.permissionCapability;
        },
        beginTurnLifecycle: () => params.binder.runWithScope(params.scope, () => runtime.beginTurnLifecycle?.()),
        startOrLoadSession: (opts?: Parameters<RuntimeTurnOperations['startOrLoadSession']>[0]) =>
            params.binder.runWithScope(params.scope, () => runtime.startOrLoadSession?.(opts)),
        sendTurnPrompt: (
            prompt: string,
            meta?: Parameters<RuntimeTurnOperations['sendTurnPrompt']>[1],
        ) => params.binder.runWithScope(params.scope, () => runtime.sendTurnPrompt?.(prompt, meta)),
        ...(compactContext
            ? {
                compactContext: (command: string) =>
                    params.binder.runWithScope(params.scope, () => compactContext(command)),
            }
            : {}),
        steerInFlightTurn: (
            message: string,
            meta?: Parameters<RuntimeTurnOperations['steerInFlightTurn']>[1],
        ) => params.binder.runWithScope(params.scope, () => runtime.steerInFlightTurn?.(message, meta)),
        waitForTurnCompletion: (opts?: Parameters<RuntimeTurnOperations['waitForTurnCompletion']>[0]) =>
            params.binder.runWithScope(params.scope, () => runtime.waitForTurnCompletion?.(opts)),
        subscribeRuntimeEvents: (handler: Parameters<RuntimeTurnOperations['subscribeRuntimeEvents']>[0]) =>
            params.binder.runWithScope(params.scope, () => runtime.subscribeRuntimeEvents?.(handler) ?? (() => undefined)),
        ...(respondToPermission
            ? {
                respondToPermission: (requestId: string, approved: boolean) =>
                    params.binder.runWithScope(params.scope, () => respondToPermission(requestId, approved)),
            }
            : {}),
        cancelTurn: () => params.binder.runWithScope(params.scope, () => runtime.cancelTurn?.()),
        readSessionIdentity: () =>
            params.binder.runWithScope(params.scope, () => runtime.readSessionIdentity?.() ?? { sessionId: null }),
        updateSessionRuntimeConfig: (update: Parameters<RuntimeTurnOperations['updateSessionRuntimeConfig']>[0]) =>
            params.binder.runWithScope(params.scope, () => runtime.updateSessionRuntimeConfig?.(update)),
        resetOrDisposeRuntime: async () => params.binder.runWithScope(params.scope, async () => {
            try {
                await resetOrDisposeRuntime?.();
            } finally {
                if (params.revokeTranscriptSessionIdOnDispose) {
                    await params.binder.revokeTranscriptFileFollowScope({
                        sessionId: params.revokeTranscriptSessionIdOnDispose,
                    });
                }
            }
        }),
    });
}

export function bindPluginContextToRuntimeCore(
    rawRuntimeCore: CliRuntimeCore,
    binder: PluginContextV1Binder | null,
): CliRuntimeCore {
    return Object.freeze({
        async createSessionRuntime(sessionParams: unknown) {
            const plan = await rawRuntimeCore.createSessionRuntime(sessionParams);
            if (!binder) return plan as any;
            if (!plan || typeof plan !== 'object') return plan as any;
            const planRecord = plan as any;
            const config = planRecord.config;
            const createSessionRuntime = config?.createSessionRuntime;
            if (typeof createSessionRuntime !== 'function') return plan as any;
            const wrappedConfig = Object.freeze({
                ...config,
                createSessionRuntime: async (runtimeParams: HostSessionRuntimeFactoryParams) => {
                    const scope = binder.bindHostSessionRuntime(runtimeParams);
                    const createdRuntime = await createSessionRuntime(runtimeParams);
                    return bindHostSessionRuntimeResultToTranscriptGrantScope({
                        createdRuntime,
                        binder,
                        scope,
                        sessionId: readTrimmedString(runtimeParams.session.sessionId),
                    });
                },
            });
            return Object.freeze({
                ...planRecord,
                config: wrappedConfig,
            });
        },
        createExecutionRunBackend(opts: CreateCliExecutionRunBackendParams & Readonly<{
            parentSessionStateTarget?: ExecutionRunSessionStateTarget | null;
        }>) {
            const parentSessionStateTarget = readExecutionRunSessionStateTarget(opts);
            const executionRunScope = binder?.bindExecutionRun({
                runId: readTrimmedString(opts?.runId),
                permissionMode: opts?.permissionMode,
                rootPath: readExecutionRunScopeRootPath(opts),
                parentSessionStateTarget,
            }) ?? null;
            const { parentSessionStateTarget: _parentSessionStateTarget, ...runtimeOpts } = opts;
            void _parentSessionStateTarget;
            const runtime = rawRuntimeCore.createExecutionRunBackend(runtimeOpts);
            if (!executionRunScope || !binder) return runtime;
            return bindExecutionRunHostRuntimeToScope(runtime, executionRunScope, binder.runWithScope);
        },
    });
}
