import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { JsonValue } from '@happier-dev/plugin-sdk';
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

import { parseCodexCliStableVersion } from '../../cli/detect.js';
import { readCodexAppServerRequestTimeoutMs, readCodexAppServerRpcTimeoutMs } from './client/timeout.js';
import { isCodexRealtimeConversationCliVersionSupported } from './realtimeSupport.js';

type CodexAppServerEnv = Readonly<Record<string, string | undefined>>;

type JsonRpcRequestHandler = (params: unknown, message: Readonly<{ id?: unknown }>) => Promise<unknown> | unknown;
type JsonRpcNotificationHandler = (params: unknown) => Promise<void> | void;

export type CodexAppServerRequestOptions = Readonly<{
    timeoutMs?: number;
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
        codexCliVersion: string | null;
        realtimeConversationVersionSupported: boolean;
    }>;
    onExit: (listener: (result: Readonly<{
        exitCode: number | null;
        signal: string | null;
    }>) => void) => () => void;
    dispose: () => Promise<void>;
}>;

export function isCodexAppServerOversizedJsonFrameError(error: unknown): boolean {
    if (!error || typeof error !== 'object') return false;
    const record = error as Readonly<{ code?: unknown; message?: unknown }>;
    return record.code === 'PLUGIN_EXEC_CLIENT_PROTOCOL_ERROR'
        && typeof record.message === 'string'
        && record.message.includes('JSON-RPC frame exceeded the configured size limit');
}

const CODEX_APP_SERVER_ARGS = ['app-server', '--listen', 'stdio://'] as const;
const CODEX_REALTIME_CONVERSATION_FEATURE = 'realtime_conversation';
const CODEX_REALTIME_ENABLED_LAUNCH_UNAVAILABLE =
    'CODEX_REALTIME_ENABLED_LAUNCH_UNAVAILABLE';
const DEFAULT_JSON_LINE_MAX_CHARS = 32 * 1024 * 1024;
const CODEX_APP_SERVER_CLIENT_INFO = Object.freeze({
    name: 'happier_cli',
    title: 'Happier',
    version: '0.1.0',
});

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

export function resolveCodexHome(env: CodexAppServerEnv): string {
    const override = typeof env.CODEX_HOME === 'string'
        ? expandHomeDirPath(env.CODEX_HOME, env)
        : '';
    return override || join(resolveHomeDirFromEnvironment(env), '.codex');
}

function resolveCodexConfigTomlPath(env: CodexAppServerEnv): string {
    return join(resolveCodexHome(env), 'config.toml');
}

function normalizeCodexMcpServerKeyFromConfigSection(raw: string): string | null {
    const trimmed = raw.trim();
    if (!trimmed) return null;

    const firstChar = trimmed[0];
    if (firstChar === '"' || firstChar === "'") {
        const end = trimmed.indexOf(firstChar, 1);
        if (end === -1) return null;
        return trimmed.slice(0, end + 1);
    }

    const firstSegment = trimmed.split('.')[0]?.trim() ?? '';
    return firstSegment ? firstSegment : null;
}

function readCodexMcpServerKeysFromConfigToml(env: CodexAppServerEnv): string[] {
    let text: string;
    try {
        text = readFileSync(resolveCodexConfigTomlPath(env), 'utf8');
    } catch {
        return [];
    }

    const keys = new Set<string>();
    const re = /^\s*\[mcp_servers\.([^\]]+)\]\s*$/gm;
    for (;;) {
        const match = re.exec(text);
        if (!match) break;
        const key = normalizeCodexMcpServerKeyFromConfigSection(match[1] ?? '');
        if (key) keys.add(key);
    }
    return Array.from(keys).sort((left, right) => left.localeCompare(right));
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

