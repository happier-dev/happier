import { describe, expect, it } from "vitest";

import { createAuthenticatedRouteRequest, createRouteRequest } from "./requestFixtures";

describe("requestFixtures", () => {
    it("creates isolated default request bags", () => {
        const request = createRouteRequest();
        const nextRequest = createRouteRequest();

        request.params.id = "route-1";
        request.query.page = 2;
        request.headers.authorization = "Bearer token";

        expect(nextRequest.params).toEqual({});
        expect(nextRequest.query).toEqual({});
        expect(nextRequest.headers).toEqual({});
    });

    it("creates authenticated requests with merged route data", () => {
        const request = createAuthenticatedRouteRequest({
            userId: "user-42",
            params: { sessionId: "session-1" },
            query: { page: 3 },
            headers: { "x-test": "1" },
            body: { ok: true },
        });

        expect(request).toMatchObject({
            userId: "user-42",
            params: { sessionId: "session-1" },
            query: { page: 3 },
            headers: { "x-test": "1" },
            body: { ok: true },
        });
    });
});
