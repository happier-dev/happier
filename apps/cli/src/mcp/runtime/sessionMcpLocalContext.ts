import { isAbsolute } from 'node:path';
import { z } from 'zod/mini';

export const SESSION_MCP_CONTEXT_FILE_ENV = 'HAPPIER_SESSION_MCP_CONTEXT_FILE';

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

/** Host-private transient authority; no public SDK or persisted representation. */
export const SessionMcpLocalContextSchema = z.strictObject({
    v: z.literal(1),
    socketPath: z.string().check(z.refine(isAbsolute)),
    bearerToken: z.string().check(z.regex(/^[A-Za-z0-9_-]{43}$/u)),
});
export type SessionMcpLocalContext = Readonly<z.infer<typeof SessionMcpLocalContextSchema>>;
