import { redactBugReportSensitiveText } from '@happier-dev/protocol';
import type {
    AcpAuthoringServiceV1,
    AcpBackendSpecV1,
    AcpComposedRuntimeV1,
    AcpRuntimeExtensionHandlerContextV1,
    AcpRuntimeExtensionsV1,
    AcpRuntimeHandleV1,
    CreateAcpRuntimeParamsV1,
    ExecClientHandleV1,
    ExecClientSpecV1,
    ExecJsonRpcClientSpecV1,
    ExecRuntimeServiceV1,
    JsonRpcClientV1,
    JsonRpcNotificationHandlerV1,
    JsonRpcRequestHandlerV1,
    PluginContextV1,
} from '@happier-dev/plugin-sdk';

import { buildClientSpecFromAcpSpec } from './clientSpec';
import { createAcpSessionRuntime, type AcpSessionRuntimeController } from './session';

type PluginAcpRuntimeDisposable = Readonly<{
    dispose: () => void | Promise<void>;
}>;

export type PluginAcpRuntimeErrorCode =
    | 'PLUGIN_ACP_RUNTIME_DISPOSED'
    | 'PLUGIN_ACP_TURN_CANCELLED'
    | 'PLUGIN_ACP_RUNTIME_UNSUPPORTED_TRANSPORT'
    | 'PLUGIN_ACP_EXTENSION_METHOD_NOT_NAMESPACED'
    | 'PLUGIN_ACP_EXTENSION_METHOD_CONFLICT'
    | 'PLUGIN_ACP_EXTENSION_INVALID_RESULT'
    | 'PLUGIN_ACP_EXTENSION_HANDLER_FAILED'
    | 'PLUGIN_ACP_SESSION_NOT_STARTED'
    | 'PLUGIN_ACP_SESSION_INVALID_RESULT';

export class PluginAcpRuntimeError extends Error {
    readonly code: PluginAcpRuntimeErrorCode;

    constructor(code: PluginAcpRuntimeErrorCode, message: string, options?: ErrorOptions) {
        super(message, options);
        this.name = 'PluginAcpRuntimeError';
        this.code = code;
    }
}

export type CreatePluginAcpRuntimeServiceParams = Readonly<{
    exec: ExecRuntimeServiceV1;
    signal?: AbortSignal;
    addDisposable?: (disposable: PluginAcpRuntimeDisposable) => unknown;
    readPluginContext?: () => PluginContextV1;
}>;

type ExtensionHandlers = Readonly<{
    requests: Readonly<Record<string, JsonRpcRequestHandlerV1>>;
    notifications: Readonly<Record<string, JsonRpcNotificationHandlerV1>>;
}>;

type AbortControllerBinding = Readonly<{
    controller: AbortController;
    dispose: () => void;
}>;

type ExtensionRequestAbortBinding = AbortControllerBinding & Readonly<{
    createAbortError: () => PluginAcpRuntimeError;
}>;

const MAX_EXTENSION_ERROR_DIAGNOSTIC_CHARS = 500;

function isObjectResult(value: unknown): value is Readonly<Record<string, unknown>> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sanitizeDiagnostic(value: unknown): string {
    const text = value instanceof Error ? value.message : String(value);
    const redacted = redactBugReportSensitiveText(text);
    return redacted.length > MAX_EXTENSION_ERROR_DIAGNOSTIC_CHARS
        ? `${redacted.slice(0, MAX_EXTENSION_ERROR_DIAGNOSTIC_CHARS)}...`
        : redacted;
}

function createDisposedError(): PluginAcpRuntimeError {
    return new PluginAcpRuntimeError(
        'PLUGIN_ACP_RUNTIME_DISPOSED',
        'ACP runtime extension dispatch was disposed',
    );
}

function createTurnCancelledError(): PluginAcpRuntimeError {
    return new PluginAcpRuntimeError(
        'PLUGIN_ACP_TURN_CANCELLED',
        'ACP runtime extension dispatch was cancelled for the active turn',
    );
}

