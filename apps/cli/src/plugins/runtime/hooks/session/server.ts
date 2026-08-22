import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

import {
    SESSION_PROVIDER_HOOK_EVENT_ID_V1,
    SessionProviderHookEventPayloadV1Schema,
} from '@happier-dev/protocol';
import { AgentRuntimeJsonValueV1Schema } from '@happier-dev/protocol/runtime';
import type { JsonValue } from '@happier-dev/plugin-sdk';
import {
    AGENT_EXTERNAL_SESSION_HOOK_LIMITS,
} from '@happier-dev/plugin-sdk/sessions/external';

import { logger } from '@/ui/logger';

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
    closed: Promise<void>;
}>;

export type SessionHookEventIdentity = Readonly<{
    providerId: string;
    sessionId: string;
}>;

export const QUALIFIED_EXTERNAL_SESSION_HOOK_PATH =
    '/hook/qualified-external-session';

export type QualifiedExternalSessionHookRequest = Readonly<{
    token: string;
    eventId: string;
    observedAtMs: number;
    forwardingStartedAtMs: number;
    nativePayload: JsonValue;
    signal: AbortSignal;
}>;

export type QualifiedExternalSessionHookResponse =
    | Readonly<{ state: 'admitted'; facts: number }>
    | Readonly<{ state: 'linked'; sessionId: string; created: boolean }>
    | Readonly<{ state: 'ignored' | 'rejected' }>;

export type StartSessionHookServerOptions = Readonly<{
    requestedPort?: number;
    session?: SessionHookEventIdentity | (() => SessionHookEventIdentity | null);
    onSessionHook?: (providerSessionId: string, data: SessionHookPayload) => void | Promise<void>;
    onPermissionHook?: (data: PermissionHookPayload) => unknown | Promise<unknown>;
    /**
     * Claude statusline payloads pushed by the statusline forwarder wrapper. The endpoint is
     * authenticated with the session hook secret, responds 200 BEFORE the consumer runs, and
     * swallows consumer errors — a broken consumer must never delay or break the status bar.
     */
    onStatuslineUpdate?: (data: StatuslineHookPayload) => void | Promise<void>;
    defaultPermissionHookResponse?: (data: PermissionHookPayload) => unknown | Promise<unknown>;
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
    permissionRequestTimeoutMsForTool?: (
        toolName: string | null,
    ) => number | null | undefined | Promise<number | null | undefined>;
    requestReadTimeoutMs?: number;
    publishHostEvent?: (name: string, payload?: unknown) => Promise<void>;
    onQualifiedExternalSessionHook?: (
        request: QualifiedExternalSessionHookRequest,
    ) => Promise<QualifiedExternalSessionHookResponse>;
}>;

const DEFAULT_PERMISSION_REQUEST_TIMEOUT_MS = 10 * 60 * 1000;
const HOOK_REQUEST_READ_TIMEOUT_MS = 5_000;
const PERSISTED_PORT_TAKEOVER_RETRY_DELAY_MS = 100;
const PERSISTED_PORT_TAKEOVER_MAX_RETRIES = 20;
const MAX_HOOK_REQUEST_BODY_BYTES = 1024 * 1024;
const MAX_QUALIFIED_EXTERNAL_SESSION_HOOK_REQUEST_BODY_BYTES =
    AGENT_EXTERNAL_SESSION_HOOK_LIMITS.maxJsonUtf8Bytes;
const REDACTED_HOOK_PATH = '[redacted-path]';
const hookRequestBodyTooLargeErrors = new WeakSet<object>();

function createHookRequestBodyTooLargeError(): Error {
    const error = new Error('hook request body exceeded maximum size');
    hookRequestBodyTooLargeErrors.add(error);
    return error;
}

function isHookRequestBodyTooLargeError(error: unknown): boolean {
    return typeof error === 'object'
        && error !== null
        && hookRequestBodyTooLargeErrors.has(error);
}

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
async function resolveEffectivePermissionRequestTimeoutMs(
    options: StartSessionHookServerOptions,
    toolName: string | null,
): Promise<number | null> {
    let perTool: number | null | undefined;
    try {
        perTool = await options.permissionRequestTimeoutMsForTool?.(toolName);
    } catch {
        logger.debug('[sessionHookServer] Failed to resolve per-tool permission timeout');
    }
    if (perTool === null) return null;
    if (typeof perTool === 'number' && Number.isFinite(perTool) && perTool > 0) {
        return perTool;
    }
    return resolvePermissionRequestTimeoutMs(options);
}

async function resolveDefaultPermissionHookResponse(
    options: StartSessionHookServerOptions,
    data: PermissionHookPayload,
): Promise<unknown> {
    try {
        return await options.defaultPermissionHookResponse?.(data)
            ?? { continue: true, suppressOutput: true };
    } catch {
        logger.debug('[sessionHookServer] Failed to resolve default permission response');
        return { continue: true, suppressOutput: true };
    }
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
    maxBytes: number = MAX_HOOK_REQUEST_BODY_BYTES,
): Promise<{ bodyLength: number; data: TPayload }> {
    const chunks: Buffer[] = [];
    let bodyLength = 0;
    for await (const chunk of req) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        bodyLength += buffer.length;
        if (bodyLength > maxBytes) {
            throw createHookRequestBodyTooLargeError();
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
    } catch {
        logger.debug('[sessionHookServer] Failed to parse hook data as JSON');
    }
    return { bodyLength, data: {} as TPayload };
}

