import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeSocket, getSocketHandler } from "../testkit/socketHarness";

const createSessionMessage = vi.fn<(...args: unknown[]) => Promise<unknown>>(async () => ({ ok: false, error: "invalid-params" }));
const emitEphemeral = vi.fn();
vi.mock("@/app/session/sessionWriteService", () => ({
    createSessionMessage,
    updateSessionMetadata: vi.fn(async () => ({ ok: false, error: "internal" })),
    updateSessionAgentState: vi.fn(async () => ({ ok: false, error: "internal" })),
}));
vi.mock("@/app/events/eventRouter", () => ({
    eventRouter: {
        emitEphemeral,
        emitUpdate: vi.fn(),
    },
    buildMessageUpdatedUpdate: vi.fn(),
    buildNewMessageUpdate: vi.fn(),
    buildPendingChangedUpdate: vi.fn(),
    buildSessionActivityEphemeral: vi.fn(),
    buildUpdateSessionUpdate: vi.fn(),
}));

const checkSessionAccess = vi.fn(async () => ({
    userId: "user-1",
    sessionId: "s-1",
    level: "owner",
    isOwner: true,
}));
const requireAccessLevel = vi.fn(() => true);
vi.mock("@/app/share/accessControl", () => ({
    checkSessionAccess,
    requireAccessLevel,
}));

const getSessionParticipantUserIds = vi.fn(async () => ["user-1"]);
vi.mock("@/app/share/sessionParticipants", () => ({
    getSessionParticipantUserIds,
}));
const refreshSessionParticipantBadgePushes = vi.fn(async () => {});
vi.mock("@/app/activity/refreshAccountActivityBadgePushes", () => ({
    refreshSessionParticipantBadgePushes,
}));
const logInfo = vi.fn();
const logDebug = vi.fn();
vi.mock("@/utils/logging/log", () => ({ log: logInfo, debug: logDebug }));

