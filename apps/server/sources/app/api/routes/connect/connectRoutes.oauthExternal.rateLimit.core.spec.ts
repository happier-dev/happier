import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { auth } from "@/app/auth/auth";
import { db } from "@/storage/db";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";

import { createFakeRouteApp, getRouteEntry } from "../../testkit/routeHarness";
import { createEnvReset } from "../../testkit/env";

vi.mock("@/utils/logging/log", () => ({ log: vi.fn() }));
// Exercise real token issuance and route admission against the canonical storage harness.
let harness: LightSqliteHarness;
let token: string;
beforeAll(async () => {
    harness = await createLightSqliteHarness({ tempDirPrefix: "happier-connect-rate-auth-", initAuth: true });
    await db.account.create({ data: { id: "user-1", publicKey: "connect-rate-auth-user" } });
    token = await auth.createToken("user-1", undefined, { kind: "account", authority: "present_user" });
}, 120_000);
afterAll(async () => { await harness?.close(); });

describe("connectRoutes (oauth external) rate limit", () => {
    const resetRouteKeyStrategyEnv = createEnvReset();

    it("registers OAuth routes with explicit rate limits", async () => {
        const { connectOAuthExternalRoutes } = await import("./connectRoutes.oauthExternal");
        const app = createFakeRouteApp();
        connectOAuthExternalRoutes(app as any);

        const authParams = getRouteEntry(app, "GET", "/v1/auth/external/:provider/params");
        expect(authParams.opts.config?.rateLimit).toEqual(expect.objectContaining({ max: expect.any(Number) }));
        expect(authParams.opts.config?.rateLimit?.keyGenerator).toEqual(expect.any(Function));
        expect(await authParams.opts.config?.rateLimit?.keyGenerator?.({ headers: {}, ip: "203.0.113.9" })).toBe("ip:203.0.113.9");

        const connectParams = getRouteEntry(app, "GET", "/v1/connect/external/:provider/params");
        expect(connectParams.opts.config?.rateLimit).toEqual(expect.objectContaining({ max: expect.any(Number) }));
        expect(connectParams.opts.config?.rateLimit?.keyGenerator).toEqual(expect.any(Function));
        expect(await connectParams.opts.config?.rateLimit?.keyGenerator?.({ headers: { authorization: `Bearer ${token}` }, ip: "203.0.113.9" })).toBe("uid:user-1");

        const callback = getRouteEntry(app, "GET", "/v1/oauth/:provider/callback");
        expect(callback.opts.config?.rateLimit).toEqual(expect.objectContaining({ max: expect.any(Number) }));
        expect(callback.opts.config?.rateLimit?.keyGenerator).toEqual(expect.any(Function));
        expect(await callback.opts.config?.rateLimit?.keyGenerator?.({ headers: {}, ip: "203.0.113.9" })).toBe("ip:203.0.113.9");
    });

    it("can force ip-only route keying strategy via HAPPIER_API_RATE_LIMITS_ROUTE_KEY_STRATEGY", async () => {
        resetRouteKeyStrategyEnv({ HAPPIER_API_RATE_LIMITS_ROUTE_KEY_STRATEGY: "ip-only" });
        const { connectOAuthExternalRoutes } = await import("./connectRoutes.oauthExternal");
        const app = createFakeRouteApp();
        connectOAuthExternalRoutes(app as any);

        const connectParams = getRouteEntry(app, "GET", "/v1/connect/external/:provider/params");
        expect(await connectParams.opts.config?.rateLimit?.keyGenerator?.({ headers: { authorization: `Bearer ${token}` }, ip: "203.0.113.9" })).toBe("ip:203.0.113.9");

        // Public endpoints should remain IP-keyed to avoid turning auth-only into a global shared bucket.
        const authParams = getRouteEntry(app, "GET", "/v1/auth/external/:provider/params");
        expect(await authParams.opts.config?.rateLimit?.keyGenerator?.({ headers: {}, ip: "203.0.113.9" })).toBe("ip:203.0.113.9");
    });
});
