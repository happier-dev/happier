import { createLocalMcpBearer } from './localMcpBearer';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import type { AddressInfo, Server } from 'node:net';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { createSessionNativeDirectory, grantExactUidPathAccess } from '@/utils/fs/unixPathAccess';
import { registerTranscriptSecret } from '@/api/session/client/transport/transcriptSecretRedaction';
import { agentVisibleSessionMcpContext, SessionMcpUnavailableError, SESSION_MCP_CONTEXT_FILE_ENV,
    type SessionMcpLocalContext } from './sessionMcpLocalContext';
export { SessionMcpLocalContextSchema, SessionMcpUnavailableError, SESSION_MCP_CONTEXT_FILE_ENV,
    type SessionMcpLocalContext } from './sessionMcpLocalContext';

/** Unix-socket transport (and Agent isolation). Elsewhere (Windows) the bearer-gated loopback transport below applies. */
export function supportsSessionMcpLocalTransport(): boolean {
    return process.platform !== 'win32';
}

export type SessionMcpLocalTransportOptions = Readonly<{ agentUid: number; runtimeRoot?: string }>;
export type SessionMcpLocalTransport = Readonly<{
    readonly localContext: SessionMcpLocalContext | undefined;
    contextFilePath?: string;
    /** HTTP base URL clients use; the socket transport's SDK URL is nominal. */
    readonly url: string | undefined;
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
    const bearer = createLocalMcpBearer();
    const localContext: Extract<SessionMcpLocalContext, Readonly<{ socketPath: string }>> = Object.freeze({
        v: 1, socketPath: join(directory.path, 'mcp.sock'), bearerToken: bearer.token,
    });
    let retired = false;
    let contextFilePath: string | undefined;
    const retire = async () => {
        retired = true;
        bearer.retire();
        await directory.dispose();
    };
    try {
        return {
            get localContext() { return retired ? undefined : localContext; },
            get contextFilePath() { return contextFilePath; },
            get url() { return retired ? undefined : 'http://localhost/mcp'; },
            authenticate: bearer.authenticate,
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
                            access: 'rw-', directory: false, kind: 'socket' });
                    } else {
                        // Isolated launches publish through the single Agent-launch frame.
                        // A same-UID Session uses this owner's private transient directory. The
                        // Agent can read this file, so it names the socket only: the endpoint
                        // admits the Agent tree by kernel peer proof.
                        contextFilePath = join(directory.path, 'session-mcp.json');
                        await writeFile(contextFilePath, JSON.stringify(agentVisibleSessionMcpContext(localContext)), { mode: 0o600, flag: 'wx' });
                    }
                } catch {
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

/**
 * Where no Unix socket transport exists (Windows), the Session MCP listens on 127.0.0.1, which
 * every local process and OS user can reach. The bearer is the admission. The context file the
 * Agent reads names the endpoint only; the bearer reaches the relay through its MCP client config
 * env (`SESSION_MCP_BEARER_ENV`), and the transcript writer redacts it while it is live.
 */
export async function prepareSessionMcpLoopbackTransport(): Promise<SessionMcpLocalTransport> {
    const directory = await mkdtemp(join(tmpdir(), 'happier-mcp-')).catch(() => { throw new SessionMcpUnavailableError(); });
    const bearer = createLocalMcpBearer();
    const unregisterTranscriptSecret = registerTranscriptSecret(bearer.token);
    let localContext: SessionMcpLocalContext | undefined;
    let retired = false;
    let contextFilePath: string | undefined;
    const retire = async () => {
        retired = true;
        unregisterTranscriptSecret();
        bearer.retire();
        await rm(directory, { recursive: true, force: true });
    };
    return {
        get localContext() { return retired ? undefined : localContext; },
        get contextFilePath() { return contextFilePath; },
        get url() { return retired || !localContext || !('url' in localContext) ? undefined : localContext.url; },
        authenticate: bearer.authenticate,
        listen: async (server: Server) => {
            try {
                await chmod(directory, 0o700);
                const port = await new Promise<number>((resolve, reject) => {
                    server.once('error', reject);
                    server.listen(0, '127.0.0.1', () => {
                        server.off('error', reject);
                        resolve((server.address() as AddressInfo).port);
                    });
                });
                localContext = Object.freeze({ v: 1, url: `http://127.0.0.1:${port}`, bearerToken: bearer.token });
                contextFilePath = join(directory, 'session-mcp.json');
                await writeFile(contextFilePath, JSON.stringify(agentVisibleSessionMcpContext(localContext)), { mode: 0o600, flag: 'wx' });
            } catch {
                await new Promise<void>(resolve => server.close(() => resolve()));
                await retire();
                throw new SessionMcpUnavailableError();
            }
        },
        retire,
    };
}
