import { beforeEach, describe, expect, it } from "vitest";
import { V2SessionByIdResponseSchema } from "@happier-dev/protocol";

import {
    accountFindUnique,
    createSessionRouteTestBuilder,
    resetSessionRouteMocks,
    sessionFindFirst,
    sessionPendingMessageCount,
    sessionUpdate,
} from "./sessionRoutes.testkit";
import { DEFAULT_SESSION_ROLLBACK_ELIGIBLE_TURN_RELATION_LIMIT } from "./v2SessionHotReadLimits";

const OWNER_METADATA_ENVELOPE_V1 = {
    t: "encrypted",
    c: "oRoBAgMEBQYHCAkKCwwNDg8QERITFBUWFxh8aC0+8+YDECLScN6uQTItPyWVR7XbQA==",
} as const;
const STORED_OWNER_METADATA_ENVELOPE_V1 =
    JSON.stringify(OWNER_METADATA_ENVELOPE_V1);

describe("sessionRoutes v2 session by id", () => {
    beforeEach(() => {
        resetSessionRouteMocks();
        sessionFindFirst.mockReset();
    });

    it("does not read Account currentness for an owned layout-zero row", async () => {
        const now = new Date(1);
        sessionFindFirst.mockResolvedValue({
            id: "legacy-owned",
            seq: 1,
            accountId: "u1",
            encryptionMode: "plain",
            createdAt: now,
            updatedAt: now,
            meaningfulActivityAt: now,
            archivedAt: null,
            metadata: "legacy-owner-metadata",
            metadataVersion: 2,
            ownerMetadata: null,
            metadataLayoutVersion: 0,
            agentState: "legacy-owner-agent-state",
            agentStateVersion: 3,
            lastViewedSessionSeq: 1,
            pendingPermissionRequestCount: 0,
            pendingUserActionRequestCount: 0,
            latestTurnId: null,
            latestTurnStatus: null,
            latestTurnStatusObservedAt: null,
            lastRuntimeIssue: null,
            turns: [],
            pendingCount: 0,
            pendingVersion: 0,
            dataEncryptionKey: null,
            active: false,
            lastActiveAt: now,
            shares: [],
        });

        const route = await createSessionRouteTestBuilder(
            "GET",
            "/v2/sessions/:sessionId",
        );
        const { response } = await route.invoke({
            params: { sessionId: "legacy-owned" },
        });

        expect(response).toEqual({
            session: expect.objectContaining({
                id: "legacy-owned",
                metadata: "legacy-owner-metadata",
                metadataLayoutVersion: 0,
                agentState: "legacy-owner-agent-state",
            }),
        });
        expect(accountFindUnique).not.toHaveBeenCalled();
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
            ownerMetadata: STORED_OWNER_METADATA_ENVELOPE_V1,
            metadataLayoutVersion: 1,
            agentState: "full-owner-agent-state",
            agentStateVersion: 3,
            lastViewedSessionSeq: 1,
            pendingPermissionRequestCount: 2,
            pendingUserActionRequestCount: 0,
            latestTurnId: "turn-1",
            latestTurnStatus: "completed",
            latestTurnStatusObservedAt: BigInt(1_234),
            lastRuntimeIssue: null,
            turns: [
                {
                    transcriptAnchorsJson: JSON.stringify({ startUserMessageSeq: 4 }),
                    rollbackState: "eligible",
                },
            ],
            pendingCount: 0,
            pendingVersion: 0,
            dataEncryptionKey: Buffer.from([1, 2, 3]),
            active: true,
            lastActiveAt: now,
            shares: [],
        });

        const route = await createSessionRouteTestBuilder("GET", "/v2/sessions/:sessionId");
        const { response: res } = await route.invoke({ params: { sessionId: "s1" } });

        expect(sessionFindFirst).toHaveBeenCalledWith(expect.objectContaining({
            select: expect.objectContaining({
                turns: expect.objectContaining({ take: DEFAULT_SESSION_ROLLBACK_ELIGIBLE_TURN_RELATION_LIMIT }),
            }),
        }));
        expect(res).toEqual({
            session: expect.objectContaining({
                id: "s1",
                encryptionMode: "e2ee",
                metadata: "m1",
                ownerMetadata: OWNER_METADATA_ENVELOPE_V1,
                metadataLayoutVersion: 1,
                agentState: "full-owner-agent-state",
                agentStateVersion: 3,
                dataEncryptionKey: "AQID",
                lastViewedSessionSeq: 1,
                pendingPermissionRequestCount: 2,
                pendingUserActionRequestCount: 0,
                latestTurnId: "turn-1",
                latestTurnStatus: "completed",
                latestTurnStatusObservedAt: 1_234,
                rollbackEligibleTurnStarts: [4],
                share: null,
                archivedAt: null,
            }),
        });
        expect(V2SessionByIdResponseSchema.safeParse(res).success).toBe(true);
    });

    it("falls back when rollback turn columns are unavailable", async () => {
        const now = new Date(1);
        sessionFindFirst
            .mockRejectedValueOnce(Object.assign(new Error("Column SessionTurn.rollbackState does not exist"), { code: "P2022" }))
            .mockResolvedValueOnce({
                id: "s1",
                seq: 9,
                currentStorageState: "server_partial",
                acceptedThroughServerSeq: 4,
                materializationPublicationId: null,
                materializedThroughSourceAt: null,
                publishedThroughServerSeq: null,
                accountId: "u1",
                encryptionMode: "e2ee",
                createdAt: now,
                updatedAt: now,
                meaningfulActivityAt: now,
                archivedAt: null,
                metadata: "m1",
                metadataVersion: 2,
                agentState: null,
                agentStateVersion: 3,
                lastViewedSessionSeq: 9,
                pendingPermissionRequestCount: 0,
                pendingUserActionRequestCount: 0,
                latestTurnId: "turn-1",
                latestTurnStatus: "completed",
                latestTurnStatusObservedAt: BigInt(1_234),
                lastRuntimeIssue: null,
                dataEncryptionKey: Buffer.from([1, 2, 3]),
                pendingCount: 0,
                pendingVersion: 0,
                active: true,
                lastActiveAt: now,
                shares: [],
            });

        const route = await createSessionRouteTestBuilder("GET", "/v2/sessions/:sessionId");
        const { response: res } = await route.invoke({ params: { sessionId: "s1" } });

        expect(sessionFindFirst).toHaveBeenCalledTimes(2);
        expect(sessionFindFirst.mock.calls[1]?.[0]?.select).not.toHaveProperty("turns");
        expect(sessionFindFirst.mock.calls[1]?.[0]?.select).toEqual(expect.objectContaining({
            currentStorageState: true,
            acceptedThroughServerSeq: true,
            materializationPublicationId: true,
            materializedThroughSourceAt: true,
            publishedThroughServerSeq: true,
        }));
        expect(res).toEqual({
            session: expect.objectContaining({
                id: "s1",
                seq: 4,
                lastViewedSessionSeq: 4,
            }),
        });
        expect(res).toEqual({
            session: expect.objectContaining({
                id: "s1",
                latestTurnId: null,
                latestTurnStatus: null,
                latestTurnStatusObservedAt: null,
                rollbackEligibleTurnStarts: [],
            }),
        });
    });

    it("returns shared session with share DEK and share info", async () => {
        const now = new Date(1);
        sessionFindFirst.mockResolvedValue({
            id: "s2",
            seq: 2,
            currentStorageState: "hosted",
            accountId: "owner",
            encryptionMode: "e2ee",
            createdAt: now,
            updatedAt: now,
            archivedAt: null,
            metadata: "m2",
            metadataVersion: 1,
            ownerMetadata: STORED_OWNER_METADATA_ENVELOPE_V1,
            metadataLayoutVersion: 1,
            agentState: "full-owner-agent-state",
            agentStateVersion: 7,
            lastViewedSessionSeq: 0,
            pendingPermissionRequestCount: 0,
            pendingUserActionRequestCount: 1,
            pendingCount: 0,
            pendingVersion: 0,
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

        const route = await createSessionRouteTestBuilder("GET", "/v2/sessions/:sessionId");
        const { response: res } = await route.invoke({ params: { sessionId: "s2" } });

        expect(res).toEqual({
            session: expect.objectContaining({
                id: "s2",
                encryptionMode: "e2ee",
                metadata: "m2",
                metadataLayoutVersion: 1,
                dataEncryptionKey: "BAU=",
                lastViewedSessionSeq: 0,
                pendingPermissionRequestCount: 0,
                pendingUserActionRequestCount: 1,
                share: { accessLevel: "edit", canApprovePermissions: true },
                archivedAt: null,
            }),
        });
        expect(V2SessionByIdResponseSchema.safeParse(res).success).toBe(true);
        if (!res || typeof res !== "object" || !("session" in res)) {
            throw new Error("Expected a session response");
        }
        expect(res.session).not.toHaveProperty("ownerMetadata");
        expect(res.session).toMatchObject({
            agentState: null,
            agentStateVersion: 7,
        });
        expect(JSON.stringify(res.session)).not.toMatch(
            /oRoBAgMEBQYHCAkKCwwNDg8QERITFBUWFxh8aC0\+8\+YDECLScN6uQTItPyWVR7XbQA==|full-owner-agent-state/,
        );
    });

    it("refuses shared detail disclosure when the owning plain Account has an encrypted owner envelope", async () => {
        const now = new Date(1);
        accountFindUnique.mockResolvedValue({
            encryptionMode: "plain",
            publicKey: null,
            contentPublicKey: null,
            contentPublicKeySig: null,
        });
        sessionFindFirst.mockResolvedValue({
            id: "s2",
            seq: 2,
            currentStorageState: "hosted",
            accountId: "owner",
            encryptionMode: "e2ee",
            createdAt: now,
            updatedAt: now,
            archivedAt: null,
            metadata: "m2",
            metadataVersion: 1,
            ownerMetadata: STORED_OWNER_METADATA_ENVELOPE_V1,
            metadataLayoutVersion: 1,
            agentState: "full-owner-agent-state",
            agentStateVersion: 7,
            lastViewedSessionSeq: 0,
            pendingPermissionRequestCount: 0,
            pendingUserActionRequestCount: 0,
            pendingCount: 0,
            pendingVersion: 0,
            dataEncryptionKey: null,
            active: true,
            lastActiveAt: now,
            shares: [{
                encryptedDataKey: Buffer.from([4, 5]),
                accessLevel: "view",
                canApprovePermissions: false,
            }],
        });

        const route = await createSessionRouteTestBuilder(
            "GET",
            "/v2/sessions/:sessionId",
        );
        const { reply, response } = await route.invoke({
            params: { sessionId: "s2" },
        });

        expect(reply.statusCode).toBe(409);
        expect(response).toEqual({
            error: "Session metadata privacy upgrade required",
            code: "metadata_privacy_upgrade_required",
        });
    });

    it("refuses a released layout-zero shared by-id projection until owner migration", async () => {
        const now = new Date(1);
        sessionFindFirst.mockResolvedValue({
            id: "legacy-shared",
            seq: 2,
            currentStorageState: "hosted",
            accountId: "owner",
            encryptionMode: "e2ee",
            createdAt: now,
            updatedAt: now,
            archivedAt: null,
            metadata: "legacy-whole-bag",
            metadataVersion: 1,
            ownerMetadata: null,
            metadataLayoutVersion: 0,
            agentState: "legacy-owner-state",
            agentStateVersion: 7,
            lastViewedSessionSeq: 0,
            pendingPermissionRequestCount: 0,
            pendingUserActionRequestCount: 0,
            pendingCount: 0,
            pendingVersion: 0,
            dataEncryptionKey: null,
            active: true,
            lastActiveAt: now,
            shares: [
                {
                    encryptedDataKey: Buffer.from([4, 5]),
                    accessLevel: "view",
                    canApprovePermissions: false,
                },
            ],
        });

        const route = await createSessionRouteTestBuilder("GET", "/v2/sessions/:sessionId");
        const { reply, response: res } = await route.invoke({ params: { sessionId: "legacy-shared" } });

        expect(reply.statusCode).toBe(409);
        expect(res).toEqual({
            error: "Session metadata privacy upgrade required",
            code: "metadata_privacy_upgrade_required",
        });
        expect(sessionFindFirst).toHaveBeenCalledWith(expect.objectContaining({
            select: expect.objectContaining({
                accountId: true,
                metadataLayoutVersion: true,
                ownerMetadata: true,
                agentState: true,
                agentStateVersion: true,
            }),
        }));
    });

    it.each(["machine_only", "server_partial"] as const)(
        "returns not found to a shared viewer while transcript storage is %s",
        async (currentStorageState) => {
            const now = new Date(1);
            sessionFindFirst.mockResolvedValue({
                id: "s2",
                seq: 2,
                currentStorageState,
                acceptedThroughServerSeq: currentStorageState === "server_partial" ? 1 : null,
                materializationPublicationId: null,
                materializedThroughSourceAt: null,
                publishedThroughServerSeq: null,
                accountId: "owner",
                encryptionMode: "e2ee",
                createdAt: now,
                updatedAt: now,
                archivedAt: null,
                metadata: "m2",
                metadataVersion: 1,
                agentState: null,
                agentStateVersion: 0,
                lastViewedSessionSeq: 0,
                pendingPermissionRequestCount: 0,
                pendingUserActionRequestCount: 0,
                pendingCount: 0,
                pendingVersion: 0,
                dataEncryptionKey: null,
                active: false,
                lastActiveAt: now,
                shares: [{
                    encryptedDataKey: Buffer.from([4, 5]),
                    accessLevel: "view",
                    canApprovePermissions: false,
                }],
            });

            const route = await createSessionRouteTestBuilder("GET", "/v2/sessions/:sessionId");
            const { reply } = await route.invoke({ params: { sessionId: "s2" } });

            expect(reply.code).toHaveBeenCalledWith(404);
            expect(reply.send).toHaveBeenCalledWith({ error: "Session not found" });
        },
    );

    it.each([
        {
            name: "hosted",
            publication: {
                currentStorageState: "hosted",
                acceptedThroughServerSeq: null,
                materializationPublicationId: null,
                materializedThroughSourceAt: null,
                publishedThroughServerSeq: null,
            },
            ceiling: 9,
            recency: 9_000,
            rollbackStarts: [4, 5],
            retainsLiveFacts: true,
        },
        {
            name: "machine-only",
            publication: {
                currentStorageState: "machine_only",
                acceptedThroughServerSeq: null,
                materializationPublicationId: null,
                materializedThroughSourceAt: null,
                publishedThroughServerSeq: null,
            },
            ceiling: 0,
            recency: 1_000,
            rollbackStarts: [],
            retainsLiveFacts: false,
        },
        {
            name: "initial partial",
            publication: {
                currentStorageState: "server_partial",
                acceptedThroughServerSeq: 4,
                materializationPublicationId: null,
                materializedThroughSourceAt: null,
                publishedThroughServerSeq: null,
            },
            ceiling: 4,
            recency: 1_000,
            rollbackStarts: [4],
            retainsLiveFacts: false,
        },
        {
            name: "published snapshot with private post-publication activity",
            publication: {
                currentStorageState: "snapshot_complete",
                acceptedThroughServerSeq: 9,
                materializationPublicationId: "publication-4",
                materializedThroughSourceAt: BigInt(4_000),
                publishedThroughServerSeq: 4,
            },
            ceiling: 4,
            recency: 4_000,
            rollbackStarts: [4],
            retainsLiveFacts: false,
        },
        {
            name: "legacy external unknown",
            publication: {
                currentStorageState: "legacy_external_unknown",
                acceptedThroughServerSeq: null,
                materializationPublicationId: null,
                materializedThroughSourceAt: null,
                publishedThroughServerSeq: null,
            },
            ceiling: 0,
            recency: 1_000,
            rollbackStarts: [],
            retainsLiveFacts: false,
        },
    ] as const)(
        "GET /v2/sessions/:sessionId projects no private live fact while storage is $name",
        async ({ publication, ceiling, recency, rollbackStarts, retainsLiveFacts }) => {
            sessionFindFirst.mockResolvedValue({
                id: "external-preview",
                seq: 9,
                accountId: "u1",
                encryptionMode: "plain",
                createdAt: new Date(1_000),
                updatedAt: new Date(9_000),
                meaningfulActivityAt: new Date(9_000),
                archivedAt: null,
                metadata: "owner-metadata",
                metadataVersion: 1,
                ownerMetadata: null,
                metadataLayoutVersion: 0,
                agentState: null,
                agentStateVersion: 0,
                lastViewedSessionSeq: 8,
                pendingPermissionRequestCount: 2,
                pendingUserActionRequestCount: 3,
                pendingRequestObservedAt: new Date(9_000),
                pendingCount: 4,
                pendingBlockedCount: 5,
                pendingVersion: 6,
                latestTurnId: "turn-at-nine",
                latestTurnStatus: "in_progress",
                latestTurnStatusObservedAt: BigInt(9_000),
                lastRuntimeIssue: JSON.stringify({
                    v: 1,
                    scope: "primary_session",
                    status: "failed",
                    code: "usage_limit",
                    source: "usage_limit",
                    occurredAt: 9_000,
                }),
                runtimeActivityState: "active",
                runtimeActivityActiveCount: 1,
                runtimeActivityObservedAt: BigInt(9_000),
                runtimeActivityRevision: BigInt(9),
                thinking: true,
                thinkingAt: new Date(9_000),
                active: true,
                lastActiveAt: new Date(9_000),
                dataEncryptionKey: null,
                turns: [
                    {
                        transcriptAnchorsJson: JSON.stringify({ startUserMessageSeq: 4 }),
                        rollbackState: "eligible",
                    },
                    {
                        transcriptAnchorsJson: JSON.stringify({ startUserMessageSeq: 5 }),
                        rollbackState: "eligible",
                    },
                ],
                shares: [],
                ...publication,
            });

            const route = await createSessionRouteTestBuilder("GET", "/v2/sessions/:sessionId");
            const { response } = await route.invoke({ params: { sessionId: "external-preview" } });
            if (!response || typeof response !== "object" || !("session" in response)) {
                throw new Error("Expected a session response");
            }

            expect(response.session).toMatchObject({
                seq: ceiling,
                lastViewedSessionSeq: Math.min(8, ceiling),
                updatedAt: recency,
                meaningfulActivityAt: recency,
                activeAt: recency,
                rollbackEligibleTurnStarts: rollbackStarts,
                acceptedThroughServerSeq: publication.acceptedThroughServerSeq === null
                    ? null
                    : Math.min(publication.acceptedThroughServerSeq, ceiling),
            });

            if (retainsLiveFacts) {
                expect(response.session).toMatchObject({
                    active: true,
                    pendingPermissionRequestCount: 2,
                    pendingUserActionRequestCount: 3,
                    pendingCount: 4,
                    pendingBlockedCount: 5,
                    pendingVersion: 6,
                    latestTurnId: "turn-at-nine",
                    latestTurnStatus: "in_progress",
                    latestTurnStatusObservedAt: 9_000,
                });
                return;
            }

            expect(response.session).toMatchObject({
                active: false,
                pendingPermissionRequestCount: 0,
                pendingUserActionRequestCount: 0,
                pendingCount: 0,
                pendingBlockedCount: 0,
                pendingVersion: 0,
                latestTurnId: null,
                latestTurnStatus: null,
                latestTurnStatusObservedAt: null,
                lastRuntimeIssue: null,
            });
        },
    );

    it("returns stored pending state without reconciling pending rows", async () => {
        const now = new Date(1);
        sessionFindFirst.mockResolvedValue({
            id: "s-drift",
            seq: 2,
            accountId: "u1",
            encryptionMode: "e2ee",
            createdAt: now,
            updatedAt: now,
            meaningfulActivityAt: now,
            archivedAt: null,
            metadata: "m2",
            metadataVersion: 1,
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
            pendingVersion: 4,
            active: true,
            lastActiveAt: now,
            shares: [],
        });
        sessionPendingMessageCount.mockResolvedValue(2);
        sessionUpdate.mockResolvedValue({ pendingCount: 2, pendingVersion: 5 });

        const route = await createSessionRouteTestBuilder("GET", "/v2/sessions/:sessionId");
        const { response: res } = await route.invoke({ params: { sessionId: "s-drift" } });

        expect(sessionPendingMessageCount).not.toHaveBeenCalled();
        expect(sessionUpdate).not.toHaveBeenCalled();
        expect(res).toEqual({
            session: expect.objectContaining({
                id: "s-drift",
                pendingCount: 0,
                pendingVersion: 4,
            }),
        });
    });

    it("returns 404 when session is not accessible", async () => {
        sessionFindFirst.mockResolvedValue(null);

        const route = await createSessionRouteTestBuilder("GET", "/v2/sessions/:sessionId");
        const { reply, response: res } = await route.invoke({ params: { sessionId: "missing" } });

        expect(reply.code).toHaveBeenCalledWith(404);
        expect(res).toEqual({ error: "Session not found" });
    });
});
