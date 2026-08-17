import { describe, expect, it } from "vitest";

import { createFakeRouteApp, getRouteEntry } from "../../testkit/routeHarness";
import { accountRoutes } from "./accountRoutes";

describe("accountRoutes (plugin Account Settings)", () => {
    it("registers the dedicated authenticated record route instead of exposing the reserved row through generic KV", () => {
        const app = createFakeRouteApp();
        accountRoutes(app as any);

        const read = getRouteEntry(app, "GET", "/v1/account/plugin-settings/:pluginId");
        const write = getRouteEntry(app, "POST", "/v1/account/plugin-settings/:pluginId");

        expect(read.opts.preHandler).toBe(app.authenticate);
        expect(write.opts.preHandler).toBe(app.authenticate);
        expect(read.opts.schema).toEqual(expect.objectContaining({
            params: expect.anything(),
            response: expect.objectContaining({ 200: expect.anything(), 503: expect.anything() }),
        }));
        expect(write.opts.schema).toEqual(expect.objectContaining({
            params: expect.anything(),
            body: expect.anything(),
            response: expect.objectContaining({ 200: expect.anything(), 503: expect.anything() }),
        }));
    });

    it("registers the separate authenticated Account-KV record route instead of reopening generic KV", () => {
        const app = createFakeRouteApp();
        accountRoutes(app as any);

        const read = getRouteEntry(app, "GET", "/v1/account/plugin-storage/:pluginId");
        const write = getRouteEntry(app, "POST", "/v1/account/plugin-storage/:pluginId");

        expect(read.opts.preHandler).toBe(app.authenticate);
        expect(write.opts.preHandler).toBe(app.authenticate);
        expect(read.opts.schema).toEqual(expect.objectContaining({
            params: expect.anything(),
            response: expect.objectContaining({ 200: expect.anything(), 503: expect.anything() }),
        }));
        expect(write.opts.schema).toEqual(expect.objectContaining({
            params: expect.anything(),
            body: expect.anything(),
            response: expect.objectContaining({ 200: expect.anything(), 503: expect.anything() }),
        }));
    });
});
