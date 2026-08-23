import { beforeEach, describe, expect, it, vi } from "vitest";

import { createDbMocks, installDbModuleMock, installPrismaModuleMock } from "../testkit/dbMocks";
import { createInTxHarness } from "../testkit/txHarness";
import { createFakeSocket, getSocketHandler } from "../testkit/socketHarness";

vi.mock("@/app/share/accessControl", () => ({
    checkSessionAccess: vi.fn(async () => ({ accessLevel: "edit" })),
    requireAccessLevel: vi.fn(() => true),
}));

const emitUpdate = vi.fn();
const emitEphemeral = vi.fn();
const buildUpdateSessionUpdate = vi.fn((_sid: string, updSeq: number, updId: string) => ({
    id: updId,
    seq: updSeq,
    body: { t: "update-session" },
}));
const buildSessionActivityEphemeral = vi.fn(() => ({ t: "session-activity" }));

vi.mock("@/app/events/eventRouter", () => ({
    eventRouter: { emitUpdate, emitEphemeral },
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
const txSessionUpdate = vi.hoisted(() => vi.fn(async () => ({ id: "s1" })));
const markSessionInactive = vi.hoisted(() => vi.fn());
const { db, reset: resetDbMocks } = createDbMocks({
    session: ["findMany", "findUnique", "update"],
    sessionMessage: ["findMany"],
    accountPushToken: ["findMany"],
} as const);
const sessionFindMany = db.session.findMany;
const directSessionFindUnique = db.session.findUnique;
const directSessionUpdate = db.session.update;
const sessionMessageFindMany = db.sessionMessage.findMany;
const accountPushTokenFindMany = db.accountPushToken.findMany;
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
            latestTurnId: null,
            lastViewedSessionSeq: 2,
            pendingCount: 0,
            pendingPermissionRequestCount: 0,
            pendingUserActionRequestCount: 0,
            latestTurnStatus: null,
            latestTurnStatusObservedAt: null,
            lastRuntimeIssue: null,
            meaningfulActivityAt: null,
            active: true,
            lastActiveAt: new Date(500),
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
        markSessionInactive,
    },
}));

installPrismaModuleMock(() => ({
    isPrismaErrorCode: () => false,
}));

installDbModuleMock(() => ({
    db,
}));

/**
 * `mark-unread` resolves the newest unread-affecting main-transcript message before it decides where
 * to put the cursor, so both the direct database reader and transaction harness must expose
 * `sessionMessage`.
 */
const txSessionMessageFindMany = vi.hoisted(() => vi.fn(async (): Promise<unknown[]> => []));

vi.mock("@/storage/inTx", () => {
    const { inTx, afterTx } = createInTxHarness(() => ({
            session: {
                findUnique: sessionFindUnique,
                updateMany: sessionUpdateMany,
                update: txSessionUpdate,
            },
            sessionMessage: {
                findMany: txSessionMessageFindMany,
            },
    }));

    return { afterTx, inTx };
});

