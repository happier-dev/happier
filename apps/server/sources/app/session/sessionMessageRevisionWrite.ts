import { decodeStoredSessionMessage } from "@/storage/sessionMessageContent";
import { encodeSessionMessageContentForStorage, toPrismaSessionMessageStoredContent } from "@/storage/sessionMessageContent";
import type { Prisma } from '@prisma/client';

import type { Tx } from '@/storage/inTx';
import { isPrismaErrorCode, prismaRuntime } from '@/storage/prisma';
import { notifySessionTranscriptMutationAfterCommit } from './sessionTranscriptMutationObserver';

export const SESSION_MESSAGE_WRITE_SELECT = {
    id: true, sessionId: true, seq: true, localId: true, sidechainId: true,
    messageRole: true, contentBytes: true, content: true, createdAt: true, updatedAt: true,
    sourceCreatedAt: true, sourceUpdatedAt: true, transcriptObservationProvenance: true,
    inputAdmissionReceipt: true, authorAccountId: true, rowRevision: true,
} as const;

export class SessionMessageRowRevisionRaceError extends Error {
    constructor() {
        super('Session Message mutation lost its row-revision precondition');
        this.name = 'SessionMessageRowRevisionRaceError';
    }
}

/** The existing Message CAS owner serves corrections and explicit historical association enrichment. */
export async function updateSessionMessageAtCurrentRevisionInTx(params: Readonly<{
    tx: Tx;
    id: string;
    rowRevision: bigint;
    data: Omit<Prisma.SessionMessageUncheckedUpdateInput, "content" | "contentBytes"> & { content?: PrismaJson.SessionMessageContent };
}>) {
    const storedContent = params.data.content === undefined ? undefined
        : encodeSessionMessageContentForStorage(params.data.content);
    try {
        const updated = await params.tx.sessionMessage.update({
            where: { id: params.id, rowRevision: params.rowRevision },
            data: {
                ...params.data,
                // Prisma requires its JSON-null sentinel; the generated custom JSON input omits that sentinel type.
                ...(storedContent ? { ...storedContent, content: toPrismaSessionMessageStoredContent(storedContent.content) } : {}),
                // Changed opaque content/delivery cannot retain the previous body's timing proof.
                ...((params.data.content !== undefined || params.data.deliveryResolution !== undefined)
                    && params.data.usageTimingV1 === undefined ? { usageTimingV1: prismaRuntime.DbNull } : {}),
                // A content correction cannot retain publication authority from the old ciphertext.
                ...(params.data.content !== undefined && params.data.surfaceItemReference === undefined
                    ? { surfaceItemReference: prismaRuntime.DbNull } : {}),
            },
            select: SESSION_MESSAGE_WRITE_SELECT,
        }).then(row => decodeStoredSessionMessage(row));
        // Corrections bypass transcript insertion's parent cursor write.
        await params.tx.session.update({
            where: { id: updated.sessionId },
            data: { updatedAt: new Date() },
            select: { id: true },
        });
        notifySessionTranscriptMutationAfterCommit(params.tx, {
            kind: 'upsert',
            message: {
                id: updated.id, sessionId: updated.sessionId, seq: updated.seq,
                createdAtMs: updated.createdAt.getTime(), updatedAtMs: updated.updatedAt.getTime(),
                role: typeof updated.messageRole === 'string' ? updated.messageRole : null,
                content: updated.content,
            },
        });
        return updated;
    } catch (error) {
        if (isPrismaErrorCode(error, 'P2025')) throw new SessionMessageRowRevisionRaceError();
        throw error;
    }
}
