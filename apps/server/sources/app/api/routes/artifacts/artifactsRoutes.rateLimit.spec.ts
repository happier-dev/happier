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
    delete(path: string, opts: any, _handler: any) {
        this.routes.set(`DELETE ${path}`, { opts });
    }
}

describe("artifactsRoutes rate limits", () => {
    it("registers GET /v1/artifacts with an explicit rate limit", async () => {
        const { artifactsRoutes } = await import("./artifactsRoutes");
        const app = new FakeApp();
        artifactsRoutes(app as any);

        const route = app.routes.get("GET /v1/artifacts");
        expect(route?.opts?.config?.rateLimit).toEqual(
            expect.objectContaining({ max: expect.any(Number), timeWindow: expect.any(String) }),
        );
    });
});

