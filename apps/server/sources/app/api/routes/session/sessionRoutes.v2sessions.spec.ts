import { beforeEach, describe, expect, it } from "vitest";

import {
    CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION,
    encodeV2SessionListCursorV1,
    encodeV2SessionListCursorV2,
    V2SessionListResponseSchema,
} from "@happier-dev/protocol";
import type { SessionRuntimeIssueV1 } from "@happier-dev/protocol";

import {
    DEFAULT_SESSION_ROLLBACK_ELIGIBLE_TURN_RELATION_LIMIT,
    DEFAULT_V2_SESSION_LIST_INITIAL_ATTENTION_ROW_LIMIT,
} from "./v2SessionHotReadLimits";
import {
    mapV2SessionListRow as mapV2SessionListRowWithAccountMode,
} from "./v2SessionListRows";
import {
    createSessionRouteTestBuilder,
    accountFindUnique,
    resetSessionRouteMocks,
    sessionFindFirst,
    sessionFindMany,
    sessionPinFindMany,
} from "./sessionRoutes.testkit";
import { isMissingAttentionProjectionColumnError } from "./v2SessionListPage";

const OWNER_METADATA_ENVELOPE_V1 = {
    t: "encrypted",
    c: "oQoBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQGDb9gtt8Xqs3gDuzJU/wWRuslcRY3OZA==",
} as const;
const STORED_OWNER_METADATA_ENVELOPE_V1 =
    JSON.stringify(OWNER_METADATA_ENVELOPE_V1);
const STORED_SHARED_METADATA_V1 = JSON.stringify({ v: 1 });

