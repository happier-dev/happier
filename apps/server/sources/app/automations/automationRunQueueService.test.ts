import { describe, expect, it } from "vitest";

import { resolveScheduledRunDueAt } from "./automationRunQueueService";

describe("resolveScheduledRunDueAt", () => {
    it("keeps schedule-based dueAt when nextRunAt is overdue", () => {
        const now = new Date("2026-02-12T10:00:00.000Z");
        const dueAt = resolveScheduledRunDueAt({
            now,
            scheduleKind: "interval",
            everyMs: 60_000,
            scheduleExpr: null,
            timezone: null,
            nextRunAt: new Date("2026-02-12T09:59:00.000Z"),
        });
        expect(dueAt?.toISOString()).toBe("2026-02-12T10:01:00.000Z");
    });
});
