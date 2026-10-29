import { PluginError, type JsonValue, type LoggerService } from '@happier-dev/plugin-sdk';
import type {
    ManagedExecutableRef } from '@happier-dev/plugin-sdk/managed-services';
import type {
    ExecService,
    PluginProcessResult } from '@happier-dev/plugin-sdk/exec';
import type {
    PluginProtocolClientHandle,
} from '@happier-dev/plugin-sdk/exec/protocol-clients';
import {
    expandHomePath,
    resolveHomeDirFromEnvironment,
} from '@happier-dev/plugin-sdk/fs';

import { readCodexAppServerRequestTimeoutMs, readCodexAppServerRpcTimeoutMs } from './client/timeout.js';
import {
    buildCodexAppServerBaseArgs,
    CODEX_REALTIME_CONVERSATION_FEATURE,
    initializeCodexAppServerClient,
} from './connection.js';
import { connectCodexUnixWebSocketJsonRpc } from './client/unixWebSocket.js';
import { withCodexNativeStartupLock } from './nativeStartupLock.js';
import { readCodexMcpServerKeysFromConfigToml } from '../../mcp/configServers.js';
import {
    CODEX_SUPPORTED_RUNTIME_VERSION,
    CODEX_TOOL_RESTRICTION_RUNTIME_REMEDY,
} from '../../cli/supportedRuntime.js';
export { resolveCodexHome } from '../../mcp/configServers.js';

type CodexAppServerEnv = Readonly<Record<string, string | undefined>>;
type AgentNativeLaunchQualifier = NonNullable<NonNullable<Parameters<ExecService['spawn']>[1]>['nativeLaunch']>;

export type CodexAppServerTransport =
    | Readonly<{ kind: 'stdio' }>
    | Readonly<{ kind: 'daemonProxy' }>
    | Readonly<{
        kind: 'unixWebSocket';
        socketPath: string;
        realtimeConversationAdvertised: boolean;
    }>;

type JsonRpcRequestHandler = (params: unknown, message: Readonly<{ id?: unknown }>) => Promise<unknown> | unknown;
type JsonRpcNotificationHandler = (params: unknown) => Promise<void> | void;

export type CodexAppServerRequestOptions = Readonly<{
    signal?: AbortSignal;
    timeoutMs?: number | null;
}>;

export type CodexAppServerClient = Readonly<{
    request: (method: string, params?: unknown, options?: CodexAppServerRequestOptions) => Promise<unknown>;
    notify: (method: string, params?: unknown) => Promise<void>;
    registerRequestHandler: (method: string, handler: JsonRpcRequestHandler) => () => void;
    registerNotificationHandler: (method: string, handler: JsonRpcNotificationHandler) => () => void;
}>;

export type DisposableCodexAppServerClient = CodexAppServerClient & Readonly<{
    launchFeatures: Readonly<{
        realtimeConversationAdvertised: boolean;
        toolRestrictionSupportedModelIds?: readonly string[];
    }>;
    onExit: (listener: (result: Readonly<{
        exitCode: number | null;
        signal: string | null;
    }>) => void) => () => void;
    dispose: () => Promise<void>;
}>;

export function assertCodexToolRestrictionModelSupported(
    client: DisposableCodexAppServerClient,
    modelId: string | null,
): void {
    if (!modelId || !client.launchFeatures.toolRestrictionSupportedModelIds?.includes(modelId)) {
        throw new PluginError({
            code: 'codex_tool_restriction_unsupported_model',
            message: 'Codex MCP confinement requires a native model advertising code-mode-only tools.',
        });
    }
}

export function isCodexAppServerOversizedJsonFrameError(error: unknown): boolean {
    if (!error || typeof error !== 'object') return false;
    const record = error as Readonly<{ code?: unknown; message?: unknown }>;
    return record.code === 'PLUGIN_EXEC_CLIENT_PROTOCOL_ERROR'
        && typeof record.message === 'string'
        && record.message.includes('JSON-RPC frame exceeded the configured size limit');
}

