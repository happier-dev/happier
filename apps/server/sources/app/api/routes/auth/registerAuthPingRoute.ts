import { z } from "zod";
import { type Fastify } from "../../types";

export function registerAuthPingRoute(app: Fastify): void {
    app.get(
        "/v1/auth/ping",
        {
            preHandler: [
                async (_request, reply) => {
                    reply.header("Cache-Control", "no-store");
                },
                app.authenticate,
            ],
            schema: {
                response: {
                    200: z.object({ ok: z.literal(true) }),
                },
            },
        },
        async (_request, reply) => {
            return reply.send({ ok: true });
        },
    );
}
