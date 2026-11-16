import { decodeSessionStoredContent, withSessionContentSelect } from '@/storage/sessionMachineStoredContent';
import { z } from "zod/mini";
import { SessionArchiveHttpBodyV1Schema } from '@happier-dev/protocol/sessions/control/contract';

import { resolveSessionAccessForOperation } from "@/app/session/access/sessionAccess";
import { readSessionAccessAuthenticationFromRequest } from "@/app/session/access/sessionAccessAuthentication";
import { markSessionProjectionRecipientsChanged } from "@/app/session/changeTracking/markSessionProjectionRecipientsChanged";
import { prepareSessionAccountCursorLocks } from "@/app/session/changeTracking/acquireSessionAccountCursorLocksInTx";
import { clearSessionRuntimeActivityProjectionInTx } from "@/app/session/sessionWriteService";
import { transitionSessionArchiveStateInTx } from "@/app/session/archive/transitionSessionArchiveStateInTx";
import { isAutomationOriginRunPublisherTx } from "@/app/automations/automationTriggerCauseChain";
import { PluginInstallationPublisherProofError, verifyPluginInstallationPublisherHeader } from "@/app/plugins/installations/publisherProof";
import { inTx } from "@/storage/inTx";
import { db } from "@/storage/db";
import { didSessionActivityBadgeSignalChange } from "@/app/activity/accountActivityBadge";
import { SESSION_TRANSCRIPT_PUBLICATION_SELECT } from "@/app/session/sessionTranscriptPublicationPolicy";
import { publishSessionArchiveTransition } from "@/app/session/archive/publishSessionArchiveTransition";
import { resolveSessionAccountChangePublications } from "@/app/session/changeTracking/markAccountChangesForSessionAccounts";
import { log } from "@/utils/logging/log";
import { type Fastify } from "../../types";

