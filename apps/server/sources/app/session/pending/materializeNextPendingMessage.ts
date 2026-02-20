import { markSessionParticipantsChanged, type SessionParticipantCursor } from "@/app/session/changeTracking/markSessionParticipantsChanged";
import { markPendingStateChangedParticipants } from "@/app/session/pending/markPendingStateChangedParticipants";
import { resolveSessionPendingOwnerAccess } from "@/app/session/pending/resolveSessionPendingAccess";
import { inTx, type Tx } from "@/storage/inTx";
import { readEncryptionFeatureEnv } from "@/app/features/catalog/readFeatureEnv";
import { isStoredContentKindAllowedForSessionByStoragePolicy, type SessionStoredContentKind } from "@happier-dev/protocol";

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

    try {
        return await inTx(async (tx) => {
            const sessionModeRow = await tx.session.findUnique({
                where: { id: sessionId },
                select: { encryptionMode: true },
            });
            if (!sessionModeRow) return { ok: false, error: "session-not-found" } as const;
            const sessionEncryptionMode: "e2ee" | "plain" = sessionModeRow.encryptionMode === "plain" ? "plain" : "e2ee";
            const policy = readEncryptionFeatureEnv(process.env);

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
                select: { pendingCount: true, pendingVersion: true },
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
            } as const;
        });
    } catch {
        return { ok: false, error: "internal" };
    }
}
