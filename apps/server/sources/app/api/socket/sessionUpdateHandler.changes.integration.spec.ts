import { beforeEach, describe, expect, it, vi } from "vitest";

import { createDbMocks, installDbModuleMock, installPrismaModuleMock } from "../testkit/dbMocks";
import { createFakeSocket, getSocketHandler } from "../testkit/socketHarness";

vi.mock("@/app/share/accessControl", () => ({
    checkSessionAccess: vi.fn(async () => ({ accessLevel: "edit" })),
    requireAccessLevel: vi.fn(() => true),
}));

const emitUpdate = vi.fn();
const buildNewMessageUpdate = vi.fn((_created: any, _sid: string, updSeq: number, updId: string) => ({
    id: updId,
    seq: updSeq,
    body: { t: "new-message" },
}));
const buildMessageUpdatedUpdate = vi.fn((_created: any, _sid: string, updSeq: number, updId: string) => ({
    id: updId,
    seq: updSeq,
    body: { t: "message-updated" },
}));

vi.mock("@/app/events/eventRouter", () => ({
    eventRouter: { emitUpdate },
    buildNewMessageUpdate,
    buildMessageUpdatedUpdate,
    buildSessionActivityEphemeral: vi.fn(() => ({ t: "session-activity" })),
    buildUpdateSessionUpdate: vi.fn(() => ({ t: "update-session" })),
}));

let keyCounter = 0;

const randomKeyNaked = vi.fn()
    .mockImplementation(() => `upd-${++keyCounter}`);

vi.mock("@/utils/keys/randomKeyNaked", () => ({ randomKeyNaked }));

const markAccountChanged = vi.fn(async (_tx: any, params: any) => {
    if (params.accountId === "owner") return 101;
    if (params.accountId === "u2") return 102;
    return 999;
});

vi.mock("@/app/changes/markAccountChanged", () => ({ markAccountChanged }));

const socketMessageAckInc = vi.fn();

vi.mock("@/app/monitoring/metrics2", () => ({
    sessionAliveEventsCounter: { inc: vi.fn() },
    websocketEventsCounter: { inc: vi.fn() },
    socketMessageAckCounter: { inc: socketMessageAckInc },
}));

vi.mock("@/utils/logging/log", () => ({ log: vi.fn() }));

vi.mock("@/app/presence/sessionCache", () => ({
    activityCache: {
        isSessionValid: vi.fn(async () => true),
        queueSessionUpdate: vi.fn(),
    },
}));

vi.mock("@/app/activity/refreshAccountActivityBadgePushes", () => ({
    refreshSessionParticipantBadgePushes: vi.fn(async () => {}),
}));

installPrismaModuleMock(() => ({
    isPrismaErrorCode: () => false,
}));

const { db, reset: resetDbMocks } = createDbMocks({
    sessionMessage: ["findFirst"],
} as const);
const txDbMocks = createDbMocks({
    session: ["findUnique", "update"],
    sessionMessage: ["findUnique", "findFirst", "create", "update"],
} as const);

installDbModuleMock(() => ({
    db,
}));

type TestSessionMessageContent =
    | { t: "encrypted"; c: string }
    | { t: "plain"; v: unknown };

type TestSessionMessageRow = Readonly<{
    id: string;
    seq: number;
    localId: string | null;
    sidechainId: string | null;
    content: TestSessionMessageContent;
    createdAt: Date;
    updatedAt: Date;
}>;

vi.mock("@/storage/inTx", () => {
    const afterTx = (tx: any, callback: () => void) => {
        tx.__afterTxCallbacks.push(callback);
    };

    const inTx = async <T>(fn: (tx: any) => Promise<T>): Promise<T> => {
        const tx: any = {
            __afterTxCallbacks: [] as Array<() => void | Promise<void>>,
            session: txDbMocks.db.session,
            sessionMessage: txDbMocks.db.sessionMessage,
        };

        const result = await fn(tx);
        for (const cb of tx.__afterTxCallbacks) {
            await cb();
        }
        return result;
    };

    return { afterTx, inTx };
});

