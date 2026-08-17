import { z } from "zod";

import { buildUpdateSessionUpdate, eventRouter } from "@/app/events/eventRouter";
import { checkSessionAccess, requireAccessLevel } from "@/app/share/accessControl";
import { markSessionParticipantsChanged } from "@/app/session/changeTracking/markSessionParticipantsChanged";
import { clearSessionRuntimeActivityProjectionInTx } from "@/app/session/sessionWriteService";
import { inTx } from "@/storage/inTx";
import { didSessionActivityBadgeContributionChange } from "@/app/activity/accountActivityBadge";
import { refreshSessionParticipantBadgePushes } from "@/app/activity/refreshAccountActivityBadgePushes";
import {
    loadSessionTranscriptPublicationRecipientProjection,
    projectSessionTranscriptPublicationRealtimeProjection,
    SESSION_TRANSCRIPT_PUBLICATION_SELECT,
} from "@/app/session/sessionTranscriptPublicationPolicy";
import { randomKeyNaked } from "@/utils/keys/randomKeyNaked";
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
                select: {
                    id: true,
                    ...SESSION_TRANSCRIPT_PUBLICATION_SELECT,
                    pendingCount: true,
                    pendingBlockedCount: true,
                    lastViewedSessionSeq: true,
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

            const updated = await tx.session.update({
                where: { id: sessionId },
                data: { archivedAt: new Date() },
                select: { archivedAt: true },
            });
            const runtimeActivityClear = await clearSessionRuntimeActivityProjectionInTx({ tx, sessionId });

            const archivedAt = updated.archivedAt?.getTime();
            if (!archivedAt) {
                return { ok: false as const, error: "not-found" as const };
            }
            const participantCursors = await markSessionParticipantsChanged({
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
                participantCursors,
                badgeAttentionChanged: didSessionActivityBadgeContributionChange(session, {
                    ...session,
                    archivedAt: new Date(archivedAt),
                }),
            };
        });

        if (!res.ok) {
            if (res.error === "not-found") return reply.code(404).send({ error: "Session not found" });
            if (res.error === "session-active") return reply.code(409).send({ error: "session-active" });
            return reply.code(404).send({ error: "Session not found" });
        }

        await refreshSessionParticipantBadgePushes({
            badgeAttentionChanged: res.badgeAttentionChanged,
            participantCursors: res.participantCursors,
        });
        const session = await loadSessionTranscriptPublicationRecipientProjection(sessionId);
        if (session) {
            await Promise.all(res.participantCursors.map(async ({ accountId, cursor }) => {
                const projection = projectSessionTranscriptPublicationRealtimeProjection(
                    res.projection,
                    session,
                    accountId,
                );
                if (projection.kind === "suppress") return;
                const payload = buildUpdateSessionUpdate(
                    sessionId,
                    cursor,
                    randomKeyNaked(12),
                    undefined,
                    undefined,
                    projection.value,
                );
                eventRouter.emitUpdate({
                    userId: accountId,
                    payload,
                    recipientFilter: { type: "all-interested-in-session", sessionId },
                });
                eventRouter.emitUpdate({
                    userId: accountId,
                    payload,
                    recipientFilter: { type: "user-machine-scoped-only" },
                });
            }));
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
                select: {
                    id: true,
                    ...SESSION_TRANSCRIPT_PUBLICATION_SELECT,
                    pendingCount: true,
                    pendingBlockedCount: true,
                    lastViewedSessionSeq: true,
                    pendingPermissionRequestCount: true,
                    pendingUserActionRequestCount: true,
                    active: true,
                    archivedAt: true,
                },
            });
            if (!session) {
                return { ok: false as const };
            }

            await tx.session.update({
                where: { id: sessionId },
                data: { archivedAt: null },
                select: { id: true },
            });

            const participantCursors = await markSessionParticipantsChanged({
                tx,
                sessionId,
                hint: { archivedAt: null },
            });
            return {
                ok: true as const,
                participantCursors,
                badgeAttentionChanged: didSessionActivityBadgeContributionChange(session, {
                    ...session,
                    archivedAt: null,
                }),
            };
        });

        if (!res.ok) {
            return reply.code(404).send({ error: "Session not found" });
        }

        await refreshSessionParticipantBadgePushes({
            badgeAttentionChanged: res.badgeAttentionChanged,
            participantCursors: res.participantCursors,
        });
        const session = await loadSessionTranscriptPublicationRecipientProjection(sessionId);
        if (session) await Promise.all(res.participantCursors.map(async ({ accountId, cursor }) => {
            const projection = projectSessionTranscriptPublicationRealtimeProjection(
                { archivedAt: null },
                session,
                accountId,
            );
            if (projection.kind === "suppress") return;
            const payload = buildUpdateSessionUpdate(
                sessionId,
                cursor,
                randomKeyNaked(12),
                undefined,
                undefined,
                projection.value,
            );
            eventRouter.emitUpdate({
                userId: accountId,
                payload,
                recipientFilter: { type: "all-interested-in-session", sessionId },
            });
            eventRouter.emitUpdate({
                userId: accountId,
                payload,
                recipientFilter: { type: "user-machine-scoped-only" },
            });
        }));
        return reply.send({ success: true, archivedAt: null });
    });
}
