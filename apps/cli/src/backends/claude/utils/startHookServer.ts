/**
 * Dedicated HTTP server for receiving Claude session hooks
 * 
 * This server receives notifications from Claude when sessions change
 * (new session, resume, compact, fork, etc.) via the SessionStart hook.
 * 
 * Separate from the MCP server to keep concerns isolated.
 * 
 * ## Control Flow
 * 
 * ### Startup
 * ```
 * runClaude.ts                                  
 *     │                                         
 *     ├─► startHookServer() ──► HTTP server on random port (e.g., 52290)
 *     │                                         
 *     ├─► generateHookSettingsFile(port) ──► ~/.happier/tmp/hooks/session-hook-<pid>.json
 *     │   (contains SessionStart hook pointing to our server)
 *     │                                         
 *     └─► loop() ──► claudeLocal/claudeRemote
 *             │
 *             └─► spawn claude --settings <hook-settings-path>
 * ```
 * 
 * ### Session Notification Flow
 * ```
 * Claude CLI (SessionStart event)
 *     │
 *     ├─► Reads hooks from --settings file
 *     │
 *     └─► Executes hook command (session_hook_forwarder.cjs)
 *             │
 *             ├─► Receives session data on stdin
 *             │
 *             └─► HTTP POST to http://127.0.0.1:<port>/hook/session-start
 *                     │
 *                     └─► startHookServer receives it
 *                             │
 *                             └─► onSessionHook(sessionId, data)
 *                                     │
 *                                     ├─► Updates Session.sessionId
 *                                     ├─► Updates API metadata
 *                                     └─► Notifies SessionScanner
 * ```
 * 
 * ### Triggered By
 * - `happier` (fresh start) - new session created
 * - `happier --continue` - continues last session (may fork)
 * - `happier --resume` - interactive picker, then resume
 * - `happier --resume <id>` - resume specific session
 * - `/compact` command - compacts and forks session
 * - Double-escape fork - user forks conversation in CLI
 * 
 * ### Why Not Use File Watching?
 * File watching has race conditions when multiple Happy processes run.
 * With hooks, Claude directly tells THIS specific process about its session,
 * ensuring 1:1 mapping between Happy process and Claude session.
 */

import { createServer, IncomingMessage, ServerResponse, Server } from 'node:http';
import { logger } from '@/ui/logger';
import { parseClaudeStatuslinePayload, type ClaudeStatuslinePayload } from '../statusline/statuslinePayload';

/**
 * Data received from Claude's SessionStart hook
 */
export interface SessionHookData {
    session_id?: string;
    sessionId?: string;
    transcript_path?: string;
    transcriptPath?: string;
    cwd?: string;
    hook_event_name?: string;
    hookEventName?: string;
    source?: string;
    [key: string]: unknown;
}

export interface PermissionHookData {
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
    [key: string]: unknown;
}

export interface PermissionHookResponse {
    continue: boolean;
    suppressOutput?: boolean;
    stopReason?: string;
    systemMessage?: string;
    hookSpecificOutput?: {
        hookEventName?: 'PermissionRequest' | 'PreToolUse';
        /**
         * Claude Code PermissionRequest hook expects a nested decision object:
         * https://docs.claude.com/en/docs/claude-code/hooks#permissionrequest-decision-control
         */
        decision?: {
            behavior: 'allow' | 'deny';
            message?: string;
            interrupt?: boolean;
            updatedInput?: unknown;
            updatedPermissions?: unknown;
        };
        /**
         * Claude Code PreToolUse hooks can satisfy native AskUserQuestion prompts
         * by returning an allow decision with updatedInput answers.
         */
        permissionDecision?: 'allow' | 'ask' | 'deny';
        updatedInput?: unknown;
        [key: string]: unknown;
    };
    [key: string]: unknown;
}

function readPermissionHookEventName(data: PermissionHookData): 'PermissionRequest' | 'PreToolUse' {
    const raw = data.hook_event_name ?? data.hookEventName;
    return raw === 'PreToolUse' ? 'PreToolUse' : 'PermissionRequest';
}

