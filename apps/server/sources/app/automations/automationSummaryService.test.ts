import { describe, expect, it } from "vitest";

import { sanitizeAutomationErrorMessage, sanitizeAutomationSummaryCiphertext } from "./automationSummaryService";

describe("automationSummaryService", () => {
    it("trims and bounds error messages", () => {
        expect(sanitizeAutomationErrorMessage("   ")).toBeNull();
        expect(sanitizeAutomationErrorMessage("  boom  ")).toBe("boom");
        expect(sanitizeAutomationErrorMessage("a".repeat(5_000))?.length).toBe(4_000);
    });

    it("trims and bounds summary ciphertext", () => {
        expect(sanitizeAutomationSummaryCiphertext("   ")).toBeNull();
        expect(sanitizeAutomationSummaryCiphertext("  ciphertext  ")).toBe("ciphertext");
        expect(sanitizeAutomationSummaryCiphertext("a".repeat(250_000))?.length).toBe(200_000);
    });
});

