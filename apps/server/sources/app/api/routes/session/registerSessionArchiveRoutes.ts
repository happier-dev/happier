import { z } from "zod";

import { assertSessionCapabilityInTx, resolveSessionAccessForOperation } from "@/app/session/access/sessionAccess";
import { readSessionAccessAuthenticationFromRequest } from "@/app/session/access/sessionAccessAuthentication";
import { markSessionProjectionRecipientsChanged } from "@/app/session/changeTracking/markSessionProjectionRecipientsChanged";
import { clearSessionRuntimeActivityProjectionInTx } from "@/app/session/sessionWriteService";
import { transitionSessionArchiveStateInTx } from "@/app/session/archive/transitionSessionArchiveStateInTx";
import { inTx } from "@/storage/inTx";
import { db } from "@/storage/db";
import { didSessionActivityBadgeSignalChange } from "@/app/activity/accountActivityBadge";
import { SESSION_TRANSCRIPT_PUBLICATION_SELECT } from "@/app/session/sessionTranscriptPublicationPolicy";
import { publishSessionArchiveTransition } from "@/app/session/archive/publishSessionArchiveTransition";
import { type Fastify } from "../../types";

export function registerSessionArchiveRoutes(app: Fastify) {
    app.post("/v2/sessions/:sessionId/archive", {
        preHandler: app.authenticate,
        schema: {
            params: z.object({ sessionId: z.string() }),
            response: {
                200: z.object({ success: z.literal(true), archivedAt: z.number() }),
                403: z.union([z.object({ error: z.literal("Forbidden") }), z.object({ error: z.literal("team_authentication_required") })]),
                404: z.object({ error: z.literal("Session not found") }),
                409: z.object({ error: z.literal("session-active") }),
                503: z.object({ error: z.literal("team_authentication_unavailable") }),
            },
        },
    }, async (request, reply) => {
        const userId = request.userId;
        const { sessionId } = request.params;

        const authentication = readSessionAccessAuthenticationFromRequest(request);
        const admission = await resolveSessionAccessForOperation(db, {
            accountId: userId,
            sessionId,
            authentication,
            capability: "archiveSession",
        });
        if (admission.status === "authentication_required") return reply.code(403).send({ error: "team_authentication_required" });
        if (admission.status === "authentication_unavailable") return reply.code(503).send({ error: "team_authentication_unavailable" });
        if (admission.status !== "allowed" || !admission.access.capabilities.archiveSession) {
            return reply.code(403).send({ error: "Forbidden" });
        }

        const res = await inTx(async (tx) => {
            const authority = await assertSessionCapabilityInTx({ tx, accountId: userId, sessionId, capability: "archiveSession", authentication });
            if (!authority.ok) return { ok: false as const, error: authority.reason };
            const session = await tx.session.findUnique({
                where: { id: sessionId },
                select: {
                    id: true,
                    ...SESSION_TRANSCRIPT_PUBLICATION_SELECT,
                    pendingCount: true,
                    pendingBlockedCount: true,
                    pendingPermissionRequestCount: true,
                    pendingUserActionRequestCount: true,
                    active: true,
                    archivedAt: true,
                },
            });
            if (!session) {
                return { ok: false as const, error: "not-found" as const };
            }
            if (session.active) {
                return { ok: false as const, error: "session-active" as const };
            }

            const updated = await transitionSessionArchiveStateInTx({
                tx,
                sessionId,
                wasArchived: session.archivedAt !== null,
                archivedAt: new Date(),
            });
            const runtimeActivityClear = await clearSessionRuntimeActivityProjectionInTx({ tx, sessionId });

            const archivedAt = updated.archivedAt?.getTime();
            if (!archivedAt) {
                return { ok: false as const, error: "not-found" as const };
            }
            const recipientCursors = await markSessionProjectionRecipientsChanged({
                tx,
                sessionId,
                hint: { archivedAt },
            });
            return {
                ok: true as const,
                archivedAt,
                projection: {
                    archivedAt,
                    ...(runtimeActivityClear.didWrite ? runtimeActivityClear.projection : {}),
                },
                recipientCursors,
                badgeAttentionChanged: didSessionActivityBadgeSignalChange(session, {
                    ...session,
                    archivedAt: new Date(archivedAt),
                }),
            };
        });

        if (!res.ok) {
            if (res.error === "authentication_required") return reply.code(403).send({ error: "team_authentication_required" });
            if (res.error === "authentication_unavailable") return reply.code(503).send({ error: "team_authentication_unavailable" });
            if (res.error === "unavailable") return reply.code(403).send({ error: "Forbidden" });
            if (res.error === "not-found") return reply.code(404).send({ error: "Session not found" });
            if (res.error === "session-active") return reply.code(409).send({ error: "session-active" });
            return reply.code(404).send({ error: "Session not found" });
        }

        await publishSessionArchiveTransition({
            sessionId,
            projection: res.projection,
            recipientCursors: res.recipientCursors,
            badgeAttentionChanged: res.badgeAttentionChanged,
        });
        return reply.send({ success: true, archivedAt: res.archivedAt });
    });

    app.post("/v2/sessions/:sessionId/unarchive", {
        preHandler: app.authenticate,
        schema: {
            params: z.object({ sessionId: z.string() }),
            response: {
                200: z.object({ success: z.literal(true), archivedAt: z.null() }),
                403: z.union([z.object({ error: z.literal("Forbidden") }), z.object({ error: z.literal("team_authentication_required") })]),
                404: z.object({ error: z.literal("Session not found") }),
                503: z.object({ error: z.literal("team_authentication_unavailable") }),
            },
        },
    }, async (request, reply) => {
        const userId = request.userId;
        const { sessionId } = request.params;

        const authentication = readSessionAccessAuthenticationFromRequest(request);
        const admission = await resolveSessionAccessForOperation(db, {
            accountId: userId,
            sessionId,
            authentication,
            capability: "archiveSession",
        });
        if (admission.status === "authentication_required") return reply.code(403).send({ error: "team_authentication_required" });
        if (admission.status === "authentication_unavailable") return reply.code(503).send({ error: "team_authentication_unavailable" });
        if (admission.status !== "allowed" || !admission.access.capabilities.archiveSession) {
            return reply.code(403).send({ error: "Forbidden" });
        }

        const res = await inTx(async (tx) => {
            const authority = await assertSessionCapabilityInTx({ tx, accountId: userId, sessionId, capability: "archiveSession", authentication });
            if (!authority.ok) return { ok: false as const, error: authority.reason };
            const session = await tx.session.findUnique({
                where: { id: sessionId },
                select: {
                    id: true,
                    ...SESSION_TRANSCRIPT_PUBLICATION_SELECT,
                    pendingCount: true,
                    pendingBlockedCount: true,
                    pendingPermissionRequestCount: true,
                    pendingUserActionRequestCount: true,
                    active: true,
                    archivedAt: true,
                },
            });
            if (!session) {
                return { ok: false as const, error: "not-found" as const };
            }

            await transitionSessionArchiveStateInTx({
                tx,
                sessionId,
                wasArchived: session.archivedAt !== null,
                archivedAt: null,
            });

            const recipientCursors = await markSessionProjectionRecipientsChanged({
                tx,
                sessionId,
                hint: { archivedAt: null },
            });
            return {
                ok: true as const,
                recipientCursors,
                badgeAttentionChanged: didSessionActivityBadgeSignalChange(session, {
                    ...session,
                    archivedAt: null,
                }),
            };
        });

        if (!res.ok) {
            if (res.error === "authentication_required") return reply.code(403).send({ error: "team_authentication_required" });
            if (res.error === "authentication_unavailable") return reply.code(503).send({ error: "team_authentication_unavailable" });
            if (res.error === "unavailable") return reply.code(403).send({ error: "Forbidden" });
            return reply.code(404).send({ error: "Session not found" });
        }

        await publishSessionArchiveTransition({
            sessionId,
            projection: { archivedAt: null },
            recipientCursors: res.recipientCursors,
            badgeAttentionChanged: res.badgeAttentionChanged,
        });
        return reply.send({ success: true, archivedAt: null });
    });
}
