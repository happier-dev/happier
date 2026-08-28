import { describe, expect, it, vi } from "vitest";

import { loadAutomationRetiredTriggerProjections } from "./automationRetiredTriggerProjection";

describe("Automation retired-trigger projection", () => {
    it("batch-projects only minimal tombstone facts by Automation", async () => {
        const retiredAt = new Date("2026-08-28T10:00:00.000Z");
        const findMany = vi.fn(async () => [{
            id: "trigger-retired",
            automationId: "automation-a",
            kind: "sessionLifecycle" as const,
            revision: 7,
            deletedAt: retiredAt,
        }]);

        const result = await loadAutomationRetiredTriggerProjections({
            automationIds: ["automation-a", "automation-b"],
            tx: { automationTrigger: { findMany } } as any,
        });

        expect(result.get("automation-a")).toEqual([{
            id: "trigger-retired",
            automationId: "automation-a",
            kind: "sessionLifecycle",
            revision: 7,
            retiredAt,
        }]);
        expect(result.get("automation-b")).toEqual([]);
        expect(findMany).toHaveBeenCalledWith(expect.objectContaining({
            where: {
                automationId: { in: ["automation-a", "automation-b"] },
                deletedAt: { not: null },
            },
            select: {
                id: true,
                automationId: true,
                kind: true,
                revision: true,
                deletedAt: true,
            },
        }));
    });
});