describe("sessionUpdateHandler", () => {
    let registerSessionUpdateHandler: (userId: string, socket: any, connection: any) => void;

    beforeAll(async () => {
        ({ sessionUpdateHandler: registerSessionUpdateHandler } = await import("./sessionUpdateHandler"));
    }, 120_000);

    beforeEach(() => {
        createSessionMessage.mockClear();
        emitEphemeral.mockClear();
        checkSessionAccess.mockClear();
        requireAccessLevel.mockClear();
        getSessionParticipantUserIds.mockClear();
        refreshSessionParticipantBadgePushes.mockClear();
        logInfo.mockClear();
        logDebug.mockClear();
    });

    it("does not crash on invalid message payloads and acks with invalid-params when callback is provided", async () => {
        const socket = createFakeSocket();

        registerSessionUpdateHandler(
            "user-1",
            socket as any,
            // minimal connection object for logging
            { connectionType: "session-scoped", socket: socket as any, userId: "user-1", sessionId: "s-1" } as any,
        );

        const handler = getSocketHandler(socket, "message");

        const callback = vi.fn();
        await handler({ sid: "s-1" }, callback); // missing message

        expect(callback).toHaveBeenCalledWith(
            expect.objectContaining({
                ok: false,
                error: "invalid-params",
            }),
        );
    });

    it("does not crash on invalid message payloads when callback is missing (old clients)", async () => {
        const socket = createFakeSocket();

        registerSessionUpdateHandler(
            "user-1",
            socket as any,
            { connectionType: "session-scoped", socket: socket as any, userId: "user-1", sessionId: "s-1" } as any,
        );

        const handler = getSocketHandler(socket, "message");

        await expect(handler({ sid: "s-1" })).resolves.toBeUndefined();
    });

    it("accepts plain message envelopes and forwards them to createSessionMessage", async () => {
        const socket = createFakeSocket();

        registerSessionUpdateHandler(
            "user-1",
            socket as any,
            { connectionType: "session-scoped", socket: socket as any, userId: "user-1", sessionId: "s-1" } as any,
        );

        const handler = getSocketHandler(socket, "message");
        const callback = vi.fn();
        await handler({ sid: "s-1", message: { t: "plain", v: { type: "user", text: "hi" } } }, callback);

        expect(createSessionMessage).toHaveBeenCalledWith({
            actorUserId: "user-1",
            sessionId: "s-1",
            content: { t: "plain", v: { type: "user", text: "hi" } },
            localId: null,
            sidechainId: null,
        });
        expect(callback).toHaveBeenCalledWith(expect.objectContaining({ ok: false, error: "invalid-params" }));
    });

    it("does not crash when plain message envelopes contain unserializable payloads", async () => {
        const socket = createFakeSocket();

        registerSessionUpdateHandler(
            "user-1",
            socket as any,
            { connectionType: "session-scoped", socket: socket as any, userId: "user-1", sessionId: "s-1" } as any,
        );

        const circular: any = { kind: "circular" };
        circular.self = circular;

        const handler = getSocketHandler(socket, "message");
        const callback = vi.fn();
        await handler({ sid: "s-1", message: { t: "plain", v: circular } }, callback);

        expect(createSessionMessage).toHaveBeenCalledWith({
            actorUserId: "user-1",
            sessionId: "s-1",
            content: { t: "plain", v: circular },
            localId: null,
            sidechainId: null,
        });
        expect(callback).toHaveBeenCalledWith(expect.objectContaining({ ok: false, error: "invalid-params" }));
    });

    it("writes the inbound message trace through debug logging instead of info logging", async () => {
        const socket = createFakeSocket();

        registerSessionUpdateHandler(
            "user-1",
            socket as any,
            { connectionType: "session-scoped", socket: socket as any, userId: "user-1", sessionId: "s-1" } as any,
        );

        const handler = getSocketHandler(socket, "message");
        const callback = vi.fn();
        await handler({ sid: "s-1", message: "enc", localId: "l-1" }, callback);

        expect(logDebug).toHaveBeenCalledWith(
            { module: "websocket" },
            expect.stringContaining("Received message from socket"),
        );
        expect(logInfo).not.toHaveBeenCalledWith(
            { module: "websocket" },
            expect.stringContaining("Received message from socket"),
        );
    });

    it("does not hold the per-socket message lock on slow badge refresh work", async () => {
        let resolveFirstRefresh: (() => void) | undefined;
        const firstRefresh = new Promise<void>((resolve) => {
            resolveFirstRefresh = () => resolve();
        });
        refreshSessionParticipantBadgePushes
            .mockImplementationOnce(() => firstRefresh)
            .mockResolvedValueOnce(undefined);
        createSessionMessage
            .mockResolvedValueOnce({
                ok: true,
                didWrite: true,
                didUpdate: false,
                badgeAttentionChanged: true,
                message: {
                    id: "m-1",
                    seq: 1,
                    localId: "l-1",
                    sidechainId: null,
                    content: { t: "encrypted", c: "enc-1" },
                    createdAt: new Date(1),
                    updatedAt: new Date(1),
                },
                participantCursors: [{ accountId: "user-1", cursor: 1 }],
            })
            .mockResolvedValueOnce({
                ok: true,
                didWrite: true,
                didUpdate: false,
                badgeAttentionChanged: true,
                message: {
                    id: "m-2",
                    seq: 2,
                    localId: "l-2",
                    sidechainId: null,
                    content: { t: "encrypted", c: "enc-2" },
                    createdAt: new Date(2),
                    updatedAt: new Date(2),
                },
                participantCursors: [{ accountId: "user-1", cursor: 2 }],
            });

        const socket = createFakeSocket();

        registerSessionUpdateHandler(
            "user-1",
            socket as any,
            { connectionType: "session-scoped", socket: socket as any, userId: "user-1", sessionId: "s-1" } as any,
        );

        const handler = getSocketHandler(socket, "message");

        const firstCallback = vi.fn();
        const secondCallback = vi.fn();
        const firstPromise = Promise.resolve(handler({ sid: "s-1", message: "enc-1", localId: "l-1" }, firstCallback));
        await Promise.resolve();
        const secondPromise = Promise.resolve(handler({ sid: "s-1", message: "enc-2", localId: "l-2" }, secondCallback));
        await new Promise((resolve) => setTimeout(resolve, 0));
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(createSessionMessage).toHaveBeenCalledTimes(2);
        expect(firstCallback).toHaveBeenCalledWith(expect.objectContaining({ ok: true, id: "m-1", seq: 1, localId: "l-1" }));
        expect(secondCallback).toHaveBeenCalledWith(expect.objectContaining({ ok: true, id: "m-2", seq: 2, localId: "l-2" }));

        if (!resolveFirstRefresh) {
            throw new Error("expected first refresh resolver");
        }
        resolveFirstRefresh();
        await Promise.all([firstPromise, secondPromise]);
    });

});
