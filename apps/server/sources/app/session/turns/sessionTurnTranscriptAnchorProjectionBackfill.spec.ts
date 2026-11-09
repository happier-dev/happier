import { describe, expect, it, vi } from "vitest";

import {
    backfillSessionTurnTranscriptAnchorProjectionPage,
} from "./sessionTurnTranscriptAnchorProjectionBackfill";

const ANCHORED_TURN_JSON = JSON.stringify({
    startUserMessageSeq: 7,
    userMessageSeqs: [7, 9],
    startSeqInclusive: 7,
    endSeqInclusive: 12,
    finalAssistantMessageSeq: 12,
});

const PREDECESSOR_REPLACED_ANCHOR_JSON = JSON.stringify({
    startUserMessageSeq: 20,
    userMessageSeqs: [20, 22],
    startSeqInclusive: 20,
    endSeqInclusive: 24,
    finalAssistantMessageSeq: 24,
});

type ProjectionUpdateArgs = Readonly<{
    where: Readonly<{
        id: string;
        transcriptAnchorsJson: string | null;
        transcriptAnchorProjectionVersion: number;
        transcriptAnchorMinSeq: number | null;
        transcriptAnchorMaxSeq: number | null;
    }>;
    data: Readonly<{
        transcriptAnchorProjectionVersion: 1;
        transcriptAnchorMinSeq: number | null;
        transcriptAnchorMaxSeq: number | null;
    }>;
}>;

