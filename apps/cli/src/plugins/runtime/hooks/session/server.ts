import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

import {
    SESSION_PROVIDER_HOOK_EVENT_ID_V1,
    SessionProviderHookEventPayloadV1Schema,
} from '@happier-dev/protocol';

import { logger } from '@/ui/logger';
import { publishHostPluginEvent } from '../../context/events';

export type SessionHookPayload = Record<string, unknown> & Readonly<{
    session_id?: string;
    sessionId?: string;
    transcript_path?: string;
    transcriptPath?: string;
    cwd?: string;
    hook_event_name?: string;
    hookEventName?: string;
    source?: string;
}>;

export type PermissionHookPayload = Record<string, unknown> & Readonly<{
    session_id?: string;
    sessionId?: string;
    transcript_path?: string;
    transcriptPath?: string;
    cwd?: string;
    hook_event_name?: string;
    hookEventName?: string;
    permission_mode?: string;
    permissionMode?: string;
    tool_name?: string;
    toolName?: string;
    tool_input?: unknown;
    toolInput?: unknown;
    tool_use_id?: string;
    toolUseId?: string;
}>;

export type StatuslineHookPayload = Record<string, unknown> & Readonly<{
    session_id?: string;
    transcript_path?: string;
    cwd?: string;
    version?: string;
    model?: Readonly<Record<string, unknown>>;
    context_window?: Readonly<Record<string, unknown>>;
}>;

export type SessionHookServerHandle = Readonly<{
    port: number;
    stop: () => void;
}>;

export type SessionHookEventIdentity = Readonly<{
    providerId: string;
    sessionId: string;
}>;

export type StartSessionHookServerOptions = Readonly<{
    session?: SessionHookEventIdentity | (() => SessionHookEventIdentity | null);
    onSessionHook?: (providerSessionId: string, data: SessionHookPayload) => void | Promise<void>;
    onPermissionHook?: (data: PermissionHookPayload) => unknown | Promise<unknown>;
    /**
     * Claude statusline payloads pushed by the statusline forwarder wrapper. The endpoint is
     * authenticated with the session hook secret, responds 200 BEFORE the consumer runs, and
     * swallows consumer errors — a broken consumer must never delay or break the status bar.
     */
    onStatuslineUpdate?: (data: StatuslineHookPayload) => void | Promise<void>;
    defaultPermissionHookResponse?: (data: PermissionHookPayload) => unknown;
    sessionHookSecret?: string;
    permissionHookSecret?: string;
    permissionRequestTimeoutMs?: number | null;
    /**
     * Optional per-tool override for the permission-response timeout. Resolved after the hook
     * body is read so the tool name is known. Returning `null` means no Happier-imposed timeout
     * (the wait is bounded only by Claude's finite provider hook timeout) — used for interactive
     * tools such as AskUserQuestion/ExitPlanMode. Returning a number sets that timeout; returning
     * `undefined` falls back to `permissionRequestTimeoutMs` / the default cap.
     */
    permissionRequestTimeoutMsForTool?: (toolName: string | null) => number | null | undefined;
    requestReadTimeoutMs?: number;
    publishHostEvent?: (name: string, payload?: unknown) => Promise<void>;
}>;

const DEFAULT_PERMISSION_REQUEST_TIMEOUT_MS = 10 * 60 * 1000;
const HOOK_REQUEST_READ_TIMEOUT_MS = 5_000;
const MAX_HOOK_REQUEST_BODY_BYTES = 1024 * 1024;
const REDACTED_HOOK_PATH = '[redacted-path]';

function readString(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
}

function redactProviderPath(value: unknown): string | null {
    return readString(value) ? REDACTED_HOOK_PATH : null;
}

function readProviderSessionId(data: SessionHookPayload | PermissionHookPayload): string | null {
    return readString(data.session_id) ?? readString(data.sessionId);
}

function readHookEventName(data: SessionHookPayload | PermissionHookPayload, fallback: string): string {
    return readString(data.hook_event_name) ?? readString(data.hookEventName) ?? fallback;
}

function resolvePermissionRequestTimeoutMs(options: StartSessionHookServerOptions): number | null {
    if (options.permissionRequestTimeoutMs === null) {
        return null;
    }
    if (
        typeof options.permissionRequestTimeoutMs === 'number'
        && Number.isFinite(options.permissionRequestTimeoutMs)
        && options.permissionRequestTimeoutMs > 0
    ) {
        return options.permissionRequestTimeoutMs;
    }
    return DEFAULT_PERMISSION_REQUEST_TIMEOUT_MS;
}

