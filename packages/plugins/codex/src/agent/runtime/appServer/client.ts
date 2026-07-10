import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

import type {
    ExecClientHandleV1,
    ExecClientLifecycleV1,
    ExecClientSpecV1,
    ExecJsonRpcClientSpecV1,
    ExecRuntimeServiceV1,
    JsonRpcClientV1,
    JsonRpcNotificationHandlerV1,
    JsonRpcRequestHandlerV1,
} from '@happier-dev/plugin-sdk';
import { expandHomePath, readTrimmedString as readString } from '@happier-dev/plugin-sdk/experimental/sessions/fileStores';

import { readCodexAppServerRequestTimeoutMs, readCodexAppServerRpcTimeoutMs } from './client/timeout.js';

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
const DEFAULT_JSON_LINE_MAX_CHARS = 32 * 1024 * 1024;
const DEFAULT_RPC_LOG_MAX_BYTES = 10 * 1024 * 1024;
const DEFAULT_RPC_LOG_ROTATE_COUNT = 2;
const MAX_RPC_LOG_ROTATE_COUNT = 10;
const CODEX_APP_SERVER_CLIENT_INFO = Object.freeze({
    name: 'happier_cli',
    title: 'Happier',
    version: '0.1.0',
});

const CODEX_APP_SERVER_BINARY_OVERRIDE_ENV_KEYS = [
    'HAPPIER_CODEX_APP_SERVER_BIN',
    'HAPPIER_CODEX_TUI_BIN',
    'HAPPY_CODEX_TUI_BIN',
] as const;

