import { decodeStoredSessionMessages } from "@/storage/sessionMessageContent";
import { PrimaryTurnStatusV1Schema, type PrimaryTurnStatusV1 } from '@happier-dev/protocol/sessions/control/runtimeIssueV1';
import { SessionStoredMessageContentSchema } from '@happier-dev/protocol/sessions/messages/sessionStoredMessageContent';
import { isRecoveredHistoryTranscriptObservationProvenance } from '@happier-dev/protocol/sessions/messages/transcriptObservationV1';

import { db } from "@/storage/db";
import {
    applySessionTranscriptPublicationCeilingToProjection,
    buildSessionMessagePublicationWhere,
    type SessionTranscriptPublicationFields,
} from "@/app/session/sessionTranscriptPublicationPolicy";
import { resolveMessageAttentionImpact } from "@/app/session/messageAttentionImpact";

/**
 * The transcript-scan half of the manual-unread boundary. It lives beside the
 * cursor transition owner so both the viewer read-state owner and the transcript
 * write service consume one implementation instead of each keeping a copy.
 */

export function normalizeReadSeq(value: unknown): number | null {
    return typeof value === "number" && Number.isFinite(value)
        ? Math.max(0, Math.trunc(value))
        : null;
}

export function maxReadSeq(left: number | null, right: number | null): number | null {
    if (left === null) return right;
    if (right === null) return left;
    return Math.max(left, right);
}

export function parseStoredPrimaryTurnStatus(value: unknown): PrimaryTurnStatusV1 | null {
    const parsed = PrimaryTurnStatusV1Schema.safeParse(value);
    return parsed.success ? parsed.data : null;
}

export function isTerminalPrimaryTurnStatus(status: PrimaryTurnStatusV1 | null): boolean {
    return status === "completed" || status === "cancelled" || status === "failed";
}

/**
 * Newest published main-transcript row whose content actually affects unread.
 * Mark unread must land behind a row a human would recognize as new, not behind
 * whatever system row happened to arrive last.
 */
export async function findLatestUnreadAffectingMainTranscriptMessageSeq(
    sessionId: string,
    publication: SessionTranscriptPublicationFields,
): Promise<number | null> {
    const metadataPageSize = 100;
    const contentBatchSize = 100;
    let beforeSeq: number | null = null;
    for (;;) {
        const metadataRows = await db.sessionMessage.findMany({
            where: buildSessionMessagePublicationWhere({
                where: {
                    sessionId,
                    sidechainId: null,
                    ...(beforeSeq === null ? {} : { seq: { lt: beforeSeq } }),
                },
                publication,
            }),
            orderBy: { seq: "desc" },
            take: metadataPageSize,
            select: {
                id: true,
                seq: true,
                transcriptObservationProvenance: true,
            },
        });
        if (!Array.isArray(metadataRows) || metadataRows.length === 0) return null;

        const contentRequiredRows = metadataRows.filter(
            (row) => !isRecoveredHistoryTranscriptObservationProvenance(
                row.transcriptObservationProvenance,
                'stored',
            ),
        );
        for (let offset = 0; offset < contentRequiredRows.length; offset += contentBatchSize) {
            const batch = contentRequiredRows.slice(offset, offset + contentBatchSize);
            const contentRows = await db.sessionMessage.findMany({
                where: buildSessionMessagePublicationWhere({
                    where: {
                        sessionId,
                        sidechainId: null,
                        id: { in: batch.map((row) => row.id) },
                    },
                    publication,
                }),
                select: { contentBytes: true, id: true, content: true, localId: true },
            }).then(row => decodeStoredSessionMessages(row));
            const contentById = new Map(contentRows.map((row) => [row.id, row]));
            for (const row of batch) {
                const stored = contentById.get(row.id);
                const content = SessionStoredMessageContentSchema.safeParse(stored?.content);
                if (!content.success) return normalizeReadSeq(row.seq);
                if (resolveMessageAttentionImpact({
                    content: content.data,
                    localId: stored?.localId ?? null,
                }).affectsUnread) {
                    return normalizeReadSeq(row.seq);
                }
            }
        }
        if (metadataRows.length < metadataPageSize) return null;
        beforeSeq = normalizeReadSeq(metadataRows[metadataRows.length - 1]?.seq);
        if (beforeSeq === null) return null;
    }
}

export function resolveManualUnreadReadableSessionSeq(
    latestMainMessageSeq: number | null,
    session: Readonly<{
        seq?: number | null;
        latestReadyEventSeq?: number | null;
        latestTurnStatus?: unknown;
    }> & SessionTranscriptPublicationFields,
): number {
    const publicationProjection = applySessionTranscriptPublicationCeilingToProjection({
        seq: normalizeReadSeq(session.seq) ?? 0,
        latestReadyEventSeq: normalizeReadSeq(session.latestReadyEventSeq),
    }, session);
    let readableSeq = maxReadSeq(latestMainMessageSeq, normalizeReadSeq(publicationProjection.latestReadyEventSeq));
    if (readableSeq === null && isTerminalPrimaryTurnStatus(parseStoredPrimaryTurnStatus(session.latestTurnStatus))) {
        readableSeq = publicationProjection.seq;
    }
    return readableSeq ?? publicationProjection.seq;
}
