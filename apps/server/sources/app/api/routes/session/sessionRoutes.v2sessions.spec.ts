import { beforeEach, describe, expect, it } from "vitest";

import { encodeV2SessionListCursorV1 } from "@happier-dev/protocol";

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
                encryptionMode: "e2ee",
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
                encryptionMode: "e2ee",
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
                encryptionMode: "plain",
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
                    encryptionMode: "e2ee",
                    dataEncryptionKey: "AQID",
                    share: null,
                    archivedAt: null,
                }),
                expect.objectContaining({
                    id: "s2",
                    encryptionMode: "e2ee",
                    dataEncryptionKey: "BAU=",
                    share: { accessLevel: "edit", canApprovePermissions: true },
                    archivedAt: null,
                }),
            ],
            nextCursor: encodeV2SessionListCursorV1("s2"),
            hasNext: true,
        });
    });
});
