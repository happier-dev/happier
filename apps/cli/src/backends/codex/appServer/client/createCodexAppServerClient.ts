import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { resolveWindowsCommandInvocation } from '@happier-dev/cli-common/process';

import { resolveCodexCliInvocation } from '../../utils/resolveCodexCliInvocation';
import { appendCodexCliConfigOverridesArgs } from '../../utils/appendCodexCliConfigOverridesArgs';

type JsonRpcMessage = Readonly<{
    id?: number | string | null;
    method?: string;
    params?: unknown;
    result?: unknown;
    error?: Readonly<{ code?: number; message?: string }>;
}>;

type JsonRpcRequestHandler = (params: unknown) => Promise<unknown> | unknown;
type JsonRpcNotificationHandler = (params: unknown) => Promise<void> | void;

export type CodexAppServerClient = Readonly<{
    request: (method: string, params?: unknown) => Promise<unknown>;
    notify: (method: string, params?: unknown) => Promise<void>;
    registerRequestHandler: (method: string, handler: JsonRpcRequestHandler) => () => void;
    registerNotificationHandler: (method: string, handler: JsonRpcNotificationHandler) => () => void;
}>;

export type DisposableCodexAppServerClient = CodexAppServerClient & Readonly<{
    dispose: () => Promise<void>;
}>;

type MessageQueueState = {
    buffer: string;
    fatalError: Error | null;
};

type PendingRequest = Readonly<{
    method: string;
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
}>;

const STARTUP_RPC_METHODS = new Set(['thread/start', 'thread/resume']);

function clampRpcTimeoutMs(rawValue: unknown, fallbackMs: number, maxMs: number): number {
    const raw = Number.parseInt(String(rawValue ?? ''), 10);
    const configured = Number.isFinite(raw) && raw > 0 ? Math.trunc(raw) : fallbackMs;
    return Math.max(250, Math.min(maxMs, configured));
}

function readRpcTimeoutMs(env?: NodeJS.ProcessEnv): number {
    return clampRpcTimeoutMs(env?.HAPPIER_CODEX_APP_SERVER_RPC_TIMEOUT_MS, 5_000, 60_000);
}

function readStartupRpcTimeoutMs(env?: NodeJS.ProcessEnv, baseTimeoutMs?: number): number {
    const base = baseTimeoutMs ?? readRpcTimeoutMs(env);
    const configured = clampRpcTimeoutMs(env?.HAPPIER_CODEX_APP_SERVER_STARTUP_RPC_TIMEOUT_MS, 20_000, 120_000);
    return Math.max(base, configured);
}

function readRequestTimeoutMs(method: string, env?: NodeJS.ProcessEnv): number {
    const baseTimeoutMs = readRpcTimeoutMs(env);
    if (STARTUP_RPC_METHODS.has(method)) {
        return readStartupRpcTimeoutMs(env, baseTimeoutMs);
    }
    return baseTimeoutMs;
}

function failWaiters(state: MessageQueueState, error: Error): void {
    if (state.fatalError === null) {
        state.fatalError = error;
    }
}

function createJsonRpcError(message: string, code = -32000): Readonly<{ code: number; message: string }> {
    return { code, message };
}

function toMessageKey(id: number | string | null | undefined): string | null {
    if (id === null || id === undefined) return null;
    return `${typeof id}:${String(id)}`;
}

function createDisposedError(): Error {
    return new Error('Codex app-server client has been disposed');
}

function sanitizeCodexAppServerEnv(processEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
    return {
        ...processEnv,
        CODEX_THREAD_ID: undefined,
        CODEX_INTERNAL_ORIGINATOR_OVERRIDE: undefined,
    };
}

function resolveCodexConfigTomlPath(env: NodeJS.ProcessEnv): string {
    const codexHome = typeof env.CODEX_HOME === 'string' ? env.CODEX_HOME.trim() : '';
    if (codexHome) return join(codexHome, 'config.toml');
    return join(homedir(), '.codex', 'config.toml');
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

function readCodexMcpServerKeysFromConfigToml(env: NodeJS.ProcessEnv): string[] {
    const configPath = resolveCodexConfigTomlPath(env);
    let text: string;
    try {
        text = readFileSync(configPath, 'utf8');
    } catch {
        return [];
    }

    const keys = new Set<string>();
    const re = /^\s*\[mcp_servers\.([^\]]+)\]\s*$/gm;
    for (;;) {
        const match = re.exec(text);
        if (!match) break;
        const key = normalizeCodexMcpServerKeyFromConfigSection(match[1] ?? '');
        if (!key) continue;
        keys.add(key);
    }

    return Array.from(keys).sort((a, b) => a.localeCompare(b));
}

