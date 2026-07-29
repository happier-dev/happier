import { beforeEach, describe, expect, it } from "vitest";

import {
    createSessionRouteTestBuilder,
    resetSessionRouteMocks,
    sessionFindMany,
} from "./sessionRoutes.testkit";

describe("sessionRoutes v2 active sessions listing", () => {
    beforeEach(() => {
        resetSessionRouteMocks();
        sessionFindMany.mockReset();
    });

    it("reuses the canonical v2 row contract and visibility while filtering to the active window", async () => {
        const now = new Date(1_000);
        sessionFindMany.mockResolvedValueOnce([
            {
                id: "owned-active",
                seq: 3,
                accountId: "u1",
                encryptionMode: "e2ee",
                createdAt: now,
                updatedAt: now,
                archivedAt: null,
                metadata: "m3",
                metadataVersion: 1,
                agentState: null,
                agentStateVersion: 0,
                lastViewedSessionSeq: 2,
                pendingPermissionRequestCount: 1,
                pendingUserActionRequestCount: 0,
                pendingCount: 4,
                pendingVersion: 8,
                dataEncryptionKey: Buffer.from([1, 2, 3]),
                active: true,
                lastActiveAt: now,
                shares: [],
            },
            {
                id: "shared-active",
                seq: 2,
                currentStorageState: "hosted",
                accountId: "owner",
                encryptionMode: "e2ee",
                createdAt: now,
                updatedAt: now,
                archivedAt: null,
                metadata: "m2",
                metadataVersion: 1,
                metadataLayoutVersion: 1,
                ownerMetadata: "oQoBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQGDb9gtt8Xqs3gDuzJU/wWRuslcRY3OZA==",
                agentState: null,
                agentStateVersion: 0,
                lastViewedSessionSeq: 1,
                pendingPermissionRequestCount: 0,
                pendingUserActionRequestCount: 2,
                pendingCount: 3,
                pendingVersion: 5,
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
            },
            {
                id: "shared-partial",
                seq: 1,
                currentStorageState: "server_partial",
                acceptedThroughServerSeq: 1,
                materializationPublicationId: null,
                materializedThroughSourceAt: null,
                publishedThroughServerSeq: null,
                accountId: "owner",
                encryptionMode: "plain",
                createdAt: now,
                updatedAt: now,
                archivedAt: null,
                metadata: "{}",
                metadataVersion: 1,
                agentState: null,
                agentStateVersion: 0,
                lastViewedSessionSeq: 0,
                pendingPermissionRequestCount: 0,
                pendingUserActionRequestCount: 0,
                pendingCount: 0,
                pendingVersion: 0,
                dataEncryptionKey: null,
                active: true,
                lastActiveAt: now,
                shares: [{
                    encryptedDataKey: null,
                    accessLevel: "view",
                    canApprovePermissions: false,
                }],
            },
        ]).mockResolvedValue([]);

        const route = await createSessionRouteTestBuilder("GET", "/v2/sessions/active");
        const { response: res } = await route.invoke({
            query: { limit: 2 },
        });

        expect(sessionFindMany).toHaveBeenCalledWith(
            expect.objectContaining({
                where: expect.objectContaining({
                    OR: [
                        { accountId: "u1" },
                        {
                            AND: [
                                { shares: { some: { sharedWithUserId: "u1" } } },
                                {
                                    OR: [
                                        { currentStorageState: "hosted" },
                                        {
                                            currentStorageState: "snapshot_complete",
                                            materializationPublicationId: { not: "" },
                                            materializedThroughSourceAt: {
                                                gte: 0,
                                                lte: BigInt(Number.MAX_SAFE_INTEGER),
                                            },
                                            publishedThroughServerSeq: { gte: 0 },
                                        },
                                    ],
                                },
                            ],
                        },
                    ],
                    active: true,
                    lastActiveAt: { gt: expect.any(Date) },
                }),
                orderBy: [
                    { lastActiveAt: "desc" },
                    { id: "desc" },
                ],
                take: 2,
                select: expect.objectContaining({
                    accountId: true,
                    pendingCount: true,
                    pendingVersion: true,
                    shares: {
                        where: { sharedWithUserId: "u1" },
                        select: {
                            encryptedDataKey: true,
                            accessLevel: true,
                            canApprovePermissions: true,
                        },
                    },
                }),
            }),
        );

        expect(res).toEqual({
            sessions: [
                expect.objectContaining({
                    id: "owned-active",
                    encryptionMode: "e2ee",
                    dataEncryptionKey: "AQID",
                    lastViewedSessionSeq: 2,
                    pendingPermissionRequestCount: 1,
                    pendingUserActionRequestCount: 0,
                    pendingCount: 4,
                    pendingVersion: 8,
                    share: null,
                    archivedAt: null,
                }),
                expect.objectContaining({
                    id: "shared-active",
                    encryptionMode: "e2ee",
                    dataEncryptionKey: "BAU=",
                    lastViewedSessionSeq: 1,
                    pendingPermissionRequestCount: 0,
                    pendingUserActionRequestCount: 2,
                    pendingCount: 3,
                    pendingVersion: 5,
                    share: { accessLevel: "edit", canApprovePermissions: true },
                    archivedAt: null,
                }),
            ],
        });
        expect((res as { sessions: Array<{ id: string }> }).sessions).not.toContainEqual(
            expect.objectContaining({ id: "shared-partial" }),
        );
    });

    it("refills equal-lastActiveAt rows without repeating an offset boundary row", async () => {
        const at = new Date(1_000);
        const sharedRow = (
            id: string,
            publicationId: string | null,
        ) => ({
            id,
            seq: 1,
            currentStorageState: publicationId === null ? "hosted" : "snapshot_complete",
            acceptedThroughServerSeq: null,
            materializationPublicationId: publicationId,
            materializedThroughSourceAt: publicationId === null ? null : 1_000n,
            publishedThroughServerSeq: publicationId === null ? null : 1,
            accountId: "owner",
            encryptionMode: "plain",
            createdAt: at,
            updatedAt: at,
            meaningfulActivityAt: at,
            archivedAt: null,
            metadata: "{}",
            metadataVersion: 1,
            metadataLayoutVersion: 1,
            ownerMetadata: "oQoBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQGDb9gtt8Xqs3gDuzJU/wWRuslcRY3OZA==",
            agentState: null,
            agentStateVersion: 0,
            lastViewedSessionSeq: 0,
            pendingPermissionRequestCount: 0,
            pendingUserActionRequestCount: 0,
            pendingRequestObservedAt: null,
            latestTurnId: null,
            latestTurnStatus: null,
            latestTurnStatusObservedAt: null,
            lastRuntimeIssue: null,
            runtimeActivityState: "unknown",
            runtimeActivityActiveCount: 0,
            runtimeActivityObservedAt: null,
            runtimeActivityRevision: 0,
            latestReadyEventSeq: null,
            latestReadyEventAt: null,
            thinking: false,
            thinkingAt: null,
            pendingCount: 0,
            pendingBlockedCount: 0,
            pendingVersion: 0,
            dataEncryptionKey: null,
            active: true,
            lastActiveAt: at,
            shares: [{
                encryptedDataKey: null,
                accessLevel: "view",
                canApprovePermissions: false,
            }],
        });
        const malformed = sharedRow("z-malformed", " ");
        const first = sharedRow("y-first", null);
        const boundary = sharedRow("x-boundary", null);
        sessionFindMany.mockImplementation(async (args) => {
            if (args.skip !== 2) return [malformed, first];
            const hasStableTieBreaker = Array.isArray(args.orderBy)
                && args.orderBy[1]?.id === "desc";
            return hasStableTieBreaker ? [boundary] : [first];
        });

        const route = await createSessionRouteTestBuilder("GET", "/v2/sessions/active");
        const { response } = await route.invoke({
            query: { limit: 2 },
        });

        expect((response as { sessions: Array<{ id: string }> }).sessions.map((session) => session.id))
            .toEqual(["y-first", "x-boundary"]);
        expect(sessionFindMany).toHaveBeenCalledWith(expect.objectContaining({
            orderBy: [
                { lastActiveAt: "desc" },
                { id: "desc" },
            ],
            skip: 2,
            take: 1,
        }));
    });

    it("preserves the released layout-zero shared active-row projection", async () => {
        const now = new Date(1_000);
        sessionFindMany.mockResolvedValue([{
            id: "legacy-shared-active",
            seq: 1,
            currentStorageState: "hosted",
            accountId: "owner",
            encryptionMode: "plain",
            createdAt: now,
            updatedAt: now,
            archivedAt: null,
            metadata: "legacy-whole-bag",
            metadataVersion: 1,
            ownerMetadata: null,
            metadataLayoutVersion: 0,
            agentState: "legacy-owner-state",
            agentStateVersion: 3,
            lastViewedSessionSeq: 0,
            pendingPermissionRequestCount: 0,
            pendingUserActionRequestCount: 0,
            pendingCount: 0,
            pendingVersion: 0,
            dataEncryptionKey: null,
            active: true,
            lastActiveAt: now,
            shares: [{
                encryptedDataKey: null,
                accessLevel: "view",
                canApprovePermissions: false,
            }],
        }]);

        const route = await createSessionRouteTestBuilder("GET", "/v2/sessions/active");
        const { reply, response } = await route.invoke({ query: { limit: 1 } });

        expect(reply.statusCode).toBe(200);
        expect(response).toEqual({
            sessions: [
                expect.objectContaining({
                    id: "legacy-shared-active",
                    metadata: "legacy-whole-bag",
                    metadataVersion: 1,
                    metadataLayoutVersion: 0,
                    agentState: "legacy-owner-state",
                    agentStateVersion: 3,
                    dataEncryptionKey: null,
                    share: {
                        accessLevel: "view",
                        canApprovePermissions: false,
                    },
                }),
            ],
        });
    });

    it("exposes diagnostic route timing headers only when explicitly requested", async () => {
        sessionFindMany.mockResolvedValue([]);

        const route = await createSessionRouteTestBuilder("GET", "/v2/sessions/active");
        const { reply } = await route.invoke({
            query: { limit: 2 },
            headers: { "x-happier-session-list-timing": "1" },
        });

        const headers = reply.headers as Record<string, string | undefined>;
        expect(headers["Server-Timing"] ?? headers["server-timing"]).toMatch(
            /happier_v2_sessions_cursor;dur=[0-9]+(?:\.[0-9]+)?, happier_v2_sessions_query;dur=[0-9]+(?:\.[0-9]+)?, happier_v2_sessions_page;dur=[0-9]+(?:\.[0-9]+)?, happier_v2_sessions_total;dur=[0-9]+(?:\.[0-9]+)?/,
        );
    });
});