const CODEX_REALTIME_ENABLED_LAUNCH_UNAVAILABLE =
    'CODEX_REALTIME_ENABLED_LAUNCH_UNAVAILABLE';
// A resume response can carry the complete Codex thread. Preserve the established
// 0.2 app-server boundary instead of introducing a lower plugin-only rejection cap.
const DEFAULT_JSON_LINE_MAX_CHARS = 128 * 1024 * 1024;

export function isCodexRealtimeEnabledAppServerLaunchUnavailableError(
    error: unknown,
): boolean {
    return Boolean(
        error
        && typeof error === 'object'
        && (error as Readonly<{ code?: unknown }>).code
            === CODEX_REALTIME_ENABLED_LAUNCH_UNAVAILABLE,
    );
}

function createCodexRealtimeEnabledAppServerLaunchUnavailableError(): Error {
    const error = new Error('The realtime-enabled Codex app-server launch was unavailable.');
    Object.defineProperty(error, 'code', {
        value: CODEX_REALTIME_ENABLED_LAUNCH_UNAVAILABLE,
        enumerable: true,
    });
    return error;
}

const CODEX_APP_SERVER_BINARY_OVERRIDE_ENV_KEYS = [
    'HAPPIER_CODEX_APP_SERVER_BIN',
    'HAPPIER_CODEX_TUI_BIN',
    'HAPPY_CODEX_TUI_BIN',
] as const;

const CODEX_APP_SERVER_RUNTIME_ONLY_ENV_KEYS = new Set([
    'CODEX_THREAD_ID',
    'CODEX_INTERNAL_ORIGINATOR_OVERRIDE',
    'HAPPIER_CODEX_APP_SERVER_RPC_TIMEOUT_MS',
    'HAPPIER_CODEX_APP_SERVER_RPC_LOG_PATH',
    'HAPPIER_CODEX_APP_SERVER_RPC_LOG_MAX_BYTES',
    'HAPPIER_CODEX_APP_SERVER_RPC_LOG_ROTATE_COUNT',
    'HAPPIER_CONNECTED_SERVICE_SELECTIONS_JSON',
    'HAPPIER_CONNECTED_SERVICE_MATERIALIZED_ENV_KEYS_JSON',
    'HAPPIER_SPAWN_EXPLICIT_ENV_KEYS_JSON',
]);

function readPositiveInteger(value: unknown, fallback: number): number {
    const parsed = Number.parseInt(String(value ?? ''), 10);
    return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : fallback;
}

function readJsonLineMaxChars(env: CodexAppServerEnv): number {
    return readPositiveInteger(env.HAPPIER_CODEX_APP_SERVER_MAX_JSON_LINE_CHARS, DEFAULT_JSON_LINE_MAX_CHARS);
}

function expandHomeDirPath(value: string, env: CodexAppServerEnv): string {
    return expandHomePath(value, resolveHomeDirFromEnvironment(env));
}

function appendConfigOverrides(args: readonly string[], overrides: readonly string[]): string[] {
    if (overrides.length === 0) return [...args];
    return [
        ...args,
        ...overrides.flatMap((override) => ['-c', override]),
    ];
}

function resolveCodexAppServerBinaryOverride(env: CodexAppServerEnv): string | null {
    for (const key of CODEX_APP_SERVER_BINARY_OVERRIDE_ENV_KEYS) {
        const raw = typeof env[key] === 'string' ? env[key]?.trim() : '';
        if (raw) return expandHomeDirPath(raw, env);
    }
    return null;
}

export function buildCodexAppServerEnv(env: CodexAppServerEnv): Record<string, string> {
    const output: Record<string, string> = {};
    for (const [key, value] of Object.entries(env)) {
        if (typeof value !== 'string') continue;
        if (CODEX_APP_SERVER_RUNTIME_ONLY_ENV_KEYS.has(key)) continue;
        output[key] = value;
    }

    const appServerOverride = resolveCodexAppServerBinaryOverride(env);
    if (appServerOverride) {
        output.HAPPIER_CODEX_PATH = appServerOverride;
    }
    return output;
}

