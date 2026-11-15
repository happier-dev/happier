import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { AsyncResource } from 'node:async_hooks';
import type { Socket } from 'node:net';

import { registerTranscriptSecret } from '@/api/session/client/transport/transcriptSecretRedaction';
import { createLocalMcpBearer } from './localMcpBearer';
import { resolveSessionMcpAgentPeer } from './sessionMcpAgentPeer';
import { refuseSessionMcpRelayUpgrade } from './sessionMcpRelayEndpoint';
import { prepareSessionMcpLocalTransport, prepareSessionMcpLoopbackTransport, type SessionMcpLocalContext,
    type SessionMcpLocalTransport, type SessionMcpLocalTransportOptions } from './sessionMcpLocalTransport';

/** What one Session serves on the host endpoint once the endpoint has resolved a connection to it. */
export type SessionMcpEndpointHandlers = Readonly<{
    /** The Session whose Agent tree the kernel peer proof admits (`currentSessionHolderScope()` at start). */
    holderScope: object;
    handleRequest: (request: IncomingMessage, response: ServerResponse) => unknown;
    handleUpgrade: (request: IncomingMessage, socket: Socket, head: Buffer) => unknown;
}>;

export type SessionMcpEndpointRegistration = Readonly<{
    /** This Session's private context: the host endpoint and this Session's own bearer. */
    readonly localContext: SessionMcpLocalContext | undefined;
    /** The Agent-visible context file (the endpoint only, no bearer); shared by the endpoint's Sessions. */
    readonly contextFilePath: string | undefined;
    readonly url: string | undefined;
    /**
     * Stops dispatching to this Session: its bearer is retired and its connections close. The last
     * Session closes the listener; a failed physical removal stays retryable through this call.
     */
    retire: () => Promise<void>;
}>;

type Registration = {
    readonly bearer: ReturnType<typeof createLocalMcpBearer>;
    readonly holderScope: object;
    readonly agentUid: number | undefined;
    readonly handleRequest: SessionMcpEndpointHandlers['handleRequest'];
    readonly handleUpgrade: SessionMcpEndpointHandlers['handleUpgrade'];
    readonly sockets: Set<Socket>;
    retired: boolean;
};

type Endpoint = {
    readonly key: string;
    readonly agentUid: number | undefined;
    readonly transport: SessionMcpLocalTransport;
    readonly server: Server;
    readonly sessions: Set<Registration>;
    closing: Promise<void> | undefined;
};

/**
 * One Session MCP endpoint per host process and Agent identity (owner ruling 2026-11-12 (5)): a
 * session host serving N Sessions keeps one listener (one Unix socket per Agent uid, or on Windows
 * one 127.0.0.1 port), not one per Session. Each request and relay upgrade is dispatched to exactly
 * one registered Session, resolved only from the connection: the Session's own bearer, or on the
 * Unix socket a kernel-proven peer in exactly one Session's Agent tree running as that Session's
 * Agent uid. Nothing a client sends selects the Session; a tool request naming another Session is
 * refused by the bound Session's own checks. Anything unresolved or ambiguous is refused.
 *
 * Isolated Agent uids keep their own socket and ACL grants (`prepareSessionMcpLocalTransport`), so
 * filesystem reach is unchanged: one uid never reaches another uid's socket. The listener
 * transport's own bearer admits nothing here; only Session bearers do.
 */
const endpoints = new Map<string, Promise<Endpoint>>();

function endpointKey(transport: SessionMcpLocalTransportOptions | undefined): string {
    return transport ? JSON.stringify(['unix', transport.agentUid, transport.runtimeRoot ?? null]) : 'loopback';
}

