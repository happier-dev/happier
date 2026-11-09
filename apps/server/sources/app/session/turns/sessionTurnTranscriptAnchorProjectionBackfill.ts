import type { Prisma } from "@prisma/client";
import { inTx } from "@/storage/inTx";

import {
    deriveSessionTurnTranscriptAnchorProjection,
} from "./sessionTurnTranscriptAnchorProjection";

export const SESSION_TURN_TRANSCRIPT_ANCHOR_PROJECTION_BACKFILL_PAGE_MAX = 500;

type BackfillClient = Pick<Prisma.TransactionClient, "sessionTurn">;

type SessionTurnTranscriptAnchorProjectionRow = Readonly<{
    id: string;
    transcriptAnchorsJson: string | null;
    transcriptAnchorProjectionVersion: number;
    transcriptAnchorMinSeq: number | null;
    transcriptAnchorMaxSeq: number | null;
}>;

function resolvePageLimit(value: number | undefined): number {
    return Math.max(
        1,
        Math.min(
            SESSION_TURN_TRANSCRIPT_ANCHOR_PROJECTION_BACKFILL_PAGE_MAX,
            Math.floor(value ?? 100),
        ),
    );
}

async function readProjectionRows(params: Readonly<{
    db: BackfillClient;
    sessionId: string;
    afterId?: string;
    limit: number;
}>): Promise<readonly SessionTurnTranscriptAnchorProjectionRow[]> {
    return await params.db.sessionTurn.findMany({
        where: {
            sessionId: params.sessionId,
            transcriptAnchorProjectionVersion: 0,
            ...(params.afterId === undefined ? {} : { id: { gt: params.afterId } }),
        },
        orderBy: { id: "asc" },
        take: params.limit,
        select: {
            id: true,
            transcriptAnchorsJson: true,
            transcriptAnchorProjectionVersion: true,
            transcriptAnchorMinSeq: true,
            transcriptAnchorMaxSeq: true,
        },
    });
}

/**
 * Derive every scalar only from the current row JSON. The snapshot predicate
 * lets a concurrent capable writer win without this recovery pass restoring a
 * stale projection over its newer anchors.
 */
export async function backfillSessionTurnTranscriptAnchorProjectionPage(params: Readonly<{
    db: BackfillClient;
    sessionId: string;
    afterId?: string;
    limit?: number;
}>): Promise<Readonly<{ processed: number; updated: number; nextAfterId: string | null }>> {
    const limit = resolvePageLimit(params.limit);
    const rows = await readProjectionRows({
        db: params.db,
        sessionId: params.sessionId,
        ...(params.afterId === undefined ? {} : { afterId: params.afterId }),
        limit,
    });
    let updated = 0;

    for (const row of rows) {
        const projection = deriveSessionTurnTranscriptAnchorProjection(row.transcriptAnchorsJson);
        const result = await params.db.sessionTurn.updateMany({
            where: {
                id: row.id,
                transcriptAnchorsJson: row.transcriptAnchorsJson,
                transcriptAnchorProjectionVersion: row.transcriptAnchorProjectionVersion,
                transcriptAnchorMinSeq: row.transcriptAnchorMinSeq,
                transcriptAnchorMaxSeq: row.transcriptAnchorMaxSeq,
            },
            data: projection,
        });
        updated += result.count;
    }

    return {
        processed: rows.length,
        updated,
        nextAfterId: rows.length === limit ? rows.at(-1)?.id ?? null : null,
    };
}

/**
 * Prepare only an admitted Session, outside the transcript read snapshot. Each
 * page commits independently using the converter's existing transaction bound.
 * Current writers publish JSON and v1 scalars together, so the indexed v0 range
 * contains only predecessor rows; interrupted requests resume on their next read.
 */
export async function ensureSessionTurnTranscriptAnchorProjection(sessionId: string, signal?: AbortSignal): Promise<void> {
    let afterId: string | undefined;
    while (true) {
        signal?.throwIfAborted();
        const page = await inTx(tx => backfillSessionTurnTranscriptAnchorProjectionPage({ db: tx, sessionId, afterId }));
        signal?.throwIfAborted();
        if (page.nextAfterId === null) return;
        afterId = page.nextAfterId;
    }
}
