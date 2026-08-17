export const MAX_SESSION_TURN_TRANSCRIPT_ANCHOR_PROJECTION_SEQ = 2_147_483_647;

export type SessionTurnTranscriptAnchorProjection = Readonly<{
    transcriptAnchorProjectionVersion: 1;
    transcriptAnchorMinSeq: number | null;
    transcriptAnchorMaxSeq: number | null;
}>;

function parseTranscriptAnchorProjectionJson(value: string | null | undefined): Record<string, unknown> {
    if (!value) return {};
    try {
        const parsed: unknown = JSON.parse(value);
        return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
            ? parsed as Record<string, unknown>
            : {};
    } catch {
        return {};
    }
}

function readTranscriptAnchorProjectionSeq(value: unknown): number | null {
    return typeof value === "number"
        && Number.isSafeInteger(value)
        && value >= 0
        && value <= MAX_SESSION_TURN_TRANSCRIPT_ANCHOR_PROJECTION_SEQ
        ? value
        : null;
}

/**
 * This tolerates malformed predecessor JSON so its scalar result remains a
 * coarse query filter, never a replacement semantic owner for turn anchors.
 */
export function deriveSessionTurnTranscriptAnchorProjection(
    transcriptAnchorsJson: string | null | undefined,
): SessionTurnTranscriptAnchorProjection {
    const anchors = parseTranscriptAnchorProjectionJson(transcriptAnchorsJson);
    let minSeq: number | null = null;
    let maxSeq: number | null = null;
    const observe = (value: unknown) => {
        const seq = readTranscriptAnchorProjectionSeq(value);
        if (seq === null) return;
        minSeq = minSeq === null ? seq : Math.min(minSeq, seq);
        maxSeq = maxSeq === null ? seq : Math.max(maxSeq, seq);
    };

    observe(anchors.startUserMessageSeq);
    observe(anchors.startSeqInclusive);
    observe(anchors.endSeqInclusive);
    observe(anchors.finalAssistantMessageSeq);
    if (Array.isArray(anchors.userMessageSeqs)) {
        for (const userMessageSeq of anchors.userMessageSeqs) {
            observe(userMessageSeq);
        }
    }

    return {
        transcriptAnchorProjectionVersion: 1,
        transcriptAnchorMinSeq: minSeq,
        transcriptAnchorMaxSeq: maxSeq,
    };
}

/**
 * The scalar range is only an index for the persisted anchor owner. A reader
 * must fail closed when the two disagree rather than treating the index as a
 * second source of turn semantics.
 */
export function isSessionTurnTranscriptAnchorProjectionCurrent(params: Readonly<{
    transcriptAnchorsJson: string | null | undefined;
    transcriptAnchorProjectionVersion: number | null | undefined;
    transcriptAnchorMinSeq: number | null | undefined;
    transcriptAnchorMaxSeq: number | null | undefined;
}>): boolean {
    const expected = deriveSessionTurnTranscriptAnchorProjection(params.transcriptAnchorsJson);
    return params.transcriptAnchorProjectionVersion === expected.transcriptAnchorProjectionVersion
        && params.transcriptAnchorMinSeq === expected.transcriptAnchorMinSeq
        && params.transcriptAnchorMaxSeq === expected.transcriptAnchorMaxSeq;
}