const CODEX_APP_SERVER_RUNTIME_ONLY_ENV_KEYS = new Set([
    'CODEX_THREAD_ID',
    'CODEX_INTERNAL_ORIGINATOR_OVERRIDE',
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

function readRpcLogMaxBytes(env: CodexAppServerEnv): number {
    return readPositiveInteger(env.HAPPIER_CODEX_APP_SERVER_RPC_LOG_MAX_BYTES, DEFAULT_RPC_LOG_MAX_BYTES);
}

function readRpcLogRotateCount(env: CodexAppServerEnv): number {
    return Math.min(
        readPositiveInteger(env.HAPPIER_CODEX_APP_SERVER_RPC_LOG_ROTATE_COUNT, DEFAULT_RPC_LOG_ROTATE_COUNT),
        MAX_RPC_LOG_ROTATE_COUNT,
    );
}

function resolveHomeDirFromEnvironment(env: CodexAppServerEnv): string {
    return readString(env.HOME) ?? readString(env.USERPROFILE) ?? homedir();
}

function expandHomeDirPath(value: string, env: CodexAppServerEnv): string {
    const trimmed = value.trim();
    if (!trimmed) return '';
    return expandHomePath(trimmed, resolveHomeDirFromEnvironment(env));
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

function resolveRpcLogPath(env: CodexAppServerEnv): string | null {
    const raw = typeof env.HAPPIER_CODEX_APP_SERVER_RPC_LOG_PATH === 'string'
        ? env.HAPPIER_CODEX_APP_SERVER_RPC_LOG_PATH.trim()
        : '';
    return raw ? resolve(expandHomeDirPath(raw, env)) : null;
}

function buildCodexAppServerArgs(params: Readonly<{
    env: CodexAppServerEnv;
    configOverrides?: readonly string[];
    disableUserMcpServers?: boolean;
}>): string[] {
    const userMcpOverrides = params.disableUserMcpServers === true
        ? readCodexMcpServerKeysFromConfigToml(params.env).map((key) => `mcp_servers.${key}.enabled=false`)
        : [];
    return appendConfigOverrides(CODEX_APP_SERVER_ARGS, [
        ...userMcpOverrides,
        ...(params.configOverrides ?? []),
    ]);
}

function buildCodexAppServerDiagnostics(env: CodexAppServerEnv): ExecClientLifecycleV1 {
    const rpcLogPath = resolveRpcLogPath(env);
    return {
        requestTimeoutMs: readCodexAppServerRpcTimeoutMs(env),
        maxStderrBytes: 8_000,
        ...(rpcLogPath
            ? {
                diagnostics: {
                    rpcLog: {
                        kind: 'file' as const,
                        path: rpcLogPath,
                        maxBytes: readRpcLogMaxBytes(env),
                        rotateCount: readRpcLogRotateCount(env),
                    },
                    sanitizer: {
                        sensitiveKeys: ['id'],
                    },
                },
            }
            : {}),
    };
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

function buildCodexAppServerClientSpec(params: Readonly<{
    cwd?: string;
    env: CodexAppServerEnv;
    configOverrides?: readonly string[];
    disableUserMcpServers?: boolean;
}>): ExecJsonRpcClientSpecV1 {
    return {
        launch: {
            kind: 'agent-cli',
            agentId: 'codex',
            cwd: params.cwd,
            args: buildCodexAppServerArgs(params),
            env: buildCodexAppServerEnv(params.env),
        },
        transport: {
            kind: 'stdio',
            framing: { kind: 'strict-lf-json' },
            encoding: 'utf8',
            maxFrameBytes: readJsonLineMaxChars(params.env),
        },
        protocol: { kind: 'json-rpc-2.0' },
        lifecycle: buildCodexAppServerDiagnostics(params.env),
    };
}

function wrapCodexAppServerClient(
    handle: ExecClientHandleV1<JsonRpcClientV1>,
    env: CodexAppServerEnv,
): DisposableCodexAppServerClient {
    const requestHandlerUnregisters = new Map<string, () => void>();
    const notificationHandlerSets = new Map<string, {
        handlers: Set<JsonRpcNotificationHandler>;
        unregister: () => void;
    }>();

    const request = async (
        method: string,
        requestParams?: unknown,
        options?: CodexAppServerRequestOptions,
    ): Promise<unknown> => {
        return await handle.client.request(
            method,
            createCircularSafeJsonClone(requestParams),
            { timeoutMs: options?.timeoutMs ?? readCodexAppServerRequestTimeoutMs(method, env) },
        );
    };

    const notify = async (method: string, notificationParams?: unknown): Promise<void> => {
        await handle.client.notify(method, createCircularSafeJsonClone(notificationParams));
    };

    const registerRequestHandler = (method: string, handler: JsonRpcRequestHandler): (() => void) => {
        requestHandlerUnregisters.get(method)?.();
        const unregister = handle.client.registerRequestHandler(method, async (params, context) => {
            const result = await handler(params, { id: context?.requestId });
            return result === undefined ? null : result;
        });
        requestHandlerUnregisters.set(method, unregister);
        return () => {
            if (requestHandlerUnregisters.get(method) === unregister) {
                requestHandlerUnregisters.delete(method);
                unregister();
            }
        };
    };

    const registerNotificationHandler = (method: string, handler: JsonRpcNotificationHandler): (() => void) => {
        const existing = notificationHandlerSets.get(method);
        if (existing) {
            existing.handlers.add(handler);
        } else {
            const handlers = new Set<JsonRpcNotificationHandler>([handler]);
            const unregister = handle.client.registerNotificationHandler(method, async (params) => {
                for (const current of [...handlers]) {
                    await current(params);
                }
            });
            notificationHandlerSets.set(method, { handlers, unregister });
        }

        return () => {
            const entry = notificationHandlerSets.get(method);
            if (!entry) return;
            entry.handlers.delete(handler);
            if (entry.handlers.size === 0) {
                notificationHandlerSets.delete(method);
                entry.unregister();
            }
        };
    };

    const dispose = async (): Promise<void> => {
        requestHandlerUnregisters.clear();
        notificationHandlerSets.clear();
        await handle.dispose({
            code: 'CODEX_APP_SERVER_CLIENT_DISPOSED',
            message: 'Codex app-server client has been disposed',
        });
    };

    return { request, notify, registerRequestHandler, registerNotificationHandler, dispose };
}

export async function createCodexAppServerClient(params: Readonly<{
    exec: ExecRuntimeServiceV1;
    processEnv?: CodexAppServerEnv;
    cwd?: string;
    configOverrides?: readonly string[];
    disableUserMcpServers?: boolean;
    signal?: AbortSignal;
}>): Promise<DisposableCodexAppServerClient> {
    const env = params.processEnv ?? process.env;
    const handle = await params.exec.spawnClient(buildCodexAppServerClientSpec({
        cwd: params.cwd,
        env,
        configOverrides: params.configOverrides,
        disableUserMcpServers: params.disableUserMcpServers,
    }), params.signal ? { signal: params.signal } : undefined);
    const client = wrapCodexAppServerClient(handle, env);
    try {
        await client.request('initialize', {
            clientInfo: CODEX_APP_SERVER_CLIENT_INFO,
            capabilities: {
                experimentalApi: true,
            },
        });
        await client.notify('initialized');
        return client;
    } catch (error) {
        await client.dispose().catch(() => undefined);
        throw error;
    }
}
