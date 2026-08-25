import { describe, expect, it } from "vitest";

import { sameAutomationEventDurablePushWebhookContributionV1 } from "./automationEventCurrentness";

describe("Automation Event durable-push webhook currentness", () => {
    it("compares the full webhook contribution identity for every consumer vector", () => {
        const current = { pluginId: "com.acme.github", localId: "repository-events" } as const;

        expect(sameAutomationEventDurablePushWebhookContributionV1(
            current,
            { pluginId: "com.acme.github", localId: "repository-events" },
        )).toBe(true);
        expect(sameAutomationEventDurablePushWebhookContributionV1(
            current,
            { pluginId: "com.acme.gitlab", localId: "repository-events" },
        )).toBe(false);
        expect(sameAutomationEventDurablePushWebhookContributionV1(
            current,
            { pluginId: "com.acme.github", localId: "push-events" },
        )).toBe(false);
    });
});
