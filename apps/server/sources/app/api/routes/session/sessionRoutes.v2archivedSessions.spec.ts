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
            .mockResolvedValueOnce([]);

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
});