describe("sessionUpdateHandler (session state AccountChange integration)", () => {
    beforeEach(() => {
        sendPushNotificationsAsyncSpy.mockClear();
        emitUpdate.mockClear();
        emitEphemeral.mockClear();
        buildUpdateSessionUpdate.mockClear();
        buildSessionActivityEphemeral.mockClear();
        markAccountChanged.mockClear();
        markSessionInactive.mockClear();
        sessionUpdateMany.mockClear();
        txSessionMessageFindMany.mockClear();
        txSessionMessageFindMany.mockResolvedValue([]);
        txSessionUpdate.mockClear();
        txSessionUpdate.mockResolvedValue({ id: "s1" });
        resetDbMocks();
        sessionFindMany.mockResolvedValue([]);
        directSessionFindUnique.mockResolvedValue(null);
        directSessionUpdate.mockResolvedValue({ id: "s1" });
        sessionMessageFindMany.mockResolvedValue([]);
        accountPushTokenFindMany.mockResolvedValue([]);
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

        // The badge refresh is debounced (`SESSION_PARTICIPANT_BADGE_REFRESH_DEBOUNCE_MS`), so it is
        // scheduled rather than sent by the time the handler resolves. Reading the spy immediately
        // could only ever observe zero calls, which is how this expectation stopped running at all.
        await vi.waitFor(() => expect(sendPushNotificationsAsyncSpy).toHaveBeenCalled(), {
            timeout: 10_000,
            interval: 25,
        });

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
            pendingRequestObservedAt: expect.any(Number),
        });
        expect(buildUpdateSessionUpdate).toHaveBeenNthCalledWith(2, "s1", 202, "upd-d", undefined, { value: "a2", version: 2 }, {
            pendingPermissionRequestCount: 2,
            pendingUserActionRequestCount: 1,
            pendingRequestObservedAt: expect.any(Number),
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
            where: { id: "s1", OR: [{ lastViewedSessionSeq: { lt: 7 } }, { lastViewedSessionSeq: null }] },
            // Catching the cursor up clears the unread edge instant in the same statement. The
            // attention flag needs no write: it is generated from the very cursor being moved.
            data: { lastViewedSessionSeq: 7, unreadSince: null },
        }));
        expect(buildUpdateSessionUpdate).toHaveBeenNthCalledWith(1, "s1", 201, "upd-g", undefined, undefined, {
            lastViewedSessionSeq: 7,
        });
        expect(buildUpdateSessionUpdate).toHaveBeenNthCalledWith(2, "s1", 202, "upd-h", undefined, undefined, {
            lastViewedSessionSeq: 7,
        });
        expect(callback).toHaveBeenCalledWith({ result: "success", lastViewedSessionSeq: 7 });
    });

    it("marks a session unread through the read-cursor operation payload", async () => {
        sessionFindUnique.mockImplementation(async (args: any) => {
            if (args?.select?.accountId === true) {
                return { accountId: "owner", shares: [{ sharedWithUserId: "u2" }] };
            }
            if (args?.select?.seq === true) {
                return {
                    seq: 7,
                    latestTurnId: null,
                    lastViewedSessionSeq: 7,
                    pendingCount: 0,
                    pendingPermissionRequestCount: 0,
                    pendingUserActionRequestCount: 0,
                    latestTurnStatus: null,
                    latestTurnStatusObservedAt: null,
                    lastRuntimeIssue: null,
                    meaningfulActivityAt: null,
                    active: true,
                    lastActiveAt: new Date(500),
                    archivedAt: null,
                };
            }
            return null;
        });

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
        await handler({ sid: "s1", operation: "mark-unread" }, callback);

        expect(sessionUpdateMany).toHaveBeenCalledWith(expect.objectContaining({
            where: { id: "s1", lastViewedSessionSeq: { gt: 6 } },
            // Marking unread stamps the read -> unread edge instant in the same statement. The
            // attention flag needs no write: it is generated from the very cursor being moved.
            data: { lastViewedSessionSeq: 6, unreadSince: expect.any(Date) },
        }));
        expect(buildUpdateSessionUpdate).toHaveBeenNthCalledWith(1, "s1", 201, "upd-g", undefined, undefined, {
            lastViewedSessionSeq: 6,
        });
        expect(buildUpdateSessionUpdate).toHaveBeenNthCalledWith(2, "s1", 202, "upd-h", undefined, undefined, {
            lastViewedSessionSeq: 6,
        });
        expect(callback).toHaveBeenCalledWith({
            result: "success",
            lastViewedSessionSeq: 6,
            didChange: true,
            readState: "unread",
        });
    });

    it("marks a session read through the read-cursor operation payload", async () => {
        sessionFindUnique.mockImplementation(async (args: any) => {
            if (args?.select?.accountId === true) {
                return { accountId: "owner", shares: [{ sharedWithUserId: "u2" }] };
            }
            if (args?.select?.seq === true) {
                return {
                    seq: 7,
                    latestTurnId: null,
                    lastViewedSessionSeq: 2,
                    pendingCount: 0,
                    pendingPermissionRequestCount: 0,
                    pendingUserActionRequestCount: 0,
                    latestTurnStatus: null,
                    latestTurnStatusObservedAt: null,
                    lastRuntimeIssue: null,
                    meaningfulActivityAt: null,
                    active: true,
                    lastActiveAt: new Date(500),
                    archivedAt: null,
                };
            }
            return null;
        });
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
        await handler({ sid: "s1", operation: "mark-read" }, callback);

        expect(sessionUpdateMany).toHaveBeenCalledWith(expect.objectContaining({
            where: { id: "s1", OR: [{ lastViewedSessionSeq: { lt: 7 } }, { lastViewedSessionSeq: null }] },
            // Catching the cursor up clears the unread edge instant in the same statement. The
            // attention flag needs no write: it is generated from the very cursor being moved.
            data: { lastViewedSessionSeq: 7, unreadSince: null },
        }));
        expect(callback).toHaveBeenCalledWith({
            result: "success",
            lastViewedSessionSeq: 7,
            didChange: true,
            readState: "read",
        });
    });

    it("uses operation precedence when a read-cursor payload also includes a cursor", async () => {
        sessionFindUnique.mockImplementation(async (args: any) => {
            if (args?.select?.accountId === true) {
                return { accountId: "owner", shares: [{ sharedWithUserId: "u2" }] };
            }
            if (args?.select?.seq === true) {
                return {
                    seq: 7,
                    latestTurnId: null,
                    lastViewedSessionSeq: 7,
                    pendingCount: 0,
                    pendingPermissionRequestCount: 0,
                    pendingUserActionRequestCount: 0,
                    latestTurnStatus: null,
                    latestTurnStatusObservedAt: null,
                    lastRuntimeIssue: null,
                    meaningfulActivityAt: null,
                    active: true,
                    lastActiveAt: new Date(500),
                    archivedAt: null,
                };
            }
            return null;
        });
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
        await handler({ sid: "s1", operation: "mark-unread", lastViewedSessionSeq: 99 }, callback);

        expect(sessionUpdateMany).toHaveBeenCalledWith(expect.objectContaining({
            where: { id: "s1", lastViewedSessionSeq: { gt: 6 } },
            // Marking unread stamps the read -> unread edge instant in the same statement. The
            // attention flag needs no write: it is generated from the very cursor being moved.
            data: { lastViewedSessionSeq: 6, unreadSince: expect.any(Date) },
        }));
        expect(callback).toHaveBeenCalledWith({
            result: "success",
            lastViewedSessionSeq: 6,
            didChange: true,
            readState: "unread",
        });
    });

    it("rejects a read-cursor payload with neither operation nor cursor", async () => {
        const { sessionUpdateHandler } = await import("./sessionUpdateHandler");

        const socket = createFakeSocket();
        sessionUpdateHandler(
            "owner",
            socket as any,
            { connectionType: "session-scoped", socket: socket as any, userId: "owner", sessionId: "s1" } as any,
        );

        const handler = getSocketHandler(socket, "update-read-cursor");

        const callback = vi.fn();
        await handler({ sid: "s1" }, callback);

        expect(sessionUpdateMany).not.toHaveBeenCalled();
        expect(callback).toHaveBeenCalledWith({ result: "error" });
    });

    it("rejects an unknown read-cursor operation without falling back to cursor advance", async () => {
        const { sessionUpdateHandler } = await import("./sessionUpdateHandler");

        const socket = createFakeSocket();
        sessionUpdateHandler(
            "owner",
            socket as any,
            { connectionType: "session-scoped", socket: socket as any, userId: "owner", sessionId: "s1" } as any,
        );

        const handler = getSocketHandler(socket, "update-read-cursor");

        const callback = vi.fn();
        await handler({ sid: "s1", operation: "mark-archived", lastViewedSessionSeq: 9 }, callback);

        expect(sessionUpdateMany).not.toHaveBeenCalled();
        expect(callback).toHaveBeenCalledWith({ result: "error" });
    });

});
