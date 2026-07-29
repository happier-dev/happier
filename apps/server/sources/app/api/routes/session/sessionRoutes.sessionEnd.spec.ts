import { beforeEach, describe, expect, it } from "vitest";

import {
    createSessionRouteTestBuilder,
    emitEphemeral,
    emitUpdate,
    resetSessionRouteMocks,
    sessionFindUnique,
    sessionUpdate,
} from "./sessionRoutes.testkit";

describe("sessionRoutes legacy session end", () => {
    beforeEach(() => resetSessionRouteMocks());

    it("does not register an ordinary authenticated HTTP broad-end authority", async () => {
        const route = await createSessionRouteTestBuilder("POST", "/v1/sessions/:sessionId/end");

        expect(route.routeExists).toBe(false);
        expect(sessionFindUnique).not.toHaveBeenCalled();
        expect(sessionUpdate).not.toHaveBeenCalled();
        expect(emitUpdate).not.toHaveBeenCalled();
        expect(emitEphemeral).not.toHaveBeenCalled();
    });
});
