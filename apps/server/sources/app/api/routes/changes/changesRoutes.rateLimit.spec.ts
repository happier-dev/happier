import { describe, expect, it, vi } from "vitest";

class FakeApp {
    public authenticate = vi.fn();
    public routes = new Map<string, any>();

    get(path: string, opts: any, handler: any) {
        this.routes.set(`GET ${path}`, { opts, handler });
    }
    post() {}
}

describe("changesRoutes rate limits", () => {
    it("registers GET /v2/changes with an explicit rate limit", async () => {
        const { changesRoutes } = await import("./changesRoutes");
        const app = new FakeApp();
        changesRoutes(app as any);
        const cursorRoute = app.routes.get("GET /v2/cursor");
        expect(cursorRoute?.opts?.config?.rateLimit).toEqual(
            expect.objectContaining({ max: expect.any(Number), timeWindow: expect.any(String) }),
        );
        const route = app.routes.get("GET /v2/changes");
        expect(route?.opts?.config?.rateLimit).toEqual(
            expect.objectContaining({ max: expect.any(Number), timeWindow: expect.any(String) }),
        );
    });
});
