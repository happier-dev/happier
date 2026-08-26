import { beforeEach, describe, expect, it, vi } from "vitest";
import tweetnacl from "tweetnacl";
import {
    CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION,
} from "@happier-dev/protocol";
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
    txExecuteRawUnsafe,
    txSessionCreate,
    txSessionUpdate,
} from "./sessionRoutes.testkit";
import { DEFAULT_SESSION_ROLLBACK_ELIGIBLE_TURN_RELATION_LIMIT } from "./v2SessionHotReadLimits";

const OWNER_METADATA_CIPHERTEXT =
    "oRoBAgMEBQYHCAkKCwwNDg8QERITFBUWFxh8aC0+8+YDECLScN6uQTItPyWVR7XbQA==";
const OWNER_METADATA_ENVELOPE = {
    t: "encrypted",
    c: OWNER_METADATA_CIPHERTEXT,
} as const;
const LEGACY_ACCOUNT_STORED_CONTENT_COMPATIBILITY = {
    supportsCurrentProtocol: false,
    outcome: "legacy-protocol-too-old",
    declaration: { v: 1 as const, protocolVersion: 1 },
    upgradeRequired: {
        error: "client-upgrade-required",
        requirement: {
            v: 1 as const,
            kind: "account-stored-content" as const,
            minimumProtocolVersion:
                CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION,
        },
    },
} as const;

function createE2eeAccountFixture() {
    const signing = tweetnacl.sign.keyPair();
    const content = tweetnacl.box.keyPair();
    return {
        encryptionMode: "e2ee" as const,
        publicKey: Buffer.from(signing.publicKey).toString("hex"),
        contentPublicKey: new Uint8Array(content.publicKey),
        contentPublicKeySig: new Uint8Array(
            tweetnacl.sign.detached(
                Buffer.concat([
                    Buffer.from(
                        "Happy content key v1\u0000",
                        "utf8",
                    ),
                    Buffer.from(content.publicKey),
                ]),
                signing.secretKey,
            ),
        ),
    };
}

