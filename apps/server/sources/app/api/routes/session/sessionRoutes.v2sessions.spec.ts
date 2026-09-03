import { beforeEach, describe, expect, it } from "vitest";

import {
    encodeV2SessionListCursorV1,
    encodeV2SessionListCursorV2,
} from "@happier-dev/protocol";
import type { SessionRuntimeIssueV1 } from "@happier-dev/protocol";

import { mapV2SessionListRow } from "./v2SessionListRows";
import {
    createSessionRouteTestBuilder,
    resetSessionRouteMocks,
    sessionFindFirst,
    sessionFindMany,
    sessionPinFindMany,
} from "./sessionRoutes.testkit";
import { DEFAULT_V2_SESSION_LIST_INITIAL_ATTENTION_ROW_LIMIT } from "./v2SessionListInitialPage";
import { V2_ACTIVE_SESSION_LIST_ROW_LIMIT } from "./v2SessionListPage";

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
        latestReadyEventSeq: null,
        latestReadyEventAt: null,
        thinking: false,
        thinkingAt: null,
        latestTurnId: null,
        latestTurnStatus: null,
        lastRuntimeIssue: null,
        pendingCount: 0,
        pendingVersion: 0,
        dataEncryptionKey: null,
        active: overrides.active ?? false,
        lastActiveAt: overrides.lastActiveAt ?? createdAt,
        runtimeActivityState: "unknown",
        runtimeActivityActiveCount: 0,
        runtimeActivityObservedAt: null,
        runtimeActivityRevision: 0n,
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

function legacyPagedSessionRow(id: string) {
    const {
        pendingRequestObservedAt: _pendingRequestObservedAt,
        latestReadyEventSeq: _latestReadyEventSeq,
        latestReadyEventAt: _latestReadyEventAt,
        thinking: _thinking,
        thinkingAt: _thinkingAt,
        ...row
    } = pagedSessionRow(id);
    return row;
}

