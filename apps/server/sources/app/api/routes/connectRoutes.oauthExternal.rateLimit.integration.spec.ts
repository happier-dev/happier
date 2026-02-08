import { describe, expect, it, vi } from "vitest";

vi.mock("@/utils/log", () => ({ log: vi.fn() }));

class FakeApp {
    public authenticate = vi.fn();
    public getOptsByPath = new Map<string, any>();
    public postOptsByPath = new Map<string, any>();

    get(path: string, opts: any) {
        this.getOptsByPath.set(path, opts);
    }
    post(path: string, opts: any) {
        this.postOptsByPath.set(path, opts);
    }
    delete() { }
}

describe("connectRoutes (oauth external) rate limit", () => {
    it("registers OAuth routes with explicit rate limits", async () => {
        const { connectOAuthExternalRoutes } = await import("./connectRoutes.oauthExternal");
        const app = new FakeApp();
        connectOAuthExternalRoutes(app as any);

        const authParams = app.getOptsByPath.get("/v1/auth/external/:provider/params");
        expect(authParams?.config?.rateLimit).toEqual(expect.objectContaining({ max: expect.any(Number) }));

        const connectParams = app.getOptsByPath.get("/v1/connect/external/:provider/params");
        expect(connectParams?.config?.rateLimit).toEqual(expect.objectContaining({ max: expect.any(Number) }));

        const callback = app.getOptsByPath.get("/v1/oauth/:provider/callback");
        expect(callback?.config?.rateLimit).toEqual(expect.objectContaining({ max: expect.any(Number) }));
    });
});