function readQualifiedExternalSessionHookBody(
    data: Readonly<Record<string, unknown>>,
): Omit<QualifiedExternalSessionHookRequest, 'token' | 'signal'> | null {
    const keys = Object.keys(data);
    if (
        keys.length !== 4
        || !keys.every((key) => [
            'eventId',
            'observedAtMs',
            'forwardingStartedAtMs',
            'nativePayload',
        ].includes(key))
        || typeof data.eventId !== 'string'
        || data.eventId.trim().length === 0
        || !Number.isSafeInteger(data.observedAtMs)
        || Number(data.observedAtMs) < 0
        || !Number.isSafeInteger(data.forwardingStartedAtMs)
        || Number(data.forwardingStartedAtMs) < 0
    ) {
        return null;
    }
    const nativePayload = AgentRuntimeJsonValueV1Schema.safeParse(
        data.nativePayload,
    );
    if (!nativePayload.success) return null;
    return {
        eventId: data.eventId.trim(),
        observedAtMs: Number(data.observedAtMs),
        forwardingStartedAtMs: Number(data.forwardingStartedAtMs),
        nativePayload: nativePayload.data as JsonValue,
    };
}

async function handleQualifiedExternalSessionHook(
    req: IncomingMessage,
    res: ServerResponse,
    options: StartSessionHookServerOptions,
): Promise<void> {
    const handler = options.onQualifiedExternalSessionHook;
    const header = req.headers['x-happier-hook-secret'];
    const token = readString(Array.isArray(header) ? header[0] : header);
    if (!handler || !token) {
        res.writeHead(403).end('forbidden');
        return;
    }

    try {
        const read = await readJsonRequestBody<Record<string, unknown>>(
            req,
            MAX_QUALIFIED_EXTERNAL_SESSION_HOOK_REQUEST_BODY_BYTES,
        );
        const body = readQualifiedExternalSessionHookBody(read.data);
        const receivedAtMs = Date.now();
        if (
            !body
            || body.forwardingStartedAtMs > receivedAtMs
            || body.forwardingStartedAtMs
                + AGENT_EXTERNAL_SESSION_HOOK_LIMITS.totalHookDeadlineMs
                <= receivedAtMs
        ) {
            res.writeHead(400).end('invalid request');
            return;
        }

        const controller = new AbortController();
        let resolveTerminal!: () => void;
        const terminal = new Promise<void>((resolve) => {
            resolveTerminal = resolve;
        });
        const abort = () => {
            if (controller.signal.aborted) return;
            controller.abort();
            resolveTerminal();
        };
        const onResponseClose = () => {
            if (!res.writableEnded) abort();
        };
        req.once('aborted', abort);
        res.once('close', onResponseClose);
        const deadline = setTimeout(
            abort,
            Math.max(
                0,
                body.forwardingStartedAtMs
                    + AGENT_EXTERNAL_SESSION_HOOK_LIMITS.totalHookDeadlineMs
                    - Date.now(),
            ),
        );
        deadline.unref?.();
        try {
            const settled = Promise.resolve().then(
                async () => await handler({
                    ...body,
                    token,
                    signal: controller.signal,
                }),
            );
            const outcome = await Promise.race([
                settled.then((value) => ({ kind: 'settled' as const, value })),
                terminal.then(() => ({ kind: 'aborted' as const })),
            ]);
            if (
                outcome.kind === 'aborted'
                || controller.signal.aborted
                || res.destroyed
            ) {
                return;
            }
            if (outcome.value.state === 'rejected') {
                res.writeHead(403).end('forbidden');
                return;
            }
            res.writeHead(200, { 'Content-Type': 'text/plain' }).end('ok');
        } finally {
            clearTimeout(deadline);
            req.removeListener('aborted', abort);
            res.removeListener('close', onResponseClose);
        }
    } catch (error) {
        logger.debug(
            '[sessionHookServer] Qualified External Session hook request failed',
        );
        if (!res.headersSent && !res.destroyed) {
            const status = isHookRequestBodyTooLargeError(error) ? 413 : 400;
            res.writeHead(status).end(
                status === 413 ? 'payload too large' : 'invalid request',
            );
        }
    }
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
    await params.options.publishHostEvent?.(SESSION_PROVIDER_HOOK_EVENT_ID_V1, payload);
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
            hasProviderSessionId: providerSessionId !== null,
            transcriptPath: redactProviderPath(data.transcript_path ?? data.transcriptPath),
            cwd: redactProviderPath(data.cwd),
            hasHookEventName:
                readString(data.hook_event_name) !== null
                || readString(data.hookEventName) !== null,
            hasSource: readString(data.source) !== null,
            bodyLength,
        });

        if (providerSessionId) {
            await publishSessionHookEvent({ options, providerSessionId, data });
            try {
                await options.onSessionHook?.(providerSessionId, data);
            } catch {
                logger.debug('[sessionHookServer] Session hook callback failed after event publication');
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
        logger.debug('[sessionHookServer] Error handling session hook');
        if (!res.headersSent) {
            const status = isHookRequestBodyTooLargeError(error) ? 413 : 500;
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
    const armResponseTimeout = async (toolName: string | null): Promise<void> => {
        const effectiveTimeoutMs = await resolveEffectivePermissionRequestTimeoutMs(options, toolName);
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

        await armResponseTimeout(readString(data.tool_name) ?? readString(data.toolName));

        logger.debug('[sessionHookServer] Received permission hook', {
            providerId: resolveSessionIdentity(options)?.providerId ?? null,
            sessionId: resolveSessionIdentity(options)?.sessionId ?? null,
            hasProviderSessionId: readProviderSessionId(data) !== null,
            cwd: redactProviderPath(data.cwd),
            hasHookEventName:
                readString(data.hook_event_name) !== null
                || readString(data.hookEventName) !== null,
            hasPermissionMode:
                readString(data.permission_mode) !== null
                || readString(data.permissionMode) !== null,
            hasToolName:
                readString(data.tool_name) !== null
                || readString(data.toolName) !== null,
            hasToolUseId:
                readString(data.tool_use_id) !== null
                || readString(data.toolUseId) !== null,
            transcriptPath: redactProviderPath(data.transcript_path ?? data.transcriptPath),
            bodyLength: read.bodyLength,
        });

        const response = options.onPermissionHook
            ? await options.onPermissionHook(data)
            : await resolveDefaultPermissionHookResponse(options, data);

        if (responseTimeout) clearTimeout(responseTimeout);
        if (!res.headersSent) writeJson(res, response);
    } catch {
        clearTimeout(readTimeout);
        if (responseTimeout) clearTimeout(responseTimeout);
        if (readTimedOut) return;
        logger.debug('[sessionHookServer] Error handling permission hook');
        if (!res.headersSent) {
            writeJson(res, await resolveDefaultPermissionHookResponse(options, data));
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
            hasProviderSessionId: readProviderSessionId(data) !== null,
            transcriptPath: redactProviderPath(data.transcript_path),
            bodyLength,
        });

        try {
            await options.onStatuslineUpdate?.(data);
        } catch {
            logger.debug('[sessionHookServer] Statusline hook consumer failed');
        }
    } catch (error) {
        clearTimeout(readTimeout);
        if (readTimedOut) return;
        logger.debug('[sessionHookServer] Error handling statusline hook');
        if (!res.headersSent) {
            const status = isHookRequestBodyTooLargeError(error) ? 413 : 500;
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
            if (
                req.method === 'POST'
                && req.url === QUALIFIED_EXTERNAL_SESSION_HOOK_PATH
            ) {
                void handleQualifiedExternalSessionHook(req, res, options);
                return;
            }
            res.writeHead(404).end('not found');
        });

        server.listen(options.requestedPort ?? 0, '127.0.0.1', () => {
            const address = server.address();
            if (!address || typeof address === 'string') {
                reject(new Error('Failed to get session hook server address'));
                return;
            }
            logger.debug(`[sessionHookServer] Started on port ${address.port}`);
            let stopped = false;
            let resolveClosed!: () => void;
            const closed = new Promise<void>((resolveClosedPromise) => {
                resolveClosed = resolveClosedPromise;
            });
            resolve({
                port: address.port,
                closed,
                stop: () => {
                    if (stopped) return;
                    stopped = true;
                    server.close((error) => {
                        if (error) {
                            logger.debug('[sessionHookServer] Error stopping server');
                        }
                        resolveClosed();
                    });
                    logger.debug('[sessionHookServer] Stopped');
                },
            });
        });

        server.on('error', (error) => {
            logger.debug('[sessionHookServer] Server error');
            reject(error);
        });
    });
}

function isAddressInUseError(error: unknown): boolean {
    return (error as NodeJS.ErrnoException)?.code === 'EADDRINUSE';
}

async function waitForPersistedPortRelease(): Promise<void> {
    await new Promise<void>((resolveDelay) => {
        setTimeout(resolveDelay, PERSISTED_PORT_TAKEOVER_RETRY_DELAY_MS);
    });
}

/**
 * Allows a bounded predecessor handoff only when a caller deliberately reuses
 * a persisted port. Ephemeral listeners and all other failures keep the base
 * server's immediate-failure contract.
 */
export async function startSessionHookServerWithPersistedPortTakeover(
    options: StartSessionHookServerOptions,
): Promise<SessionHookServerHandle> {
    let attempt = 0;
    while (true) {
        try {
            return await startSessionHookServer(options);
        } catch (error) {
            if (
                options.requestedPort === undefined
                || !isAddressInUseError(error)
                || attempt >= PERSISTED_PORT_TAKEOVER_MAX_RETRIES
            ) {
                throw error;
            }
            attempt += 1;
            await waitForPersistedPortRelease();
        }
    }
}
