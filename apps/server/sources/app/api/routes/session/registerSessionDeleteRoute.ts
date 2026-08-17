import { z } from "zod";
import { sessionDelete } from "@/app/session/sessionDelete";
import { type Fastify } from "../../types";

export function registerSessionDeleteRoute(app: Fastify) {
    app.delete('/v1/sessions/:sessionId', {
        schema: {
            params: z.object({
                sessionId: z.string()
            }),
            response: {
                200: z.object({ success: z.literal(true) }),
                404: z.object({
                    error: z.literal(
                        'Session not found or not owned by user',
                    ),
                }),
            },
        },
        preHandler: app.authenticate
    }, async (request, reply) => {
        const userId = request.userId;
        const { sessionId } = request.params;
        const result = await sessionDelete(
            { uid: userId },
            sessionId,
        );

        if (!result.ok) {
            return reply.code(404).send({ error: 'Session not found or not owned by user' });
        }

        return reply.send({ success: true });
    });
}
