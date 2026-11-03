import { randomBytes, timingSafeEqual } from 'node:crypto';
import { chmod, readFile, writeFile } from 'node:fs/promises';
import type { Server } from 'node:http';
import { isAbsolute, join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport, StreamableHTTPError } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Agent, fetch as fetchWithDispatcher } from 'undici';
import { fetchWithCredentialRedirectRefusal, CredentialRequestRedirectError } from '@happier-dev/cli-common/homeTarget';
import { z } from 'zod/mini';
import { createSessionNativeDirectory, grantExactUidPathAccess } from '@/utils/fs/unixPathAccess';
import { SessionMcpLocalContextSchema, SessionMcpUnavailableError, SESSION_MCP_CONTEXT_FILE_ENV,
    type SessionMcpLocalContext } from './sessionMcpLocalContext';
export { SessionMcpLocalContextSchema, SessionMcpUnavailableError, SESSION_MCP_CONTEXT_FILE_ENV,
    type SessionMcpLocalContext } from './sessionMcpLocalContext';

/** Windows retains its existing current-user MCP transport; isolation is unavailable. */
export function supportsSessionMcpLocalTransport(): boolean {
    return process.platform !== 'win32';
}

export type SessionMcpLocalTransportOptions = Readonly<{ agentUid: number; runtimeRoot?: string }>;
export type SessionMcpLocalTransport = Readonly<{
    readonly localContext: SessionMcpLocalContext | undefined;
    contextFilePath?: string;
    authenticate: (authorization: string | undefined) => boolean;
    listen: (server: Server) => Promise<void>;
    retire: () => Promise<void>;
}>;

export async function prepareSessionMcpLocalTransport(options: SessionMcpLocalTransportOptions): Promise<SessionMcpLocalTransport> {
    if (!supportsSessionMcpLocalTransport() || !Number.isSafeInteger(options.agentUid) || options.agentUid < 0
        || (options.runtimeRoot !== undefined && !isAbsolute(options.runtimeRoot))) {
        throw new SessionMcpUnavailableError();
    }
    const sameIdentity = options.agentUid === process.getuid?.();
    if (!sameIdentity && process.platform !== 'linux') throw new SessionMcpUnavailableError();
    const directory = await createSessionNativeDirectory({ uid: options.agentUid, prefix: 'happier-mcp-',
        access: '--x', runtimeRoot: options.runtimeRoot })
        .catch(() => { throw new SessionMcpUnavailableError(); });
    const bearer = randomBytes(32);
    const localContext: SessionMcpLocalContext = Object.freeze({
        v: 1, socketPath: join(directory.path, 'mcp.sock'), bearerToken: bearer.toString('base64url'),
    });
    const expectedHeader = Buffer.from(`Bearer ${localContext.bearerToken}`, 'utf8');
    let retired = false;
    let contextFilePath: string | undefined;
    const retire = async () => {
        retired = true;
        bearer.fill(0);
        expectedHeader.fill(0);
        await directory.dispose();
    };
    try {
        return {
            get localContext() { return retired ? undefined : localContext; },
            get contextFilePath() { return contextFilePath; },
            authenticate: (authorization: string | undefined): boolean => {
                if (retired || typeof authorization !== 'string') return false;
                const candidate = Buffer.from(authorization, 'utf8');
                return candidate.length === expectedHeader.length && timingSafeEqual(candidate, expectedHeader);
            },
            listen: async (server: Server) => {
                try {
                    await new Promise<void>((resolve, reject) => {
                        server.once('error', reject);
                        server.listen(localContext.socketPath, () => {
                            server.off('error', reject);
                            resolve();
                        });
                    });
                    await chmod(localContext.socketPath, 0o600);
                    if (!sameIdentity) {
                        await grantExactUidPathAccess({ path: localContext.socketPath, uid: options.agentUid,
                            access: 'rw-', directory: false });
                    } else {
                        // Isolated launches publish through the single Agent-launch frame.
                        // A same-UID Session uses this owner's private transient directory.
                        contextFilePath = join(directory.path, 'session-mcp.json');
                        await writeFile(contextFilePath, JSON.stringify(localContext), { mode: 0o600, flag: 'wx' });
                    }
                } catch {
                    server.closeAllConnections();
                    await new Promise<void>(resolve => server.close(() => resolve()));
                    await retire();
                    throw new SessionMcpUnavailableError();
                }
            },
            retire,
        };
    } catch {
        await retire();
        throw new SessionMcpUnavailableError();
    }
}

export async function readSessionMcpContextFromEnvironment(
    env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<SessionMcpLocalContext> {
    try {
        const file = env[SESSION_MCP_CONTEXT_FILE_ENV];
        if (!file || !isAbsolute(file)) throw new SessionMcpUnavailableError();
        return z.parse(SessionMcpLocalContextSchema, JSON.parse(await readFile(file, 'utf8')));
    } catch {
        throw new SessionMcpUnavailableError();
    }
}

/** The SDK owns MCP framing; Undici directs every HTTP/SSE request to the same Unix socket. */
export async function connectSessionMcpClient(context: SessionMcpLocalContext, signal?: AbortSignal): Promise<Readonly<{
    client: Client;
    close: () => Promise<void>;
}>> {
    signal?.throwIfAborted();
    const dispatcher = new Agent({ connect: { socketPath: context.socketPath } });
    const client = new Client({ name: 'happier-session-bridge', version: '1' });
    const transport = new StreamableHTTPClientTransport(new URL('http://localhost/mcp'), {
        requestInit: { headers: { authorization: `Bearer ${context.bearerToken}` } },
        fetch: (url, init) => fetchWithCredentialRedirectRefusal(url, init, async (url, init) => {
            // Pair the dispatcher with its own Undici version: Node's bundled
            // fetch can use a different dispatch ABI. The SDK sends JSON strings.
            const { body, headers, ...options } = init ?? {};
            if (body != null && typeof body !== 'string') throw new SessionMcpUnavailableError();
            const response = await fetchWithDispatcher(url, {
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
            && (error.code === 401 || error.code === 403) ? 'not_authenticated' : 'mcp_socket_access_unavailable');
    }
}
