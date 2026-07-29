import type { JsonValue } from '@happier-dev/plugin-sdk';
import type { ManagedExecutableRef, PluginAgentCliReadinessService, PluginExecService, PluginFramedBytesClient, PluginJsonRpcClient, PluginJsonStreamClient, PluginLoopbackWebSocketJsonClient, PluginPath, PluginProcessHandle, PluginProtocolClientHandle, PluginProtocolClientSpec, PluginProtocolClientSpecByKind, PluginProtocolClientsService, PluginSystemToolsService } from '@happier-dev/plugin-sdk/runtime';
import { PluginError } from '@happier-dev/plugin-sdk';
import { resolveWindowsCommandInvocation } from '@happier-dev/cli-common/process';
import type {
    ExecProcessHandleV1,
    ExecRunResultV1,
    ExecSystemToolServiceV1,
} from '../../exec/privateContract';

import { createJsonRpcProcessClient } from '../../exec/jsonRpc';
import { createJsonStreamProcessClient } from '../../exec/jsonStream';
import { createFramedBytesProcessClient } from '../../exec/framedBytes';
import {
    createLoopbackWebSocketJsonClient,
    createLoopbackWebSocketHandshakeClient,
} from '../../exec/loopbackWebSocket';
import {
    spawnSupervisedPluginProcess,
    type SupervisedPluginProcess,
} from '../../exec/processSupervisor';
import { PluginExecClientError } from '../../exec/errors';
import {
    isPluginPathAuthorizedByScope,
    type PluginFileSystemScope,
} from './filesystem';
import type { HostRuntimeLimitMeasurementRecorder } from '@/agent/runtime/state/runtimeLimitMeasurement';

type ResolvedPluginExecutable = Readonly<{
    command: string;
    args?: readonly string[];
    env?: Readonly<Record<string, string>>;
    allowedArguments?: readonly string[];
    release?: () => void;
}>;

export type HostResolvedManagedDependencyExecutable = Readonly<{
    command: string;
    args?: readonly string[];
    env?: Readonly<Record<string, string>>;
    release(): void;
}>;

export type HostResolvedSystemToolExecutable = Readonly<{
    executable: ManagedExecutableRef;
    command: string;
    args?: readonly string[];
    env?: Readonly<Record<string, string>>;
}>;

const INTERNAL_EXECUTABLE_RESOLVERS = new WeakMap<
    PluginExecService,
    (
        executable: ManagedExecutableRef,
        options?: Readonly<{ signal?: AbortSignal }>,
    ) => Promise<ResolvedPluginExecutable>
>();

const INTERNAL_SYSTEM_TOOL_RESOLVERS = new WeakMap<
    PluginExecService,
    (
        request: Parameters<PluginSystemToolsService['resolve']>[0],
    ) => Promise<HostResolvedSystemToolExecutable>
>();

export async function resolvePluginExecSystemToolForHost(
    service: PluginExecService,
    request: Parameters<PluginSystemToolsService['resolve']>[0],
): Promise<HostResolvedSystemToolExecutable> {
    const resolveSystemTool = INTERNAL_SYSTEM_TOOL_RESOLVERS.get(service);
    if (!resolveSystemTool) {
        fail(
            'plugin_exec_system_tool_resolution_unavailable',
            'System-tool executable resolution is unavailable in this invocation host',
        );
    }
    return await resolveSystemTool(request);
}

export async function resolvePluginExecManagedDependencyForHost(
    service: PluginExecService,
    dependencyId: string,
    options?: Readonly<{ signal?: AbortSignal }>,
): Promise<HostResolvedManagedDependencyExecutable> {
    const resolveExecutable = INTERNAL_EXECUTABLE_RESOLVERS.get(service);
    if (!resolveExecutable) {
        fail(
            'plugin_exec_managed_dependency_resolution_unavailable',
            'Managed-dependency executable resolution is unavailable in this invocation host',
        );
    }
    const resolved = await resolveExecutable({
        kind: 'managedDependency',
        id: dependencyId,
    }, options);
    return Object.freeze({
        command: resolved.command,
        ...(resolved.args ? { args: resolved.args } : {}),
        ...(resolved.env ? { env: resolved.env } : {}),
        release: resolved.release ?? (() => undefined),
    });
}

