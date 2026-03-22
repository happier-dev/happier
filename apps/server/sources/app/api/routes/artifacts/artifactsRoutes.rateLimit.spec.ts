import { describe, expect, it } from "vitest";

import { createFakeRouteApp, getRouteEntry } from "../../testkit/routeHarness";

describe("artifactsRoutes rate limits", () => {
    it("registers GET /v1/artifacts with an explicit rate limit", async () => {
        const { artifactsRoutes } = await import("./artifactsRoutes");
        const app = createFakeRouteApp();
        artifactsRoutes(app as any);

        expect(getRouteEntry(app, "GET", "/v1/artifacts").opts.config?.rateLimit).toEqual(
            expect.objectContaining({ max: expect.any(Number), timeWindow: expect.any(String) }),
        );
    });
});
