import { describe, expect, it } from "vitest";

import { resolveApiHotEndpointRateLimit } from "./apiRateLimitCatalog";

describe("apiRateLimitCatalog", () => {
    it("resolves env keys by id and uses catalog defaults", () => {
        const env = {
            HAPPIER_API_RATE_LIMITS_ENABLED: "1",
        } as const;

        const rateLimit = resolveApiHotEndpointRateLimit(env, "account.profile");
        expect(rateLimit).toEqual(
            expect.objectContaining({
                max: 300,
                timeWindow: "1 minute",
            }),
        );
    });

    it("allows overriding max/window via env vars derived from the id", () => {
        const env = {
            HAPPIER_API_RATE_LIMITS_ENABLED: "1",
            HAPPIER_ACCOUNT_PROFILE_RATE_LIMIT_MAX: "12",
            HAPPIER_ACCOUNT_PROFILE_RATE_LIMIT_WINDOW: "30 seconds",
        } as const;

        const rateLimit = resolveApiHotEndpointRateLimit(env, "account.profile");
        expect(rateLimit).toEqual(
            expect.objectContaining({
                max: 12,
                timeWindow: "30 seconds",
            }),
        );
    });

    it("disables a specific limit when the derived *_MAX is set to 0", () => {
        const env = {
            HAPPIER_API_RATE_LIMITS_ENABLED: "1",
            HAPPIER_ACCOUNT_PROFILE_RATE_LIMIT_MAX: "0",
        } as const;

        expect(resolveApiHotEndpointRateLimit(env, "account.profile")).toBe(false);
    });

    it("fails closed when the id is unknown", () => {
        const env = {
            HAPPIER_API_RATE_LIMITS_ENABLED: "1",
        } as const;

        expect(resolveApiHotEndpointRateLimit(env, "unknown.id" as any)).toBe(false);
    });
});