function v1ListSessionRow(
    id: string,
    updatedAtMs: number,
    overrides: Partial<{
        accountId: string;
        metadataLayoutVersion: number;
        ownerMetadata: string | null;
        encryptionMode: "e2ee" | "plain";
    }> = {},
) {
    const updatedAt = new Date(updatedAtMs);
    return {
        id,
        seq: 1,
        accountId: overrides.accountId ?? "u1",
        currentStorageState: "hosted",
        createdAt: updatedAt,
        updatedAt,
        meaningfulActivityAt: updatedAt,
        archivedAt: null,
        encryptionMode: overrides.encryptionMode ?? "e2ee",
        metadata: "{}",
        metadataVersion: 1,
        metadataLayoutVersion: overrides.metadataLayoutVersion ?? 1,
        ownerMetadata:
            Object.prototype.hasOwnProperty.call(overrides, "ownerMetadata")
                ? overrides.ownerMetadata ?? null
                : JSON.stringify(OWNER_METADATA_ENVELOPE),
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
        lastActiveAt: updatedAt,
    };
}

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
        accountFindUnique.mockResolvedValue(
            createE2eeAccountFixture(),
        );
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
                currentStorageState: "hosted",
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
        expect(accountFindUnique).not.toHaveBeenCalled();
    });

    it("reads Account currentness only for emitted layout-one owners", async () => {
        sessionFindMany.mockResolvedValue([
            v1ListSessionRow("owned-layout-one-omitted", 1),
        ]);
        const sharedRows = Array.from({ length: 150 }, (_, index) => ({
            accessLevel: "view",
            canApprovePermissions: false,
            encryptedDataKey: null,
            sharedByUserId: "owner",
            sharedByUser: {},
            session: v1ListSessionRow(
                `shared-${index}`,
                1_000 + index,
                { accountId: "owner" },
            ),
        }));
        sessionShareFindMany.mockResolvedValue(sharedRows);

        const route = await createSessionRouteTestBuilder("GET", "/v1/sessions");
        const { reply, response } = await route.invoke();

        expect(reply.statusCode).toBe(200);
        const emitted = (response as { sessions: Array<{ id: string }> }).sessions;
        expect(emitted).toHaveLength(150);
        expect(emitted.map((session) => session.id)).not.toContain(
            "owned-layout-one-omitted",
        );
        expect(accountFindUnique).toHaveBeenCalledTimes(1);
        expect(accountFindUnique).toHaveBeenCalledWith(expect.objectContaining({
            where: { id: "owner" },
        }));
    });

    it("does not require current stored-content support for a layout-one candidate omitted from the emitted 150", async () => {
        sessionFindMany.mockResolvedValue(
            Array.from({ length: 150 }, (_, index) =>
                v1ListSessionRow(
                    `legacy-visible-owned-${index}`,
                    1_000 + index,
                    {
                        metadataLayoutVersion: 0,
                        ownerMetadata: null,
                    },
                )),
        );
        sessionShareFindMany.mockResolvedValue([{
            accessLevel: "view",
            canApprovePermissions: false,
            encryptedDataKey: null,
            sharedByUserId: "owner",
            sharedByUser: {},
            session: v1ListSessionRow(
                "layout-one-shared-candidate",
                1,
                { accountId: "owner" },
            ),
        }]);

        const route = await createSessionRouteTestBuilder("GET", "/v1/sessions");
        const { reply, response } = await route.invoke({
            accountStoredContentCompatibility:
                LEGACY_ACCOUNT_STORED_CONTENT_COMPATIBILITY,
        });

        expect(reply.statusCode).toBe(200);
        const emitted = (response as { sessions: Array<{ id: string }> }).sessions;
        expect(emitted).toHaveLength(150);
        expect(emitted.map((session) => session.id)).not.toContain(
            "layout-one-shared-candidate",
        );
        expect(accountFindUnique).not.toHaveBeenCalled();
    });

    it("reads Account currentness exactly once when emitted rows include owned layout one", async () => {
        sessionFindMany.mockResolvedValue([
            v1ListSessionRow("owned-layout-one-newer", 2_000),
            v1ListSessionRow("owned-layout-one-older", 1_999),
        ]);
        sessionShareFindMany.mockResolvedValue([]);

        const route = await createSessionRouteTestBuilder("GET", "/v1/sessions");
        const { reply, response } = await route.invoke();

        expect(reply.statusCode).toBe(200);
        expect(response).toEqual({
            sessions: [
                expect.objectContaining({ id: "owned-layout-one-newer" }),
                expect.objectContaining({ id: "owned-layout-one-older" }),
            ],
        });
        expect(accountFindUnique).toHaveBeenCalledTimes(1);
    });

    it("GET /v1/sessions returns materialized turn observed timestamps for owned sessions", async () => {
        const now = new Date(1);
        sessionFindMany.mockResolvedValue([
            {
                id: "s1",
                seq: 1,
                accountId: "u1",
                currentStorageState: "hosted",
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
                    transcriptShareable: true,
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
                    ownerMetadata: JSON.stringify(OWNER_METADATA_ENVELOPE),
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
                    transcriptShareable: true,
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

    it("GET /v1/sessions fails a layout-zero shared projection closed", async () => {
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

        expect(reply.statusCode).toBe(409);
        expect(res).toEqual({
            error: "Session metadata privacy upgrade required",
            code: "metadata_privacy_upgrade_required",
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
                    metadata: JSON.stringify({ v: 1 }),
                    metadataVersion: 1,
                    metadataLayoutVersion: 1,
                    ownerMetadata: JSON.stringify(OWNER_METADATA_ENVELOPE),
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

    it("POST /v1/sessions returns typed upgrade-required before a missing-declaration layout-v1 create", async () => {
        sessionFindUnique.mockResolvedValue(null);
        const route = await createSessionRouteTestBuilder("POST", "/v1/sessions");
        const { reply } = await route.invoke({
            accountStoredContentCompatibility: {
                supportsCurrentProtocol: false,
                outcome: "legacy-missing",
                declaration: null,
                upgradeRequired: {
                    error: "client-upgrade-required",
                    requirement: {
                        v: 1,
                        kind: "account-stored-content",
                        minimumProtocolVersion:
                            CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION,
                    },
                },
            },
            body: {
                tag: "t-layout-v1",
                metadataLayoutVersion: 1,
                sharedMetadata: { ciphertext: "shared" },
                ownerMetadata: OWNER_METADATA_ENVELOPE,
                agentState: "full-owner-agent-state",
                dataEncryptionKey: null,
            },
        });

        expect(reply.statusCode).toBe(426);
        expect(reply.send).toHaveBeenCalledWith({
            error: "client-upgrade-required",
            requirement: {
                v: 1,
                kind: "account-stored-content",
                minimumProtocolVersion:
                    CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION,
            },
        });
        expect(txExecuteRawUnsafe).not.toHaveBeenCalled();
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
            expect.objectContaining({
                metadataLayoutVersion: 0,
            }),
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

    // `legacy_external_unknown` is the state the publication-authority migration
    // backfills onto predecessor `direct:v1:*` rows. Owner-machine relink is the
    // only transition out of it, so it must reach the same fenced repair as an
    // un-reclassified hosted predecessor row.
    it.each(["hosted", "legacy_external_unknown"] as const)(
        "POST /v1/sessions safely repairs a %s predecessor external-linked row before returning it",
        async (currentStorageState) => {
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
                currentStorageState,
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
                    currentStorageState: { in: ["hosted", "legacy_external_unknown"] },
                    seq: 0,
                    acceptedThroughServerSeq: null,
                    materializationPublicationId: null,
                    materializedThroughSourceAt: null,
                    publishedThroughServerSeq: null,
                },
                data: { currentStorageState: "machine_only" },
            });
        },
    );

    // A predecessor row that already owns server transcript sequence is not
    // reclassifiable in either direction: message presence must never be read
    // as proof that the row is a complete hosted conversation.
    it.each(["hosted", "legacy_external_unknown"] as const)(
        "POST /v1/sessions rejects unsafe %s predecessor storage repair without changing authority",
        async (currentStorageState) => {
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
                currentStorageState,
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
        },
    );

    it("POST /v1/sessions refuses a plain layout-zero create when plaintext storage is optional", async () => {
        resetStoragePolicyEnv({ HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "optional" });

        const route = await createSessionRouteTestBuilder("POST", "/v1/sessions");
        const { reply } = await route.invoke({
            body: legacyCreateBody({ tag: "t2", metadata: "m2", agentState: null, dataEncryptionKey: null, encryptionMode: "plain" }),
        });

        expect(reply.code).toHaveBeenCalledWith(409);
        expect(reply.send).toHaveBeenCalledWith({
            error: "Session metadata privacy upgrade required",
            code: "metadata_privacy_upgrade_required",
        });
        expect(txSessionCreate).not.toHaveBeenCalled();
    });

    it("POST /v1/sessions rejects account key material for a plain layout-zero Session", async () => {
        resetStoragePolicyEnv({ HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "optional" });

        const route = await createSessionRouteTestBuilder("POST", "/v1/sessions");
        const { reply } = await route.invoke({
            body: legacyCreateBody({
                tag: "t2",
                metadata: "m2",
                agentState: null,
                dataEncryptionKey: "retained-key-material",
                encryptionMode: "plain",
            }),
        });

        expect(reply.code).toHaveBeenCalledWith(409);
        expect(reply.send).toHaveBeenCalledWith({
            error: "Session metadata privacy upgrade required",
            code: "metadata_privacy_upgrade_required",
        });
        expect(txSessionCreate).not.toHaveBeenCalled();
    });

    it("POST /v1/sessions refuses layout zero when the effective mode defaults to the plain Account mode", async () => {
        resetStoragePolicyEnv({ HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "optional" });
        accountFindUnique.mockResolvedValue({ encryptionMode: "plain" });

        const route = await createSessionRouteTestBuilder("POST", "/v1/sessions");
        const { reply } = await route.invoke({
            body: legacyCreateBody({ tag: "t2", metadata: "m2", agentState: null, dataEncryptionKey: null }),
        });

        expect(reply.code).toHaveBeenCalledWith(409);
        expect(reply.send).toHaveBeenCalledWith({
            error: "Session metadata privacy upgrade required",
            code: "metadata_privacy_upgrade_required",
        });
        expect(txSessionCreate).not.toHaveBeenCalled();
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
