import { markSessionParticipantsChanged, type SessionParticipantCursor } from "@/app/session/changeTracking/markSessionParticipantsChanged";
import { markPendingStateChangedParticipants } from "@/app/session/pending/markPendingStateChangedParticipants";
import { resolveSessionPendingOwnerAccess } from "@/app/session/pending/resolveSessionPendingAccess";
import { inTx, type Tx } from "@/storage/inTx";
import { db } from "@/storage/db";
import { readEncryptionFeatureEnv } from "@/app/features/catalog/readFeatureEnv";
import { isStoredContentKindAllowedForSessionByStoragePolicy, type SessionMessageRole, type SessionStoredContentKind } from "@happier-dev/protocol";
import { didSessionActivityBadgeContributionChange } from "@/app/activity/accountActivityBadge";
import { parseSessionMessageRole, resolveSessionMessageRole } from "@/app/session/messageRole/resolveSessionMessageRole";
import {
    resolveReadyProjectionEventType,
    updateSessionMessageActivityProjection,
    type SessionReadyProjectionUpdate,
} from "@/app/session/sessionWriteService";
import { logger } from "@/utils/logging/log";

type ParticipantCursor = SessionParticipantCursor;

export type MaterializeNextPendingMessageResult =
    | {
        ok: true;
        didMaterialize: false;
        pendingCount: number;
        pendingVersion: number;
      }
    | {
        ok: true;
        didMaterialize: true;
        didWriteMessage: boolean;
        message: { id: string; seq: number; localId: string; messageRole: SessionMessageRole | null; content: PrismaJson.SessionMessageContent; createdAt: Date; updatedAt: Date };
        participantCursorsMessage: ParticipantCursor[];
        participantCursorsPending: ParticipantCursor[];
        pendingCount: number;
        pendingVersion: number;
        meaningfulActivityAt?: Date;
        badgeAttentionChanged: boolean;
        readyProjection?: SessionReadyProjectionUpdate;
      }
    | { ok: false; error: "session-not-found" | "forbidden" | "invalid-params" | "internal" };

function toSessionMessageContentFromPending(content: PrismaJson.SessionPendingMessageContent): PrismaJson.SessionMessageContent {
    return content;
}

async function createSessionMessageFromPending(tx: Tx, params: {
    sessionId: string;
    localId: string;
    messageRole: SessionMessageRole | null;
    content: PrismaJson.SessionMessageContent;
}): Promise<{
    didWrite: boolean;
    message: { id: string; seq: number; localId: string; messageRole: SessionMessageRole | null; content: PrismaJson.SessionMessageContent; createdAt: Date; updatedAt: Date };
}> {
    const { sessionId, localId, messageRole, content } = params;

    const existing = await tx.sessionMessage.findFirst({
        where: { sessionId, localId },
        select: { id: true, seq: true, localId: true, messageRole: true, content: true, createdAt: true, updatedAt: true },
    });
    if (existing && existing.localId) {
        const row = existing.messageRole === null && messageRole !== null
            ? await tx.sessionMessage.update({
                where: { id: existing.id },
                data: { messageRole },
                select: { id: true, seq: true, localId: true, messageRole: true, content: true, createdAt: true, updatedAt: true },
            })
            : existing;

        return {
            didWrite: false,
            message: {
                id: row.id,
                seq: row.seq,
                localId,
                messageRole: parseSessionMessageRole(row.messageRole),
                content: row.content as PrismaJson.SessionMessageContent,
                createdAt: row.createdAt,
                updatedAt: row.updatedAt,
            },
        };
    }

    const messageCreatedAt = new Date();
    const next = await tx.session.update({
        where: { id: sessionId },
        select: { seq: true },
        data: {
            seq: { increment: 1 },
            meaningfulActivityAt: messageCreatedAt,
        },
    });

    const created = await tx.sessionMessage.create({
        data: {
            sessionId,
            seq: next.seq,
            content,
            localId,
            messageRole,
            createdAt: messageCreatedAt,
        },
        select: { id: true, seq: true, localId: true, messageRole: true, content: true, createdAt: true, updatedAt: true },
    });

    return {
        didWrite: true,
        message: {
            id: created.id,
            seq: created.seq,
            localId: created.localId!,
            messageRole: parseSessionMessageRole(created.messageRole),
            content: created.content as PrismaJson.SessionMessageContent,
            createdAt: created.createdAt,
            updatedAt: created.updatedAt,
        },
    };
}