async function openEndpoint(key: string, options: SessionMcpLocalTransportOptions | undefined): Promise<Endpoint> {
    const transport = options ? await prepareSessionMcpLocalTransport(options) : await prepareSessionMcpLoopbackTransport();
    const sessions = new Set<Registration>();
    // Peer proof runs once per connection; a connection keeps the Session it was proven for.
    const peerSessions = new WeakMap<Socket, Promise<Registration | null>>();
    const resolve = async (socket: Socket, authorization: string | undefined): Promise<Registration | null> => {
        if (authorization !== undefined) {
            for (const session of sessions) if (session.bearer.authenticate(authorization)) return session;
        }
        if (!options) return null;
        let proven = peerSessions.get(socket);
        if (!proven) {
            proven = resolveSessionMcpAgentPeer(socket, [...sessions]).catch(() => null);
            peerSessions.set(socket, proven);
        }
        const session = await proven;
        return session && !session.retired ? session : null;
    };
    const attach = (session: Registration, socket: Socket) => {
        if (session.sockets.has(socket)) return;
        session.sockets.add(socket);
        socket.once('close', () => session.sockets.delete(socket));
    };
    const server = createServer((request, response) => {
        void (async () => {
            const session = await resolve(request.socket, request.headers.authorization);
            if (!session || session.retired) {
                response.writeHead(401, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'unauthorized' }));
                return;
            }
            attach(session, request.socket);
            await session.handleRequest(request, response);
        })().catch(() => {
            if (!response.headersSent) response.writeHead(500);
            response.end();
        });
    });
    server.on('upgrade', (request: IncomingMessage, socket: Socket, head: Buffer) => {
        socket.on('error', () => undefined);
        void (async () => {
            const session = await resolve(socket, request.headers.authorization);
            if (!session || session.retired) {
                refuseSessionMcpRelayUpgrade(socket);
                return;
            }
            attach(session, socket);
            await session.handleUpgrade(request, socket, head);
        })().catch(() => socket.destroy());
    });
    try {
        await transport.listen(server);
    } catch (error) {
        await transport.retire().catch(() => undefined);
        throw error;
    }
    return { key, agentUid: options?.agentUid, transport, server, sessions, closing: undefined };
}

async function closeEndpoint(endpoint: Endpoint): Promise<void> {
    endpoint.closing ??= (async () => {
        // The Unix transport accepts through its own front (`prepareSessionMcpLocalTransport`), closed by
        // `retire`; connections no Session claimed close here, as every connection did before.
        endpoint.server.closeAllConnections();
        if (endpoint.server.listening) await new Promise<void>(resolve => endpoint.server.close(() => resolve()));
        await endpoint.transport.retire();
    })().catch((error: unknown) => {
        // Revoked authority stays revoked; a failed physical removal is retried by the next retire.
        endpoint.closing = undefined;
        throw error;
    });
    await endpoint.closing;
}

/**
 * Registers one Session on its host endpoint (opening the endpoint for the first Session of this
 * Agent identity). The handlers run in the registering Session's async context (its hosted Session
 * scope, server binding and invocation stores), never the context of the Session that opened the
 * shared listener.
 */
export async function registerSessionMcpEndpointSession(
    transportOptions: SessionMcpLocalTransportOptions | undefined,
    handlers: SessionMcpEndpointHandlers,
): Promise<SessionMcpEndpointRegistration> {
    const key = endpointKey(transportOptions);
    let opening: Promise<Endpoint>;
    let endpoint: Endpoint;
    // A Session never joins an endpoint its last Session is already closing.
    for (;;) {
        let current = endpoints.get(key);
        if (!current) {
            const created = openEndpoint(key, transportOptions);
            current = created;
            endpoints.set(key, created);
            void created.catch(() => { if (endpoints.get(key) === created) endpoints.delete(key); });
        }
        const opened = await current;
        if (endpoints.get(key) === current && !opened.closing) {
            opening = current;
            endpoint = opened;
            break;
        }
    }
    const bearer = createLocalMcpBearer();
    // The Windows loopback bearer reaches the relay's MCP client config; redact it while it is live.
    const unregisterTranscriptSecret = transportOptions ? () => {} : registerTranscriptSecret(bearer.token);
    const session: Registration = {
        bearer, holderScope: handlers.holderScope, agentUid: transportOptions?.agentUid,
        handleRequest: AsyncResource.bind(handlers.handleRequest),
        handleUpgrade: AsyncResource.bind(handlers.handleUpgrade),
        sockets: new Set(), retired: false,
    };
    endpoint.sessions.add(session);
    const endpointContext = endpoint.transport.localContext;
    const localContext: SessionMcpLocalContext | undefined = !endpointContext ? undefined
        : 'socketPath' in endpointContext ? Object.freeze({ v: 1, socketPath: endpointContext.socketPath, bearerToken: bearer.token })
            : Object.freeze({ v: 1, url: endpointContext.url, bearerToken: bearer.token });
    const retire = async (): Promise<void> => {
        if (!session.retired) {
            session.retired = true;
            bearer.retire();
            unregisterTranscriptSecret();
            endpoint.sessions.delete(session);
            for (const socket of session.sockets) socket.destroy();
            session.sockets.clear();
            if (endpoint.sessions.size === 0 && endpoints.get(key) === opening) endpoints.delete(key);
        }
        if (endpoint.sessions.size === 0 && endpoints.get(key) !== opening) await closeEndpoint(endpoint);
    };
    return {
        get localContext() { return session.retired ? undefined : localContext; },
        get contextFilePath() { return session.retired ? undefined : endpoint.transport.contextFilePath; },
        get url() { return session.retired ? undefined : endpoint.transport.url; },
        retire,
    };
}