export function buildCodexAppServerArgs(params: Readonly<{
    env: CodexAppServerEnv;
    configOverrides?: readonly string[];
    disableUserMcpServers?: boolean;
    enableRealtimeConversation?: boolean;
    listenUrl?: string;
    transport?: CodexAppServerTransport;
}>): string[] {
    if (params.transport?.kind === 'daemonProxy') {
        return ['app-server', 'proxy'];
    }
    const userMcpOverrides = params.disableUserMcpServers === true
        ? readCodexMcpServerKeysFromConfigToml(params.env).map((key) => `mcp_servers.${key}.enabled=false`)
        : [];
    return appendConfigOverrides(buildCodexAppServerBaseArgs(
        params.enableRealtimeConversation === true,
        params.listenUrl,
    ), [
        ...userMcpOverrides,
        ...(params.configOverrides ?? []),
    ]);
}

function processExitedSuccessfully(result: PluginProcessResult): boolean {
    return result.termination.requestedBy.kind === 'none'
        && result.termination.observed.kind === 'exit'
        && result.termination.observed.exitCode === 0;
}

function advertisesRealtimeConversation(result: PluginProcessResult): boolean {
    if (
        !processExitedSuccessfully(result)
        || result.stdoutTruncated
        || result.stderrTruncated
    ) return false;
    const stdout = new TextDecoder().decode(result.stdout);
    return stdout
        .split(/\r?\n/u)
        .some((line) => line.trimStart().startsWith(`${CODEX_REALTIME_CONVERSATION_FEATURE} `));
}

export async function probeCodexRealtimeConversationFeature(params: Readonly<{
    exec: ExecService;
    executable: ManagedExecutableRef;
    env: CodexAppServerEnv;
    signal?: AbortSignal;
}>): Promise<boolean> {
    try {
        const request = {
            executable: params.executable,
            args: ['features', 'list'],
            cwd: { root: 'workspace', relativePath: '' },
            env: buildCodexAppServerEnv(params.env),
            timeoutMs: readCodexAppServerRpcTimeoutMs(params.env),
        } as const;
        const result = params.signal
            ? await params.exec.run(request, { signal: params.signal })
            : await params.exec.run(request);
        return advertisesRealtimeConversation(result);
    } catch (error) {
        if (params.signal?.aborted) throw error;
        return false;
    }
}

function createCircularSafeJsonClone(value: unknown): unknown {
    if (value === undefined) return {};
    const seen = new WeakSet<object>();
    return JSON.parse(JSON.stringify(value, (_key, child) => {
        if (typeof child !== 'object' || child === null) return child;
        if (seen.has(child)) return '[Circular]';
        seen.add(child);
        return child;
    })) as unknown;
}

function toJsonValue(value: unknown): JsonValue {
    return createCircularSafeJsonClone(value) as JsonValue;
}

function toNativeExit(result: PluginProcessResult): Readonly<{
    exitCode: number | null;
    signal: string | null;
}> {
    if (result.termination.observed.kind === 'exit') {
        return { exitCode: result.termination.observed.exitCode, signal: null };
    }
    if (result.termination.observed.kind === 'signal') {
        return { exitCode: null, signal: result.termination.observed.signal };
    }
    return { exitCode: null, signal: null };
}

