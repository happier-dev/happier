import { beforeEach, describe, expect, it } from "vitest";

import {
    createSessionRouteTestBuilder,
    resetSessionRouteMocks,
    sessionFindMany,
} from "./sessionRoutes.testkit";
import { V2_ACTIVE_SESSION_LIST_ROW_LIMIT } from "./v2SessionListPage";

describe("sessionRoutes v2 active sessions listing", () => {
    beforeEach(() => {
        resetSessionRouteMocks();
        sessionFindMany.mockReset();
    });

    it("reuses the canonical v2 row contract and visibility while filtering to the active window", async () => {
        const now = new Date(1_000);
        sessionFindMany.mockResolvedValue([
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
                runtimeActivityState: "unknown",
                runtimeActivityActiveCount: 0,
                runtimeActivityObservedAt: null,
                runtimeActivityRevision: 0,
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
                accountId: "owner",
                encryptionMode: "e2ee",
                createdAt: now,
                updatedAt: now,
                archivedAt: null,
                metadata: "m2",
                metadataVersion: 1,
                agentState: null,
                agentStateVersion: 0,
                runtimeActivityState: "unknown",
                runtimeActivityActiveCount: 0,
                runtimeActivityObservedAt: null,
                runtimeActivityRevision: 0,
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
        ]);

        const route = await createSessionRouteTestBuilder("GET", "/v2/sessions/active");
        const { response: res } = await route.invoke({
            query: { limit: 2 },
        });

        expect(sessionFindMany).toHaveBeenCalledWith(
            expect.objectContaining({
                where: expect.objectContaining({
                    OR: [
                        { accountId: "u1" },
                        { shares: { some: { sharedWithUserId: "u1" } } },
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
    });

    it("keeps archived sessions out of the active family", async () => {
        sessionFindMany.mockResolvedValue([]);

        const route = await createSessionRouteTestBuilder("GET", "/v2/sessions/active");
        await route.invoke({ query: { limit: 2 } });

        // Archiving removes a session from the list; still being live on a machine does not undo
        // that. Without this conjunct the endpoint was the one list read that injected archived
        // sessions back into the client's session list.
        expect(sessionFindMany).toHaveBeenCalledWith(
            expect.objectContaining({
                where: expect.objectContaining({ archivedAt: null }),
            }),
        );
    });

    /**
     * The active family has two readers — this endpoint and the `includeActive` branch of the initial
     * list page — and they must be bounded identically. They were not: the merged branch took
     * `V2_ACTIVE_SESSION_LIST_ROW_LIMIT` rows while this endpoint silently truncated an unqualified
     * request at 150.
     *
     * Truncation here has no recovery, because this response carries no cursor: unlike `/v2/sessions`
     * it returns `{ sessions }` alone, so a caller that hits the default has no way to ask for the
     * rest and cannot even tell it was cut. And the rows are not spare capacity — the client renders
     * every active session in the list's top "Active" section, with no client-side cap and no path
     * that backfills a row this family omitted (the cursor page is ordered by `meaningfulActivityAt`,
     * and a session can be live on a machine with its last meaningful activity weeks old). So the
     * smaller default was not a cheaper answer; it was a live session missing from the list.
     */
    it("bounds an unqualified request by the same limit the merged initial page uses", async () => {
        sessionFindMany.mockResolvedValue([]);

        const route = await createSessionRouteTestBuilder("GET", "/v2/sessions/active");
        await route.invoke({});

        expect(sessionFindMany).toHaveBeenCalledWith(
            expect.objectContaining({ take: V2_ACTIVE_SESSION_LIST_ROW_LIMIT }),
        );
    });

    it("still honours a smaller limit a client asks for", async () => {
        sessionFindMany.mockResolvedValue([]);

        const route = await createSessionRouteTestBuilder("GET", "/v2/sessions/active");
        await route.invoke({ query: { limit: 2 } });

        expect(sessionFindMany).toHaveBeenCalledWith(expect.objectContaining({ take: 2 }));
    });

    it("exposes diagnostic route timing headers only when explicitly requested", async () => {
        sessionFindMany.mockResolvedValue([]);

        const route = await createSessionRouteTestBuilder("GET", "/v2/sessions/active");
        const { reply } = await route.invoke({
            query: { limit: 2 },
            headers: { "x-happier-session-list-timing": "1" },
        });

        const serverTiming = reply.headers.get("server-timing");
        expect(serverTiming).toMatch(/happier_v2_sessions_query;dur=[0-9]+(?:\.[0-9]+)?/);
        expect(serverTiming).toMatch(/happier_v2_sessions_query_active;dur=[0-9]+(?:\.[0-9]+)?/);
        expect(serverTiming).toMatch(/happier_v2_sessions_total;dur=[0-9]+(?:\.[0-9]+)?/);
    });
});
