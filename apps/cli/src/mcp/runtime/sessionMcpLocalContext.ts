import { isAbsolute } from 'node:path';
import { z } from 'zod/mini';

export const SESSION_MCP_CONTEXT_FILE_ENV = 'HAPPIER_SESSION_MCP_CONTEXT_FILE';
/** Windows loopback only: the relay's bearer, carried in its MCP client config env, never the Agent env. */
export const SESSION_MCP_BEARER_ENV = 'HAPPIER_SESSION_MCP_BEARER';

export class SessionMcpUnavailableError extends Error {
    readonly code: 'mcp_socket_access_unavailable' | 'not_authenticated';
    readonly phase?: 'context_read' | 'client_connect';
    readonly httpStatus?: number;
    constructor(code: 'mcp_socket_access_unavailable' | 'not_authenticated' = 'mcp_socket_access_unavailable',
        diagnostic?: Readonly<{ phase: 'context_read' | 'client_connect'; httpStatus?: number }>) {
        // MCP forwards Error.message to the native client. Keep that projection
        // content-free: never include the context path, bearer or response body.
        super([diagnostic?.phase, diagnostic?.httpStatus === undefined ? undefined
            : `httpStatus=${diagnostic.httpStatus}`, code].filter(Boolean).join(' '));
        this.code = code;
        this.phase = diagnostic?.phase;
        this.httpStatus = diagnostic?.httpStatus;
        this.name = 'SessionMcpUnavailableError';
    }
}

/** No Session MCP transport reaches this caller (a detached run, a process outside a Session); not an authentication verdict. */
export function sessionActionTransportUnavailable(): Readonly<{ ok: false; errorCode: 'action_transport_unavailable'; error: string }> {
    return { ok: false, errorCode: 'action_transport_unavailable', error: 'No Session Action transport is available for this caller.' };
}

const SessionMcpBearerTokenSchema = z.string().check(z.regex(/^[A-Za-z0-9_-]{43}$/u));

/**
 * Host-private transient authority; no public SDK or persisted representation. A Unix socket
 * (owner-only, optionally granted to an isolated uid) where the platform supports it; otherwise
 * (Windows) a 127.0.0.1 endpoint. The bearer admits out-of-tree consumers (plugin services); the
 * Unix socket also admits this Session's Agent tree by kernel peer proof without it.
 */
export const SessionMcpLocalContextSchema = z.union([
    z.strictObject({
        v: z.literal(1),
        socketPath: z.string().check(z.refine(isAbsolute)),
        bearerToken: SessionMcpBearerTokenSchema,
    }),
    z.strictObject({
        v: z.literal(1),
        url: z.string().check(z.refine(value => /^http:\/\/127\.0\.0\.1:\d{1,5}\/?$/u.test(value))),
        bearerToken: SessionMcpBearerTokenSchema,
    }),
]);
export type SessionMcpLocalContext = Readonly<z.infer<typeof SessionMcpLocalContextSchema>>;

/**
 * The context an Agent can read (`HAPPIER_SESSION_MCP_CONTEXT_FILE`, isolated launch material):
 * the endpoint only. A context still carrying a bearer (an out-of-tree consumer's copy) parses.
 */
export const SessionMcpAgentContextSchema = z.union([
    z.strictObject({
        v: z.literal(1),
        socketPath: z.string().check(z.refine(isAbsolute)),
        bearerToken: z.optional(SessionMcpBearerTokenSchema),
    }),
    z.strictObject({
        v: z.literal(1),
        url: z.string().check(z.refine(value => /^http:\/\/127\.0\.0\.1:\d{1,5}\/?$/u.test(value))),
        bearerToken: z.optional(SessionMcpBearerTokenSchema),
    }),
]);
export type SessionMcpAgentContext = Readonly<z.infer<typeof SessionMcpAgentContextSchema>>;

/** The single projection from the host context to what the Agent may read: no bearer. */
export function agentVisibleSessionMcpContext(context: SessionMcpLocalContext): SessionMcpAgentContext {
    return 'socketPath' in context ? Object.freeze({ v: 1, socketPath: context.socketPath })
        : Object.freeze({ v: 1, url: context.url });
}
