import { z } from "zod";

import { applySessionReadCursorOperation } from "@/app/session/sessionWriteService";
import { publishSessionReadCursorUpdate } from "@/app/session/readCursor/publishSessionReadCursorUpdate";
import { type Fastify } from "../../types";

const readStateBodySchema = z.object({
    state: z.union([z.literal("read"), z.literal("unread")]),
});

export function registerSessionReadStateRoutes(app: Fastify) {
    app.post("/v2/sessions/:sessionId/read-state", {
        preHandler: app.authenticate,
        schema: {
            params: z.object({ sessionId: z.string() }),
            body: readStateBodySchema,
            response: {
                200: z.object({
                    success: z.literal(true),
                    state: z.union([z.literal("read"), z.literal("unread"), z.literal("empty")]),
                    lastViewedSessionSeq: z.number().int().min(0).nullable(),
                    didChange: z.boolean(),
                }),
                400: z.object({ error: z.literal("invalid-read-state") }),
                403: z.object({ error: z.literal("Forbidden") }),
                404: z.object({ error: z.literal("Session not found") }),
                500: z.object({ error: z.literal("Failed to update session read state") }),
            },
        },
    }, async (request, reply) => {
        const parsedBody = readStateBodySchema.safeParse(request.body);
        if (!parsedBody.success) {
            return reply.code(400).send({ error: "invalid-read-state" });
        }

        const userId = request.userId;
        const { sessionId } = request.params;
        const state = parsedBody.data.state;

        const result = await applySessionReadCursorOperation({
            actorUserId: userId,
            sessionId,
            operation: state === "read" ? { kind: "mark-read" } : { kind: "mark-unread" },
        });

        if (!result.ok) {
            if (result.error === "invalid-params") return reply.code(400).send({ error: "invalid-read-state" });
            if (result.error === "forbidden") return reply.code(403).send({ error: "Forbidden" });
            if (result.error === "session-not-found") return reply.code(404).send({ error: "Session not found" });
            return reply.code(500).send({ error: "Failed to update session read state" });
        }

        await publishSessionReadCursorUpdate({
            sessionId,
            lastViewedSessionSeq: result.lastViewedSessionSeq,
            participantCursors: result.participantCursors,
            badgeAttentionChanged: result.badgeAttentionChanged,
        });

        return reply.send({
            success: true as const,
            state: result.readState,
            lastViewedSessionSeq: result.lastViewedSessionSeq,
            didChange: result.didChange,
        });
    });
}