function createInvalidSessionResultError(message: string): PluginAcpRuntimeError {
    return new PluginAcpRuntimeError(
        'PLUGIN_ACP_SESSION_INVALID_RESULT',
        message,
    );
}

function createSessionNotStartedError(): PluginAcpRuntimeError {
    return new PluginAcpRuntimeError(
        'PLUGIN_ACP_SESSION_NOT_STARTED',
        'ACP session operation requires a started provider session',
    );
}

function createUnsupportedTransportError(transportKind: string): PluginAcpRuntimeError {
    return new PluginAcpRuntimeError(
        'PLUGIN_ACP_RUNTIME_UNSUPPORTED_TRANSPORT',
        `ctx.acp.createRuntime currently supports stdio ACP transports, received '${transportKind}'`,
    );
}

function assertExtensionMethodName(method: string): void {
    if (method.trim() !== method || !method.includes('/')) {
        throw new PluginAcpRuntimeError(
            'PLUGIN_ACP_EXTENSION_METHOD_NOT_NAMESPACED',
            `ACP extension method '${method}' must be provider-namespaced`,
        );
    }
    const segments = method.split('/');
    if (segments.some((segment) => segment.trim().length === 0)) {
        throw new PluginAcpRuntimeError(
            'PLUGIN_ACP_EXTENSION_METHOD_NOT_NAMESPACED',
            `ACP extension method '${method}' must not contain empty namespace segments`,
        );
    }
}

function createAbortController(signals: readonly (AbortSignal | undefined)[]): Readonly<{
    controller: AbortController;
    dispose: () => void;
}> {
    const controller = new AbortController();
    const activeSignals = signals.filter((signal): signal is AbortSignal => signal !== undefined);
    const abortRuntime = () => {
        if (!controller.signal.aborted) {
            controller.abort();
        }
    };
    for (const signal of activeSignals) {
        if (signal.aborted) {
            abortRuntime();
        } else {
            signal.addEventListener('abort', abortRuntime, { once: true });
        }
    }
    return Object.freeze({
        controller,
        dispose: () => {
            for (const signal of activeSignals) {
                signal.removeEventListener('abort', abortRuntime);
            }
        },
    });
}

function createTurnAbortManager(runtimeSignal: AbortSignal): Readonly<{
    beginTurn(): void;
    cancelTurn(): void;
    settleTurn(): void;
    createRequestSignal(): ExtensionRequestAbortBinding;
}> {
    let activeTurnController: AbortController | null = null;
    let activeTurnAbortError: PluginAcpRuntimeError | null = null;
    const clearActiveTurn = () => {
        activeTurnController = null;
        activeTurnAbortError = null;
    };
    return Object.freeze({
        beginTurn(): void {
            activeTurnController?.abort();
            activeTurnController = new AbortController();
            activeTurnAbortError = null;
        },
        cancelTurn(): void {
            activeTurnAbortError ??= createTurnCancelledError();
            activeTurnController?.abort();
        },
        settleTurn(): void {
            clearActiveTurn();
        },
        createRequestSignal(): ExtensionRequestAbortBinding {
            const signalBinding = createAbortController([
                runtimeSignal,
                activeTurnController?.signal,
            ]);
            return Object.freeze({
                ...signalBinding,
                createAbortError: () => activeTurnAbortError ?? createDisposedError(),
            });
        },
    });
}

function createExtensionContext(params: Readonly<{
    method: string;
    requestId?: string;
    spec: AcpBackendSpecV1;
    runtimeParams: CreateAcpRuntimeParamsV1;
    signal: AbortSignal;
}>): AcpRuntimeExtensionHandlerContextV1 {
    const agentName = params.runtimeParams.agentName
        ?? params.spec.ux?.name
        ?? params.spec.ux?.title;
    return Object.freeze({
        method: params.method,
        ...(params.requestId ? { requestId: params.requestId } : {}),
        sessionId: params.runtimeParams.sessionId,
        backendId: params.spec.backendId,
        ...(agentName ? { agentName } : {}),
        signal: params.signal,
    });
}

