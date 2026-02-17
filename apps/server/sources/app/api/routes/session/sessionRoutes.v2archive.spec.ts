import { beforeEach, describe, expect, it } from "vitest";

import {
    createSessionRouteReply,
    registerSessionRoutesAndGetHandler,
    resetSessionRouteMocks,
    checkSessionAccess,
    getSessionParticipantUserIds,
    txSessionFindUnique,
    txSessionUpdate,
    markAccountChanged,
} from "./sessionRoutes.testkit";

describe("sessionRoutes v2 archive", () => {
    beforeEach(() => {
        resetSessionRouteMocks();
    });

    it("archives an inactive session when actor is admin", async () => {
        const now = new Date(1234);
        checkSessionAccess.mockResolvedValue({ level: "admin" });
        getSessionParticipantUserIds.mockResolvedValue(["owner", "u2"]);
        txSessionFindUnique.mockResolvedValue({ id: "s1", active: false, archivedAt: null });
        txSessionUpdate.mockResolvedValue({ id: "s1", archivedAt: now });

        const { handler } = await registerSessionRoutesAndGetHandler("POST", "/v2/sessions/:sessionId/archive");
        const reply = createSessionRouteReply();

        const res = await handler(
            {
                userId: "u1",
                params: { sessionId: "s1" },
            },
            reply,
        );

        expect(reply.code).not.toHaveBeenCalledWith(403);
        expect(res).toEqual({ success: true, archivedAt: now.getTime() });
        expect(markAccountChanged).toHaveBeenCalledTimes(2);
    });

    it("returns 409 when attempting to archive an active session", async () => {
        checkSessionAccess.mockResolvedValue({ level: "admin" });
        txSessionFindUnique.mockResolvedValue({ id: "s1", active: true, archivedAt: null });

        const { handler } = await registerSessionRoutesAndGetHandler("POST", "/v2/sessions/:sessionId/archive");
        const reply = createSessionRouteReply();

        const res = await handler(
            {
                userId: "u1",
                params: { sessionId: "s1" },
            },
            reply,
        );

        expect(reply.code).toHaveBeenCalledWith(409);
        expect(res).toEqual({ error: "session-active" });
        expect(txSessionUpdate).not.toHaveBeenCalled();
    });

    it("returns 403 when actor is not admin", async () => {
        checkSessionAccess.mockResolvedValue({ level: "edit" });

        const { handler } = await registerSessionRoutesAndGetHandler("POST", "/v2/sessions/:sessionId/archive");
        const reply = createSessionRouteReply();

        const res = await handler(
            {
                userId: "u1",
                params: { sessionId: "s1" },
            },
            reply,
        );

        expect(reply.code).toHaveBeenCalledWith(403);
        expect(res).toEqual({ error: "Forbidden" });
    });

    it("unarchives an archived session when actor is admin", async () => {
        checkSessionAccess.mockResolvedValue({ level: "admin" });
        getSessionParticipantUserIds.mockResolvedValue(["owner"]);
        txSessionFindUnique.mockResolvedValue({ id: "s1", active: false, archivedAt: new Date(1) });
        txSessionUpdate.mockResolvedValue({ id: "s1", archivedAt: null });

        const { handler } = await registerSessionRoutesAndGetHandler("POST", "/v2/sessions/:sessionId/unarchive");
        const reply = createSessionRouteReply();

        const res = await handler(
            {
                userId: "u1",
                params: { sessionId: "s1" },
            },
            reply,
        );

        expect(res).toEqual({ success: true, archivedAt: null });
        expect(markAccountChanged).toHaveBeenCalledTimes(1);
    });
});