// Resolves the effective permission-response timeout for a specific tool. A per-tool resolver
// wins when it returns a concrete value (number or explicit null); when it returns `undefined`
// the global/default cap applies. This keeps interactive tools (which return null) honest about
// having no Happier-imposed timeout while non-interactive tools stay bounded.
function resolveEffectivePermissionRequestTimeoutMs(
    options: StartSessionHookServerOptions,
    toolName: string | null,
): number | null {
    const perTool = options.permissionRequestTimeoutMsForTool?.(toolName);
    if (perTool === null) return null;
    if (typeof perTool === 'number' && Number.isFinite(perTool) && perTool > 0) {
        return perTool;
    }
    return resolvePermissionRequestTimeoutMs(options);
}

function resolveHookRequestReadTimeoutMs(options: StartSessionHookServerOptions): number {
    if (
        typeof options.requestReadTimeoutMs === 'number'
        && Number.isFinite(options.requestReadTimeoutMs)
        && options.requestReadTimeoutMs > 0
    ) {
        return Math.trunc(options.requestReadTimeoutMs);
    }
    return HOOK_REQUEST_READ_TIMEOUT_MS;
}

function resolveSessionIdentity(options: StartSessionHookServerOptions): SessionHookEventIdentity | null {
    if (!options.session) return null;
    return typeof options.session === 'function' ? options.session() : options.session;
}

function hasValidHookSecret(req: IncomingMessage, expectedSecret: string): boolean {
    const providedSecret = req.headers['x-happier-hook-secret'];
    const providedSecretValue = Array.isArray(providedSecret) ? providedSecret[0] : providedSecret;
    return providedSecretValue === expectedSecret;
}

async function readJsonRequestBody<TPayload extends Record<string, unknown>>(
    req: IncomingMessage,
): Promise<{ bodyLength: number; data: TPayload }> {
    const chunks: Buffer[] = [];
    let bodyLength = 0;
    for await (const chunk of req) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        bodyLength += buffer.length;
        if (bodyLength > MAX_HOOK_REQUEST_BODY_BYTES) {
            throw new Error('hook request body exceeded maximum size');
        }
        chunks.push(buffer);
    }

    const body = Buffer.concat(chunks).toString('utf-8');
    if (!body.trim()) {
        return { bodyLength, data: {} as TPayload };
    }

    try {
        const parsed = JSON.parse(body) as unknown;
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            return { bodyLength, data: parsed as TPayload };
        }
    } catch (parseError) {
        logger.debug('[sessionHookServer] Failed to parse hook data as JSON:', parseError);
    }
    return { bodyLength, data: {} as TPayload };
}

async function publishSessionHookEvent(params: Readonly<{
    options: StartSessionHookServerOptions;
    providerSessionId: string;
    data: SessionHookPayload;
}>): Promise<void> {
    const session = resolveSessionIdentity(params.options);
    if (!session) return;
    const eventName = readHookEventName(params.data, 'SessionStart');
    const payload = SessionProviderHookEventPayloadV1Schema.parse({
        providerId: session.providerId,
        sessionId: session.sessionId,
        providerSessionId: params.providerSessionId,
        eventName,
        providerPayload: params.data,
    });
    await (params.options.publishHostEvent ?? publishHostPluginEvent)(
        SESSION_PROVIDER_HOOK_EVENT_ID_V1,
        payload,
    );
}

function writeJson(res: ServerResponse, value: unknown): void {
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(value));
}

