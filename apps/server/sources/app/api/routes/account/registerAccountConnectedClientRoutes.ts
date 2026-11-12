import {
    CONNECTED_CLIENT_ROUTES,
    ConnectedClientSeenRequestSchema,
    ConnectedClientsResponseSchema,
} from "@happier-dev/protocol";
import { z } from "zod";
import { type Fastify } from "../../types";
import { resolveApiHotEndpointRateLimit } from "@/app/api/utils/apiRateLimitCatalog";
import { connectedClientSeen } from "@/app/account/connectedClients/connectedClientSeen";
import { connectedClientList } from "@/app/account/connectedClients/connectedClientList";

/** Connected-client liveness: clients report when they are seen and read it for the device list. */
export function registerAccountConnectedClientRoutes(app: Fastify) {
    const rateLimit = resolveApiHotEndpointRateLimit(process.env, "account.connectedClients");

    app.post(CONNECTED_CLIENT_ROUTES.seen, {
        preHandler: app.authenticate,
        config: { rateLimit },
        schema: {
            body: ConnectedClientSeenRequestSchema,
            response: { 200: z.object({ ok: z.literal(true) }) },
        },
    }, async (request, reply) => {
        await connectedClientSeen({ uid: request.userId }, request.body.clientId);
        return reply.send({ ok: true });
    });

    app.get(CONNECTED_CLIENT_ROUTES.list, {
        preHandler: app.authenticate,
        config: { rateLimit },
        schema: {
            response: { 200: ConnectedClientsResponseSchema },
        },
    }, async (request, reply) => {
        return reply.send({ clients: await connectedClientList({ uid: request.userId }) });
    });
}
