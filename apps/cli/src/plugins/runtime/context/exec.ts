import { basename, isAbsolute } from 'node:path';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';

import { resolveWindowsCommandInvocation } from '@happier-dev/cli-common/process';
import type {
    ExecClientHandleV1,
    ExecClientDisposeReasonV1,
    ExecClientDiagnosticSanitizerV1,
    ExecProtocolClientV1,
    ExecClientSpecV1,
    ExecFramedBytesClientSpecV1,
    ExecJsonRpcClientSpecV1,
    ExecJsonStreamClientSpecV1,
    ExecLaunchInputV1,
    ExecProcessHandleV1,
    ExecRunOptionsV1,
    ExecRunResultV1,
    ExecRuntimeServiceV1,
    FramedBytesClientV1,
    JsonRpcClientV1,
    JsonStreamClientV1,
} from '@happier-dev/plugin-sdk';

import type { CatalogAgentLookupId } from '@/backends/types';
import { killProcessTree } from '@/agent/runtime/process/killProcessTree';
import { requireProviderCliLaunchSpec } from '@/packagedRuntime/managedTools/requireProviderCliLaunchSpec';

import { PluginExecClientError, sanitizeExecDiagnosticText } from '../exec/errors';
import { createFramedBytesProcessClient } from '../exec/framedBytes';
import { createJsonRpcProcessClient } from '../exec/jsonRpc';
import { createJsonStreamProcessClient } from '../exec/jsonStream';
import { composeJsonRpcDiagnosticHooks, createExecClientRpcLogger } from '../exec/diagnostics/rpcLog';
import type { PluginExecSystemToolDefinition } from './exec/system/tools/definitions';
import {
    createPluginExecSystemToolGrantStore,
    type PluginExecSystemToolGrantStore,
} from './exec/system/tools/grants';
import { createPluginExecSystemToolResolver } from './exec/system/tools/resolveGrant';
import { isDeniedPathOnlyRuntimeName, normalizePathOnlyRuntimeName } from './exec/system/tools/runtimeDeny';

type PluginExecDisposable = Readonly<{
    dispose: () => void | Promise<void>;
}>;

type ResolvedPluginExecLaunch = Readonly<{
    executablePath: string;
    args: readonly string[];
    cwd?: string;
    env?: Readonly<Record<string, string>>;
    stdin?: string | Uint8Array;
    grantKind?: 'agent-cli';
}>;

type SpawnedPluginProcess = Readonly<{
    child: ChildProcessWithoutNullStreams;
    handle: ExecProcessHandleV1;
    readStderrPreview: () => string;
}>;

type ExecProtocolProcessClient<TClient extends ExecProtocolClientV1 = ExecProtocolClientV1> = Readonly<{
    client: TClient;
    dispose(error?: Error): void;
    settleExit(error: Error): void;
}>;

export type PluginExecErrorCode =
    | 'PLUGIN_EXEC_PERMISSION_DENIED'
    | 'PLUGIN_EXEC_UNRESOLVED_LAUNCH'
    | 'PLUGIN_EXEC_UNSUPPORTED_LAUNCH'
    | 'PLUGIN_EXEC_PATH_ONLY_RUNTIME_DENIED';

export class PluginExecError extends Error {
    readonly code: PluginExecErrorCode;

    constructor(code: PluginExecErrorCode, message: string) {
        super(message);
        this.name = 'PluginExecError';
        this.code = code;
    }
}

export type CreatePluginExecServiceParams = Readonly<{
    allowedExecutablePaths?: readonly string[];
    allowPathRuntimeNames?: readonly string[];
    baseEnv?: Readonly<Record<string, string>>;
    signal?: AbortSignal;
    addDisposable?: (disposable: PluginExecDisposable) => unknown;
    systemTools?: readonly PluginExecSystemToolDefinition[];
    systemToolGrantStore?: PluginExecSystemToolGrantStore;
    now?: () => number;
    rpcLogAllowedDirectories?: readonly string[];
}>;

function createAbortError(): Error {
    const error = new Error('Plugin exec operation was aborted');
    error.name = 'AbortError';
    return error;
}

