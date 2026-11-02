import { execFile } from 'node:child_process';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport, StreamableHTTPError } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Agent, fetch as fetchWithDispatcher } from 'undici';
import { fetchWithCredentialRedirectRefusal, CredentialRequestRedirectError } from '@happier-dev/cli-common/homeTarget';
import { z } from 'zod/mini';
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

function runAclCommand(command: 'setfacl' | 'getfacl', args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
        execFile(command, args, { encoding: 'utf8' }, (error, stdout) => {
            if (error) reject(new SessionMcpUnavailableError());
            else resolve(stdout);
        });
    });
}

async function admitAgentSocketAccess(path: string, agentUid: number, directory: boolean): Promise<void> {
    // A parent default ACL must not become effective when granting the Agent mask.
    await runAclCommand('setfacl', ['-b', path]);
    if (directory) await runAclCommand('setfacl', ['-k', path]);
    const access = directory ? '--x' : 'rw-';
    await runAclCommand('setfacl', ['-m', `u:${agentUid}:${access}`, path]);
    const actual = (await runAclCommand('getfacl', ['-n', '-c', '-p', path]))
        .split('\n').map(line => line.split('#')[0]!.trim()).filter(Boolean).sort();
    const expected = [`user::${directory ? 'rwx' : 'rw-'}`, `user:${agentUid}:${access}`,
        'group::---', `mask::${access}`, 'other::---'].sort();
    if (actual.length !== expected.length || actual.some((entry, index) => entry !== expected[index])) {
        throw new SessionMcpUnavailableError();
    }
}

export async function prepareSessionMcpLocalTransport(options: SessionMcpLocalTransportOptions): Promise<SessionMcpLocalTransport> {
    if (!supportsSessionMcpLocalTransport() || !Number.isSafeInteger(options.agentUid) || options.agentUid < 0
        || (options.runtimeRoot !== undefined && !isAbsolute(options.runtimeRoot))) {
        throw new SessionMcpUnavailableError();
    }
    const sameIdentity = options.agentUid === process.getuid?.();
    if (!sameIdentity && process.platform !== 'linux') throw new SessionMcpUnavailableError();
    const directory = await mkdtemp(join(options.runtimeRoot ?? tmpdir(), 'happier-mcp-'))
        .catch(() => { throw new SessionMcpUnavailableError(); });
    const bearer = randomBytes(32);
    const localContext: SessionMcpLocalContext = Object.freeze({
        v: 1, socketPath: join(directory, 'mcp.sock'), bearerToken: bearer.toString('base64url'),
    });
    const expectedHeader = Buffer.from(`Bearer ${localContext.bearerToken}`, 'utf8');
    let retired = false;
    let contextFilePath: string | undefined;
    const retire = async () => {
        retired = true;
        bearer.fill(0);
        expectedHeader.fill(0);
        await rm(directory, { recursive: true, force: true });
    };
    try {
        await chmod(directory, 0o700);
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
                        await admitAgentSocketAccess(directory, options.agentUid, true);
                        await admitAgentSocketAccess(localContext.socketPath, options.agentUid, false);
                    } else {
                        // Isolated launches publish through the single Agent-launch frame.
                        // A same-UID Session uses this owner's private transient directory.
                        contextFilePath = join(directory, 'session-mcp.json');
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
