import { beforeEach, describe, expect, it } from "vitest";

import {
    createSessionRouteReply,
    registerSessionRoutesAndGetHandler,
    resetSessionRouteMocks,
    sessionFindFirst,
    sessionFindMany,
    sessionShareFindMany,
    txAccountFindUnique,
    txSessionFindFirst,
    txSessionCreate,
} from "./sessionRoutes.testkit";

describe("sessionRoutes v1 sessions snapshot", () => {
    beforeEach(() => {
        resetSessionRouteMocks();
        sessionFindMany.mockReset();
        sessionShareFindMany.mockReset();
        sessionFindFirst.mockReset();
        txSessionFindFirst.mockReset();
        txAccountFindUnique.mockReset();
        txAccountFindUnique.mockResolvedValue({ encryptionMode: "e2ee" });
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
        txSessionFindFirst.mockResolvedValue({
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

        expect(sessionFindFirst).not.toHaveBeenCalled();
        expect(txSessionFindFirst).toHaveBeenCalled();
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
        txSessionFindFirst.mockResolvedValue(null);
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

        expect(sessionFindFirst).not.toHaveBeenCalled();
        expect(txSessionFindFirst).toHaveBeenCalled();
        expect(res).toEqual({
            session: expect.objectContaining({
                id: "s2",
                pendingCount: 0,
                pendingVersion: 0,
            }),
        });
    });

    it("POST /v1/sessions forwards encryptionMode=plain when plaintext storage is optional", async () => {
        process.env.HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY = "optional";

        const now = new Date(1);
        txSessionFindFirst.mockResolvedValue(null);
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
            encryptionMode: "plain",
        });

        const { handler } = await registerSessionRoutesAndGetHandler("POST", "/v1/sessions");
        const reply = createSessionRouteReply();

        await handler(
            {
                userId: "u1",
                body: { tag: "t2", metadata: "m2", agentState: null, dataEncryptionKey: null, encryptionMode: "plain" },
            },
            reply,
        );

        expect(txSessionCreate).toHaveBeenCalledWith(
            expect.objectContaining({
                data: expect.objectContaining({
                    encryptionMode: "plain",
                }),
            }),
        );
    });

    it("POST /v1/sessions defaults encryptionMode to the account mode when not specified", async () => {
        process.env.HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY = "optional";

        const now = new Date(1);
        txSessionFindFirst.mockResolvedValue(null);
        txAccountFindUnique.mockResolvedValue({ encryptionMode: "plain" });
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
            encryptionMode: "plain",
        });

        const { handler } = await registerSessionRoutesAndGetHandler("POST", "/v1/sessions");
        const reply = createSessionRouteReply();

        await handler(
            {
                userId: "u1",
                body: { tag: "t2", metadata: "m2", agentState: null, dataEncryptionKey: null },
            },
            reply,
        );

        expect(txSessionCreate).toHaveBeenCalledWith(
            expect.objectContaining({
                data: expect.objectContaining({
                    encryptionMode: "plain",
                }),
            }),
        );
    });

    it("POST /v1/sessions stores agentState when provided", async () => {
        const now = new Date(1);
        txSessionFindFirst.mockResolvedValue(null);
        txSessionCreate.mockResolvedValue({
            id: "s2",
            seq: 2,
            createdAt: now,
            updatedAt: now,
            metadata: "m2",
            metadataVersion: 0,
            agentState: "state-1",
            agentStateVersion: 0,
            dataEncryptionKey: null,
            pendingCount: 0,
            pendingVersion: 0,
            active: true,
            lastActiveAt: now,
            encryptionMode: "e2ee",
        });

        const { handler } = await registerSessionRoutesAndGetHandler("POST", "/v1/sessions");
        const reply = createSessionRouteReply();

        await handler(
            {
                userId: "u1",
                body: { tag: "t2", metadata: "m2", agentState: "state-1", dataEncryptionKey: null },
            },
            reply,
        );

        expect(txSessionCreate).toHaveBeenCalledWith(
            expect.objectContaining({
                data: expect.objectContaining({
                    agentState: "state-1",
                }),
            }),
        );
    });

    it("POST /v1/sessions returns a stable error code when the requested encryptionMode is disallowed by storage policy", async () => {
        const prevStoragePolicy = process.env.HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY;
        process.env.HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY = "required_e2ee";

        try {
            const { handler } = await registerSessionRoutesAndGetHandler("POST", "/v1/sessions");
            const reply = createSessionRouteReply();

            await handler(
                {
                    userId: "u1",
                    body: { tag: "t1", metadata: "m1", agentState: null, dataEncryptionKey: null, encryptionMode: "plain" },
                },
                reply,
            );

            expect(reply.code).toHaveBeenCalledWith(400);
            expect(reply.send).toHaveBeenCalledWith({
                error: "invalid-params",
                code: "storage_policy_requires_e2ee",
            });
        } finally {
            if (typeof prevStoragePolicy === "string") process.env.HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY = prevStoragePolicy;
            else delete (process.env as any).HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY;
        }
    });
});
