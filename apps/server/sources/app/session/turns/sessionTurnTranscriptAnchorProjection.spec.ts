import { describe, expect, it } from "vitest";

import { deriveSessionTurnTranscriptAnchorProjection } from "./sessionTurnTranscriptAnchorProjection";

describe("deriveSessionTurnTranscriptAnchorProjection", () => {
    it("uses only bounded persisted anchor sequences and never infers a range from unrelated JSON", () => {
        expect(deriveSessionTurnTranscriptAnchorProjection(JSON.stringify({
            startUserMessageSeq: 7,
            userMessageSeqs: [9, -1, 2_147_483_648],
            startSeqInclusive: 8,
            endSeqInclusive: 12,
            finalAssistantMessageSeq: 12,
            unrelatedTimestamp: 1,
        }))).toEqual({
            transcriptAnchorProjectionVersion: 1,
            transcriptAnchorMinSeq: 7,
            transcriptAnchorMaxSeq: 12,
        });
        expect(deriveSessionTurnTranscriptAnchorProjection("{not valid JSON")).toEqual({
            transcriptAnchorProjectionVersion: 1,
            transcriptAnchorMinSeq: null,
            transcriptAnchorMaxSeq: null,
        });
    });
});