const LEGACY_ACCOUNT_STORED_CONTENT_COMPATIBILITY = {
    accepted: false,
    supportsCurrentProtocol: false,
    outcome: "reject-protocol-too-old",
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

function mapV2SessionListRow(
    params: Omit<
        Parameters<typeof mapV2SessionListRowWithAccountMode>[0],
        "ownerAccountMode"
    >,
) {
    return mapV2SessionListRowWithAccountMode({
        ...params,
        ownerAccountMode: "e2ee",
    });
}

function pagedSessionRow(
    id: string,
    overrides: Partial<{
        createdAt: Date;
        updatedAt: Date;
        meaningfulActivityAt: Date | null;
        active: boolean;
        lastActiveAt: Date;
    }> = {},
) {
    const createdAt = overrides.createdAt ?? new Date(1_000);
    return {
        id,
        seq: 1,
        accountId: "u1",
        currentStorageState: "hosted",
        acceptedThroughServerSeq: null,
        materializationPublicationId: null,
        materializedThroughSourceAt: null,
        publishedThroughServerSeq: null,
        encryptionMode: "plain",
        createdAt,
        updatedAt: overrides.updatedAt ?? createdAt,
        meaningfulActivityAt: overrides.meaningfulActivityAt ?? createdAt,
        archivedAt: null,
        metadata: STORED_SHARED_METADATA_V1,
        metadataVersion: 1,
        metadataLayoutVersion: 1,
        ownerMetadata: STORED_OWNER_METADATA_ENVELOPE_V1,
        agentState: null,
        agentStateVersion: 0,
        lastViewedSessionSeq: 0,
        pendingPermissionRequestCount: 0,
        pendingUserActionRequestCount: 0,
        pendingRequestObservedAt: null,
        latestTurnId: null,
        latestTurnStatus: null,
        latestTurnStatusObservedAt: null,
        lastRuntimeIssue: null,
        runtimeActivityState: "unknown",
        runtimeActivityActiveCount: 0,
        runtimeActivityObservedAt: null,
        runtimeActivityRevision: 0,
        latestReadyEventSeq: null,
        latestReadyEventAt: null,
        thinking: false,
        thinkingAt: null,
        pendingCount: 0,
        pendingVersion: 0,
        dataEncryptionKey: null,
        active: overrides.active ?? false,
        lastActiveAt: overrides.lastActiveAt ?? createdAt,
        shares: [],
    };
}

const usageLimitRuntimeIssue: SessionRuntimeIssueV1 = {
    v: 1,
    scope: "primary_session",
    status: "failed",
    code: "usage_limit",
    source: "usage_limit",
    occurredAt: 1_000,
    agentId: "claude",
    usageLimit: {
        v: 1,
        resetAtMs: null,
        retryAfterMs: null,
        quotaScope: "account",
        recoverability: "wait",
    },
};

function expectedV2SessionVisibilityBranches() {
    return expect.arrayContaining([
        { accountId: "u1" },
        {
            AND: [
                { shares: { some: { sharedWithUserId: "u1" } } },
                {
                    OR: [
                        { currentStorageState: "hosted" },
                        expect.objectContaining({
                            currentStorageState: "snapshot_complete",
                            materializationPublicationId: expect.anything(),
                            materializedThroughSourceAt: {
                                gte: 0,
                                lte: BigInt(Number.MAX_SAFE_INTEGER),
                            },
                            publishedThroughServerSeq: { gte: 0 },
                        }),
                    ],
                },
            ],
        },
    ]);
}

function hasAttentionCandidatePredicate(where: Record<string, unknown>): boolean {
    const clauses = where.AND;
    if (!Array.isArray(clauses)) return false;
    return clauses.some((clause) => {
        if (!clause || typeof clause !== "object") return false;
        const candidates = (clause as Record<string, unknown>).OR;
        return Array.isArray(candidates) && candidates.some((candidate) =>
            candidate
            && typeof candidate === "object"
            && (Object.prototype.hasOwnProperty.call(candidate, "latestTurnStatus")
                || Object.prototype.hasOwnProperty.call(candidate, "pendingPermissionRequestCount")
                || Object.prototype.hasOwnProperty.call(candidate, "pendingUserActionRequestCount")));
    });
}

describe("sessionRoutes v2 sessions snapshot", () => {
    beforeEach(() => {
        resetSessionRouteMocks();
        sessionFindFirst.mockReset();
        sessionFindMany.mockReset();
        sessionFindMany.mockResolvedValue([]);
    });

    it("does not read Account currentness for an empty page", async () => {
        sessionFindMany.mockResolvedValue([]);

        const route = await createSessionRouteTestBuilder("GET", "/v2/sessions");
        const { response } = await route.invoke({ query: { limit: 1 } });

        expect(response).toEqual({
            sessions: [],
            nextCursor: null,
            hasNext: false,
        });
        expect(accountFindUnique).not.toHaveBeenCalled();
    });

    it("coalesces owned layout-one projection to one Account-currentness read per page", async () => {
        sessionFindMany
            .mockResolvedValueOnce([
                pagedSessionRow("owned-layout-one-2"),
                pagedSessionRow("owned-layout-one-1"),
            ])
            .mockResolvedValueOnce([]);

        const route = await createSessionRouteTestBuilder("GET", "/v2/sessions");
        const { response } = await route.invoke({ query: { limit: 2 } });

        expect(response).toEqual({
            sessions: [
                expect.objectContaining({ id: "owned-layout-one-2" }),
                expect.objectContaining({ id: "owned-layout-one-1" }),
            ],
            nextCursor: null,
            hasNext: false,
        });
        expect(accountFindUnique).toHaveBeenCalledTimes(1);
    });

    it("reads Account currentness for the displayed shared row, not the owned layout-one lookahead row", async () => {
        const sharedDisplayedRow = {
            ...pagedSessionRow("shared-displayed"),
            accountId: "owner",
            shares: [{
                encryptedDataKey: null,
                accessLevel: "view",
                canApprovePermissions: false,
            }],
        };
        sessionFindMany
            .mockResolvedValueOnce([
                sharedDisplayedRow,
                pagedSessionRow("owned-lookahead"),
            ])
            .mockResolvedValue([]);

        const route = await createSessionRouteTestBuilder("GET", "/v2/sessions");
        const { response } = await route.invoke({ query: { limit: 1 } });

        expect(response).toEqual({
            sessions: [expect.objectContaining({
                id: "shared-displayed",
                share: { accessLevel: "view", canApprovePermissions: false },
            })],
            nextCursor: encodeV2SessionListCursorV2({
                sessionId: "shared-displayed",
                meaningfulActivityAt: 1_000,
            }),
            hasNext: true,
        });
        expect(accountFindUnique).toHaveBeenCalledTimes(1);
        expect(accountFindUnique).toHaveBeenCalledWith(expect.objectContaining({
            where: { id: "owner" },
        }));
    });

    it("does not require current stored-content support for a sliced-out layout-one lookahead row", async () => {
        const emittedLayoutZero = {
            ...pagedSessionRow("emitted-layout-zero", {
                meaningfulActivityAt: new Date(2_000),
            }),
            metadataLayoutVersion: 0,
            ownerMetadata: null,
        };
        sessionFindMany
            .mockResolvedValueOnce([
                emittedLayoutZero,
                pagedSessionRow("layout-one-lookahead", {
                    meaningfulActivityAt: new Date(1_000),
                }),
            ])
            .mockResolvedValueOnce([]);

        const route = await createSessionRouteTestBuilder("GET", "/v2/sessions");
        const { reply, response } = await route.invoke({
            query: { limit: 1 },
            accountStoredContentCompatibility:
                LEGACY_ACCOUNT_STORED_CONTENT_COMPATIBILITY,
        });

        expect(reply.statusCode).toBe(200);
        expect(response).toEqual({
            sessions: [expect.objectContaining({ id: "emitted-layout-zero" })],
            nextCursor: encodeV2SessionListCursorV2({
                sessionId: "emitted-layout-zero",
                meaningfulActivityAt: 2_000,
            }),
            hasNext: true,
        });
        expect(accountFindUnique).not.toHaveBeenCalled();
    });

    it("requires current stored-content support when layout one appears only in the emitted pinned rows", async () => {
        const regularLayoutZero = {
            ...pagedSessionRow("regular-layout-zero"),
            metadataLayoutVersion: 0,
            ownerMetadata: null,
        };
        sessionPinFindMany.mockResolvedValue([
            {
                sessionId: "pinned-layout-one",
                sortKey: "a",
                pinnedAt: new Date(1_000),
            },
        ]);
        sessionFindMany.mockImplementation(async (query) => {
            const where = query.where as Record<string, unknown>;
            if (where.currentStorageState === "hosted" && where.meaningfulActivityAt) {
                return [regularLayoutZero];
            }
            if (where.id && !where.currentStorageState) {
                return [pagedSessionRow("pinned-layout-one", {
                    meaningfulActivityAt: new Date(100),
                })];
            }
            return [];
        });

        const route = await createSessionRouteTestBuilder("GET", "/v2/sessions");
        const { reply } = await route.invoke({
            query: { limit: 1 },
            accountStoredContentCompatibility:
                LEGACY_ACCOUNT_STORED_CONTENT_COMPATIBILITY,
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
        expect(accountFindUnique).not.toHaveBeenCalled();
    });

    it("keeps full Agent state owner-only when projecting a shared session row", () => {
        const row = {
            ...pagedSessionRow("s_shared_agent_state"),
            accountId: "owner",
            metadata: STORED_SHARED_METADATA_V1,
            metadataLayoutVersion: 1,
            ownerMetadata: STORED_OWNER_METADATA_ENVELOPE_V1,
            agentState: "full-owner-agent-state",
            agentStateVersion: 7,
            shares: [{
                encryptedDataKey: null,
                accessLevel: "view",
                canApprovePermissions: false,
            }],
            currentStorageState: "hosted",
        } as any;

        const owner = mapV2SessionListRow({ userId: "owner", row });
        const recipient = mapV2SessionListRow({ userId: "recipient", row });

        expect(owner.agentState).toBe("full-owner-agent-state");
        expect(owner.agentStateVersion).toBe(7);
        expect(recipient.metadata).toBe(STORED_SHARED_METADATA_V1);
        expect(recipient).not.toHaveProperty("ownerMetadata");
        expect(recipient.agentState).toBeNull();
        expect(recipient.agentStateVersion).toBe(7);
        expect(recipient.metadataLayoutVersion).toBe(1);
        expect(JSON.stringify(recipient)).not.toMatch(
            /oQoBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQGDb9gtt8Xqs3gDuzJU\/wWRuslcRY3OZA==|full-owner-agent-state/,
        );
        expect(V2SessionListResponseSchema.safeParse({
            sessions: [owner, recipient],
            nextCursor: null,
            hasNext: false,
        }).success).toBe(true);
    });

    it("rejects shared-recipient rows carrying owner projection authority", () => {
        const row = {
            ...pagedSessionRow("s_mixed_recipient_authority"),
            accountId: "owner",
            metadata: STORED_SHARED_METADATA_V1,
            metadataLayoutVersion: 1,
            ownerMetadata: STORED_OWNER_METADATA_ENVELOPE_V1,
            agentState: "full-owner-agent-state",
            agentStateVersion: 7,
            shares: [{
                encryptedDataKey: null,
                accessLevel: "edit",
                canApprovePermissions: true,
            }],
            currentStorageState: "hosted",
        } as any;
        const recipient = mapV2SessionListRow({ userId: "recipient", row });

        expect(recipient.share).toEqual({
            accessLevel: "edit",
            canApprovePermissions: true,
        });
        expect(V2SessionListResponseSchema.safeParse({
            sessions: [{
                ...recipient,
                ownerMetadata: OWNER_METADATA_ENVELOPE_V1,
                agentState: "full-owner-agent-state",
            }],
            nextCursor: null,
            hasNext: false,
        }).success).toBe(false);
    });

    it("GET /v2/sessions refuses a released layout-zero shared projection until owner migration", async () => {
        sessionFindMany
            .mockResolvedValueOnce([
                {
                    ...pagedSessionRow("legacy-shared"),
                    accountId: "owner",
                    metadata: "legacy-whole-bag",
                    metadataLayoutVersion: 0,
                    ownerMetadata: null,
                    agentState: "legacy-owner-state",
                    agentStateVersion: 7,
                    shares: [{
                        encryptedDataKey: null,
                        accessLevel: "view",
                        canApprovePermissions: false,
                    }],
                    currentStorageState: "hosted",
                },
            ])
            .mockResolvedValueOnce([]);

        const route = await createSessionRouteTestBuilder("GET", "/v2/sessions");
        const { reply, response: res } = await route.invoke({ query: { limit: 1 } });

        expect(reply.statusCode).toBe(409);
        expect(res).toEqual({
            error: "Session metadata privacy upgrade required",
            code: "metadata_privacy_upgrade_required",
        });
    });

    it("exposes the materialized turn observation time on v2 session rows", () => {
        const now = new Date(1_000);
        const mapped = mapV2SessionListRow({
            userId: "u1",
            row: {
                ...pagedSessionRow("s_projection", { createdAt: now }),
                latestTurnId: "turn-1",
                latestTurnStatus: "completed",
                latestTurnStatusObservedAt: BigInt(1_234),
            } as any,
        });

        expect(mapped.latestTurnStatus).toBe("completed");
        expect(mapped.latestTurnStatusObservedAt).toBe(1_234);
    });

    it("preserves remote-dev persisted provider process-exit-after-switch runtime issues on v2 rows", () => {
        const mapped = mapV2SessionListRow({
            userId: "u1",
            row: {
                ...pagedSessionRow("s_remote_issue", { createdAt: new Date(1_000) }),
                latestTurnStatus: "failed",
                lastRuntimeIssue: JSON.stringify({
                    v: 1,
                    scope: "primary_session",
                    status: "failed",
                    code: "agent_process_exit_after_switch",
                    source: "agent_process_exit_after_switch",
                    occurredAt: 2_000,
                    provider: "pi",
                    agentProcessExitAfterSwitch: {
                        exitCode: 1,
                        signal: null,
                        lastStderrLine: "session file missing",
                        vendorResumeId: "019e6942",
                        materializationRoot: "/tmp/happier/connected-services/pi",
                        effectiveStateMode: "isolated",
                    },
                }),
            } as any,
        });

        expect(mapped.lastRuntimeIssue).toMatchObject({
            source: "agent_process_exit_after_switch",
            agentProcessExitAfterSwitch: {
                exitCode: 1,
                signal: null,
                lastStderrLine: "session file missing",
                vendorResumeId: "019e6942",
                materializationRoot: "/tmp/happier/connected-services/pi",
                effectiveStateMode: "isolated",
            },
        });
    });

    it("preserves existing and remote-dev temporary throttle recoverability values on v2 rows", () => {
        for (const recoverability of ["wait", "manual"] as const) {
            const mapped = mapV2SessionListRow({
                userId: "u1",
                row: {
                    ...pagedSessionRow(`s_throttle_${recoverability}`, { createdAt: new Date(1_000) }),
                    latestTurnStatus: "failed",
                    lastRuntimeIssue: JSON.stringify({
                        v: 1,
                        scope: "primary_session",
                        status: "failed",
                        code: "provider_temporary_throttle",
                        source: "agent_status_error",
                        occurredAt: 2_000,
                        temporaryThrottle: {
                            v: 1,
                            retryAfterMs: null,
                            recoverability,
                        },
                    }),
                } as any,
            });

            expect(mapped.lastRuntimeIssue?.temporaryThrottle?.recoverability).toBe(recoverability);
        }
    });

    it("exposes rollback-eligible turn starts from session turn rows", () => {
        const now = new Date(1_000);
        const mapped = mapV2SessionListRow({
            userId: "u1",
            row: {
                ...pagedSessionRow("s_turns", { createdAt: now }),
                turns: [
                    {
                        transcriptAnchorsJson: JSON.stringify({ startUserMessageSeq: 1 }),
                        rollbackState: "eligible",
                    },
                    {
                        transcriptAnchorsJson: JSON.stringify({ startUserMessageSeq: 3 }),
                        rollbackState: "rolled_back",
                    },
                    {
                        transcriptAnchorsJson: JSON.stringify({ startUserMessageSeq: 5 }),
                        rollbackState: "eligible",
                    },
                    {
                        transcriptAnchorsJson: JSON.stringify({ startUserMessageSeq: -1 }),
                        rollbackState: "eligible",
                    },
                ],
            } as any,
        });

        expect(mapped.rollbackEligibleTurnStarts).toEqual([1, 5]);
    });

    it("exposes durable attention and live-work projection fields on v2 session rows", () => {
        const mapped = mapV2SessionListRow({
            userId: "u1",
            row: {
                ...pagedSessionRow("s_attention"),
                thinking: true,
                thinkingAt: new Date(1_111),
                pendingPermissionRequestCount: 1,
                pendingUserActionRequestCount: 2,
                pendingRequestObservedAt: new Date(1_222),
                latestReadyEventSeq: 9,
                latestReadyEventAt: new Date(1_333),
            } as any,
        });

        expect(mapped.thinking).toBe(true);
        expect(mapped.thinkingAt).toBe(1_111);
        expect(mapped.pendingRequestObservedAt).toBe(1_222);
        expect(mapped.latestReadyEventSeq).toBe(9);
        expect(mapped.latestReadyEventAt).toBe(1_333);
    });

    it("does not expose unpublished imported sequence or ready projections on session rows", () => {
        const mapped = mapV2SessionListRow({
            userId: "u1",
            row: {
                ...pagedSessionRow("s_partial"),
                seq: 12,
                lastViewedSessionSeq: 11,
                latestReadyEventSeq: 10,
                latestReadyEventAt: new Date(1_333),
                currentStorageState: "server_partial",
                acceptedThroughServerSeq: 8,
                publishedThroughServerSeq: null,
            } as any,
        });

        expect(mapped.seq).toBe(8);
        expect(mapped.lastViewedSessionSeq).toBe(8);
        expect(mapped.latestReadyEventSeq).toBeNull();
        expect(mapped.latestReadyEventAt).toBeNull();
    });

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
        "applies the publication ceiling to every preview fact for $name",
        ({ publication, ceiling, recency, rollbackStarts, retainsLiveFacts }) => {
            const mapped = mapV2SessionListRow({
                userId: "u1",
                row: {
                    ...pagedSessionRow("s_publication_preview", {
                        createdAt: new Date(1_000),
                        updatedAt: new Date(9_000),
                        meaningfulActivityAt: new Date(9_000),
                        active: true,
                        lastActiveAt: new Date(9_000),
                    }),
                    seq: 9,
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
                    lastRuntimeIssue: JSON.stringify(usageLimitRuntimeIssue),
                    runtimeActivityState: "active",
                    runtimeActivityActiveCount: 1,
                    runtimeActivityObservedAt: BigInt(9_000),
                    runtimeActivityRevision: BigInt(9),
                    thinking: true,
                    thinkingAt: new Date(9_000),
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
                    ...publication,
                } as any,
            });

            expect(mapped).toMatchObject({
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
                expect(mapped).toMatchObject({
                    active: true,
                    pendingPermissionRequestCount: 2,
                    pendingUserActionRequestCount: 3,
                    pendingRequestObservedAt: 9_000,
                    pendingCount: 4,
                    pendingBlockedCount: 5,
                    pendingVersion: 6,
                    latestTurnId: "turn-at-nine",
                    latestTurnStatus: "in_progress",
                    latestTurnStatusObservedAt: 9_000,
                    thinking: true,
                    thinkingAt: 9_000,
                    runtimeActivityState: "active",
                    runtimeActivityActiveCount: 1,
                    runtimeActivityObservedAt: 9_000,
                    runtimeActivityRevision: 9,
                });
                return;
            }

            expect(mapped).toMatchObject({
                active: false,
                pendingPermissionRequestCount: 0,
                pendingUserActionRequestCount: 0,
                pendingRequestObservedAt: null,
                pendingCount: 0,
                pendingBlockedCount: 0,
                pendingVersion: 0,
                latestTurnId: null,
                latestTurnStatus: null,
                latestTurnStatusObservedAt: null,
                lastRuntimeIssue: null,
                thinking: false,
                thinkingAt: null,
            });
            expect(mapped).not.toHaveProperty("runtimeActivityState");
            expect(mapped).not.toHaveProperty("runtimeActivityActiveCount");
            expect(mapped).not.toHaveProperty("runtimeActivityObservedAt");
            expect(mapped).not.toHaveProperty("runtimeActivityRevision");
        },
    );

    it("exposes provider runtime activity as the canonical four-field projection on v2 rows", () => {
        const mapped = mapV2SessionListRow({
            userId: "u1",
            row: {
                ...pagedSessionRow("s_runtime_activity"),
                runtimeActivityState: "active",
                runtimeActivityActiveCount: 2,
                runtimeActivityObservedAt: BigInt(1_444),
                runtimeActivityRevision: BigInt(12),
            } as any,
        });

        expect(mapped.runtimeActivityState).toBe("active");
        expect(mapped.runtimeActivityActiveCount).toBe(2);
        expect(mapped.runtimeActivityObservedAt).toBe(1_444);
        expect(mapped.runtimeActivityRevision).toBe(12);
        expect(mapped).not.toHaveProperty("runtimeActivitySourceClass");
    });

    it("exposes the safe C9 transcript-authority state and publication bound without the opaque publication id", () => {
        const mapped = mapV2SessionListRow({
            userId: "u1",
            row: {
                ...pagedSessionRow("s_materialized"),
                currentStorageState: "snapshot_complete",
                acceptedThroughServerSeq: null,
                materializationPublicationId: "publication-private-owner",
                materializedThroughSourceAt: BigInt(1_700_000_000_000),
                publishedThroughServerSeq: 12,
            } as any,
        });

        expect(mapped.currentStorageState).toBe("snapshot_complete");
        expect(mapped.acceptedThroughServerSeq).toBeNull();
        expect(mapped.materializedThroughSourceAt).toBe(1_700_000_000_000);
        expect(mapped.publishedThroughServerSeq).toBe(12);
        expect(mapped.transcriptShareable).toBe(true);
        expect(mapped).not.toHaveProperty("materializationPublicationId");

        const incomplete = mapV2SessionListRow({
            userId: "u1",
            row: {
                ...pagedSessionRow("s_incomplete_materialization"),
                currentStorageState: "snapshot_complete",
                acceptedThroughServerSeq: null,
                materializationPublicationId: null,
                materializedThroughSourceAt: BigInt(1_700_000_000_000),
                publishedThroughServerSeq: 12,
            } as any,
        });
        expect(incomplete.transcriptShareable).toBe(false);
        expect(incomplete).not.toHaveProperty("materializationPublicationId");
    });

    it("omits malformed or source-class-contaminated runtime activity tuples", () => {
        const partial = mapV2SessionListRow({
            userId: "u1",
            row: {
                ...pagedSessionRow("s_runtime_partial"),
                runtimeActivityState: "active",
                runtimeActivityActiveCount: 2,
                runtimeActivityObservedAt: null,
                runtimeActivityRevision: BigInt(12),
            } as any,
        });
        const sourceClassContaminated = mapV2SessionListRow({
            userId: "u1",
            row: {
                ...pagedSessionRow("s_runtime_source_class"),
                runtimeActivityState: "active",
                runtimeActivityActiveCount: 2,
                runtimeActivityObservedAt: BigInt(1_444),
                runtimeActivityRevision: BigInt(12),
                runtimeActivitySourceClass: "agent_detached_task",
            } as any,
        });

        for (const mapped of [partial, sourceClassContaminated]) {
            expect(mapped).not.toHaveProperty("runtimeActivityState");
            expect(mapped).not.toHaveProperty("runtimeActivityActiveCount");
            expect(mapped).not.toHaveProperty("runtimeActivityObservedAt");
            expect(mapped).not.toHaveProperty("runtimeActivityRevision");
        }
    });

    it("treats terminal turn projection as authoritative over stale legacy thinking rows", () => {
        const mapped = mapV2SessionListRow({
            userId: "u1",
            row: {
                ...pagedSessionRow("s_completed", { active: true }),
                thinking: true,
                thinkingAt: new Date(2_000),
                latestTurnId: "turn-1",
                latestTurnStatus: "completed",
                latestTurnStatusObservedAt: BigInt(1_500),
            } as any,
        });

        expect(mapped.latestTurnStatus).toBe("completed");
        expect(mapped.thinking).toBe(false);
        expect(mapped.thinkingAt).toBe(1_500);
    });

    it("returns owned + shared sessions and uses share DEK for shared sessions", async () => {
        const now = new Date(1);
        sessionFindMany
            .mockResolvedValueOnce([
                {
                    id: "s3",
                    seq: 3,
                    accountId: "u1",
                    encryptionMode: "e2ee",
                    createdAt: now,
                    updatedAt: now,
                    meaningfulActivityAt: new Date(3),
                    archivedAt: null,
                    metadata: "m3",
                    metadataVersion: 1,
                    agentState: null,
                    agentStateVersion: 0,
                    lastViewedSessionSeq: 2,
                    pendingPermissionRequestCount: 1,
                    pendingUserActionRequestCount: 0,
                    dataEncryptionKey: Buffer.from([1, 2, 3]),
                    active: true,
                    lastActiveAt: now,
                    shares: [],
                },
                {
                    id: "s2",
                    seq: 2,
                    accountId: "owner",
                    encryptionMode: "e2ee",
                    createdAt: now,
                    updatedAt: now,
                    meaningfulActivityAt: new Date(2),
                    archivedAt: null,
                    metadata: "m2",
                    metadataVersion: 1,
                    metadataLayoutVersion: 1,
                    ownerMetadata: STORED_OWNER_METADATA_ENVELOPE_V1,
                    agentState: null,
                    agentStateVersion: 0,
                    lastViewedSessionSeq: 1,
                    pendingPermissionRequestCount: 0,
                    pendingUserActionRequestCount: 2,
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
                },
                {
                    id: "s1",
                    seq: 1,
                    accountId: "u1",
                    encryptionMode: "plain",
                    createdAt: now,
                    updatedAt: now,
                    meaningfulActivityAt: new Date(1),
                    archivedAt: null,
                    metadata: "m1",
                    metadataVersion: 1,
                    agentState: null,
                    agentStateVersion: 0,
                    lastViewedSessionSeq: 0,
                    pendingPermissionRequestCount: 0,
                    pendingUserActionRequestCount: 0,
                    dataEncryptionKey: null,
                    active: true,
                    lastActiveAt: now,
                    shares: [],
                },
            ])
            .mockResolvedValueOnce([]);

        const route = await createSessionRouteTestBuilder("GET", "/v2/sessions");
        const { response: res } = await route.invoke({
            query: { limit: 2 },
        });

        expect(sessionFindMany).toHaveBeenCalledWith(
            expect.objectContaining({
                where: expect.objectContaining({
                    archivedAt: null,
                }),
            }),
        );

        expect(res).toEqual({
            sessions: [
                expect.objectContaining({
                    id: "s3",
                    meaningfulActivityAt: 3,
                    encryptionMode: "e2ee",
                    dataEncryptionKey: "AQID",
                    lastViewedSessionSeq: 2,
                    pendingPermissionRequestCount: 1,
                    pendingUserActionRequestCount: 0,
                    share: null,
                    archivedAt: null,
                }),
                expect.objectContaining({
                    id: "s2",
                    meaningfulActivityAt: 2,
                    encryptionMode: "e2ee",
                    dataEncryptionKey: "BAU=",
                    lastViewedSessionSeq: 1,
                    pendingPermissionRequestCount: 0,
                    pendingUserActionRequestCount: 2,
                    share: { accessLevel: "edit", canApprovePermissions: true },
                    archivedAt: null,
                }),
            ],
            nextCursor: encodeV2SessionListCursorV2({ sessionId: "s2", meaningfulActivityAt: 2 }),
            hasNext: true,
        });
    });

    it("refills malformed publication rows before deciding the page lookahead", async () => {
        const sharedSnapshotRow = (
            id: string,
            activityAt: number,
            publicationId: string,
        ) => ({
            ...pagedSessionRow(id, { meaningfulActivityAt: new Date(activityAt) }),
            accountId: "owner",
            currentStorageState: "snapshot_complete",
            acceptedThroughServerSeq: null,
            materializationPublicationId: publicationId,
            materializedThroughSourceAt: BigInt(activityAt),
            publishedThroughServerSeq: 1,
            shares: [{
                encryptedDataKey: null,
                accessLevel: "view",
                canApprovePermissions: false,
            }],
        });
        const malformed = sharedSnapshotRow("s-malformed", 4_000, " ");
        const first = sharedSnapshotRow("s-first", 3_000, "publication-first");
        const second = sharedSnapshotRow("s-second", 2_000, "publication-second");
        const lookahead = sharedSnapshotRow("s-lookahead", 1_000, "publication-lookahead");
        sessionFindMany
            .mockResolvedValueOnce([malformed, first, second])
            .mockResolvedValueOnce([])
            .mockResolvedValueOnce([lookahead]);

        const route = await createSessionRouteTestBuilder("GET", "/v2/sessions");
        const { response } = await route.invoke({
            query: { limit: 1 },
        });

        expect(response).toEqual({
            sessions: [expect.objectContaining({ id: "s-first" })],
            nextCursor: encodeV2SessionListCursorV2({
                sessionId: "s-first",
                meaningfulActivityAt: 3_000,
            }),
            hasNext: true,
        });
        expect(sessionFindMany).toHaveBeenCalledWith(expect.objectContaining({
            skip: 3,
            take: 1,
        }));
    });

    it("orders paged session rows by meaningful activity before id", async () => {
        sessionFindMany.mockResolvedValue([]);

        const route = await createSessionRouteTestBuilder("GET", "/v2/sessions");
        await route.invoke({
            query: { limit: 10 },
        });

        expect(sessionFindMany).toHaveBeenCalledWith(
            expect.objectContaining({
                orderBy: [
                    { meaningfulActivityAt: "desc" },
                    { id: "desc" },
                ],
            }),
        );
        expect(sessionFindMany).toHaveBeenCalledWith(
            expect.objectContaining({
                where: expect.objectContaining({
                    OR: expectedV2SessionVisibilityBranches(),
                }),
            }),
        );
    });

    it("includes server-backed initial pinned rows and durable attention rows without consuming the regular page", async () => {
        const normalFirstPageRow = pagedSessionRow("s_normal_first_page", { meaningfulActivityAt: new Date(1_000) });
        const normalSecondPageRow = pagedSessionRow("s_normal_second_page", { meaningfulActivityAt: new Date(950) });
        const firstPinned = pagedSessionRow("s_pinned_old", { meaningfulActivityAt: new Date(100) });
        const secondPinned = pagedSessionRow("s_pinned_older", { meaningfulActivityAt: new Date(50) });
        const readyAttention = {
            ...pagedSessionRow("s_ready_attention", { meaningfulActivityAt: new Date(900) }),
            seq: 8,
            lastViewedSessionSeq: 7,
            latestReadyEventSeq: 8,
            latestReadyEventAt: new Date(900),
        };
        sessionPinFindMany.mockResolvedValue([
            { sessionId: "s_pinned_old", sortKey: "a", pinnedAt: new Date(1_000) },
            { sessionId: "s_pinned_older", sortKey: "b", pinnedAt: new Date(2_000) },
        ]);
        sessionFindMany.mockImplementation(async (query) => {
            const where = query.where as Record<string, unknown>;
            if (where.id && !where.currentStorageState) {
                return [secondPinned, firstPinned];
            }
            if (where.currentStorageState === "hosted" && where.meaningfulActivityAt) {
                return hasAttentionCandidatePredicate(where)
                    ? [readyAttention]
                    : [normalFirstPageRow, normalSecondPageRow];
            }
            return [];
        });

        const route = await createSessionRouteTestBuilder("GET", "/v2/sessions");
        const { response } = await route.invoke({
            query: {
                includeAttention: "true",
                limit: 1,
            },
        });

        expect((response as { sessions: Array<{ id: string }> }).sessions.map((session) => session.id)).toEqual([
            "s_pinned_old",
            "s_pinned_older",
            "s_ready_attention",
            "s_normal_first_page",
        ]);
        expect(response).toEqual(expect.objectContaining({
            nextCursor: encodeV2SessionListCursorV2({ sessionId: "s_normal_first_page", meaningfulActivityAt: 1_000 }),
            hasNext: true,
        }));
        // The attention owner requests one lookahead candidate, and each
        // publication-shape branch requests its own refill lookahead row.
        const expectedAttentionBranchTake = DEFAULT_V2_SESSION_LIST_INITIAL_ATTENTION_ROW_LIMIT + 2;
        expect(sessionFindMany).toHaveBeenCalledWith(expect.objectContaining({
            take: expectedAttentionBranchTake,
            where: expect.objectContaining({
                currentStorageState: "hosted",
                meaningfulActivityAt: { not: null },
            }),
        }));
        expect(sessionPinFindMany).toHaveBeenCalledWith(expect.objectContaining({
            where: expect.objectContaining({
                accountId: "u1",
                session: expect.objectContaining({
                    archivedAt: null,
                    OR: expectedV2SessionVisibilityBranches(),
                }),
            }),
            orderBy: [{ sortKey: "asc" }, { pinnedAt: "asc" }],
        }));
        expect(accountFindUnique).toHaveBeenCalledTimes(1);
    });

    it("treats an empty server pin set as authoritative instead of falling back to client-provided pinned ids", async () => {
        sessionPinFindMany.mockResolvedValue([]);
        sessionFindMany
            .mockResolvedValueOnce([pagedSessionRow("s_normal_first_page", { meaningfulActivityAt: new Date(1_000) })])
            .mockResolvedValueOnce([pagedSessionRow("s_legacy_pinned", { meaningfulActivityAt: new Date(100) })])
            .mockResolvedValueOnce([]);

        const route = await createSessionRouteTestBuilder("GET", "/v2/sessions");
        const { response } = await route.invoke({
            query: {
                pinnedSessionIds: "s_legacy_pinned",
                limit: 1,
            },
        });

        expect((response as { sessions: Array<{ id: string }> }).sessions.map((session) => session.id)).toEqual([
            "s_normal_first_page",
        ]);
        expect(sessionFindMany.mock.calls.some((call) => {
            const ids = (call[0].where as { id?: { in?: string[] } } | undefined)?.id?.in;
            return Array.isArray(ids) && ids.includes("s_legacy_pinned");
        })).toBe(false);
    });

    it("keeps failed initial attention rows while active or unread without treating read inactive failures as durable attention", async () => {
        const normalFirstPageRow = pagedSessionRow("s_normal_first_page", { meaningfulActivityAt: new Date(1_000) });
        const normalSecondPageRow = pagedSessionRow("s_normal_second_page", { meaningfulActivityAt: new Date(950) });
        const activeReadFailure = {
            ...pagedSessionRow("s_failed_active_read", { active: true, meaningfulActivityAt: new Date(2_500) }),
            seq: 10,
            lastViewedSessionSeq: 10,
            latestTurnStatus: "failed",
            latestTurnStatusObservedAt: BigInt(1_000),
            lastRuntimeIssue: JSON.stringify(usageLimitRuntimeIssue),
        };
        const inactiveUnreadFailure = {
            ...pagedSessionRow("s_failed_inactive_unread", { active: false, meaningfulActivityAt: new Date(2_600) }),
            seq: 11,
            lastViewedSessionSeq: 10,
            latestTurnStatus: "failed",
            latestTurnStatusObservedAt: BigInt(1_000),
            lastRuntimeIssue: JSON.stringify(usageLimitRuntimeIssue),
        };
        const inactiveReadFailure = {
            ...pagedSessionRow("s_failed_inactive_read", { active: false, meaningfulActivityAt: new Date(1_000) }),
            seq: 10,
            lastViewedSessionSeq: 10,
            latestTurnStatus: "failed",
            latestTurnStatusObservedAt: BigInt(1_000),
            lastRuntimeIssue: JSON.stringify(usageLimitRuntimeIssue),
        };
        const inactivePublishedReadFailureWithStagedTail = {
            ...pagedSessionRow("s_failed_inactive_staged_tail", { active: false, meaningfulActivityAt: new Date(1_100) }),
            seq: 9,
            lastViewedSessionSeq: 4,
            latestTurnStatus: "failed",
            latestTurnStatusObservedAt: BigInt(1_000),
            lastRuntimeIssue: JSON.stringify(usageLimitRuntimeIssue),
            currentStorageState: "snapshot_complete",
            acceptedThroughServerSeq: 9,
            materializationPublicationId: "publication-1",
            materializedThroughSourceAt: BigInt(1_000),
            publishedThroughServerSeq: 4,
        };
        sessionFindMany.mockImplementation(async (query) => {
            const where = query.where as Record<string, unknown>;
            if (where.currentStorageState === "hosted" && where.meaningfulActivityAt) {
                return hasAttentionCandidatePredicate(where)
                    ? [
                        activeReadFailure,
                        inactiveUnreadFailure,
                        inactiveReadFailure,
                        inactivePublishedReadFailureWithStagedTail,
                    ]
                    : [normalFirstPageRow, normalSecondPageRow];
            }
            return [];
        });

        const route = await createSessionRouteTestBuilder("GET", "/v2/sessions");
        const { response } = await route.invoke({
            query: {
                includeAttention: "true",
                limit: 1,
            },
        });

        const sessionIds = (response as { sessions: Array<{ id: string }> }).sessions.map((session) => session.id);
        expect(sessionIds).toHaveLength(3);
        expect(sessionIds).toEqual(expect.arrayContaining([
            "s_failed_active_read",
            "s_failed_inactive_unread",
            "s_normal_first_page",
        ]));
        expect(sessionIds).not.toContain("s_failed_inactive_read");
        expect(sessionIds).not.toContain("s_failed_inactive_staged_tail");
    });

    it("caps rollback-eligible turn relation fanout on paged list rows", async () => {
        sessionFindMany.mockResolvedValue([]);

        const route = await createSessionRouteTestBuilder("GET", "/v2/sessions");
        await route.invoke({
            query: { limit: 1 },
        });

        expect(sessionFindMany).toHaveBeenNthCalledWith(1, expect.objectContaining({
            select: expect.objectContaining({
                turns: expect.objectContaining({ take: DEFAULT_SESSION_ROLLBACK_ELIGIBLE_TURN_RELATION_LIMIT }),
            }),
        }));
        expect(sessionFindMany).toHaveBeenNthCalledWith(2, expect.objectContaining({
            select: expect.objectContaining({
                turns: expect.objectContaining({ take: DEFAULT_SESSION_ROLLBACK_ELIGIBLE_TURN_RELATION_LIMIT }),
            }),
        }));
    });

    it("does not truncate initial pinned session expansion queries", async () => {
        sessionFindMany.mockResolvedValue([]);
        const pinnedCount = 101;
        const pinnedSessionIds = Array.from(
            { length: pinnedCount },
            (_value, index) => `s_pinned_${index}`,
        );
        sessionPinFindMany.mockResolvedValue(pinnedSessionIds.map((sessionId, index) => ({
            sessionId,
            sortKey: String(index).padStart(3, "0"),
            pinnedAt: new Date(index + 1),
        })));

        const route = await createSessionRouteTestBuilder("GET", "/v2/sessions");
        await route.invoke({
            query: {
                limit: 1,
            },
        });

        const pinnedQuery = sessionFindMany.mock.calls
            .map((call) => call[0])
            .find((query) => {
                const ids = (query.where as { id?: { in?: string[] } } | undefined)?.id?.in;
                return Array.isArray(ids) && ids.includes("s_pinned_0");
            });
        expect(pinnedQuery).toEqual(expect.objectContaining({
            take: pinnedCount,
        }));
        const pinnedWhere = pinnedQuery?.where as { id?: { in?: string[] } } | undefined;
        const pinnedIds = pinnedWhere?.id?.in ?? [];
        expect(pinnedIds).toHaveLength(pinnedCount);
        expect(pinnedIds).toContain("s_pinned_0");
        expect(pinnedIds).toContain(`s_pinned_${pinnedCount - 1}`);
    });

    it("does not downgrade a missing publication-authority column to the legacy projection", () => {
        expect(isMissingAttentionProjectionColumnError(
            Object.assign(new Error("no such column: currentStorageState"), { code: "P2022" }),
        )).toBe(false);
        expect(isMissingAttentionProjectionColumnError(
            Object.assign(new Error("no such column: publishedThroughServerSeq"), { code: "P2022" }),
        )).toBe(false);
    });

    it("accepts legacy v1 cursors by resolving the cursor row effective activity", async () => {
        sessionFindFirst.mockResolvedValue({
            id: "s5",
            accountId: "u1",
            currentStorageState: "hosted",
            acceptedThroughServerSeq: null,
            materializationPublicationId: null,
            materializedThroughSourceAt: null,
            publishedThroughServerSeq: null,
            createdAt: new Date(5_000),
            meaningfulActivityAt: new Date(4_500),
        });
        sessionFindMany.mockResolvedValue([]);

        const route = await createSessionRouteTestBuilder("GET", "/v2/sessions");
        const { response, reply } = await route.invoke({
            query: { limit: 10, cursor: encodeV2SessionListCursorV1("s5") },
        });

        expect(reply.code).not.toHaveBeenCalledWith(400);
        expect(sessionFindFirst).toHaveBeenCalledWith(expect.objectContaining({
            where: expect.objectContaining({
                id: "s5",
                archivedAt: null,
                OR: expectedV2SessionVisibilityBranches(),
            }),
            select: expect.objectContaining({
                id: true,
                accountId: true,
                createdAt: true,
                meaningfulActivityAt: true,
                currentStorageState: true,
                acceptedThroughServerSeq: true,
                materializationPublicationId: true,
                materializedThroughSourceAt: true,
                publishedThroughServerSeq: true,
            }),
        }));
        expect(sessionFindMany).toHaveBeenCalledWith(expect.objectContaining({
            where: expect.objectContaining({
                AND: [{
                    OR: [
                        { meaningfulActivityAt: { lt: new Date(4_500) } },
                        { meaningfulActivityAt: new Date(4_500), id: { lt: "s5" } },
                    ],
                }],
            }),
        }));
        expect(response).toEqual({ sessions: [], nextCursor: null, hasNext: false });
    });

    it("paginates null meaningfulActivityAt rows by createdAt without skipping the next page", async () => {
        const s9 = pagedSessionRow("s9", {
            createdAt: new Date(900),
            meaningfulActivityAt: new Date(9_000),
        });
        const s8 = pagedSessionRow("s8", {
            createdAt: new Date(8_000),
            meaningfulActivityAt: null,
        });
        const s7 = pagedSessionRow("s7", {
            createdAt: new Date(700),
            meaningfulActivityAt: new Date(7_000),
        });
        sessionFindMany.mockImplementation(async (query) => {
            const where = query.where as Record<string, unknown>;
            if (where.currentStorageState !== "hosted") return [];
            const hasCursor = Array.isArray(where.AND) && where.AND.length > 0;
            if (where.meaningfulActivityAt) {
                return hasCursor ? [s7] : [s9, s7];
            }
            return hasCursor ? [] : [s8];
        });

        const route = await createSessionRouteTestBuilder("GET", "/v2/sessions");
        const { response: firstPage } = await route.invoke({
            query: { limit: 2 },
        });

        expect(firstPage).toEqual({
            sessions: [
                expect.objectContaining({ id: "s9", meaningfulActivityAt: 9_000 }),
                expect.objectContaining({ id: "s8", meaningfulActivityAt: 8_000 }),
            ],
            nextCursor: encodeV2SessionListCursorV2({ sessionId: "s8", meaningfulActivityAt: 8_000 }),
            hasNext: true,
        });

        const { response: secondPage } = await route.invoke({
            query: {
                limit: 2,
                cursor: (firstPage as { nextCursor: string }).nextCursor,
            },
        });

        expect(secondPage).toEqual({
            sessions: [
                expect.objectContaining({ id: "s7", meaningfulActivityAt: 7_000 }),
            ],
            nextCursor: null,
            hasNext: false,
        });
        expect(sessionFindMany).toHaveBeenNthCalledWith(5, expect.objectContaining({
            where: expect.objectContaining({
                archivedAt: null,
                meaningfulActivityAt: { not: null },
                OR: expectedV2SessionVisibilityBranches(),
                AND: [{
                    OR: [
                        { meaningfulActivityAt: { lt: new Date(8_000) } },
                        { meaningfulActivityAt: new Date(8_000), id: { lt: "s8" } },
                    ],
                }],
            }),
        }));
        expect(sessionFindMany).toHaveBeenNthCalledWith(6, expect.objectContaining({
            where: expect.objectContaining({
                archivedAt: null,
                meaningfulActivityAt: null,
                OR: expectedV2SessionVisibilityBranches(),
                AND: [{
                    OR: [
                        { createdAt: { lt: new Date(8_000) } },
                        { createdAt: new Date(8_000), id: { lt: "s8" } },
                    ],
                }],
            }),
        }));
    });

    it("does not expose diagnostic route timing headers on successful paged listing responses", async () => {
        sessionFindMany.mockResolvedValue([]);

        const route = await createSessionRouteTestBuilder("GET", "/v2/sessions");
        const { reply } = await route.invoke({
            query: { limit: 10 },
        });

        expect(
            Object.keys(reply.headers).some((header) => header.toLowerCase() === "server-timing"),
        ).toBe(false);
    });

    it("exposes diagnostic route timing headers only when explicitly requested", async () => {
        sessionFindMany.mockResolvedValue([]);

        const route = await createSessionRouteTestBuilder("GET", "/v2/sessions");
        const { reply } = await route.invoke({
            query: { limit: 10 },
            headers: { "x-happier-session-list-timing": "1" },
        });

        const headers = reply.headers as Record<string, string | undefined>;
        expect(headers["Server-Timing"] ?? headers["server-timing"]).toMatch(
            /happier_v2_sessions_cursor;dur=[0-9]+(?:\.[0-9]+)?, happier_v2_sessions_query;dur=[0-9]+(?:\.[0-9]+)?, happier_v2_sessions_page;dur=[0-9]+(?:\.[0-9]+)?, happier_v2_sessions_total;dur=[0-9]+(?:\.[0-9]+)?/,
        );
    });

    it("exposes diagnostic route timing headers on archived session listing when explicitly requested", async () => {
        sessionFindMany.mockResolvedValue([]);

        const route = await createSessionRouteTestBuilder("GET", "/v2/sessions/archived");
        const { reply } = await route.invoke({
            query: { limit: 10 },
            headers: { "x-happier-session-list-timing": "1" },
        });

        const headers = reply.headers as Record<string, string | undefined>;
        expect(headers["Server-Timing"] ?? headers["server-timing"]).toMatch(
            /happier_v2_sessions_cursor;dur=[0-9]+(?:\.[0-9]+)?, happier_v2_sessions_query;dur=[0-9]+(?:\.[0-9]+)?, happier_v2_sessions_page;dur=[0-9]+(?:\.[0-9]+)?, happier_v2_sessions_total;dur=[0-9]+(?:\.[0-9]+)?/,
        );
    });
});
