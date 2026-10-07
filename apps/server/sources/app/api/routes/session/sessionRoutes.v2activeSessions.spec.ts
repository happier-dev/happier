import { beforeEach, describe, expect, it } from "vitest";

import {
    createSessionRouteTestBuilder,
    accountFindUnique,
    createSessionAccessProjectionRelations,
    createSessionDataKeyEnvelopeFixture,
    flattenSessionWhereConjuncts,
    resetSessionRouteMocks,
    sessionFindMany,
} from "./sessionRoutes.testkit";

const STORED_OWNER_METADATA_ENVELOPE_V1 = JSON.stringify({
    t: "encrypted",
    c: "oRoBAgMEBQYHCAkKCwwNDg8QERITFBUWFxh8aC0+8+YDECLScN6uQTItPyWVR7XbQA==",
});
const STORED_SHARED_METADATA_V1 = JSON.stringify({ v: 1 });

describe("sessionRoutes v2 active sessions listing", () => {
    beforeEach(() => {
        resetSessionRouteMocks();
        sessionFindMany.mockReset();
    });

    it("uses the active-family bound for an unqualified request", async () => {
        sessionFindMany.mockResolvedValue([]);

        const route = await createSessionRouteTestBuilder("GET", "/v2/sessions/active");
        await route.invoke({ query: {} });

        expect(sessionFindMany.mock.calls[0]?.[0]).toEqual(expect.objectContaining({ take: 500 }));
    });

    it("reuses the canonical v2 row contract and visibility while filtering to the active window", async () => {
        const now = new Date(1_000);
        sessionFindMany.mockResolvedValueOnce([
            {
                ...createSessionAccessProjectionRelations(),
                id: "owned-active",
                seq: 3,
                currentStorageState: "hosted",
                acceptedThroughServerSeq: null,
                materializationPublicationId: null,
                materializedThroughSourceAt: null,
                publishedThroughServerSeq: null,
                accountId: "u1",
                encryptionMode: "e2ee",
                createdAt: now,
                updatedAt: now,
                meaningfulActivityAt: now,
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
                    dataKeyEnvelopes: [createSessionDataKeyEnvelopeFixture(Buffer.from([1, 2, 3]))],
                    active: true,
                    lastActiveAt: now,
                    accountReadStates: [{ accountId: "u1", lastViewedSessionSeq: 2, unreadSince: null }],
                    accountFollows: [],
                    sessionPins: [],
                    sessionAttentionStandings: [],
                    shares: [],
                    teamGrants: [],
                    groupGrants: [],
            },
            {
                ...createSessionAccessProjectionRelations(),
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
                ownerMetadata: STORED_OWNER_METADATA_ENVELOPE_V1,
                agentState: null,
                agentStateVersion: 0,
                lastViewedSessionSeq: 1,
                pendingPermissionRequestCount: 0,
                pendingUserActionRequestCount: 2,
                pendingCount: 3,
                pendingVersion: 5,
                    dataKeyEnvelopes: [createSessionDataKeyEnvelopeFixture(Buffer.from([4, 5]))],
                    active: true,
                    lastActiveAt: now,
                    accountReadStates: [{ accountId: "u1", lastViewedSessionSeq: 1, unreadSince: null }],
                    accountFollows: [],
                    sessionPins: [],
                    sessionAttentionStandings: [],
                    shares: [
                        {
                            id: "shared-active-grant",
                            sharedWithUserId: "u1",
                        accessLevel: "edit",
                        canApprovePermissions: true,
                        },
                    ],
                    teamGrants: [],
                    groupGrants: [],
            },
            {
                ...createSessionAccessProjectionRelations(),
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
                metadata: STORED_SHARED_METADATA_V1,
                metadataVersion: 1,
                agentState: null,
                agentStateVersion: 0,
                lastViewedSessionSeq: 0,
                pendingPermissionRequestCount: 0,
                pendingUserActionRequestCount: 0,
                pendingCount: 0,
                pendingVersion: 0,
                    dataKeyEnvelopes: [],
                    active: true,
                    lastActiveAt: now,
                    accountReadStates: [{ accountId: "u1", lastViewedSessionSeq: 0, unreadSince: null }],
                    accountFollows: [],
                    sessionPins: [],
                    sessionAttentionStandings: [],
                    shares: [{
                        id: "shared-partial-grant",
                        sharedWithUserId: "u1",
                    accessLevel: "view",
                        canApprovePermissions: false,
                    }],
                    teamGrants: [],
                    groupGrants: [],
            },
        ]).mockResolvedValue([]);

        const route = await createSessionRouteTestBuilder("GET", "/v2/sessions/active");
        const { response: res } = await route.invoke({
            query: { limit: 2 },
        });

        const firstQuery = sessionFindMany.mock.calls[0]?.[0];
        expect(firstQuery).toEqual(
            expect.objectContaining({
                orderBy: [
                    { lastActiveAt: "desc" },
                    { id: "desc" },
                ],
                take: 2,
                select: expect.objectContaining({
                    accountId: true,
                    pendingCount: true,
                    pendingVersion: true,
                    dataKeyEnvelopes: expect.objectContaining({
                        where: { recipientAccountId: "u1" },
                        select: expect.objectContaining({ encryptedDataKey: true }),
                    }),
                    shares: expect.objectContaining({
                        // The direct-share relation is filtered to currently
                        // active recipient Accounts by the access owner.
                        where: { sharedWithUserId: { in: ["u1"] }, sharedWithUser: { status: "active" } },
                        select: expect.objectContaining({
                            accessLevel: true,
                            canApprovePermissions: true,
                        }),
                    }),
                }),
            }),
        );
        expect(flattenSessionWhereConjuncts(firstQuery?.where)).toEqual(expect.arrayContaining([
            { archivedAt: null },
            { currentStorageState: "hosted" },
            { active: true, lastActiveAt: { gt: expect.any(Date) } },
            expect.objectContaining({
                OR: expect.arrayContaining([
                    { accountId: "u1", account: { status: "active" } },
                    expect.objectContaining({
                        AND: expect.arrayContaining([
                            expect.objectContaining({
                                OR: expect.arrayContaining([
                                    expect.objectContaining({
                                        shares: { some: expect.objectContaining({ sharedWithUserId: "u1" }) },
                                    }),
                                ]),
                            }),
                        ]),
                    }),
                ]),
            }),
        ]));

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
            ...createSessionAccessProjectionRelations(),
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
            metadata: STORED_SHARED_METADATA_V1,
            metadataVersion: 1,
            metadataLayoutVersion: 1,
            ownerMetadata: STORED_OWNER_METADATA_ENVELOPE_V1,
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
            accountReadStates: [{ accountId: "u1", lastViewedSessionSeq: 0, unreadSince: null }],
            accountFollows: [],
            sessionPins: [],
            sessionAttentionStandings: [],
            shares: [{
                id: `${id}-grant`,
                sharedWithUserId: "u1",
                encryptedDataKey: null,
                accessLevel: "view",
                canApprovePermissions: false,
            }],
            teamGrants: [],
            groupGrants: [],
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
        expect(accountFindUnique).toHaveBeenCalledTimes(1);
        expect(accountFindUnique).toHaveBeenCalledWith(expect.objectContaining({
            where: { id: "owner" },
        }));
    });

    it("omits the unmigrated layout-zero shared active row instead of refusing the page", async () => {
        const now = new Date(1_000);
        sessionFindMany.mockResolvedValue([{
            ...createSessionAccessProjectionRelations(),
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

        // Per-row degradation: the unreadable historical share is dropped and the
        // refusal stays visible through the count, never a request-wide 409.
        expect(reply.statusCode).toBe(200);
        const payload = response as {
            sessions: ReadonlyArray<{ id: string }>;
            metadataUpgradeRequiredCount?: number;
        };
        expect(payload.sessions).toEqual([]);
        expect(payload.metadataUpgradeRequiredCount).toBe(1);
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
