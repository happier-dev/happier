import { describe, expect, it } from "vitest";

import { computeNextDueAtForAutomation } from "./automationSchedulingService";

describe("automationSchedulingService", () => {
    it("computes next due time for interval schedules", () => {
        const now = new Date("2026-02-12T10:00:00.000Z");
        const due = computeNextDueAtForAutomation({
            now,
            scheduleKind: "interval",
            everyMs: 5 * 60_000,
            scheduleExpr: null,
            timezone: null,
        });

        expect(due?.toISOString()).toBe("2026-02-12T10:05:00.000Z");
    });

    it("returns null when everyMs is invalid", () => {
        const due = computeNextDueAtForAutomation({
            now: new Date("2026-02-12T10:00:00.000Z"),
            scheduleKind: "interval",
            everyMs: null,
            scheduleExpr: null,
            timezone: null,
        });

        expect(due).toBeNull();
    });

    it("computes next due time for cron schedules in UTC", () => {
        const now = new Date("2026-02-12T10:00:00.000Z");
        const due = computeNextDueAtForAutomation({
            now,
            scheduleKind: "cron",
            everyMs: null,
            scheduleExpr: "*/5 * * * *",
            timezone: "UTC",
        });

        expect(due?.toISOString()).toBe("2026-02-12T10:05:00.000Z");
    });

});
