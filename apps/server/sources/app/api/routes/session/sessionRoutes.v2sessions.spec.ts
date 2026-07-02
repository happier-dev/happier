import { beforeEach, describe, expect, it } from "vitest";

import {
    encodeV2SessionListCursorV1,
    encodeV2SessionListCursorV2,
} from "@happier-dev/protocol";
import type { SessionRuntimeIssueV1 } from "@happier-dev/protocol";

import {
    DEFAULT_SESSION_ROLLBACK_ELIGIBLE_TURN_RELATION_LIMIT,
    DEFAULT_V2_SESSION_LIST_INITIAL_ATTENTION_ROW_LIMIT,
    DEFAULT_V2_SESSION_LIST_INITIAL_PINNED_ROW_LIMIT,
} from "./v2SessionHotReadLimits";
import {
    mapV2SessionListRow,
} from "./v2SessionListRows";
import {
    createSessionRouteTestBuilder,
    resetSessionRouteMocks,
    sessionFindFirst,
    sessionFindMany,
} from "./sessionRoutes.testkit";

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
        encryptionMode: "plain",
        createdAt,
        updatedAt: overrides.updatedAt ?? createdAt,
        meaningfulActivityAt: overrides.meaningfulActivityAt ?? createdAt,
        archivedAt: null,
        metadata: "{}",
        metadataVersion: 1,
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
    provider: "claude",
    usageLimit: {
        v: 1,
        resetAtMs: null,
        retryAfterMs: null,
        quotaScope: "account",
        recoverability: "wait",
    },
};

function legacyPagedSessionRow(id: string, overrides: Parameters<typeof pagedSessionRow>[1] = {}) {
    const {
        pendingRequestObservedAt: _pendingRequestObservedAt,
        latestReadyEventSeq: _latestReadyEventSeq,
        latestReadyEventAt: _latestReadyEventAt,
        thinking: _thinking,
        thinkingAt: _thinkingAt,
        ...legacyRow
    } = pagedSessionRow(id, overrides);
    return legacyRow;
}

