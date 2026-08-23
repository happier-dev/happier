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
                409: z.object({
                    error: z.literal('Session delete condition was lost'),
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
            // A lost delete condition means the session still exists and nothing was
            // removed. Answering 404 there told the client the session was gone and
            // invited it to retire local copies of live data.
            if (result.error === 'conflict') {
                return reply.code(409).send({ error: 'Session delete condition was lost' });
            }
            return reply.code(404).send({ error: 'Session not found or not owned by user' });
        }

        return reply.send({ success: true });
    });
}
