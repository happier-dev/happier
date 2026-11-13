import type { IncomingMessage } from 'node:http';
import type { Socket } from 'node:net';
import type { Readable, Writable } from 'node:stream';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { logger } from '@/ui/logger';
import { createMcpWatchSession, type McpWatchSession } from '@/mcp/resources/watchSubscriptions';
import type { ForwardingMcpUpstreamKind } from '@/mcp/bridges/forwardingMcpServer';

/**
 * Agent relays (`happier-session-holder mcp-relay`, the stdio MCP server every Agent launches)
 * reach the Session MCP endpoint (the Session's Unix socket, or the Windows 127.0.0.1 port) with
 * one HTTP upgrade (`Upgrade: happier-mcp-relay`, the endpoint's bearer, optionally the Agent's
 * tool-name budget). After `101` the connection carries MCP stdio framing (newline-delimited
 * JSON-RPC) and is one MCP session served here in the host: no per-Session bridge process.
 *
 * A relay is admitted by the host's one connection admission: on Unix, a kernel-proven peer in this
 * Session's Agent tree (the Agent-visible context carries no bearer); otherwise the bearer.
 */
export const SESSION_MCP_RELAY_UPGRADE = 'happier-mcp-relay';
const TOOL_NAME_MAX_LENGTH_HEADER = 'x-happier-tool-name-max-length';

function readToolNameMaxLength(request: IncomingMessage): number | undefined | null {
    const raw = request.headers[TOOL_NAME_MAX_LENGTH_HEADER];
    if (raw === undefined) return undefined;
    const value = typeof raw === 'string' && /^\d{1,6}$/u.test(raw) ? Number(raw) : NaN;
    return Number.isSafeInteger(value) && value > 0 ? value : null;
}

export type SessionMcpRelayHost = Readonly<{
    /** The endpoint's connection admission (bearer, or on Unix the Agent-tree peer proof). */
    admit: (socket: Socket, authorization: string | undefined) => Promise<boolean>;
    /** One fresh request server for the current admitted catalog (the same owner HTTP requests use). */
    createRequestServer: (input: Readonly<{ kind: ForwardingMcpUpstreamKind; watchSession: McpWatchSession }>) => Promise<McpServer>;
    lifetimeSignal: AbortSignal;
}>;

/** Admit one relay upgrade and serve its connection as an MCP session in this process. */
export async function serveSessionMcpRelayUpgrade(
    request: IncomingMessage,
    socket: Socket,
    head: Buffer,
    host: SessionMcpRelayHost,
): Promise<void> {
    socket.on('error', () => undefined);
    const toolNameMaxLength = readToolNameMaxLength(request);
    if (String(request.headers.upgrade ?? '').toLowerCase() !== SESSION_MCP_RELAY_UPGRADE || toolNameMaxLength === null
        || host.lifetimeSignal.aborted || !(await host.admit(socket, request.headers.authorization))) {
        logger.debug('[happierMCP] Session MCP relay refused');
        socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
        socket.destroySoon();
        return;
    }
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: ${SESSION_MCP_RELAY_UPGRADE}\r\nConnection: Upgrade\r\n\r\n`);
    if (head.byteLength > 0) socket.unshift(head);
    await serveSessionMcpRelayConnection({ input: socket, output: socket, close: () => socket.destroy(),
        isClosed: () => socket.destroyed, onClose: listener => socket.once('close', listener) },
        toolNameMaxLength === undefined ? {} : { toolNameMaxLength }, host);
    socket.resume();
}

/** One relay connection after its upgrade: the MCP stdio bytes both ways. */
export type SessionMcpRelayConnection = Readonly<{
    input: Readable;
    output: Writable;
    close(): void;
    isClosed(): boolean;
    onClose(listener: () => void): void;
}>;

/**
 * Serves one admitted relay connection as an MCP session in this process: a relay upgrade on this
 * endpoint, or a relay an Agent in a target started, which its holder admitted from its own Agent
 * tree and carries on the Session's holder channel (`registerSessionMcpRelayAcceptor`).
 */
export async function serveSessionMcpRelayConnection(
    connection: SessionMcpRelayConnection,
    options: Readonly<{ toolNameMaxLength?: number }>,
    host: Pick<SessionMcpRelayHost, 'createRequestServer' | 'lifetimeSignal'>,
): Promise<void> {
    const { toolNameMaxLength } = options;
    if (host.lifetimeSignal.aborted) { connection.close(); return; }
    const [{ Client }, { InMemoryTransport }, { StdioServerTransport }, { createForwardingMcpServer }] = await Promise.all([
        import('@modelcontextprotocol/sdk/client/index.js'),
        import('@modelcontextprotocol/sdk/inMemory.js'),
        import('@modelcontextprotocol/sdk/server/stdio.js'),
        import('@/mcp/bridges/forwardingMcpServer'),
    ]);
    const watchSession = createMcpWatchSession();
    const upstream = async <T>(operation: (client: Client) => Promise<T>, kind: ForwardingMcpUpstreamKind): Promise<T> => {
        const mcp = await host.createRequestServer({ kind, watchSession });
        const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
        const client = new Client({ name: 'happier-session-relay', version: '1' });
        try {
            await mcp.connect(serverSide);
            await client.connect(clientSide);
            return await operation(client);
        } finally {
            await client.close().catch(() => undefined);
            await Promise.resolve(mcp.close()).catch(() => undefined);
        }
    };
    const server = createForwardingMcpServer({
        upstream,
        ...(toolNameMaxLength === undefined ? {} : { toolNameMaxLength }),
        forwardResources: true,
    });
    watchSession.attachNotificationStream(async uri => {
        if (!host.lifetimeSignal.aborted && !connection.isClosed()) await server.server.sendResourceUpdated({ uri });
    });
    let closed = false;
    const close = () => {
        if (closed) return;
        closed = true;
        host.lifetimeSignal.removeEventListener('abort', close);
        connection.close();
        void server.close().catch(() => undefined);
        void watchSession.close().catch(() => undefined);
    };
    connection.onClose(close);
    host.lifetimeSignal.addEventListener('abort', close, { once: true });
    await server.connect(new StdioServerTransport(connection.input, connection.output));
}