function resolveExecutableLaunch(input: ExecLaunchInputV1): ResolvedPluginExecLaunch {
    if (input.kind === 'ipc') {
        throw new PluginExecError(
            'PLUGIN_EXEC_UNSUPPORTED_LAUNCH',
            'ctx.exec ipc launch is declared in the SDK but is not supported by the process-backed host runtime',
        );
    }
    if (input.kind !== 'binary' || input.executablePath.trim().length === 0) {
        throw new PluginExecError(
            'PLUGIN_EXEC_UNRESOLVED_LAUNCH',
            'ctx.exec requires a host-resolved executable launch input',
        );
    }
    if (!isAbsolute(input.executablePath)) {
        throw new PluginExecError(
            'PLUGIN_EXEC_UNRESOLVED_LAUNCH',
            `ctx.exec requires an absolute host-resolved executable path, received '${input.executablePath}'`,
        );
    }
    return {
        executablePath: input.executablePath,
        args: input.args ?? [],
        cwd: input.cwd,
        env: input.env,
        stdin: input.stdin,
    };
}

function buildProviderCliProcessEnv(
    params: CreatePluginExecServiceParams,
    input: Extract<ExecLaunchInputV1, { kind: 'agent-cli' }>,
): NodeJS.ProcessEnv {
    const processEnv: NodeJS.ProcessEnv = { ...process.env };
    for (const source of [params.baseEnv, input.env]) {
        for (const [key, value] of Object.entries(source ?? {})) {
            if (typeof value === 'string') {
                processEnv[key] = value;
            }
        }
    }
    return processEnv;
}

function resolveAgentCliLaunch(
    input: Extract<ExecLaunchInputV1, { kind: 'agent-cli' }>,
    params: CreatePluginExecServiceParams,
): ResolvedPluginExecLaunch {
    const launch = requireProviderCliLaunchSpec(input.agentId as CatalogAgentLookupId, {
        processEnv: buildProviderCliProcessEnv(params, input),
    });
    return {
        executablePath: launch.command,
        args: [
            ...launch.args,
            ...(input.args ?? []),
        ],
        cwd: input.cwd,
        env: input.env,
        stdin: input.stdin,
        grantKind: 'agent-cli',
    };
}

function resolveAllowedLaunch(
    input: ExecLaunchInputV1,
    params: CreatePluginExecServiceParams,
    systemToolGrantStore: PluginExecSystemToolGrantStore,
): ResolvedPluginExecLaunch {
    const launch = input.kind === 'agent-cli'
        ? resolveAgentCliLaunch(input, params)
        : resolveExecutableLaunch(input);
    if (launch.grantKind === 'agent-cli') {
        return launch;
    }
    const executableName = basename(launch.executablePath);
    const pathOnlyRuntimeName = normalizePathOnlyRuntimeName(executableName);
    if (isDeniedPathOnlyRuntimeName(executableName)) {
        const explicitlyAllowed = params.allowPathRuntimeNames
            ?.some((allowedName) => normalizePathOnlyRuntimeName(allowedName) === pathOnlyRuntimeName) === true;
        if (!explicitlyAllowed) {
            throw new PluginExecError(
                'PLUGIN_EXEC_PATH_ONLY_RUNTIME_DENIED',
                `ctx.exec cannot launch '${executableName}' without a managed runtime policy`,
            );
        }
    }
    const explicitManifestGrant = new Set(params.allowedExecutablePaths ?? []).has(launch.executablePath);
    if (!explicitManifestGrant && !systemToolGrantStore.hasActivePathGrant(launch.executablePath)) {
        throw new PluginExecError(
            'PLUGIN_EXEC_PERMISSION_DENIED',
            `ctx.exec cannot launch undeclared executable '${launch.executablePath}'`,
        );
    }
    return launch;
}

function clipBuffer(buffer: string, maxBytes: number | undefined): string {
    if (maxBytes === undefined || maxBytes < 0) {
        return buffer;
    }
    return Buffer.byteLength(buffer) <= maxBytes
        ? buffer
        : Buffer.from(buffer).subarray(0, maxBytes).toString('utf8');
}

function isClientSpec(input: ExecLaunchInputV1 | ExecClientSpecV1): input is ExecClientSpecV1 {
    return 'launch' in input && 'transport' in input && 'protocol' in input;
}

function createExecClientDisposeError(reason: ExecClientDisposeReasonV1 | undefined, stderrPreview?: string): PluginExecClientError {
    const code = typeof reason?.code === 'string' && reason.code.trim().length > 0
        ? reason.code.trim()
        : 'PLUGIN_EXEC_CLIENT_DISPOSED';
    const message = typeof reason?.message === 'string' && reason.message.trim().length > 0
        ? reason.message.trim()
        : 'Plugin exec client was disposed';
    return new PluginExecClientError(code, message, { stderrPreview });
}

