import { parseSessionMessageRole } from "@/app/session/messageRole/resolveSessionMessageRole";
import { stampMissingSessionUnreadSince } from "@/app/session/attention/sessionAttentionFacts";
import type { Tx } from "@/storage/inTx";
import {
    readPendingLocalId,
    type SessionMessageRole,
} from "@happier-dev/protocol";
import { isDeepStrictEqual } from "node:util";

export type PendingTranscriptMessage = {
    id: string;
    seq: number;
    localId: string;
    messageRole: SessionMessageRole | null;
    content: PrismaJson.SessionMessageContent;
    deliveryResolution?: Readonly<{ v: 1; kind: "manual_handled" }> | null;
    createdAt: Date;
    updatedAt: Date;
};

export function resolvePendingTranscriptCompatibility(params: {
    existing: {
        content: unknown;
        messageRole: unknown;
    };
    pending: {
        content: PrismaJson.SessionMessageContent;
        messageRole: SessionMessageRole | null;
    };
}): {
    ok: true;
    existingMessageRole: SessionMessageRole | null;
} | {
    ok: false;
    conflict: "content" | "message-role";
} {
    if (!isDeepStrictEqual(params.existing.content, params.pending.content)) {
        return { ok: false, conflict: "content" };
    }

    const existingMessageRole = parseSessionMessageRole(params.existing.messageRole);
    if (
        existingMessageRole !== null
        && params.pending.messageRole !== null
        && existingMessageRole !== params.pending.messageRole
    ) {
        return { ok: false, conflict: "message-role" };
    }

    return { ok: true, existingMessageRole };
}

export async function createSessionMessageFromPending(tx: Tx, params: {
    sessionId: string;
    localId: string;
    content: PrismaJson.SessionMessageContent;
    messageRole: SessionMessageRole | null;
}): Promise<{
    ok: true;
    didWrite: boolean;
    didUpdate: boolean;
    message: PendingTranscriptMessage;
} | {
    ok: false;
    error: "transcript-conflict";
    conflict: "local-id" | "content" | "message-role";
}> {
    const { sessionId, localId, content, messageRole } = params;
    if (readPendingLocalId(localId) === null) {
        return { ok: false, error: "transcript-conflict", conflict: "local-id" };
    }

    const existing = await tx.sessionMessage.findFirst({
        where: { sessionId, localId },
        select: { id: true, seq: true, localId: true, messageRole: true, content: true, deliveryResolution: true, createdAt: true, updatedAt: true },
    });
    if (existing && existing.localId) {
        const compatibility = resolvePendingTranscriptCompatibility({
            existing,
            pending: { content, messageRole },
        });
        if (!compatibility.ok) return { ok: false, error: "transcript-conflict", conflict: compatibility.conflict };
        const needsRoleUpdate = existing.messageRole === null && messageRole !== null;
        const row = needsRoleUpdate
            ? await tx.sessionMessage.update({
                where: { id: existing.id },
                data: {
                    ...(needsRoleUpdate ? { messageRole } : {}),
                    rowRevision: { increment: 1 },
                },
                select: { id: true, seq: true, localId: true, messageRole: true, content: true, deliveryResolution: true, createdAt: true, updatedAt: true },
            })
            : existing;
        return {
            ok: true,
            didWrite: false,
            didUpdate: needsRoleUpdate,
            message: {
                id: row.id,
                seq: row.seq,
                localId: row.localId ?? localId,
                messageRole: parseSessionMessageRole(row.messageRole),
                content: row.content as PrismaJson.SessionMessageContent,
                deliveryResolution: row.deliveryResolution as PendingTranscriptMessage["deliveryResolution"],
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
        },
    });
    // Materializing a pending message advances `seq` without moving the read cursor, so the session
    // is unread afterwards. `stampMissingSessionUnreadSince` only writes where nothing is stored, so
    // a session that was already unread keeps its original edge instant. The attention flag itself
    // needs no write: `Session.needsAttention` is generated from `seq` and the read cursor, so the
    // `seq` increment above has already moved it.
    await stampMissingSessionUnreadSince({
        client: tx,
        unreadSessionIds: [sessionId],
        now: messageCreatedAt,
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
        select: { id: true, seq: true, localId: true, messageRole: true, content: true, deliveryResolution: true, createdAt: true, updatedAt: true },
    });

    return {
        ok: true,
        didWrite: true,
        didUpdate: false,
        message: {
            id: created.id,
            seq: created.seq,
            localId: created.localId!,
            messageRole: parseSessionMessageRole(created.messageRole),
            content: created.content as PrismaJson.SessionMessageContent,
            deliveryResolution: created.deliveryResolution as PendingTranscriptMessage["deliveryResolution"],
            createdAt: created.createdAt,
            updatedAt: created.updatedAt,
        },
    };
}
