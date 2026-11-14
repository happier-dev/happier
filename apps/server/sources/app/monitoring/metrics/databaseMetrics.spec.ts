import { afterEach, describe, expect, it, vi } from "vitest";

import { createDbMocks, installDbModuleMock } from "@/app/api/testkit/dbMocks";

// The database is the boundary: each `count()` is one `SELECT COUNT(*)` statement.
const dbMocks = createDbMocks({
    account: ["count"],
    session: ["count"],
    sessionMessage: ["count"],
    machine: ["count"],
} as const);
installDbModuleMock({ db: dbMocks.db });

const countStatements = () => [
    dbMocks.db.account.count,
    dbMocks.db.session.count,
    dbMocks.db.sessionMessage.count,
    dbMocks.db.machine.count,
].reduce((total, count) => total + count.mock.calls.length, 0);

describe("database record count gauges", () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    it("count nothing while idle and count each table once per scrape", async () => {
        vi.useFakeTimers();
        dbMocks.reset();
        dbMocks.db.account.count.mockResolvedValue(3);
        dbMocks.db.session.count.mockResolvedValue(5);
        dbMocks.db.sessionMessage.count.mockResolvedValue(7);
        dbMocks.db.machine.count.mockResolvedValue(2);
        const { enableDatabaseRecordCountsOnScrape } = await import("./databaseMetrics");
        const { register } = await import("./registry");

        enableDatabaseRecordCountsOnScrape();
        await vi.advanceTimersByTimeAsync(5 * 60_000);
        expect(countStatements()).toBe(0);

        const scraped = await register.getSingleMetricAsString("database_records_total");
        expect(countStatements()).toBe(4);
        expect(scraped).toContain('database_records_total{table="sessions"} 5');
    });
});