function buildDefaultPermissionHookResponse(data?: PermissionHookData): PermissionHookResponse {
    return {
        continue: true,
        suppressOutput: true,
        hookSpecificOutput: {
            hookEventName: data ? readPermissionHookEventName(data) : 'PermissionRequest',
        },
    };
}

export interface HookServerOptions {
    /** Called when a session hook is received with a valid session ID */
    onSessionHook: (sessionId: string, data: SessionHookData) => void;
    /** Called when a permission hook is received */
    onPermissionHook?: (data: PermissionHookData, options?: Readonly<{ signal?: AbortSignal }>) => PermissionHookResponse | Promise<PermissionHookResponse>;
    /**
     * Called when the statusline forwarder posts a Claude statusline payload.
     *
     * Always additive enrichment: the response is sent regardless of what the callback does,
     * and consumer errors never fail the request (the forwarder is fire-and-forget anyway).
     */
    onStatuslineUpdate?: (payload: ClaudeStatuslinePayload) => void;
    /** Shared secret required for permission hook requests */
    permissionHookSecret?: string;
    /**
     * Timeout for a single permission hook HTTP request.
     *
     * This must be long enough for a human to approve/deny from the UI; Claude Code hook
     * commands can run substantially longer than 5 seconds.
     *
     * Set to `null` to wait indefinitely (no terminal fallback).
     */
    permissionRequestTimeoutMs?: number | null;
    /**
     * When provided, bind this exact localhost port. Used by adopt-first recovery to re-own
     * hook commands baked into an already-running Claude TUI.
     */
    requestedPort?: number;
}

export interface HookServer {
    /** The port the server is listening on */
    port: number;
    /** Stop the server */
    stop: () => void;
}

/**
 * Start a dedicated HTTP server for receiving Claude session hooks
 * 
 * @param options - Server options including the session hook callback
 * @returns Promise resolving to the server instance with port info
 */
/**
 * Hard cap on buffered hook request bodies. Real hook payloads are small JSON envelopes
 * (well under 1 MB even with large tool inputs); anything bigger is malformed or hostile,
 * and buffering it unbounded would let any local process exhaust this server's memory.
 */
const MAX_HOOK_BODY_BYTES = 10 * 1024 * 1024;

async function readBoundedRequestBody(req: IncomingMessage): Promise<Buffer | null> {
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    for await (const chunk of req) {
        const buffer = chunk as Buffer;
        totalBytes += buffer.length;
        if (totalBytes > MAX_HOOK_BODY_BYTES) {
            return null;
        }
        chunks.push(buffer);
    }
    return Buffer.concat(chunks);
}

function rejectOversizedBody(req: IncomingMessage, res: ServerResponse): void {
    logger.debug('[hookServer] Rejected oversized hook body');
    if (!res.headersSent) {
        res.writeHead(413).end('payload too large');
    }
    req.destroy();
}

