import { describe, expect, it, vi } from "vitest";

class FakeApp {
    public authenticate = vi.fn();
    public routes = new Map<string, any>();

    get(path: string, opts: any, handler: any) {
        this.routes.set(`GET ${path}`, { opts, handler });
    }
    post(path: string, opts: any, handler: any) {
        this.routes.set(`POST ${path}`, { opts, handler });
    }
    put(path: string, opts: any, handler: any) {
        this.routes.set(`PUT ${path}`, { opts, handler });
    }
    patch(path: string, opts: any, handler: any) {
        this.routes.set(`PATCH ${path}`, { opts, handler });
    }
    delete(path: string, opts: any, handler: any) {
        this.routes.set(`DELETE ${path}`, { opts, handler });
    }
}

describe("sessionPendingRoutes rate limits", () => {
    it("registers pending routes with explicit rate limits", async () => {
        const { sessionPendingRoutes } = await import("./pendingRoutes");
        const app = new FakeApp();
        sessionPendingRoutes(app as any);

        const list = app.routes.get("GET /v2/sessions/:sessionId/pending");
        expect(list?.opts?.config?.rateLimit).toEqual(
            expect.objectContaining({ max: expect.any(Number), timeWindow: expect.any(String) }),
        );

        const materialize = app.routes.get("POST /v2/sessions/:sessionId/pending/materialize-next");
        expect(materialize?.opts?.config?.rateLimit).toEqual(
            expect.objectContaining({ max: expect.any(Number), timeWindow: expect.any(String) }),
        );
    });
});

