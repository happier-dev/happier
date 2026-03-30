import { describe, expect, it } from "vitest";

import { createFakeRouteApp, getRouteEntry } from "../../testkit/routeHarness";

describe("pairing auth routes rate limits", () => {
    it("registers all pairing endpoints with an explicit rate limit", async () => {
        const { registerPairingAuthRoutes } = await import("./registerPairingAuthRoutes");
        const app = createFakeRouteApp();
        registerPairingAuthRoutes(app as any);

        for (const key of [
            "POST /v1/auth/pairing/start",
            "POST /v1/auth/pairing/request",
            "GET /v1/auth/pairing/status",
            "POST /v1/auth/pairing/consume",
        ]) {
            const [method, path] = key.split(" ") as ["GET" | "POST", string];
            expect(getRouteEntry(app, method, path).opts.config?.rateLimit).toEqual(
                expect.objectContaining({ max: expect.any(Number), timeWindow: expect.any(String) }),
            );
        }
    });
});