export async function materializeNextPendingMessage(params: {
    actorUserId: string;
    sessionId: string;
}): Promise<MaterializeNextPendingMessageResult> {
    const actorUserId = typeof params.actorUserId === "string" ? params.actorUserId : "";
    const sessionId = typeof params.sessionId === "string" ? params.sessionId : "";

    if (!actorUserId || !sessionId) return { ok: false, error: "invalid-params" };

    const access = await resolveSessionPendingOwnerAccess(actorUserId, sessionId);
    if (!access.ok) return { ok: false, error: access.error };

    const sessionRow = await db.session.findUnique({
        where: { id: sessionId },
        select: {
            encryptionMode: true,
            seq: true,
            pendingCount: true,
            pendingVersion: true,
            lastViewedSessionSeq: true,
            pendingPermissionRequestCount: true,
            pendingUserActionRequestCount: true,
            active: true,
            archivedAt: true,
        },
    });
    if (!sessionRow) return { ok: false, error: "session-not-found" };
    if ((sessionRow.pendingCount ?? 0) <= 0) {
        // pendingCount is a denormalized counter; treat it as a fast-path hint, not a source of truth.
        // If the counter is inconsistent (e.g. race/data corruption), fall back to checking the queue.
        const hasQueued = await db.sessionPendingMessage.findFirst({
            where: { sessionId, status: "queued" },
            orderBy: [{ position: "asc" }, { createdAt: "asc" }, { localId: "asc" }],
            select: { localId: true },
        });
        if (!hasQueued) {
            return {
                ok: true,
                didMaterialize: false,
                pendingCount: sessionRow.pendingCount,
                pendingVersion: sessionRow.pendingVersion,
            };
        }
    }

    const sessionEncryptionMode: "e2ee" | "plain" = sessionRow.encryptionMode === "plain" ? "plain" : "e2ee";
    const policy = readEncryptionFeatureEnv(process.env);

    try {
        const result = await inTx(async (tx) => {
            const sessionBefore = await tx.session.findUniqueOrThrow({
                where: { id: sessionId },
                select: {
                    seq: true,
                    pendingCount: true,
                    pendingVersion: true,
                    lastViewedSessionSeq: true,
                    pendingPermissionRequestCount: true,
                    pendingUserActionRequestCount: true,
                    active: true,
                    archivedAt: true,
                },
            });

            const nextPending = await tx.sessionPendingMessage.findFirst({
                where: { sessionId, status: "queued" },
                orderBy: [{ position: "asc" }, { createdAt: "asc" }, { localId: "asc" }],
                select: { localId: true, messageRole: true, content: true, status: true },
            });

            if (!nextPending) {
                if ((sessionBefore.pendingCount ?? 0) > 0) {
                    await tx.session.updateMany({
                        where: {
                            id: sessionId,
                            pendingCount: sessionBefore.pendingCount,
                            pendingVersion: sessionBefore.pendingVersion,
                        },
                        data: { pendingCount: 0, pendingVersion: { increment: 1 } },
                    });
                    const repaired = await tx.session.findUniqueOrThrow({
                        where: { id: sessionId },
                        select: { pendingCount: true, pendingVersion: true },
                    });
                    return {
                        ok: true,
                        didMaterialize: false,
                        pendingCount: repaired.pendingCount,
                        pendingVersion: repaired.pendingVersion,
                    } as const;
                }

                return {
                    ok: true,
                    didMaterialize: false,
                    pendingCount: sessionBefore.pendingCount,
                    pendingVersion: sessionBefore.pendingVersion,
                } as const;
            }

            const localId = nextPending.localId;
            const content = toSessionMessageContentFromPending(nextPending.content as PrismaJson.SessionPendingMessageContent);
            const messageRole = resolveSessionMessageRole({
                content,
                suppliedRole: nextPending.messageRole,
                telemetry: {
                    sessionId,
                    storageMode: sessionEncryptionMode,
                    source: "pending-materialization",
                },
            }).messageRole;

            const writeKind: SessionStoredContentKind = content.t === "plain" ? "plain" : "encrypted";
            if (!isStoredContentKindAllowedForSessionByStoragePolicy(policy.storagePolicy, sessionEncryptionMode, writeKind)) {
                return { ok: false, error: "invalid-params" } as const;
            }

            const created = await createSessionMessageFromPending(tx, { sessionId, localId, messageRole, content });
            const readyProjection = created.didWrite
                ? await updateSessionMessageActivityProjection(tx, {
                    sessionId,
                    created: created.message,
                    trustedSessionEventType: resolveReadyProjectionEventType({
                        actorUserId,
                        sessionOwnerId: actorUserId,
                        content,
                    }),
                })
                : undefined;

            await tx.sessionPendingMessage.delete({
                where: { sessionId_localId: { sessionId, localId } },
            });

            const didDecrementPendingCount =
                (
                    await tx.session.updateMany({
                        where: { id: sessionId, pendingCount: { gt: 0 } },
                        data: { pendingCount: { decrement: 1 }, pendingVersion: { increment: 1 } },
                    })
                ).count > 0;

            if (!didDecrementPendingCount) {
                await tx.session.updateMany({
                    where: { id: sessionId, pendingCount: { lte: 0 } },
                    data: { pendingCount: 0, pendingVersion: { increment: 1 } },
                });
            }

            const session = await tx.session.findUniqueOrThrow({
                where: { id: sessionId },
                select: {
                    seq: true,
                    pendingCount: true,
                    pendingVersion: true,
                    lastViewedSessionSeq: true,
                    pendingPermissionRequestCount: true,
                    pendingUserActionRequestCount: true,
                    active: true,
                    archivedAt: true,
                },
            });

            const participantCursorsMessage = await markSessionParticipantsChanged({
                tx,
                sessionId,
                hint: { lastMessageSeq: created.message.seq, lastMessageId: created.message.id },
            });
            const participantCursorsPending = await markPendingStateChangedParticipants({
                tx,
                sessionId,
                pendingVersion: session.pendingVersion,
                pendingCount: session.pendingCount,
                meaningfulActivityAt: created.message.createdAt,
            });

            return {
                ok: true,
                didMaterialize: true,
                didWriteMessage: created.didWrite,
                message: created.message,
                participantCursorsMessage,
                participantCursorsPending,
                pendingCount: session.pendingCount,
                pendingVersion: session.pendingVersion,
                meaningfulActivityAt: created.message.createdAt,
                ...(readyProjection ? { readyProjection } : {}),
                badgeAttentionChanged: didSessionActivityBadgeContributionChange(
                    sessionBefore,
                    {
                        seq: session.seq,
                        pendingCount: session.pendingCount,
                        lastViewedSessionSeq: session.lastViewedSessionSeq,
                        pendingPermissionRequestCount: session.pendingPermissionRequestCount,
                        pendingUserActionRequestCount: session.pendingUserActionRequestCount,
                        active: session.active,
                        archivedAt: session.archivedAt,
                    },
                ),
            } as const;
        });
        if (result.ok && result.didMaterialize) {
            logger.debug({
                sessionId,
                didMaterialize: true,
                localId: result.message.localId,
                messageSeq: result.message.seq,
                messageRole: result.message.messageRole,
                didWriteMessage: result.didWriteMessage,
                pendingCount: result.pendingCount,
                pendingVersion: result.pendingVersion,
            }, "session.pending.materialize");
        }
        return result;
    } catch {
        return { ok: false, error: "internal" };
    }
}
