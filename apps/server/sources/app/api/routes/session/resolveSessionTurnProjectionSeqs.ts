import { SessionTurnTranscriptAnchorsV1Schema } from "@happier-dev/protocol";

/**
 * Which message seqs a turn-projection page should return.
 *
 * The transcript navigation rail shows one anchor per prompt with the turn's final reply
 * beneath it. Fetching that by paging raw history means transferring — and DECRYPTING — every
 * reply row of every turn to keep one per turn; measured on remote-dev 2026-08-18, one cold
 * open pulled 630 messages for a transcript that needed 48.
 *
 * This tree does not have to compute turn boundaries to avoid that: `SessionTurn` already
 * MATERIALISES them. `transcriptAnchorsJson` records the prompt seqs and the turn's final
 * assistant seq, and `transcriptAnchorMinSeq`/`MaxSeq` index the range. So the page is a plain
 * seq lookup — no window functions, no raw SQL, and nothing dialect-specific, which is what the
 * predecessor implementation needed only because it had no turn model at all.
 *
 * Anchors are parsed through the canonical protocol schema rather than re-read field by field,
 * so this cannot drift from the writer that produced them.
 */

export type SessionTurnProjectionTurnRow = Readonly<{
    transcriptAnchorsJson: string | null;
    transcriptAnchorMinSeq: number | null;
    transcriptAnchorMaxSeq: number | null;
}>;

export type SessionTurnProjectionSeqs = Readonly<{
    /** Message seqs to fetch, ascending. */
    seqs: readonly number[];
    /** Cursor for the next older page: the lowest anchor seq kept, or null at the end. */
    nextBeforeSeq: number | null;
    hasMore: boolean;
}>;

function parseAnchors(transcriptAnchorsJson: string | null): Readonly<{
    promptSeqs: readonly number[];
    finalAssistantSeq: number | null;
}> {
    if (!transcriptAnchorsJson) return { promptSeqs: [], finalAssistantSeq: null };
    let raw: unknown;
    try {
        raw = JSON.parse(transcriptAnchorsJson);
    } catch {
        return { promptSeqs: [], finalAssistantSeq: null };
    }
    const parsed = SessionTurnTranscriptAnchorsV1Schema.safeParse(raw);
    if (!parsed.success) return { promptSeqs: [], finalAssistantSeq: null };

    const anchors = parsed.data;
    const promptSeqs: number[] = [];
    if (typeof anchors.startUserMessageSeq === "number") promptSeqs.push(anchors.startUserMessageSeq);
    for (const seq of anchors.userMessageSeqs ?? []) {
        if (typeof seq === "number") promptSeqs.push(seq);
    }
    return {
        promptSeqs,
        finalAssistantSeq: typeof anchors.finalAssistantMessageSeq === "number"
            ? anchors.finalAssistantMessageSeq
            : null,
    };
}

/**
 * @param turnRows Newest-first, and deliberately one longer than `turnLimit` so `hasMore` is
 *   observed rather than guessed.
 */
export function resolveSessionTurnProjectionSeqs(params: Readonly<{
    turnRows: readonly SessionTurnProjectionTurnRow[];
    turnLimit: number;
}>): SessionTurnProjectionSeqs {
    const limit = Math.max(0, Math.trunc(params.turnLimit));
    const hasMore = params.turnRows.length > limit;
    const keptTurns = hasMore ? params.turnRows.slice(0, limit) : params.turnRows;

    const seqs = new Set<number>();
    let lowestAnchorSeq: number | null = null;
    for (const turn of keptTurns) {
        const { promptSeqs, finalAssistantSeq } = parseAnchors(turn.transcriptAnchorsJson);
        for (const seq of promptSeqs) {
            seqs.add(seq);
            lowestAnchorSeq = lowestAnchorSeq === null ? seq : Math.min(lowestAnchorSeq, seq);
        }
        // A turn still running has no final reply yet; that is a prompt with no subtitle, not a
        // reason to drop the anchor.
        if (finalAssistantSeq !== null) seqs.add(finalAssistantSeq);
    }

    return {
        seqs: [...seqs].sort((left, right) => left - right),
        // Paging continues below the oldest PROMPT kept, so the next page cannot re-return it.
        nextBeforeSeq: hasMore ? lowestAnchorSeq : null,
        hasMore,
    };
}