function runExtensionRequest<TResult>(
    signal: AbortSignal,
    createAbortError: () => PluginAcpRuntimeError,
    run: () => TResult | Promise<TResult>,
): Promise<TResult> {
    if (signal.aborted) {
        return Promise.reject(createAbortError());
    }
    return new Promise<TResult>((resolve, reject) => {
        let settled = false;
        const settleResolve = (value: TResult) => {
            if (settled) {
                return;
            }
            settled = true;
            signal.removeEventListener('abort', onAbort);
            resolve(value);
        };
        const settleReject = (error: unknown) => {
            if (settled) {
                return;
            }
            settled = true;
            signal.removeEventListener('abort', onAbort);
            reject(error);
        };
        const onAbort = () => {
            settleReject(createAbortError());
        };
        signal.addEventListener('abort', onAbort, { once: true });
        Promise.resolve()
            .then(run)
            .then(settleResolve, settleReject);
    });
}

function createExtensionHandlers(params: Readonly<{
    spec: AcpBackendSpecV1;
    runtimeParams: CreateAcpRuntimeParamsV1;
    createRequestSignal: () => ExtensionRequestAbortBinding;
}>): ExtensionHandlers {
    const requests: Record<string, JsonRpcRequestHandlerV1> = {};
    const notifications: Record<string, JsonRpcNotificationHandlerV1> = {};
    for (const [method, handler] of Object.entries(params.runtimeParams.extensions?.requests ?? {})) {
        assertExtensionMethodName(method);
        requests[method] = async (requestParams, requestContext) => {
            const signalBinding = params.createRequestSignal();
            if (signalBinding.controller.signal.aborted) {
                signalBinding.dispose();
                throw signalBinding.createAbortError();
            }
            try {
                const context = createExtensionContext({
                    ...params,
                    method,
                    ...(requestContext.requestId ? { requestId: requestContext.requestId } : {}),
                    signal: signalBinding.controller.signal,
                });
                const result = await runExtensionRequest(
                    signalBinding.controller.signal,
                    signalBinding.createAbortError,
                    () => handler(requestParams, context),
                );
                if (!isObjectResult(result)) {
                    throw new PluginAcpRuntimeError(
                        'PLUGIN_ACP_EXTENSION_INVALID_RESULT',
                        `ACP extension request '${method}' must return a JSON object result`,
                    );
                }
                return result;
            } catch (error) {
                if (error instanceof PluginAcpRuntimeError) {
                    throw error;
                }
                throw new PluginAcpRuntimeError(
                    'PLUGIN_ACP_EXTENSION_HANDLER_FAILED',
                    `ACP extension request '${method}' failed: ${sanitizeDiagnostic(error)}`,
                    { cause: error },
                );
            } finally {
                signalBinding.dispose();
            }
        };
    }
    for (const [method, handler] of Object.entries(params.runtimeParams.extensions?.notifications ?? {})) {
        assertExtensionMethodName(method);
        notifications[method] = async (notificationParams) => {
            const signalBinding = params.createRequestSignal();
            if (signalBinding.controller.signal.aborted) {
                signalBinding.dispose();
                return;
            }
            try {
                const context = createExtensionContext({
                    ...params,
                    method,
                    signal: signalBinding.controller.signal,
                });
                await handler(notificationParams, context);
            } catch {
                // JSON-RPC notifications have no response channel. Keep the shared runtime alive.
            } finally {
                signalBinding.dispose();
            }
        };
    }
    return Object.freeze({
        requests: Object.freeze(requests),
        notifications: Object.freeze(notifications),
    });
}

function createSharedSessionHandlers(params: Readonly<{
    readSessionRuntime: () => AcpSessionRuntimeController | null;
    queueSessionUpdate: (update: unknown) => void;
}>): ExtensionHandlers {
    return Object.freeze({
        requests: Object.freeze({}),
        notifications: Object.freeze({
            'session/update': async (notificationParams: unknown) => {
                const sessionRuntime = params.readSessionRuntime();
                if (sessionRuntime) {
                    sessionRuntime.handleSessionUpdate(notificationParams);
                    return;
                }
                params.queueSessionUpdate(notificationParams);
            },
        }),
    });
}

