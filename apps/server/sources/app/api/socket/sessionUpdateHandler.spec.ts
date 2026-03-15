import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeSocket, getSocketHandler } from "../testkit/socketHarness";

const createSessionMessage = vi.fn(async () => ({ ok: false, error: "invalid-params" }));
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

const dbSessionFindUnique = vi.fn(async () => ({ encryptionMode: "plain" }));
vi.mock("@/storage/db", () => ({
    db: {
        session: {
            findUnique: dbSessionFindUnique,
        },
    },
}));
vi.mock("@/utils/logging/log", () => ({ log: vi.fn() }));

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
        dbSessionFindUnique.mockClear();
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

    it("drops transcript-draft deltas whose plain content cannot be JSON-stringified", async () => {
        const socket = createFakeSocket();

        registerSessionUpdateHandler(
            "user-1",
            socket as any,
            { connectionType: "session-scoped", socket: socket as any, userId: "user-1", sessionId: "s-1" } as any,
        );

        const handler = getSocketHandler(socket, "transcript-draft");

        const unserializableDelta = { t: "plain", v: { n: BigInt(1) } };
        await handler({
            sid: "s-1",
            localId: "l1",
            segmentKind: "assistant",
            sidechainId: null,
            delta: unserializableDelta,
            createdAt: Date.now(),
        });

        expect(emitEphemeral).not.toHaveBeenCalled();
    });
});
