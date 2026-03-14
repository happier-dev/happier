import { beforeEach, describe, expect, it, vi } from "vitest";
import { createInTxHarness } from "../testkit/txHarness";
import { createFakeSocket, getSocketHandler } from "../testkit/socketHarness";

vi.mock("@/app/share/accessControl", () => ({
    checkSessionAccess: vi.fn(async () => ({ accessLevel: "edit" })),
    requireAccessLevel: vi.fn(() => true),
}));

const emitUpdate = vi.fn();
const buildUpdateSessionUpdate = vi.fn((_sid: string, updSeq: number, updId: string) => ({
    id: updId,
    seq: updSeq,
    body: { t: "update-session" },
}));
const buildSessionActivityEphemeral = vi.fn(() => ({ t: "session-activity" }));

vi.mock("@/app/events/eventRouter", () => ({
    eventRouter: { emitUpdate },
    buildUpdateSessionUpdate,
    buildNewMessageUpdate: vi.fn(),
    buildSessionActivityEphemeral,
}));

const randomKeyNaked = vi.fn();
vi.mock("@/utils/keys/randomKeyNaked", () => ({ randomKeyNaked }));

const sendPushNotificationsAsyncSpy = vi.hoisted(() => vi.fn(async (messages: unknown[]) => messages.map(() => ({ status: "ok" }))));
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
    }

    return {
        __esModule: true,
        Expo,
    };
});

const sessionUpdateMany = vi.hoisted(() => vi.fn(async () => ({ count: 1 })));
const sessionFindMany = vi.hoisted(() => vi.fn(async (_args?: unknown) => [] as Array<Record<string, unknown>>));
const accountPushTokenFindMany = vi.hoisted(() => vi.fn(async (_args?: unknown) => [] as Array<Record<string, unknown>>));
const sessionFindUnique = vi.hoisted(() => vi.fn(async (args: any) => {
    if (args?.select?.metadataVersion === true) {
        return {
            metadataVersion: 1,
            metadata: "m1",
            lastViewedSessionSeq: 0,
            seq: 3,
            pendingCount: 0,
            pendingPermissionRequestCount: 0,
            pendingUserActionRequestCount: 0,
            active: true,
            archivedAt: null,
        };
    }
    if (args?.select?.agentStateVersion === true) {
        return {
            agentStateVersion: 1,
            agentState: "a1",
            seq: 7,
            lastViewedSessionSeq: 7,
            pendingCount: 0,
            pendingPermissionRequestCount: 0,
            pendingUserActionRequestCount: 0,
            active: true,
            archivedAt: null,
        };
    }
    if (args?.select?.accountId === true) {
        return { accountId: "owner", shares: [{ sharedWithUserId: "u2" }] };
    }
    if (args?.select?.seq === true) {
        return {
            seq: 7,
            lastViewedSessionSeq: 2,
            pendingCount: 0,
            pendingPermissionRequestCount: 0,
            pendingUserActionRequestCount: 0,
            active: true,
            archivedAt: null,
        };
    }
    return null;
}));

const markAccountChanged = vi.fn(async (_tx: any, params: any) => {
    if (params.accountId === "owner") return 201;
    if (params.accountId === "u2") return 202;
    return 999;
});
vi.mock("@/app/changes/markAccountChanged", () => ({ markAccountChanged }));

vi.mock("@/app/monitoring/metrics2", () => ({
    sessionAliveEventsCounter: { inc: vi.fn() },
    websocketEventsCounter: { inc: vi.fn() },
}));

vi.mock("@/utils/logging/log", () => ({ log: vi.fn() }));

vi.mock("@/app/presence/sessionCache", () => ({
    activityCache: {
        isSessionValid: vi.fn(async () => true),
        queueSessionUpdate: vi.fn(),
    },
}));

vi.mock("@/storage/prisma", () => ({
    isPrismaErrorCode: () => false,
}));

vi.mock("@/storage/db", () => ({
    db: {
        session: {
            findMany: (args: any) => sessionFindMany(args),
        },
        accountPushToken: {
            findMany: (args: any) => accountPushTokenFindMany(args),
        },
    },
}));

vi.mock("@/storage/inTx", () => {
    const { inTx, afterTx } = createInTxHarness(() => ({
            session: {
                findUnique: sessionFindUnique,
                updateMany: sessionUpdateMany,
            },
    }));

    return { afterTx, inTx };
});