type ProtocolClientKind = PluginProtocolClientSpec['kind'];

export function resolveStablePluginExecInvocation(input: Readonly<{
    command: string;
    args: readonly string[];
    env: NodeJS.ProcessEnv;
}>) {
    return resolveWindowsCommandInvocation(input);
}

function executableKey(executable: ManagedExecutableRef): string {
    const id = typeof executable.id === 'string'
        ? executable.id
        : `${executable.id.pluginId}:${executable.id.localId}`;
    return `${executable.kind}:${id}`;
}

function fail(code: string, message: string, cause?: unknown): never {
    throw new PluginError({ code, message }, cause === undefined ? undefined : { cause });
}

export function adaptStablePluginExecLegacyProcessHandle(
    supervised: SupervisedPluginProcess,
): ExecProcessHandleV1 {
    const exit = supervised.handle.wait().then((result): ExecRunResultV1 => {
        const observed = result.termination.observed;
        if (observed.kind === 'failed') {
            throw new PluginExecClientError(
                observed.diagnostic.code,
                observed.diagnostic.message ?? 'Plugin process failed',
            );
        }
        return Object.freeze({
            exitCode: observed.kind === 'exit' ? observed.exitCode : null,
            signal: observed.kind === 'signal' ? observed.signal : null,
            stdout: Buffer.from(result.stdout).toString('utf8'),
            stderr: Buffer.from(result.stderr).toString('utf8'),
        });
    });
    // Protocol adapters may use the legacy process handle only for I/O and never observe
    // `exit`; own the rejection immediately while preserving it for callers that do await it.
    void exit.catch(() => undefined);
    return Object.freeze({
        pid: supervised.handle.pid,
        exit,
        writeStdin: async (data) => supervised.handle.write(
            typeof data === 'string' ? new Uint8Array(Buffer.from(data, 'utf8')) : data,
        ),
        kill: () => {
            void supervised.requestTermination({ kind: 'abort' });
        },
        dispose: () => supervised.dispose('caller'),
    });
}

