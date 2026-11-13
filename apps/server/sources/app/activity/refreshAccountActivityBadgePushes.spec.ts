import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createDbMocks, createDbTransactionMock, inTxPostgresControlStatementMock, installDbModuleMock } from "../api/testkit/dbMocks";

const dbSessionFindMany = vi.hoisted(() => vi.fn());
const dbAccountPushTokenFindMany = vi.hoisted(() => vi.fn());
const dbAccountPushTokenDeleteMany = vi.hoisted(() => vi.fn());
const sendPushNotificationsAsyncSpy = vi.hoisted(() => vi.fn(async (messages: unknown[]) => messages.map(() => ({ status: "ok" }))));
const getPushNotificationReceiptsAsyncSpy = vi.hoisted(() => vi.fn(async (_ids: string[]) => ({})));

// Badge counting now resolves personal attention through the canonical viewer
// owners (owner-or-active-Follow tracking plus Discussion attention), so the
// delegates those owners read must exist here or the migrated path is never
// exercised: `accountSessionFollow` and `discussionReadState` are the
// Lane 09B/09C tables, `discussion.groupBy` the latest-activity read,
// and `teamMembership` the collective-access snapshot the badge admission
// resolves for each Account through the canonical access owner.
const dbMocks = createDbMocks({
    account: ["findMany", "findUnique"],
    sessionGrant: ["findMany"],
    session: ["findMany"],
    discussion: ["findMany", "groupBy"],
    discussionMessage: ["findMany"],
    discussionReadState: ["findMany"],
    accountSessionFollow: ["findMany"],
    accountPushToken: ["findMany", "deleteMany"],
    teamMembership: ["findMany"],
} as const);

const transactionMock = createDbTransactionMock(() => ({ ...dbMocks.db, ...inTxPostgresControlStatementMock }));

dbMocks.db.session.findMany.mockImplementation(async (...args: unknown[]) => {
    const rows = await dbSessionFindMany(...args) as Array<Record<string, unknown>>;
    return rows.map((row) => {
        const accountId = String(row.accountId);
        const cursor = typeof row.lastViewedSessionSeq === "number" ? row.lastViewedSessionSeq : 0;
        return {
            primaryTeamId: null,
            account: { status: "active" },
            grants: [],
            
            
            messages: [],
            accountReadStates: [{ accountId, lastViewedSessionSeq: cursor, unreadSince: null }],
            accountFollows: [],
            sessionPins: [],
            sessionAttentionStandings: [],
            dataKeyEnvelopes: [],
            responsibleAccountId: null,
            encryptionMode: "plain",
            pendingBlockedCount: 0,
            latestReadyEventSeq: null,
            latestTurnStatus: null,
            lastRuntimeIssue: null,
            ...row,
        };
    });
});
dbMocks.db.accountPushToken.findMany.mockImplementation((...args: unknown[]) => dbAccountPushTokenFindMany(...args));
dbMocks.db.accountPushToken.deleteMany.mockImplementation((...args: unknown[]) => dbAccountPushTokenDeleteMany(...args));

installDbModuleMock({
    db: transactionMock.wrapDb(dbMocks.db),
    getActivePrismaRuntime: () => ({ DbNull: Object.freeze({}) }),
});

vi.mock("@/utils/logging/log", () => ({
    log: vi.fn(),
}));

vi.mock("expo-server-sdk", () => {
    class Expo {
        static isExpoPushToken() {
            return true;
        }

        chunkPushNotifications(messages: unknown[]) {
            return [messages];
        }

        async sendPushNotificationsAsync(chunk: unknown[]) {
            return await sendPushNotificationsAsyncSpy(chunk);
        }

        async getPushNotificationReceiptsAsync(ids: string[]) {
            return await getPushNotificationReceiptsAsyncSpy(ids);
        }
    }

    return {
        __esModule: true,
        Expo,
    };
});

