import { describe, expect, it, vi } from "vitest";

import { createFakeRouteApp, createReplyStub, getRouteEntry, getRouteHandler } from "./routeHarness";

describe("routeHarness", () => {
    it("returns the registered route entry for opts-driven assertions", () => {
        const app = createFakeRouteApp();
        const handlerSpy = vi.fn(async () => ({ ok: true }));

        app.post("/v1/test", {
            config: {
                rateLimit: {
                    max: 10,
                    timeWindow: "1 minute",
                },
            },
        }, handlerSpy);

        expect(getRouteEntry(app, "POST", "/v1/test")).toEqual({
            handler: handlerSpy,
            opts: {
                config: {
                    rateLimit: {
                        max: 10,
                        timeWindow: "1 minute",
                    },
                },
            },
        });
    });

    it("stops executing preHandlers when a preHandler sends a response (even if it returns undefined)", async () => {
        const app = createFakeRouteApp();
        const handlerSpy = vi.fn(async () => ({ ok: true }));

        app.get("/v1/test", {
            preHandler: async (_request: any, reply: any) => {
                reply.code(404);
                reply.send({ error: "not_found" });
                // No return value: in Fastify this still ends the request.
            },
        }, handlerSpy);

        const handler = getRouteHandler(app, "GET", "/v1/test");
        const reply = createReplyStub();

        await handler({}, reply);

        expect(reply.send).toHaveBeenCalledWith({ error: "not_found" });
        expect(handlerSpy).not.toHaveBeenCalled();
    });

    it("tracks reply statusCode when code() is used", () => {
        const reply = createReplyStub();

        reply.code(404);

        expect(reply.statusCode).toBe(404);
    });
});
