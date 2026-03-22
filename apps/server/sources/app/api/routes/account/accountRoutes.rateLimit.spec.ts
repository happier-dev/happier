import { describe, expect, it } from "vitest";

import { createFakeRouteApp, getRouteEntry } from "../../testkit/routeHarness";

describe("accountRoutes rate limits", () => {
    it("registers hot account endpoints with explicit rate limits", async () => {
        const { accountRoutes } = await import("./accountRoutes");
        const app = createFakeRouteApp();
        accountRoutes(app as any);

        expect(getRouteEntry(app, "GET", "/v1/account/profile").opts.config?.rateLimit).toEqual(
            expect.objectContaining({ max: expect.any(Number), timeWindow: expect.any(String) }),
        );

        expect(getRouteEntry(app, "GET", "/v1/account/settings").opts.config?.rateLimit).toEqual(
            expect.objectContaining({ max: expect.any(Number), timeWindow: expect.any(String) }),
        );
    });
});