function buildCodexAppServerEnv(env: CodexAppServerEnv): Record<string, string> {
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

function buildCodexAppServerArgs(params: Readonly<{
    env: CodexAppServerEnv;
    configOverrides?: readonly string[];
    disableUserMcpServers?: boolean;
    enableRealtimeConversation?: boolean;
}>): string[] {
    const userMcpOverrides = params.disableUserMcpServers === true
        ? readCodexMcpServerKeysFromConfigToml(params.env).map((key) => `mcp_servers.${key}.enabled=false`)
        : [];
    return appendConfigOverrides([
        ...CODEX_APP_SERVER_ARGS,
        ...(params.enableRealtimeConversation
            ? ['--enable', CODEX_REALTIME_CONVERSATION_FEATURE]
            : []),
    ], [
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

function readCodexCliVersion(result: PluginProcessResult): string | null {
    if (
        !processExitedSuccessfully(result)
        || result.stdoutTruncated
        || result.stderrTruncated
    ) return null;
    const output = new TextDecoder().decode(result.stdout).trim();
    const parsed = parseCodexCliStableVersion(output);
    return parsed && output === `codex-cli ${parsed.value}` ? parsed.value : null;
}

async function probeCodexCliVersion(params: Readonly<{
    exec: ExecService;
    executable: ManagedExecutableRef;
    env: CodexAppServerEnv;
    signal?: AbortSignal;
}>): Promise<string | null> {
    try {
        const request = {
            executable: params.executable,
            args: ['--version'],
            cwd: { root: 'workspace', relativePath: '' },
            env: buildCodexAppServerEnv(params.env),
            timeoutMs: readCodexAppServerRpcTimeoutMs(params.env),
        } as const;
        const result = params.signal
            ? await params.exec.run(request, { signal: params.signal })
            : await params.exec.run(request);
        return readCodexCliVersion(result);
    } catch (error) {
        if (params.signal?.aborted) throw error;
        return null;
    }
}

async function probeCodexRealtimeConversationFeature(params: Readonly<{
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
    handle: PluginProtocolClientHandle<'jsonRpc'>,
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
        for (const handler of [...handlers]) await handler(message.params);
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
            return await handle.client.request(
                method,
                toJsonValue(requestParams),
                { timeoutMs: options?.timeoutMs ?? readCodexAppServerRequestTimeoutMs(method, env) },
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
}>) {
    return {
        kind: 'jsonRpc' as const,
        launch: {
            executable: params.executable,
            args: buildCodexAppServerArgs(params),
            cwd: { root: 'workspace' as const, relativePath: '' },
            env: buildCodexAppServerEnv(params.env),
        },
        framing: 'jsonLines' as const,
        maxFrameBytes: readJsonLineMaxChars(params.env),
        requestTimeoutMs: readCodexAppServerRpcTimeoutMs(params.env),
    };
}

export async function createCodexNativeAppServerClient(params: Readonly<{
    exec: ExecService;
    processEnv?: CodexAppServerEnv;
    cwd?: string;
    configOverrides?: readonly string[];
    disableUserMcpServers?: boolean;
    signal?: AbortSignal;
}>): Promise<DisposableCodexAppServerClient> {
    const env = params.processEnv ?? process.env;
    const resolvedSystemTool = await params.exec.systemTools.resolve({
        toolId: 'codex-cli',
        purpose: 'Launch the Codex native app-server',
    });
    const codexCliVersion = await probeCodexCliVersion({
        exec: params.exec,
        executable: resolvedSystemTool.executable,
        env,
        ...(params.signal ? { signal: params.signal } : {}),
    });
    const realtimeConversationVersionSupported =
        isCodexRealtimeConversationCliVersionSupported(codexCliVersion);
    const realtimeConversationAdvertised = await probeCodexRealtimeConversationFeature({
        exec: params.exec,
        executable: resolvedSystemTool.executable,
        env,
        ...(params.signal ? { signal: params.signal } : {}),
    });
    const enableRealtimeConversation =
        realtimeConversationVersionSupported && realtimeConversationAdvertised;
    let handle: PluginProtocolClientHandle<'jsonRpc'>;
    try {
        handle = await params.exec.clients.spawn(buildNativeCodexAppServerClientSpec({
            executable: resolvedSystemTool.executable,
            env,
            configOverrides: params.configOverrides,
            disableUserMcpServers: params.disableUserMcpServers,
            enableRealtimeConversation,
        }), params.signal ? { signal: params.signal } : undefined) as PluginProtocolClientHandle<'jsonRpc'>;
    } catch (error) {
        if (params.signal?.aborted || !enableRealtimeConversation) throw error;
        throw createCodexRealtimeEnabledAppServerLaunchUnavailableError();
    }
    const client = wrapNativeCodexAppServerClient(handle, env, {
        realtimeConversationAdvertised,
        codexCliVersion,
        realtimeConversationVersionSupported,
    });
    try {
        await client.request('initialize', {
            clientInfo: CODEX_APP_SERVER_CLIENT_INFO,
            capabilities: { experimentalApi: true },
        });
        await client.notify('initialized');
        return client;
    } catch (error) {
        await client.dispose().catch(() => undefined);
        if (params.signal?.aborted || !enableRealtimeConversation) throw error;
        throw createCodexRealtimeEnabledAppServerLaunchUnavailableError();
    }
}