describe("backfillSessionTurnTranscriptAnchorProjectionPage", () => {
    it("upgrades an admitted Session historical v0 turn from its persisted anchors", async () => {
        const findMany = vi.fn(async () => [{
            id: "turn-history",
            transcriptAnchorsJson: ANCHORED_TURN_JSON,
            transcriptAnchorProjectionVersion: 0,
            transcriptAnchorMinSeq: null,
            transcriptAnchorMaxSeq: null,
        }]);
        const updateMany = vi.fn(async () => ({ count: 1 }));
        // Prisma is the storage boundary; this fixture exposes only the selected page operations.
        const db = {
            sessionTurn: { findMany, updateMany },
        } as unknown as Parameters<typeof backfillSessionTurnTranscriptAnchorProjectionPage>[0]["db"];

        await expect(backfillSessionTurnTranscriptAnchorProjectionPage({ sessionId: "requested-session", db, limit: 25 })).resolves.toEqual({
            processed: 1,
            updated: 1,
            nextAfterId: null,
        });

        expect(findMany).toHaveBeenCalledWith(expect.objectContaining({
            orderBy: { id: "asc" },
            take: 25,
            select: expect.objectContaining({
                transcriptAnchorsJson: true,
                transcriptAnchorProjectionVersion: true,
                transcriptAnchorMinSeq: true,
                transcriptAnchorMaxSeq: true,
            }),
        }));
        expect(updateMany).toHaveBeenCalledWith({
            where: {
                id: "turn-history",
                transcriptAnchorsJson: ANCHORED_TURN_JSON,
                transcriptAnchorProjectionVersion: 0,
                transcriptAnchorMinSeq: null,
                transcriptAnchorMaxSeq: null,
            },
            data: {
                transcriptAnchorProjectionVersion: 1,
                transcriptAnchorMinSeq: 7,
                transcriptAnchorMaxSeq: 12,
            },
        });
    });

    it("leaves a concurrent capable writer's replacement intact", async () => {
        const staleRow = {
            id: "turn-race",
            transcriptAnchorsJson: ANCHORED_TURN_JSON,
            transcriptAnchorProjectionVersion: 0,
            transcriptAnchorMinSeq: null,
            transcriptAnchorMaxSeq: null,
        };
        const findMany = vi.fn()
            .mockResolvedValueOnce([staleRow])
            .mockResolvedValueOnce([]);
        // A zero-count compare-and-set means the capable writer won after this page read.
        const updateMany = vi.fn(async () => ({ count: 0 }));
        const db = {
            sessionTurn: { findMany, updateMany },
        } as unknown as Parameters<typeof backfillSessionTurnTranscriptAnchorProjectionPage>[0]["db"];

        await expect(backfillSessionTurnTranscriptAnchorProjectionPage({ sessionId: "requested-session", db })).resolves.toMatchObject({
            processed: 1,
            updated: 0,
        });
        await expect(backfillSessionTurnTranscriptAnchorProjectionPage({ sessionId: "requested-session", db })).resolves.toMatchObject({
            processed: 0,
            updated: 0,
        });

        expect(updateMany).toHaveBeenCalledTimes(1);
        expect(updateMany).toHaveBeenCalledWith(expect.objectContaining({
            where: expect.objectContaining({
                transcriptAnchorProjectionVersion: 0,
                transcriptAnchorMinSeq: null,
                transcriptAnchorMaxSeq: null,
            }),
        }));
    });

    it("upgrades malformed historical anchors without inventing a range from row ordering or time", async () => {
        const findMany = vi.fn(async () => [{
            id: "turn-malformed",
            transcriptAnchorsJson: "{not valid JSON",
            transcriptAnchorProjectionVersion: 0,
            transcriptAnchorMinSeq: null,
            transcriptAnchorMaxSeq: null,
        }]);
        const updateMany = vi.fn(async () => ({ count: 1 }));
        const db = {
            sessionTurn: { findMany, updateMany },
        } as unknown as Parameters<typeof backfillSessionTurnTranscriptAnchorProjectionPage>[0]["db"];

        await expect(backfillSessionTurnTranscriptAnchorProjectionPage({ sessionId: "requested-session", db })).resolves.toMatchObject({
            processed: 1,
            updated: 1,
        });
        expect(updateMany).toHaveBeenCalledWith(expect.objectContaining({
            data: {
                transcriptAnchorProjectionVersion: 1,
                transcriptAnchorMinSeq: null,
                transcriptAnchorMaxSeq: null,
            },
        }));
    });
    it("resumes conversion after a concurrent anchor rewrite wins the snapshot predicate", async () => {
        const row = {
            id: "turn-predecessor-update",
            transcriptAnchorsJson: ANCHORED_TURN_JSON,
            transcriptAnchorProjectionVersion: 0,
            transcriptAnchorMinSeq: null as number | null,
            transcriptAnchorMaxSeq: null as number | null,
        };
        const findMany = vi.fn(async () => row.transcriptAnchorProjectionVersion === 0 ? [{ ...row }] : []);
        const updateMany = vi.fn(async ({ where, data }: ProjectionUpdateArgs) => {
            // The database boundary simulates a rewrite committed after the page read.
            if (row.transcriptAnchorsJson === ANCHORED_TURN_JSON) {
                row.transcriptAnchorsJson = PREDECESSOR_REPLACED_ANCHOR_JSON;
            }
            if (
                row.id !== where.id
                || row.transcriptAnchorsJson !== where.transcriptAnchorsJson
                || row.transcriptAnchorProjectionVersion !== where.transcriptAnchorProjectionVersion
                || row.transcriptAnchorMinSeq !== where.transcriptAnchorMinSeq
                || row.transcriptAnchorMaxSeq !== where.transcriptAnchorMaxSeq
            ) {
                return { count: 0 };
            }
            row.transcriptAnchorProjectionVersion = data.transcriptAnchorProjectionVersion;
            row.transcriptAnchorMinSeq = data.transcriptAnchorMinSeq;
            row.transcriptAnchorMaxSeq = data.transcriptAnchorMaxSeq;
            return { count: 1 };
        });
        const db = {
            sessionTurn: { findMany, updateMany },
        } as unknown as Parameters<typeof backfillSessionTurnTranscriptAnchorProjectionPage>[0]["db"];

        await expect(backfillSessionTurnTranscriptAnchorProjectionPage({ sessionId: "requested-session", db })).resolves.toMatchObject({
            updated: 0,
        });
        expect(row).toMatchObject({
            transcriptAnchorProjectionVersion: 0,
            transcriptAnchorMinSeq: null,
            transcriptAnchorMaxSeq: null,
        });

        await expect(backfillSessionTurnTranscriptAnchorProjectionPage({ sessionId: "requested-session", db })).resolves.toMatchObject({
            updated: 1,
        });
        expect(row).toMatchObject({
            transcriptAnchorProjectionVersion: 1,
            transcriptAnchorMinSeq: 20,
            transcriptAnchorMaxSeq: 24,
        });
        await expect(backfillSessionTurnTranscriptAnchorProjectionPage({ sessionId: "requested-session", db })).resolves.toMatchObject({ updated: 0 });
    });
});