async function handleSessionHook(
    req: IncomingMessage,
    res: ServerResponse,
    options: StartSessionHookServerOptions,
): Promise<void> {
    const expectedSecret = readString(options.sessionHookSecret);
    if (expectedSecret && !hasValidHookSecret(req, expectedSecret)) {
        logger.debug('[sessionHookServer] Forbidden session hook request (secret mismatch)');
        res.writeHead(403).end('forbidden');
        return;
    }

    let readTimedOut = false;
    const readTimeout = setTimeout(() => {
        readTimedOut = true;
        if (!res.headersSent) {
            logger.debug('[sessionHookServer] Session hook request read timeout');
            res.writeHead(408).end('timeout');
        }
        req.destroy();
    }, resolveHookRequestReadTimeoutMs(options));
    readTimeout.unref?.();

    try {
        const { bodyLength, data } = await readJsonRequestBody<SessionHookPayload>(req);
        clearTimeout(readTimeout);
        if (readTimedOut || res.headersSent) return;

        const providerSessionId = readProviderSessionId(data);
        logger.debug('[sessionHookServer] Received session hook', {
            providerId: resolveSessionIdentity(options)?.providerId ?? null,
            sessionId: resolveSessionIdentity(options)?.sessionId ?? null,
            providerSessionId,
            transcriptPath: redactProviderPath(data.transcript_path ?? data.transcriptPath),
            cwd: redactProviderPath(data.cwd),
            hookEventName: readHookEventName(data, 'SessionStart'),
            source: data.source,
            bodyLength,
        });

        if (providerSessionId) {
            await publishSessionHookEvent({ options, providerSessionId, data });
            try {
                await options.onSessionHook?.(providerSessionId, data);
            } catch (callbackError) {
                logger.debug('[sessionHookServer] Session hook callback failed after event publication:', callbackError);
            }
        } else {
            logger.debug('[sessionHookServer] Session hook received but no provider session id was found');
        }

        if (!res.headersSent) {
            res.writeHead(200, { 'Content-Type': 'text/plain' }).end('ok');
        }
    } catch (error) {
        clearTimeout(readTimeout);
        if (readTimedOut) return;
        logger.debug('[sessionHookServer] Error handling session hook:', error);
        if (!res.headersSent) {
            const status = error instanceof Error && error.message.includes('maximum size') ? 413 : 500;
            res.writeHead(status).end(status === 413 ? 'payload too large' : 'error');
        }
    }
}

async function handlePermissionHook(
    req: IncomingMessage,
    res: ServerResponse,
    options: StartSessionHookServerOptions,
): Promise<void> {
    const expectedSecret = readString(options.permissionHookSecret);
    if (expectedSecret && !hasValidHookSecret(req, expectedSecret)) {
        logger.debug('[sessionHookServer] Forbidden permission hook request (secret mismatch)');
        res.writeHead(403).end('forbidden');
        return;
    }

    // The response timeout is created after the body is read so the per-tool resolver can see
    // the tool name. The read itself is bounded by the separate read timeout below.
    let responseTimeout: ReturnType<typeof setTimeout> | null = null;
    const armResponseTimeout = (toolName: string | null): void => {
        const effectiveTimeoutMs = resolveEffectivePermissionRequestTimeoutMs(options, toolName);
        if (effectiveTimeoutMs === null) return;
        responseTimeout = setTimeout(() => {
            if (!res.headersSent) {
                logger.debug('[sessionHookServer] Permission hook request timeout');
                res.writeHead(408).end('timeout');
            }
        }, effectiveTimeoutMs);
        responseTimeout.unref?.();
    };

    let readTimedOut = false;
    const readTimeout = setTimeout(() => {
        readTimedOut = true;
        if (!res.headersSent) {
            logger.debug('[sessionHookServer] Permission hook request read timeout');
            res.writeHead(408).end('timeout');
        }
        req.destroy();
    }, resolveHookRequestReadTimeoutMs(options));
    readTimeout.unref?.();
    let data: PermissionHookPayload = {};

    try {
        const read = await readJsonRequestBody<PermissionHookPayload>(req);
        clearTimeout(readTimeout);
        if (readTimedOut || res.headersSent) return;
        data = read.data;

        armResponseTimeout(readString(data.tool_name) ?? readString(data.toolName));

        logger.debug('[sessionHookServer] Received permission hook', {
            providerId: resolveSessionIdentity(options)?.providerId ?? null,
            sessionId: resolveSessionIdentity(options)?.sessionId ?? null,
            providerSessionId: readProviderSessionId(data),
            cwd: redactProviderPath(data.cwd),
            hookEventName: readHookEventName(data, 'PermissionRequest'),
            permissionMode: data.permission_mode || data.permissionMode,
            toolName: data.tool_name || data.toolName,
            toolUseId: data.tool_use_id || data.toolUseId,
            transcriptPath: redactProviderPath(data.transcript_path ?? data.transcriptPath),
            bodyLength: read.bodyLength,
        });

        const response = options.onPermissionHook
            ? await options.onPermissionHook(data)
            : options.defaultPermissionHookResponse?.(data) ?? { continue: true, suppressOutput: true };

        if (responseTimeout) clearTimeout(responseTimeout);
        if (!res.headersSent) writeJson(res, response);
    } catch (error) {
        clearTimeout(readTimeout);
        if (responseTimeout) clearTimeout(responseTimeout);
        if (readTimedOut) return;
        logger.debug('[sessionHookServer] Error handling permission hook:', error);
        if (!res.headersSent) {
            writeJson(res, options.defaultPermissionHookResponse?.(data) ?? { continue: true, suppressOutput: true });
        }
    }
}