describe("sessionUpdateHandler (session state AccountChange integration)", () => {
    beforeEach(() => {
        sendPushNotificationsAsyncSpy.mockClear();
        emitUpdate.mockClear();
        buildUpdateSessionUpdate.mockClear();
        buildSessionActivityEphemeral.mockClear();
        markAccountChanged.mockClear();
        sessionUpdateMany.mockClear();
        sessionFindMany.mockReset().mockResolvedValue([]);
        accountPushTokenFindMany.mockReset().mockResolvedValue([]);
    });

    it("sends a silent badge refresh push when a read-cursor change clears badge attention", async () => {
        sessionFindUnique.mockClear();
        sessionFindMany.mockResolvedValue([
            {
                accountId: "owner",
                seq: 7,
                pendingCount: 0,
                lastViewedSessionSeq: 7,
                pendingPermissionRequestCount: 0,
                pendingUserActionRequestCount: 0,
                active: true,
                archivedAt: null,
            },
        ]);
        accountPushTokenFindMany.mockResolvedValue([
            { accountId: "owner", token: "ExponentPushToken[owner]" },
        ]);

        randomKeyNaked.mockReset().mockReturnValueOnce("upd-g").mockReturnValueOnce("upd-h");
        const { sessionUpdateHandler } = await import("./sessionUpdateHandler");

        const socket = createFakeSocket();
        sessionUpdateHandler(
            "owner",
            socket as any,
            { connectionType: "session-scoped", socket: socket as any, userId: "owner", sessionId: "s1" } as any,
        );

        const handler = getSocketHandler(socket, "update-read-cursor");

        const callback = vi.fn();
        await handler({ sid: "s1", lastViewedSessionSeq: 9 }, callback);

        const [chunk] = sendPushNotificationsAsyncSpy.mock.calls[0] ?? [];
        expect(Array.isArray(chunk)).toBe(true);
        expect(chunk).toEqual([
            expect.objectContaining({
                to: "ExponentPushToken[owner]",
                badge: 0,
                data: { type: "badge_refresh" },
            }),
        ]);
    });

    it("marks session metadata updates for all participants and emits updates using those cursors", async () => {
        sessionFindUnique.mockClear();
        sessionUpdateMany.mockClear();
        randomKeyNaked.mockReset().mockReturnValueOnce("upd-a").mockReturnValueOnce("upd-b");
        const { sessionUpdateHandler } = await import("./sessionUpdateHandler");

        const socket = createFakeSocket();
        sessionUpdateHandler(
            "owner",
            socket as any,
            { connectionType: "session-scoped", socket: socket as any, userId: "owner", sessionId: "s1" } as any,
        );

        const handler = getSocketHandler(socket, "update-metadata");

        const callback = vi.fn();
        await handler({ sid: "s1", metadata: "m2", expectedVersion: 1 }, callback);

        expect(sessionUpdateMany).toHaveBeenCalledWith(expect.objectContaining({
            where: { id: "s1", metadataVersion: 1 },
            data: expect.objectContaining({ metadata: "m2", metadataVersion: 2 }),
        }));

        expect(markAccountChanged).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ accountId: "owner", kind: "session", entityId: "s1" }));
        expect(markAccountChanged).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ accountId: "u2", kind: "session", entityId: "s1" }));

        expect(buildUpdateSessionUpdate).toHaveBeenNthCalledWith(1, "s1", 201, "upd-a", { value: "m2", version: 2 }, undefined, undefined);
        expect(buildUpdateSessionUpdate).toHaveBeenNthCalledWith(2, "s1", 202, "upd-b", { value: "m2", version: 2 }, undefined, undefined);

        expect(emitUpdate).toHaveBeenCalledTimes(2);
        expect(callback).toHaveBeenCalledWith({ result: "success", version: 2, metadata: "m2" });
    });

    it("persists lastViewedSessionSeq when update-metadata includes readCursorHintV1", async () => {
        sessionFindUnique.mockClear();
        emitUpdate.mockClear();
        buildUpdateSessionUpdate.mockClear();
        markAccountChanged.mockClear();
        sessionUpdateMany.mockClear();

        randomKeyNaked.mockReset().mockReturnValueOnce("upd-e").mockReturnValueOnce("upd-f");
        const { sessionUpdateHandler } = await import("./sessionUpdateHandler");

        const socket = createFakeSocket();
        sessionUpdateHandler(
            "owner",
            socket as any,
            { connectionType: "session-scoped", socket: socket as any, userId: "owner", sessionId: "s1" } as any,
        );

        const handler = getSocketHandler(socket, "update-metadata");

        const callback = vi.fn();
        await handler(
            { sid: "s1", metadata: "m2", expectedVersion: 1, readCursorHintV1: { lastViewedSessionSeq: 2 } },
            callback,
        );

        expect(sessionUpdateMany).toHaveBeenCalledWith(expect.objectContaining({
            where: { id: "s1", metadataVersion: 1 },
            data: expect.objectContaining({ lastViewedSessionSeq: 2 }),
        }));
    });

    it("marks session agentState updates for all participants and emits updates using those cursors", async () => {
        sessionFindUnique.mockClear();
        emitUpdate.mockClear();
        buildUpdateSessionUpdate.mockClear();
        markAccountChanged.mockClear();
        sessionUpdateMany.mockClear();

        randomKeyNaked.mockReset().mockReturnValueOnce("upd-c").mockReturnValueOnce("upd-d");
        const { sessionUpdateHandler } = await import("./sessionUpdateHandler");

        const socket = createFakeSocket();
        sessionUpdateHandler(
            "owner",
            socket as any,
            { connectionType: "session-scoped", socket: socket as any, userId: "owner", sessionId: "s1" } as any,
        );

        const handler = getSocketHandler(socket, "update-state");

        const callback = vi.fn();
        await handler({
            sid: "s1",
            agentState: "a2",
            expectedVersion: 1,
            activitySummaryV1: {
                pendingPermissionRequestCount: 2,
                pendingUserActionRequestCount: 1,
            },
        }, callback);

        expect(sessionUpdateMany).toHaveBeenCalledWith(expect.objectContaining({
            where: { id: "s1", agentStateVersion: 1 },
            data: expect.objectContaining({
                agentState: "a2",
                agentStateVersion: 2,
                pendingPermissionRequestCount: 2,
                pendingUserActionRequestCount: 1,
            }),
        }));

        expect(markAccountChanged).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ accountId: "owner", kind: "session", entityId: "s1" }));
        expect(markAccountChanged).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ accountId: "u2", kind: "session", entityId: "s1" }));

        expect(buildUpdateSessionUpdate).toHaveBeenNthCalledWith(1, "s1", 201, "upd-c", undefined, { value: "a2", version: 2 }, {
            pendingPermissionRequestCount: 2,
            pendingUserActionRequestCount: 1,
        });
        expect(buildUpdateSessionUpdate).toHaveBeenNthCalledWith(2, "s1", 202, "upd-d", undefined, { value: "a2", version: 2 }, {
            pendingPermissionRequestCount: 2,
            pendingUserActionRequestCount: 1,
        });

        expect(emitUpdate).toHaveBeenCalledTimes(2);
        expect(callback).toHaveBeenCalledWith({ result: "success", version: 2, agentState: "a2" });
    });

    it("applies a dedicated monotonic read-cursor update and emits updates", async () => {
        sessionFindUnique.mockClear();
        emitUpdate.mockClear();
        buildUpdateSessionUpdate.mockClear();
        buildSessionActivityEphemeral.mockClear();
        markAccountChanged.mockClear();
        sessionUpdateMany.mockClear();

        randomKeyNaked.mockReset().mockReturnValueOnce("upd-g").mockReturnValueOnce("upd-h");
        const { sessionUpdateHandler } = await import("./sessionUpdateHandler");

        const socket = createFakeSocket();
        sessionUpdateHandler(
            "owner",
            socket as any,
            { connectionType: "session-scoped", socket: socket as any, userId: "owner", sessionId: "s1" } as any,
        );

        const handler = getSocketHandler(socket, "update-read-cursor");

        const callback = vi.fn();
        await handler({ sid: "s1", lastViewedSessionSeq: 9 }, callback);

        expect(sessionUpdateMany).toHaveBeenCalledWith(expect.objectContaining({
            where: { id: "s1", lastViewedSessionSeq: { lt: 7 } },
            data: { lastViewedSessionSeq: 7 },
        }));
        expect(buildUpdateSessionUpdate).toHaveBeenNthCalledWith(1, "s1", 201, "upd-g", undefined, undefined, {
            lastViewedSessionSeq: 7,
        });
        expect(buildUpdateSessionUpdate).toHaveBeenNthCalledWith(2, "s1", 202, "upd-h", undefined, undefined, {
            lastViewedSessionSeq: 7,
        });
        expect(callback).toHaveBeenCalledWith({ result: "success", lastViewedSessionSeq: 7 });
    });
});
