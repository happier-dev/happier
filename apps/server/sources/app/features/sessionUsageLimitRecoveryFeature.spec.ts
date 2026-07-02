import { describe, expect, it } from "vitest";

import { resolveSessionUsageLimitRecoveryFeature } from "./sessionUsageLimitRecoveryFeature";

describe("resolveSessionUsageLimitRecoveryFeature", () => {
    it("defaults usage-limit recovery to enabled", () => {
        expect(resolveSessionUsageLimitRecoveryFeature({} as NodeJS.ProcessEnv).features?.sessions).toEqual({
            enabled: true,
            usageLimitRecovery: { enabled: true },
        });
    });

    it("reads usage-limit recovery enablement from env", () => {
        expect(resolveSessionUsageLimitRecoveryFeature({
            HAPPIER_FEATURE_SESSIONS_USAGE_LIMIT_RECOVERY__ENABLED: "0",
        } as NodeJS.ProcessEnv).features?.sessions).toEqual({
            enabled: true,
            usageLimitRecovery: { enabled: false },
        });
    });
});
