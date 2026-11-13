import { beforeEach, describe, expect, it } from "vitest";

import {
    CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION,
    encodeV2SessionListCursorV1,
    encodeV2SessionListCursorV2,
    V2SessionListResponseSchema,
    V2SessionRecordSchema,
} from "@happier-dev/protocol";
import type { SessionRuntimeIssueV1 } from "@happier-dev/protocol";

import {
    DEFAULT_SESSION_ROLLBACK_ELIGIBLE_TURN_RELATION_LIMIT,
    DEFAULT_V2_SESSION_LIST_INITIAL_ATTENTION_ROW_LIMIT,
} from "@/app/session/listing/readLimits";
import {
    createSessionRouteTestBuilder,
    createSessionDataKeyEnvelopeFixture,
    accountFindUnique,
    FOLLOW_RULE_VIEWER_ACCOUNT_READS,
    createSessionAccessProjectionRelations,
    flattenSessionWhereConjuncts,
    resetSessionRouteMocks,
    sessionFindFirst,
    sessionFindMany,
    txSessionFindFirst,
    txSessionFindMany,
    txSessionPinFindMany,
    txSessionShareFindMany,
    txSessionTurnFindMany,
    sessionTurnFindMany,
} from "./sessionRoutes.testkit";
import {
    mapV2SessionListRow as mapV2SessionListRowWithAccountMode,
} from "@/app/session/listing/rows";
import { isMissingAttentionProjectionColumnError } from "@/app/session/listing/page";
import { matchesDbMockWhere } from "@/app/api/testkit/dbMocks";
import { getRouteEntry } from "@/app/api/testkit/routeHarness";

const OWNER_METADATA_ENVELOPE_V1 = {
    t: "encrypted",
    c: "oRoBAgMEBQYHCAkKCwwNDg8QERITFBUWFxh8aC0+8+YDECLScN6uQTItPyWVR7XbQA==",
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

describe("session listing response contracts", () => {
    it.each([
        "/v2/sessions",
        "/v2/sessions/active",
        "/v2/sessions/archived",
    ] as const)("does not advertise an unreachable 426 response for GET %s", async (path) => {
        const route = await createSessionRouteTestBuilder("GET", path);
        const response = (getRouteEntry(route.app, "GET", path).opts.schema as {
            response: Record<number, unknown>;
        }).response;

        expect(response[426]).toBeUndefined();
    });

    it.each([
        "/v2/sessions",
        "/v2/sessions/active",
        "/v2/sessions/archived",
    ] as const)("admits only a proof-bound session.list PAT effect for GET %s", async (path) => {
        const route = await createSessionRouteTestBuilder("GET", path);
        const config = getRouteEntry(route.app, "GET", path).opts.config;

        expect(config).toMatchObject({
        });
        expect(config?.allowApiToken).toBeUndefined();
    });
});

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
        ...createSessionAccessProjectionRelations(),
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
        meaningfulActivityAt: overrides.meaningfulActivityAt === undefined ? createdAt : overrides.meaningfulActivityAt,
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
        pendingBlockedCount: 0,
        pendingVersion: 0,
        pendingActivationRequestId: null,
        pendingActivationRequestedAt: null,
        pendingActivationStatus: null,
        pendingActivationFailureCode: null,
        dataEncryptionKey: null,
        active: overrides.active ?? false,
        lastActiveAt: overrides.lastActiveAt ?? createdAt,
        accountReadStates: [{ accountId: "u1", lastViewedSessionSeq: 0, unreadSince: null }],
        accountFollows: [],
        sessionPins: [],
        sessionAttentionStandings: [],
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
        // The access owner captures the active viewer before building this predicate.
        { accountId: "u1" },
        expect.objectContaining({
            accountId: { not: "u1" },
            AND: expect.arrayContaining([
                expect.objectContaining({
                    OR: expect.arrayContaining([
                        { currentStorageState: "hosted" },
                        expect.objectContaining({
                            currentStorageState: "snapshot_complete",
                            materializationPublicationId: expect.anything(),
                            materializedThroughSourceAt: {
                                gte: 0,
                                lte: BigInt(Number.MAX_SAFE_INTEGER),
                            },
                            publishedThroughServerSeq: expect.objectContaining({ gte: 0 }),
                        }),
                    ]),
                }),
                expect.objectContaining({
                    OR: expect.arrayContaining([
                        { id: { in: [] } },
                    ]),
                }),
            ]),
        }),
    ]);
}

function findWhereConjunct(
    where: unknown,
    predicate: (clause: Record<string, unknown>) => boolean,
): Record<string, unknown> | undefined {
    return flattenSessionWhereConjuncts(where).find(predicate);
}

function readWhereSessionIds(where: unknown): ReadonlySet<string> | null {
    const clause = findWhereConjunct(where, (value) => Object.prototype.hasOwnProperty.call(value, "id"));
    const values = (clause?.id as { in?: unknown } | undefined)?.in;
    return Array.isArray(values) && values.every((value): value is string => typeof value === "string")
        ? new Set(values)
        : null;
}