function createSpawnedPluginProcess(
    launch: ExecLaunchInputV1,
    options: ExecRunOptionsV1 | undefined,
    params: CreatePluginExecServiceParams,
    systemToolGrantStore: PluginExecSystemToolGrantStore,
    diagnosticSanitizer?: ExecClientDiagnosticSanitizerV1,
): SpawnedPluginProcess {
    const resolvedLaunch = resolveAllowedLaunch(launch, params, systemToolGrantStore);
    if (options?.signal?.aborted || params.signal?.aborted) {
        throw createAbortError();
    }
    const env = { ...(params.baseEnv ?? {}), ...(resolvedLaunch.env ?? {}) };
    const invocation = resolveWindowsCommandInvocation({
        command: resolvedLaunch.executablePath,
        args: [...resolvedLaunch.args],
        env,
        resolveCommandOnPath: false,
    });
    const child = spawn(invocation.command, invocation.args, {
        cwd: resolvedLaunch.cwd,
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: false,
        windowsVerbatimArguments: invocation.windowsVerbatimArguments,
    });
    let stdout = '';
    let stderr = '';
    let disposePromise: Promise<void> | null = null;
    let exited = false;
    let terminationPromise: Promise<void> | null = null;
    const requestTermination = (signal?: string): Promise<void> => {
        terminationPromise ??= terminateProcessTree(child, signal);
        return terminationPromise;
    };
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string | Buffer | Uint8Array) => {
        const text = typeof chunk === 'string'
            ? chunk
            : Buffer.from(chunk).toString('utf8');
        stdout = clipBuffer(stdout + text, options?.maxStdoutBytes);
    });
    child.stderr.on('data', (chunk: string) => {
        stderr = clipBuffer(stderr + chunk, options?.maxStderrBytes);
    });
    child.stdin.on('error', () => {
        // Write callers receive callback errors; this listener prevents process-level unhandled EPIPE events.
    });
    const timeout = options?.timeoutMs === undefined
        ? null
        : setTimeout(() => {
            void requestTermination();
        }, Math.max(0, options.timeoutMs));
    const abortProcess = () => {
        void requestTermination();
    };
    options?.signal?.addEventListener('abort', abortProcess, { once: true });
    params.signal?.addEventListener('abort', abortProcess, { once: true });
    if (resolvedLaunch.stdin !== undefined) {
        child.stdin.end(resolvedLaunch.stdin);
    }
    const exit = new Promise<ExecRunResultV1>((resolve, reject) => {
        child.once('error', (error) => {
            exited = true;
            reject(error);
        });
        child.once('exit', (exitCode, signal) => {
            exited = true;
            if (timeout) {
                clearTimeout(timeout);
            }
            resolve(Object.freeze({
                exitCode,
                signal,
                stdout,
                stderr,
            }));
        });
    });
    const close = new Promise<void>((resolve) => {
        child.once('close', () => {
            resolve();
        });
    });
    const handle: ExecProcessHandleV1 = Object.freeze({
        pid: child.pid ?? null,
        exit,
        async writeStdin(inputChunk) {
            await new Promise<void>((resolve, reject) => {
                child.stdin.write(inputChunk, (error) => {
                    if (error) {
                        reject(error);
                        return;
                    }
                    resolve();
                });
            });
        },
        kill(signal?: string) {
            void requestTermination(signal);
        },
        async dispose() {
            if (disposePromise) {
                await disposePromise;
                return;
            }
            disposePromise = (async () => {
                if (timeout) {
                    clearTimeout(timeout);
                }
                options?.signal?.removeEventListener('abort', abortProcess);
                params.signal?.removeEventListener('abort', abortProcess);
                if (!exited) {
                    await requestTermination();
                } else {
                    await terminationPromise?.catch(() => undefined);
                }
                await exit.catch(() => undefined);
                await close.catch(() => undefined);
            })();
            await disposePromise;
        },
    });
    params.addDisposable?.(handle);
    return {
        child,
        handle,
        readStderrPreview: () => sanitizeExecDiagnosticText(stderr, options?.maxStderrBytes ?? 4096, diagnosticSanitizer),
    };
}

async function terminateProcessTree(child: ChildProcessWithoutNullStreams, signal?: string): Promise<void> {
    const initialSignal = signal as NodeJS.Signals | undefined;
    try {
        await killProcessTree(child, { graceMs: 100 });
    } catch {
        try {
            child.kill(initialSignal);
        } catch {
            // Already exited.
        }
    }
}