function wrapNativeCodexAppServerClient(
    handle: Pick<PluginProtocolClientHandle<'jsonRpc'>, 'client' | 'wait' | 'dispose'>,
    env: CodexAppServerEnv,
    launchFeatures: DisposableCodexAppServerClient['launchFeatures'],
): DisposableCodexAppServerClient {
    const requestHandlerDisposables = new Map<string, { dispose(): void }>();
    const notificationHandlers = new Map<string, Set<JsonRpcNotificationHandler>>();
    const exitListeners = new Set<(result: Readonly<{ exitCode: number | null; signal: string | null }>) => void>();
    let settledExit: Readonly<{ exitCode: number | null; signal: string | null }> | null = null;

    const notificationSubscription = handle.client.onNotification(async (message) => {
        const handlers = notificationHandlers.get(message.method);
        if (!handlers) return;
        for (const handler of [...handlers]) {
            const completion = handler(message.params);
            // Synchronous observers must finish before the next notification can overtake them.
            if (completion !== undefined) await completion;
        }
    });
    void handle.wait().then((result) => {
        settledExit = toNativeExit(result);
        for (const listener of [...exitListeners]) listener(settledExit);
    }).catch(() => {
        settledExit = { exitCode: null, signal: null };
        for (const listener of [...exitListeners]) listener(settledExit);
    });

    return {
        launchFeatures,
        async request(method, requestParams, options) {
            const timeoutMs = options?.timeoutMs === null
                ? null
                : options?.timeoutMs ?? readCodexAppServerRequestTimeoutMs(method, env);
            return await handle.client.request(
                method,
                toJsonValue(requestParams),
                {
                    timeoutMs,
                    ...(options?.signal ? { signal: options.signal } : {}),
                },
            );
        },
        async notify(method, notificationParams) {
            if (notificationParams === undefined) {
                await handle.client.notify(method);
                return;
            }
            await handle.client.notify(method, toJsonValue(notificationParams));
        },
        registerRequestHandler(method, handler) {
            requestHandlerDisposables.get(method)?.dispose();
            const disposable = handle.client.onRequest(method, async (request) => {
                const result = await handler(request.params, { id: request.id });
                return result === undefined ? null : toJsonValue(result);
            });
            requestHandlerDisposables.set(method, disposable);
            return () => {
                if (requestHandlerDisposables.get(method) === disposable) {
                    requestHandlerDisposables.delete(method);
                    disposable.dispose();
                }
            };
        },
        registerNotificationHandler(method, handler) {
            const handlers = notificationHandlers.get(method) ?? new Set<JsonRpcNotificationHandler>();
            handlers.add(handler);
            notificationHandlers.set(method, handlers);
            return () => {
                handlers.delete(handler);
                if (handlers.size === 0) notificationHandlers.delete(method);
            };
        },
        onExit(listener) {
            if (settledExit) {
                queueMicrotask(() => listener(settledExit!));
                return () => undefined;
            }
            exitListeners.add(listener);
            return () => exitListeners.delete(listener);
        },
        async dispose() {
            for (const disposable of requestHandlerDisposables.values()) disposable.dispose();
            requestHandlerDisposables.clear();
            notificationHandlers.clear();
            notificationSubscription.dispose();
            exitListeners.clear();
            await handle.dispose();
        },
    };
}

function buildNativeCodexAppServerClientSpec(params: Readonly<{
    executable: ManagedExecutableRef;
    env: CodexAppServerEnv;
    configOverrides?: readonly string[];
    disableUserMcpServers?: boolean;
    enableRealtimeConversation?: boolean;
    transport?: CodexAppServerTransport;
}>) {
    return {
        kind: 'jsonRpc' as const,
        launch: {
            executable: params.executable,
            args: buildCodexAppServerArgs(params),
            cwd: { root: 'workspace' as const, relativePath: '' },
            env: buildCodexAppServerEnv(params.env),
        },
        framing: params.transport?.kind === 'daemonProxy' ? 'webSocket' as const : 'jsonLines' as const,
        maxFrameBytes: readJsonLineMaxChars(params.env),
        requestTimeoutMs: readCodexAppServerRpcTimeoutMs(params.env),
    };
}

type CodexNativeAppServerClientParams = Readonly<{
    exec: ExecService;
    logger?: Pick<LoggerService, 'debug'>;
    nativeLaunch?: AgentNativeLaunchQualifier;
    processEnv?: CodexAppServerEnv;
    cwd?: string;
    configOverrides?: readonly string[];
    disableUserMcpServers?: boolean;
    toolRestrictionRequired?: boolean;
    toolRestrictionAllowedMcpServerKeys?: readonly string[];
    signal?: AbortSignal;
    initializeRequestOptions?: CodexAppServerRequestOptions;
    /** Content-free control diagnostics distinguish transport creation from initialization. */
    onInitialize?: () => void;
    transport?: CodexAppServerTransport;
}>;

