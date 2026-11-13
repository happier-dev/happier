import { readFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport, StreamableHTTPError } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Agent, fetch as fetchWithDispatcher } from 'undici';
import { fetchWithCredentialRedirectRefusal, CredentialRequestRedirectError } from '@happier-dev/cli-common/homeTarget';
import { z } from 'zod/mini';
import { SessionMcpLocalContextSchema, SessionMcpUnavailableError, SESSION_MCP_CONTEXT_FILE_ENV,
    type SessionMcpLocalContext } from './sessionMcpLocalContext';

// Client side of the Session MCP socket (bridges and `happier tools`). Kept apart from the
// listener in `sessionMcpLocalTransport.ts` so a runner hosting the server does not load the
// MCP client stack and Undici.

export async function readSessionMcpContextFromEnvironment(
    env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<SessionMcpLocalContext> {
    try {
        const file = env[SESSION_MCP_CONTEXT_FILE_ENV];
        if (!file || !isAbsolute(file)) throw new SessionMcpUnavailableError();
        return z.parse(SessionMcpLocalContextSchema, JSON.parse(await readFile(file, 'utf8')));
    } catch {
        throw new SessionMcpUnavailableError('mcp_socket_access_unavailable', { phase: 'context_read' });
    }
}

/** The SDK owns MCP framing; Undici directs every HTTP/SSE request to the Session's socket (or loopback endpoint). */
export async function connectSessionMcpClient(context: SessionMcpLocalContext, signal?: AbortSignal): Promise<Readonly<{
    client: Client;
    close: () => Promise<void>;
}>> {
    signal?.throwIfAborted();
    const dispatcher = 'socketPath' in context ? new Agent({ connect: { socketPath: context.socketPath } }) : new Agent();
    const client = new Client({ name: 'happier-session-bridge', version: '1' });
    const transport = new StreamableHTTPClientTransport(new URL('socketPath' in context ? 'http://localhost/mcp' : context.url), {
        requestInit: { headers: { authorization: `Bearer ${context.bearerToken}` } },
        fetch: (url, init) => fetchWithCredentialRedirectRefusal(String(url), init, async (url, init) => {
            // Pair the dispatcher with its own Undici version: Node's bundled
            // fetch can use a different dispatch ABI. The SDK sends JSON strings.
            const { body, headers, ...options } = init ?? {};
            if (body != null && typeof body !== 'string') throw new SessionMcpUnavailableError();
            const response = await fetchWithDispatcher(typeof url === 'string' || url instanceof URL ? url : url.url, {
                ...options, body, headers: Array.from(new Headers(headers).entries()), dispatcher, redirect: 'manual',
            });
            // Undici types its body with Node's stream/web declaration. Narrow
            // the actual standard stream at this external fetch boundary.
            const responseBody = response.body;
            if (responseBody !== null && !(responseBody instanceof ReadableStream)) throw new SessionMcpUnavailableError();
            return new Response(responseBody, {
                status: response.status, statusText: response.statusText, headers: Array.from(response.headers.entries()),
            });
        }),
    });
    const close = async () => {
        signal?.removeEventListener('abort', onAbort);
        try { await client.close(); } finally { await dispatcher.destroy(); }
    };
    const onAbort = () => { void close().catch(() => undefined); };
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
        await client.connect(transport, signal ? { signal } : undefined);
        signal?.throwIfAborted();
        return { client, close };
    } catch (error) {
        try { await close(); } finally {
            if (error instanceof CredentialRequestRedirectError) throw error;
        }
        signal?.throwIfAborted();
        throw new SessionMcpUnavailableError(error instanceof StreamableHTTPError
            && (error.code === 401 || error.code === 403) ? 'not_authenticated' : 'mcp_socket_access_unavailable',
        { phase: 'client_connect', ...(error instanceof StreamableHTTPError ? { httpStatus: error.code } : {}) });
    }
}
