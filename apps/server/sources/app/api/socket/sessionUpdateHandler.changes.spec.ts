import { beforeEach, describe, expect, it, vi } from "vitest";

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

vi.mock("@/app/events/eventRouter", () => ({
    eventRouter: { emitUpdate },
    buildNewMessageUpdate,
    buildSessionActivityEphemeral: vi.fn(() => ({ t: "session-activity" })),
    buildUpdateSessionUpdate: vi.fn(() => ({ t: "update-session" })),
}));

let keyCounter = 0;

const randomKeyNaked = vi.fn()
    .mockImplementation(() => `upd-${++keyCounter}`);

vi.mock("@/utils/randomKeyNaked", () => ({ randomKeyNaked }));

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

vi.mock("@/utils/log", () => ({ log: vi.fn() }));

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
        sessionMessage: {
            findFirst: vi.fn(),
        },
    },
}));

vi.mock("@/storage/inTx", () => {
    const afterTx = (tx: any, callback: () => void) => {
        tx.__afterTxCallbacks.push(callback);
    };

    const inTx = async <T>(fn: (tx: any) => Promise<T>): Promise<T> => {
        const tx: any = {
            __afterTxCallbacks: [] as Array<() => void | Promise<void>>,
            session: {
                findUnique: vi.fn(async (args: any) => {
                    if (args?.select?.id === true) {
                        return { id: "s1" };
                    }
                    return {
                        accountId: "owner",
                        shares: [{ sharedWithUserId: "u2" }],
                    };
                }),
                update: vi.fn(async () => ({ seq: 55 })),
            },
            sessionMessage: {
                findFirst: vi.fn(async () => null),
                create: vi.fn(async () => ({
                    id: "m1",
                    seq: 55,
                    localId: "l1",
                    content: { t: "encrypted", c: "enc" },
                    createdAt: new Date(1),
                    updatedAt: new Date(1),
                })),
            },
        };

        const result = await fn(tx);
        for (const cb of tx.__afterTxCallbacks) {
            await cb();
        }
        return result;
    };

    return { afterTx, inTx };
});

class FakeSocket {
    public id = "fake-socket";
    public handlers = new Map<string, any>();

    on(event: string, handler: any) {
        this.handlers.set(event, handler);
    }
}

describe("sessionUpdateHandler (AccountChange integration)", () => {
    beforeEach(() => {
        keyCounter = 0;
        emitUpdate.mockClear();
        buildNewMessageUpdate.mockClear();
        randomKeyNaked.mockClear();
        markAccountChanged.mockClear();
        socketMessageAckInc.mockClear();
    });

    it("marks a session change for all participants and emits updates using the returned cursors", async () => {
        const { sessionUpdateHandler } = await import("./sessionUpdateHandler");

        const socket = new FakeSocket();
        sessionUpdateHandler(
            "owner",
            socket as any,
            { connectionType: "session-scoped", socket: socket as any, userId: "owner", sessionId: "s1" } as any,
        );

        const handler = socket.handlers.get("message");
        expect(typeof handler).toBe("function");

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
        expect(callback).toHaveBeenCalledWith({ ok: true, id: "m1", seq: 55, localId: "l1" });
    });

    it("does not skip sender connection when echoToSender is requested (opt-in)", async () => {
        const { sessionUpdateHandler } = await import("./sessionUpdateHandler");

        const socket = new FakeSocket();
        const connection = { connectionType: "session-scoped", socket: socket as any, userId: "owner", sessionId: "s1" } as any;
        sessionUpdateHandler("owner", socket as any, connection);

        const handler = socket.handlers.get("message");
        expect(typeof handler).toBe("function");

        await handler({ sid: "s1", message: "enc", localId: "l1", echoToSender: true });

        const ownerCall = emitUpdate.mock.calls
            .map((c) => c[0])
            .find((payload) => payload?.userId === "owner");
        expect(ownerCall).toBeTruthy();
        expect(ownerCall.skipSenderConnection).toBeUndefined();
    });

    it("does not require a callback for socket message ACK (old clients)", async () => {
        const { sessionUpdateHandler } = await import("./sessionUpdateHandler");

        const socket = new FakeSocket();
        sessionUpdateHandler(
            "owner",
            socket as any,
            { connectionType: "session-scoped", socket: socket as any, userId: "owner", sessionId: "s1" } as any,
        );

        const handler = socket.handlers.get("message");
        expect(typeof handler).toBe("function");

        await handler({ sid: "s1", message: "enc", localId: "l1" });

        expect(socketMessageAckInc).toHaveBeenCalledWith({ result: "ok", error: "none" });
        expect(emitUpdate).toHaveBeenCalledTimes(2);
    });
});