export async function createCodexNativeAppServerClient(params: CodexNativeAppServerClientParams): Promise<DisposableCodexAppServerClient> {
    if (params.transport && params.transport.kind !== 'stdio') {
        return await createUnlockedCodexNativeAppServerClient(params);
    }
    const env = params.processEnv ?? process.env;
    const resolvedSystemTool = await params.exec.systemTools.resolve({
        toolId: 'codex-cli', purpose: 'Launch the Codex native app-server',
    });
    const readVersion = async () => await params.exec.run({
        executable: resolvedSystemTool.executable,
        args: ['--version'], cwd: { root: 'workspace', relativePath: '' },
        env: buildCodexAppServerEnv(env),
        timeoutMs: readCodexAppServerRpcTimeoutMs(env),
    }, params.signal ? { signal: params.signal } : undefined).then(result =>
        processExitedSuccessfully(result) && !result.stdoutTruncated
            ? new TextDecoder().decode(result.stdout) : '',
    ).catch(error => { if (params.signal?.aborted) throw error; return ''; });
    return await withCodexNativeStartupLock(
        async configOverrides => await createUnlockedCodexNativeAppServerClient({ ...params, configOverrides }, resolvedSystemTool.executable),
        params.initializeRequestOptions?.signal ?? params.signal,
        params.logger,
        { processEnv: env, readVersion, configOverrides: params.configOverrides, cwd: params.cwd },
    );
}

