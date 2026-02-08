import { describe, expect, it } from "vitest";

import { resolveAuthPolicyFromEnv } from "./authPolicy";

describe("resolveAuthPolicyFromEnv (offboarding interval)", () => {
    it("defaults to a 24-hour eligibility re-check interval", () => {
        const policy = resolveAuthPolicyFromEnv({} as any);
        expect(policy.offboarding.intervalSeconds).toBe(86400);
    });
});
