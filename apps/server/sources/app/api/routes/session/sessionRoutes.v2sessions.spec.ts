import { beforeEach, describe, expect, it } from "vitest";

import {
    createSessionRouteReply,
    registerSessionRoutesAndGetHandler,
    resetSessionRouteMocks,
    sessionFindMany,
} from "./sessionRoutes.testkit";

describe("sessionRoutes v2 sessions snapshot", () => {
    beforeEach(() => {
        resetSessionRouteMocks();
        sessionFindMany.mockReset();
    });

    it("returns owned + shared sessions and uses share DEK for shared sessions", async () => {
        const now = new Date(1);
        sessionFindMany.mockResolvedValue([
            {
                id: "s3",
                seq: 3,
                accountId: "u1",
                createdAt: now,
                updatedAt: now,
                archivedAt: null,
                metadata: "m3",
                metadataVersion: 1,
                agentState: null,
                agentStateVersion: 0,
                dataEncryptionKey: Buffer.from([1, 2, 3]),
                active: true,
                lastActiveAt: now,
                shares: [],
            },
            {
                id: "s2",
                seq: 2,
                accountId: "owner",
                createdAt: now,
                updatedAt: now,
                archivedAt: null,
                metadata: "m2",
                metadataVersion: 1,
                agentState: null,
                agentStateVersion: 0,
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
                id: "s1",
                seq: 1,
                accountId: "u1",
                createdAt: now,
                updatedAt: now,
                archivedAt: null,
                metadata: "m1",
                metadataVersion: 1,
                agentState: null,
                agentStateVersion: 0,
                dataEncryptionKey: null,
                active: true,
                lastActiveAt: now,
                shares: [],
            },
        ]);

        const { handler } = await registerSessionRoutesAndGetHandler("GET", "/v2/sessions");
        const reply = createSessionRouteReply();

        const res = await handler(
            {
                userId: "u1",
                query: { limit: 2 },
            },
            reply,
        );

        expect(res).toEqual({
            sessions: [
                expect.objectContaining({
                    id: "s3",
                    dataEncryptionKey: "AQID",
                    share: null,
                    archivedAt: null,
                }),
                expect.objectContaining({
                    id: "s2",
                    dataEncryptionKey: "BAU=",
                    share: { accessLevel: "edit", canApprovePermissions: true },
                    archivedAt: null,
                }),
            ],
            nextCursor: "cursor_v1_s2",
            hasNext: true,
        });
    });
});