export async function startHookServer(options: HookServerOptions): Promise<HookServer> {
    const { onSessionHook, onPermissionHook, permissionHookSecret } = options;
    const resolvePermissionRequestTimeoutMs = (): number | null => {
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
        return 10 * 60 * 1000;
    };

    return new Promise((resolve, reject) => {
        const server: Server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
            // Only handle POST to /hook/session-start
            if (req.method === 'POST' && req.url === '/hook/session-start') {
                // A5-MED-2: same secret gate as the permission/statusline endpoints — a hostile
                // local process must not be able to spoof session_id/transcript_path (transcript
                // ingestion follows transcript_path). Absent secret keeps legacy-open behavior.
                const expectedSessionSecret = typeof permissionHookSecret === 'string' && permissionHookSecret.length > 0
                    ? permissionHookSecret
                    : null;
                if (expectedSessionSecret) {
                    const providedSecret = req.headers['x-happier-hook-secret'];
                    const providedSecretValue = Array.isArray(providedSecret) ? providedSecret[0] : providedSecret;
                    if (providedSecretValue !== expectedSessionSecret) {
                        logger.debug('[hookServer] Forbidden session hook request (secret mismatch)');
                        res.writeHead(403).end('forbidden');
                        return;
                    }
                }
                // Set timeout to prevent hanging if Claude doesn't close stdin
                const timeout = setTimeout(() => {
                    if (!res.headersSent) {
                        logger.debug('[hookServer] Request timeout');
                        res.writeHead(408).end('timeout');
                    }
                }, 5000);

                try {
                    const rawBody = await readBoundedRequestBody(req);
                    clearTimeout(timeout);
                    if (rawBody === null) {
                        rejectOversizedBody(req, res);
                        return;
                    }

                    const body = rawBody.toString('utf-8');

                    let data: SessionHookData = {};
                    try {
                        data = JSON.parse(body);
                    } catch (parseError) {
                        logger.debug('[hookServer] Failed to parse hook data as JSON:', parseError);
                    }

                    logger.debug('[hookServer] Received session hook', {
                        sessionId: data.session_id || data.sessionId || null,
                        transcriptPath: data.transcript_path || data.transcriptPath || null,
                        cwd: data.cwd,
                        hookEventName: data.hook_event_name || data.hookEventName,
                        source: data.source,
                        bodyLength: body.length,
                    });

                    // Support both snake_case (from Claude) and camelCase
                    const sessionId = data.session_id || data.sessionId;
                    if (sessionId) {
                        logger.debug(`[hookServer] Session hook received session ID: ${sessionId}`);
                        onSessionHook(sessionId, data);
                    } else {
                        logger.debug('[hookServer] Session hook received but no session_id found in data');
                    }

                    res.writeHead(200, { 'Content-Type': 'text/plain' }).end('ok');
                } catch (error) {
                    clearTimeout(timeout);
                    logger.debug('[hookServer] Error handling session hook:', error);
                    if (!res.headersSent) {
                        res.writeHead(500).end('error');
                    }
                }
                return;
            }

            if (req.method === 'POST' && req.url === '/hook/permission-request') {
                const expectedSecret = typeof permissionHookSecret === 'string' && permissionHookSecret.length > 0
                    ? permissionHookSecret
                    : null;
                if (expectedSecret) {
                    const providedSecret = req.headers['x-happier-hook-secret'];
                    const providedSecretValue = Array.isArray(providedSecret) ? providedSecret[0] : providedSecret;
                    if (providedSecretValue !== expectedSecret) {
                        logger.debug('[hookServer] Forbidden permission hook request (secret mismatch)');
                        res.writeHead(403).end('forbidden');
                        return;
                    }
                }

                const controller = new AbortController();
                const abort = () => controller.abort();
                const onResponseClose = () => {
                    if (!res.writableEnded) abort();
                };
                req.once('aborted', abort);
                res.once('close', onResponseClose);
                const permissionRequestTimeoutMs = resolvePermissionRequestTimeoutMs();
                const responseTimeout = permissionRequestTimeoutMs === null
                    ? null
                    : setTimeout(() => {
                        if (!res.headersSent) {
                            logger.debug('[hookServer] Permission hook request timeout');
                            abort();
                            res.writeHead(408).end('timeout');
                        }
                    }, permissionRequestTimeoutMs);
                responseTimeout?.unref?.();

                const readTimeout = setTimeout(() => {
                    if (!res.headersSent) {
                        logger.debug('[hookServer] Permission hook request read timeout');
                        abort();
                        res.writeHead(408).end('timeout');
                    }
                }, 5000);

                try {
                    const rawBody = await readBoundedRequestBody(req);
                    clearTimeout(readTimeout);
                    if (controller.signal.aborted || res.headersSent) return;
                    if (rawBody === null) {
                        if (responseTimeout) {
                            clearTimeout(responseTimeout);
                        }
                        rejectOversizedBody(req, res);
                        return;
                    }

                    const body = rawBody.toString('utf-8');

                    let data: PermissionHookData = {};
                    try {
                        data = JSON.parse(body);
                    } catch (parseError) {
                        logger.debug('[hookServer] Failed to parse permission hook data as JSON:', parseError);
                    }

                    logger.debug('[hookServer] Received permission hook', {
                        sessionId: data.session_id || data.sessionId || null,
                        cwd: data.cwd,
                        hookEventName: data.hook_event_name || data.hookEventName,
                        permissionMode: data.permission_mode || data.permissionMode,
                        toolName: data.tool_name || data.toolName,
                        toolUseId: data.tool_use_id || data.toolUseId,
                        transcriptPath: data.transcript_path || data.transcriptPath || null,
                        bodyLength: body.length,
                    });

                    const response = onPermissionHook
                        ? await onPermissionHook(data, { signal: controller.signal })
                        : buildDefaultPermissionHookResponse(data);

                    if (responseTimeout) {
                        clearTimeout(responseTimeout);
                    }
                    if (!res.headersSent && !res.destroyed) {
                        res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(response));
                    }
                } catch (error) {
                    clearTimeout(readTimeout);
                    if (responseTimeout) {
                        clearTimeout(responseTimeout);
                    }
                    logger.debug('[hookServer] Error handling permission hook:', error);
                    if (!res.headersSent && !res.destroyed) {
                        res.writeHead(200, { 'Content-Type': 'application/json' }).end(
                            JSON.stringify(buildDefaultPermissionHookResponse()),
                        );
                    }
                } finally {
                    clearTimeout(readTimeout);
                    if (responseTimeout) clearTimeout(responseTimeout);
                    req.off('aborted', abort);
                    res.off('close', onResponseClose);
                }
                return;
            }

            if (req.method === 'POST' && req.url === '/hook/statusline') {
                const expectedSecret = typeof permissionHookSecret === 'string' && permissionHookSecret.length > 0
                    ? permissionHookSecret
                    : null;
                if (expectedSecret) {
                    const providedSecret = req.headers['x-happier-hook-secret'];
                    const providedSecretValue = Array.isArray(providedSecret) ? providedSecret[0] : providedSecret;
                    if (providedSecretValue !== expectedSecret) {
                        logger.debug('[hookServer] Forbidden statusline hook request (secret mismatch)');
                        res.writeHead(403).end('forbidden');
                        return;
                    }
                }

                const readTimeout = setTimeout(() => {
                    if (!res.headersSent) {
                        logger.debug('[hookServer] Statusline hook request read timeout');
                        res.writeHead(408).end('timeout');
                    }
                }, 5000);

                try {
                    const rawBody = await readBoundedRequestBody(req);
                    clearTimeout(readTimeout);
                    if (rawBody === null) {
                        rejectOversizedBody(req, res);
                        return;
                    }

                    const body = rawBody.toString('utf-8');
                    let payload: ClaudeStatuslinePayload | null = null;
                    try {
                        payload = parseClaudeStatuslinePayload(JSON.parse(body));
                    } catch (parseError) {
                        logger.debug('[hookServer] Failed to parse statusline payload as JSON:', parseError);
                    }

                    // Respond before the consumer runs: the forwarder is fire-and-forget and the
                    // statusline pipeline is additive enrichment, never a request/response protocol.
                    res.writeHead(200, { 'Content-Type': 'text/plain' }).end('ok');

                    if (payload && options.onStatuslineUpdate) {
                        try {
                            options.onStatuslineUpdate(payload);
                        } catch (error) {
                            logger.debug('[hookServer] Statusline consumer failed (non-fatal):', error);
                        }
                    }
                } catch (error) {
                    clearTimeout(readTimeout);
                    logger.debug('[hookServer] Error handling statusline hook:', error);
                    if (!res.headersSent) {
                        res.writeHead(200, { 'Content-Type': 'text/plain' }).end('ok');
                    }
                }
                return;
            }

            // 404 for anything else
            res.writeHead(404).end('not found');
        });

        const requestedPort = typeof options.requestedPort === 'number' && Number.isInteger(options.requestedPort) && options.requestedPort > 0
            ? options.requestedPort
            : 0;
        server.listen(requestedPort, '127.0.0.1', () => {
            const address = server.address();
            if (!address || typeof address === 'string') {
                reject(new Error('Failed to get server address'));
                return;
            }

            const port = address.port;
            logger.debug(`[hookServer] Started on port ${port}`);

            resolve({
                port,
                stop: () => {
                    server.close();
                    logger.debug('[hookServer] Stopped');
                }
            });
        });

        server.on('error', (err) => {
            logger.debug('[hookServer] Server error:', err);
            reject(err);
        });
    });
}
