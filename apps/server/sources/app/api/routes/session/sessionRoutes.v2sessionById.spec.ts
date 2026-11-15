import { beforeEach, describe, expect, it } from "vitest";

import {
    createSessionRouteTestBuilder,
    resetSessionRouteMocks,
    sessionFindFirst,
    txSessionPendingMessageCount,
    txSessionUpdateMany,
} from "./sessionRoutes.testkit";

describe("sessionRoutes v2 session by id", () => {
    beforeEach(() => {
        resetSessionRouteMocks();
        sessionFindFirst.mockReset();
    });

    it("returns owned session with raw session DEK and share=null", async () => {
        const now = new Date(1);
        sessionFindFirst.mockResolvedValue({
            id: "s1",
            seq: 1,
            accountId: "u1",
            encryptionMode: "e2ee",
            createdAt: now,
            updatedAt: now,
            meaningfulActivityAt: now,
            archivedAt: null,
            metadata: "m1",
            metadataVersion: 2,
            agentState: null,
            agentStateVersion: 3,
            lastViewedSessionSeq: 1,
            pendingPermissionRequestCount: 2,
            pendingUserActionRequestCount: 0,
            pendingCount: 0,
            _count: { pendingMessages: 0 },
            pendingVersion: 0,
            latestTurnId: "turn-1",
            latestTurnStatus: "in_progress",
            latestTurnStatusObservedAt: 1_234,
            lastRuntimeIssue: null,
            runtimeActivityState: "active",
            runtimeActivityRevision: BigInt(5),
            runtimeActivityActiveCount: 2,
            runtimeActivityObservedAt: BigInt(2_000),
            dataEncryptionKey: Buffer.from([1, 2, 3]),
            active: true,
            lastActiveAt: now,
            shares: [],
        });

        const route = await createSessionRouteTestBuilder("GET", "/v2/sessions/:sessionId");
        const { response: res } = await route.invoke({ params: { sessionId: "s1" } });

        expect(res).toEqual({
            session: expect.objectContaining({
                id: "s1",
                encryptionMode: "e2ee",
                dataEncryptionKey: "AQID",
                lastViewedSessionSeq: 1,
                pendingPermissionRequestCount: 2,
                pendingUserActionRequestCount: 0,
                pendingBlockedNoEffectCount: 0,
                latestTurnId: "turn-1",
                latestTurnStatus: "in_progress",
                latestTurnStatusObservedAt: 1_234,
                runtimeActivityState: "active",
                runtimeActivityRevision: 5,
                runtimeActivityActiveCount: 2,
                runtimeActivityObservedAt: 2_000,
                share: null,
                archivedAt: null,
            }),
        });
    });

    it("returns shared session with share DEK and share info", async () => {
        const now = new Date(1);
        sessionFindFirst.mockResolvedValue({
            id: "s2",
            seq: 2,
            accountId: "owner",
            encryptionMode: "e2ee",
            createdAt: now,
            updatedAt: now,
            meaningfulActivityAt: now,
            archivedAt: null,
            metadata: "m2",
            metadataVersion: 1,
            agentState: null,
            agentStateVersion: 0,
            lastViewedSessionSeq: 0,
            pendingPermissionRequestCount: 0,
            pendingUserActionRequestCount: 1,
            pendingCount: 0,
            pendingVersion: 0,
            latestTurnStatus: null,
            latestTurnStatusObservedAt: null,
            lastRuntimeIssue: null,
            runtimeActivityState: "unknown",
            runtimeActivityRevision: BigInt(0),
            runtimeActivityActiveCount: 0,
            runtimeActivityObservedAt: null,
            dataEncryptionKey: null,
            active: true,
            lastActiveAt: now,
            shares: [
                {
                    encryptedDataKey: Buffer.from([4, 5]),
                    accessLevel: "edit",
                    canApprovePermissions: true,
                },
            ],
        });

        const route = await createSessionRouteTestBuilder("GET", "/v2/sessions/:sessionId");
        const { response: res } = await route.invoke({ params: { sessionId: "s2" } });

        expect(res).toEqual({
            session: expect.objectContaining({
                id: "s2",
                encryptionMode: "e2ee",
                dataEncryptionKey: "BAU=",
                lastViewedSessionSeq: 0,
                pendingPermissionRequestCount: 0,
                pendingUserActionRequestCount: 1,
                share: { accessLevel: "edit", canApprovePermissions: true },
                archivedAt: null,
            }),
        });
    });

    it("returns stored pending state without reconciling pending rows", async () => {
        const now = new Date(1);
        sessionFindFirst.mockResolvedValue({
            id: "s-drift",
            seq: 2,
            accountId: "u1",
            encryptionMode: "e2ee",
            createdAt: now,
            updatedAt: now,
            meaningfulActivityAt: now,
            archivedAt: null,
            metadata: "m2",
            metadataVersion: 1,
            agentState: null,
            agentStateVersion: 0,
            lastViewedSessionSeq: 0,
            pendingPermissionRequestCount: 0,
            pendingUserActionRequestCount: 0,
            latestTurnId: null,
            latestTurnStatus: null,
            latestTurnStatusObservedAt: null,
            lastRuntimeIssue: null,
            runtimeActivityState: "unknown",
            runtimeActivityRevision: BigInt(0),
            runtimeActivityActiveCount: 0,
            runtimeActivityObservedAt: null,
            dataEncryptionKey: null,
            pendingCount: 0,
            pendingVersion: 4,
            active: true,
            lastActiveAt: now,
            shares: [],
        });
        txSessionPendingMessageCount.mockResolvedValue(2);
        txSessionUpdateMany.mockResolvedValue({ count: 1 });

        const route = await createSessionRouteTestBuilder("GET", "/v2/sessions/:sessionId");
        const { response: res } = await route.invoke({ params: { sessionId: "s-drift" } });

        expect(txSessionPendingMessageCount).not.toHaveBeenCalled();
        expect(txSessionUpdateMany).not.toHaveBeenCalled();
        expect(res).toEqual({
            session: expect.objectContaining({
                id: "s-drift",
                pendingCount: 0,
                pendingVersion: 4,
            }),
        });
    });

    it("returns 404 when session is not accessible", async () => {
        sessionFindFirst.mockResolvedValue(null);

        const route = await createSessionRouteTestBuilder("GET", "/v2/sessions/:sessionId");
        const { reply, response: res } = await route.invoke({ params: { sessionId: "missing" } });

        expect(reply.code).toHaveBeenCalledWith(404);
        expect(res).toEqual({ error: "Session not found" });
    });

});
