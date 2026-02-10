import { beforeEach, describe, expect, it } from "vitest";

import {
    createSessionRouteReply,
    registerSessionRoutesAndGetHandler,
    resetSessionRouteMocks,
    sessionFindFirst,
    sessionFindMany,
    sessionShareFindMany,
    txSessionCreate,
} from "./sessionRoutes.testkit";

describe("sessionRoutes v1 sessions snapshot", () => {
    beforeEach(() => {
        resetSessionRouteMocks();
        sessionFindMany.mockReset();
        sessionShareFindMany.mockReset();
        sessionFindFirst.mockReset();
        txSessionCreate.mockReset();
    });

    it("GET /v1/sessions returns pendingCount + pendingVersion for owned sessions", async () => {
        const now = new Date(1);
        sessionFindMany.mockResolvedValue([
            {
                id: "s1",
                seq: 1,
                createdAt: now,
                updatedAt: now,
                metadata: "m1",
                metadataVersion: 1,
                agentState: null,
                agentStateVersion: 0,
                dataEncryptionKey: null,
                pendingCount: 2,
                pendingVersion: 7,
                active: true,
                lastActiveAt: now,
            },
        ]);
        sessionShareFindMany.mockResolvedValue([]);

        const { handler } = await registerSessionRoutesAndGetHandler("GET", "/v1/sessions");
        const reply = createSessionRouteReply();

        const res = await handler(
            {
                userId: "u1",
            },
            reply,
        );

        expect(res).toEqual({
            sessions: [
                expect.objectContaining({
                    id: "s1",
                    pendingCount: 2,
                    pendingVersion: 7,
                }),
            ],
        });
    });

    it("GET /v1/sessions returns pendingCount + pendingVersion for shared sessions", async () => {
        const now = new Date(1);
        sessionFindMany.mockResolvedValue([]);
        sessionShareFindMany.mockResolvedValue([
            {
                accessLevel: "edit",
                canApprovePermissions: true,
                encryptedDataKey: Buffer.from([1, 2, 3]),
                sharedByUserId: "owner",
                sharedByUser: {},
                session: {
                    id: "s2",
                    seq: 2,
                    createdAt: now,
                    updatedAt: now,
                    metadata: "m2",
                    metadataVersion: 1,
                    agentState: null,
                    agentStateVersion: 0,
                    pendingCount: 9,
                    pendingVersion: 10,
                    active: true,
                    lastActiveAt: now,
                },
            },
        ]);

        const { handler } = await registerSessionRoutesAndGetHandler("GET", "/v1/sessions");
        const reply = createSessionRouteReply();

        const res = await handler(
            {
                userId: "u1",
            },
            reply,
        );

        expect(res).toEqual({
            sessions: [
                expect.objectContaining({
                    id: "s2",
                    pendingCount: 9,
                    pendingVersion: 10,
                }),
            ],
        });
    });

    it("POST /v1/sessions returns pendingCount + pendingVersion when loading an existing session", async () => {
        const now = new Date(1);
        sessionFindFirst.mockResolvedValue({
            id: "s1",
            seq: 1,
            createdAt: now,
            updatedAt: now,
            metadata: "m1",
            metadataVersion: 1,
            agentState: null,
            agentStateVersion: 0,
            dataEncryptionKey: null,
            pendingCount: 3,
            pendingVersion: 4,
            active: true,
            lastActiveAt: now,
        });

        const { handler } = await registerSessionRoutesAndGetHandler("POST", "/v1/sessions");
        const reply = createSessionRouteReply();

        const res = await handler(
            {
                userId: "u1",
                body: { tag: "t1", metadata: "m1", agentState: null, dataEncryptionKey: null },
            },
            reply,
        );

        expect(res).toEqual({
            session: expect.objectContaining({
                id: "s1",
                pendingCount: 3,
                pendingVersion: 4,
            }),
        });
    });

    it("POST /v1/sessions returns pendingCount + pendingVersion when creating a new session", async () => {
        const now = new Date(1);
        sessionFindFirst.mockResolvedValue(null);
        txSessionCreate.mockResolvedValue({
            id: "s2",
            seq: 2,
            createdAt: now,
            updatedAt: now,
            metadata: "m2",
            metadataVersion: 1,
            agentState: null,
            agentStateVersion: 0,
            dataEncryptionKey: null,
            pendingCount: 0,
            pendingVersion: 0,
            active: true,
            lastActiveAt: now,
        });

        const { handler } = await registerSessionRoutesAndGetHandler("POST", "/v1/sessions");
        const reply = createSessionRouteReply();

        const res = await handler(
            {
                userId: "u1",
                body: { tag: "t2", metadata: "m2", agentState: null, dataEncryptionKey: null },
            },
            reply,
        );

        expect(res).toEqual({
            session: expect.objectContaining({
                id: "s2",
                pendingCount: 0,
                pendingVersion: 0,
            }),
        });
    });
});

