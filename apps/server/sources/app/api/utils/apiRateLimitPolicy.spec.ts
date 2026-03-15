import { describe, expect, it, vi } from "vitest";

import {
    createApiRateLimitKeyGenerator,
    gateRateLimitConfig,
    resolveApiRateLimitPluginOptions,
    resolveApiTrustProxy,
    resolveRouteRateLimit,
} from "./apiRateLimitPolicy";

import { auth } from "@/app/auth/auth";

vi.mock("@/app/auth/auth", () => ({
    auth: {
        verifyToken: vi.fn(async (token: string) => (token === "valid-token" ? { userId: "user-123" } : null)),
    },
}));

describe("apiRateLimitPolicy", () => {
    it("disables all rate limiting when HAPPIER_API_RATE_LIMITS_ENABLED=0", () => {
        const env = {
            HAPPIER_API_RATE_LIMITS_ENABLED: "0",
            HAPPIER_API_RATE_LIMITS_GLOBAL_MAX: "100",
            HAPPIER_API_RATE_LIMITS_GLOBAL_WINDOW: "1 minute",
        } as const;

        expect(resolveApiRateLimitPluginOptions(env)).toEqual({ global: false });
        expect(
            resolveRouteRateLimit(env, {
                maxEnvKey: "HAPPIER_SESSION_MESSAGES_RATE_LIMIT_MAX",
                windowEnvKey: "HAPPIER_SESSION_MESSAGES_RATE_LIMIT_WINDOW",
                defaultMax: 600,
                defaultWindow: "1 minute",
            }),
        ).toBe(false);
    });

    it("enables global rate limiting when global max is set", () => {
        const env = {
            HAPPIER_API_RATE_LIMITS_ENABLED: "1",
            HAPPIER_API_RATE_LIMITS_GLOBAL_MAX: "123",
            HAPPIER_API_RATE_LIMITS_GLOBAL_WINDOW: "30 seconds",
        } as const;

        expect(resolveApiRateLimitPluginOptions(env)).toEqual(
            expect.objectContaining({
                global: true,
                max: 123,
                timeWindow: "30 seconds",
                keyGenerator: expect.any(Function),
            }),
        );
    });

    it("parses HAPPIER_SERVER_TRUST_PROXY as a boolean or hop count", () => {
        expect(resolveApiTrustProxy({})).toBeUndefined();
        expect(resolveApiTrustProxy({ HAPPIER_SERVER_TRUST_PROXY: "true" })).toBe(true);
        expect(resolveApiTrustProxy({ HAPPIER_SERVER_TRUST_PROXY: "1" })).toBe(1);
        expect(resolveApiTrustProxy({ HAPPIER_SERVER_TRUST_PROXY: "false" })).toBe(false);
        expect(resolveApiTrustProxy({ HAPPIER_SERVER_TRUST_PROXY: "0" })).toBe(0);
        expect(resolveApiTrustProxy({ HAPPIER_SERVER_TRUST_PROXY: "2" })).toBe(2);
    });

    it("keys authenticated requests by verified user id (not by raw Authorization header)", async () => {
        const verifySpy = vi.spyOn(auth, "verifyToken");
        const keyGen = createApiRateLimitKeyGenerator();
        const key = await keyGen({ headers: { authorization: "Bearer valid-token" }, ip: "203.0.113.9" });
        expect(key).toBe("uid:user-123");
        expect(verifySpy).toHaveBeenCalledWith("valid-token");

        const fallback = await keyGen({ headers: { authorization: "Bearer invalid-token" }, ip: "203.0.113.9" });
        expect(fallback).toBe("ip:203.0.113.9");
    });

    it("fails closed to the ip key without verifying absurdly large bearer tokens", async () => {
        const verifySpy = vi.spyOn(auth, "verifyToken");
        verifySpy.mockClear();

        const keyGen = createApiRateLimitKeyGenerator();
        const hugeToken = "x".repeat(5000);
        const key = await keyGen({ headers: { authorization: `Bearer ${hugeToken}` }, ip: "203.0.113.9" });

        expect(key).toBe("ip:203.0.113.9");
        expect(verifySpy).not.toHaveBeenCalled();
    });

    it("truncates untrusted ip strings used in rate limit keys", async () => {
        const keyGen = createApiRateLimitKeyGenerator({ HAPPIER_API_RATE_LIMITS_ROUTE_KEY_STRATEGY: "ip-only" });
        const hugeIp = "203.0.113.9," + "a".repeat(5000);
        const key = await keyGen({ headers: {}, ip: hugeIp });

        expect(key.startsWith("ip:")).toBe(true);
        expect(key.length).toBeLessThanOrEqual("ip:".length + 256);
    });

    it("fails closed to the ip key when the verified user id is excessively large", async () => {
        const verifySpy = vi.spyOn(auth, "verifyToken");
        verifySpy.mockResolvedValue({ userId: "x".repeat(10_000) } as any);

        const keyGen = createApiRateLimitKeyGenerator();
        const key = await keyGen({ headers: { authorization: "Bearer valid-token" }, ip: "203.0.113.9" });

        expect(key).toBe("ip:203.0.113.9");
        verifySpy.mockRestore();
    });

    it("can force ip-only keying strategy via env", async () => {
        const keyGen = createApiRateLimitKeyGenerator({ HAPPIER_API_RATE_LIMITS_ROUTE_KEY_STRATEGY: "ip-only" });
        const key = await keyGen({ headers: { authorization: "Bearer valid-token" }, ip: "203.0.113.9" });
        expect(key).toBe("ip:203.0.113.9");
    });

    it("gates fixed route rate limits behind HAPPIER_API_RATE_LIMITS_ENABLED", () => {
        const enabledEnv = { HAPPIER_API_RATE_LIMITS_ENABLED: "1" } as const;
        const disabledEnv = { HAPPIER_API_RATE_LIMITS_ENABLED: "0" } as const;
        const config = { max: 10, timeWindow: "1 minute" } as const;

        expect(gateRateLimitConfig(enabledEnv, config)).toEqual(config);
        expect(gateRateLimitConfig(disabledEnv, config)).toBe(false);
    });
});
