import { beforeEach, describe, expect, it } from "vitest";

import {
    createSessionRouteTestBuilder,
    resetSessionRouteMocks,
    checkSessionAccess,
    clearSessionRuntimeActivityProjectionInTx,
    getSessionParticipantUserIds,
    buildUpdateSessionUpdate,
    emitUpdate,
    sessionFindUnique,
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
        clearSessionRuntimeActivityProjectionInTx.mockResolvedValue({
            ok: true,
            didWrite: true,
            projection: {
                runtimeActivityState: "unknown",
                runtimeActivityActiveCount: 0,
                runtimeActivityObservedAt: null,
                runtimeActivityRevision: 9,
            },
            participantCursors: [],
            badgeAttentionChanged: false,
        });
        sessionFindUnique.mockResolvedValue({
            accountId: "owner",
            currentStorageState: "snapshot_complete",
            acceptedThroughServerSeq: 4,
            materializationPublicationId: "archive-publication-v1",
            materializedThroughSourceAt: 42_000n,
            publishedThroughServerSeq: 4,
            seq: 9,
            lastViewedSessionSeq: 9,
            latestReadyEventSeq: null,
            latestReadyEventAt: null,
            createdAt: new Date(10_000),
            updatedAt: new Date(90_000),
            meaningfulActivityAt: new Date(90_000),
            lastActiveAt: new Date(90_000),
        });

        const route = await createSessionRouteTestBuilder("POST", "/v2/sessions/:sessionId/archive");
        const { reply, response: res } = await route.invoke({ params: { sessionId: "s1" } });

        expect(reply.code).not.toHaveBeenCalledWith(403);
        expect(res).toEqual({ success: true, archivedAt: now.getTime() });
        expect(clearSessionRuntimeActivityProjectionInTx).toHaveBeenCalledWith(expect.objectContaining({
            sessionId: "s1",
        }));
        expect(markAccountChanged).toHaveBeenCalledTimes(2);
        expect(buildUpdateSessionUpdate).toHaveBeenCalledWith(
            "s1",
            expect.any(Number),
            expect.any(String),
            undefined,
            undefined,
            {
                archivedAt: now.getTime(),
                runtimeActivityState: "unknown",
                runtimeActivityActiveCount: 0,
                runtimeActivityObservedAt: null,
                runtimeActivityRevision: 9,
            },
        );
        expect(emitUpdate).toHaveBeenCalledTimes(4);
        expect(emitUpdate).toHaveBeenCalledWith(expect.objectContaining({
            recipientFilter: {
                type: "all-interested-in-session",
                sessionId: "s1",
            },
        }));
        expect(emitUpdate).toHaveBeenCalledWith(expect.objectContaining({
            recipientFilter: { type: "user-machine-scoped-only" },
        }));
    });

    it("returns 409 when attempting to archive an active session", async () => {
        checkSessionAccess.mockResolvedValue({ level: "admin" });
        txSessionFindUnique.mockResolvedValue({ id: "s1", active: true, archivedAt: null });

        const route = await createSessionRouteTestBuilder("POST", "/v2/sessions/:sessionId/archive");
        const { reply, response: res } = await route.invoke({ params: { sessionId: "s1" } });

        expect(reply.code).toHaveBeenCalledWith(409);
        expect(res).toEqual({ error: "session-active" });
        expect(txSessionUpdate).not.toHaveBeenCalled();
    });

    it("returns 403 when actor is not admin", async () => {
        checkSessionAccess.mockResolvedValue({ level: "edit" });

        const route = await createSessionRouteTestBuilder("POST", "/v2/sessions/:sessionId/archive");
        const { reply, response: res } = await route.invoke({ params: { sessionId: "s1" } });

        expect(reply.code).toHaveBeenCalledWith(403);
        expect(res).toEqual({ error: "Forbidden" });
    });

    it("unarchives an archived session when actor is admin", async () => {
        checkSessionAccess.mockResolvedValue({ level: "admin" });
        getSessionParticipantUserIds.mockResolvedValue(["owner"]);
        txSessionFindUnique.mockResolvedValue({ id: "s1", active: false, archivedAt: new Date(1) });
        txSessionUpdate.mockResolvedValue({ id: "s1", archivedAt: null });

        const route = await createSessionRouteTestBuilder("POST", "/v2/sessions/:sessionId/unarchive");
        const { response: res } = await route.invoke({ params: { sessionId: "s1" } });

        expect(res).toEqual({ success: true, archivedAt: null });
        expect(markAccountChanged).toHaveBeenCalledTimes(1);
        expect(buildUpdateSessionUpdate).toHaveBeenCalledWith(
            "s1",
            expect.any(Number),
            expect.any(String),
            undefined,
            undefined,
            { archivedAt: null },
        );
        expect(emitUpdate).toHaveBeenCalledTimes(2);
        expect(emitUpdate).toHaveBeenCalledWith(expect.objectContaining({
            recipientFilter: {
                type: "all-interested-in-session",
                sessionId: "s1",
            },
        }));
        expect(emitUpdate).toHaveBeenCalledWith(expect.objectContaining({
            recipientFilter: { type: "user-machine-scoped-only" },
        }));
    });
});
