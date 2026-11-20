import { decodeStoredSessionMessage } from "@/storage/sessionMessageContent";
import { encodeSessionMessageContentForStorage, toPrismaSessionMessageStoredContent } from "@/storage/sessionMessageContent";
import type { Prisma } from '@prisma/client';
import { prepareSessionMessageToolOutputForWrite, type SessionMessageToolOutputWrite } from '@/storage/sessionMessageToolOutput';

import {
    acquireSessionAccountCursorLocksInTx,
    prepareSessionAccountCursorLocks,
} from '@/app/session/changeTracking/acquireSessionAccountCursorLocksInTx';
import { markSessionProjectionRecipientsChanged } from '@/app/session/changeTracking/markSessionProjectionRecipientsChanged';
import { inTx, type Tx } from '@/storage/inTx';
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

export class SessionMessageToolOutputAlreadyExpiredError extends Error {
    readonly code = 'session_tool_output_already_expired';

    constructor() {
        super('An expired Session tool output cannot be replaced by a content correction');
        this.name = 'SessionMessageToolOutputAlreadyExpiredError';
    }
}

/** The existing Message CAS owner serves corrections and explicit historical association enrichment. */
export async function updateSessionMessageAtCurrentRevisionInTx(params: Readonly<{
    tx: Tx;
    id: string;
    rowRevision: bigint;
    toolOutput?: SessionMessageToolOutputWrite;
    data: Omit<Prisma.SessionMessageUncheckedUpdateInput, "content" | "contentBytes" | "toolOutputBytes" | "toolOutputExpiredAfterDays"> & { content?: PrismaJson.SessionMessageContent };
}>) {
    const storedContent = params.data.content === undefined ? undefined
        : encodeSessionMessageContentForStorage(params.data.content);
    const toolOutputBytes = params.data.content === undefined ? null
        : prepareSessionMessageToolOutputForWrite(params.data.content, params.toolOutput);
    try {
        const updated = await params.tx.sessionMessage.update({
            where: {
                id: params.id,
                rowRevision: params.rowRevision,
                ...(storedContent ? { toolOutputExpiredAfterDays: null } : {}),
                ...(params.toolOutput ? { sessionId: params.toolOutput.sessionId, localId: params.toolOutput.localId } : {}),
            },
            data: {
                ...params.data,
                // Prisma requires its JSON-null sentinel; the generated custom JSON input omits that sentinel type.
                ...(storedContent ? {
                    ...storedContent,
                    content: toPrismaSessionMessageStoredContent(storedContent.content),
                    toolOutputBytes,
                } : {}),
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
        if (!isPrismaErrorCode(error, 'P2025')) throw error;
        if (storedContent && await params.tx.sessionMessage.findFirst({
            where: { id: params.id, toolOutputExpiredAfterDays: { not: null } },
            select: { id: true },
        })) {
            throw new SessionMessageToolOutputAlreadyExpiredError();
        }
        throw new SessionMessageRowRevisionRaceError();
    }
}

/** Clear only detached bytes under the same revision precondition as content corrections. */
export async function expireSessionMessageToolOutputAtRevision(params: Readonly<{
    id: string;
    sessionId: string;
    seq: number;
    rowRevision: bigint;
    updatedAt: Date;
    cutoff: Date;
    now: Date;
    days: number;
}>): Promise<boolean> {
    const sessionIds = [params.sessionId];
    const updatedAt = new Date(Math.max(params.now.getTime(), params.updatedAt.getTime() + 1));
    return inTx(async tx => {
        await acquireSessionAccountCursorLocksInTx(tx, sessionIds, [], { reuseHeldAudience: true });
        const result = await tx.sessionMessage.updateMany({
            where: {
                id: params.id,
                sessionId: params.sessionId,
                rowRevision: params.rowRevision,
                createdAt: { lt: params.cutoff },
                toolOutputBytes: { not: null },
                toolOutputExpiredAfterDays: null,
            },
            data: {
                toolOutputBytes: null,
                toolOutputExpiredAfterDays: params.days,
                rowRevision: { increment: 1n },
                updatedAt,
            },
        });
        if (result.count !== 1) return false;

        await markSessionProjectionRecipientsChanged({
            tx,
            sessionId: params.sessionId,
            hint: { updatedMessageSeq: params.seq, updatedMessageId: params.id, updatedMessageUpdatedAt: updatedAt.getTime() },
            followSourceChanged: false,
            usageAccountingChanged: false,
            memoryInputsChanged: false,
        });
        return true;
    }, {
        transactionClass: 'tool-output-retention',
        prepare: () => prepareSessionAccountCursorLocks(sessionIds),
    });
}