export async function createCodexAppServerClient(params: Readonly<{
    processEnv?: NodeJS.ProcessEnv;
    cwd?: string;
    configOverrides?: ReadonlyArray<string>;
    disableUserMcpServers?: boolean;
}>): Promise<DisposableCodexAppServerClient> {
    const processEnv = sanitizeCodexAppServerEnv(params.processEnv ?? process.env);
    const baseInvocation = await resolveCodexCliInvocation({
        args: ['app-server', '--listen', 'stdio://'],
        processEnv,
        overrideEnvVarKeys: ['HAPPIER_CODEX_APP_SERVER_BIN', 'HAPPIER_CODEX_TUI_BIN', 'HAPPY_CODEX_TUI_BIN'],
        targetLabel: 'Codex app-server',
    });

    const baseOverrides = params.disableUserMcpServers === true
        ? readCodexMcpServerKeysFromConfigToml(processEnv).map((key) => `mcp_servers.${key}.enabled=false`)
        : [];

    const invocation = appendCodexCliConfigOverridesArgs(baseInvocation, [...baseOverrides, ...(params.configOverrides ?? [])]);
    const windowsInvocation = resolveWindowsCommandInvocation({
        command: invocation.command,
        args: invocation.args,
        resolveCommandOnPath: true,
    });
    const child = spawn(windowsInvocation.command, windowsInvocation.args, {
        cwd: params.cwd ?? process.cwd(),
        env: processEnv,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        windowsVerbatimArguments: windowsInvocation.windowsVerbatimArguments,
    });

    if (!child.stdin || !child.stdout || !child.stderr) {
        throw new Error('Failed to start Codex app-server with piped stdio');
    }

    const state: MessageQueueState = {
        buffer: '',
        fatalError: null,
    };
    let stderrBuffer = '';
    const maxStderrChars = 8_000;
    const pendingRequests = new Map<string, PendingRequest>();
    const requestHandlers = new Map<string, JsonRpcRequestHandler>();
    const notificationHandlers = new Map<string, Set<JsonRpcNotificationHandler>>();
    let writeChain = Promise.resolve();
    let nextId = 0;
    let disposing = false;
    let disposePromise: Promise<void> | null = null;
    let resolveClosed: (() => void) | null = null;
    const closedPromise = new Promise<void>((resolve) => {
        resolveClosed = resolve;
    });

    const failPendingRequests = (error: Error): void => {
        for (const [requestKey, pending] of pendingRequests.entries()) {
            pendingRequests.delete(requestKey);
            pending.reject(error);
        }
    };

    const sendMessage = async (message: Record<string, unknown>): Promise<void> => {
        if (state.fatalError) {
            throw state.fatalError;
        }
        const payload = `${JSON.stringify(message)}\n`;
        const nextWrite = writeChain.then(async () => {
            const stdin = child.stdin;
            if (!stdin || stdin.writableEnded || stdin.destroyed) {
                throw state.fatalError ?? createDisposedError();
            }
            await new Promise<void>((resolve, reject) => {
                try {
                    stdin.write(payload, 'utf8', (error) => {
                        if (error) {
                            reject(error);
                            return;
                        }
                        resolve();
                    });
                } catch (error) {
                    reject(error);
                }
            });
        });
        writeChain = nextWrite.catch(() => undefined);
        await nextWrite;
    };

    const handleServerRequest = async (message: JsonRpcMessage): Promise<void> => {
        if (typeof message.method !== 'string') return;
        const requestKey = toMessageKey(message.id);
        if (!requestKey) return;
        const handler = requestHandlers.get(message.method);
        if (!handler) {
            await sendMessage({
                id: message.id,
                error: createJsonRpcError(`No handler registered for ${message.method}`, -32601),
            });
            return;
        }
        try {
            const result = await handler(message.params);
            await sendMessage({ id: message.id, result: result ?? null });
        } catch (error) {
            const failure = error instanceof Error ? error : new Error(String(error));
            await sendMessage({
                id: message.id,
                error: createJsonRpcError(failure.message),
            });
        }
    };

    const failWith = (error: unknown): void => {
        const failure = error instanceof Error ? error : new Error(String(error));
        failWaiters(state, failure);
        failPendingRequests(failure);
    };

    const handleIncomingMessage = (message: JsonRpcMessage): void => {
        const requestKey = toMessageKey(message.id);
        if (typeof message.method === 'string') {
            if (requestKey) {
                void handleServerRequest(message).catch((error) => {
                    failWith(error);
                });
                return;
            }
            const handlers = notificationHandlers.get(message.method);
            if (handlers && handlers.size > 0) {
                for (const handler of [...handlers]) {
                    try {
                        const result = handler(message.params);
                        if (result && typeof (result as PromiseLike<void>).then === 'function') {
                            void Promise.resolve(result).catch((error: unknown) => {
                                failWith(error);
                            });
                        }
                    } catch (error) {
                        failWith(error);
                    }
                }
            }
            return;
        }
        if (!requestKey) {
            return;
        }
        const pending = pendingRequests.get(requestKey);
        if (!pending) {
            return;
        }
        pendingRequests.delete(requestKey);
        if (message.error) {
            pending.reject(new Error(message.error.message ?? `Codex app-server request failed: ${pending.method}`));
            return;
        }
        pending.resolve(message.result);
    };

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
        state.buffer += chunk;
        while (true) {
            const newlineIndex = state.buffer.indexOf('\n');
            if (newlineIndex === -1) break;
            const rawLine = state.buffer.slice(0, newlineIndex).trim();
            state.buffer = state.buffer.slice(newlineIndex + 1);
            if (!rawLine) continue;
            try {
                handleIncomingMessage(JSON.parse(rawLine) as JsonRpcMessage);
            } catch (error) {
                failWith(new Error(`Invalid Codex app-server JSON output: ${error instanceof Error ? error.message : String(error)}`));
                return;
            }
        }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
        if (stderrBuffer.length >= maxStderrChars) return;
        stderrBuffer = (stderrBuffer + chunk).slice(0, maxStderrChars);
    });
    child.once('error', (error) => {
        failWith(new Error(`Failed to launch Codex app-server: ${error.message}`));
    });
    child.once('close', (code, signal) => {
        resolveClosed?.();
        if (disposing) {
            return;
        }
        const suffix = stderrBuffer.trim() ? `\n${stderrBuffer.trim()}` : '';
        failWith(new Error(`Codex app-server exited before completing the request (code=${code ?? 'null'} signal=${signal ?? 'null'})${suffix}`));
    });

    const request = async (method: string, requestParams?: unknown): Promise<unknown> => {
        const timeoutMs = readRequestTimeoutMs(method, processEnv);
        const id = ++nextId;
        const requestKey = toMessageKey(id);
        if (!requestKey) {
            throw new Error(`Failed to create Codex app-server request id for ${method}`);
        }
        const responsePromise = new Promise<unknown>((resolve, reject) => {
            const timer = setTimeout(() => {
                pendingRequests.delete(requestKey);
                reject(new Error(`Codex app-server request ${method} timed out after ${timeoutMs}ms`));
            }, timeoutMs);
            pendingRequests.set(requestKey, {
                method,
                resolve: (value) => {
                    clearTimeout(timer);
                    resolve(value);
                },
                reject: (error) => {
                    clearTimeout(timer);
                    reject(error);
                },
            });
        });
        try {
            await sendMessage({
                id,
                method,
                ...(requestParams !== undefined ? { params: requestParams } : {}),
            });
        } catch (error) {
            const failure = error instanceof Error ? error : new Error(String(error));
            const pending = pendingRequests.get(requestKey);
            pendingRequests.delete(requestKey);
            pending?.reject(failure);
        }
        return await responsePromise;
    };

    const notify = async (method: string, notificationParams?: unknown): Promise<void> => {
        await sendMessage({
            method,
            ...(notificationParams !== undefined ? { params: notificationParams } : {}),
        });
    };

    const registerRequestHandler = (method: string, handler: JsonRpcRequestHandler): (() => void) => {
        requestHandlers.set(method, handler);
        return () => {
            if (requestHandlers.get(method) === handler) {
                requestHandlers.delete(method);
            }
        };
    };

    const registerNotificationHandler = (method: string, handler: JsonRpcNotificationHandler): (() => void) => {
        const existing = notificationHandlers.get(method);
        if (existing) {
            existing.add(handler);
        } else {
            notificationHandlers.set(method, new Set([handler]));
        }
        return () => {
            const handlers = notificationHandlers.get(method);
            if (!handlers) return;
            handlers.delete(handler);
            if (handlers.size === 0) {
                notificationHandlers.delete(method);
            }
        };
    };

    const dispose = async (): Promise<void> => {
        if (disposePromise) {
            return await disposePromise;
        }
        disposing = true;
        const disposedError = createDisposedError();
        failWaiters(state, disposedError);
        failPendingRequests(disposedError);
        disposePromise = (async () => {
            try {
                child.stdin?.end();
            } catch {
                // ignore
            }
            try {
                child.kill();
            } catch {
                // ignore
            }
            await closedPromise;
        })();
        return await disposePromise;
    };

    try {
        await request('initialize', {
            clientInfo: {
                name: 'happier_cli',
                title: 'Happier',
                version: '0.1.0',
            },
            capabilities: {
                experimentalApi: true,
            },
        });
        await notify('initialized');

        return { request, notify, registerRequestHandler, registerNotificationHandler, dispose };
    } catch (error) {
        await dispose().catch(() => undefined);
        throw error;
    }
}