describe("sessionUpdateHandler (AccountChange integration)", () => {
    beforeEach(() => {
        keyCounter = 0;
        emitUpdate.mockClear();
        buildNewMessageUpdate.mockClear();
        buildMessageUpdatedUpdate.mockClear();
        randomKeyNaked.mockClear();
        markAccountChanged.mockClear();
        socketMessageAckInc.mockClear();
        resetDbMocks();
        txDbMocks.reset();

        txDbMocks.db.session.findUnique.mockImplementation(async (args: any) => {
            if (args?.select?.id === true) {
                return { id: "s1" };
            }
            return {
                accountId: "owner",
                shares: [{ sharedWithUserId: "u2" }],
            };
        });
        txDbMocks.db.session.update.mockResolvedValue({ seq: 55 });
        txDbMocks.db.sessionMessage.findFirst.mockResolvedValue(null);
        txDbMocks.db.sessionMessage.findUnique.mockResolvedValue(null);
        txDbMocks.db.sessionMessage.create.mockResolvedValue({
            id: "m1",
            seq: 55,
            localId: "l1",
            sidechainId: null,
            content: { t: "encrypted", c: "enc" },
            createdAt: new Date(1),
            updatedAt: new Date(1),
        });
        txDbMocks.db.sessionMessage.update.mockResolvedValue({
            id: "m1",
            seq: 55,
            localId: "l1",
            sidechainId: null,
            content: { t: "encrypted", c: "enc" },
            createdAt: new Date(1),
            updatedAt: new Date(1),
        });
    });

    it("marks a session change for all participants and emits updates using the returned cursors", async () => {
        const { sessionUpdateHandler } = await import("./sessionUpdateHandler");

        const socket = createFakeSocket();
        sessionUpdateHandler(
            "owner",
            socket as any,
            { connectionType: "session-scoped", socket: socket as any, userId: "owner", sessionId: "s1" } as any,
        );

        const handler = getSocketHandler(socket, "message");

        const callback = vi.fn();
        await handler({ sid: "s1", message: "enc", localId: "l1" }, callback);

        expect(markAccountChanged).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({
                accountId: "owner",
                kind: "session",
                entityId: "s1",
                hint: { lastMessageSeq: 55, lastMessageId: "m1" },
            }),
        );
        expect(markAccountChanged).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({
                accountId: "u2",
                kind: "session",
                entityId: "s1",
                hint: { lastMessageSeq: 55, lastMessageId: "m1" },
            }),
        );

        expect(buildNewMessageUpdate).toHaveBeenNthCalledWith(1, expect.anything(), "s1", 101, "upd-1");
        expect(buildNewMessageUpdate).toHaveBeenNthCalledWith(2, expect.anything(), "s1", 102, "upd-2");

        expect(emitUpdate).toHaveBeenCalledTimes(2);
        expect(socketMessageAckInc).toHaveBeenCalledWith({ result: "ok", error: "none" });
        expect(callback).toHaveBeenCalledWith({ ok: true, id: "m1", seq: 55, localId: "l1", didWrite: true });
    });

    it("emits message-updated when upserting an existing message row", async () => {
        const { sessionUpdateHandler } = await import("./sessionUpdateHandler");

        txDbMocks.db.sessionMessage.findUnique.mockResolvedValue({
            id: "m1",
            seq: 55,
            localId: "l1",
            sidechainId: null,
            content: { t: "encrypted", c: "prev" },
            createdAt: new Date(1),
            updatedAt: new Date(1),
        });
        txDbMocks.db.sessionMessage.update.mockResolvedValue({
            id: "m1",
            seq: 55,
            localId: "l1",
            sidechainId: null,
            content: { t: "encrypted", c: "next" },
            createdAt: new Date(1),
            updatedAt: new Date(2),
        });

        const socket = createFakeSocket();
        sessionUpdateHandler(
            "owner",
            socket as any,
            { connectionType: "session-scoped", socket: socket as any, userId: "owner", sessionId: "s1" } as any,
        );

        const handler = getSocketHandler(socket, "message");

        const callback = vi.fn();
        await handler({ sid: "s1", message: "next", localId: "l1" }, callback);

        expect(buildNewMessageUpdate).not.toHaveBeenCalled();
        expect(buildMessageUpdatedUpdate).toHaveBeenNthCalledWith(1, expect.anything(), "s1", 101, "upd-1");
        expect(buildMessageUpdatedUpdate).toHaveBeenNthCalledWith(2, expect.anything(), "s1", 102, "upd-2");
        expect(emitUpdate).toHaveBeenCalledTimes(2);
        expect(callback).toHaveBeenCalledWith({ ok: true, id: "m1", seq: 55, localId: "l1", didWrite: false, didUpdate: true });
    });

    it("forwards sidechainId to session message writes", async () => {
        const { sessionUpdateHandler } = await import("./sessionUpdateHandler");

        txDbMocks.db.sessionMessage.create.mockResolvedValueOnce({
            id: "m1",
            seq: 55,
            localId: "l1",
            sidechainId: "sc-1",
            content: { t: "encrypted", c: "enc" },
            createdAt: new Date(1),
            updatedAt: new Date(1),
        });

        const socket = createFakeSocket();
        sessionUpdateHandler(
            "owner",
            socket as any,
            { connectionType: "session-scoped", socket: socket as any, userId: "owner", sessionId: "s1" } as any,
        );

        const handler = getSocketHandler(socket, "message");

        await handler({ sid: "s1", message: "enc", localId: "l1", sidechainId: "sc-1" });

        expect(txDbMocks.db.sessionMessage.create).toHaveBeenCalledWith(
            expect.objectContaining({
                data: expect.objectContaining({ sidechainId: "sc-1" }),
            }),
        );
    });

    it("does not skip sender connection when echoToSender is requested (opt-in)", async () => {
        const { sessionUpdateHandler } = await import("./sessionUpdateHandler");

        const socket = createFakeSocket();
        const connection = { connectionType: "session-scoped", socket: socket as any, userId: "owner", sessionId: "s1" } as any;
        sessionUpdateHandler("owner", socket as any, connection);

        const handler = getSocketHandler(socket, "message");

        await handler({ sid: "s1", message: "enc", localId: "l1", echoToSender: true });

        const ownerCall = emitUpdate.mock.calls
            .map((c) => c[0])
            .find((payload) => payload?.userId === "owner");
        expect(ownerCall).toBeTruthy();
        expect(ownerCall.skipSenderConnection).toBeUndefined();
    });

    it("does not require a callback for socket message ACK (old clients)", async () => {
        const { sessionUpdateHandler } = await import("./sessionUpdateHandler");

        const socket = createFakeSocket();
        sessionUpdateHandler(
            "owner",
            socket as any,
            { connectionType: "session-scoped", socket: socket as any, userId: "owner", sessionId: "s1" } as any,
        );

        const handler = getSocketHandler(socket, "message");

        await handler({ sid: "s1", message: "enc", localId: "l1" });

        expect(socketMessageAckInc).toHaveBeenCalledWith({ result: "ok", error: "none" });
        expect(emitUpdate).toHaveBeenCalledTimes(2);
    });
});
