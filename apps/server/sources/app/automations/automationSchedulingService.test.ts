import { describe, expect, it } from "vitest";

import {
    computeNextDueAtForAutomation,
    shouldEnqueueNextRunForTerminalState,
} from "./automationSchedulingService";

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

    it("computes next due time for cron schedules using timezone", () => {
        // 2026-02-12 in America/New_York is UTC-5.
        // At 13:00Z it's 08:00 local. Next local 09:00 should be 14:00Z.
        const now = new Date("2026-02-12T13:00:00.000Z");
        const due = computeNextDueAtForAutomation({
            now,
            scheduleKind: "cron",
            everyMs: null,
            scheduleExpr: "0 9 * * *",
            timezone: "America/New_York",
        });

        expect(due?.toISOString()).toBe("2026-02-12T14:00:00.000Z");
    });

    it("enqueues follow-up runs only for terminal states", () => {
        expect(shouldEnqueueNextRunForTerminalState("succeeded")).toBe(true);
        expect(shouldEnqueueNextRunForTerminalState("failed")).toBe(true);
        expect(shouldEnqueueNextRunForTerminalState("cancelled")).toBe(true);
        expect(shouldEnqueueNextRunForTerminalState("running")).toBe(false);
    });
});
