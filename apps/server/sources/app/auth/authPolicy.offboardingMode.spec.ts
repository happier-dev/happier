import { describe, expect, it } from "vitest";

import { resolveAuthPolicyFromEnv } from "./authPolicy";

describe("resolveAuthPolicyFromEnv (offboarding mode)", () => {
    it("always uses per-request-cache", () => {
        const policy = resolveAuthPolicyFromEnv({} as any);
        expect(policy.offboarding.mode).toBe("per-request-cache");
    });
});