function assertExecClientTransportSupported(input: ExecClientSpecV1): void {
    if (input.transport.kind !== 'stdio') {
        throw new PluginExecClientError(
            'PLUGIN_EXEC_CLIENT_PROTOCOL_ERROR',
            `Unsupported exec client transport '${input.transport.kind}'`,
        );
    }
}

function assertStrictLfJsonFraming(input: ExecClientSpecV1): void {
    if (input.transport.framing.kind !== 'strict-lf-json') {
        throw new PluginExecClientError(
            'PLUGIN_EXEC_CLIENT_PROTOCOL_ERROR',
            `Unsupported exec client framing '${input.transport.framing.kind}'`,
        );
    }
}

function assertFramedBytesFraming(input: ExecClientSpecV1): void {
    if (input.transport.framing.kind !== 'framed-bytes') {
        throw new PluginExecClientError(
            'PLUGIN_EXEC_CLIENT_PROTOCOL_ERROR',
            `Unsupported exec client framing '${input.transport.framing.kind}'`,
        );
    }
}

function validateExecClientSpec(input: ExecClientSpecV1): void {
    assertExecClientTransportSupported(input);
    switch (input.protocol.kind) {
        case 'json-rpc-2.0':
        case 'json-stream':
            assertStrictLfJsonFraming(input);
            return;
        case 'framed-bytes':
            assertFramedBytesFraming(input);
            return;
        default:
            throw new PluginExecClientError(
                'PLUGIN_EXEC_CLIENT_PROTOCOL_ERROR',
                `Unsupported exec client protocol '${(input.protocol as { kind?: string }).kind ?? 'unknown'}'`,
            );
    }
}

function createProtocolClientForSpec(
    input: ExecClientSpecV1,
    spawned: SpawnedPluginProcess,
    rpcLogger: ReturnType<typeof createExecClientRpcLogger>,
): ExecProtocolProcessClient {
    switch (input.protocol.kind) {
        case 'json-rpc-2.0':
            assertStrictLfJsonFraming(input);
            return createJsonRpcProcessClient({
                process: spawned.handle,
                stdout: spawned.child.stdout,
                write: (chunk) => spawned.handle.writeStdin(chunk),
                encoding: input.transport.encoding === undefined ? undefined : input.transport.encoding as BufferEncoding,
                maxFrameBytes: input.transport.maxFrameBytes,
                requestTimeoutMs: input.lifecycle?.requestTimeoutMs,
                handlers: input.handlers?.jsonRpc,
                hooks: composeJsonRpcDiagnosticHooks(input.hooks?.jsonRpc, rpcLogger),
                readStderrPreview: spawned.readStderrPreview,
            });
        case 'json-stream':
            assertStrictLfJsonFraming(input);
            return createJsonStreamProcessClient({
                process: spawned.handle,
                stdout: spawned.child.stdout,
                write: (chunk) => spawned.handle.writeStdin(chunk),
                encoding: input.transport.encoding === undefined ? undefined : input.transport.encoding as BufferEncoding,
                maxFrameBytes: input.transport.maxFrameBytes,
                readStderrPreview: spawned.readStderrPreview,
            });
        case 'framed-bytes':
            assertFramedBytesFraming(input);
            return createFramedBytesProcessClient({
                process: spawned.handle,
                stdout: spawned.child.stdout,
                write: (chunk) => spawned.handle.writeStdin(chunk),
                maxFrameBytes: input.transport.maxFrameBytes,
                readStderrPreview: spawned.readStderrPreview,
            });
    }
}

function settleProtocolExitAfterStdoutDrain(
    spawned: SpawnedPluginProcess,
    protocolClient: ExecProtocolProcessClient,
    error: Error,
): void {
    const stdout = spawned.child.stdout;
    if (stdout.readableEnded || stdout.destroyed) {
        protocolClient.settleExit(error);
        return;
    }
    let settled = false;
    const settle = () => {
        if (settled) {
            return;
        }
        settled = true;
        stdout.off('end', settle);
        stdout.off('close', settle);
        protocolClient.settleExit(error);
    };
    stdout.once('end', settle);
    stdout.once('close', settle);
    setTimeout(settle, 250).unref?.();
}

