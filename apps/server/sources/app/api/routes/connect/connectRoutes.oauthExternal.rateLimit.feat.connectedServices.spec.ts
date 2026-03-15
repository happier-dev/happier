import { describe, expect, it, vi } from "vitest";

vi.mock("@/utils/logging/log", () => ({ log: vi.fn() }));
vi.mock("@/app/auth/auth", () => ({
    auth: {
        verifyToken: vi.fn(async (token: string) => (token === "token_1" ? { userId: "user-1" } : null)),
    },
}));

class FakeApp {
    public authenticate = vi.fn();
    public getOptsByPath = new Map<string, any>();
    public postOptsByPath = new Map<string, any>();

    get(path: string, opts: any) {
        this.getOptsByPath.set(path, opts);
    }
    post(path: string, opts: any) {
        this.postOptsByPath.set(path, opts);
    }
    delete() { }
}

describe("connectRoutes (oauth external) rate limit", () => {
    it("registers OAuth routes with explicit rate limits", async () => {
        const { connectOAuthExternalRoutes } = await import("./connectRoutes.oauthExternal");
        const app = new FakeApp();
        connectOAuthExternalRoutes(app as any);

        const authParams = app.getOptsByPath.get("/v1/auth/external/:provider/params");
        expect(authParams?.config?.rateLimit).toEqual(expect.objectContaining({ max: expect.any(Number) }));
        expect(authParams?.config?.rateLimit?.keyGenerator).toEqual(expect.any(Function));
        expect(await authParams?.config?.rateLimit?.keyGenerator?.({ headers: {}, ip: "203.0.113.9" })).toBe("ip:203.0.113.9");

        const connectParams = app.getOptsByPath.get("/v1/connect/external/:provider/params");
        expect(connectParams?.config?.rateLimit).toEqual(expect.objectContaining({ max: expect.any(Number) }));
        expect(connectParams?.config?.rateLimit?.keyGenerator).toEqual(expect.any(Function));
        expect(await connectParams?.config?.rateLimit?.keyGenerator?.({ headers: { authorization: "Bearer token_1" }, ip: "203.0.113.9" })).toBe("uid:user-1");

        const callback = app.getOptsByPath.get("/v1/oauth/:provider/callback");
        expect(callback?.config?.rateLimit).toEqual(expect.objectContaining({ max: expect.any(Number) }));
        expect(callback?.config?.rateLimit?.keyGenerator).toEqual(expect.any(Function));
        expect(await callback?.config?.rateLimit?.keyGenerator?.({ headers: {}, ip: "203.0.113.9" })).toBe("ip:203.0.113.9");
    });

    it("can force ip-only route keying strategy via HAPPIER_API_RATE_LIMITS_ROUTE_KEY_STRATEGY", async () => {
        const originalEnv = process.env;
        process.env = {
            ...originalEnv,
            HAPPIER_API_RATE_LIMITS_ROUTE_KEY_STRATEGY: "ip-only",
        };
        try {
            const { connectOAuthExternalRoutes } = await import("./connectRoutes.oauthExternal");
            const app = new FakeApp();
            connectOAuthExternalRoutes(app as any);

            const connectParams = app.getOptsByPath.get("/v1/connect/external/:provider/params");
            expect(await connectParams?.config?.rateLimit?.keyGenerator?.({ headers: { authorization: "Bearer token_1" }, ip: "203.0.113.9" })).toBe("ip:203.0.113.9");

            // Public endpoints should remain IP-keyed to avoid turning auth-only into a global shared bucket.
            const authParams = app.getOptsByPath.get("/v1/auth/external/:provider/params");
            expect(await authParams?.config?.rateLimit?.keyGenerator?.({ headers: {}, ip: "203.0.113.9" })).toBe("ip:203.0.113.9");
        } finally {
            process.env = originalEnv;
        }
    });
});
