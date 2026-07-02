import {
    SessionTurnMutationReceiptV1Schema,
    SessionTurnMutationV1Schema,
    SessionTurnsProjectionV1Schema,
} from "@happier-dev/protocol";
import { z } from "zod";

import { checkSessionAccess } from "@/app/share/accessControl";
import { parseStoredSessionTurns, type SessionTurnStoredRow } from "@/app/session/turns/parseSessionTurnState";
import { applySessionTurnMutation } from "@/app/session/sessionWriteService";
import { publishSessionTurnMutationUpdate } from "@/app/session/turns/publishSessionTurnMutationUpdate";
import { db } from "@/storage/db";
import { type Fastify } from "../../types";

export function registerSessionTurnMutationRoute(app: Fastify) {
    app.post("/v1/sessions/:sessionId/turns/mutations", {
        preHandler: app.authenticate,
        schema: {
            params: z.object({ sessionId: z.string() }),
            body: SessionTurnMutationV1Schema,
            response: {
                200: z.object({
                    success: z.literal(true),
                    applied: z.boolean(),
                    reason: z.string().optional(),
                    receipt: SessionTurnMutationReceiptV1Schema,
                }),
                400: z.object({ error: z.literal("Invalid parameters") }),
                403: z.object({ error: z.literal("Forbidden") }),
                404: z.object({ error: z.literal("Session not found") }),
                500: z.object({ error: z.literal("Failed to update session") }),
            },
        },
    }, async (request, reply) => {
        const userId = request.userId;
        const { sessionId } = request.params;
        const parsed = SessionTurnMutationV1Schema.safeParse(request.body);
        if (!parsed.success || parsed.data.sessionId !== sessionId) {
            return reply.code(400).send({ error: "Invalid parameters" });
        }

        const result = await applySessionTurnMutation({
            actorUserId: userId,
            mutation: parsed.data,
        });

        if (!result.ok) {
            if (result.error === "invalid-params") return reply.code(400).send({ error: "Invalid parameters" });
            if (result.error === "forbidden") return reply.code(403).send({ error: "Forbidden" });
            if (result.error === "session-not-found") return reply.code(404).send({ error: "Session not found" });
            return reply.code(500).send({ error: "Failed to update session" });
        }

        await publishSessionTurnMutationUpdate({
            sessionId,
            actorUserId: userId,
            result,
        });

        return reply.send({
            success: true as const,
            applied: result.didApply,
            ...(result.reason ? { reason: result.reason } : {}),
            receipt: result.receipt,
        });
    });

    app.get("/v1/sessions/:sessionId/turns", {
        preHandler: app.authenticate,
        schema: {
            params: z.object({ sessionId: z.string() }),
            response: {
                200: SessionTurnsProjectionV1Schema,
                404: z.object({ error: z.literal("Session not found") }),
            },
        },
    }, async (request, reply) => {
        const userId = request.userId;
        const { sessionId } = request.params;
        const access = await checkSessionAccess(userId, sessionId);
        if (!access) {
            return reply.code(404).send({ error: "Session not found" });
        }

        const session = await db.session.findUnique({
            where: { id: sessionId },
            select: {
                latestTurnId: true,
                updatedAt: true,
            },
        });
        if (!session) {
            return reply.code(404).send({ error: "Session not found" });
        }

        const rows = await db.sessionTurn.findMany({
            where: { sessionId },
            orderBy: [{ updatedAt: "asc" }, { createdAt: "asc" }],
        }) as SessionTurnStoredRow[];

        return reply.send({
            v: 1 as const,
            sessionId,
            ...(session.latestTurnId ? { latestTurnId: session.latestTurnId } : {}),
            updatedAt: session.updatedAt.getTime(),
            turns: parseStoredSessionTurns(rows),
        });
    });
}