export function createPluginExecService(params: CreatePluginExecServiceParams = {}): ExecRuntimeServiceV1 {
    const systemToolGrantStore = params.systemToolGrantStore
        ?? createPluginExecSystemToolGrantStore({ now: params.now });
    const systemTools = createPluginExecSystemToolResolver({
        definitions: params.systemTools,
        baseEnv: params.baseEnv,
        now: params.now,
        registerGrant(grant) {
            systemToolGrantStore.register(grant);
        },
    });

    async function spawn(input: ExecLaunchInputV1, options?: ExecRunOptionsV1): Promise<ExecProcessHandleV1> {
        return createSpawnedPluginProcess(input, options, params, systemToolGrantStore).handle;
    }

    async function run(input: ExecLaunchInputV1, options?: ExecRunOptionsV1): Promise<ExecRunResultV1> {
        const handle = await spawn(input, options);
        try {
            return await handle.exit;
        } finally {
            await handle.dispose();
        }
    }

    async function spawnClient(
        input: ExecJsonRpcClientSpecV1,
        options?: ExecRunOptionsV1,
    ): Promise<ExecClientHandleV1<JsonRpcClientV1>>;
    async function spawnClient(
        input: ExecJsonStreamClientSpecV1,
        options?: ExecRunOptionsV1,
    ): Promise<ExecClientHandleV1<JsonStreamClientV1>>;
    async function spawnClient(
        input: ExecFramedBytesClientSpecV1,
        options?: ExecRunOptionsV1,
    ): Promise<ExecClientHandleV1<FramedBytesClientV1>>;
    async function spawnClient(
        input: ExecClientSpecV1,
        options?: ExecRunOptionsV1,
    ): Promise<ExecClientHandleV1<ExecProtocolClientV1>> {
        if (!isClientSpec(input)) {
            throw new PluginExecClientError(
                'PLUGIN_EXEC_CLIENT_PROTOCOL_ERROR',
                'spawnClient requires an object-shaped ExecClientSpecV1 with an explicit protocol',
            );
        }
        validateExecClientSpec(input);
        const rpcLogger = createExecClientRpcLogger(input.lifecycle?.diagnostics, {
            allowedDirectories: params.rpcLogAllowedDirectories,
        });
        const spawned = createSpawnedPluginProcess(input.launch, {
            ...options,
            maxStderrBytes: input.lifecycle?.maxStderrBytes ?? options?.maxStderrBytes,
        }, params, systemToolGrantStore, input.lifecycle?.diagnostics?.sanitizer);
        let status: 'running' | 'exited' | 'disposed' = 'running';
        let disposePromise: Promise<void> | null = null;
        const exitListeners = new Set<(result: ExecRunResultV1) => void>();
        const protocolClient = createProtocolClientForSpec(input, spawned, rpcLogger);
        spawned.handle.exit.then((result) => {
            if (status !== 'disposed') {
                status = 'exited';
            }
            settleProtocolExitAfterStdoutDrain(spawned, protocolClient, new PluginExecClientError(
                'PLUGIN_EXEC_CLIENT_EXITED',
                'Plugin exec client process exited',
                { stderrPreview: spawned.readStderrPreview() },
            ));
            for (const listener of exitListeners) {
                listener(result);
            }
            void rpcLogger.flush();
        }, (error) => {
            if (status !== 'disposed') {
                status = 'exited';
            }
            const exitError = error instanceof Error ? error : new Error(String(error));
            protocolClient.settleExit(exitError);
            const result: ExecRunResultV1 = Object.freeze({
                exitCode: null,
                signal: null,
                stdout: '',
                stderr: sanitizeExecDiagnosticText(
                    spawned.readStderrPreview() || exitError.message,
                    input.lifecycle?.maxStderrBytes ?? options?.maxStderrBytes ?? 4096,
                    input.lifecycle?.diagnostics?.sanitizer,
                ),
            });
            for (const listener of exitListeners) {
                listener(result);
            }
            void rpcLogger.flush();
        });
        const handle: ExecClientHandleV1<ExecProtocolClientV1> = Object.freeze({
            client: protocolClient.client,
            process: spawned.handle,
            get status() {
                return status;
            },
            onExit(listener) {
                exitListeners.add(listener);
                return () => {
                    exitListeners.delete(listener);
                };
            },
            async dispose(reason?: ExecClientDisposeReasonV1) {
                if (disposePromise) {
                    await disposePromise;
                    return;
                }
                disposePromise = (async () => {
                    status = 'disposed';
                    protocolClient.dispose(createExecClientDisposeError(reason, spawned.readStderrPreview()));
                    await spawned.handle.dispose();
                    await rpcLogger.flush();
                })();
                await disposePromise;
            },
        });
        params.addDisposable?.(handle);
        return handle;
    }

    const service: ExecRuntimeServiceV1 = Object.freeze({
        systemTools,
        run,
        spawn,
        spawnClient,
    });
    return service;
}