export function registerSessionArchiveRoutes(app: Fastify) {
    app.post("/v2/sessions/:sessionId/archive", {
        preHandler: app.authenticate,
        config: {
            apiTokenSessionAction: "session.archive",
            restrictedCredentialBinding: { scope: "session", session: "params.sessionId" },
        },
        schema: {
            params: z.object({ sessionId: z.string() }),
            body: SessionArchiveHttpBodyV1Schema,
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

        const originRunId = request.body?.originRunId;
        let originPublisher: Awaited<ReturnType<typeof verifyPluginInstallationPublisherHeader>> = null;
        if (originRunId !== undefined) {
            try {
                originPublisher = await verifyPluginInstallationPublisherHeader({
                    accountId: userId, request,
                    path: `/v2/sessions/${encodeURIComponent(sessionId)}/archive`, required: true,
                });
            } catch (error) {
                if (!(error instanceof PluginInstallationPublisherProofError)) throw error;
                return reply.code(403).send({ error: "Forbidden" });
            }
            if (!originPublisher) return reply.code(403).send({ error: "Forbidden" });
        }

        const res = await inTx(async (tx) => {
            if (originRunId !== undefined && (!originPublisher || !await isAutomationOriginRunPublisherTx(tx, {
                accountId: userId, machineId: originPublisher.machineId, runId: originRunId,
            }))) return { ok: false as const, error: "unavailable" as const };
            const session = await tx.session.findUnique({
                where: { id: sessionId },
                select: withSessionContentSelect({
                    id: true,
                    ...SESSION_TRANSCRIPT_PUBLICATION_SELECT,
                    pendingCount: true,
                    pendingBlockedCount: true,
                    pendingPermissionRequestCount: true,
                    pendingUserActionRequestCount: true,
                    active: true,
                    archivedAt: true,
                }),
            }).then(decodeSessionStoredContent);
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
                ...(originRunId !== undefined ? { originRunId } : {}),
            });
            if (!updated.didWrite) {
                return { ok: true as const, didWrite: false as const, archivedAt: updated.session.archivedAt!.getTime() };
            }
            const runtimeActivityClear = await clearSessionRuntimeActivityProjectionInTx({ tx, sessionId });

            const archivedAt = updated.session.archivedAt?.getTime();
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
                didWrite: true as const,
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
        }, {
            transactionClass: "session-archive",
            prepare: () => prepareSessionAccountCursorLocks([sessionId], [userId], { includeLifecyclePublications: true }),
        });

        if (!res.ok) {
            if (res.error === "unavailable") return reply.code(403).send({ error: "Forbidden" });
            if (res.error === "not-found") return reply.code(404).send({ error: "Session not found" });
            if (res.error === "session-active") return reply.code(409).send({ error: "session-active" });
            return reply.code(404).send({ error: "Session not found" });
        }

        // The durable mutation owns the receipt. Publication may perform slow
        // reads after commit; it must neither hold nor contradict that receipt.
        reply.send({ success: true, archivedAt: res.archivedAt });
        if (!res.didWrite) return reply;
        log({ module: "session-archive", sessionId, operation: "archive", phase: "committed" }, "Session archive transition committed");
        log({ module: "session-archive", sessionId, operation: "archive", phase: "publication_started" }, "Publishing Session archive transition");
        await publishSessionArchiveTransition({
            sessionId,
            projection: res.projection,
            recipientCursors: resolveSessionAccountChangePublications(res.recipientCursors),
            badgeAttentionChanged: res.badgeAttentionChanged,
        }).then(() => {
            log({ module: "session-archive", sessionId, operation: "archive", phase: "publication_completed" }, "Published Session archive transition");
        }, () => {
            log({ module: "session-archive", level: "warn", sessionId, operation: "archive", phase: "publication_failed" }, "Failed to publish committed Session archive transition");
        });
        return reply;
    });

    app.post("/v2/sessions/:sessionId/unarchive", {
        preHandler: app.authenticate,
        config: {
            apiTokenSessionAction: "session.unarchive",
            restrictedCredentialBinding: { scope: "session", session: "params.sessionId" },
        },
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
            const session = await tx.session.findUnique({
                where: { id: sessionId },
                select: withSessionContentSelect({
                    id: true,
                    ...SESSION_TRANSCRIPT_PUBLICATION_SELECT,
                    pendingCount: true,
                    pendingBlockedCount: true,
                    pendingPermissionRequestCount: true,
                    pendingUserActionRequestCount: true,
                    active: true,
                    archivedAt: true,
                }),
            }).then(decodeSessionStoredContent);
            if (!session) {
                return { ok: false as const, error: "not-found" as const };
            }

            const updated = await transitionSessionArchiveStateInTx({
                tx,
                sessionId,
                wasArchived: session.archivedAt !== null,
                archivedAt: null,
            });
            if (!updated.didWrite) return { ok: true as const, didWrite: false as const };

            const recipientCursors = await markSessionProjectionRecipientsChanged({
                tx,
                sessionId,
                hint: { archivedAt: null },
            });
            return {
                ok: true as const,
                didWrite: true as const,
                recipientCursors,
                badgeAttentionChanged: didSessionActivityBadgeSignalChange(session, {
                    ...session,
                    archivedAt: null,
                }),
            };
        }, {
            transactionClass: "session-unarchive",
            prepare: () => prepareSessionAccountCursorLocks([sessionId], [userId]),
        });

        if (!res.ok) {
            return reply.code(404).send({ error: "Session not found" });
        }

        reply.send({ success: true, archivedAt: null });
        if (!res.didWrite) return reply;
        log({ module: "session-archive", sessionId, operation: "unarchive", phase: "committed" }, "Session archive transition committed");
        log({ module: "session-archive", sessionId, operation: "unarchive", phase: "publication_started" }, "Publishing Session archive transition");
        await publishSessionArchiveTransition({
            sessionId,
            projection: { archivedAt: null },
            recipientCursors: resolveSessionAccountChangePublications(res.recipientCursors),
            badgeAttentionChanged: res.badgeAttentionChanged,
        }).then(() => {
            log({ module: "session-archive", sessionId, operation: "unarchive", phase: "publication_completed" }, "Published Session archive transition");
        }, () => {
            log({ module: "session-archive", level: "warn", sessionId, operation: "unarchive", phase: "publication_failed" }, "Failed to publish committed Session unarchive transition");
        });
        return reply;
    });
}
