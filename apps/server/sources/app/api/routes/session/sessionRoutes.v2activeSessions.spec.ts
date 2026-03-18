import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
    createSessionRouteReply,
    preloadSessionRoutes,
    registerSessionRoutesAndGetHandler,
    resetSessionRouteMocks,
    sessionFindMany,
} from "./sessionRoutes.testkit";

describe("sessionRoutes v2 active sessions listing", () => {
    beforeAll(async () => {
        await preloadSessionRoutes();
    }, 120_000);

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

        const { handler } = await registerSessionRoutesAndGetHandler("GET", "/v2/sessions/active");
        const reply = createSessionRouteReply();

        const res = await handler(
            {
                userId: "u1",
                query: { limit: 2 },
            },
            reply,
        );

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
                orderBy: { lastActiveAt: "desc" },
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
});