async function handleStatuslineHook(
    req: IncomingMessage,
    res: ServerResponse,
    options: StartSessionHookServerOptions,
): Promise<void> {
    const expectedSecret = readString(options.sessionHookSecret);
    if (expectedSecret && !hasValidHookSecret(req, expectedSecret)) {
        logger.debug('[sessionHookServer] Forbidden statusline hook request (secret mismatch)');
        res.writeHead(403).end('forbidden');
        return;
    }

    let readTimedOut = false;
    const readTimeout = setTimeout(() => {
        readTimedOut = true;
        if (!res.headersSent) {
            logger.debug('[sessionHookServer] Statusline hook request read timeout');
            res.writeHead(408).end('timeout');
        }
        req.destroy();
    }, resolveHookRequestReadTimeoutMs(options));
    readTimeout.unref?.();

    try {
        const { bodyLength, data } = await readJsonRequestBody<StatuslineHookPayload>(req);
        clearTimeout(readTimeout);
        if (readTimedOut || res.headersSent) return;

        // Respond BEFORE the consumer runs: the forwarder (and thus Claude's status bar render)
        // must never wait on Happier-side processing.
        res.writeHead(200, { 'Content-Type': 'text/plain' }).end('ok');

        // readJsonRequestBody yields `{}` for malformed/empty bodies; a keyless payload carries
        // no statusline facts either way, so the consumer is only invoked for real objects.
        if (Object.keys(data).length === 0) {
            if (bodyLength > 0) {
                logger.debug('[sessionHookServer] Ignoring malformed statusline hook payload', { bodyLength });
            }
            return;
        }

        logger.debug('[sessionHookServer] Received statusline hook', {
            providerId: resolveSessionIdentity(options)?.providerId ?? null,
            sessionId: resolveSessionIdentity(options)?.sessionId ?? null,
            providerSessionId: readProviderSessionId(data),
            transcriptPath: redactProviderPath(data.transcript_path),
            bodyLength,
        });

        try {
            await options.onStatuslineUpdate?.(data);
        } catch (callbackError) {
            logger.debug('[sessionHookServer] Statusline hook consumer failed:', callbackError);
        }
    } catch (error) {
        clearTimeout(readTimeout);
        if (readTimedOut) return;
        logger.debug('[sessionHookServer] Error handling statusline hook:', error);
        if (!res.headersSent) {
            const status = error instanceof Error && error.message.includes('maximum size') ? 413 : 500;
            res.writeHead(status).end(status === 413 ? 'payload too large' : 'error');
        }
    }
}

export async function startSessionHookServer(
    options: StartSessionHookServerOptions,
): Promise<SessionHookServerHandle> {
    return await new Promise((resolve, reject) => {
        const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
            if (req.method === 'POST' && req.url === '/hook/session-start') {
                void handleSessionHook(req, res, options);
                return;
            }
            if (req.method === 'POST' && req.url === '/hook/permission-request') {
                void handlePermissionHook(req, res, options);
                return;
            }
            if (req.method === 'POST' && req.url === '/hook/statusline') {
                void handleStatuslineHook(req, res, options);
                return;
            }
            res.writeHead(404).end('not found');
        });

        server.listen(0, '127.0.0.1', () => {
            const address = server.address();
            if (!address || typeof address === 'string') {
                reject(new Error('Failed to get session hook server address'));
                return;
            }
            logger.debug(`[sessionHookServer] Started on port ${address.port}`);
            let stopped = false;
            resolve({
                port: address.port,
                stop: () => {
                    if (stopped) return;
                    stopped = true;
                    server.close((error) => {
                        if (error) {
                            logger.debug('[sessionHookServer] Error stopping server:', error);
                        }
                    });
                    logger.debug('[sessionHookServer] Stopped');
                },
            });
        });

        server.on('error', (error) => {
            logger.debug('[sessionHookServer] Server error:', error);
            reject(error);
        });
    });
}
