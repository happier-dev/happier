import { createServer, type OutgoingHttpHeaders, type ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { AddressInfo } from "node:net";
import { logger } from "@/ui/logger";
import { createHappierMcpServer, HAPPIER_MCP_TOOL_NAMES } from "@/mcp/createHappierMcpServer";
import type { RpcHandlerManagerLike } from "@/api/rpc/types";
import { configuration } from "@/configuration";

export type HappyMcpSessionClient = {
    sessionId: string;
    rpcHandlerManager: RpcHandlerManagerLike;
    sendClaudeSessionMessage(message: any, meta?: Record<string, unknown>): void;
};

export async function startHappyServer(client: HappyMcpSessionClient) {
    // Do not eagerly construct an MCP server on startup; only snapshot the names.
    // Full server creation is done per request inside the handler.
    const toolNamesSnapshot = [...HAPPIER_MCP_TOOL_NAMES];
    const keepAliveIntervalMs = configuration.mcpSseKeepAliveIntervalMs;

    //
    // Create the HTTP server
    //

    const server = createServer(async (req, res) => {
        // Claude Code keeps a long-lived standalone GET SSE stream open for MCP notifications.
        // Without periodic bytes on that stream, the client times out and reconnects every ~5 minutes.
        // Keepalives are only needed for the standalone GET stream (POST response streams are short-lived).
        const stopKeepAlive = req.method === 'GET' ? startMcpSseKeepAlive(res, keepAliveIntervalMs) : () => {};

        // Build a fresh MCP server + transport per request.
        //
        // We intentionally run in stateless mode (no session IDs) because some
        // clients re-send initialize and do not keep MCP session headers.
        // In newer MCP SDK versions, stateless transports are single-use; reusing
        // one transport across requests can surface as client-side "Error POSTing to endpoint".
        const { mcp } = createHappierMcpServer(client);

        const transport = new StreamableHTTPServerTransport({
            // NOTE: Returning session id here will result in claude
            // sdk spawn to fail with `Invalid Request: Server already initialized`
            sessionIdGenerator: undefined,
        });

        let cleanedUp = false;
        const cleanup = async () => {
            if (cleanedUp) {
                return;
            }
            cleanedUp = true;

            stopKeepAlive();

            try {
                await transport.close();
            } catch (error) {
                logger.debug('[happierMCP] Error closing transport:', error);
            }

            try {
                await Promise.resolve(mcp.close());
            } catch (error) {
                logger.debug('[happierMCP] Error closing server:', error);
            }
        };

        res.once('close', () => {
            cleanup().catch((error) => {
                logger.debug('[happierMCP] Error during request cleanup:', error);
            });
        });

        try {
            await mcp.connect(transport);
            await transport.handleRequest(req, res);
        } catch (error) {
            logger.debug('[happierMCP] Error handling request:', error);
            if (!res.headersSent) {
                res.writeHead(500).end();
            }
            await cleanup();
        }
    });

    const baseUrl = await new Promise<URL>((resolve) => {
        server.listen(0, "127.0.0.1", () => {
            const addr = server.address() as AddressInfo;
            resolve(new URL(`http://127.0.0.1:${addr.port}`));
        });
    });

    return {
        url: baseUrl.toString(),
        toolNames: toolNamesSnapshot,
        stop: () => {
            logger.debug('[happierMCP] Stopping server');
            server.close();
        }
    }
}

function startMcpSseKeepAlive(res: ServerResponse, keepAliveIntervalMs: number | null): () => void {
    if (!keepAliveIntervalMs) {
        return () => {};
    }

    let stopped = false;
    let keepAliveTimer: NodeJS.Timeout | null = null;

    const originalSetHeader = res.setHeader.bind(res);
    const originalWriteHead = res.writeHead.bind(res);

    const stop = () => {
        if (stopped) return;
        stopped = true;
        if (keepAliveTimer) {
            clearInterval(keepAliveTimer);
            keepAliveTimer = null;
        }
        // Restore patched methods (defense-in-depth; these response objects are per-request).
        try {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (res as any).setHeader = originalSetHeader;
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (res as any).writeHead = originalWriteHead;
        } catch {
            // best-effort
        }
    };

    let started = false;

    const tryWriteKeepAlive = () => {
        if (stopped) return;
        if (res.writableEnded || res.destroyed) {
            stop();
            return;
        }
        try {
            // SSE comment (":") is ignored by clients and safe to interleave with message events.
            res.write(':\n\n');
        } catch {
            stop();
        }
    };

    const startKeepAlive = () => {
        if (started) return;
        started = true;
        // Defer the first write to avoid racing the underlying transport's SSE setup.
        const immediate = setTimeout(tryWriteKeepAlive, 0);
        immediate.unref?.();
        keepAliveTimer = setInterval(tryWriteKeepAlive, keepAliveIntervalMs);
        keepAliveTimer.unref?.();
    };

    const maybeStartFromHeader = (name: unknown, value: unknown) => {
        if (stopped || started) return;
        const headerName = typeof name === 'string' ? name.toLowerCase() : '';
        if (headerName && headerName !== 'content-type') return;
        const serialized = Array.isArray(value) ? value.map((v) => String(v)).join(',') : String(value ?? '');
        if (!serialized.includes('text/event-stream')) return;
        startKeepAlive();
    };

    // Start keepalives as soon as the underlying transport configures an SSE response.
    // This prevents clients with idle timeouts from dropping the stream during long periods of inactivity.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (res as any).setHeader = (name: string, value: unknown) => {
        originalSetHeader(name, value as any);
        maybeStartFromHeader(name, value);
        return res;
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (res as any).writeHead = (...args: unknown[]) => {
        const result = (originalWriteHead as unknown as (...inner: any[]) => unknown)(...(args as any[]));

        let headersArg: Record<string, unknown> | null = null;
        for (let i = args.length - 1; i >= 0; i--) {
            const value = args[i];
            if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
            headersArg = value as Record<string, unknown>;
            break;
        }

        if (headersArg) {
            for (const [k, v] of Object.entries(headersArg)) {
                maybeStartFromHeader(k, v);
            }
        }

        if (!started) {
            maybeStartFromHeader('content-type', res.getHeader('content-type'));
        }

        return result;
    };

    res.once('close', stop);
    res.once('finish', stop);

    return stop;
}
