import { describe, expect, it } from "vitest";

import { createFakeRouteApp, createReplyStub, getRouteEntry, getRouteHandler, type FakeRouteApp } from "./routeHarness";
import { createRouteRequest } from "./requestFixtures";
import { withAuthenticatedTestApp } from "./sqliteFastify";
import { createRouteTestBuilder } from "./routeTestBuilder";

describe("routeHarness", () => {
    it("supports Fastify's fluent serializer while exposing the application payload", async () => {
        const payload = { success: true };
        const registerRoutes = (app: Pick<FakeRouteApp, "get">) => {
            app.get("/v1/serialized", async (_request, reply) =>
                reply.serializer(JSON.stringify).code(202).send(payload));
        };
        await withAuthenticatedTestApp(registerRoutes, async app => {
            const response = await app.inject({ method: "GET", url: "/v1/serialized" });
            expect(response.statusCode).toBe(202);
            expect(response.json()).toEqual(payload);
        });

        const route = createRouteTestBuilder({ method: "GET", path: "/v1/serialized", registerRoutes });
        const result = await route.invoke();

        expect(result.reply.statusCode).toBe(202);
        expect(result.response).toEqual(payload);
    });

    it("returns the registered route entry for opts-driven assertions", () => {
        const app = createFakeRouteApp();
        const handler = async () => ({ ok: true });

        app.post("/v1/test", {
            config: {
                rateLimit: {
                    max: 10,
                    timeWindow: "1 minute",
                },
            },
        }, handler);

        expect(getRouteEntry(app, "POST", "/v1/test")).toEqual({
            handler,
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

    it("matches Fastify hook order and stops after a preHandler sends without returning", async () => {
        const registerRoutes = (app: Pick<FakeRouteApp, "get">, trace: string[]) => {
            app.get("/v1/test", {
                onRequest: [async () => { trace.push("onRequest"); }],
                preHandler: [
                    async (_request: unknown, reply: ReturnType<typeof createReplyStub>) => {
                        trace.push("reject");
                        reply.code(404).send({ error: "not_found" });
                        // Fastify must stop even without a return value.
                    },
                    async () => { trace.push("laterPreHandler"); },
                ],
            }, async () => {
                trace.push("handler");
                return { ok: true };
            });
        };

        const fastifyTrace: string[] = [];
        await withAuthenticatedTestApp(
            (app) => registerRoutes(app, fastifyTrace),
            async (app) => {
                const response = await app.inject({ method: "GET", url: "/v1/test" });
                expect(response.statusCode).toBe(404);
                expect(response.json()).toEqual({ error: "not_found" });
            },
        );
        expect(fastifyTrace).toEqual(["onRequest", "reject"]);

        const fakeTrace: string[] = [];
        const app = createFakeRouteApp();
        registerRoutes(app, fakeTrace);
        const reply = createReplyStub();

        await expect(getRouteHandler(app, "GET", "/v1/test")(createRouteRequest(), reply)).resolves.toBeUndefined();

        expect(reply.statusCode).toBe(404);
        expect(reply.sent).toBe(true);
        expect(reply.send).toHaveBeenCalledWith({ error: "not_found" });
        expect(fakeTrace).toEqual(fastifyTrace);
    });
});
