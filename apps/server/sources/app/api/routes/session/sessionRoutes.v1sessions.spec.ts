import { beforeEach, describe, expect, it, vi } from "vitest";
import { createEnvReset } from "../../testkit/env";

import {
    accountFindUnique,
    buildSessionActivityEphemeral,
    buildNewSessionUpdate,
    buildUpdateSessionUpdate,
    createSessionRouteTestBuilder,
    emitEphemeral,
    emitUpdate,
    getSessionParticipantUserIds,
    markAccountChanged,
    markAccountChangedAfterCommit,
    resetSessionRouteMocks,
    sessionFindFirst,
    sessionFindMany,
    sessionFindUnique,
    sessionUpdateMany,
    sessionShareFindMany,
    txSessionCreate,
    txSessionUpdate,
} from "./sessionRoutes.testkit";
import { DEFAULT_SESSION_ROLLBACK_ELIGIBLE_TURN_RELATION_LIMIT } from "./v2SessionHotReadLimits";

const OWNER_METADATA_CIPHERTEXT =
    "oQoBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQGDb9gtt8Xqs3gDuzJU/wWRuslcRY3OZA==";

function legacyCreateBody(body: Readonly<{
    tag: string;
    metadata: string;
    agentState: string | null;
    dataEncryptionKey: string | null;
    encryptionMode?: "e2ee" | "plain";
    currentStorageState?: "machine_only";
}>) {
    return body;
}

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
        sessionUpdateMany.mockReset();
        markAccountChangedAfterCommit.mockResolvedValue(1);
    });

    it("GET /v1/sessions returns pendingCount + pendingVersion for owned sessions", async () => {
        const now = new Date(1);
        sessionFindMany.mockResolvedValue([
            {
                id: "s1",
                seq: 1,
                accountId: "u1",
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
                accountId: "u1",
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
                    seq: 9,
                    accountId: "u1",
                    currentStorageState: "server_partial",
                    acceptedThroughServerSeq: 4,
                    materializationPublicationId: null,
                    materializedThroughSourceAt: null,
                    publishedThroughServerSeq: null,
                    createdAt: now,
                    updatedAt: now,
                    meaningfulActivityAt: now,
                    archivedAt: null,
                    encryptionMode: "e2ee",
                    metadata: "m1",
                    metadataVersion: 1,
                    agentState: null,
                    agentStateVersion: 0,
                    lastViewedSessionSeq: 9,
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
        expect(sessionFindMany.mock.calls[1]?.[0]?.select).toEqual(expect.objectContaining({
            currentStorageState: true,
            acceptedThroughServerSeq: true,
            materializationPublicationId: true,
            materializedThroughSourceAt: true,
            publishedThroughServerSeq: true,
        }));
        expect(res).toEqual({
            sessions: [
                expect.objectContaining({
                    id: "s1",
                    seq: 4,
                    lastViewedSessionSeq: 4,
                    latestTurnStatus: "completed",
                    latestTurnStatusObservedAt: 1234,
                    rollbackEligibleTurnStarts: [],
                }),
            ],
        });
    });

    it("GET /v1/sessions omits all owner-only fields from a layout-one shared row", async () => {
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
                    currentStorageState: "hosted",
                    createdAt: now,
                    updatedAt: now,
                    metadata: "m2",
                    metadataVersion: 1,
                    metadataLayoutVersion: 1,
                    ownerMetadata: OWNER_METADATA_CIPHERTEXT,
                    agentState: "full-owner-agent-state",
                    agentStateVersion: 8,
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
                    metadata: "m2",
                    metadataLayoutVersion: 1,
                }),
            ],
        });
        const session = (res as { sessions: unknown[] }).sessions[0];
        expect(session).not.toHaveProperty("ownerMetadata");
        expect(session).toMatchObject({
            agentState: null,
            agentStateVersion: 8,
        });
    });

    it("GET /v1/sessions preserves the released layout-zero shared projection", async () => {
        const now = new Date(1);
        sessionFindMany.mockResolvedValue([]);
        sessionShareFindMany.mockResolvedValue([
            {
                accessLevel: "view",
                canApprovePermissions: false,
                encryptedDataKey: null,
                sharedByUserId: "owner",
                sharedByUser: {},
                session: {
                    id: "legacy-shared",
                    seq: 2,
                    accountId: "owner",
                    currentStorageState: "hosted",
                    createdAt: now,
                    updatedAt: now,
                    metadata: "legacy-whole-bag",
                    metadataVersion: 1,
                    ownerMetadata: null,
                    metadataLayoutVersion: 0,
                    agentState: "legacy-owner-state",
                    agentStateVersion: 8,
                    pendingCount: 0,
                    pendingVersion: 0,
                    active: true,
                    lastActiveAt: now,
                },
            },
        ]);

        const route = await createSessionRouteTestBuilder("GET", "/v1/sessions");
        const { reply, response: res } = await route.invoke();

        expect(reply.statusCode).toBe(200);
        expect(res).toEqual({
            sessions: [
                expect.objectContaining({
                    id: "legacy-shared",
                    metadata: "legacy-whole-bag",
                    metadataVersion: 1,
                    metadataLayoutVersion: 0,
                    agentState: "legacy-owner-state",
                    agentStateVersion: 8,
                    accessLevel: "view",
                }),
            ],
        });
        expect(sessionShareFindMany).toHaveBeenCalledWith(
            expect.objectContaining({
                select: expect.objectContaining({
                    session: expect.objectContaining({
                        select: expect.objectContaining({ accountId: true }),
                    }),
                }),
            }),
        );
    });

    it("refills equal-recency shared snapshots without repeating an offset boundary row", async () => {
        const shareAt = (index: number, publicationId: string) => {
            const observedAt = 10_000;
            const at = new Date(observedAt);
            return {
                accessLevel: "view",
                canApprovePermissions: false,
                encryptedDataKey: null,
                sharedByUserId: "owner",
                sharedByUser: {},
                session: {
                    id: `shared-${index}`,
                    seq: 1,
                    currentStorageState: "snapshot_complete",
                    acceptedThroughServerSeq: null,
                    materializationPublicationId: publicationId,
                    materializedThroughSourceAt: BigInt(observedAt),
                    publishedThroughServerSeq: 1,
                    createdAt: at,
                    updatedAt: at,
                    meaningfulActivityAt: at,
                    archivedAt: null,
                    encryptionMode: "plain",
                    metadata: "{}",
                    metadataVersion: 1,
                    metadataLayoutVersion: 1,
                    ownerMetadata: OWNER_METADATA_CIPHERTEXT,
                    agentState: null,
                    agentStateVersion: 0,
                    lastViewedSessionSeq: 0,
                    pendingPermissionRequestCount: 0,
                    pendingUserActionRequestCount: 0,
                    latestTurnId: null,
                    latestTurnStatus: null,
                    latestTurnStatusObservedAt: null,
                    lastRuntimeIssue: null,
                    turns: [],
                    dataEncryptionKey: null,
                    pendingCount: 0,
                    pendingBlockedCount: 0,
                    pendingVersion: 0,
                    active: false,
                    lastActiveAt: at,
                },
            };
        };
        const malformed = shareAt(0, " ");
        const admitted = Array.from({ length: 149 }, (_, index) =>
            shareAt(index + 1, `publication-${index + 1}`));
        const boundary = shareAt(150, "publication-150");

        sessionFindMany.mockResolvedValue([]);
        sessionShareFindMany.mockImplementation(async (args) => {
            const storageState = args.where?.session?.AND?.[0]?.currentStorageState;
            if (storageState === "hosted") return [];
            if (args.skip !== 150) return [malformed, ...admitted];
            const hasStableTieBreaker = Array.isArray(args.orderBy)
                && args.orderBy[1]?.session?.id === "desc";
            return hasStableTieBreaker ? [boundary] : [admitted.at(-1)!];
        });

        const route = await createSessionRouteTestBuilder("GET", "/v1/sessions");
        const { response } = await route.invoke();
        const sessions = (response as { sessions: Array<{ id: string }> }).sessions;

        expect(sessions).toHaveLength(150);
        expect(sessions.map((session) => session.id)).toContain("shared-150");
        expect(sessionShareFindMany).toHaveBeenCalledWith(expect.objectContaining({
            orderBy: [
                { session: { materializedThroughSourceAt: "desc" } },
                { session: { id: "desc" } },
            ],
            skip: 150,
            take: 1,
        }));
    });

    it.each(["machine_only", "server_partial"] as const)(
        "GET /v1/sessions omits a shared session while transcript storage is %s",
        async (currentStorageState) => {
            const now = new Date(1);
            sessionFindMany.mockResolvedValue([]);
            sessionShareFindMany.mockResolvedValue([{
                accessLevel: "view",
                canApprovePermissions: false,
                encryptedDataKey: Buffer.from([1]),
                sharedByUserId: "owner",
                sharedByUser: {},
                session: {
                    id: "shared-external",
                    seq: 1,
                    currentStorageState,
                    acceptedThroughServerSeq: currentStorageState === "server_partial" ? 1 : null,
                    materializationPublicationId: null,
                    materializedThroughSourceAt: null,
                    publishedThroughServerSeq: null,
                    createdAt: now,
                    updatedAt: now,
                    metadata: "m",
                    metadataVersion: 1,
                    agentState: null,
                    agentStateVersion: 0,
                    pendingCount: 0,
                    pendingVersion: 0,
                    active: false,
                    lastActiveAt: now,
                },
            }]);

            const route = await createSessionRouteTestBuilder("GET", "/v1/sessions");
            const { response } = await route.invoke();

            expect(sessionShareFindMany).toHaveBeenCalledTimes(2);
            expect(sessionShareFindMany).toHaveBeenNthCalledWith(1, expect.objectContaining({
                orderBy: [
                    { session: { updatedAt: "desc" } },
                    { session: { id: "desc" } },
                ],
                take: 150,
                where: {
                    sharedWithUserId: "u1",
                    session: {
                        archivedAt: null,
                        AND: [{ currentStorageState: "hosted" }],
                    },
                },
            }));
            expect(sessionShareFindMany).toHaveBeenNthCalledWith(2, expect.objectContaining({
                orderBy: [
                    { session: { materializedThroughSourceAt: "desc" } },
                    { session: { id: "desc" } },
                ],
                take: 150,
                where: {
                    sharedWithUserId: "u1",
                    session: {
                        archivedAt: null,
                        AND: [{
                            currentStorageState: "snapshot_complete",
                            materializationPublicationId: { not: "" },
                            materializedThroughSourceAt: {
                                gte: 0,
                                lte: BigInt(Number.MAX_SAFE_INTEGER),
                            },
                            publishedThroughServerSeq: { gte: 0 },
                        }],
                    },
                },
            }));
            expect(response).toEqual({ sessions: [] });
        },
    );

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
            metadataLayoutVersion: 0,
            ownerMetadata: null,
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
            body: legacyCreateBody({ tag: "t1", metadata: "m1", agentState: null, dataEncryptionKey: null }),
        });

        expect(sessionFindFirst).not.toHaveBeenCalled();
        expect(markAccountChangedAfterCommit).not.toHaveBeenCalled();
        expect(res).toEqual({
            created: false,
            session: expect.objectContaining({
                id: "s1",
                pendingCount: 3,
                pendingVersion: 4,
            }),
        });
    });

    it("POST /v1/sessions reports when it created the tagged session", async () => {
        const now = new Date(1);
        txSessionCreate.mockResolvedValue({
            id: "s-created",
            seq: 0,
            createdAt: now,
            updatedAt: now,
            meaningfulActivityAt: now,
            metadata: "m1",
            metadataVersion: 0,
            agentState: null,
            agentStateVersion: 0,
            dataEncryptionKey: null,
            pendingCount: 0,
            pendingBlockedCount: 0,
            pendingVersion: 0,
            active: true,
            lastActiveAt: now,
            encryptionMode: "e2ee",
        });

        const route = await createSessionRouteTestBuilder("POST", "/v1/sessions");
        const { response } = await route.invoke({
            body: legacyCreateBody({ tag: "t-created", metadata: "m1", agentState: null, dataEncryptionKey: null }),
        });

        expect(response).toEqual({
            created: true,
            session: expect.objectContaining({ id: "s-created" }),
        });
        expect(txSessionCreate).toHaveBeenCalledWith(expect.objectContaining({
            data: expect.objectContaining({
                metadata: "m1",
            }),
        }));
        expect(txSessionCreate.mock.calls[0]?.[0]?.data).not.toHaveProperty(
            "ownerMetadata",
        );
        expect(txSessionCreate.mock.calls[0]?.[0]?.data).not.toHaveProperty(
            "metadataLayoutVersion",
        );
    });

    it("POST /v1/sessions refuses to activate layout-v1 for a fresh session", async () => {
        sessionFindUnique.mockResolvedValue(null);
        const route = await createSessionRouteTestBuilder("POST", "/v1/sessions");
        const { reply, response } = await route.invoke({
            body: {
                tag: "t-layout-v1",
                metadataLayoutVersion: 1,
                sharedMetadata: { ciphertext: "shared" },
                ownerMetadata: { ciphertext: OWNER_METADATA_CIPHERTEXT },
                agentState: "full-owner-agent-state",
                dataEncryptionKey: null,
            },
        });

        expect(reply.statusCode).toBe(409);
        expect(response).toEqual(expect.objectContaining({
            code: "metadata_privacy_upgrade_required",
        }));
        expect(txSessionCreate).not.toHaveBeenCalled();
    });

    it("POST /v1/sessions leaves an existing inactive session inactive after a duplicate create", async () => {
        const now = new Date(1);
        txSessionCreate.mockRejectedValueOnce(Object.assign(new Error("duplicate"), { code: "P2002" }));
        sessionFindUnique.mockResolvedValue({
            id: "s1",
            seq: 1,
            createdAt: now,
            updatedAt: now,
            meaningfulActivityAt: now,
            metadata: "m1",
            metadataVersion: 1,
            metadataLayoutVersion: 0,
            ownerMetadata: null,
            agentState: null,
            agentStateVersion: 0,
            dataEncryptionKey: null,
            pendingCount: 3,
            pendingBlockedCount: 0,
            pendingVersion: 4,
            active: false,
            lastActiveAt: now,
            encryptionMode: "e2ee",
        });
        const route = await createSessionRouteTestBuilder("POST", "/v1/sessions");
        const { response: res } = await route.invoke({
            body: legacyCreateBody({ tag: "t1", metadata: "m1", agentState: null, dataEncryptionKey: null }),
        });

        expect(markAccountChangedAfterCommit).not.toHaveBeenCalled();
        expect(txSessionUpdate).not.toHaveBeenCalled();
        expect(buildUpdateSessionUpdate).not.toHaveBeenCalled();
        expect(buildSessionActivityEphemeral).not.toHaveBeenCalled();
        expect(emitUpdate).not.toHaveBeenCalled();
        expect(emitEphemeral).not.toHaveBeenCalled();
        expect(res).toEqual({
            created: false,
            session: expect.objectContaining({
                id: "s1",
                active: false,
                activeAt: now.getTime(),
                meaningfulActivityAt: now.getTime(),
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
            body: legacyCreateBody({ tag: "t2", metadata: "m2", agentState: null, dataEncryptionKey: null }),
        });

        expect(sessionFindFirst).not.toHaveBeenCalled();
        expect(markAccountChangedAfterCommit).toHaveBeenCalledWith({
            accountId: "u1",
            kind: "session",
            entityId: "s2",
        });
        expect(buildNewSessionUpdate).toHaveBeenCalledWith(
            expect.objectContaining({ id: "s2" }),
            1,
            "upd-id",
        );
        expect(emitUpdate).toHaveBeenCalledWith(expect.objectContaining({
            userId: "u1",
            recipientFilter: { type: "user-scoped-only" },
            payload: expect.objectContaining({
                body: expect.objectContaining({ t: "new-session" }),
            }),
        }));
        expect(res).toEqual({
            created: true,
            session: expect.objectContaining({
                id: "s2",
                pendingCount: 0,
                pendingVersion: 0,
            }),
        });
    });

    it("POST /v1/sessions initializes an external-linked session as machine_only", async () => {
        const now = new Date(1);
        txSessionCreate.mockResolvedValue({
            id: "external-session",
            seq: 0,
            createdAt: now,
            updatedAt: now,
            metadata: "encrypted-link",
            metadataVersion: 0,
            agentState: null,
            agentStateVersion: 0,
            dataEncryptionKey: null,
            currentStorageState: "machine_only",
            pendingCount: 0,
            pendingBlockedCount: 0,
            pendingVersion: 0,
            active: false,
            lastActiveAt: now,
            encryptionMode: "e2ee",
        });

        const route = await createSessionRouteTestBuilder("POST", "/v1/sessions");
        await route.invoke({
            body: legacyCreateBody({
                tag: "external-link",
                metadata: "encrypted-link",
                agentState: null,
                dataEncryptionKey: null,
                currentStorageState: "machine_only",
            }),
        });

        expect(txSessionCreate).toHaveBeenCalledWith(expect.objectContaining({
            data: expect.objectContaining({
                currentStorageState: "machine_only",
            }),
        }));
    });

    it("POST /v1/sessions safely repairs a predecessor external-linked row before returning it", async () => {
        const now = new Date(1);
        txSessionCreate.mockRejectedValueOnce(Object.assign(new Error("duplicate"), { code: "P2002" }));
        sessionFindUnique.mockResolvedValue({
            id: "external-session",
            seq: 0,
            createdAt: now,
            updatedAt: now,
            metadata: "encrypted-link",
            metadataVersion: 1,
            metadataLayoutVersion: 0,
            ownerMetadata: null,
            agentState: null,
            agentStateVersion: 0,
            dataEncryptionKey: null,
            currentStorageState: "hosted",
            acceptedThroughServerSeq: null,
            materializationPublicationId: null,
            materializedThroughSourceAt: null,
            publishedThroughServerSeq: null,
            pendingCount: 0,
            pendingBlockedCount: 0,
            pendingVersion: 0,
            active: false,
            lastActiveAt: now,
            encryptionMode: "e2ee",
        });
        sessionUpdateMany.mockResolvedValue({ count: 1 });

        const route = await createSessionRouteTestBuilder("POST", "/v1/sessions");
        await route.invoke({
            body: legacyCreateBody({
                tag: "external-link",
                metadata: "encrypted-link",
                agentState: null,
                dataEncryptionKey: null,
                currentStorageState: "machine_only",
            }),
        });

        expect(sessionUpdateMany).toHaveBeenCalledWith({
            where: {
                id: "external-session",
                currentStorageState: "hosted",
                seq: 0,
                acceptedThroughServerSeq: null,
                materializationPublicationId: null,
                materializedThroughSourceAt: null,
                publishedThroughServerSeq: null,
            },
            data: { currentStorageState: "machine_only" },
        });
    });

    it("POST /v1/sessions rejects unsafe predecessor storage repair without changing authority", async () => {
        const now = new Date(1);
        txSessionCreate.mockRejectedValueOnce(Object.assign(new Error("duplicate"), { code: "P2002" }));
        sessionFindUnique.mockResolvedValue({
            id: "external-session",
            seq: 1,
            createdAt: now,
            updatedAt: now,
            metadata: "encrypted-link",
            metadataVersion: 1,
            metadataLayoutVersion: 0,
            ownerMetadata: null,
            agentState: null,
            agentStateVersion: 0,
            dataEncryptionKey: null,
            currentStorageState: "hosted",
            acceptedThroughServerSeq: null,
            materializationPublicationId: null,
            materializedThroughSourceAt: null,
            publishedThroughServerSeq: null,
            pendingCount: 0,
            pendingBlockedCount: 0,
            pendingVersion: 0,
            active: false,
            lastActiveAt: now,
            encryptionMode: "e2ee",
        });

        const route = await createSessionRouteTestBuilder("POST", "/v1/sessions");
        const { reply } = await route.invoke({
            body: legacyCreateBody({
                tag: "external-link",
                metadata: "encrypted-link",
                agentState: null,
                dataEncryptionKey: null,
                currentStorageState: "machine_only",
            }),
        });

        expect(sessionUpdateMany).not.toHaveBeenCalled();
        expect(reply.code).toHaveBeenCalledWith(409);
        expect(reply.send).toHaveBeenCalledWith({
            error: "storage-state-conflict",
            code: "session_storage_state_conflict",
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
            body: legacyCreateBody({ tag: "t2", metadata: "m2", agentState: null, dataEncryptionKey: null, encryptionMode: "plain" }),
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
            body: legacyCreateBody({ tag: "t2", metadata: "m2", agentState: null, dataEncryptionKey: null }),
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
            body: legacyCreateBody({ tag: "t2", metadata: "m2", agentState: "state-1", dataEncryptionKey: null }),
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
            body: legacyCreateBody({ tag: "t1", metadata: "m1", agentState: null, dataEncryptionKey: null, encryptionMode: "plain" }),
        });

        expect(reply.code).toHaveBeenCalledWith(400);
        expect(reply.send).toHaveBeenCalledWith({
            error: "invalid-params",
            code: "storage_policy_requires_e2ee",
        });
    });
});