async function createUnlockedCodexNativeAppServerClient(params: CodexNativeAppServerClientParams, executable?: ManagedExecutableRef): Promise<DisposableCodexAppServerClient> {
    const env = params.processEnv ?? process.env;
    const resolvedExecutable = executable ?? (await params.exec.systemTools.resolve({
        toolId: 'codex-cli',
        purpose: 'Launch the Codex native app-server',
    })).executable;
    const realtimeConversationAdvertised = params.transport?.kind === 'unixWebSocket'
        ? params.transport.realtimeConversationAdvertised
        : params.transport?.kind === 'daemonProxy'
          ? false
          : await probeCodexRealtimeConversationFeature({
            exec: params.exec,
            executable: resolvedExecutable,
            env,
            ...(params.signal ? { signal: params.signal } : {}),
        });
    const enableRealtimeConversation = params.transport?.kind !== 'unixWebSocket'
        && params.transport?.kind !== 'daemonProxy'
        && realtimeConversationAdvertised;
    let handle: Pick<PluginProtocolClientHandle<'jsonRpc'>, 'client' | 'wait' | 'dispose'>;
    try {
        handle = params.transport?.kind === 'unixWebSocket'
            ? await connectCodexUnixWebSocketJsonRpc({
                socketPath: params.transport.socketPath,
                maxFrameBytes: readJsonLineMaxChars(env),
                requestTimeoutMs: readCodexAppServerRpcTimeoutMs(env),
                ...(params.signal ? { signal: params.signal } : {}),
            })
            : await params.exec.clients.spawn(buildNativeCodexAppServerClientSpec({
                executable: resolvedExecutable,
                env,
                configOverrides: params.configOverrides,
                disableUserMcpServers: params.disableUserMcpServers,
                enableRealtimeConversation,
                transport: params.transport,
            }), params.signal || (params.nativeLaunch && params.transport?.kind !== 'daemonProxy') ? {
                ...(params.signal ? { signal: params.signal } : {}),
                ...(params.nativeLaunch && params.transport?.kind !== 'daemonProxy'
                    ? { nativeLaunch: params.nativeLaunch } : {}),
            } : undefined) as PluginProtocolClientHandle<'jsonRpc'>;
    } catch (error) {
        if (error instanceof PluginError) throw error;
        if (params.signal?.aborted || !enableRealtimeConversation) throw error;
        throw createCodexRealtimeEnabledAppServerLaunchUnavailableError();
    }
    const launchFeatures: { realtimeConversationAdvertised: boolean; toolRestrictionSupportedModelIds?: readonly string[] } = {
        realtimeConversationAdvertised,
    };
    const client = wrapNativeCodexAppServerClient(handle, env, launchFeatures);
    try {
        const initializeRequestOptions = params.initializeRequestOptions ?? (params.signal
            ? { signal: params.signal }
            : undefined);
        params.onInitialize?.();
        const initialized = await initializeCodexAppServerClient({
            request: async (method, requestParams) => await client.request(
                method,
                requestParams,
                initializeRequestOptions,
            ),
            notify: async (method) => await client.notify(method),
        });
        if (params.toolRestrictionRequired) {
            // The managed install's exact qualified release is the support basis.
            // Unknown versions fail closed because older binaries can echo ignored flags.
            const userAgent = initialized && typeof initialized === 'object'
                ? (initialized as Readonly<{ userAgent?: unknown }>).userAgent : null;
            const version = typeof userAgent === 'string'
                ? /\/(\d+\.\d+\.\d+)(?:\s|$)/u.exec(userAgent)?.[1] : null;
            if (version !== CODEX_SUPPORTED_RUNTIME_VERSION) {
                throw new PluginError({ code: 'codex_tool_restriction_unsupported_runtime', message: CODEX_TOOL_RESTRICTION_RUNTIME_REMEDY });
            }
            const effective = await client.request('config/read', { includeLayers: false, ...(params.cwd ? { cwd: params.cwd } : {}) });
            const config = effective && typeof effective === 'object' ? (effective as { config?: unknown }).config : null;
            const features = config && typeof config === 'object' ? (config as { features?: unknown }).features : null;
            const codeMode = features && typeof features === 'object' ? (features as { code_mode?: unknown }).code_mode : null;
            const excluded = codeMode && typeof codeMode === 'object' ? (codeMode as { excluded_tool_namespaces?: unknown }).excluded_tool_namespaces : null;
            if (!Array.isArray(excluded) || !excluded.includes('functions')) {
                throw new PluginError({ code: 'codex_tool_restriction_unsupported_runtime', message: 'Codex did not apply its native tool-namespace exclusion.' });
            }
            const mcpServers = config && typeof config === 'object' ? (config as { mcp_servers?: unknown }).mcp_servers : null;
            const allowedServerKeys = new Set(params.toolRestrictionAllowedMcpServerKeys ?? []);
            if (!mcpServers || typeof mcpServers !== 'object' || Array.isArray(mcpServers) || Object.entries(mcpServers).some(([key, value]) => (
                !allowedServerKeys.has(key) && (!value || typeof value !== 'object' || (value as { enabled?: unknown }).enabled !== false)
            ))) {
                throw new PluginError({ code: 'codex_tool_restriction_unsupported_runtime', message: 'Codex has enabled MCP servers outside the host-selected recipe.' });
            }
            const result = await params.exec.run({
                executable: resolvedExecutable,
                args: ['debug', 'models'],
                cwd: { root: 'workspace', relativePath: '' },
                env: buildCodexAppServerEnv(env),
                timeoutMs: readCodexAppServerRpcTimeoutMs(env),
            }, params.signal ? { signal: params.signal } : undefined);
            let models: unknown;
            if (processExitedSuccessfully(result) && result.stdoutTruncated === false && result.stderrTruncated === false) {
                try { models = (JSON.parse(new TextDecoder().decode(result.stdout)) as { models?: unknown }).models; } catch { /* Malformed native capability evidence is unsupported. */ }
            }
            if (!Array.isArray(models)) {
                throw new PluginError({ code: 'codex_tool_restriction_unsupported_runtime', message: 'Codex did not provide its native tool-mode catalog.' });
            }
            launchFeatures.toolRestrictionSupportedModelIds = models.flatMap((model: unknown) => {
                if (!model || typeof model !== 'object') return [];
                const entry = model as Readonly<{ slug?: unknown; tool_mode?: unknown }>;
                return typeof entry.slug === 'string' && entry.tool_mode === 'code_mode_only' ? [entry.slug] : [];
            });
        }
        return client;
    } catch (error) {
        await client.dispose().catch(() => undefined);
        if (error instanceof PluginError) throw error;
        if (params.signal?.aborted || !enableRealtimeConversation) throw error;
        throw createCodexRealtimeEnabledAppServerLaunchUnavailableError();
    }
}