function mergeRuntimeHandlerSets(params: Readonly<{
    shared: ExtensionHandlers;
    extensions: ExtensionHandlers;
}>): ExtensionHandlers {
    const requests: Record<string, JsonRpcRequestHandlerV1> = {
        ...params.shared.requests,
    };
    const notifications: Record<string, JsonRpcNotificationHandlerV1> = {
        ...params.shared.notifications,
    };
    for (const [method, handler] of Object.entries(params.extensions.requests)) {
        if (Object.prototype.hasOwnProperty.call(requests, method)) {
            throw new PluginAcpRuntimeError(
                'PLUGIN_ACP_EXTENSION_METHOD_CONFLICT',
                `ACP extension request method '${method}' conflicts with a shared ACP handler`,
            );
        }
        requests[method] = handler;
    }
    for (const [method, handler] of Object.entries(params.extensions.notifications)) {
        if (Object.prototype.hasOwnProperty.call(notifications, method)) {
            throw new PluginAcpRuntimeError(
                'PLUGIN_ACP_EXTENSION_METHOD_CONFLICT',
                `ACP extension notification method '${method}' conflicts with a shared ACP handler`,
            );
        }
        notifications[method] = handler;
    }
    return Object.freeze({
        requests: Object.freeze(requests),
        notifications: Object.freeze(notifications),
    });
}

function mergeHandlers(params: Readonly<{
    spec: ExecJsonRpcClientSpecV1;
    handlers: ExtensionHandlers;
}>): ExecJsonRpcClientSpecV1 {
    const baseJsonRpc = params.spec.handlers?.jsonRpc;
    const requests: Record<string, JsonRpcRequestHandlerV1> = {
        ...(baseJsonRpc?.requests ?? {}),
    };
    const notifications: Record<string, JsonRpcNotificationHandlerV1> = {
        ...(baseJsonRpc?.notifications ?? {}),
    };
    for (const [method, handler] of Object.entries(params.handlers.requests)) {
        if (Object.prototype.hasOwnProperty.call(requests, method)) {
            throw new PluginAcpRuntimeError(
                'PLUGIN_ACP_EXTENSION_METHOD_CONFLICT',
                `ACP request method '${method}' conflicts with a shared ACP handler`,
            );
        }
        requests[method] = handler;
    }
    for (const [method, handler] of Object.entries(params.handlers.notifications)) {
        if (Object.prototype.hasOwnProperty.call(notifications, method)) {
            throw new PluginAcpRuntimeError(
                'PLUGIN_ACP_EXTENSION_METHOD_CONFLICT',
                `ACP notification method '${method}' conflicts with a shared ACP handler`,
            );
        }
        notifications[method] = handler;
    }
    return Object.freeze({
        ...params.spec,
        handlers: Object.freeze({
            ...(params.spec.handlers ?? {}),
            jsonRpc: Object.freeze({
                ...(baseJsonRpc ?? {}),
                requests: Object.freeze(requests),
                notifications: Object.freeze(notifications),
            }),
        }),
    });
}

function requireJsonRpcClientSpec(spec: ExecClientSpecV1): ExecJsonRpcClientSpecV1 {
    if (spec.protocol.kind !== 'json-rpc-2.0') {
        throw new PluginAcpRuntimeError(
            'PLUGIN_ACP_RUNTIME_UNSUPPORTED_TRANSPORT',
            `ACP runtime requires JSON-RPC 2.0 exec client protocol, received '${spec.protocol.kind}'`,
        );
    }
    return spec as ExecJsonRpcClientSpecV1;
}

function registerExtensionHandlers(
    client: JsonRpcClientV1,
    handlers: ExtensionHandlers,
): readonly (() => void)[] {
    const disposers: (() => void)[] = [];
    for (const [method, handler] of Object.entries(handlers.requests)) {
        disposers.push(client.registerRequestHandler(method, handler));
    }
    for (const [method, handler] of Object.entries(handlers.notifications)) {
        disposers.push(client.registerNotificationHandler(method, handler));
    }
    return Object.freeze(disposers);
}

