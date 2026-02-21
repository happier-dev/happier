import { describe, expect, it, vi } from "vitest";

class FakeApp {
    public authenticate = vi.fn();
    public routes = new Map<string, any>();

    get(path: string, opts: any, _handler: any) {
        this.routes.set(`GET ${path}`, { opts });
    }
    post(path: string, opts: any, _handler: any) {
        this.routes.set(`POST ${path}`, { opts });
    }
}

describe("machinesRoutes rate limits", () => {
    it("registers GET /v1/machines with an explicit rate limit", async () => {
        const { machinesRoutes } = await import("./machinesRoutes");
        const app = new FakeApp();
        machinesRoutes(app as any);

        const route = app.routes.get("GET /v1/machines");
        expect(route?.opts?.config?.rateLimit).toEqual(
            expect.objectContaining({ max: expect.any(Number), timeWindow: expect.any(String) }),
        );
    });
});

