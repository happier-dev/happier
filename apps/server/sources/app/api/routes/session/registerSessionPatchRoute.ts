import { z } from "zod";

import { buildUpdateSessionUpdate, eventRouter } from "@/app/events/eventRouter";
import { patchSession } from "@/app/session/sessionWriteService";
import { randomKeyNaked } from "@/utils/keys/randomKeyNaked";
import { type Fastify } from "../../types";

export function registerSessionPatchRoute(app: Fastify) {
    app.patch('/v2/sessions/:sessionId', {
        preHandler: app.authenticate,
        schema: {
            params: z.object({ sessionId: z.string() }),
            body: z.object({
                metadata: z.object({
                    ciphertext: z.string(),
                    expectedVersion: z.number().int().min(0),
                }).optional(),
                agentState: z.object({
                    ciphertext: z.string().nullable(),
                    expectedVersion: z.number().int().min(0),
                }).optional(),
            }),
            response: {
                200: z.union([
                    z.object({
                        success: z.literal(true),
                        metadata: z.object({ version: z.number() }).optional(),
                        agentState: z.object({ version: z.number() }).optional(),
                    }),
                    z.object({
                        success: z.literal(false),
                        error: z.literal("version-mismatch"),
                        metadata: z.object({ version: z.number(), value: z.string().nullable() }).optional(),
                        agentState: z.object({ version: z.number(), value: z.string().nullable() }).optional(),
                    }),
                ]),
                400: z.object({ error: z.literal("Invalid parameters") }),
                403: z.object({ error: z.literal("Forbidden") }),
                404: z.object({ error: z.literal("Session not found") }),
                500: z.object({ error: z.literal("Failed to update session") }),
            },
        },
    }, async (request, reply) => {
        const userId = request.userId;
        const { sessionId } = request.params;
        const { metadata, agentState } = request.body;

        const result = await patchSession({
            actorUserId: userId,
            sessionId,
            metadata: metadata ? { ciphertext: metadata.ciphertext, expectedVersion: metadata.expectedVersion } : undefined,
            agentState: agentState ? { ciphertext: agentState.ciphertext, expectedVersion: agentState.expectedVersion } : undefined,
        });

        if (!result.ok) {
            if (result.error === "invalid-params") return reply.code(400).send({ error: "Invalid parameters" });
            if (result.error === "forbidden") return reply.code(403).send({ error: "Forbidden" });
            if (result.error === "session-not-found") return reply.code(404).send({ error: "Session not found" });
            if (result.error === "version-mismatch") {
                if (!result.current) {
                    return reply.code(500).send({ error: "Failed to update session" });
                }
                return reply.send({
                    success: false as const,
                    error: "version-mismatch" as const,
                    ...(result.current?.metadata ? { metadata: result.current.metadata } : {}),
                    ...(result.current?.agentState ? { agentState: result.current.agentState } : {}),
                });
            }
            return reply.code(500).send({ error: "Failed to update session" });
        }

        const metadataUpdate = result.metadata ? { value: result.metadata.value, version: result.metadata.version } : undefined;
        const agentStateUpdate = result.agentState ? { value: result.agentState.value, version: result.agentState.version } : undefined;

        await Promise.all(result.participantCursors.map(async ({ accountId, cursor }) => {
            const payload = buildUpdateSessionUpdate(sessionId, cursor, randomKeyNaked(12), metadataUpdate, agentStateUpdate);
            eventRouter.emitUpdate({
                userId: accountId,
                payload,
                recipientFilter: { type: "all-interested-in-session", sessionId },
            });
        }));

        return reply.send({
            success: true as const,
            ...(result.metadata ? { metadata: { version: result.metadata.version } } : {}),
            ...(result.agentState ? { agentState: { version: result.agentState.version } } : {}),
        });
    });
}
