import { beforeEach, describe, expect, it } from "vitest";
import { createEnvReset } from "../../testkit/env";

import {
    accountFindUnique,
    createSessionRouteTestBuilder,
    markAccountChangedAfterCommit,
    resetSessionRouteMocks,
    sessionFindFirst,
    sessionFindMany,
    sessionFindUnique,
    sessionShareFindMany,
    txSessionCreate,
} from "./sessionRoutes.testkit";
import { DEFAULT_SESSION_ROLLBACK_ELIGIBLE_TURN_RELATION_LIMIT } from "./v2SessionHotReadLimits";

describe("sessionRoutes v1 sessions snapshot", () => {
    const resetStoragePolicyEnv = createEnvReset();

    beforeEach(() => {
        resetStoragePolicyEnv();
        resetSessionRouteMocks();
        accountFindUnique.mockReset();
        accountFindUnique.mockResolvedValue({ encryptionMode: "e2ee" });
        sessionFindMany.mockReset();
        sessionShareFindMany.mockReset();
        sessionFindFirst.mockReset();
        markAccountChangedAfterCommit.mockReset();
        txSessionCreate.mockReset();
        sessionFindUnique.mockReset();
        markAccountChangedAfterCommit.mockResolvedValue(1);
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

        const route = await createSessionRouteTestBuilder("GET", "/v1/sessions");
        const { response: res } = await route.invoke();

        expect(sessionFindMany).toHaveBeenCalledWith(expect.objectContaining({
            select: expect.objectContaining({
                turns: expect.objectContaining({ take: DEFAULT_SESSION_ROLLBACK_ELIGIBLE_TURN_RELATION_LIMIT }),
            }),
        }));
        expect(sessionShareFindMany).toHaveBeenCalledWith(expect.objectContaining({
            select: expect.objectContaining({
                session: expect.objectContaining({
                    select: expect.objectContaining({
                        turns: expect.objectContaining({ take: DEFAULT_SESSION_ROLLBACK_ELIGIBLE_TURN_RELATION_LIMIT }),
                    }),
                }),
            }),
        }));
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

    it("GET /v1/sessions returns materialized turn observed timestamps for owned sessions", async () => {
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
                pendingCount: 0,
                pendingVersion: 0,
                active: true,
                lastActiveAt: now,
                latestTurnId: "turn-1",
                latestTurnStatus: "in_progress",
                latestTurnStatusObservedAt: BigInt(1234),
            },
        ]);
        sessionShareFindMany.mockResolvedValue([]);

        const route = await createSessionRouteTestBuilder("GET", "/v1/sessions");
        const { response: res } = await route.invoke();

        expect(res).toEqual({
            sessions: [
                expect.objectContaining({
                    id: "s1",
                    latestTurnStatus: "in_progress",
                    latestTurnStatusObservedAt: 1234,
                }),
            ],
        });
    });

    it("GET /v1/sessions falls back when rollback turn columns are unavailable", async () => {
        const now = new Date(1);
        sessionFindMany
            .mockRejectedValueOnce(Object.assign(new Error("Column SessionTurn.rollbackState does not exist"), { code: "P2022" }))
            .mockResolvedValueOnce([
                {
                    id: "s1",
                    seq: 1,
                    createdAt: now,
                    updatedAt: now,
                    meaningfulActivityAt: now,
                    archivedAt: null,
                    encryptionMode: "e2ee",
                    metadata: "m1",
                    metadataVersion: 1,
                    agentState: null,
                    agentStateVersion: 0,
                    lastViewedSessionSeq: 1,
                    pendingPermissionRequestCount: 0,
                    pendingUserActionRequestCount: 0,
                    latestTurnId: "turn-1",
                    latestTurnStatus: "completed",
                    latestTurnStatusObservedAt: BigInt(1234),
                    lastRuntimeIssue: null,
                    dataEncryptionKey: null,
                    pendingCount: 0,
                    pendingVersion: 0,
                    active: true,
                    lastActiveAt: now,
                },
            ]);
        sessionShareFindMany.mockResolvedValue([]);

        const route = await createSessionRouteTestBuilder("GET", "/v1/sessions");
        const { response: res } = await route.invoke();

        expect(sessionFindMany).toHaveBeenCalledTimes(2);
        expect(sessionFindMany.mock.calls[1]?.[0]?.select).not.toHaveProperty("turns");
        expect(res).toEqual({
            sessions: [
                expect.objectContaining({
                    id: "s1",
                    latestTurnStatus: "completed",
                    latestTurnStatusObservedAt: 1234,
                    rollbackEligibleTurnStarts: [],
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

        const route = await createSessionRouteTestBuilder("GET", "/v1/sessions");
        const { response: res } = await route.invoke();

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
        txSessionCreate.mockRejectedValueOnce(Object.assign(new Error("duplicate"), { code: "P2002" }));
        sessionFindUnique.mockResolvedValue({
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

        const route = await createSessionRouteTestBuilder("POST", "/v1/sessions");
        const { response: res } = await route.invoke({
            body: { tag: "t1", metadata: "m1", agentState: null, dataEncryptionKey: null },
        });

        expect(sessionFindFirst).not.toHaveBeenCalled();
        expect(markAccountChangedAfterCommit).not.toHaveBeenCalled();
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

        const route = await createSessionRouteTestBuilder("POST", "/v1/sessions");
        const { response: res } = await route.invoke({
            body: { tag: "t2", metadata: "m2", agentState: null, dataEncryptionKey: null },
        });

        expect(sessionFindFirst).not.toHaveBeenCalled();
        expect(markAccountChangedAfterCommit).toHaveBeenCalledWith({
            accountId: "u1",
            kind: "session",
            entityId: "s2",
        });
        expect(res).toEqual({
            session: expect.objectContaining({
                id: "s2",
                pendingCount: 0,
                pendingVersion: 0,
            }),
        });
    });

    it("POST /v1/sessions forwards encryptionMode=plain when plaintext storage is optional", async () => {
        resetStoragePolicyEnv({ HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "optional" });

        const now = new Date(1);
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

        const route = await createSessionRouteTestBuilder("POST", "/v1/sessions");
        await route.invoke({
            body: { tag: "t2", metadata: "m2", agentState: null, dataEncryptionKey: null, encryptionMode: "plain" },
        });

        expect(txSessionCreate).toHaveBeenCalledWith(
            expect.objectContaining({
                data: expect.objectContaining({
                    encryptionMode: "plain",
                }),
            }),
        );
    });

    it("POST /v1/sessions defaults encryptionMode to the account mode when not specified", async () => {
        resetStoragePolicyEnv({ HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "optional" });

        const now = new Date(1);
        accountFindUnique.mockResolvedValue({ encryptionMode: "plain" });
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

        const route = await createSessionRouteTestBuilder("POST", "/v1/sessions");
        await route.invoke({
            body: { tag: "t2", metadata: "m2", agentState: null, dataEncryptionKey: null },
        });

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

        const route = await createSessionRouteTestBuilder("POST", "/v1/sessions");
        await route.invoke({
            body: { tag: "t2", metadata: "m2", agentState: "state-1", dataEncryptionKey: null },
        });

        expect(txSessionCreate).toHaveBeenCalledWith(
            expect.objectContaining({
                data: expect.objectContaining({
                    agentState: "state-1",
                }),
            }),
        );
    });

    it("POST /v1/sessions returns a stable error code when the requested encryptionMode is disallowed by storage policy", async () => {
        resetStoragePolicyEnv({ HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "required_e2ee" });

        const route = await createSessionRouteTestBuilder("POST", "/v1/sessions");
        const { reply } = await route.invoke({
            body: { tag: "t1", metadata: "m1", agentState: null, dataEncryptionKey: null, encryptionMode: "plain" },
        });

        expect(reply.code).toHaveBeenCalledWith(400);
        expect(reply.send).toHaveBeenCalledWith({
            error: "invalid-params",
            code: "storage_policy_requires_e2ee",
        });
    });
});
