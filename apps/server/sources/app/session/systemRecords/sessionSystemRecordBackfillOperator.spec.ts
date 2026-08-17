import { describe, expect, it, vi } from "vitest";

import {
    parseSessionSystemRecordBackfillOperatorArgs,
    resolveSessionSystemRecordBackfillOperatorProvider,
    runSessionSystemRecordBackfillOperator,
} from "./sessionSystemRecordBackfillOperator";

describe("parseSessionSystemRecordBackfillOperatorArgs", () => {
    it("parses bounded page and time-budget options", () => {
        expect(parseSessionSystemRecordBackfillOperatorArgs([
            "--page-size=250",
            "--time-budget-ms=30000",
        ])).toEqual({ pageSize: 250, timeBudgetMs: 30_000, mode: "coexistence" });
    });

    it("parses the explicit final CONTRACT preflight mode", () => {
        expect(parseSessionSystemRecordBackfillOperatorArgs([
            "--final-contract",
        ])).toEqual({
            pageSize: 100,
            timeBudgetMs: 5 * 60_000,
            mode: "final-contract",
        });
    });

    it("rejects unknown or unsafe options", () => {
        expect(() => parseSessionSystemRecordBackfillOperatorArgs(["--page-size=501"]))
            .toThrow(/page-size/);
        expect(() => parseSessionSystemRecordBackfillOperatorArgs(["--unknown=1"]))
            .toThrow(/unknown/i);
    });
});

describe("resolveSessionSystemRecordBackfillOperatorProvider", () => {
    it("accepts supported providers and rejects misspellings", () => {
        expect(resolveSessionSystemRecordBackfillOperatorProvider(
            { HAPPIER_DB_PROVIDER: "postgresql" },
            "sqlite",
        )).toBe("postgres");
        expect(resolveSessionSystemRecordBackfillOperatorProvider(
            { HAPPY_DB_PROVIDER: "mysql" },
            "postgres",
        )).toBe("mysql");
        expect(() => resolveSessionSystemRecordBackfillOperatorProvider(
            { HAPPIER_DB_PROVIDER: "postgress" },
            "postgres",
        )).toThrow(/Unsupported.*postgress/);
    });
});

describe("runSessionSystemRecordBackfillOperator", () => {
    it("drains bounded pages and audits every populated address before reporting success", async () => {
        const runPage = vi.fn()
            .mockResolvedValueOnce({ processed: 2, updated: 2, nextAfterId: "row-2" })
            .mockResolvedValueOnce({ processed: 0, updated: 0, nextAfterId: null })
            .mockResolvedValueOnce({ processed: 1, updated: 1, nextAfterId: null })
            .mockResolvedValueOnce({ processed: 0, updated: 0, nextAfterId: null });
        const runAuditPage = vi.fn()
            .mockResolvedValueOnce({ processed: 2, nullRows: 0, mismatchedRows: 0, nextAfterId: "row-2" })
            .mockResolvedValueOnce({ processed: 1, nullRows: 0, mismatchedRows: 0, nextAfterId: null });

        const result = await runSessionSystemRecordBackfillOperator({
            pageSize: 2,
            timeBudgetMs: 10_000,
            runPage,
            runAuditPage,
        });

        expect(result).toEqual({
            outcome: "drained",
            pages: 4,
            processed: 3,
            updated: 3,
            audit: {
                pages: 2,
                processed: 3,
                nullRows: 0,
                mismatchedRows: 0,
            },
        });
        expect(runPage).toHaveBeenNthCalledWith(1, { afterId: undefined, limit: 2 });
        expect(runPage).toHaveBeenNthCalledWith(2, { afterId: "row-2", limit: 2 });
        expect(runPage).toHaveBeenNthCalledWith(3, { afterId: undefined, limit: 2 });
        expect(runPage).toHaveBeenNthCalledWith(4, { afterId: undefined, limit: 2 });
        expect(runAuditPage).toHaveBeenNthCalledWith(1, { afterId: undefined, limit: 2 });
        expect(runAuditPage).toHaveBeenNthCalledWith(2, { afterId: "row-2", limit: 2 });
    });

    it("fails verification when a populated row has invalid ownership or derived keys", async () => {
        const runPage = vi.fn().mockResolvedValue({ processed: 0, updated: 0, nextAfterId: null });
        const runAuditPage = vi.fn().mockResolvedValue({
            processed: 3,
            nullRows: 0,
            mismatchedRows: 1,
            nextAfterId: null,
        });

        await expect(runSessionSystemRecordBackfillOperator({
            pageSize: 100,
            timeBudgetMs: 10_000,
            runPage,
            runAuditPage,
        })).resolves.toEqual({
            outcome: "verification_failed",
            pages: 1,
            processed: 0,
            updated: 0,
            audit: {
                pages: 1,
                processed: 3,
                nullRows: 0,
                mismatchedRows: 1,
            },
        });
    });

    it("stops after a bounded pass when the time budget is exhausted", async () => {
        const runPage = vi.fn().mockResolvedValue({
            processed: 1,
            updated: 1,
            nextAfterId: "row-1",
        });
        const nowMs = vi.fn()
            .mockReturnValueOnce(0)
            .mockReturnValueOnce(10);

        await expect(runSessionSystemRecordBackfillOperator({
            pageSize: 1,
            timeBudgetMs: 10,
            nowMs,
            runPage,
        })).resolves.toEqual({
            outcome: "time_budget",
            pages: 1,
            processed: 1,
            updated: 1,
            audit: {
                pages: 0,
                processed: 0,
                nullRows: 0,
                mismatchedRows: 0,
            },
        });
        expect(runPage).toHaveBeenCalledTimes(1);
    });
});
