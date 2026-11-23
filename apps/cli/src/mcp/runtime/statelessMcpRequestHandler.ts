import type { IncomingMessage, ServerResponse } from 'node:http';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

/** Disposable MCP request servers; connection admission belongs to the endpoint. */
export function createStatelessMcpRequestHandler(input: Readonly<{
    signal?: AbortSignal;
    createServer(signal: AbortSignal): McpServer;
}>) {
    const requestCleanups = new Set<() => Promise<void>>();
    return {
        async handleRequest(req: IncomingMessage, res: ServerResponse) {
            const controller = new AbortController();
            const signal = input.signal ? AbortSignal.any([input.signal, controller.signal]) : controller.signal;
            let mcp: McpServer | undefined;
            let transport: StreamableHTTPServerTransport | undefined;
            let cleanedUp = false;
            const cleanup = async () => {
                if (cleanedUp) return;
                cleanedUp = true;
                controller.abort();
                requestCleanups.delete(cleanup);
                if (!res.destroyed) res.destroy();
                try { await transport?.close(); }
                finally { await mcp?.close(); }
            };
            requestCleanups.add(cleanup);
            res.once('close', () => { void cleanup().catch(() => undefined); });
            try {
                signal.throwIfAborted();
                const { StreamableHTTPServerTransport } = await import('@modelcontextprotocol/sdk/server/streamableHttp.js');
                signal.throwIfAborted();
                mcp = input.createServer(signal);
                transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
                await mcp.connect(transport);
                await transport.handleRequest(req, res);
            } catch {
                if (!res.headersSent) res.writeHead(500).end();
                await cleanup();
            }
        },
        async dispose() { await Promise.all([...requestCleanups].map(cleanup => cleanup())); },
    };
}
