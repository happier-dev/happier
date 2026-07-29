import { beforeEach, describe, expect, it } from "vitest";

import {
    createSessionRouteTestBuilder,
    resetSessionRouteMocks,
    sessionFindMany,
} from "./sessionRoutes.testkit";

describe("sessionRoutes v2 archived sessions listing", () => {
    beforeEach(() => {
        resetSessionRouteMocks();
        sessionFindMany.mockReset();
    });

    it("filters to archived sessions and includes archivedAt", async () => {
        const now = new Date(1000);
        sessionFindMany
            .mockResolvedValueOnce([
                {
                    id: "s2",
                    seq: 2,
                    accountId: "u1",
                    encryptionMode: "e2ee",
                    createdAt: now,
                    updatedAt: now,
                    meaningfulActivityAt: now,
                    archivedAt: now,
                    metadata: "m2",
                    metadataVersion: 1,
                    agentState: null,
                    agentStateVersion: 0,
                    dataEncryptionKey: null,
                    pendingCount: 0,
                    pendingVersion: 0,
                    active: false,
                    lastActiveAt: now,
                    shares: [],
                },
            ])
            .mockResolvedValue([]);

        const route = await createSessionRouteTestBuilder("GET", "/v2/sessions/archived");
        const { response: res } = await route.invoke({ query: { limit: 50 } });

        expect(sessionFindMany).toHaveBeenCalledWith(
            expect.objectContaining({
                where: expect.objectContaining({
                    archivedAt: { not: null },
                }),
            }),
        );

        expect(res).toEqual({
            sessions: [
                expect.objectContaining({
                    id: "s2",
                    encryptionMode: "e2ee",
                    archivedAt: now.getTime(),
                }),
            ],
            nextCursor: null,
            hasNext: false,
        });
    });

    it("preserves the released layout-zero shared archived-row projection", async () => {
        const now = new Date(1_000);
        const row = {
            id: "legacy-shared-archived",
            seq: 1,
            currentStorageState: "hosted",
            accountId: "owner",
            encryptionMode: "plain",
            createdAt: now,
            updatedAt: now,
            meaningfulActivityAt: now,
            archivedAt: now,
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
            active: false,
            lastActiveAt: now,
            shares: [{
                encryptedDataKey: null,
                accessLevel: "view",
                canApprovePermissions: false,
            }],
        };
        sessionFindMany
            .mockResolvedValueOnce([row])
            .mockResolvedValue([]);

        const route = await createSessionRouteTestBuilder("GET", "/v2/sessions/archived");
        const { reply, response } = await route.invoke({ query: { limit: 1 } });

        expect(reply.statusCode).toBe(200);
        expect(response).toEqual({
            sessions: [
                expect.objectContaining({
                    id: "legacy-shared-archived",
                    metadata: "legacy-whole-bag",
                    metadataVersion: 1,
                    metadataLayoutVersion: 0,
                    agentState: "legacy-owner-state",
                    agentStateVersion: 3,
                    archivedAt: now.getTime(),
                    share: {
                        accessLevel: "view",
                        canApprovePermissions: false,
                    },
                }),
            ],
            nextCursor: null,
            hasNext: false,
        });
        expect(sessionFindMany).toHaveBeenCalledWith(expect.objectContaining({
            where: expect.objectContaining({
                archivedAt: { not: null },
                meaningfulActivityAt: { not: null },
            }),
        }));
    });
});
