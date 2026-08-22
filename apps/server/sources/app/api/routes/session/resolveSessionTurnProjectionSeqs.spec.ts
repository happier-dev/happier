import { describe, expect, it } from "vitest";

import {
    resolveSessionTurnProjectionSeqs,
    type SessionTurnProjectionTurnRow,
} from "./resolveSessionTurnProjectionSeqs";

/**
 * The rail needs each prompt plus that turn's final reply, and nothing else.
 *
 * The interesting cases are all about what the materialised anchors DO NOT guarantee: a turn
 * still running has no final reply, a legacy or malformed anchor blob has nothing usable, and a
 * multi-prompt turn has several anchors. Getting any of those wrong pairs a prompt with the
 * wrong reply, which is worse than fetching too much.
 */

function turn(anchors: Record<string, unknown> | null, range?: Readonly<{ min: number; max: number }>): SessionTurnProjectionTurnRow {
    return {
        transcriptAnchorsJson: anchors === null ? null : JSON.stringify(anchors),
        transcriptAnchorMinSeq: range?.min ?? null,
        transcriptAnchorMaxSeq: range?.max ?? null,
    };
}

describe("session turn projection seqs", () => {
    it("returns each prompt with its turn's final reply, and nothing in between", () => {
        // The rows between the prompt and the final reply are exactly what the old fetch
        // transferred and decrypted to discard.
        const result = resolveSessionTurnProjectionSeqs({
            turnRows: [
                turn({ startUserMessageSeq: 10, finalAssistantMessageSeq: 19 }),
                turn({ startUserMessageSeq: 1, finalAssistantMessageSeq: 7 }),
            ],
            turnLimit: 10,
        });

        expect(result.seqs).toEqual([1, 7, 10, 19]);
        expect(result.hasMore).toBe(false);
        expect(result.nextBeforeSeq).toBeNull();
    });

    it("keeps a prompt whose turn has not produced a reply yet", () => {
        const result = resolveSessionTurnProjectionSeqs({
            turnRows: [turn({ startUserMessageSeq: 42, finalAssistantMessageSeq: null })],
            turnLimit: 10,
        });

        expect(result.seqs).toEqual([42]);
    });

    it("keeps every prompt of a multi-prompt turn", () => {
        const result = resolveSessionTurnProjectionSeqs({
            turnRows: [turn({ userMessageSeqs: [3, 5, 8], finalAssistantMessageSeq: 12 })],
            turnLimit: 10,
        });

        expect(result.seqs).toEqual([3, 5, 8, 12]);
    });

    it("does not duplicate a seq recorded as both the start prompt and in the prompt list", () => {
        const result = resolveSessionTurnProjectionSeqs({
            turnRows: [turn({ startUserMessageSeq: 4, userMessageSeqs: [4, 6], finalAssistantMessageSeq: 9 })],
            turnLimit: 10,
        });

        expect(result.seqs).toEqual([4, 6, 9]);
    });

    it("contributes nothing for an anchor blob that is missing or unreadable", () => {
        // A legacy turn carries no v1 anchors. It must not throw and must not invent seqs;
        // the route decides separately whether such a session may use the projection at all.
        const result = resolveSessionTurnProjectionSeqs({
            turnRows: [turn(null), turn({}), { transcriptAnchorsJson: "{not json", transcriptAnchorMinSeq: null, transcriptAnchorMaxSeq: null }],
            turnLimit: 10,
        });

        expect(result.seqs).toEqual([]);
    });

    it("reports more when the extra probe turn came back, and pages below the oldest prompt kept", () => {
        const result = resolveSessionTurnProjectionSeqs({
            turnRows: [
                turn({ startUserMessageSeq: 30, finalAssistantMessageSeq: 33 }),
                turn({ startUserMessageSeq: 20, finalAssistantMessageSeq: 24 }),
                // The probe turn beyond the limit: proves there is more, contributes nothing.
                turn({ startUserMessageSeq: 10, finalAssistantMessageSeq: 14 }),
            ],
            turnLimit: 2,
        });

        expect(result.seqs).toEqual([20, 24, 30, 33]);
        expect(result.hasMore).toBe(true);
        // Strictly below the oldest prompt kept, so the next page cannot re-return it.
        expect(result.nextBeforeSeq).toBe(20);
    });

    it("stops paging when the last page is not full", () => {
        const result = resolveSessionTurnProjectionSeqs({
            turnRows: [turn({ startUserMessageSeq: 5, finalAssistantMessageSeq: 6 })],
            turnLimit: 10,
        });

        expect(result.hasMore).toBe(false);
        expect(result.nextBeforeSeq).toBeNull();
    });
});
