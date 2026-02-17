import { beforeEach, describe, expect, it } from "vitest";

import {
    createSessionRouteReply,
    registerSessionRoutesAndGetHandler,
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
        sessionFindMany.mockResolvedValue([
            {
                id: "s2",
                seq: 2,
                accountId: "u1",
                createdAt: now,
                updatedAt: now,
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
        ]);

        const { handler } = await registerSessionRoutesAndGetHandler("GET", "/v2/sessions/archived");
        const reply = createSessionRouteReply();

        const res = await handler({ userId: "u1", query: { limit: 50 } }, reply);

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
                    archivedAt: now.getTime(),
                }),
            ],
            nextCursor: null,
            hasNext: false,
        });
    });
});

