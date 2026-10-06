import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import {
    createApiRateLimitKeyGenerator,
    gateRateLimitConfig,
    resolveApiRateLimitPluginOptions,
    resolveApiTrustProxy,
    resolveRouteRateLimit,
} from "./apiRateLimitPolicy";

import { auth } from "@/app/auth/auth";

// Bearer keying is proven through the real auth owner (mint + verifyTokenForRoute).
// Only the storage boundary is stubbed: createToken/verify read the account
// token epoch and active status through db.account.findUnique.
const dbAccountFindUniqueMock = vi.hoisted(() => vi.fn());
vi.mock("@/storage/db", () => ({
    db: {
        account: {
            findUnique: dbAccountFindUniqueMock,
        },
    },
}));

const previousMasterSecret = process.env.HANDY_MASTER_SECRET;

beforeAll(async () => {
    process.env.HANDY_MASTER_SECRET = "api-rate-limit-policy-spec-secret";
    dbAccountFindUniqueMock.mockResolvedValue({ tokenEpoch: 0, status: "active" });
    await auth.init();
});

afterAll(() => {
    if (typeof previousMasterSecret === "string") {
        process.env.HANDY_MASTER_SECRET = previousMasterSecret;
    } else {
        delete process.env.HANDY_MASTER_SECRET;
    }
});

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

    it("keys an ordinary signed bearer by its verified account id (not by the raw Authorization header)", async () => {
        const token = await auth.createToken("rate-limit-account-1", undefined, {
            kind: "account",
            authority: "present_user",
        });
        const keyGen = createApiRateLimitKeyGenerator();
        const key = await keyGen({ headers: { authorization: `Bearer ${token}` }, ip: "203.0.113.9" });

        expect(key).toBe("uid:rate-limit-account-1");
    });

    it("never keys a restricted account_directory bearer by its account id", async () => {
        const token = await auth.createToken("rate-limit-directory-1", undefined, {
            kind: "account_directory",
            authority: "present_user",
        });
        await expect(auth.verifyTokenForRoute(token)).resolves.toMatchObject({
            userId: "rate-limit-directory-1", authTokenKind: "account_directory",
        });
        const keyGen = createApiRateLimitKeyGenerator();
        const key = await keyGen({ headers: { authorization: `Bearer ${token}` }, ip: "203.0.113.9" });

        expect(key).toBe("ip:203.0.113.9");
    });

    it("falls back to the ip key for an unverifiable bearer", async () => {
        const keyGen = createApiRateLimitKeyGenerator();
        const key = await keyGen({ headers: { authorization: "Bearer not-a-signed-token" }, ip: "203.0.113.9" });

        expect(key).toBe("ip:203.0.113.9");
    });

    it("uses the route IP key without pre-verifying a bearer on PAT-admitting routes", async () => {
        const verifySpy = vi.spyOn(auth, "verifyTokenForRoute");
        const keyGen = createApiRateLimitKeyGenerator({}, { strategy: "user-or-ip", scope: "global" });

        const key = await keyGen({
            headers: { authorization: "Bearer valid-token" },
            ip: "203.0.113.9",
            routeOptions: { config: { allowApiToken: true } },
        });

        expect(key).toBe("ip:203.0.113.9");
        expect(verifySpy).not.toHaveBeenCalled();
        verifySpy.mockRestore();
    });

    it("fails closed to the ip key without verifying absurdly large bearer tokens", async () => {
        const verifySpy = vi.spyOn(auth, "verifyTokenForRoute");

        const keyGen = createApiRateLimitKeyGenerator();
        const hugeToken = "x".repeat(5000);
        const key = await keyGen({ headers: { authorization: `Bearer ${hugeToken}` }, ip: "203.0.113.9" });

        expect(key).toBe("ip:203.0.113.9");
        expect(verifySpy).not.toHaveBeenCalled();
        verifySpy.mockRestore();
    });

    it("truncates untrusted ip strings used in rate limit keys", async () => {
        const keyGen = createApiRateLimitKeyGenerator({ HAPPIER_API_RATE_LIMITS_ROUTE_KEY_STRATEGY: "ip-only" });
        const hugeIp = "203.0.113.9," + "a".repeat(5000);
        const key = await keyGen({ headers: {}, ip: hugeIp });

        expect(key.startsWith("ip:")).toBe(true);
        expect(key.length).toBeLessThanOrEqual("ip:".length + 256);
    });

    it("fails closed to the ip key when the verified user id is excessively large", async () => {
        const userId = "x".repeat(129);
        const token = await auth.createToken(userId, undefined, {
            kind: "account", authority: "present_user",
        });
        // Reach the user-id guard, not the earlier bearer-size rejection.
        expect(token.length).toBeLessThanOrEqual(2048);
        await expect(auth.verifyTokenForRoute(token)).resolves.toMatchObject({ userId });

        const keyGen = createApiRateLimitKeyGenerator();
        const key = await keyGen({ headers: { authorization: `Bearer ${token}` }, ip: "203.0.113.9" });

        expect(key).toBe("ip:203.0.113.9");
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
