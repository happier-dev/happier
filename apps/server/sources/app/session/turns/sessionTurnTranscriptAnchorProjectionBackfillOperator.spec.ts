import { describe, expect, it, vi } from "vitest";

import {
    parseSessionTurnTranscriptAnchorProjectionBackfillOperatorArgs,
    runSessionTurnTranscriptAnchorProjectionBackfillOperator,
} from "./sessionTurnTranscriptAnchorProjectionBackfillOperator";

describe("parseSessionTurnTranscriptAnchorProjectionBackfillOperatorArgs", () => {
    it("accepts only bounded page and time-budget options", () => {
        expect(parseSessionTurnTranscriptAnchorProjectionBackfillOperatorArgs([
            "--page-size=250",
            "--time-budget-ms=30000",
        ])).toEqual({ pageSize: 250, timeBudgetMs: 30_000, mode: "coexistence" });
        expect(() => parseSessionTurnTranscriptAnchorProjectionBackfillOperatorArgs([
            "--page-size=501",
        ])).toThrow(/page-size/);
    });
});

describe("runSessionTurnTranscriptAnchorProjectionBackfillOperator", () => {
    it("restarts from the beginning once, then audits the factual v1 state before reporting drained", async () => {
        const runPage = vi.fn()
            .mockResolvedValueOnce({ processed: 1, updated: 1, nextAfterId: null })
            .mockResolvedValueOnce({ processed: 1, updated: 0, nextAfterId: null });
        const runAuditPage = vi.fn().mockResolvedValue({
            processed: 1,
            legacyRows: 0,
            mismatchedRows: 0,
            nextAfterId: null,
        });

        await expect(runSessionTurnTranscriptAnchorProjectionBackfillOperator({
            pageSize: 100,
            timeBudgetMs: 10_000,
            runPage,
            runAuditPage,
        })).resolves.toEqual({
            outcome: "drained",
            pages: 2,
            processed: 2,
            updated: 1,
            audit: {
                pages: 1,
                processed: 1,
                legacyRows: 0,
                mismatchedRows: 0,
            },
        });

        expect(runPage).toHaveBeenNthCalledWith(1, { afterId: undefined, limit: 100 });
        expect(runPage).toHaveBeenNthCalledWith(2, { afterId: undefined, limit: 100 });
    });

    it("can be interrupted and safely repeated without retaining a cursor", async () => {
        const interruptedRunPage = vi.fn().mockResolvedValue({
            processed: 1,
            updated: 1,
            nextAfterId: "turn-1",
        });
        const nowMs = vi.fn()
            .mockReturnValueOnce(0)
            .mockReturnValueOnce(10);

        await expect(runSessionTurnTranscriptAnchorProjectionBackfillOperator({
            pageSize: 1,
            timeBudgetMs: 10,
            nowMs,
            runPage: interruptedRunPage,
        })).resolves.toMatchObject({ outcome: "time_budget", pages: 1, updated: 1 });

        const resumedRunPage = vi.fn()
            .mockResolvedValueOnce({ processed: 1, updated: 0, nextAfterId: null })
            .mockResolvedValueOnce({ processed: 1, updated: 0, nextAfterId: null });
        const resumedAuditPage = vi.fn().mockResolvedValue({
            processed: 1,
            legacyRows: 0,
            mismatchedRows: 0,
            nextAfterId: null,
        });
        await expect(runSessionTurnTranscriptAnchorProjectionBackfillOperator({
            pageSize: 1,
            timeBudgetMs: 10_000,
            runPage: resumedRunPage,
            runAuditPage: resumedAuditPage,
        })).resolves.toMatchObject({ outcome: "drained", updated: 0 });
    });

    it("honors cancellation before reading another backfill page", async () => {
        const controller = new AbortController();
        controller.abort();
        const runPage = vi.fn();

        await expect(runSessionTurnTranscriptAnchorProjectionBackfillOperator({
            pageSize: 100,
            timeBudgetMs: 10_000,
            signal: controller.signal,
            runPage,
        })).resolves.toMatchObject({ outcome: "aborted", pages: 0 });
        expect(runPage).not.toHaveBeenCalled();
    });

    it("aborts when cancellation fires while a clean final audit page is awaited", async () => {
        const controller = new AbortController();
        const runPage = vi.fn()
            .mockResolvedValueOnce({ processed: 1, updated: 1, nextAfterId: null })
            .mockResolvedValueOnce({ processed: 1, updated: 0, nextAfterId: null });
        const runAuditPage = vi.fn(async () => {
            controller.abort();
            return {
                processed: 1,
                legacyRows: 0,
                mismatchedRows: 0,
                nextAfterId: null,
            };
        });

        await expect(runSessionTurnTranscriptAnchorProjectionBackfillOperator({
            pageSize: 100,
            timeBudgetMs: 10_000,
            signal: controller.signal,
            runPage,
            runAuditPage,
        })).resolves.toMatchObject({
            outcome: "aborted",
            pages: 2,
            audit: { pages: 0, processed: 0, legacyRows: 0, mismatchedRows: 0 },
        });
        expect(runAuditPage).toHaveBeenCalledTimes(1);
    });
});