function hasActivityCursor(where: unknown): boolean {
    return flattenSessionWhereConjuncts(where).some((clause) =>
        ["meaningfulActivityAt", "createdAt", "materializedThroughSourceAt", "id"].some((key) => {
            const value = clause[key];
            return value !== null && typeof value === "object" && "lt" in value;
        }));
}

function expectPageAccessBranches() {
    const queries = sessionFindMany.mock.calls.map(([query]) => flattenSessionWhereConjuncts(query.where));
    expect(queries).toEqual(expect.arrayContaining([
        expect.arrayContaining([{ accountId: "u1" }]),
        expect.arrayContaining([
            { accountId: { not: "u1" } },
            expect.objectContaining({ OR: expect.arrayContaining([{ id: { in: expect.any(Array) } }]) }),
        ]),
    ]));
}

describe("sessionRoutes v2 sessions snapshot", () => {
    beforeEach(() => {
        resetSessionRouteMocks();
        sessionFindFirst.mockReset();
        sessionFindMany.mockReset();
        sessionFindMany.mockResolvedValue([]);
    });

    it("adds no per-Session owner currentness reads beyond viewer-rule admission for an empty page", async () => {
        sessionFindMany.mockResolvedValue([]);

        const route = await createSessionRouteTestBuilder("GET", "/v2/sessions");
        const { response } = await route.invoke({ query: { limit: 1 } });

        expect(response).toEqual({
            observationCursor: 0,
            sessions: [],
            nextCursor: null,
            hasNext: false,
        });
        expect(accountFindUnique).toHaveBeenCalledTimes(FOLLOW_RULE_VIEWER_ACCOUNT_READS + 1);
    });

    it("merges and acknowledges active rows when a predecessor client requests them", async () => {
        const pageRow = pagedSessionRow("page-row", {
            meaningfulActivityAt: new Date(9_000),
        });
        const activeRow = pagedSessionRow("live-elsewhere", {
            meaningfulActivityAt: new Date(1),
            active: true,
            lastActiveAt: new Date(10_000),
        });
        let returnedPageRow = false;
        sessionFindMany.mockImplementation(async (args) => {
            const orderBy = args.orderBy as ReadonlyArray<Record<string, unknown>> | undefined;
            if (Array.isArray(orderBy) && orderBy[0]?.lastActiveAt === "desc") {
                return [activeRow];
            }
            if (!returnedPageRow) {
                returnedPageRow = true;
                return [pageRow];
            }
            return [];
        });

        const route = await createSessionRouteTestBuilder("GET", "/v2/sessions");
        const { response } = await route.invoke({
            query: { includeActive: true, limit: 10 },
        });

        expect(response).toEqual(expect.objectContaining({
            sessions: [
                expect.objectContaining({ id: "live-elsewhere" }),
                expect.objectContaining({ id: "page-row" }),
            ],
            includedActive: true,
        }));
        expect(sessionFindMany.mock.calls.map(([args]) => args)).toEqual(expect.arrayContaining([
            expect.objectContaining({
                orderBy: [
                    { lastActiveAt: "desc" },
                    { id: "desc" },
                ],
                take: 500,
            }),
        ]));
    });

    it("does not read or acknowledge the active family when it was not requested", async () => {
        sessionFindMany.mockResolvedValue([]);

        const route = await createSessionRouteTestBuilder("GET", "/v2/sessions");
        const { response } = await route.invoke({ query: { limit: 10 } });

        expect(response).not.toHaveProperty("includedActive");
        expect(sessionFindMany.mock.calls.some(([args]) => {
            const orderBy = args.orderBy as ReadonlyArray<Record<string, unknown>> | undefined;
            return Array.isArray(orderBy) && orderBy[0]?.lastActiveAt === "desc";
        })).toBe(false);
    });

    it("projects a waiting activation authorization and keeps it through later publisher activity", async () => {
        sessionFindMany
            .mockResolvedValueOnce([
                {
                    ...pagedSessionRow("waiting", { lastActiveAt: new Date(1_000) }),
                    pendingActivationRequestId: "pending-1",
                    pendingActivationRequestedAt: new Date(2_000),
                    pendingActivationStatus: "waiting",
                },
                {
                    // Publisher activity after the request no longer fences the authorization.
                    ...pagedSessionRow("stale", { lastActiveAt: new Date(3_000) }),
                    pendingActivationRequestId: "pending-2",
                    pendingActivationRequestedAt: new Date(2_000),
                    pendingActivationStatus: "waiting",
                },
            ])
            .mockResolvedValueOnce([]);

        const route = await createSessionRouteTestBuilder("GET", "/v2/sessions");
        const { response: rawResponse } = await route.invoke({ query: { limit: 2 } });
        const response = V2SessionListResponseSchema.parse(rawResponse);

        expect(response.sessions.find((session: { id: string }) => session.id === "waiting")).toMatchObject({
            id: "waiting",
            pendingActivationAuthorization: {
                requestId: "pending-1",
                requestedAt: 2_000,
                status: "waiting",
            },
        });
        expect(response.sessions.find((session: { id: string }) => session.id === "stale")).toMatchObject({
            id: "stale",
            pendingActivationAuthorization: { requestId: "pending-2", requestedAt: 2_000, status: "waiting" },
        });
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
            observationCursor: 0,
            sessions: [
                expect.objectContaining({ id: "owned-layout-one-2" }),
                expect.objectContaining({ id: "owned-layout-one-1" }),
            ],
            nextCursor: null,
            hasNext: false,
        });
        expect(accountFindUnique).toHaveBeenCalled();
    });

    it("reads Account currentness for the displayed shared row, not the owned layout-one lookahead row", async () => {
        const sharedDisplayedRow = {
            ...pagedSessionRow("shared-displayed"),
            accountId: "owner",
            grants: [{ principalKind: 'account', teamId: null, teamGroupId: null, effectiveAt: null, requiredByTeamPolicy: false, account: { status: 'active' }, team: null, teamGroup: null, 
                id: "shared-displayed-grant",
                accountId: "u1",
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
            observationCursor: 0,
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
        expect(accountFindUnique).toHaveBeenCalled();
        expect(accountFindUnique).toHaveBeenCalledWith(expect.objectContaining({
            where: { id: "owner" },
        }));
    });

    it("filters unrepresentable rows before page selection and cursor calculation", async () => {
        const emittedLayoutZero = {
            ...pagedSessionRow("emitted-layout-zero", {
                meaningfulActivityAt: new Date(2_000),
            }),
            metadataLayoutVersion: 0,
            ownerMetadata: null,
        };
        const rows = [
            emittedLayoutZero,
            pagedSessionRow("layout-one-lookahead", { meaningfulActivityAt: new Date(1_000) }),
        ];
        sessionFindMany.mockImplementation(async (query) =>
            rows.filter(row => matchesDbMockWhere(row, query.where))
                .slice(query.skip ?? 0, (query.skip ?? 0) + (query.take ?? rows.length)));


        const route = await createSessionRouteTestBuilder("GET", "/v2/sessions");
        const { reply, response } = await route.invoke({
            query: { limit: 1 },
            accountStoredContentCompatibility:
                LEGACY_ACCOUNT_STORED_CONTENT_COMPATIBILITY,
        });

        expect(reply.statusCode).toBe(200);
        expect(response).toEqual({
            observationCursor: 0,
            sessions: [expect.objectContaining({ id: "emitted-layout-zero" })],
            nextCursor: null,
            hasNext: false,
        });
        expect(sessionFindMany.mock.calls).not.toHaveLength(0);
        const pageRowQueries = sessionFindMany.mock.calls.filter(([query]) =>
            flattenSessionWhereConjuncts(query.where).some((clause) =>
                Object.prototype.hasOwnProperty.call(clause, "currentStorageState")));
        expect(pageRowQueries).not.toHaveLength(0);
        for (const [query] of pageRowQueries) {
            expect(flattenSessionWhereConjuncts(query.where))
                .toContainEqual({ metadataLayoutVersion: { not: 1 } });
        }
        expect(accountFindUnique).toHaveBeenCalledTimes(FOLLOW_RULE_VIEWER_ACCOUNT_READS + 1);
    });

    it("omits an incompatible pinned row without rejecting the compatible page", async () => {
        const regularLayoutZero = {
            ...pagedSessionRow("regular-layout-zero"),
            metadataLayoutVersion: 0,
            ownerMetadata: null,
        };
        const regularLookahead = {
            ...pagedSessionRow("regular-lookahead", {
                meaningfulActivityAt: new Date(900),
            }),
            metadataLayoutVersion: 0,
            ownerMetadata: null,
        };
        txSessionPinFindMany.mockResolvedValue([
            {
                sessionId: "pinned-layout-one",
                sortKey: "a",
                pinnedAt: new Date(1_000),
            },
        ]);
        sessionFindMany.mockImplementation(async (query) => {
            const where = query.where as Record<string, unknown>;
            const hosted = findWhereConjunct(where, (clause) => clause.currentStorageState === "hosted");
            const ids = findWhereConjunct(where, (clause) => Object.prototype.hasOwnProperty.call(clause, "id"));
            const filtersLegacyRows = findWhereConjunct(where, (clause) =>
                (clause.metadataLayoutVersion as { not?: number } | undefined)?.not === 1);
            if (hosted?.meaningfulActivityAt) {
                return [regularLayoutZero, regularLookahead];
            }
            if (ids) {
                if (filtersLegacyRows) return [];
                return [pagedSessionRow("pinned-layout-one", {
                    meaningfulActivityAt: new Date(100),
                })];
            }
            return [];
        });

        const route = await createSessionRouteTestBuilder("GET", "/v2/sessions");
        const { reply, response } = await route.invoke({
            query: { limit: 1 },
            accountStoredContentCompatibility:
                LEGACY_ACCOUNT_STORED_CONTENT_COMPATIBILITY,
        });

        expect(reply.statusCode).toBe(200);
        expect(response).toEqual({
            observationCursor: 0,
            sessions: [expect.objectContaining({ id: "regular-layout-zero" })],
            nextCursor: expect.any(String),
            hasNext: true,
            attentionNextCursor: null,
            attentionHasNext: false,
        });
        expect((response as { sessions: Array<{ id: string }> }).sessions)
            .not.toContainEqual(expect.objectContaining({ id: "pinned-layout-one" }));
        expect(accountFindUnique).toHaveBeenCalledTimes(FOLLOW_RULE_VIEWER_ACCOUNT_READS + 1);
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
            grants: [{ principalKind: 'account', teamId: null, teamGroupId: null, effectiveAt: null, requiredByTeamPolicy: false, account: { status: 'active' }, team: null, teamGroup: null, 
                id: "shared-agent-state-grant",
                accountId: "recipient",
                encryptedDataKey: null,
                accessLevel: "view",
                canApprovePermissions: false,
             }],
            currentStorageState: "hosted",
        } as any;

        const owner = mapV2SessionListRow({ userId: "owner", row, hasOtherNamedCollaborator: true });
        const recipient = mapV2SessionListRow({ userId: "recipient", row, hasOtherNamedCollaborator: true });

        expect(owner.agentState).toBe("full-owner-agent-state");
        expect(owner.agentStateVersion).toBe(7);
        expect(recipient.metadata).toBe(STORED_SHARED_METADATA_V1);
        expect(recipient).not.toHaveProperty("ownerMetadata");
        expect(recipient.agentState).toBeNull();
        expect(recipient.agentStateVersion).toBe(7);
        expect(recipient.metadataLayoutVersion).toBe(1);
        expect(owner.hasOtherNamedCollaborator).toBe(true);
        expect(recipient.hasOtherNamedCollaborator).toBe(true);
        expect(JSON.stringify(recipient)).not.toMatch(
            /oRoBAgMEBQYHCAkKCwwNDg8QERITFBUWFxh8aC0\+8\+YDECLScN6uQTItPyWVR7XbQA==|full-owner-agent-state/,
        );
        expect(V2SessionRecordSchema.safeParse(owner).success).toBe(true);
        expect(V2SessionRecordSchema.safeParse(recipient).success).toBe(true);
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
            grants: [{ principalKind: 'account', teamId: null, teamGroupId: null, effectiveAt: null, requiredByTeamPolicy: false, account: { status: 'active' }, team: null, teamGroup: null, 
                id: "mixed-recipient-grant",
                accountId: "recipient",
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
        expect(V2SessionRecordSchema.safeParse({
                ...recipient,
                ownerMetadata: OWNER_METADATA_ENVELOPE_V1,
                agentState: "full-owner-agent-state",
        }).success).toBe(false);
    });

    it("omits the legacy direct-share field for a Team-only recipient", () => {
        const recipient = mapV2SessionListRow({
            userId: "recipient",
            qualifiedTeamIds: new Set(["team-1"]),
            row: {
                ...pagedSessionRow("s_team_only"),
                accountId: "owner",
                metadata: STORED_SHARED_METADATA_V1,
                ownerMetadata: STORED_OWNER_METADATA_ENVELOPE_V1,
                grants: [{ id: 'team-grant', principalKind: 'team', accountId: null, teamGroupId: null, account: null, teamGroup: null, 
                    teamId: "team-1",
                    effectiveAt: new Date(1),
                    accessLevel: "view",
                    canApprovePermissions: false,
                    requiredByTeamPolicy: false,
                    team: {
                        authenticationPolicy: null,
                        memberships: [{
                            accountId: "recipient",
                            sessionAccessStartsAt: null,
                        }],
                    },
                 }],
                
            } as any,
        });

        expect(recipient).not.toHaveProperty("share");
        expect(recipient.effectiveAccess).toMatchObject({
            v: 1,
            level: "view",
            sources: [{
                kind: "team",
                teamId: "team-1",
                requiredByTeamPolicy: false,
            }],
        });
        expect(V2SessionRecordSchema.safeParse(recipient).success).toBe(true);
    });

    it("GET /v2/sessions omits one unmigrated layout-zero share and keeps the rest of the page", async () => {
        sessionFindMany
            .mockResolvedValueOnce([
                {
                    ...pagedSessionRow("legacy-shared", {
                        meaningfulActivityAt: new Date(9_000),
                    }),
                    accountId: "owner",
                    metadata: "legacy-whole-bag",
                    metadataLayoutVersion: 0,
                    ownerMetadata: null,
                    agentState: "legacy-owner-state",
                    agentStateVersion: 7,
                    grants: [{ principalKind: 'account', teamId: null, teamGroupId: null, effectiveAt: null, requiredByTeamPolicy: false, account: { status: 'active' }, team: null, teamGroup: null, 
                        id: "legacy-shared-grant",
                        accountId: "u1",
                        encryptedDataKey: null,
                        accessLevel: "view",
                        canApprovePermissions: false,
                     }],
                    currentStorageState: "hosted",
                },
                pagedSessionRow("owned-current", {
                    meaningfulActivityAt: new Date(8_000),
                }),
            ])
            .mockResolvedValueOnce([]);

        const route = await createSessionRouteTestBuilder("GET", "/v2/sessions");
        const { reply, response: res } = await route.invoke({ query: { limit: 2 } });

        expect(reply.statusCode).toBe(200);
        const payload = res as {
            sessions: ReadonlyArray<{ id: string }>;
            metadataUpgradeRequiredCount?: number;
        };
        // The readable row survives, the unreadable one is omitted, and the
        // omission stays visible instead of silently shrinking the page.
        expect(payload.sessions.map((session) => session.id)).toEqual(["owned-current"]);
        expect(payload.metadataUpgradeRequiredCount).toBe(1);
        expect(V2SessionListResponseSchema.safeParse(payload).success).toBe(true);
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
                accountReadStates: [{ accountId: "u1", lastViewedSessionSeq: 11, unreadSince: null }],
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
                    accountReadStates: [{ accountId: "u1", lastViewedSessionSeq: 8, unreadSince: null }],
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

            expect(mapped.active).toBe(false);
            for (const field of [
                "pendingPermissionRequestCount",
                "pendingUserActionRequestCount",
                "pendingRequestObservedAt",
                "pendingCount",
                "pendingBlockedCount",
                "pendingVersion",
                "latestTurnId",
                "latestTurnStatus",
                "latestTurnStatusObservedAt",
                "lastRuntimeIssue",
                "thinking",
                "thinkingAt",
                "runtimeActivityState",
                "runtimeActivityActiveCount",
                "runtimeActivityObservedAt",
                "runtimeActivityRevision",
            ]) {
                expect(mapped).not.toHaveProperty(field);
            }
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
                seq: 12,
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
        const rows = [
                {
                    ...pagedSessionRow("s3", {
                        createdAt: now,
                        updatedAt: now,
                        meaningfulActivityAt: new Date(3),
                        active: true,
                        lastActiveAt: now,
                    }),
                    seq: 3,
                    encryptionMode: "e2ee",
                    metadata: "m3",
                    lastViewedSessionSeq: 2,
                    pendingPermissionRequestCount: 1,
                    dataKeyEnvelopes: [createSessionDataKeyEnvelopeFixture(Buffer.from([1, 2, 3]))],
                    accountReadStates: [{ accountId: "u1", lastViewedSessionSeq: 2, unreadSince: null }],
                },
                {
                    ...pagedSessionRow("s2", {
                        createdAt: now,
                        updatedAt: now,
                        meaningfulActivityAt: new Date(2),
                        active: true,
                        lastActiveAt: now,
                    }),
                    seq: 2,
                    accountId: "owner",
                    encryptionMode: "e2ee",
                    metadata: "m2",
                    lastViewedSessionSeq: 1,
                    pendingUserActionRequestCount: 2,
                    dataKeyEnvelopes: [createSessionDataKeyEnvelopeFixture(Buffer.from([4, 5]))],
                    accountReadStates: [{ accountId: "u1", lastViewedSessionSeq: 1, unreadSince: null }],
                    grants: [{ principalKind: 'account', teamId: null, teamGroupId: null, effectiveAt: null, requiredByTeamPolicy: false, account: { status: 'active' }, team: null, teamGroup: null, 
                            id: "s2-direct-grant",
                            accountId: "u1",
                            accessLevel: "edit",
                            canApprovePermissions: true,
                         }],
                },
                {
                    ...pagedSessionRow("s1", {
                        createdAt: now,
                        updatedAt: now,
                        meaningfulActivityAt: new Date(1),
                        active: true,
                        lastActiveAt: now,
                    }),
                    seq: 1,
                    metadata: "m1",
                },
        ];
        txSessionShareFindMany.mockResolvedValue([{
            sessionId: "s2", accountId: "u1", accessLevel: "edit", canApprovePermissions: true,
        }]);
        sessionFindMany.mockImplementation(async (query) =>
            rows.filter(row => matchesDbMockWhere(row, query.where))
                .slice(query.skip ?? 0, (query.skip ?? 0) + (query.take ?? rows.length)));

        const route = await createSessionRouteTestBuilder("GET", "/v2/sessions");
        const { response: res } = await route.invoke({
            query: { limit: 2 },
        });

        expectPageAccessBranches();

        expect(res).toEqual({
            observationCursor: 0,
            sessions: [
                expect.objectContaining({
                    id: "s3",
                    meaningfulActivityAt: 3,
                    encryptionMode: "e2ee",
                    dataEncryptionKey: "AQID",
                    lastViewedSessionSeq: 2,
                    pendingPermissionRequestCount: 1,
                    pendingUserActionRequestCount: 0,
                    effectiveAccess: expect.objectContaining({
                        v: 1,
                        level: "owner",
                        sources: [{ kind: "owner" }],
                        capabilities: expect.objectContaining({
                            readTranscript: true,
                            manageAccess: true,
                            deleteSession: true,
                        }),
                    }),
                    share: null,
                    archivedAt: null,
                }),
                expect.objectContaining({
                    id: "s2",
                    meaningfulActivityAt: 2,
                    encryptionMode: "e2ee",
                    dataEncryptionKey: "BAU=",
                    // The viewer's own cursor row is the viewer's frontier, with or
                    // without Follow (projection.ts `tracked || readRow !== undefined`),
                    // so a recipient holding `lastViewedSessionSeq: 1` reads 1, not seq.
                    lastViewedSessionSeq: 1,
                    pendingPermissionRequestCount: 0,
                    pendingUserActionRequestCount: 2,
                    effectiveAccess: expect.objectContaining({
                        v: 1,
                        level: "edit",
                        sources: [{ kind: "direct", shareId: "s2-direct-grant" }],
                        capabilities: expect.objectContaining({
                            readTranscript: true,
                            submitAgentInput: true,
                            approveRuntimePermissions: true,
                            manageAccess: false,
                        }),
                    }),
                    share: { accessLevel: "edit", canApprovePermissions: true },
                    archivedAt: null,
                }),
            ],
            nextCursor: encodeV2SessionListCursorV2({ sessionId: "s2", meaningfulActivityAt: 2 }),
            hasNext: true,
        });
        for (const session of (res as { sessions: Array<Record<string, unknown>> }).sessions) {
            expect(session.effectiveAccess).not.toHaveProperty("accountId");
            expect(session.effectiveAccess).not.toHaveProperty("sessionId");
        }
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
            grants: [{ principalKind: 'account', teamId: null, teamGroupId: null, effectiveAt: null, requiredByTeamPolicy: false, account: { status: 'active' }, team: null, teamGroup: null, 
                id: `${id}-direct-grant`,
                accountId: "u1",
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
            observationCursor: 0,
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
        expectPageAccessBranches();
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
            accountReadStates: [{ accountId: "u1", lastViewedSessionSeq: 7, unreadSince: null }],
            latestReadyEventSeq: 8,
            latestReadyEventAt: new Date(900),
        };
        txSessionPinFindMany.mockResolvedValue([
            { sessionId: "s_pinned_old", sortKey: "a", pinnedAt: new Date(1_000) },
            { sessionId: "s_pinned_older", sortKey: "b", pinnedAt: new Date(2_000) },
        ]);
        txSessionFindMany.mockResolvedValue([readyAttention]);
        sessionFindMany.mockImplementation(async (query) => {
            const where = query.where as Record<string, unknown>;
            const hosted = findWhereConjunct(where, (clause) => clause.currentStorageState === "hosted");
            if (hosted?.meaningfulActivityAt) {
                const ids = readWhereSessionIds(where);
                return ids?.has(readyAttention.id)
                    ? [readyAttention]
                    : [normalFirstPageRow, normalSecondPageRow];
            }
            if (readWhereSessionIds(where)) {
                return [secondPinned, firstPinned];
            }
            return [];
        });

        const route = await createSessionRouteTestBuilder("GET", "/v2/sessions");
        const { response } = await route.invoke({
            query: {
                includeAttention: true,
                limit: 1,
            },
        });

        expect(txSessionFindMany).toHaveBeenCalled();
        expect(sessionFindMany.mock.calls
            .map((call) => [...(readWhereSessionIds(call[0].where) ?? [])]))
            .toContainEqual(expect.arrayContaining([readyAttention.id]));
        expect((response as { sessions: Array<{ id: string }> }).sessions.map((session) => session.id)).toEqual(expect.arrayContaining([
            "s_pinned_old",
            "s_pinned_older",
            "s_ready_attention",
        ]));
        expect(response).toEqual(expect.objectContaining({
            nextCursor: expect.any(String),
            hasNext: true,
        }));
        expect(txSessionPinFindMany).toHaveBeenCalledWith(expect.objectContaining({
            where: expect.objectContaining({
                accountId: "u1",
                session: expect.any(Object),
            }),
            orderBy: [{ sortKey: "asc" }, { pinnedAt: "asc" }],
        }));
        const pinSessionWhere = txSessionPinFindMany.mock.calls[0]?.[0]?.where?.session;
        expect(flattenSessionWhereConjuncts(pinSessionWhere)).toEqual(expect.arrayContaining([
            { archivedAt: null },
            expect.objectContaining({ OR: expectedV2SessionVisibilityBranches() }),
        ]));
        expect(accountFindUnique).toHaveBeenCalled();
    });

    it("treats an empty server pin set as authoritative instead of falling back to client-provided pinned ids", async () => {
        txSessionPinFindMany.mockResolvedValue([]);
        const normalFirstPageRow = pagedSessionRow("s_normal_first_page", { meaningfulActivityAt: new Date(1_000) });
        const legacyPinnedRow = pagedSessionRow("s_legacy_pinned", { meaningfulActivityAt: new Date(100) });
        // The database holds both rows; the page selection must still never ask for the client-provided id.
        sessionFindMany.mockImplementation(async (query) => {
            const ids = readWhereSessionIds(query.where);
            return ids?.has("s_legacy_pinned") ? [legacyPinnedRow] : [normalFirstPageRow];
        });

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
            const ids = findWhereConjunct(call[0].where, (clause) => Object.prototype.hasOwnProperty.call(clause, "id"))
                ?.id as { in?: string[] } | undefined;
            return Array.isArray(ids?.in) && ids.in.includes("s_legacy_pinned");
        })).toBe(false);
    });

    it("keeps canonical failed attention rows while rejecting an unpublished staged tail", async () => {
        const normalFirstPageRow = pagedSessionRow("s_normal_first_page", { meaningfulActivityAt: new Date(1_000) });
        const normalSecondPageRow = pagedSessionRow("s_normal_second_page", { meaningfulActivityAt: new Date(950) });
        const activeReadFailure = {
            ...pagedSessionRow("s_failed_active_read", { active: true, meaningfulActivityAt: new Date(2_500) }),
            seq: 10,
            lastViewedSessionSeq: 9,
            latestTurnId: "turn-failed",
            latestTurnStatus: "failed",
            latestTurnStatusObservedAt: BigInt(1_000),
            lastRuntimeIssue: JSON.stringify(usageLimitRuntimeIssue),
        };
        const inactiveUnreadFailure = {
            ...pagedSessionRow("s_failed_inactive_unread", { active: false, meaningfulActivityAt: new Date(2_600) }),
            seq: 11,
            lastViewedSessionSeq: 10,
            latestTurnId: "turn-failed",
            latestTurnStatus: "failed",
            latestTurnStatusObservedAt: BigInt(1_000),
            lastRuntimeIssue: JSON.stringify(usageLimitRuntimeIssue),
        };
        const inactiveReadFailure = {
            ...pagedSessionRow("s_failed_inactive_read", { active: false, meaningfulActivityAt: new Date(1_000) }),
            seq: 10,
            lastViewedSessionSeq: 9,
            latestTurnId: "turn-failed",
            latestTurnStatus: "failed",
            latestTurnStatusObservedAt: BigInt(1_000),
            lastRuntimeIssue: JSON.stringify(usageLimitRuntimeIssue),
        };
        const failureAnchors = new Map([
            ["s_failed_active_read", 10],
            ["s_failed_inactive_unread", 11],
            ["s_failed_inactive_read", 10],
        ]);
        // Persistence boundary: each current failed turn commits its transcript anchor; a failure
        // stays attention only while that anchor is beyond the viewer cursor.
        const readFailureAnchors = async (query: { where: { OR: Array<{ sessionId: string; turnId: string }> } }) =>
            query.where.OR.flatMap(({ sessionId }) => failureAnchors.has(sessionId)
                ? [{ sessionId, transcriptAnchorsJson: JSON.stringify({ endSeqInclusive: failureAnchors.get(sessionId) }) }]
                : []);
        txSessionTurnFindMany.mockImplementation(readFailureAnchors as never);
        sessionTurnFindMany.mockImplementation(readFailureAnchors as never);
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
        for (const row of [activeReadFailure, inactiveUnreadFailure, inactiveReadFailure, inactivePublishedReadFailureWithStagedTail]) {
            row.accountReadStates = [{
                accountId: "u1",
                lastViewedSessionSeq: row.lastViewedSessionSeq,
                unreadSince: null,
            }];
        }
        txSessionFindMany.mockResolvedValue([
            activeReadFailure,
            inactiveUnreadFailure,
            inactiveReadFailure,
            normalFirstPageRow,
        ]);
        sessionFindMany.mockImplementation(async (query) => {
            const where = query.where as Record<string, unknown>;
            const hosted = findWhereConjunct(where, (clause) => clause.currentStorageState === "hosted");
            if (hosted?.meaningfulActivityAt) {
                const ids = readWhereSessionIds(where);
                return ids
                    ? [
                        activeReadFailure,
                        inactiveUnreadFailure,
                        inactiveReadFailure,
                        inactivePublishedReadFailureWithStagedTail,
                    ].filter((row) => ids.has(row.id) && row.currentStorageState === "hosted")
                    : [normalFirstPageRow, normalSecondPageRow];
            }
            return [];
        });

        const route = await createSessionRouteTestBuilder("GET", "/v2/sessions");
        const { response } = await route.invoke({
            query: {
                includeAttention: true,
                limit: 1,
            },
        });

        expect(txSessionFindMany).toHaveBeenCalled();
        const sessionIds = (response as { sessions: Array<{ id: string }> }).sessions.map((session) => session.id);
        expect(sessionIds).toHaveLength(4);
        expect(sessionIds).toEqual(expect.arrayContaining([
            "s_failed_active_read",
            "s_failed_inactive_unread",
            "s_failed_inactive_read",
            "s_normal_first_page",
        ]));
        expect(sessionIds).not.toContain("s_failed_inactive_staged_tail");
    });

    it("caps rollback-eligible turn relation fanout on paged list rows", async () => {
        // The activity branches select ids only; the page's private relations (including the
        // capped rollback-eligible turns) load once, by id, for the merged page.
        sessionFindMany.mockResolvedValue([pagedSessionRow("s_page_row", { meaningfulActivityAt: new Date(1_000) })]);

        const route = await createSessionRouteTestBuilder("GET", "/v2/sessions");
        await route.invoke({
            query: { limit: 1 },
        });

        expect(sessionFindMany).toHaveBeenCalledWith(expect.objectContaining({
            where: { id: { in: expect.arrayContaining(["s_page_row"]) } },
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
        txSessionPinFindMany.mockResolvedValue(pinnedSessionIds.map((sessionId, index) => ({
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
                const ids = findWhereConjunct(query.where, (clause) => Object.prototype.hasOwnProperty.call(clause, "id"))
                    ?.id as { in?: string[] } | undefined;
                return Array.isArray(ids?.in) && ids.in.includes("s_pinned_0");
            });
        expect(pinnedQuery).toEqual(expect.objectContaining({
            take: pinnedCount,
        }));
        const pinnedIds = (findWhereConjunct(
            pinnedQuery?.where,
            (clause) => Object.prototype.hasOwnProperty.call(clause, "id"),
        )?.id as { in?: string[] } | undefined)?.in ?? [];
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
        const cursorRow = {
            id: "s5",
            accountId: "u1",
            currentStorageState: "hosted",
            acceptedThroughServerSeq: null,
            materializationPublicationId: null,
            materializedThroughSourceAt: null,
            publishedThroughServerSeq: null,
            createdAt: new Date(5_000),
            meaningfulActivityAt: new Date(4_500),
        };
        sessionFindFirst.mockResolvedValue(cursorRow);
        sessionFindMany.mockImplementation(async (query) =>
            flattenSessionWhereConjuncts(query.where).some(clause => clause.id === "s5") ? [cursorRow] : []);

        const route = await createSessionRouteTestBuilder("GET", "/v2/sessions");
        const { response, reply } = await route.invoke({
            query: { limit: 10, cursor: encodeV2SessionListCursorV1("s5") },
        });

        expect(reply.code).not.toHaveBeenCalledWith(400);
        expect(sessionFindFirst).toHaveBeenCalledWith(expect.objectContaining({
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
        expect(flattenSessionWhereConjuncts(sessionFindFirst.mock.calls[0]?.[0]?.where)).toEqual(expect.arrayContaining([
            { id: "s5" },
            { archivedAt: null },
            expect.objectContaining({ OR: expectedV2SessionVisibilityBranches() }),
        ]));
        expect(sessionFindMany.mock.calls.some((call) => hasActivityCursor(call[0].where))).toBe(true);
        expect(response).toEqual({ sessions: [], nextCursor: null, hasNext: false, observationCursor: 0 });
    });

    it("POST /v2/sessions/query returns the cursor error for an inaccessible legacy cursor", async () => {
        txSessionFindFirst.mockResolvedValue(null);

        const route = await createSessionRouteTestBuilder("POST", "/v2/sessions/query");
        const request = route.createAuthenticatedRequest({
            body: {
                v: 1,
                storage: "active",
                includeInactive: true,
                scope: "all_accessible",
                attention: "any",
                audiences: [],
                tagIds: [],
                cursor: encodeV2SessionListCursorV1("foreign-session"),
            },
        });
        const reply = route.createReply();
        const response = await route.app.routes
            .get("POST /v2/sessions/query")!
            .handler(request, reply);

        expect(reply.statusCode).toBe(400);
        expect(response).toEqual({ error: "Invalid cursor format" });
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
        const rows = [s9, s8, s7];
        sessionFindMany.mockImplementation(async (query) =>
            rows.filter(row => matchesDbMockWhere(row, query.where))
                .slice(query.skip ?? 0, (query.skip ?? 0) + (query.take ?? rows.length)));


        const route = await createSessionRouteTestBuilder("GET", "/v2/sessions");
        const { response: firstPage } = await route.invoke({
            query: { limit: 2 },
        });

        expect(firstPage).toEqual({
            observationCursor: 0,
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
            observationCursor: 0,
            sessions: [
                expect.objectContaining({ id: "s7", meaningfulActivityAt: 7_000 }),
            ],
            nextCursor: null,
            hasNext: false,
        });
        const secondPageActivityQuery = sessionFindMany.mock.calls
            .map(([query]) => query)
            .find((query) => {
                const hosted = findWhereConjunct(query.where, (clause) =>
                    clause.currentStorageState === "hosted"
                    && (clause.meaningfulActivityAt as { not?: null } | undefined)?.not === null);
                return hosted !== undefined && hasActivityCursor(query.where);
            });
        const secondPageNullActivityQuery = sessionFindMany.mock.calls
            .map(([query]) => query)
            .find((query) => {
                const hosted = findWhereConjunct(query.where, (clause) =>
                    clause.currentStorageState === "hosted"
                    && clause.meaningfulActivityAt === null);
                return hosted !== undefined && hasActivityCursor(query.where);
            });

        expect(secondPageActivityQuery).toBeDefined();
        expect(flattenSessionWhereConjuncts(secondPageActivityQuery?.where)).toEqual(expect.arrayContaining([
            { archivedAt: null },
            { currentStorageState: "hosted", meaningfulActivityAt: { not: null } },
            { accountId: "u1" },
            { meaningfulActivityAt: { lt: new Date(8_000) } },
        ]));
        expect(secondPageNullActivityQuery).toBeDefined();
        expect(flattenSessionWhereConjuncts(secondPageNullActivityQuery?.where)).toEqual(expect.arrayContaining([
            { archivedAt: null },
            { currentStorageState: "hosted", meaningfulActivityAt: null },
            { accountId: "u1" },
            { createdAt: { lt: new Date(8_000) } },
        ]));
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
