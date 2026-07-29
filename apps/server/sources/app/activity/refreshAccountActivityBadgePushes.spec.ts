import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createDbMocks, installDbModuleMock } from "../api/testkit/dbMocks";

const dbSessionFindMany = vi.hoisted(() => vi.fn());
const dbAccountPushTokenFindMany = vi.hoisted(() => vi.fn());
const dbAccountPushTokenDeleteMany = vi.hoisted(() => vi.fn());
const sendPushNotificationsAsyncSpy = vi.hoisted(() => vi.fn(async (messages: unknown[]) => messages.map(() => ({ status: "ok" }))));
const getPushNotificationReceiptsAsyncSpy = vi.hoisted(() => vi.fn(async (_ids: string[]) => ({})));

const dbMocks = createDbMocks({
    session: ["findMany"],
    accountPushToken: ["findMany", "deleteMany"],
} as const);

dbMocks.db.session.findMany.mockImplementation((...args: unknown[]) => dbSessionFindMany(...args));
dbMocks.db.accountPushToken.findMany.mockImplementation((...args: unknown[]) => dbAccountPushTokenFindMany(...args));
dbMocks.db.accountPushToken.deleteMany.mockImplementation((...args: unknown[]) => dbAccountPushTokenDeleteMany(...args));

installDbModuleMock({ db: dbMocks.db });

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
        vi.useRealTimers();
        dbSessionFindMany.mockReset();
        dbAccountPushTokenFindMany.mockReset();
        dbAccountPushTokenDeleteMany.mockReset();
        sendPushNotificationsAsyncSpy.mockClear();
        getPushNotificationReceiptsAsyncSpy.mockClear();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it("sends a badge-only Expo push with the authoritative badge count for each requested account", async () => {
        dbSessionFindMany.mockResolvedValue([
            {
                accountId: "a1",
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
    }, 30_000);

    it("does not publish badge attention for transcript rows above a partial import ceiling", async () => {
        dbSessionFindMany.mockResolvedValue([
            {
                accountId: "a1",
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

        const { refreshSessionParticipantBadgePushes } = await import("./refreshAccountActivityBadgePushes");
        await refreshSessionParticipantBadgePushes({
            badgeAttentionChanged: true,
            participantCursors: [{ accountId: "a1" }],
        });
        await refreshSessionParticipantBadgePushes({
            badgeAttentionChanged: true,
            participantCursors: [{ accountId: "a2" }, { accountId: "a1" }],
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

    it("returns before computing badge counts when no push tokens exist", async () => {
        dbSessionFindMany.mockResolvedValue([
            {
                accountId: "a1",
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
