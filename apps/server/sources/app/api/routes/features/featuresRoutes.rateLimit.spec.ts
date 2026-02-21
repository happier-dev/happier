import { describe, expect, it, vi } from "vitest";

class FakeApp {
    public routes = new Map<string, any>();

    get(path: string, opts: any, _handler: any) {
        this.routes.set(`GET ${path}`, { opts });
    }
}

describe("featuresRoutes rate limits", () => {
    it("registers GET /v1/features with an explicit rate limit", async () => {
        const { featuresRoutes } = await import("./featuresRoutes");
        const app = new FakeApp();
        featuresRoutes(app as any);

        const route = app.routes.get("GET /v1/features");
        expect(route?.opts?.config?.rateLimit).toEqual(
            expect.objectContaining({ max: expect.any(Number), timeWindow: expect.any(String) }),
        );
    });
});

