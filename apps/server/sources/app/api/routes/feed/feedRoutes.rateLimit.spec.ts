import { describe, expect, it, vi } from "vitest";

class FakeApp {
    public authenticate = vi.fn();
    public routes = new Map<string, any>();

    get(path: string, opts: any, _handler: any) {
        this.routes.set(`GET ${path}`, { opts });
    }
}

describe("feedRoutes rate limits", () => {
    it("registers GET /v1/feed with an explicit rate limit", async () => {
        const { feedRoutes } = await import("./feedRoutes");
        const app = new FakeApp();
        feedRoutes(app as any);

        const route = app.routes.get("GET /v1/feed");
        expect(route?.opts?.config?.rateLimit).toEqual(
            expect.objectContaining({ max: expect.any(Number), timeWindow: expect.any(String) }),
        );
    });
});

