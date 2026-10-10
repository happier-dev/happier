import { buildSessionAccessWhere } from "@/app/session/access/sessionAccessWhere";
import {
    SessionTurnMutationReceiptV1Schema,
    SessionTurnMutationV1Schema,
    SessionTurnsProjectionV1Schema,
} from "@happier-dev/protocol";
import { z } from "zod";

import { readSessionAccessAuthenticationFromRequest } from "@/app/session/access/sessionAccessAuthentication";
import {
    isExternalShareableSessionTurnVisible,
    isSessionTranscriptShareable,
    loadSessionTranscriptPublication,
    resolveSessionTranscriptNonOwnerRecencyMs,
} from "@/app/session/sessionTranscriptPublicationPolicy";
import {
    parseStoredSessionTurns,
    type SessionTurnStoredRow,
} from "@/app/session/turns/parseSessionTurnState";
import { applySessionTurnMutation } from "@/app/session/sessionWriteService";
import { publishSessionTurnMutationUpdate } from "@/app/session/turns/publishSessionTurnMutationUpdate";
import { inTx } from "@/storage/inTx";
import { type Fastify } from "../../types";
import { PRESENT_USER_REQUIRED_ERROR } from "@/app/api/utils/apiTokenRouteAdmission";

export function registerSessionTurnMutationRoute(app: Fastify) {
    app.post("/v1/sessions/:sessionId/turns/mutations", {
        preHandler: app.authenticate,
        config: { restrictedCredentialBinding: { scope: "session", session: "params.sessionId" } },
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
                400: z.object({
                    error: z.literal("Invalid parameters"),
                    code: z.string().optional(),
                }),
                403: z.union([
                    z.object({ error: z.literal("Forbidden") }),
                    z.object({ error: z.literal(PRESENT_USER_REQUIRED_ERROR) }),
                ]),
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
            authentication: readSessionAccessAuthenticationFromRequest(request),
        });

        if (!result.ok) {
            if (result.error === "invalid-params") {
                return reply.code(400).send({
                    error: "Invalid parameters",
                    ...(result.code ? { code: result.code } : {}),
                });
            }
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
        config: {
            restrictedCredentialBinding: { scope: "session", session: "params.sessionId" },
            apiTokenSessionAction: "session.transcript.get",
        },
        schema: {
            params: z.object({ sessionId: z.string() }),
            querystring: z.object({}).strict(),
            response: {
                200: SessionTurnsProjectionV1Schema,
                404: z.object({ error: z.literal("Session not found") }),
            },
        },
    }, async (request, reply) => {
        const userId = request.userId;
        const { sessionId } = request.params;
        const authentication = readSessionAccessAuthenticationFromRequest(request);
        const { session, rows, publication, currentlyAccessible } = await inTx(async (tx) => {
            const currentParticipantWhere = { AND: [{ id: sessionId }, await buildSessionAccessWhere({ tx, accountId: userId, capability: 'readTranscript', mode: 'effective_access_v1', authentication })] };
            const rows = await tx.sessionTurn.findMany({
                where: {
                    sessionId,
                    session: currentParticipantWhere,
                },
                orderBy: [{ updatedAt: "asc" }, { createdAt: "asc" }],
            }) as SessionTurnStoredRow[];
            const session = await tx.session.findFirst({
                where: currentParticipantWhere,
                select: {
                    latestTurnId: true,
                    updatedAt: true,
                },
            });
            const publication = await loadSessionTranscriptPublication(tx, sessionId);
            return {
                session,
                rows,
                publication,
                currentlyAccessible: session !== null,
            };
        }, { readOnly: true });
        if (!session || !currentlyAccessible) {
            return reply.code(404).send({ error: "Session not found" });
        }

        const visibleRows = rows.filter((row) =>
            isExternalShareableSessionTurnVisible({ row, publication }));
        const turns = parseStoredSessionTurns(visibleRows);
        const visibleTurnIds = new Set(turns.map((turn) => turn.turnId));
        const updatedAt = isSessionTranscriptShareable(publication)
            ? resolveSessionTranscriptNonOwnerRecencyMs(publication, session.updatedAt)
            : 0;

        return reply.send({
            v: 1 as const,
            sessionId,
            ...(session.latestTurnId && visibleTurnIds.has(session.latestTurnId)
                ? { latestTurnId: session.latestTurnId }
                : {}),
            updatedAt,
            turns,
        });
    });
}
