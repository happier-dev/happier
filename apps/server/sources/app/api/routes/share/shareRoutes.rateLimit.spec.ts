import { describe, expect, it, vi } from "vitest";

vi.mock("@/utils/logging/log", () => ({ log: vi.fn() }));

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
    patch() { }
    put() { }
    delete() { }
}

describe("shareRoutes rate limits", () => {
    it("registers share endpoints with explicit rate limits and IP-keying for public routes", async () => {
        const { publicShareRoutes } = await import("./publicShareRoutes");
        const { shareRoutes } = await import("./shareRoutes");

        const app = new FakeApp();
        publicShareRoutes(app as any);
        shareRoutes(app as any);

        const publicRead = app.getOptsByPath.get("/v1/public-share/:token");
        expect(publicRead?.config?.rateLimit).toEqual(expect.objectContaining({ max: expect.any(Number), timeWindow: expect.any(String) }));
        expect(await publicRead?.config?.rateLimit?.keyGenerator?.({ headers: {}, ip: "203.0.113.9" })).toBe("ip:203.0.113.9");

        const publicMessages = app.getOptsByPath.get("/v1/public-share/:token/messages");
        expect(publicMessages?.config?.rateLimit).toEqual(expect.objectContaining({ max: expect.any(Number), timeWindow: expect.any(String) }));
        expect(await publicMessages?.config?.rateLimit?.keyGenerator?.({ headers: {}, ip: "203.0.113.9" })).toBe("ip:203.0.113.9");

        const shareWithUser = app.postOptsByPath.get("/v1/sessions/:sessionId/shares");
        expect(shareWithUser?.config?.rateLimit).toEqual(expect.objectContaining({ max: expect.any(Number), timeWindow: expect.any(String) }));
    });
});
