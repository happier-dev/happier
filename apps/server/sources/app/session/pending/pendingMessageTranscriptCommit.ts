import { parseSessionMessageRole } from "@/app/session/messageRole/resolveSessionMessageRole";
import {
    validateSessionTranscriptWriteAuthorityInTx,
    writeSessionTranscriptMessageInTx,
    type SessionTranscriptStoragePolicy,
    type SessionTranscriptWriteRejectionCode,
} from "@/app/session/sessionTranscriptWrite";
import type { Tx } from "@/storage/inTx";
import {
    parseSessionMessageDeliveryResolutionV1,
    type SessionEncryptionMode,
    type SessionMessageDeliveryResolutionV1,
    type SessionMessageRole,
} from "@happier-dev/protocol";
import { isDeepStrictEqual } from "node:util";

export type PendingTranscriptMessage = {
    id: string;
    seq: number;
    localId: string;
    messageRole: SessionMessageRole | null;
    content: PrismaJson.SessionMessageContent;
    deliveryResolution: SessionMessageDeliveryResolutionV1 | null;
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
    sessionEncryptionMode: SessionEncryptionMode;
    storagePolicy: SessionTranscriptStoragePolicy;
    localId: string;
    content: PrismaJson.SessionMessageContent;
    messageRole: SessionMessageRole | null;
    deliveryResolution?: SessionMessageDeliveryResolutionV1;
}): Promise<{
    ok: true;
    didWrite: boolean;
    didUpdate: boolean;
    message: PendingTranscriptMessage;
} | {
    ok: false;
    error: "transcript-conflict";
    conflict: "content" | "message-role" | "delivery-resolution";
} | {
    ok: false;
    error: "storage-mode-conflict";
    code: SessionTranscriptWriteRejectionCode;
}> {
    const { sessionId, localId, content, messageRole } = params;
    const authority = await validateSessionTranscriptWriteAuthorityInTx(tx, {
        sessionId,
        writeAuthority: "hosted",
    });
    if (!authority.ok) return authority;

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

        const existingDeliveryResolution = parseSessionMessageDeliveryResolutionV1(existing.deliveryResolution);
        if (existing.deliveryResolution !== null && existingDeliveryResolution === null) {
            return { ok: false, error: "transcript-conflict", conflict: "delivery-resolution" };
        }
        if (
            params.deliveryResolution
            && existingDeliveryResolution
            && !isDeepStrictEqual(existingDeliveryResolution, params.deliveryResolution)
        ) {
            return { ok: false, error: "transcript-conflict", conflict: "delivery-resolution" };
        }

        const needsRoleUpdate = existing.messageRole === null && messageRole !== null;
        const needsDeliveryResolutionUpdate = params.deliveryResolution !== undefined && existingDeliveryResolution === null;
        const row = needsRoleUpdate || needsDeliveryResolutionUpdate
            ? await tx.sessionMessage.update({
                where: { id: existing.id },
                data: {
                    ...(needsRoleUpdate ? { messageRole } : {}),
                    ...(needsDeliveryResolutionUpdate ? { deliveryResolution: params.deliveryResolution } : {}),
                },
                select: { id: true, seq: true, localId: true, messageRole: true, content: true, deliveryResolution: true, createdAt: true, updatedAt: true },
            })
            : existing;

        return {
            ok: true,
            didWrite: false,
            didUpdate: needsRoleUpdate || needsDeliveryResolutionUpdate,
            message: {
                id: row.id,
                seq: row.seq,
                localId: row.localId ?? localId,
                messageRole: parseSessionMessageRole(row.messageRole),
                content: row.content as PrismaJson.SessionMessageContent,
                deliveryResolution: parseSessionMessageDeliveryResolutionV1(row.deliveryResolution),
                createdAt: row.createdAt,
                updatedAt: row.updatedAt,
            },
        };
    }

    const messageCreatedAt = new Date();
    const persisted = await writeSessionTranscriptMessageInTx(tx, {
        sessionId,
        writeAuthority: "hosted",
        sessionEncryptionMode: params.sessionEncryptionMode,
        storagePolicy: params.storagePolicy,
        content,
        localId,
        sidechainId: null,
        messageRole,
        deliveryResolution: params.deliveryResolution,
        createdAt: messageCreatedAt,
        meaningfulActivityAt: messageCreatedAt,
    });
    if (!persisted.ok) {
        return persisted;
    }
    const created = persisted.message;

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
            deliveryResolution: parseSessionMessageDeliveryResolutionV1(created.deliveryResolution),
            createdAt: created.createdAt,
            updatedAt: created.updatedAt,
        },
    };
}
