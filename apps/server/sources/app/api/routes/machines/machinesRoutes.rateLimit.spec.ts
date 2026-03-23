import { describe, expect, it } from "vitest";

import { createFakeRouteApp, getRouteEntry } from "../../testkit/routeHarness";

describe("machinesRoutes rate limits", () => {
    it("registers GET /v1/machines with an explicit rate limit", async () => {
        const { machinesRoutes } = await import("./machinesRoutes");
        const app = createFakeRouteApp();
        machinesRoutes(app as any);

        expect(getRouteEntry(app, "GET", "/v1/machines").opts.config?.rateLimit).toEqual(
            expect.objectContaining({ max: expect.any(Number), timeWindow: expect.any(String) }),
        );
    });
});
