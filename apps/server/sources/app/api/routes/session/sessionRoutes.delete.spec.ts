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

    it("answers an absent or not-owned session with 404 and a lost delete condition with 409", async () => {
        const route = await createSessionRouteTestBuilder(
            "DELETE",
            "/v1/sessions/:sessionId",
        );

        sessionDelete.mockResolvedValueOnce({ ok: false, error: "not-found" });
        const absent = await route.invoke({ params: { sessionId: "s1" } });

        sessionDelete.mockResolvedValueOnce({ ok: false, error: "conflict" });
        const conflicted = await route.invoke({ params: { sessionId: "s1" } });

        expect(absent.reply.statusCode).toBe(404);
        expect(absent.response).toEqual({
            error: "Session not found or not owned by user",
        });
        expect(conflicted.reply.statusCode).toBe(409);
        expect(conflicted.response).toEqual({
            error: "Session delete condition was lost",
        });
    });
});
