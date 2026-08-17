import { beforeEach, describe, expect, it } from "vitest";
import {
    createSessionRouteTestBuilder,
    resetSessionRouteMocks,
    sessionDelete,
} from "./sessionRoutes.testkit";

describe("session delete", () => {
    beforeEach(() => {
        resetSessionRouteMocks();
    });

    it("does not require stored-content compatibility for an ID-only deletion", async () => {
        const route = await createSessionRouteTestBuilder(
            "DELETE",
            "/v1/sessions/:sessionId",
        );

        const result = await route.invoke({
            params: { sessionId: "s1" },
        });

        expect(sessionDelete).toHaveBeenCalledWith(
            { uid: "u1" },
            "s1",
        );
        expect(result.reply.statusCode).toBe(200);
        expect(result.response).toEqual({ success: true });
    });
});
