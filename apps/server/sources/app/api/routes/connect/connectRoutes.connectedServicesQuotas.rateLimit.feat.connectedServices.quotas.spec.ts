import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { auth } from "@/app/auth/auth";
import { db } from "@/storage/db";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";

import { createFakeRouteApp, getRouteEntry } from "../../testkit/routeHarness";

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
            // SD-1: the v3 quotas POST write route was retired (it only ever returned 400).
            ["GET", "/v3/connect/:serviceId/profiles/:profileId/quotas"],
            ["POST", "/v3/connect/:serviceId/profiles/:profileId/quotas/refresh"],
            ["DELETE", "/v3/connect/:serviceId/profiles/:profileId/quotas"],
        ] as const;

        for (const [method, path] of routes) {
            const rateLimit = getRouteEntry(app, method, path).opts.config?.rateLimit;
            expect(rateLimit).toEqual(expect.objectContaining({ max: expect.any(Number), timeWindow: expect.any(String) }));
            expect(rateLimit?.keyGenerator).toEqual(expect.any(Function));
            expect(await rateLimit?.keyGenerator?.({ headers: { authorization: `Bearer ${token}` }, ip: "203.0.113.9" })).toBe("uid:user-1");
        }
    });
});
