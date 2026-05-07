import { beforeEach, describe, expect, it } from "vitest";

import {
    applySessionReadCursorOperation,
    buildUpdateSessionUpdate,
    createSessionRouteTestBuilder,
    emitUpdate,
    randomKeyNaked,
    resetSessionRouteMocks,
} from "./sessionRoutes.testkit";

describe("sessionRoutes v2 read state", () => {
    beforeEach(() => {
        resetSessionRouteMocks();
    });

    it("marks a session unread through the read-state route", async () => {
        randomKeyNaked.mockReturnValueOnce("upd-a").mockReturnValueOnce("upd-b");
        applySessionReadCursorOperation.mockResolvedValue({
            ok: true,
            lastViewedSessionSeq: 6,
            participantCursors: [
                { accountId: "owner", cursor: 201 },
                { accountId: "u2", cursor: 202 },
            ],
            badgeAttentionChanged: false,
            didChange: true,
            readState: "unread",
        });

        const route = await createSessionRouteTestBuilder("POST", "/v2/sessions/:sessionId/read-state");
        const { response: res } = await route.invoke({
            params: { sessionId: "s1" },
            body: { state: "unread" },
        });

        expect(applySessionReadCursorOperation).toHaveBeenCalledWith({
            actorUserId: "u1",
            sessionId: "s1",
            operation: { kind: "mark-unread" },
        });
        expect(res).toEqual({
            success: true,
            state: "unread",
            lastViewedSessionSeq: 6,
            didChange: true,
        });
        expect(buildUpdateSessionUpdate).toHaveBeenNthCalledWith(1, "s1", 201, "upd-a", undefined, undefined, {
            lastViewedSessionSeq: 6,
        });
        expect(buildUpdateSessionUpdate).toHaveBeenNthCalledWith(2, "s1", 202, "upd-b", undefined, undefined, {
            lastViewedSessionSeq: 6,
        });
        expect(emitUpdate).toHaveBeenCalledWith(expect.objectContaining({
            recipientFilter: { type: "all-interested-in-session", sessionId: "s1" },
        }));
    });

    it("marks a session read through the read-state route", async () => {
        applySessionReadCursorOperation.mockResolvedValue({
            ok: true,
            lastViewedSessionSeq: 7,
            participantCursors: [],
            badgeAttentionChanged: false,
            didChange: false,
            readState: "read",
        });

        const route = await createSessionRouteTestBuilder("POST", "/v2/sessions/:sessionId/read-state");
        const { response: res } = await route.invoke({
            params: { sessionId: "s1" },
            body: { state: "read" },
        });

        expect(applySessionReadCursorOperation).toHaveBeenCalledWith({
            actorUserId: "u1",
            sessionId: "s1",
            operation: { kind: "mark-read" },
        });
        expect(res).toEqual({
            success: true,
            state: "read",
            lastViewedSessionSeq: 7,
            didChange: false,
        });
    });

    it("returns the canonical empty read state and declares it in the response schema", async () => {
        applySessionReadCursorOperation.mockResolvedValue({
            ok: true,
            lastViewedSessionSeq: 0,
            participantCursors: [],
            badgeAttentionChanged: false,
            didChange: false,
            readState: "empty",
        });

        const route = await createSessionRouteTestBuilder("POST", "/v2/sessions/:sessionId/read-state");
        const responseSchema = (
            route.app.routes.get("POST /v2/sessions/:sessionId/read-state")?.opts?.schema as
                | { response?: Record<number, { safeParse: (value: unknown) => { success: boolean } }> }
                | undefined
        )?.response?.[200];
        const { response: res } = await route.invoke({
            params: { sessionId: "s1" },
            body: { state: "read" },
        });

        expect(responseSchema?.safeParse({
            success: true,
            state: "empty",
            lastViewedSessionSeq: 0,
            didChange: false,
        }).success).toBe(true);
        expect(res).toEqual({
            success: true,
            state: "empty",
            lastViewedSessionSeq: 0,
            didChange: false,
        });
    });

    it("returns a nullable cursor when unread is already represented by null", async () => {
        applySessionReadCursorOperation.mockResolvedValue({
            ok: true,
            lastViewedSessionSeq: null,
            participantCursors: [],
            badgeAttentionChanged: false,
            didChange: false,
            readState: "unread",
        });

        const route = await createSessionRouteTestBuilder("POST", "/v2/sessions/:sessionId/read-state");
        const { response: res } = await route.invoke({
            params: { sessionId: "s1" },
            body: { state: "unread" },
        });

        expect(res).toEqual({
            success: true,
            state: "unread",
            lastViewedSessionSeq: null,
            didChange: false,
        });
        expect(buildUpdateSessionUpdate).not.toHaveBeenCalled();
    });

    it("rejects invalid read-state bodies", async () => {
        const route = await createSessionRouteTestBuilder("POST", "/v2/sessions/:sessionId/read-state");
        const { reply, response: res } = await route.invoke({
            params: { sessionId: "s1" },
            body: { state: "pending" },
        });

        expect(reply.code).toHaveBeenCalledWith(400);
        expect(res).toEqual({ error: "invalid-read-state" });
        expect(applySessionReadCursorOperation).not.toHaveBeenCalled();
    });

    it("maps forbidden service results to a forbidden response", async () => {
        applySessionReadCursorOperation.mockResolvedValue({ ok: false, error: "forbidden" });

        const route = await createSessionRouteTestBuilder("POST", "/v2/sessions/:sessionId/read-state");
        const { reply, response: res } = await route.invoke({
            params: { sessionId: "s1" },
            body: { state: "read" },
        });

        expect(reply.code).toHaveBeenCalledWith(403);
        expect(res).toEqual({ error: "Forbidden" });
    });
});