describe("sessionRoutes v2 sessions snapshot", () => {
    beforeEach(() => {
        resetSessionRouteMocks();
        sessionFindFirst.mockReset();
        sessionFindMany.mockReset();
    });

    it("exposes the materialized turn status observation time on v2 session rows", () => {
        const now = new Date(1_000);
        const mapped = mapV2SessionListRow({
            userId: "u1",
            row: {
                ...pagedSessionRow("s_projection", { createdAt: now }),
                latestTurnId: "turn-1",
                latestTurnStatus: "completed",
                latestTurnStatusObservedAt: 1_234,
            } as any,
        });

        expect(mapped.latestTurnId).toBe("turn-1");
        expect(mapped.latestTurnStatus).toBe("completed");
        expect(mapped.latestTurnStatusObservedAt).toBe(1_234);
    });

    it("exposes durable attention and live-work projection fields on v2 session rows", () => {
        const now = new Date(1_000);
        const mapped = mapV2SessionListRow({
            userId: "u1",
            row: {
                ...pagedSessionRow("s_attention", { createdAt: now, active: true }),
                thinking: true,
                thinkingAt: new Date(1_111),
                pendingPermissionRequestCount: 1,
                pendingUserActionRequestCount: 0,
                pendingRequestObservedAt: new Date(1_222),
                latestReadyEventSeq: 9,
                latestReadyEventAt: new Date(1_333),
                runtimeActivityState: "active",
                runtimeActivityRevision: BigInt(8),
                runtimeActivityActiveCount: 2,
                runtimeActivityObservedAt: BigInt(1_444),
            } as any,
        });

        expect(mapped.thinking).toBe(true);
        expect(mapped.thinkingAt).toBe(1_111);
        expect(mapped.pendingRequestObservedAt).toBe(1_222);
        expect(mapped.latestReadyEventSeq).toBe(9);
        expect(mapped.latestReadyEventAt).toBe(1_333);
        expect(mapped.runtimeActivityActiveCount).toBe(2);
        expect(mapped.runtimeActivityObservedAt).toBe(1_444);
        expect(mapped).not.toHaveProperty("runtimeActivitySourceClass");
    });

    it("exposes only lifecycle-current durable pending activation authorization", () => {
        const mapped = mapV2SessionListRow({
            userId: "u1",
            row: {
                ...pagedSessionRow("s_activation", { lastActiveAt: new Date(1_000) }),
                pendingActivationRequestId: "pending-1",
                pendingActivationRequestedAt: new Date(1_001),
                pendingActivationStatus: "waiting",
                pendingActivationFailureCode: null,
            } as any,
        });

        expect(mapped.pendingActivationAuthorization).toEqual({
            requestId: "pending-1",
            requestedAt: 1_001,
            status: "waiting",
        });
    });

    it("preserves the target runtime activity projection without time-based reinterpretation", () => {
        const mapped = mapV2SessionListRow({
            userId: "u1",
            row: {
                ...pagedSessionRow("s_runtime_v2", { active: true }),
                runtimeActivityState: "active",
                runtimeActivityRevision: BigInt(17),
                runtimeActivityActiveCount: 1,
                runtimeActivityObservedAt: BigInt(1_444),
            } as any,
        });

        expect(mapped).toMatchObject({
            runtimeActivityState: "active",
            runtimeActivityRevision: 17,
            runtimeActivityActiveCount: 1,
            runtimeActivityObservedAt: 1_444,
        });
        expect(mapped).not.toHaveProperty("runtimeActivitySourceClass");
    });

    it("hydrates generic unread sessions into the initial attention page and excludes read ready candidates", async () => {
        const unreadClaudeRow = {
            ...pagedSessionRow("claude-unread", { meaningfulActivityAt: new Date(7_390) }),
            seq: 742,
            lastViewedSessionSeq: 738,
            latestReadyEventSeq: 110,
            latestReadyEventAt: new Date(1_100),
            latestTurnStatus: "completed",
            latestTurnStatusObservedAt: BigInt(7_000),
        };
        const readReadyRow = {
            ...unreadClaudeRow,
            id: "read-ready",
            lastViewedSessionSeq: 742,
        };
        // Two read rows, which is more than the requested limit — so the page has a next page and the
        // attention family can extend past it. A page that is already the whole visible list holds
        // every attention row it could, and the read is skipped outright.
        const readPageRows = [9_000, 8_000].map((activityAt, index) => ({
            ...pagedSessionRow(`page-${index === 0 ? "a" : "b"}`, { meaningfulActivityAt: new Date(activityAt) }),
            lastViewedSessionSeq: 1,
        }));
        sessionPinFindMany.mockResolvedValue([]);
        // The attention read is issued as one statement per (visibility arm x activity branch), so
        // this double answers by predicate shape rather than by call index. Returning the same rows
        // from both visibility arms also proves the merge de-duplicates them.
        sessionFindMany.mockImplementation(async (args: any) => {
            const where = args?.where ?? {};
            const isAttentionRead = JSON.stringify(where).includes("needsAttention");
            const isActivityBranch = where.meaningfulActivityAt != null;
            if (!isActivityBranch) return [];
            return isAttentionRead ? [unreadClaudeRow, readReadyRow] : readPageRows;
        });

        const route = await createSessionRouteTestBuilder("GET", "/v2/sessions");
        const { response } = await route.invoke({
            query: { includeAttention: true, limit: 1 },
        });

        expect(response).toEqual(expect.objectContaining({
            sessions: [
                expect.objectContaining({ id: "claude-unread" }),
                expect.objectContaining({ id: "page-a" }),
            ],
        }));

        const attentionCalls = sessionFindMany.mock.calls
            .map(([args]: any[]) => args)
            .filter((args: any) => JSON.stringify(args?.where ?? {}).includes("needsAttention"));
        expect(attentionCalls.length).toBeGreaterThan(0);
        for (const args of attentionCalls) {
            expect(args).toEqual(expect.objectContaining({
                where: expect.objectContaining({
                    archivedAt: null,
                    // Attention must be a single index seek on the materialized `needsAttention`
                    // fact. The predicate it replaces is a four-way disjunction over four different
                    // columns, which no engine can serve from an index, so it scanned every session
                    // of the account on every attention refresh.
                    needsAttention: true,
                }),
                // The family's budget, undiminished: none of the page's own rows needs attention, so
                // the read still asks for the whole cap (plus the branch's own has-next probe row).
                take: DEFAULT_V2_SESSION_LIST_INITIAL_ATTENTION_ROW_LIMIT + 1,
            }));
            // The read starts where the page ends, so the rows the page already carries are not
            // fetched a second time.
            expect(JSON.stringify(args.where)).toContain("page-b");
            // Anti-regression: keeping the raw arms beside the materialized column would satisfy the
            // matcher above while leaving the unservable disjunction on the hot path.
            expect(JSON.stringify(args.where)).not.toContain("pendingPermissionRequestCount");
            expect(JSON.stringify(args.where)).not.toContain("lastViewedSessionSeq");
        }
    });


    it("merges the active-session family into the initial page when includeActive is set", async () => {
        const pageRow = pagedSessionRow("page-row", { meaningfulActivityAt: new Date(9_000) });
        // Live on a machine but far enough down the ordered list that the page itself misses it —
        // the exact row the separate `/v2/sessions/active` round trip existed to recover.
        const activeRow = pagedSessionRow("live-elsewhere", {
            meaningfulActivityAt: new Date(1),
            active: true,
            lastActiveAt: new Date(),
        });
        sessionPinFindMany.mockResolvedValue([]);
        sessionFindMany.mockImplementation(async (args: any) => {
            const where = args?.where ?? {};
            if (where.active === true) return [activeRow];
            return where.meaningfulActivityAt != null ? [pageRow] : [];
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
        }));

        const activeCalls = sessionFindMany.mock.calls
            .map(([args]: any[]) => args)
            .filter((args: any) => args?.where?.active === true);
        expect(activeCalls).toEqual([
            expect.objectContaining({
                where: expect.objectContaining({
                    archivedAt: null,
                    active: true,
                    lastActiveAt: { gt: expect.any(Date) },
                }),
                orderBy: [
                    { lastActiveAt: "desc" },
                    { id: "desc" },
                ],
                // Same symbol the standalone `/v2/sessions/active` endpoint is bounded by: one family,
                // one bound. The two readers previously took 500 and 150 for the same rows.
                take: V2_ACTIVE_SESSION_LIST_ROW_LIMIT,
            }),
        ]);
    });

    it("does not read the active family when includeActive is absent", async () => {
        sessionPinFindMany.mockResolvedValue([]);
        sessionFindMany.mockResolvedValue([]);

        const route = await createSessionRouteTestBuilder("GET", "/v2/sessions");
        await route.invoke({ query: { limit: 10 } });

        expect(
            sessionFindMany.mock.calls.filter(([args]: any[]) => args?.where?.active === true),
        ).toEqual([]);
    });

    it("exposes diagnostic route timing headers only when explicitly requested", async () => {
        sessionFindMany.mockResolvedValue([]);

        const route = await createSessionRouteTestBuilder("GET", "/v2/sessions");
        const { reply } = await route.invoke({
            query: { limit: 10 },
            headers: { "x-happier-session-list-timing": "1" },
        });

        expect(reply.headers.get("server-timing")).toMatch(
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

        expect(reply.headers.get("server-timing")).toMatch(
            /happier_v2_sessions_cursor;dur=[0-9]+(?:\.[0-9]+)?, happier_v2_sessions_query;dur=[0-9]+(?:\.[0-9]+)?, happier_v2_sessions_page;dur=[0-9]+(?:\.[0-9]+)?, happier_v2_sessions_total;dur=[0-9]+(?:\.[0-9]+)?/,
        );
    });
});
