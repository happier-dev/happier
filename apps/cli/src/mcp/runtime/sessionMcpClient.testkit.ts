import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Agent, fetch as fetchWithDispatcher } from 'undici';
import { ReadBuffer, serializeMessage } from '@modelcontextprotocol/sdk/shared/stdio.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';

import { createSessionHolderSocketPath, requireSessionHolderExecutablePath, spawnSessionHolderChild,
    type SessionHolderChild, type SessionHolderRole, type SessionHolderTarget } from '@/subprocess/supervision/sessionHolder';

import type { SessionMcpLocalContext } from './sessionMcpLocalContext';

type BearerGatedSessionMcpServer = Readonly<{ url: string; localContext?: SessionMcpLocalContext }>;

/** The Authorization header the Happier-launched bridge presents (read from the server's private context). */
export function sessionMcpAuthorizationHeaders(server: BearerGatedSessionMcpServer): Readonly<{ authorization: string }> {
    if (!server.localContext) throw new Error('Session MCP server has no live bearer context');
    return { authorization: `Bearer ${server.localContext.bearerToken}` };
}

/** `fetch` that reaches the Session MCP server over its actual transport (Unix socket or loopback). */
export function sessionMcpTestFetch(server: BearerGatedSessionMcpServer): typeof fetch {
    const context = server.localContext;
    if (!context || !('socketPath' in context)) return fetch;
    const dispatcher = new Agent({ connect: { socketPath: context.socketPath } });
    return (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        const { body, headers, ...options } = init ?? {};
        const response = await fetchWithDispatcher(String(input instanceof Request ? input.url : input), {
            ...options, body: body as string | undefined, headers: Array.from(new Headers(headers).entries()), dispatcher,
        });
        return new Response(response.body as ReadableStream | null, {
            status: response.status, statusText: response.statusText, headers: Array.from(response.headers.entries()),
        });
    }) as typeof fetch;
}

/** A real SDK client transport for a Session MCP server, authenticated like the Happier-launched bridge. */
export function sessionMcpTestTransport(server: BearerGatedSessionMcpServer, headers?: Readonly<Record<string, string>>): StreamableHTTPClientTransport {
    return new StreamableHTTPClientTransport(new URL(server.url), {
        requestInit: { headers: { ...headers, ...sessionMcpAuthorizationHeaders(server) } },
        fetch: sessionMcpTestFetch(server),
    });
}

/**
 * Launch a Session MCP launch config (`mcpServers.happier`) the way an Agent's tree does: under
 * a Session holder in the current Session, so the endpoint's Agent-tree peer check admits it.
 * Returns an SDK client transport over the launched relay's stdio. With `held`, the relay is the
 * Agent of a holder in that target (its environment comes from the target's launch preparation).
 */
export function sessionMcpAgentTransport(config: Readonly<{ command: string; args?: readonly string[]; env?: Readonly<Record<string, string>> }>,
    held?: Readonly<{ target: SessionHolderTarget; socketPath: string; role: SessionHolderRole }>): Transport & {
    readonly child: SessionHolderChild;
} {
    const child = spawnSessionHolderChild({ executablePath: held?.target.holderPath ?? requireSessionHolderExecutablePath(),
        socketPath: held?.socketPath ?? createSessionHolderSocketPath(), ...(held ? { target: held.target, role: held.role } : {}),
        command: config.command, args: [...(config.args ?? [])], env: { ...process.env, ...config.env } });
    const readBuffer = new ReadBuffer();
    let exited = false;
    // The relay may exit (refused, no context) while a request is in flight: that is a close, not a crash.
    child.stdin.on('error', () => undefined);
    const transport: Transport & { child: SessionHolderChild } = {
        child,
        async start() {
            await new Promise<void>((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
            child.stdout.on('data', (chunk: Buffer) => {
                readBuffer.append(chunk);
                for (let message = readBuffer.readMessage(); message; message = readBuffer.readMessage()) transport.onmessage?.(message);
            });
            child.once('exit', () => { exited = true; transport.onclose?.(); });
        },
        async send(message: JSONRPCMessage) {
            if (exited) throw new Error('Session MCP relay exited');
            await new Promise<void>((resolve, reject) => child.stdin.write(serializeMessage(message), error => error ? reject(error) : resolve()));
        },
        async close() {
            child.kill('SIGTERM');
        },
    };
    return transport;
}
