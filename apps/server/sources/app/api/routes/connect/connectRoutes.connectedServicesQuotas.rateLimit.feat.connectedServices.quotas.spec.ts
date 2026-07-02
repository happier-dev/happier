import { describe, expect, it, vi } from "vitest";

import { createFakeRouteApp, getRouteEntry } from "../../testkit/routeHarness";

vi.mock("@/utils/logging/log", () => ({ log: vi.fn() }));
vi.mock("@/app/auth/auth", () => ({
    auth: {
        verifyToken: vi.fn(async (token: string) => (token === "token_1" ? { userId: "user-1" } : null)),
    },
}));

describe("connected services quota route rate limits", () => {
    it("registers quota snapshot routes with explicit per-user rate limits", async () => {
        const { connectConnectedServicesQuotasV2Routes } = await import("./connectRoutes.connectedServicesQuotasV2");
        const { registerConnectedServiceQuotaRoutesV3 } = await import("./connectedServicesV3/registerConnectedServiceQuotaRoutesV3");
        const app = createFakeRouteApp();

        connectConnectedServicesQuotasV2Routes(app as any);
        registerConnectedServiceQuotaRoutesV3(app as any);

        const routes = [
            ["POST", "/v2/connect/:serviceId/profiles/:profileId/quotas"],
            ["GET", "/v2/connect/:serviceId/profiles/:profileId/quotas"],
            ["POST", "/v2/connect/:serviceId/profiles/:profileId/quotas/refresh"],
            ["DELETE", "/v2/connect/:serviceId/profiles/:profileId/quotas"],
            ["POST", "/v3/connect/:serviceId/profiles/:profileId/quotas"],
            ["GET", "/v3/connect/:serviceId/profiles/:profileId/quotas"],
            ["POST", "/v3/connect/:serviceId/profiles/:profileId/quotas/refresh"],
            ["DELETE", "/v3/connect/:serviceId/profiles/:profileId/quotas"],
        ] as const;

        for (const [method, path] of routes) {
            const rateLimit = getRouteEntry(app, method, path).opts.config?.rateLimit;
            expect(rateLimit).toEqual(expect.objectContaining({ max: expect.any(Number), timeWindow: expect.any(String) }));
            expect(rateLimit?.keyGenerator).toEqual(expect.any(Function));
            expect(await rateLimit?.keyGenerator?.({ headers: { authorization: "Bearer token_1" }, ip: "203.0.113.9" })).toBe("uid:user-1");
        }
    });
});
