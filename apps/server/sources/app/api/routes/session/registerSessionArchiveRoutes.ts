import { z } from "zod";

import { checkSessionAccess, requireAccessLevel } from "@/app/share/accessControl";
import { markSessionParticipantsChanged } from "@/app/session/changeTracking/markSessionParticipantsChanged";
import { inTx } from "@/storage/inTx";
import { type Fastify } from "../../types";

export function registerSessionArchiveRoutes(app: Fastify) {
    app.post("/v2/sessions/:sessionId/archive", {
        preHandler: app.authenticate,
        schema: {
            params: z.object({ sessionId: z.string() }),
            response: {
                200: z.object({ success: z.literal(true), archivedAt: z.number() }),
                403: z.object({ error: z.literal("Forbidden") }),
                404: z.object({ error: z.literal("Session not found") }),
                409: z.object({ error: z.literal("session-active") }),
            },
        },
    }, async (request, reply) => {
        const userId = request.userId;
        const { sessionId } = request.params;

        const access = await checkSessionAccess(userId, sessionId);
        if (!access || !requireAccessLevel(access, "admin")) {
            return reply.code(403).send({ error: "Forbidden" });
        }

        const res = await inTx(async (tx) => {
            const session = await tx.session.findUnique({
                where: { id: sessionId },
                select: { id: true, active: true },
            });
            if (!session) {
                return { ok: false as const, error: "not-found" as const };
            }
            if (session.active) {
                return { ok: false as const, error: "session-active" as const };
            }

            const updated = await tx.session.update({
                where: { id: sessionId },
                data: { archivedAt: new Date() },
                select: { archivedAt: true },
            });

            await markSessionParticipantsChanged({ tx, sessionId });

            const archivedAt = updated.archivedAt?.getTime();
            if (!archivedAt) {
                return { ok: false as const, error: "not-found" as const };
            }
            return { ok: true as const, archivedAt };
        });

        if (!res.ok) {
            if (res.error === "not-found") return reply.code(404).send({ error: "Session not found" });
            if (res.error === "session-active") return reply.code(409).send({ error: "session-active" });
            return reply.code(404).send({ error: "Session not found" });
        }

        return reply.send({ success: true, archivedAt: res.archivedAt });
    });

    app.post("/v2/sessions/:sessionId/unarchive", {
        preHandler: app.authenticate,
        schema: {
            params: z.object({ sessionId: z.string() }),
            response: {
                200: z.object({ success: z.literal(true), archivedAt: z.null() }),
                403: z.object({ error: z.literal("Forbidden") }),
                404: z.object({ error: z.literal("Session not found") }),
            },
        },
    }, async (request, reply) => {
        const userId = request.userId;
        const { sessionId } = request.params;

        const access = await checkSessionAccess(userId, sessionId);
        if (!access || !requireAccessLevel(access, "admin")) {
            return reply.code(403).send({ error: "Forbidden" });
        }

        const res = await inTx(async (tx) => {
            const session = await tx.session.findUnique({
                where: { id: sessionId },
                select: { id: true },
            });
            if (!session) {
                return { ok: false as const };
            }

            await tx.session.update({
                where: { id: sessionId },
                data: { archivedAt: null },
                select: { id: true },
            });

            await markSessionParticipantsChanged({ tx, sessionId });
            return { ok: true as const };
        });

        if (!res.ok) {
            return reply.code(404).send({ error: "Session not found" });
        }

        return reply.send({ success: true, archivedAt: null });
    });
}

