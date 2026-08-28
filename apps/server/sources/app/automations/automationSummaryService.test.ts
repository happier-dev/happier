import { describe, expect, it } from "vitest";

import { sanitizeAutomationErrorMessage } from "./automationSummaryService";

describe("automationSummaryService", () => {
    it("trims and bounds error messages", () => {
        expect(sanitizeAutomationErrorMessage("   ")).toBeNull();
        expect(sanitizeAutomationErrorMessage("  boom  ")).toBe("boom");
        expect(sanitizeAutomationErrorMessage("a".repeat(5_000))?.length).toBe(4_000);
    });
});
