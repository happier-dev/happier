import { markSessionParticipantsChanged, type SessionParticipantCursor } from "@/app/session/changeTracking/markSessionParticipantsChanged";
import { markPendingStateChangedParticipants } from "@/app/session/pending/markPendingStateChangedParticipants";
import { resolveSessionPendingOwnerAccess } from "@/app/session/pending/resolveSessionPendingAccess";
import { inTx, type Tx } from "@/storage/inTx";
import { db } from "@/storage/db";
import { readEncryptionFeatureEnv } from "@/app/features/catalog/readFeatureEnv";
import { isStoredContentKindAllowedForSessionByStoragePolicy, type SessionStoredContentKind } from "@happier-dev/protocol";
import { didSessionActivityBadgeContributionChange } from "@/app/activity/accountActivityBadge";

type ParticipantCursor = SessionParticipantCursor;

export type MaterializeNextPendingMessageResult =
    | {
        ok: true;
        didMaterialize: false;
      }
    | {
        ok: true;
        didMaterialize: true;
        didWriteMessage: boolean;
        message: { id: string; seq: number; localId: string; content: PrismaJson.SessionMessageContent; createdAt: Date; updatedAt: Date };
        participantCursorsMessage: ParticipantCursor[];
        participantCursorsPending: ParticipantCursor[];
        pendingCount: number;
        pendingVersion: number;
        badgeAttentionChanged: boolean;
      }
    | { ok: false; error: "session-not-found" | "forbidden" | "invalid-params" | "internal" };

function toSessionMessageContentFromPending(content: PrismaJson.SessionPendingMessageContent): PrismaJson.SessionMessageContent {
    return content;
}

async function createSessionMessageFromPending(tx: Tx, params: {
    sessionId: string;
    localId: string;
    content: PrismaJson.SessionMessageContent;
}): Promise<{
    didWrite: boolean;
    message: { id: string; seq: number; localId: string; content: PrismaJson.SessionMessageContent; createdAt: Date; updatedAt: Date };
}> {
    const { sessionId, localId, content } = params;

    const existing = await tx.sessionMessage.findFirst({
        where: { sessionId, localId },
        select: { id: true, seq: true, localId: true, content: true, createdAt: true, updatedAt: true },
    });
    if (existing && existing.localId) {
        return {
            didWrite: false,
            message: {
                id: existing.id,
                seq: existing.seq,
                localId: existing.localId,
                content: existing.content as PrismaJson.SessionMessageContent,
                createdAt: existing.createdAt,
                updatedAt: existing.updatedAt,
            },
        };
    }

    const next = await tx.session.update({
        where: { id: sessionId },
        select: { seq: true },
        data: { seq: { increment: 1 } },
    });

    const created = await tx.sessionMessage.create({
        data: {
            sessionId,
            seq: next.seq,
            content,
            localId,
        },
        select: { id: true, seq: true, localId: true, content: true, createdAt: true, updatedAt: true },
    });

    return {
        didWrite: true,
        message: {
            id: created.id,
            seq: created.seq,
            localId: created.localId!,
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
            select: { localId: true },
        });
        if (!hasQueued) {
            return { ok: true, didMaterialize: false };
        }
    }

    const sessionEncryptionMode: "e2ee" | "plain" = sessionRow.encryptionMode === "plain" ? "plain" : "e2ee";
    const policy = readEncryptionFeatureEnv(process.env);

    try {
        return await inTx(async (tx) => {
            const sessionBefore = await tx.session.findUniqueOrThrow({
                where: { id: sessionId },
                select: {
                    seq: true,
                    pendingCount: true,
                    lastViewedSessionSeq: true,
                    pendingPermissionRequestCount: true,
                    pendingUserActionRequestCount: true,
                    active: true,
                    archivedAt: true,
                },
            });

            const nextPending = await tx.sessionPendingMessage.findFirst({
                where: { sessionId, status: "queued" },
                orderBy: [{ position: "asc" }, { createdAt: "asc" }],
                select: { localId: true, content: true, status: true },
            });

            if (!nextPending) {
                return { ok: true, didMaterialize: false } as const;
            }

            const localId = nextPending.localId;
            const content = toSessionMessageContentFromPending(nextPending.content as PrismaJson.SessionPendingMessageContent);

            const writeKind: SessionStoredContentKind = content.t === "plain" ? "plain" : "encrypted";
            if (!isStoredContentKindAllowedForSessionByStoragePolicy(policy.storagePolicy, sessionEncryptionMode, writeKind)) {
                return { ok: false, error: "invalid-params" } as const;
            }

            const created = await createSessionMessageFromPending(tx, { sessionId, localId, content });

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
                await tx.session.update({
                    where: { id: sessionId },
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
    } catch {
        return { ok: false, error: "internal" };
    }
}