describe("sessionRoutes v2 sessions snapshot", () => {
    beforeEach(() => {
        resetSessionRouteMocks();
        sessionFindFirst.mockReset();
        sessionFindMany.mockReset();
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
                    code: "provider_process_exit_after_switch",
                    source: "provider_process_exit_after_switch",
                    occurredAt: 2_000,
                    provider: "pi",
                    providerProcessExitAfterSwitch: {
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
            source: "provider_process_exit_after_switch",
            providerProcessExitAfterSwitch: {
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
                        source: "provider_status_error",
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
    });

    it("includes initial pinned rows and durable attention rows without consuming the regular page", async () => {
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
        sessionFindMany
            .mockResolvedValueOnce([normalFirstPageRow, normalSecondPageRow])
            .mockResolvedValueOnce([])
            .mockResolvedValueOnce([
                secondPinned,
                firstPinned,
            ])
            .mockResolvedValueOnce([readyAttention])
            .mockResolvedValueOnce([]);

        const route = await createSessionRouteTestBuilder("GET", "/v2/sessions");
        const { response } = await route.invoke({
            query: {
                pinnedSessionIds: "s_pinned_old,s_pinned_older",
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
        const expectedAttentionBranchTake = DEFAULT_V2_SESSION_LIST_INITIAL_ATTENTION_ROW_LIMIT + 1;
        expect(sessionFindMany).toHaveBeenNthCalledWith(4, expect.objectContaining({ take: expectedAttentionBranchTake }));
        expect(sessionFindMany).toHaveBeenNthCalledWith(5, expect.objectContaining({ take: expectedAttentionBranchTake }));
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
        sessionFindMany
            .mockResolvedValueOnce([normalFirstPageRow, normalSecondPageRow])
            .mockResolvedValueOnce([])
            .mockResolvedValueOnce([activeReadFailure, inactiveUnreadFailure, inactiveReadFailure])
            .mockResolvedValueOnce([]);

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

    it("caps initial pinned session expansion queries", async () => {
        sessionFindMany.mockResolvedValue([]);
        const pinnedSessionIds = Array.from(
            { length: DEFAULT_V2_SESSION_LIST_INITIAL_PINNED_ROW_LIMIT + 50 },
            (_value, index) => `s_pinned_${index}`,
        ).join(",");

        const route = await createSessionRouteTestBuilder("GET", "/v2/sessions");
        await route.invoke({
            query: {
                pinnedSessionIds,
                limit: 1,
            },
        });

        const pinnedQuery = sessionFindMany.mock.calls[2]?.[0];
        expect(pinnedQuery).toEqual(expect.objectContaining({
            take: DEFAULT_V2_SESSION_LIST_INITIAL_PINNED_ROW_LIMIT,
        }));
        const pinnedWhere = pinnedQuery?.where as { id?: { in?: string[] } } | undefined;
        const pinnedIds = pinnedWhere?.id?.in ?? [];
        expect(pinnedIds).toHaveLength(DEFAULT_V2_SESSION_LIST_INITIAL_PINNED_ROW_LIMIT);
        expect(pinnedIds).toContain("s_pinned_0");
        expect(pinnedIds).not.toContain(`s_pinned_${DEFAULT_V2_SESSION_LIST_INITIAL_PINNED_ROW_LIMIT}`);
    });

    it("falls back to a legacy row select when attention projection columns are not migrated yet", async () => {
        const missingColumnError = Object.assign(new Error("no such column: pendingRequestObservedAt"), {
            code: "P2022",
        });
        sessionFindMany
            .mockRejectedValueOnce(missingColumnError)
            .mockResolvedValueOnce([])
            .mockResolvedValueOnce([legacyPagedSessionRow("s_legacy")])
            .mockResolvedValueOnce([]);

        const route = await createSessionRouteTestBuilder("GET", "/v2/sessions");
        const { response: res } = await route.invoke({
            query: { limit: 2 },
        });

        expect(sessionFindMany).toHaveBeenCalledTimes(4);
        const initialSelect = sessionFindMany.mock.calls[0]?.[0]?.select as Record<string, unknown>;
        const fallbackSelect = sessionFindMany.mock.calls[2]?.[0]?.select as Record<string, unknown>;
        expect(initialSelect.pendingRequestObservedAt).toBe(true);
        expect(fallbackSelect.pendingRequestObservedAt).toBeUndefined();
        expect(fallbackSelect.turns).toBeUndefined();
        expect(res).toEqual({
            sessions: [
                expect.objectContaining({
                    id: "s_legacy",
                    pendingRequestObservedAt: null,
                    latestReadyEventSeq: null,
                    latestReadyEventAt: null,
                    thinking: false,
                    thinkingAt: null,
                }),
            ],
            nextCursor: null,
            hasNext: false,
        });
    });

    it("falls back to empty rollback eligibility when session turn rows are not migrated yet", async () => {
        const missingTurnRelationError = Object.assign(new Error("no such column: SessionTurn.rollbackState"), {
            code: "P2022",
        });
        sessionFindMany
            .mockRejectedValueOnce(missingTurnRelationError)
            .mockResolvedValueOnce([])
            .mockResolvedValueOnce([legacyPagedSessionRow("s_legacy_turns")])
            .mockResolvedValueOnce([]);

        const route = await createSessionRouteTestBuilder("GET", "/v2/sessions");
        const { response: res } = await route.invoke({
            query: { limit: 2 },
        });

        const fallbackSelect = sessionFindMany.mock.calls[2]?.[0]?.select as Record<string, unknown>;
        expect(fallbackSelect.turns).toBeUndefined();
        expect(res).toEqual({
            sessions: [
                expect.objectContaining({
                    id: "s_legacy_turns",
                    rollbackEligibleTurnStarts: [],
                }),
            ],
            nextCursor: null,
            hasNext: false,
        });
    });

    it("accepts legacy v1 cursors by resolving the cursor row effective activity", async () => {
        sessionFindFirst.mockResolvedValue({
            id: "s5",
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
                OR: expect.arrayContaining([
                    { accountId: "u1" },
                    { shares: { some: { sharedWithUserId: "u1" } } },
                ]),
            }),
            select: { id: true, createdAt: true, meaningfulActivityAt: true },
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
        sessionFindMany
            .mockResolvedValueOnce([
                pagedSessionRow("s9", {
                    createdAt: new Date(900),
                    meaningfulActivityAt: new Date(9_000),
                }),
                pagedSessionRow("s7", {
                    createdAt: new Date(700),
                    meaningfulActivityAt: new Date(7_000),
                }),
            ])
            .mockResolvedValueOnce([
                pagedSessionRow("s8", {
                    createdAt: new Date(8_000),
                    meaningfulActivityAt: null,
                }),
            ])
            .mockResolvedValueOnce([
                pagedSessionRow("s7", {
                    createdAt: new Date(700),
                    meaningfulActivityAt: new Date(7_000),
                }),
            ])
            .mockResolvedValueOnce([]);

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
        expect(sessionFindMany).toHaveBeenNthCalledWith(3, expect.objectContaining({
            where: expect.objectContaining({
                archivedAt: null,
                meaningfulActivityAt: { not: null },
                OR: expect.arrayContaining([
                    { accountId: "u1" },
                    { shares: { some: { sharedWithUserId: "u1" } } },
                ]),
                AND: [{
                    OR: [
                        { meaningfulActivityAt: { lt: new Date(8_000) } },
                        { meaningfulActivityAt: new Date(8_000), id: { lt: "s8" } },
                    ],
                }],
            }),
        }));
        expect(sessionFindMany).toHaveBeenNthCalledWith(4, expect.objectContaining({
            where: expect.objectContaining({
                archivedAt: null,
                meaningfulActivityAt: null,
                OR: expect.arrayContaining([
                    { accountId: "u1" },
                    { shares: { some: { sharedWithUserId: "u1" } } },
                ]),
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
});