export function createStablePluginExecService(params: Readonly<{
    allowedExecutables: readonly ManagedExecutableRef[];
    allowedEnvKeys?: readonly string[];
    environment?: Readonly<Record<string, string>>;
    allowedCwdScopes?: readonly PluginFileSystemScope[];
    signal: AbortSignal;
    isGenerationCurrent(): boolean;
    resolveExecutable(executable: ManagedExecutableRef): Promise<ResolvedPluginExecutable>;
    resolvePath(path: PluginPath): Promise<string>;
    agentCli?: PluginAgentCliReadinessService;
    systemTools?: ExecSystemToolServiceV1;
    recordRuntimeLimitMeasurement?: HostRuntimeLimitMeasurementRecorder;
}>): PluginExecService {
    const allowedExecutables = new Set(params.allowedExecutables.map(executableKey));
    const preResolvedSystemTools = new WeakMap<object, Readonly<{
        launch: ResolvedPluginExecutable;
        expiresAt: number | null;
    }>>();
    const allowedEnvKeys = new Set(params.allowedEnvKeys ?? []);
    const admittedEnvironment = Object.freeze(Object.fromEntries(
        Object.entries(params.environment ?? {}).filter(([key]) => allowedEnvKeys.has(key)),
    ));

    function guard(signal?: AbortSignal): void {
        if (!params.isGenerationCurrent()) {
            fail('plugin_generation_stale', 'Plugin generation is stale');
        }
        if (params.signal.aborted || signal?.aborted) {
            fail('plugin_exec_aborted', 'Process operation was aborted');
        }
    }

    function authorize(request: Readonly<{ executable: ManagedExecutableRef; env?: Readonly<Record<string, string>> }>): void {
        if (!allowedExecutables.has(executableKey(request.executable))) {
            fail('plugin_exec_access_denied', 'Executable is not authorized for this plugin invocation');
        }
        if (Object.keys(request.env ?? {}).some((key) => !allowedEnvKeys.has(key))) {
            fail('plugin_exec_environment_denied', 'Environment key is not authorized for this plugin invocation');
        }
    }

    const agentCli: PluginAgentCliReadinessService = Object.freeze({
        async checkReadiness(request: Parameters<PluginAgentCliReadinessService['checkReadiness']>[0]) {
            guard(request.signal);
            if (params.agentCli === undefined) {
                fail('plugin_exec_agent_cli_readiness_unavailable', 'Agent CLI readiness is unavailable in this invocation host');
            }
            const result = await params.agentCli.checkReadiness(request);
            guard(request.signal);
            return Object.freeze({ launchable: Object.freeze([...result.launchable]) });
        },
    });

    const systemTools: PluginSystemToolsService = Object.freeze({
        async resolve(request: Parameters<PluginSystemToolsService['resolve']>[0]) {
            guard(request.signal);
            const executable = Object.freeze({
                kind: 'systemTool' as const,
                id: request.toolId,
            });
            authorize({ executable });
            if (params.systemTools === undefined) {
                fail('plugin_exec_system_tool_resolution_unavailable', 'System-tool resolution is unavailable in this invocation host');
            }
            const resolved = await params.systemTools.resolve(request);
            guard(request.signal);
            preResolvedSystemTools.set(executable, Object.freeze({
                launch: Object.freeze({
                    command: resolved.launch.executablePath,
                    args: Object.freeze([...(resolved.launch.args ?? [])]),
                    env: Object.freeze({ ...(resolved.launch.env ?? {}) }),
                    ...(resolved.allowedArguments ? {
                        allowedArguments: Object.freeze([...resolved.allowedArguments]),
                    } : {}),
                }),
                expiresAt: resolved.expiresAt ?? null,
            }));
            return Object.freeze({
                executable,
                executablePath: resolved.executablePath,
                ...(resolved.diagnostics ? {
                    diagnostics: Object.freeze(resolved.diagnostics.map((diagnostic) => {
                        const detail = Object.freeze(Object.fromEntries(
                            Object.entries(diagnostic.detail ?? {}).filter(
                                (entry): entry is [string, string | number] => (
                                    typeof entry[1] === 'string'
                                    || (typeof entry[1] === 'number' && Number.isFinite(entry[1]))
                                ),
                            ),
                        ));
                        return Object.freeze({
                            code: diagnostic.code,
                            ...(Object.keys(detail).length > 0 ? { detail } : {}),
                        });
                    })),
                } : {}),
            });
        },
    });

    function validateOptionalByteLimit(value: number | undefined, field: string): void {
        if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) {
            fail('plugin_exec_invalid_limit', `${field} must be a non-negative safe integer`);
        }
    }

    function validateSpawnRequest(request: Parameters<PluginExecService['spawn']>[0] & { timeoutMs?: number }): void {
        validateOptionalByteLimit(request.maxStdoutBytes, 'maxStdoutBytes');
        validateOptionalByteLimit(request.maxStderrBytes, 'maxStderrBytes');
        if (request.timeoutMs !== undefined && (!Number.isSafeInteger(request.timeoutMs) || request.timeoutMs < 0)) {
            fail('plugin_exec_invalid_limit', 'timeoutMs must be a non-negative safe integer');
        }
        if (request.stdin !== undefined && !(request.stdin instanceof Uint8Array)) {
            fail('plugin_exec_invalid_input', 'Process stdin must be binary data');
        }
    }

    async function launchProcess(
        request: Parameters<PluginExecService['spawn']>[0] & Readonly<{ timeoutMs?: number }>,
        options?: { signal?: AbortSignal },
    ): Promise<SupervisedPluginProcess> {
        guard(options?.signal);
        authorize(request);
        validateSpawnRequest(request);
        if (request.cwd && !isPluginPathAuthorizedByScope(request.cwd, params.allowedCwdScopes ?? [], 'read')) {
            fail('plugin_exec_cwd_denied', 'Process working directory is not authorized for this plugin invocation');
        }
        let resolved: ResolvedPluginExecutable;
        const preResolved = preResolvedSystemTools.get(request.executable);
        if (preResolved) {
            if (preResolved.expiresAt !== null && preResolved.expiresAt <= Date.now()) {
                preResolvedSystemTools.delete(request.executable);
                return fail('plugin_exec_system_tool_resolution_expired', 'Pre-resolved system-tool launch has expired');
            }
            resolved = preResolved.launch;
        } else {
            try {
                resolved = await params.resolveExecutable(request.executable);
            } catch (error) {
                if (error instanceof PluginError) throw error;
                return fail('plugin_exec_resolve_failed', 'Executable could not be resolved', error);
            }
        }
        let released = false;
        const releaseExecutable = () => {
            if (released) return;
            released = true;
            resolved.release?.();
        };
        const allowedArguments = resolved.allowedArguments;
        if (
            allowedArguments !== undefined
            && (request.args ?? []).some((argument) => !allowedArguments.includes(argument))
        ) {
            releaseExecutable();
            return fail(
                'plugin_exec_argument_denied',
                'Process argument is not authorized for this system tool',
            );
        }
        try {
            guard(options?.signal);
        } catch (error) {
            releaseExecutable();
            throw error;
        }
        let cwd: string | undefined;
        try {
            cwd = request.cwd ? await params.resolvePath(request.cwd) : undefined;
        } catch (error) {
            releaseExecutable();
            if (error instanceof PluginError) throw error;
            return fail('plugin_exec_cwd_unavailable', 'Process working directory could not be resolved', error);
        }
        try {
            guard(options?.signal);
        } catch (error) {
            releaseExecutable();
            throw error;
        }
        let supervised: ReturnType<typeof spawnSupervisedPluginProcess>;
        try {
            const environment = {
                ...admittedEnvironment,
                ...(resolved.env ?? {}),
                ...(request.env ?? {}),
            };
            const invocation = resolveStablePluginExecInvocation({
                command: resolved.command,
                args: [...(resolved.args ?? []), ...(request.args ?? [])],
                env: environment,
            });
            supervised = spawnSupervisedPluginProcess({
                command: invocation.command,
                args: invocation.args,
                ...(cwd ? { cwd } : {}),
                env: environment,
                ...(request.stdin ? { stdin: request.stdin } : {}),
                ...(request.timeoutMs === undefined ? {} : { timeoutMs: request.timeoutMs }),
                ...(request.maxStdoutBytes === undefined ? {} : { maxStdoutBytes: request.maxStdoutBytes }),
                ...(request.maxStderrBytes === undefined ? {} : { maxStderrBytes: request.maxStderrBytes }),
                signals: options?.signal ? [options.signal] : [],
                spawnOptions: {
                    // A dedicated POSIX process group lets the canonical supervisor
                    // terminate the complete plugin tree immediately without first
                    // enumerating every process on the host. Windows remains attached
                    // and uses taskkill's tree semantics.
                    detached: process.platform !== 'win32',
                    windowsVerbatimArguments: invocation.windowsVerbatimArguments,
                },
                ...(params.recordRuntimeLimitMeasurement
                    ? { recordRuntimeLimitMeasurement: params.recordRuntimeLimitMeasurement }
                    : {}),
            });
        } catch (error) {
            releaseExecutable();
            return fail('plugin_exec_spawn_failed', 'Process could not be started', error);
        }
        const retire = () => {
            void supervised.dispose('generationRetired');
        };
        params.signal.addEventListener('abort', retire, { once: true });
        void supervised.handle.wait().finally(() => {
            params.signal.removeEventListener('abort', retire);
            releaseExecutable();
        });
        return supervised;
    }

    async function spawnProcess(
        request: Parameters<PluginExecService['spawn']>[0],
        options?: { signal?: AbortSignal },
    ): Promise<PluginProcessHandle> {
        return (await launchProcess(request, options)).handle;
    }

    async function spawnJsonRpcClient(
        spec: Extract<Parameters<PluginExecService['clients']['spawn']>[0], { kind: 'jsonRpc' }>,
        options?: { signal?: AbortSignal },
    ): Promise<PluginProtocolClientHandle<'jsonRpc'>> {
        const supervised = await launchProcess(spec.launch, options);
        const legacyProcess = adaptStablePluginExecLegacyProcessHandle(supervised);
        const protocol = createJsonRpcProcessClient({
            process: legacyProcess,
            stdout: supervised.child.stdout,
            write: async (data) => supervised.handle.write(typeof data === 'string'
                ? new Uint8Array(Buffer.from(data, 'utf8'))
                : data),
            framing: spec.framing,
            maxFrameBytes: spec.maxFrameBytes,
            requestTimeoutMs: spec.requestTimeoutMs,
            readStderrPreview: () => Buffer.from(supervised.readBufferedStderr()).toString('utf8'),
            onFailure: () => {
                void supervised.dispose('runtimeRecovery');
            },
            ...(params.recordRuntimeLimitMeasurement
                ? { recordRuntimeLimitMeasurement: params.recordRuntimeLimitMeasurement }
                : {}),
        });
        const requestMethods = new Set<string>();
        const client: PluginJsonRpcClient = Object.freeze({
            async request(method: string, requestParams?: JsonValue, requestOptions?: { signal?: AbortSignal; timeoutMs?: number }) {
                return await protocol.client.request<JsonValue | undefined, JsonValue>(method, requestParams, requestOptions);
            },
            notify: (method: string, notificationParams?: JsonValue) => protocol.client.notify(method, notificationParams),
            onNotification(listener: Parameters<PluginJsonRpcClient['onNotification']>[0]) {
                const unsubscribe = protocol.subscribeNotification((message) => listener({
                    method: message.method,
                    ...(message.params === undefined ? {} : { params: message.params as JsonValue }),
                }));
                return Object.freeze({ dispose: unsubscribe });
            },
            onRequest(method: string, listener: Parameters<PluginJsonRpcClient['onRequest']>[1]) {
                if (requestMethods.has(method)) {
                    fail('plugin_exec_protocol_duplicate_handler', `JSON-RPC method '${method}' already has a responder`);
                }
                requestMethods.add(method);
                const unregister = protocol.client.registerRequestHandler(method, async (requestParams, context) => {
                    return await listener({
                        id: context.requestId
                            ?? fail('plugin_exec_protocol_invalid_request', 'JSON-RPC server request is missing its correlation id'),
                        method,
                        ...(requestParams === undefined ? {} : { params: requestParams as JsonValue }),
                    });
                });
                return Object.freeze({
                    dispose() {
                        requestMethods.delete(method);
                        unregister();
                    },
                });
            },
            dispose: () => protocol.dispose(),
        });
        let disposePromise: Promise<void> | null = null;
        const dispose = (): Promise<void> => {
            disposePromise ??= (async () => {
                protocol.dispose();
                await supervised.dispose('caller');
            })();
            return disposePromise;
        };
        void supervised.handle.wait().then((result) => {
            protocol.settleExit(new PluginExecClientError(
                'PLUGIN_EXEC_CLIENT_EXITED',
                `Plugin process terminated (${result.termination.observed.kind})`,
            ));
        });
        return Object.freeze({
            client,
            process: supervised.handle,
            wait: () => supervised.handle.wait(),
            dispose,
        });
    }

    async function spawnJsonStreamClient(
        spec: Extract<Parameters<PluginExecService['clients']['spawn']>[0], { kind: 'jsonStream' }>,
        options?: { signal?: AbortSignal },
    ): Promise<PluginProtocolClientHandle<'jsonStream'>> {
        const supervised = await launchProcess(spec.launch, options);
        const protocol = createJsonStreamProcessClient({
            process: adaptStablePluginExecLegacyProcessHandle(supervised),
            stdout: supervised.child.stdout,
            write: async (data) => supervised.handle.write(new Uint8Array(Buffer.from(data, 'utf8'))),
            maxFrameBytes: spec.maxFrameBytes,
            readStderrPreview: () => Buffer.from(supervised.readBufferedStderr()).toString('utf8'),
            ...(params.recordRuntimeLimitMeasurement
                ? { recordRuntimeLimitMeasurement: params.recordRuntimeLimitMeasurement }
                : {}),
        });
        const client: PluginJsonStreamClient = Object.freeze({
            async write(value: JsonValue) {
                const outcome = await protocol.client.writeRecord(value);
                if (outcome.kind !== 'written') {
                    const code = outcome.error instanceof PluginExecClientError
                        ? outcome.error.code
                        : 'PLUGIN_EXEC_CLIENT_WRITE_FAILED';
                    throw new PluginError({
                        code,
                        message: outcome.error.message,
                        details: {
                            jsonStreamWriteOutcome: outcome.kind,
                        },
                    }, { cause: outcome.error });
                }
            },
            subscribe(listener: Parameters<PluginJsonStreamClient['subscribe']>[0]) {
                const unsubscribe = protocol.client.subscribe((value) => listener(value as JsonValue));
                return Object.freeze({ dispose: unsubscribe });
            },
            dispose: () => protocol.dispose(),
        });
        let disposePromise: Promise<void> | null = null;
        const dispose = (): Promise<void> => {
            disposePromise ??= (async () => {
                protocol.dispose();
                await supervised.dispose('caller');
            })();
            return disposePromise;
        };
        void supervised.handle.wait().then(() => {
            protocol.settleExit(new PluginExecClientError('PLUGIN_EXEC_CLIENT_EXITED', 'Plugin process terminated'));
        });
        return Object.freeze({ client, process: supervised.handle, wait: () => supervised.handle.wait(), dispose });
    }

    async function spawnFramedBytesClient(
        spec: Extract<Parameters<PluginExecService['clients']['spawn']>[0], { kind: 'framedBytes' }>,
        options?: { signal?: AbortSignal },
    ): Promise<PluginProtocolClientHandle<'framedBytes'>> {
        const supervised = await launchProcess(spec.launch, options);
        const protocol = createFramedBytesProcessClient({
            process: adaptStablePluginExecLegacyProcessHandle(supervised),
            stdout: supervised.child.stdout,
            write: (data) => supervised.handle.write(data),
            framing: spec.framing,
            maxFrameBytes: spec.maxFrameBytes,
            readStderrPreview: () => Buffer.from(supervised.readBufferedStderr()).toString('utf8'),
            ...(params.recordRuntimeLimitMeasurement
                ? { recordRuntimeLimitMeasurement: params.recordRuntimeLimitMeasurement }
                : {}),
        });
        const client: PluginFramedBytesClient = Object.freeze({
            writeFrame: (frame: Uint8Array) => protocol.client.writeFrame(frame),
            subscribe(listener: Parameters<PluginFramedBytesClient['subscribe']>[0]) {
                const unsubscribe = protocol.client.subscribe(listener);
                return Object.freeze({ dispose: unsubscribe });
            },
            dispose: () => protocol.dispose(),
        });
        let disposePromise: Promise<void> | null = null;
        const dispose = (): Promise<void> => {
            disposePromise ??= (async () => {
                protocol.dispose();
                await supervised.dispose('caller');
            })();
            return disposePromise;
        };
        void supervised.handle.wait().then(() => {
            protocol.settleExit(new PluginExecClientError('PLUGIN_EXEC_CLIENT_EXITED', 'Plugin process terminated'));
        });
        return Object.freeze({ client, process: supervised.handle, wait: () => supervised.handle.wait(), dispose });
    }

    async function spawnLoopbackWebSocketClient(
        spec: Extract<Parameters<PluginExecService['clients']['spawn']>[0], { kind: 'loopbackWebSocketJson' }>,
        options?: { signal?: AbortSignal },
    ): Promise<PluginProtocolClientHandle<'loopbackWebSocketJson'>> {
        const supervised = await launchProcess(spec.launch, options);
        let protocol: Awaited<ReturnType<typeof createLoopbackWebSocketJsonClient>>;
        try {
            if (spec.handshake) {
                const handshake = spec.handshake;
                protocol = await createLoopbackWebSocketHandshakeClient({
                    handshake: {
                        byteOrder: handshake.byteOrder,
                        requestFrames: handshake.requestFrames,
                        response: {
                            byteOrder: handshake.byteOrder,
                            maxFrameBytes: spec.maxFrameBytes,
                        },
                    },
                    endpoint: {
                        decodeHandshakeResponse: handshake.decodeResponse,
                        buildHeaders: (endpoint) => endpoint.headers ?? [],
                    },
                    limits: { maxMessageBytes: spec.maxFrameBytes },
                    process: {
                        child: {
                            stdin: supervised.child.stdin,
                            stdout: supervised.child.stdout,
                        },
                        handle: adaptStablePluginExecLegacyProcessHandle(supervised),
                        readStderrPreview: () => Buffer.from(supervised.readBufferedStderr()).toString('utf8'),
                    },
                    ...(options?.signal ? { optionsSignal: options.signal } : {}),
                    ...(params.recordRuntimeLimitMeasurement
                        ? { recordRuntimeLimitMeasurement: params.recordRuntimeLimitMeasurement }
                        : {}),
                });
            } else {
                protocol = await createLoopbackWebSocketJsonClient({
                    endpoint: {
                        host: spec.endpoint.host,
                        port: spec.endpoint.port,
                        path: spec.endpoint.path ?? '/',
                    },
                    headers: spec.endpoint.headers ?? [],
                    limits: { maxMessageBytes: spec.maxFrameBytes },
                    ...(options?.signal ? { signal: options.signal } : {}),
                    readDiagnosticPreview: () => Buffer.from(supervised.readBufferedStderr()).toString('utf8'),
                    ...(params.recordRuntimeLimitMeasurement
                        ? { recordRuntimeLimitMeasurement: params.recordRuntimeLimitMeasurement }
                        : {}),
                });
            }
        } catch (error) {
            await supervised.dispose('caller');
            if (error instanceof PluginError) throw error;
            return fail('plugin_exec_client_create_failed', 'Protocol client could not be created', error);
        }
        const client: PluginLoopbackWebSocketJsonClient = Object.freeze({
            send: (value: JsonValue) => protocol.client.sendJson(value),
            subscribe(listener: Parameters<PluginLoopbackWebSocketJsonClient['subscribe']>[0]) {
                const unsubscribe = protocol.client.subscribe((value) => listener(value as JsonValue));
                return Object.freeze({ dispose: unsubscribe });
            },
            dispose: () => protocol.dispose(),
        });
        let disposePromise: Promise<void> | null = null;
        const dispose = (): Promise<void> => {
            disposePromise ??= (async () => {
                protocol.dispose();
                await supervised.dispose('caller');
            })();
            return disposePromise;
        };
        void supervised.handle.wait().then(() => {
            protocol.settleExit(new PluginExecClientError('PLUGIN_EXEC_CLIENT_EXITED', 'Plugin process terminated'));
        });
        return Object.freeze({ client, process: supervised.handle, wait: () => supervised.handle.wait(), dispose });
    }

    async function spawnProtocolClient(
        spec: PluginProtocolClientSpec,
        options?: { signal?: AbortSignal },
    ): Promise<PluginProtocolClientHandle> {
        if (!Number.isSafeInteger(spec.maxFrameBytes) || spec.maxFrameBytes <= 0) {
            return fail('plugin_exec_invalid_limit', 'maxFrameBytes must be a positive safe integer');
        }
        if (spec.kind === 'jsonRpc' && spec.requestTimeoutMs !== undefined && (
            !Number.isSafeInteger(spec.requestTimeoutMs) || spec.requestTimeoutMs < 0
        )) {
            return fail('plugin_exec_invalid_limit', 'requestTimeoutMs must be a non-negative safe integer');
        }
        if (spec.kind === 'loopbackWebSocketJson' && spec.endpoint && (
            !Number.isSafeInteger(spec.endpoint.port)
            || spec.endpoint.port < 1
            || spec.endpoint.port > 65_535
        )) {
            return fail('plugin_exec_invalid_endpoint', 'Loopback WebSocket port is invalid');
        }
        if (spec.kind === 'loopbackWebSocketJson' && spec.handshake && (
            spec.handshake.framing !== 'lengthPrefix'
            || !['little-endian', 'big-endian'].includes(spec.handshake.byteOrder)
        )) {
            return fail('plugin_exec_invalid_handshake', 'Loopback WebSocket handshake framing is invalid');
        }
        switch (spec.kind) {
            case 'jsonRpc': return await spawnJsonRpcClient(spec, options);
            case 'jsonStream': return await spawnJsonStreamClient(spec, options);
            case 'framedBytes': return await spawnFramedBytesClient(spec, options);
            case 'loopbackWebSocketJson': return await spawnLoopbackWebSocketClient(spec, options);
        }
    }

    const clients: PluginProtocolClientsService = Object.freeze({
        async spawn<K extends ProtocolClientKind>(
            spec: PluginProtocolClientSpecByKind<K>,
            options?: { signal?: AbortSignal },
        ): Promise<PluginProtocolClientHandle<K>> {
            return await spawnProtocolClient(spec, options) as PluginProtocolClientHandle<K>;
        },
    });

    const service: PluginExecService = Object.freeze({
        agentCli,
        systemTools,
        async run(
            request: Parameters<PluginExecService['run']>[0],
            options?: Parameters<PluginExecService['run']>[1],
        ) {
            const handle = (await launchProcess(
                request.stdin === undefined
                    ? { ...request, stdin: new Uint8Array() }
                    : request,
                options,
            )).handle;
            try {
                return await handle.wait();
            } finally {
                await handle.dispose();
            }
        },
        spawn: spawnProcess,
        clients,
    });
    INTERNAL_EXECUTABLE_RESOLVERS.set(service, async (executable, options) => {
        guard(options?.signal);
        authorize({ executable });
        const resolved = await params.resolveExecutable(executable);
        try {
            guard(options?.signal);
            return resolved;
        } catch (error) {
            resolved.release?.();
            throw error;
        }
    });
    INTERNAL_SYSTEM_TOOL_RESOLVERS.set(service, async (request) => {
        const resolved = await systemTools.resolve(request);
        const preResolved = preResolvedSystemTools.get(resolved.executable);
        if (!preResolved) {
            fail(
                'plugin_exec_system_tool_resolution_unavailable',
                'The invocation-local system-tool launch is unavailable',
            );
        }
        if (
            preResolved.expiresAt !== null
            && preResolved.expiresAt <= Date.now()
        ) {
            preResolvedSystemTools.delete(resolved.executable);
            fail(
                'plugin_exec_system_tool_resolution_expired',
                'Pre-resolved system-tool launch has expired',
            );
        }
        return Object.freeze({
            executable: resolved.executable,
            command: preResolved.launch.command,
            ...(preResolved.launch.args
                ? { args: preResolved.launch.args }
                : {}),
            ...(preResolved.launch.env
                ? { env: preResolved.launch.env }
                : {}),
        });
    });
    return service;
}