export function createPluginAcpRuntimeService(
    serviceParams: CreatePluginAcpRuntimeServiceParams,
): Pick<AcpAuthoringServiceV1, 'createRuntime'> {
    return Object.freeze({
        async createRuntime(
            spec: AcpBackendSpecV1,
            runtimeParams: CreateAcpRuntimeParamsV1,
        ): Promise<AcpRuntimeHandleV1> {
            const abortBinding = createAbortController([
                serviceParams.signal,
                runtimeParams.lifecycle?.signal,
            ]);
            const turnAbort = createTurnAbortManager(abortBinding.controller.signal);
            let sessionRuntimeController: AcpSessionRuntimeController | null = null;
            const pendingSessionUpdates: unknown[] = [];
            const sharedHandlers = createSharedSessionHandlers({
                readSessionRuntime: () => sessionRuntimeController,
                queueSessionUpdate: (update) => {
                    pendingSessionUpdates.push(update);
                },
            });
            const extensionHandlers = createExtensionHandlers({
                spec,
                runtimeParams,
                createRequestSignal: turnAbort.createRequestSignal,
            });
            const runtimeHandlers = mergeRuntimeHandlerSets({
                shared: sharedHandlers,
                extensions: extensionHandlers,
            });
            let clientHandle: ExecClientHandleV1<JsonRpcClientV1>;
            let unregisterHandlers: readonly (() => void)[] = [];
            if (runtimeParams.client) {
                clientHandle = runtimeParams.client;
                unregisterHandlers = registerExtensionHandlers(clientHandle.client, runtimeHandlers);
            } else {
                const baseSpec = runtimeParams.clientSpec
                    ? requireJsonRpcClientSpec(runtimeParams.clientSpec)
                    : await buildClientSpecFromAcpSpec({
                        spec,
                        runtimeParams,
                        createUnsupportedTransportError,
                        pluginContext: serviceParams.readPluginContext?.(),
                    });
                clientHandle = await serviceParams.exec.spawnClient(
                    mergeHandlers({
                        spec: baseSpec,
                        handlers: runtimeHandlers,
                    }),
                    { signal: abortBinding.controller.signal },
                );
            }
            sessionRuntimeController = createAcpSessionRuntime({
                client: clientHandle.client,
                sessionId: runtimeParams.sessionId,
                cwd: runtimeParams.cwd,
                signal: abortBinding.controller.signal,
                initializeMeta: runtimeParams.lifecycle?.initializeMeta,
                initialize: runtimeParams.lifecycle?.initialize,
                authenticate: runtimeParams.lifecycle?.authenticate,
                turnAbort,
                createDisposedError,
                createSessionNotStartedError,
                createInvalidResultError: createInvalidSessionResultError,
            });
            for (const update of pendingSessionUpdates.splice(0)) {
                sessionRuntimeController.handleSessionUpdate(update);
            }
            let disposed = false;
            const dispose = async (reason?: string): Promise<void> => {
                if (disposed) {
                    return;
                }
                disposed = true;
                abortBinding.controller.abort();
                abortBinding.dispose();
                for (const unregister of [...unregisterHandlers].reverse()) {
                    unregister();
                }
                await clientHandle.dispose({
                    code: 'PLUGIN_ACP_RUNTIME_DISPOSED',
                    message: reason ?? 'ACP runtime disposed',
                });
            };
            const handle: AcpRuntimeHandleV1 = Object.freeze({
                runtime: Object.freeze({
                    backendId: spec.backendId,
                    sessionId: runtimeParams.sessionId,
                    client: clientHandle.client,
                    request: <TParams = unknown, TResult = unknown>(
                        method: string,
                        params?: TParams,
                    ): Promise<TResult> => clientHandle.client.request<TParams, TResult>(method, params),
                    notify: <TParams = unknown>(
                        method: string,
                        params?: TParams,
                    ): Promise<void> => clientHandle.client.notify<TParams>(method, params),
                } satisfies AcpComposedRuntimeV1),
                sessionRuntime: sessionRuntimeController,
                dispose,
            });
            serviceParams.addDisposable?.(handle);
            return handle;
        },
    });
}
