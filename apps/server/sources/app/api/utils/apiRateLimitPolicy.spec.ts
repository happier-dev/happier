import { describe, expect, it } from "vitest";

import {
    createApiRateLimitKeyGenerator,
    gateRateLimitConfig,
    resolveApiRateLimitPluginOptions,
    resolveApiTrustProxy,
    resolveRouteRateLimit,
} from "./apiRateLimitPolicy";

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
        expect(resolveApiTrustProxy({ HAPPIER_SERVER_TRUST_PROXY: "1" })).toBe(true);
        expect(resolveApiTrustProxy({ HAPPIER_SERVER_TRUST_PROXY: "false" })).toBe(false);
        expect(resolveApiTrustProxy({ HAPPIER_SERVER_TRUST_PROXY: "0" })).toBe(false);
        expect(resolveApiTrustProxy({ HAPPIER_SERVER_TRUST_PROXY: "2" })).toBe(2);
    });

    it("builds a stable rate limit key from Authorization when present", () => {
        const keyGen = createApiRateLimitKeyGenerator();
        const token = "Bearer secret-token-value";
        const key = keyGen({ headers: { authorization: token }, ip: "203.0.113.9" });
        expect(key).toMatch(/^auth:/);
        expect(key).not.toContain("secret-token-value");

        const fallback = keyGen({ headers: {}, ip: "203.0.113.9" });
        expect(fallback).toBe("ip:203.0.113.9");
    });

    it("can derive the IP rate limit key from X-Forwarded-For when configured", () => {
        const keyGen = createApiRateLimitKeyGenerator({
            HAPPIER_API_RATE_LIMIT_CLIENT_IP_SOURCE: "x-forwarded-for",
        });
        const key = keyGen({
            headers: { "x-forwarded-for": "203.0.113.10, 10.0.0.2" },
            ip: "10.0.0.2",
        });
        expect(key).toBe("ip:203.0.113.10");
    });

    it("falls back to request.ip when configured forwarded IP header is missing", () => {
        const keyGen = createApiRateLimitKeyGenerator({
            HAPPIER_API_RATE_LIMIT_CLIENT_IP_SOURCE: "x-forwarded-for",
        });
        const key = keyGen({ headers: {}, ip: "203.0.113.9" });
        expect(key).toBe("ip:203.0.113.9");
    });

    it("supports auth-only keying mode (unauth requests share a bucket)", () => {
        const keyGen = createApiRateLimitKeyGenerator({ HAPPIER_API_RATE_LIMIT_KEY_MODE: "auth-only" });
        expect(keyGen({ headers: {}, ip: "203.0.113.9" })).toBe("auth:missing");
        expect(keyGen({ headers: { authorization: "Bearer a" }, ip: "203.0.113.9" })).toMatch(/^auth:/);
    });

    it("gates fixed route rate limits behind HAPPIER_API_RATE_LIMITS_ENABLED", () => {
        const enabledEnv = { HAPPIER_API_RATE_LIMITS_ENABLED: "1" } as const;
        const disabledEnv = { HAPPIER_API_RATE_LIMITS_ENABLED: "0" } as const;
        const config = { max: 10, timeWindow: "1 minute" } as const;

        expect(gateRateLimitConfig(enabledEnv, config)).toEqual(config);
        expect(gateRateLimitConfig(disabledEnv, config)).toBe(false);
    });
});
