import { beforeEach, describe, expect, it } from "vitest";

import {
    createSessionRouteTestBuilder,
    resetSessionRouteMocks,
    sessionFindFirst,
    sessionPendingMessageCount,
    sessionUpdate,
} from "./sessionRoutes.testkit";
import { DEFAULT_SESSION_ROLLBACK_ELIGIBLE_TURN_RELATION_LIMIT } from "./v2SessionHotReadLimits";

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
            archivedAt: null,
            metadata: "m1",
            metadataVersion: 2,
            ownerMetadata: "oQoBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQGDb9gtt8Xqs3gDuzJU/wWRuslcRY3OZA==",
            metadataLayoutVersion: 1,
            agentState: "full-owner-agent-state",
            agentStateVersion: 3,
            lastViewedSessionSeq: 1,
            pendingPermissionRequestCount: 2,
            pendingUserActionRequestCount: 0,
            latestTurnId: "turn-1",
            latestTurnStatus: "completed",
            latestTurnStatusObservedAt: BigInt(1_234),
            lastRuntimeIssue: null,
            turns: [
                {
                    transcriptAnchorsJson: JSON.stringify({ startUserMessageSeq: 4 }),
                    rollbackState: "eligible",
                },
            ],
            pendingCount: 0,
            pendingVersion: 0,
            dataEncryptionKey: Buffer.from([1, 2, 3]),
            active: true,
            lastActiveAt: now,
            shares: [],
        });

        const route = await createSessionRouteTestBuilder("GET", "/v2/sessions/:sessionId");
        const { response: res } = await route.invoke({ params: { sessionId: "s1" } });

        expect(sessionFindFirst).toHaveBeenCalledWith(expect.objectContaining({
            select: expect.objectContaining({
                turns: expect.objectContaining({ take: DEFAULT_SESSION_ROLLBACK_ELIGIBLE_TURN_RELATION_LIMIT }),
            }),
        }));
        expect(res).toEqual({
            session: expect.objectContaining({
                id: "s1",
                encryptionMode: "e2ee",
                metadata: "m1",
                ownerMetadata: "oQoBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQGDb9gtt8Xqs3gDuzJU/wWRuslcRY3OZA==",
                metadataLayoutVersion: 1,
                agentState: "full-owner-agent-state",
                agentStateVersion: 3,
                dataEncryptionKey: "AQID",
                lastViewedSessionSeq: 1,
                pendingPermissionRequestCount: 2,
                pendingUserActionRequestCount: 0,
                latestTurnId: "turn-1",
                latestTurnStatus: "completed",
                latestTurnStatusObservedAt: 1_234,
                rollbackEligibleTurnStarts: [4],
                share: null,
                archivedAt: null,
            }),
        });
    });

    it("falls back when rollback turn columns are unavailable", async () => {
        const now = new Date(1);
        sessionFindFirst
            .mockRejectedValueOnce(Object.assign(new Error("Column SessionTurn.rollbackState does not exist"), { code: "P2022" }))
            .mockResolvedValueOnce({
                id: "s1",
                seq: 9,
                currentStorageState: "server_partial",
                acceptedThroughServerSeq: 4,
                materializationPublicationId: null,
                materializedThroughSourceAt: null,
                publishedThroughServerSeq: null,
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
                lastViewedSessionSeq: 9,
                pendingPermissionRequestCount: 0,
                pendingUserActionRequestCount: 0,
                latestTurnId: "turn-1",
                latestTurnStatus: "completed",
                latestTurnStatusObservedAt: BigInt(1_234),
                lastRuntimeIssue: null,
                dataEncryptionKey: Buffer.from([1, 2, 3]),
                pendingCount: 0,
                pendingVersion: 0,
                active: true,
                lastActiveAt: now,
                shares: [],
            });

        const route = await createSessionRouteTestBuilder("GET", "/v2/sessions/:sessionId");
        const { response: res } = await route.invoke({ params: { sessionId: "s1" } });

        expect(sessionFindFirst).toHaveBeenCalledTimes(2);
        expect(sessionFindFirst.mock.calls[1]?.[0]?.select).not.toHaveProperty("turns");
        expect(sessionFindFirst.mock.calls[1]?.[0]?.select).toEqual(expect.objectContaining({
            currentStorageState: true,
            acceptedThroughServerSeq: true,
            materializationPublicationId: true,
            materializedThroughSourceAt: true,
            publishedThroughServerSeq: true,
        }));
        expect(res).toEqual({
            session: expect.objectContaining({
                id: "s1",
                seq: 4,
                lastViewedSessionSeq: 4,
            }),
        });
        expect(res).toEqual({
            session: expect.objectContaining({
                id: "s1",
                latestTurnStatus: "completed",
                latestTurnStatusObservedAt: 1_234,
                rollbackEligibleTurnStarts: [],
            }),
        });
    });

    it("returns shared session with share DEK and share info", async () => {
        const now = new Date(1);
        sessionFindFirst.mockResolvedValue({
            id: "s2",
            seq: 2,
            currentStorageState: "hosted",
            accountId: "owner",
            encryptionMode: "e2ee",
            createdAt: now,
            updatedAt: now,
            archivedAt: null,
            metadata: "m2",
            metadataVersion: 1,
            ownerMetadata: "oQoBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQGDb9gtt8Xqs3gDuzJU/wWRuslcRY3OZA==",
            metadataLayoutVersion: 1,
            agentState: "full-owner-agent-state",
            agentStateVersion: 7,
            lastViewedSessionSeq: 0,
            pendingPermissionRequestCount: 0,
            pendingUserActionRequestCount: 1,
            pendingCount: 0,
            pendingVersion: 0,
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
                metadata: "m2",
                metadataLayoutVersion: 1,
                dataEncryptionKey: "BAU=",
                lastViewedSessionSeq: 0,
                pendingPermissionRequestCount: 0,
                pendingUserActionRequestCount: 1,
                share: { accessLevel: "edit", canApprovePermissions: true },
                archivedAt: null,
            }),
        });
        if (!res || typeof res !== "object" || !("session" in res)) {
            throw new Error("Expected a session response");
        }
        expect(res.session).not.toHaveProperty("ownerMetadata");
        expect(res.session).toMatchObject({
            agentState: null,
            agentStateVersion: 7,
        });
        expect(JSON.stringify(res.session)).not.toMatch(
            /oQoBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQGDb9gtt8Xqs3gDuzJU\/wWRuslcRY3OZA==|full-owner-agent-state/,
        );
    });

    it("preserves the released layout-zero shared by-id projection", async () => {
        const now = new Date(1);
        sessionFindFirst.mockResolvedValue({
            id: "legacy-shared",
            seq: 2,
            currentStorageState: "hosted",
            accountId: "owner",
            encryptionMode: "e2ee",
            createdAt: now,
            updatedAt: now,
            archivedAt: null,
            metadata: "legacy-whole-bag",
            metadataVersion: 1,
            ownerMetadata: null,
            metadataLayoutVersion: 0,
            agentState: "legacy-owner-state",
            agentStateVersion: 7,
            lastViewedSessionSeq: 0,
            pendingPermissionRequestCount: 0,
            pendingUserActionRequestCount: 0,
            pendingCount: 0,
            pendingVersion: 0,
            dataEncryptionKey: null,
            active: true,
            lastActiveAt: now,
            shares: [
                {
                    encryptedDataKey: Buffer.from([4, 5]),
                    accessLevel: "view",
                    canApprovePermissions: false,
                },
            ],
        });

        const route = await createSessionRouteTestBuilder("GET", "/v2/sessions/:sessionId");
        const { reply, response: res } = await route.invoke({ params: { sessionId: "legacy-shared" } });

        expect(reply.statusCode).toBe(200);
        expect(res).toEqual({
            session: expect.objectContaining({
                id: "legacy-shared",
                metadata: "legacy-whole-bag",
                metadataVersion: 1,
                metadataLayoutVersion: 0,
                agentState: "legacy-owner-state",
                agentStateVersion: 7,
                dataEncryptionKey: "BAU=",
                share: {
                    accessLevel: "view",
                    canApprovePermissions: false,
                },
            }),
        });
        expect(sessionFindFirst).toHaveBeenCalledWith(expect.objectContaining({
            select: expect.objectContaining({
                accountId: true,
                metadataLayoutVersion: true,
                ownerMetadata: true,
                agentState: true,
                agentStateVersion: true,
            }),
        }));
    });

    it.each(["machine_only", "server_partial"] as const)(
        "returns not found to a shared viewer while transcript storage is %s",
        async (currentStorageState) => {
            const now = new Date(1);
            sessionFindFirst.mockResolvedValue({
                id: "s2",
                seq: 2,
                currentStorageState,
                acceptedThroughServerSeq: currentStorageState === "server_partial" ? 1 : null,
                materializationPublicationId: null,
                materializedThroughSourceAt: null,
                publishedThroughServerSeq: null,
                accountId: "owner",
                encryptionMode: "e2ee",
                createdAt: now,
                updatedAt: now,
                archivedAt: null,
                metadata: "m2",
                metadataVersion: 1,
                agentState: null,
                agentStateVersion: 0,
                lastViewedSessionSeq: 0,
                pendingPermissionRequestCount: 0,
                pendingUserActionRequestCount: 0,
                pendingCount: 0,
                pendingVersion: 0,
                dataEncryptionKey: null,
                active: false,
                lastActiveAt: now,
                shares: [{
                    encryptedDataKey: Buffer.from([4, 5]),
                    accessLevel: "view",
                    canApprovePermissions: false,
                }],
            });

            const route = await createSessionRouteTestBuilder("GET", "/v2/sessions/:sessionId");
            const { reply } = await route.invoke({ params: { sessionId: "s2" } });

            expect(reply.code).toHaveBeenCalledWith(404);
            expect(reply.send).toHaveBeenCalledWith({ error: "Session not found" });
        },
    );

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
            turns: [],
            dataEncryptionKey: null,
            pendingCount: 0,
            pendingVersion: 4,
            active: true,
            lastActiveAt: now,
            shares: [],
        });
        sessionPendingMessageCount.mockResolvedValue(2);
        sessionUpdate.mockResolvedValue({ pendingCount: 2, pendingVersion: 5 });

        const route = await createSessionRouteTestBuilder("GET", "/v2/sessions/:sessionId");
        const { response: res } = await route.invoke({ params: { sessionId: "s-drift" } });

        expect(sessionPendingMessageCount).not.toHaveBeenCalled();
        expect(sessionUpdate).not.toHaveBeenCalled();
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
