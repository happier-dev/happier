import { beforeEach, describe, expect, it, vi } from "vitest";

const dbSessionFindMany = vi.hoisted(() => vi.fn());
const dbAccountPushTokenFindMany = vi.hoisted(() => vi.fn());
const dbAccountPushTokenDeleteMany = vi.hoisted(() => vi.fn());
const sendPushNotificationsAsyncSpy = vi.hoisted(() => vi.fn(async (messages: unknown[]) => messages.map(() => ({ status: "ok" }))));
const getPushNotificationReceiptsAsyncSpy = vi.hoisted(() => vi.fn(async (_ids: string[]) => ({})));

vi.mock("@/storage/db", () => ({
    db: {
        session: {
            findMany: (...args: unknown[]) => dbSessionFindMany(...args),
        },
        accountPushToken: {
            findMany: (...args: unknown[]) => dbAccountPushTokenFindMany(...args),
            deleteMany: (...args: unknown[]) => dbAccountPushTokenDeleteMany(...args),
        },
    },
}));

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
        dbSessionFindMany.mockReset();
        dbAccountPushTokenFindMany.mockReset();
        dbAccountPushTokenDeleteMany.mockReset();
        sendPushNotificationsAsyncSpy.mockClear();
        getPushNotificationReceiptsAsyncSpy.mockClear();
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
});
