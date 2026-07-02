import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
    applySessionTurnMutation,
    buildUpdateSessionUpdate,
    buildSessionActivityEphemeral,
    createSessionRouteTestBuilder,
    emitEphemeral,
    emitUpdate,
    getSessionParticipantUserIds,
    markAccountChanged,
    markSessionInactive,
    resetSessionRouteMocks,
    sessionFindUnique,
    sessionUpdate,
} from "./sessionRoutes.testkit";

describe("sessionRoutes session end", () => {
    let dateNowMock: ReturnType<typeof vi.spyOn> | null = null;

    function mockServerNow(now: number): void {
        dateNowMock?.mockRestore();
        dateNowMock = vi.spyOn(Date, "now").mockReturnValue(now);
    }

    beforeEach(() => {
        resetSessionRouteMocks();
    });

    afterEach(() => {
        dateNowMock?.mockRestore();
        dateNowMock = null;
    });

    it("marks an owned session inactive through the HTTP fallback route", async () => {
        mockServerNow(1_000);
        sessionFindUnique.mockResolvedValue({
            id: "s1",
            seq: 5,
            pendingCount: 0,
            lastViewedSessionSeq: 5,
            pendingPermissionRequestCount: 0,
            pendingUserActionRequestCount: 0,
            latestTurnId: "turn-1",
            latestTurnStatus: "in_progress",
            latestTurnStatusObservedAt: null,
            lastRuntimeIssue: null,
            active: true,
            archivedAt: null,
        });
        sessionUpdate.mockResolvedValue({});
        applySessionTurnMutation.mockResolvedValueOnce({
            ok: true,
            didApply: true,
            latestTurnId: "turn-1",
            latestTurnStatus: "cancelled",
            latestTurnStatusObservedAt: 1_000,
            lastRuntimeIssue: null,
            participantCursors: [
                { accountId: "u1", cursor: 101 },
                { accountId: "u2", cursor: 102 },
            ],
            badgeAttentionChanged: false,
        });

        const route = await createSessionRouteTestBuilder("POST", "/v1/sessions/:sessionId/end");
        const { response: res } = await route.invoke({
            params: { sessionId: "s1" },
            body: { time: 1_000 },
        });

        expect(markSessionInactive).toHaveBeenCalledWith("s1", "u1", 1_000);
        expect(sessionUpdate).toHaveBeenCalledWith({
            where: { id: "s1" },
            data: {
                lastActiveAt: new Date(1_000),
                active: false,
                thinking: false,
                thinkingAt: new Date(1_000),
            },
        });
        expect(applySessionTurnMutation).toHaveBeenCalledWith({
            actorUserId: "u1",
            mutation: {
                v: 1,
                sessionId: "s1",
                mutationId: "legacy-session-end:s1:1000",
                action: "end_session",
                turnId: "turn-1",
                observedAt: 1_000,
            },
        });
        expect(buildSessionActivityEphemeral).toHaveBeenCalledWith("s1", false, 1_000, false);
        expect(buildUpdateSessionUpdate).toHaveBeenNthCalledWith(1, "s1", 101, expect.any(String), undefined, undefined, {
            active: false,
            activeAt: 1_000,
            latestTurnId: "turn-1",
            latestTurnStatus: "cancelled",
            latestTurnStatusObservedAt: 1_000,
            lastRuntimeIssue: null,
        });
        expect(buildUpdateSessionUpdate).toHaveBeenNthCalledWith(2, "s1", 102, expect.any(String), undefined, undefined, {
            active: false,
            activeAt: 1_000,
            latestTurnId: "turn-1",
            latestTurnStatus: "cancelled",
            latestTurnStatusObservedAt: 1_000,
            lastRuntimeIssue: null,
        });
        expect(emitUpdate).toHaveBeenCalledTimes(2);
        expect(emitEphemeral).toHaveBeenCalledWith(expect.objectContaining({
            userId: "u1",
            recipientFilter: { type: "user-scoped-only" },
        }));
        expect(res).toEqual({ success: true, applied: true });
    });

    it("does not acknowledge session-end when active turn terminalization fails", async () => {
        mockServerNow(1_000);
        sessionFindUnique.mockResolvedValue({
            id: "s1",
            seq: 5,
            pendingCount: 0,
            lastViewedSessionSeq: 5,
            pendingPermissionRequestCount: 0,
            pendingUserActionRequestCount: 0,
            latestTurnId: "turn-1",
            latestTurnStatus: "in_progress",
            latestTurnStatusObservedAt: null,
            lastRuntimeIssue: null,
            active: true,
            archivedAt: null,
        });
        sessionUpdate.mockResolvedValue({});
        applySessionTurnMutation.mockResolvedValueOnce({ ok: false, error: "internal" });

        const route = await createSessionRouteTestBuilder("POST", "/v1/sessions/:sessionId/end");
        const { reply, response: res } = await route.invoke({
            params: { sessionId: "s1" },
            body: { time: 1_000 },
        });

        expect(applySessionTurnMutation).toHaveBeenCalledWith({
            actorUserId: "u1",
            mutation: expect.objectContaining({
                action: "end_session",
                turnId: "turn-1",
            }),
        });
        expect(sessionUpdate).not.toHaveBeenCalled();
        expect(markSessionInactive).not.toHaveBeenCalled();
        expect(emitEphemeral).not.toHaveBeenCalled();
        expect(reply.code).toHaveBeenCalledWith(500);
        expect(res).toEqual({ error: "Session end failed" });
    });

    it("does not mark a session inactive when turn terminalization is rejected by a newer active turn", async () => {
        mockServerNow(1_000);
        sessionFindUnique.mockResolvedValue({
            id: "s1",
            seq: 5,
            pendingCount: 0,
            lastViewedSessionSeq: 5,
            pendingPermissionRequestCount: 0,
            pendingUserActionRequestCount: 0,
            latestTurnId: "turn-1",
            latestTurnStatus: "in_progress",
            latestTurnStatusObservedAt: BigInt(500),
            meaningfulActivityAt: new Date(500),
            lastRuntimeIssue: null,
            active: true,
            archivedAt: null,
        });
        sessionUpdate.mockResolvedValue({});
        applySessionTurnMutation.mockResolvedValueOnce({
            ok: true,
            didApply: false,
            reason: "terminal-turn",
            latestTurnId: "turn-2",
            latestTurnStatus: "in_progress",
            latestTurnStatusObservedAt: 900,
            lastRuntimeIssue: null,
            participantCursors: [],
            badgeAttentionChanged: false,
        });

        const route = await createSessionRouteTestBuilder("POST", "/v1/sessions/:sessionId/end");
        const { response: res } = await route.invoke({
            params: { sessionId: "s1" },
            body: { time: 1_000 },
        });

        expect(applySessionTurnMutation).toHaveBeenCalledWith({
            actorUserId: "u1",
            mutation: {
                v: 1,
                sessionId: "s1",
                mutationId: "legacy-session-end:s1:1000",
                action: "end_session",
                turnId: "turn-1",
                observedAt: 1_000,
            },
        });
        expect(sessionUpdate).not.toHaveBeenCalled();
        expect(markSessionInactive).not.toHaveBeenCalled();
        expect(buildUpdateSessionUpdate).not.toHaveBeenCalled();
        expect(emitEphemeral).not.toHaveBeenCalled();
        expect(res).toEqual({ success: true, applied: false });
    });

    it("bounds generated legacy session-end mutation ids for oversized session ids", async () => {
        mockServerNow(1_000);
        const sessionId = `s${"x".repeat(240)}`;
        sessionFindUnique.mockResolvedValue({
            id: sessionId,
            seq: 5,
            pendingCount: 0,
            lastViewedSessionSeq: 5,
            pendingPermissionRequestCount: 0,
            pendingUserActionRequestCount: 0,
            latestTurnId: "turn-1",
            latestTurnStatus: "in_progress",
            latestTurnStatusObservedAt: null,
            lastRuntimeIssue: null,
            active: true,
            archivedAt: null,
        });
        sessionUpdate.mockResolvedValue({});
        applySessionTurnMutation.mockResolvedValueOnce({
            ok: true,
            didApply: false,
            reason: "duplicate-mutation",
            latestTurnId: "turn-1",
            latestTurnStatus: "cancelled",
            latestTurnStatusObservedAt: 1_000,
            lastRuntimeIssue: null,
            participantCursors: [],
            badgeAttentionChanged: false,
        });

        const route = await createSessionRouteTestBuilder("POST", "/v1/sessions/:sessionId/end");
        const { response: res } = await route.invoke({
            params: { sessionId },
            body: { time: 1_000 },
        });

        const mutation = applySessionTurnMutation.mock.calls[0]?.[0]?.mutation;
        expect(mutation.mutationId).toHaveLength(191);
        expect(mutation.mutationId).toMatch(/:1000$/);
        expect(res).toEqual({ success: true, applied: true });
    });

    it("clamps future session-end timestamps to the server clock", async () => {
        mockServerNow(1_000);
        sessionFindUnique.mockResolvedValue({
            id: "s1",
            seq: 5,
            pendingCount: 0,
            lastViewedSessionSeq: 5,
            pendingPermissionRequestCount: 0,
            pendingUserActionRequestCount: 0,
            latestTurnStatus: null,
            lastRuntimeIssue: null,
            active: true,
            archivedAt: null,
        });
        getSessionParticipantUserIds.mockResolvedValueOnce(["u1", "u2"]);
        markAccountChanged.mockResolvedValueOnce(201).mockResolvedValueOnce(202);
        sessionUpdate.mockResolvedValue({});

        const route = await createSessionRouteTestBuilder("POST", "/v1/sessions/:sessionId/end");
        const { response: res } = await route.invoke({
            params: { sessionId: "s1" },
            body: { time: 2_000 },
        });

        expect(markSessionInactive).toHaveBeenCalledWith("s1", "u1", 1_000);
        expect(sessionUpdate).toHaveBeenCalledWith({
            where: { id: "s1" },
            data: {
                lastActiveAt: new Date(1_000),
                active: false,
                thinking: false,
                thinkingAt: new Date(1_000),
            },
        });
        expect(buildUpdateSessionUpdate).toHaveBeenNthCalledWith(1, "s1", 201, expect.any(String), undefined, undefined, {
            active: false,
            activeAt: 1_000,
        });
        expect(buildUpdateSessionUpdate).toHaveBeenNthCalledWith(2, "s1", 202, expect.any(String), undefined, undefined, {
            active: false,
            activeAt: 1_000,
        });
        expect(emitUpdate).toHaveBeenCalledTimes(2);
        expect(res).toEqual({ success: true, applied: true });
    });

    it("marks active sessions inactive for stale persisted session-end timestamps", async () => {
        mockServerNow(1_000 * 60 * 20);
        sessionFindUnique.mockResolvedValue({
            id: "s1",
            seq: 5,
            pendingCount: 0,
            lastViewedSessionSeq: 5,
            pendingPermissionRequestCount: 0,
            pendingUserActionRequestCount: 0,
            latestTurnStatus: null,
            lastRuntimeIssue: null,
            active: true,
            archivedAt: null,
        });
        sessionUpdate.mockResolvedValue({});

        const route = await createSessionRouteTestBuilder("POST", "/v1/sessions/:sessionId/end");
        const { response: res } = await route.invoke({
            params: { sessionId: "s1" },
            body: { time: 1_000 },
        });

        expect(sessionFindUnique).toHaveBeenCalledWith(expect.objectContaining({
            where: { id: "s1", accountId: "u1" },
        }));
        expect(markSessionInactive).toHaveBeenCalledWith("s1", "u1", 1_000 * 60 * 20);
        expect(sessionUpdate).toHaveBeenCalledWith({
            where: { id: "s1" },
            data: {
                lastActiveAt: new Date(1_000 * 60 * 20),
                active: false,
                thinking: false,
                thinkingAt: new Date(1_000 * 60 * 20),
            },
        });
        expect(res).toEqual({ success: true, applied: true });
    });

    it("ignores stale session-end timestamps when newer session activity already exists", async () => {
        mockServerNow(1_000 * 60 * 20);
        sessionFindUnique.mockResolvedValue({
            id: "s1",
            seq: 5,
            pendingCount: 0,
            lastViewedSessionSeq: 5,
            pendingPermissionRequestCount: 0,
            pendingUserActionRequestCount: 0,
            latestTurnId: "turn-new",
            latestTurnStatus: "in_progress",
            latestTurnStatusObservedAt: BigInt(5_000),
            meaningfulActivityAt: new Date(5_000),
            lastRuntimeIssue: null,
            active: true,
            archivedAt: null,
        });

        const route = await createSessionRouteTestBuilder("POST", "/v1/sessions/:sessionId/end");
        const { response: res } = await route.invoke({
            params: { sessionId: "s1" },
            body: { time: 1_000 },
        });

        expect(sessionUpdate).not.toHaveBeenCalled();
        expect(applySessionTurnMutation).not.toHaveBeenCalled();
        expect(markSessionInactive).not.toHaveBeenCalled();
        expect(emitEphemeral).not.toHaveBeenCalled();
        expect(res).toEqual({ success: true, applied: false });
    });

    it("acknowledges already inactive session-end retries without duplicate writes", async () => {
        mockServerNow(1_000 * 60 * 20);
        sessionFindUnique.mockResolvedValue({
            id: "s1",
            seq: 5,
            pendingCount: 0,
            lastViewedSessionSeq: 5,
            pendingPermissionRequestCount: 0,
            pendingUserActionRequestCount: 0,
            latestTurnStatus: null,
            lastRuntimeIssue: null,
            active: false,
            archivedAt: null,
        });

        const route = await createSessionRouteTestBuilder("POST", "/v1/sessions/:sessionId/end");
        const { response: res } = await route.invoke({
            params: { sessionId: "s1" },
            body: { time: 1_000 },
        });

        expect(sessionUpdate).not.toHaveBeenCalled();
        expect(markSessionInactive).not.toHaveBeenCalled();
        expect(emitEphemeral).not.toHaveBeenCalled();
        expect(res).toEqual({ success: true, applied: false });
    });

    it("terminalizes an in-progress turn even when the session is already inactive", async () => {
        mockServerNow(1_000);
        sessionFindUnique.mockResolvedValue({
            id: "s1",
            seq: 5,
            pendingCount: 0,
            lastViewedSessionSeq: 5,
            pendingPermissionRequestCount: 0,
            pendingUserActionRequestCount: 0,
            latestTurnId: "turn-1",
            latestTurnStatus: "in_progress",
            latestTurnStatusObservedAt: BigInt(500),
            meaningfulActivityAt: new Date(500),
            lastRuntimeIssue: null,
            active: false,
            archivedAt: null,
        });
        applySessionTurnMutation.mockResolvedValueOnce({
            ok: true,
            didApply: true,
            latestTurnId: "turn-1",
            latestTurnStatus: "cancelled",
            latestTurnStatusObservedAt: 1_000,
            lastRuntimeIssue: null,
            participantCursors: [
                { accountId: "u1", cursor: 301 },
                { accountId: "u2", cursor: 302 },
            ],
            badgeAttentionChanged: false,
        });

        const route = await createSessionRouteTestBuilder("POST", "/v1/sessions/:sessionId/end");
        const { response: res } = await route.invoke({
            params: { sessionId: "s1" },
            body: { time: 1_000 },
        });

        expect(sessionUpdate).not.toHaveBeenCalled();
        expect(markSessionInactive).not.toHaveBeenCalled();
        expect(emitEphemeral).not.toHaveBeenCalled();
        expect(applySessionTurnMutation).toHaveBeenCalledWith({
            actorUserId: "u1",
            mutation: {
                v: 1,
                sessionId: "s1",
                mutationId: "legacy-session-end:s1:1000",
                action: "end_session",
                turnId: "turn-1",
                observedAt: 1_000,
            },
        });
        expect(buildUpdateSessionUpdate).toHaveBeenNthCalledWith(1, "s1", 301, expect.any(String), undefined, undefined, {
            latestTurnId: "turn-1",
            latestTurnStatus: "cancelled",
            latestTurnStatusObservedAt: 1_000,
            lastRuntimeIssue: null,
        });
        expect(buildUpdateSessionUpdate).toHaveBeenNthCalledWith(2, "s1", 302, expect.any(String), undefined, undefined, {
            latestTurnId: "turn-1",
            latestTurnStatus: "cancelled",
            latestTurnStatusObservedAt: 1_000,
            lastRuntimeIssue: null,
        });
        expect(emitUpdate).toHaveBeenCalledTimes(2);
        expect(res).toEqual({ success: true, applied: true });
    });

    it("returns not found when the session is not owned by the actor", async () => {
        sessionFindUnique.mockResolvedValue(null);

        const route = await createSessionRouteTestBuilder("POST", "/v1/sessions/:sessionId/end");
        const { reply, response: res } = await route.invoke({
            params: { sessionId: "s1" },
            body: { time: 123 },
        });

        expect(reply.code).toHaveBeenCalledWith(404);
        expect(res).toEqual({ error: "Session not found" });
        expect(sessionUpdate).not.toHaveBeenCalled();
    });
});
