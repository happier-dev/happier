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
    patch(path: string, opts: any, _handler: any) {
        this.routes.set(`PATCH ${path}`, { opts });
    }
}

describe("accountRoutes rate limits", () => {
    it("registers hot account endpoints with explicit rate limits", async () => {
        const { accountRoutes } = await import("./accountRoutes");
        const app = new FakeApp();
        accountRoutes(app as any);

        const profile = app.routes.get("GET /v1/account/profile");
        expect(profile?.opts?.config?.rateLimit).toEqual(
            expect.objectContaining({ max: expect.any(Number), timeWindow: expect.any(String) }),
        );

        const settingsGet = app.routes.get("GET /v1/account/settings");
        expect(settingsGet?.opts?.config?.rateLimit).toEqual(
            expect.objectContaining({ max: expect.any(Number), timeWindow: expect.any(String) }),
        );
    });
});