describe("refreshAccountActivityBadgePushes", () => {
    beforeEach(() => {
        // This Prisma boundary fixture models the PostgreSQL transaction port.
        vi.stubEnv("HAPPIER_DB_PROVIDER", "postgres");
        vi.useRealTimers();
        dbSessionFindMany.mockReset();
        dbAccountPushTokenFindMany.mockReset();
        dbAccountPushTokenDeleteMany.mockReset();
        sendPushNotificationsAsyncSpy.mockClear();
        getPushNotificationReceiptsAsyncSpy.mockClear();
        dbMocks.db.account.findMany.mockReset();
        dbMocks.db.account.findUnique.mockReset();
        dbMocks.db.account.findUnique.mockResolvedValue({ status: "active" });
        dbMocks.db.sessionGrant.findMany.mockReset();
        dbMocks.db.sessionGrant.findMany.mockResolvedValue([]);
        dbMocks.db.discussion.findMany.mockReset();
        dbMocks.db.discussion.groupBy.mockReset();
        dbMocks.db.discussionMessage.findMany.mockReset();
        dbMocks.db.discussionReadState.findMany.mockReset();
        dbMocks.db.accountSessionFollow.findMany.mockReset();
        dbMocks.db.teamMembership.findMany.mockReset();
        dbMocks.db.teamMembership.findMany.mockResolvedValue([]);
        dbMocks.db.account.findMany.mockResolvedValue([{ id: "a1" }, { id: "a2" }]);
        dbMocks.db.discussion.findMany.mockResolvedValue([]);
        dbMocks.db.discussion.groupBy.mockResolvedValue([]);
        dbMocks.db.discussionMessage.findMany.mockResolvedValue([]);
        dbMocks.db.discussionReadState.findMany.mockResolvedValue([]);
        // No Follow rows by default: an Account is tracked only where it owns the
        // Session, which is exactly the quiet-by-default relation under test.
        dbMocks.db.accountSessionFollow.findMany.mockResolvedValue([]);
    });

    afterEach(async () => {
        vi.unstubAllEnvs();
        vi.useRealTimers();
        (await import("./refreshAccountActivityBadgePushes")).resetAccountActivityBadgeDeliveryMemoryForTests();
    });

    it("sends a badge-only Expo push with the authoritative badge count for each requested account", async () => {
        dbSessionFindMany.mockResolvedValue([
            {
                accountId: "a1",
                id: "s-a1",
                currentStorageState: "hosted",
                acceptedThroughServerSeq: null,
                materializationPublicationId: null,
                materializedThroughSourceAt: null,
                publishedThroughServerSeq: null,
                seq: 5,
                pendingCount: 0,
                lastViewedSessionSeq: 1,
                pendingPermissionRequestCount: 0,
                pendingUserActionRequestCount: 0,
                active: true,
                archivedAt: null,
            },
            {
                accountId: "a2",
                id: "s-a2",
                currentStorageState: "hosted",
                acceptedThroughServerSeq: null,
                materializationPublicationId: null,
                materializedThroughSourceAt: null,
                publishedThroughServerSeq: null,
                seq: 3,
                pendingCount: 0,
                lastViewedSessionSeq: 3,
                pendingPermissionRequestCount: 0,
                pendingUserActionRequestCount: 0,
                active: true,
                archivedAt: null,
            },
        ]);
        dbAccountPushTokenFindMany.mockResolvedValue([
            { accountId: "a1", token: "ExponentPushToken[a1]" },
            { accountId: "a2", token: "ExponentPushToken[a2]" },
        ]);

        const { refreshAccountActivityBadgePushes } = await import("./refreshAccountActivityBadgePushes");
        await refreshAccountActivityBadgePushes({ accountIds: ["a1", "a2"] });

        const [chunk] = sendPushNotificationsAsyncSpy.mock.calls[0] ?? [];
        expect(Array.isArray(chunk)).toBe(true);
        expect(chunk).toEqual([
            expect.objectContaining({ to: "ExponentPushToken[a1]", badge: 1, data: { type: "badge_refresh" } }),
            expect.objectContaining({ to: "ExponentPushToken[a2]", badge: 0, data: { type: "badge_refresh" } }),
        ]);
        // Account coalescing must reach one set-based candidate scan. A scan
        // per Account recreates the badge N+1 on every burst. The remaining
        // Session reads belong to the shared tracked/access owners the count
        // composes, and are themselves set-oriented over the whole batch.
        const candidateScans = dbSessionFindMany.mock.calls.filter(
            ([query]) => (query as { orderBy?: { id?: unknown } } | undefined)?.orderBy?.id === "asc",
        );
        expect(candidateScans).toHaveLength(1);
        for (const [query] of dbSessionFindMany.mock.calls) {
            const scopedAccountId = (query as { where?: { accountId?: unknown } } | undefined)?.where?.accountId;
            expect(typeof scopedAccountId === "string").toBe(false);
        }
        // Whichever case runs first pays this file's module graph cost; it was
        // measured at ~28.5s on a loaded shared executor, so the 20s lane
        // default and a 30s budget both expire before the assertions run.
    }, 60_000);

    it("pushes a badge to a device only when its count differs from the last count Expo accepted for it", async () => {
        const session = (lastViewedSessionSeq: number) => ({
            accountId: "a1", id: "s-a1", currentStorageState: "hosted", acceptedThroughServerSeq: null,
            materializationPublicationId: null, materializedThroughSourceAt: null, publishedThroughServerSeq: null,
            seq: 5, pendingCount: 0, lastViewedSessionSeq, pendingPermissionRequestCount: 0,
            pendingUserActionRequestCount: 0, active: true, archivedAt: null,
        });
        dbAccountPushTokenFindMany.mockResolvedValue([
            { accountId: "a1", token: "ExponentPushToken[memo-a1-phone]" },
            { accountId: "a1", token: "ExponentPushToken[memo-a1-tablet]" },
        ]);
        const { refreshAccountActivityBadgePushes } = await import("./refreshAccountActivityBadgePushes");
        const sentMessages = () => sendPushNotificationsAsyncSpy.mock.calls.flatMap(([chunk]) => chunk as Array<{ to: string; badge: number }>);

        // Unread (1), then four read-cursor refreshes that keep it unread, then read (0), then read again.
        const workload = [1, 1, 1, 1, 1, 5, 5];
        for (const lastViewedSessionSeq of workload) {
            dbSessionFindMany.mockResolvedValue([session(lastViewedSessionSeq)]);
            await refreshAccountActivityBadgePushes({ accountIds: ["a1"] });
        }
        // 7 refreshes x 2 devices = 14 pushes before; only the two real count changes reach each device.
        expect(sentMessages().map((message) => `${message.to}:${message.badge}`)).toEqual([
            "ExponentPushToken[memo-a1-phone]:1", "ExponentPushToken[memo-a1-tablet]:1",
            "ExponentPushToken[memo-a1-phone]:0", "ExponentPushToken[memo-a1-tablet]:0",
        ]);

        // A count Expo did not accept is not remembered: the next refresh retries it.
        sendPushNotificationsAsyncSpy.mockClear();
        sendPushNotificationsAsyncSpy.mockImplementationOnce(async (chunk: unknown[]) => chunk.map(() => ({ status: "error", message: "unavailable" })));
        dbSessionFindMany.mockResolvedValue([session(1)]);
        await refreshAccountActivityBadgePushes({ accountIds: ["a1"] });
        await refreshAccountActivityBadgePushes({ accountIds: ["a1"] });
        expect(sentMessages().map((message) => message.badge)).toEqual([1, 1, 1, 1]);
    }, 60_000);

    it("does not publish badge attention for transcript rows above a partial import ceiling", async () => {
        dbSessionFindMany.mockResolvedValue([
            {
                accountId: "a1",
                id: "s-a1",
                seq: 9,
                currentStorageState: "server_partial",
                acceptedThroughServerSeq: 4,
                materializationPublicationId: null,
                materializedThroughSourceAt: null,
                publishedThroughServerSeq: null,
                pendingCount: 0,
                pendingBlockedCount: 0,
                lastViewedSessionSeq: 4,
                pendingPermissionRequestCount: 0,
                pendingUserActionRequestCount: 0,
                active: true,
                archivedAt: null,
            },
        ]);
        dbAccountPushTokenFindMany.mockResolvedValue([
            { accountId: "a1", token: "ExponentPushToken[a1]" },
        ]);

        const { refreshAccountActivityBadgePushes } = await import("./refreshAccountActivityBadgePushes");
        await refreshAccountActivityBadgePushes({ accountIds: ["a1"] });

        const [chunk] = sendPushNotificationsAsyncSpy.mock.calls.at(0) ?? [];
        expect(chunk).toEqual([
            expect.objectContaining({ to: "ExponentPushToken[a1]", badge: 0, data: { type: "badge_refresh" } }),
        ]);
    });

    it("counts never-viewed sessions with committed transcript activity as unread badge attention", async () => {
        dbSessionFindMany.mockResolvedValue([
            {
                accountId: "a1",
                id: "s-a1",
                currentStorageState: "hosted",
                acceptedThroughServerSeq: null,
                materializationPublicationId: null,
                materializedThroughSourceAt: null,
                publishedThroughServerSeq: null,
                seq: 2,
                pendingCount: 0,
                lastViewedSessionSeq: null,
                pendingPermissionRequestCount: 0,
                pendingUserActionRequestCount: 0,
                active: true,
                archivedAt: null,
            },
        ]);
        dbAccountPushTokenFindMany.mockResolvedValue([
            { accountId: "a1", token: "ExponentPushToken[a1]" },
        ]);

        const { refreshAccountActivityBadgePushes } = await import("./refreshAccountActivityBadgePushes");
        await refreshAccountActivityBadgePushes({ accountIds: ["a1"] });

        const [chunk] = sendPushNotificationsAsyncSpy.mock.calls.at(0) ?? [];
        expect(Array.isArray(chunk)).toBe(true);
        expect(chunk).toEqual([
            expect.objectContaining({ to: "ExponentPushToken[a1]", badge: 1, data: { type: "badge_refresh" } }),
        ]);
    });

    it("deletes tokens that Expo marks as DeviceNotRegistered", async () => {
        dbSessionFindMany.mockResolvedValue([
            {
                accountId: "a1",
                id: "s-a1",
                currentStorageState: "hosted",
                acceptedThroughServerSeq: null,
                materializationPublicationId: null,
                materializedThroughSourceAt: null,
                publishedThroughServerSeq: null,
                seq: 5,
                pendingCount: 0,
                lastViewedSessionSeq: 1,
                pendingPermissionRequestCount: 0,
                pendingUserActionRequestCount: 0,
                active: true,
                archivedAt: null,
            },
        ]);
        dbAccountPushTokenFindMany.mockResolvedValue([
            { accountId: "a1", token: "ExponentPushToken[a1]" },
        ]);
        const deviceNotRegisteredTickets: Array<{ status: string; details?: { error?: string } }> = [
            {
                status: "error",
                details: { error: "DeviceNotRegistered" },
            },
        ];
        sendPushNotificationsAsyncSpy.mockResolvedValueOnce(deviceNotRegisteredTickets);

        const { refreshAccountActivityBadgePushes } = await import("./refreshAccountActivityBadgePushes");
        await refreshAccountActivityBadgePushes({ accountIds: ["a1"] });

        expect(dbAccountPushTokenDeleteMany).toHaveBeenCalledWith({
            where: {
                OR: [{ accountId: "a1", token: "ExponentPushToken[a1]" }],
            },
        });
    });

    it("does not fetch Expo receipts immediately after sending badge refresh pushes", async () => {
        dbSessionFindMany.mockResolvedValue([
            {
                accountId: "a1",
                id: "s-a1",
                currentStorageState: "hosted",
                acceptedThroughServerSeq: null,
                materializationPublicationId: null,
                materializedThroughSourceAt: null,
                publishedThroughServerSeq: null,
                seq: 5,
                pendingCount: 0,
                lastViewedSessionSeq: 1,
                pendingPermissionRequestCount: 0,
                pendingUserActionRequestCount: 0,
                active: true,
                archivedAt: null,
            },
        ]);
        dbAccountPushTokenFindMany.mockResolvedValue([
            { accountId: "a1", token: "ExponentPushToken[a1]" },
        ]);
        sendPushNotificationsAsyncSpy.mockResolvedValueOnce([{ status: "ok", id: "ticket-1" }] as unknown as Array<{ status: string }>);

        const { refreshAccountActivityBadgePushes } = await import("./refreshAccountActivityBadgePushes");
        await refreshAccountActivityBadgePushes({ accountIds: ["a1"] });

        expect(sendPushNotificationsAsyncSpy).toHaveBeenCalledTimes(1);
        expect(getPushNotificationReceiptsAsyncSpy).not.toHaveBeenCalled();
    });

    it("coalesces session participant badge refresh requests out of band", async () => {
        vi.useFakeTimers();
        dbSessionFindMany.mockResolvedValue([
            {
                accountId: "a1",
                id: "s-a1",
                currentStorageState: "hosted",
                acceptedThroughServerSeq: null,
                materializationPublicationId: null,
                materializedThroughSourceAt: null,
                publishedThroughServerSeq: null,
                seq: 5,
                pendingCount: 0,
                lastViewedSessionSeq: 1,
                pendingPermissionRequestCount: 0,
                pendingUserActionRequestCount: 0,
                active: true,
                archivedAt: null,
            },
            {
                accountId: "a2",
                id: "s-a2",
                currentStorageState: "hosted",
                acceptedThroughServerSeq: null,
                materializationPublicationId: null,
                materializedThroughSourceAt: null,
                publishedThroughServerSeq: null,
                seq: 5,
                pendingCount: 0,
                lastViewedSessionSeq: 1,
                pendingPermissionRequestCount: 0,
                pendingUserActionRequestCount: 0,
                active: true,
                archivedAt: null,
            },
        ]);
        dbAccountPushTokenFindMany.mockResolvedValue([
            { accountId: "a1", token: "ExponentPushToken[a1]" },
            { accountId: "a2", token: "ExponentPushToken[a2]" },
        ]);

        const { scheduleAccountActivityBadgeRefresh } = await import("./refreshAccountActivityBadgePushes");
        scheduleAccountActivityBadgeRefresh({
            badgeAttentionChanged: true,
            accountIds: ["a1"],
        });
        scheduleAccountActivityBadgeRefresh({
            badgeAttentionChanged: true,
            accountIds: ["a2", "a1"],
        });

        expect(sendPushNotificationsAsyncSpy).not.toHaveBeenCalled();

        await vi.advanceTimersByTimeAsync(1_000);

        expect(dbAccountPushTokenFindMany).toHaveBeenCalledTimes(1);
        expect(dbAccountPushTokenFindMany).toHaveBeenCalledWith({
            where: { accountId: { in: expect.arrayContaining(["a1", "a2"]) } },
            select: { accountId: true, token: true },
        });
        expect(sendPushNotificationsAsyncSpy).toHaveBeenCalledTimes(1);
    });

    it("publishes no badge traffic for ordinary messages while a real attention flip reaches Expo", async () => {
        vi.useFakeTimers();
        const { didSessionActivityBadgeSignalChange } = await import("./accountActivityBadge");
        const { scheduleAccountActivityBadgeRefresh } = await import("./refreshAccountActivityBadgePushes");
        const initial = {
            currentStorageState: "hosted" as const, acceptedThroughServerSeq: null,
            materializationPublicationId: null, materializedThroughSourceAt: null, publishedThroughServerSeq: null,
            seq: 5, pendingBlockedCount: 0, archivedAt: null,
        };
        let before = initial;
        for (let seq = 6; seq <= 1005; seq += 1) {
            const after = { ...before, seq };
            scheduleAccountActivityBadgeRefresh({
                badgeAttentionChanged: didSessionActivityBadgeSignalChange(before, after), accountIds: ["a1"],
            });
            before = after;
        }
        await vi.runOnlyPendingTimersAsync();
        expect(dbAccountPushTokenFindMany).not.toHaveBeenCalled();
        expect(dbSessionFindMany).not.toHaveBeenCalled();
        expect(sendPushNotificationsAsyncSpy).not.toHaveBeenCalled();

        const blocked = { ...before, pendingBlockedCount: 1 };
        dbSessionFindMany.mockResolvedValue([{ ...blocked, id: "s-a1", accountId: "a1", lastViewedSessionSeq: 1005 }]);
        dbAccountPushTokenFindMany.mockResolvedValue([{ accountId: "a1", token: "ExponentPushToken[a1]" }]);
        scheduleAccountActivityBadgeRefresh({
            badgeAttentionChanged: didSessionActivityBadgeSignalChange(before, blocked), accountIds: ["a1"],
        });
        await vi.runOnlyPendingTimersAsync();
        expect(sendPushNotificationsAsyncSpy).toHaveBeenCalledTimes(1);
        expect(sendPushNotificationsAsyncSpy.mock.calls[0]?.[0]).toEqual([
            expect.objectContaining({ to: "ExponentPushToken[a1]", badge: 1 }),
        ]);
    });

    it("returns before computing badge counts when no push tokens exist", async () => {
        dbSessionFindMany.mockResolvedValue([
            {
                accountId: "a1",
                id: "s-a1",
                currentStorageState: "hosted",
                acceptedThroughServerSeq: null,
                materializationPublicationId: null,
                materializedThroughSourceAt: null,
                publishedThroughServerSeq: null,
                seq: 5,
                pendingCount: 0,
                lastViewedSessionSeq: 1,
                pendingPermissionRequestCount: 0,
                pendingUserActionRequestCount: 0,
                active: true,
                archivedAt: null,
            },
        ]);
        dbAccountPushTokenFindMany.mockResolvedValue([]);

        const { refreshAccountActivityBadgePushes } = await import("./refreshAccountActivityBadgePushes");
        await refreshAccountActivityBadgePushes({ accountIds: ["a1"] });

        expect(dbAccountPushTokenFindMany).toHaveBeenCalledWith({
            where: { accountId: { in: ["a1"] } },
            select: { accountId: true, token: true },
        });
        expect(dbSessionFindMany).not.toHaveBeenCalled();
        expect(sendPushNotificationsAsyncSpy).not.toHaveBeenCalled();
    });
});
