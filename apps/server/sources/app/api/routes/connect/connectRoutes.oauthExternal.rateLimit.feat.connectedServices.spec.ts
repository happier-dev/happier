import { describe, expect, it, vi } from "vitest";

import { createFakeRouteApp, getRouteEntry } from "../../testkit/routeHarness";
import { createEnvReset } from "../../testkit/env";

vi.mock("@/utils/logging/log", () => ({ log: vi.fn() }));
vi.mock("@/app/auth/auth", () => ({
    auth: {
        verifyToken: vi.fn(async (token: string) => (token === "token_1" ? { userId: "user-1" } : null)),
    },
}));

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
        expect(await connectParams.opts.config?.rateLimit?.keyGenerator?.({ headers: { authorization: "Bearer token_1" }, ip: "203.0.113.9" })).toBe("uid:user-1");

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
        expect(await connectParams.opts.config?.rateLimit?.keyGenerator?.({ headers: { authorization: "Bearer token_1" }, ip: "203.0.113.9" })).toBe("ip:203.0.113.9");

        // Public endpoints should remain IP-keyed to avoid turning auth-only into a global shared bucket.
        const authParams = getRouteEntry(app, "GET", "/v1/auth/external/:provider/params");
        expect(await authParams.opts.config?.rateLimit?.keyGenerator?.({ headers: {}, ip: "203.0.113.9" })).toBe("ip:203.0.113.9");
    });
});
