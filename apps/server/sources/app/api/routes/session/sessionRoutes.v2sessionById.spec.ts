import { beforeEach, describe, expect, it } from "vitest";

import {
    createSessionRouteReply,
    registerSessionRoutesAndGetHandler,
    resetSessionRouteMocks,
    sessionFindFirst,
} from "./sessionRoutes.testkit";

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
            agentState: null,
            agentStateVersion: 3,
            dataEncryptionKey: Buffer.from([1, 2, 3]),
            active: true,
            lastActiveAt: now,
            shares: [],
        });

        const { handler } = await registerSessionRoutesAndGetHandler("GET", "/v2/sessions/:sessionId");
        const reply = createSessionRouteReply();

        const res = await handler({ userId: "u1", params: { sessionId: "s1" } }, reply);

        expect(res).toEqual({
            session: expect.objectContaining({
                id: "s1",
                encryptionMode: "e2ee",
                dataEncryptionKey: "AQID",
                share: null,
                archivedAt: null,
            }),
        });
    });

    it("returns shared session with share DEK and share info", async () => {
        const now = new Date(1);
        sessionFindFirst.mockResolvedValue({
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
        });

        const { handler } = await registerSessionRoutesAndGetHandler("GET", "/v2/sessions/:sessionId");
        const reply = createSessionRouteReply();

        const res = await handler({ userId: "u1", params: { sessionId: "s2" } }, reply);

        expect(res).toEqual({
            session: expect.objectContaining({
                id: "s2",
                encryptionMode: "e2ee",
                dataEncryptionKey: "BAU=",
                share: { accessLevel: "edit", canApprovePermissions: true },
                archivedAt: null,
            }),
        });
    });

    it("returns 404 when session is not accessible", async () => {
        sessionFindFirst.mockResolvedValue(null);

        const { handler } = await registerSessionRoutesAndGetHandler("GET", "/v2/sessions/:sessionId");
        const reply = createSessionRouteReply();

        const res = await handler({ userId: "u1", params: { sessionId: "missing" } }, reply);

        expect(reply.code).toHaveBeenCalledWith(404);
        expect(res).toEqual({ error: "Session not found" });
    });
});
