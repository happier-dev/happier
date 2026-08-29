import { describe, expect, it } from "vitest";

import {
    automationRunV2ListItemSelect,
    automationRunV3ListItemSelect,
} from "./automationPersistenceSelect";

describe("Automation persistence query shapes", () => {
    it("keeps private frozen execution and result envelopes off the V3 Run-list read", () => {
        expect(automationRunV3ListItemSelect).not.toHaveProperty("executionInputEnvelope");
        expect(automationRunV3ListItemSelect).not.toHaveProperty("resultEnvelope");
        expect(automationRunV3ListItemSelect).not.toHaveProperty("errorMessage");
        expect(automationRunV3ListItemSelect).not.toHaveProperty("scheduledAt");

        // The released V2 adapter retains its exact frozen-input/result seam.
        expect(automationRunV2ListItemSelect).toMatchObject({
            executionInputEnvelope: true,
            resultEnvelope: true,
            errorMessage: true,
            scheduledAt: true,
        });
    });
});
