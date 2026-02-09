import { describe, expect, it } from "vitest";

class FakeApp {
    public routes = new Map<string, any>();

    get(path: string, _opts: any, handler: any) {
        this.routes.set(`GET ${path}`, handler);
    }

    post() {}
    put() {}
    delete() {}
}

function makeReply() {
    const reply: any = {
        send: (p: any) => p,
    };
    return reply;
}

describe("versionRoutes GET /v1/version", () => {
    it("responds with ok=true for server validation probes", async () => {
        const { versionRoutes } = await import("./versionRoutes");
        const app = new FakeApp();
        versionRoutes(app as any);

        const handler = app.routes.get("GET /v1/version");
        expect(handler).toBeTypeOf("function");

        const res = await handler({}, makeReply());
        expect(res).toEqual({ ok: true });
    });
});

