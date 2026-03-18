import { FastifyBaseLogger, FastifyInstance } from "fastify";
import { ZodTypeProvider } from "fastify-type-provider-zod";
import { IncomingMessage, Server, ServerResponse } from "http";

type SocketClientType = "session-scoped" | "user-scoped" | "machine-scoped";

type SocketSessionScopedBinding = Readonly<{
    sessionId: string;
    machineId: string | null;
    proof: "owner-session" | "machine-access-key";
}>;

export type Fastify = FastifyInstance<
    Server<typeof IncomingMessage, typeof ServerResponse>,
    IncomingMessage,
    ServerResponse<IncomingMessage>,
    FastifyBaseLogger,
    ZodTypeProvider
>;

declare module 'fastify' {
    interface FastifyRequest {
        userId: string;
        startTime?: number;
    }
    interface FastifyInstance {
        authenticate: any;
        forwardRpcForUser: (params: {
            userId: string;
            method: string;
            params: unknown;
            timeoutMs?: number;
        }) => Promise<
            | { ok: true; result: unknown }
            | { ok: false; error: string; errorCode?: string }
        >;
    }
}

declare module "socket.io" {
    interface SocketData {
        userId?: string;
        clientType?: SocketClientType;
        sessionId?: string;
        machineId?: string;
        sessionScopedBinding?: SocketSessionScopedBinding;
    }
}
