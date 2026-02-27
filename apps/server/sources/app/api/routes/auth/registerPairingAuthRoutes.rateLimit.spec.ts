import { describe, expect, it, vi } from "vitest";

class FakeApp {
    public routes = new Map<string, any>();
    public authenticate = vi.fn();

    post(path: string, opts: any, _handler: any) {
        this.routes.set(`POST ${path}`, { opts });
    }

    get(path: string, opts: any, _handler: any) {
        this.routes.set(`GET ${path}`, { opts });
    }
}

describe("pairing auth routes rate limits", () => {
    it("registers all pairing endpoints with an explicit rate limit", async () => {
        const { registerPairingAuthRoutes } = await import("./registerPairingAuthRoutes");
        const app = new FakeApp();
        registerPairingAuthRoutes(app as any);

        for (const key of [
            "POST /v1/auth/pairing/start",
            "POST /v1/auth/pairing/request",
            "GET /v1/auth/pairing/status",
            "POST /v1/auth/pairing/consume",
        ]) {
            const route = app.routes.get(key);
            expect(route?.opts?.config?.rateLimit).toEqual(
                expect.objectContaining({ max: expect.any(Number), timeWindow: expect.any(String) }),
            );
        }
    });
});
