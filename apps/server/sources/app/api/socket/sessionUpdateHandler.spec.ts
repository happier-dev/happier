import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeSocket, getSocketHandler } from "../testkit/socketHarness";

const createSessionMessage = vi.fn<(...args: unknown[]) => Promise<unknown>>(async () => ({ ok: false, error: "invalid-params" }));
const materializeNextPendingMessage = vi.fn(async (): Promise<unknown> => ({ ok: false, error: "internal" }));
const readSessionPendingState = vi.fn(async (): Promise<unknown> => ({ ok: true, pendingCount: 0, pendingVersion: 0 }));
const applySessionTurnMutation = vi.fn(async (): Promise<unknown> => ({ ok: false, error: "internal" }));
const updateSessionAgentState = vi.fn(async (): Promise<unknown> => ({ ok: false, error: "internal" }));
const getSessionParticipantUserIds = vi.fn(async () => ["user-1"]);
const markAccountChanged = vi.fn(async () => 101);
const sessionFindUnique = vi.fn();
const sessionUpdate = vi.fn();
const emitEphemeral = vi.fn();
const emitUpdate = vi.fn();
const buildPendingChangedUpdate = vi.fn();
const buildUpdateSessionUpdate = vi.fn(
    (_sessionId: string, seq: number, updateId: string, _metadata: unknown, _agentState: unknown, projection?: unknown) => ({
        id: updateId,
        seq,
        body: { t: "update-session", ...(projection && typeof projection === "object" ? projection : {}) },
    }),
);
vi.mock("@/app/session/sessionWriteService", () => ({
    createSessionMessage,
    updateSessionMetadata: vi.fn(async () => ({ ok: false, error: "internal" })),
    updateSessionAgentState,
    applySessionTurnMutation,
}));
vi.mock("@/app/session/pending/pendingMessageService", () => ({
    materializeNextPendingMessage,
    readSessionPendingState,
}));
vi.mock("@/storage/db", () => ({
    db: {
        session: {
            findUnique: sessionFindUnique,
            update: sessionUpdate,
        },
    },
}));
vi.mock("@/app/events/eventRouter", () => ({
    eventRouter: {
        emitEphemeral,
        emitUpdate,
    },
    buildMessageUpdatedUpdate: vi.fn(),
    buildNewMessageUpdate: vi.fn(),
    buildPendingChangedUpdate,
    buildSessionActivityEphemeral: vi.fn(),
    buildUpdateSessionUpdate,
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

vi.mock("@/app/share/sessionParticipants", () => ({
    getSessionParticipantUserIds,
}));
vi.mock("@/app/changes/markAccountChanged", () => ({
    markAccountChanged,
}));
vi.mock("@/storage/inTx", () => ({
    inTx: vi.fn(async (fn: (tx: unknown) => unknown) => await fn({})),
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
        materializeNextPendingMessage.mockReset();
        materializeNextPendingMessage.mockResolvedValue({ ok: false, error: "internal" });
        readSessionPendingState.mockReset();
        readSessionPendingState.mockResolvedValue({ ok: true, pendingCount: 0, pendingVersion: 0 });
        applySessionTurnMutation.mockClear();
        updateSessionAgentState.mockClear();
        sessionFindUnique.mockReset();
        sessionUpdate.mockReset();
        emitEphemeral.mockClear();
        emitUpdate.mockClear();
        buildUpdateSessionUpdate.mockClear();
        buildPendingChangedUpdate.mockClear();
        checkSessionAccess.mockClear();
        requireAccessLevel.mockClear();
        getSessionParticipantUserIds.mockClear();
        getSessionParticipantUserIds.mockResolvedValue(["user-1"]);
        markAccountChanged.mockReset();
        markAccountChanged.mockResolvedValue(101);
        refreshSessionParticipantBadgePushes.mockClear();
        logInfo.mockClear();
        logDebug.mockClear();
        delete process.env.HAPPIER_SOCKET_MESSAGE_DIAGNOSTIC_LOGS;
        delete process.env.HAPPY_SOCKET_MESSAGE_DIAGNOSTIC_LOGS;
    });

    it("ignores runtimeIssueSummaryV1 without dropping valid update-state writes", async () => {
        updateSessionAgentState.mockResolvedValueOnce({
            ok: true,
            version: 2,
            agentState: "encrypted-state",
            participantCursors: [],
            badgeAttentionChanged: false,
        });
        const socket = createFakeSocket();

        registerSessionUpdateHandler(
            "user-1",
            socket as any,
            { connectionType: "session-scoped", socket: socket as any, userId: "user-1", sessionId: "s-1" } as any,
        );

        const handler = getSocketHandler(socket, "update-state");
        const callback = vi.fn();
        await handler({
            sid: "s-1",
            agentState: "encrypted-state",
            expectedVersion: 1,
            runtimeIssueSummaryV1: {
                latestTurnStatus: "failed",
                lastRuntimeIssue: {
                    v: 1,
                    scope: "primary_session",
                    status: "failed",
                    code: "provider_status_error",
                    source: "provider_status_error",
                    occurredAt: 200,
                    provider: "acp",
                    sanitizedPreview: "Provider reported an error",
                },
            },
        }, callback);

        expect(updateSessionAgentState).toHaveBeenCalledWith({
            actorUserId: "user-1",
            sessionId: "s-1",
            expectedVersion: 1,
            agentStateCiphertext: "encrypted-state",
        });
        expect(callback).toHaveBeenCalledWith({
            result: "success",
            version: 2,
            agentState: "encrypted-state",
        });
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

    it("does not emit per-message socket diagnostics by default", async () => {
        const socket = createFakeSocket();

        registerSessionUpdateHandler(
            "user-1",
            socket as any,
            { connectionType: "session-scoped", socket: socket as any, userId: "user-1", sessionId: "s-1" } as any,
        );

        const handler = getSocketHandler(socket, "message");
        await handler({ sid: "s-1", message: { t: "plain", v: { type: "user", text: "hi" } } }, vi.fn());

        expect(logDebug).not.toHaveBeenCalledWith(
            expect.objectContaining({ module: "websocket" }),
            expect.stringContaining("Received message from socket"),
        );
    });

    it("classifies legacy UI encrypted message payloads as user messages", async () => {
        const socket = createFakeSocket();

        registerSessionUpdateHandler(
            "user-1",
            socket,
            { connectionType: "session-scoped", socket, userId: "user-1", sessionId: "s-1" },
        );

        const handler = getSocketHandler(socket, "message");
        const callback = vi.fn();
        await handler({
            sid: "s-1",
            message: "encrypted-payload",
            localId: "local-user-1",
            sentFrom: "web",
            permissionMode: "default",
        }, callback);

        expect(createSessionMessage).toHaveBeenCalledWith({
            actorUserId: "user-1",
            sessionId: "s-1",
            content: { t: "encrypted", c: "encrypted-payload" },
            localId: "local-user-1",
            sidechainId: null,
            messageRole: "user",
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

    it("writes the inbound message trace through debug logging instead of info logging when diagnostics are enabled", async () => {
        process.env.HAPPIER_SOCKET_MESSAGE_DIAGNOSTIC_LOGS = "1";
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

    it("ignores public ready hints after creating a message from a socket", async () => {
        const createdAt = new Date(1_000);
        createSessionMessage.mockResolvedValueOnce({
            ok: true,
            didWrite: true,
            didUpdate: false,
            badgeAttentionChanged: true,
            message: {
                id: "m-ready",
                seq: 7,
                localId: "ready-local",
                sidechainId: null,
                content: { t: "encrypted", c: "enc" },
                createdAt,
                updatedAt: createdAt,
            },
            participantCursors: [{ accountId: "user-1", cursor: 10 }],
        });
        const socket = createFakeSocket();

        registerSessionUpdateHandler(
            "user-1",
            socket as any,
            { connectionType: "session-scoped", socket: socket as any, userId: "user-1", sessionId: "s-1" } as any,
        );

        const handler = getSocketHandler(socket, "message");
        await handler({
            sid: "s-1",
            message: "enc",
            localId: "ready-local",
            messageRole: "event",
            sessionEventType: "ready",
            echoToSender: false,
        }, vi.fn());

        expect(createSessionMessage).toHaveBeenCalledWith(expect.objectContaining({
            actorUserId: "user-1",
            sessionId: "s-1",
            content: { t: "encrypted", c: "enc" },
            localId: "ready-local",
            messageRole: "event",
            trustedSessionEventType: "ready",
        }));
        expect(buildUpdateSessionUpdate).not.toHaveBeenCalled();
        expect(emitUpdate).toHaveBeenCalledWith(expect.objectContaining({
            userId: "user-1",
            skipSenderConnection: expect.anything(),
        }));
    });

    it("applies session turn socket mutations and fans out updates", async () => {
        applySessionTurnMutation.mockResolvedValueOnce({
            ok: true,
            didApply: true,
            receipt: {
                v: 1,
                sessionId: "s-1",
                mutationId: "mutation-1",
                turnId: "turn-1",
                action: "complete",
                decision: "applied",
                observedAt: 123,
                appliedAt: 124,
            },
            latestTurnId: "turn-1",
            latestTurnStatus: "completed",
            latestTurnStatusObservedAt: 123,
            lastRuntimeIssue: null,
            participantCursors: [
                { accountId: "user-1", cursor: 10 },
                { accountId: "user-2", cursor: 11 },
            ],
            badgeAttentionChanged: false,
        });
        const socket = createFakeSocket();

        registerSessionUpdateHandler(
            "user-1",
            socket as any,
            { connectionType: "session-scoped", socket: socket as any, userId: "user-1", sessionId: "s-1" } as any,
        );

        const handler = getSocketHandler(socket, "session-turn-mutation");
        const callback = vi.fn();
        await handler({
            v: 1,
            sessionId: "s-1",
            mutationId: "mutation-1",
            turnId: "turn-1",
            action: "complete",
            provider: "codex",
            providerTurnId: "provider-turn-1",
            observedAt: 123,
        }, callback);

        expect(applySessionTurnMutation).toHaveBeenCalledWith({
            actorUserId: "user-1",
            mutation: {
                v: 1,
                sessionId: "s-1",
                mutationId: "mutation-1",
                turnId: "turn-1",
                action: "complete",
                provider: "codex",
                providerTurnId: "provider-turn-1",
                observedAt: 123,
            },
        });
        expect(buildUpdateSessionUpdate).toHaveBeenNthCalledWith(1, "s-1", 10, expect.any(String), undefined, undefined, {
            latestTurnId: "turn-1",
            latestTurnStatus: "completed",
            latestTurnStatusObservedAt: 123,
            lastRuntimeIssue: null,
        });
        expect(buildUpdateSessionUpdate).toHaveBeenNthCalledWith(2, "s-1", 11, expect.any(String), undefined, undefined, {
            latestTurnId: "turn-1",
            latestTurnStatus: "completed",
            latestTurnStatusObservedAt: 123,
            lastRuntimeIssue: null,
        });
        expect(emitUpdate).toHaveBeenCalledTimes(2);
        expect(callback).toHaveBeenCalledWith({
            result: "success",
            applied: true,
            receipt: {
                v: 1,
                sessionId: "s-1",
                mutationId: "mutation-1",
                turnId: "turn-1",
                action: "complete",
                decision: "applied",
                observedAt: 123,
                appliedAt: 124,
            },
        });
    });

    it("does not skip the user-scoped socket that reports a session turn mutation", async () => {
        applySessionTurnMutation.mockResolvedValueOnce({
            ok: true,
            didApply: true,
            receipt: {
                v: 1,
                sessionId: "s-1",
                mutationId: "mutation-1",
                turnId: "turn-1",
                action: "begin",
                decision: "applied",
                observedAt: 123,
                appliedAt: 124,
            },
            latestTurnId: "turn-1",
            latestTurnStatus: "in_progress",
            latestTurnStatusObservedAt: 123,
            lastRuntimeIssue: null,
            participantCursors: [{ accountId: "user-1", cursor: 10 }],
            badgeAttentionChanged: false,
        });
        const socket = createFakeSocket();
        const connection = { connectionType: "user-scoped", socket: socket as any, userId: "user-1" } as any;

        registerSessionUpdateHandler("user-1", socket as any, connection);

        const handler = getSocketHandler(socket, "session-turn-mutation");
        const callback = vi.fn();
        await handler({
            v: 1,
            sessionId: "s-1",
            mutationId: "mutation-1",
            turnId: "turn-1",
            action: "begin",
            provider: "codex",
            providerTurnId: "provider-turn-1",
            observedAt: 123,
        }, callback);

        expect(emitUpdate).toHaveBeenCalledTimes(1);
        expect(emitUpdate.mock.calls[0]?.[0]).toEqual(expect.objectContaining({
            userId: "user-1",
            recipientFilter: { type: "all-interested-in-session", sessionId: "s-1" },
        }));
        expect(emitUpdate.mock.calls[0]?.[0]?.skipSenderConnection).toBeUndefined();
        expect(callback).toHaveBeenCalledWith(expect.objectContaining({ result: "success", applied: true }));
    });

    it("returns pending state and throttles repeated pending-materialize-next no-op responses", async () => {
        const previousThrottle = process.env.HAPPIER_SOCKET_PENDING_MATERIALIZE_NOOP_THROTTLE_MS;
        process.env.HAPPIER_SOCKET_PENDING_MATERIALIZE_NOOP_THROTTLE_MS = "1000";
        const nowSpy = vi.spyOn(Date, "now").mockReturnValue(10_000);
        materializeNextPendingMessage.mockResolvedValue({
            ok: true,
            didMaterialize: false,
            pendingCount: 0,
            pendingVersion: 3,
        });
        const socket = createFakeSocket();
        registerSessionUpdateHandler(
            "user-1",
            socket as any,
            { connectionType: "session-scoped", socket: socket as any, userId: "user-1", sessionId: "s-1" } as any,
        );

        try {
            const handler = getSocketHandler(socket, "pending-materialize-next");
            const firstCallback = vi.fn();
            const secondCallback = vi.fn();

            await handler({ sid: "s-1" }, firstCallback);
            await handler({ sid: "s-1" }, secondCallback);

            expect(materializeNextPendingMessage).toHaveBeenCalledTimes(1);
            expect(firstCallback).toHaveBeenCalledWith({ ok: true, didMaterialize: false, pendingCount: 0, pendingVersion: 3 });
            expect(secondCallback).toHaveBeenCalledWith({ ok: true, didMaterialize: false, pendingCount: 0, pendingVersion: 3 });
        } finally {
            nowSpy.mockRestore();
            if (typeof previousThrottle === "string") {
                process.env.HAPPIER_SOCKET_PENDING_MATERIALIZE_NOOP_THROTTLE_MS = previousThrottle;
            } else {
                delete process.env.HAPPIER_SOCKET_PENDING_MATERIALIZE_NOOP_THROTTLE_MS;
            }
        }
    });

    it("uses a default no-op throttle longer than the legacy one-second idle poll", async () => {
        const previousThrottle = process.env.HAPPIER_SOCKET_PENDING_MATERIALIZE_NOOP_THROTTLE_MS;
        delete process.env.HAPPIER_SOCKET_PENDING_MATERIALIZE_NOOP_THROTTLE_MS;
        const nowSpy = vi.spyOn(Date, "now").mockReturnValue(10_000);
        materializeNextPendingMessage.mockResolvedValue({
            ok: true,
            didMaterialize: false,
            pendingCount: 0,
            pendingVersion: 11,
        });
        const socket = createFakeSocket();
        registerSessionUpdateHandler(
            "user-1",
            socket as any,
            { connectionType: "session-scoped", socket: socket as any, userId: "user-1", sessionId: "s-default-throttle" } as any,
        );

        try {
            const handler = getSocketHandler(socket, "pending-materialize-next");
            const firstCallback = vi.fn();
            const secondCallback = vi.fn();
            await handler({ sid: "s-default-throttle" }, firstCallback);
            nowSpy.mockReturnValue(11_000);
            await handler({ sid: "s-default-throttle" }, secondCallback);

            expect(materializeNextPendingMessage).toHaveBeenCalledTimes(1);
            expect(secondCallback).toHaveBeenCalledWith({ ok: true, didMaterialize: false, pendingCount: 0, pendingVersion: 11 });
        } finally {
            nowSpy.mockRestore();
            if (typeof previousThrottle === "string") {
                process.env.HAPPIER_SOCKET_PENDING_MATERIALIZE_NOOP_THROTTLE_MS = previousThrottle;
            } else {
                delete process.env.HAPPIER_SOCKET_PENDING_MATERIALIZE_NOOP_THROTTLE_MS;
            }
        }
    });

    it("bypasses a cached no-op when the client has observed a newer pending version", async () => {
        const previousThrottle = process.env.HAPPIER_SOCKET_PENDING_MATERIALIZE_NOOP_THROTTLE_MS;
        process.env.HAPPIER_SOCKET_PENDING_MATERIALIZE_NOOP_THROTTLE_MS = "1000";
        const nowSpy = vi.spyOn(Date, "now").mockReturnValue(10_000);
        materializeNextPendingMessage
            .mockResolvedValueOnce({
                ok: true,
                didMaterialize: false,
                pendingCount: 0,
                pendingVersion: 5,
            })
            .mockResolvedValueOnce({
                ok: true,
                didMaterialize: true,
                didWriteMessage: true,
                message: {
                    id: "msg-new",
                    seq: 12,
                    localId: "pending-new",
                    messageRole: "user",
                    content: { t: "plain", v: { type: "user", text: "hello" } },
                    createdAt: new Date("2026-01-01T00:00:00.000Z"),
                    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
                },
                pendingCount: 0,
                pendingVersion: 7,
                meaningfulActivityAt: new Date("2026-01-01T00:00:00.000Z"),
                participantCursorsMessage: [],
                participantCursorsPending: [{ accountId: "user-1", cursor: 701 }],
                badgeAttentionChanged: false,
            });
        const socket = createFakeSocket();
        registerSessionUpdateHandler(
            "user-1",
            socket as any,
            { connectionType: "session-scoped", socket: socket as any, userId: "user-1", sessionId: "s-bypass" } as any,
        );

        try {
            const handler = getSocketHandler(socket, "pending-materialize-next");
            const firstCallback = vi.fn();
            const secondCallback = vi.fn();

            await handler({ sid: "s-bypass" }, firstCallback);
            await handler({ sid: "s-bypass", pendingVersion: 6 }, secondCallback);

            expect(materializeNextPendingMessage).toHaveBeenCalledTimes(2);
            expect(secondCallback).toHaveBeenCalledWith(expect.objectContaining({
                ok: true,
                didMaterialize: true,
                pendingVersion: 7,
                message: expect.objectContaining({
                    messageRole: "user",
                    content: { t: "plain", v: { type: "user", text: "hello" } },
                    createdAt: Date.parse("2026-01-01T00:00:00.000Z"),
                    updatedAt: Date.parse("2026-01-01T00:00:00.000Z"),
                }),
            }));
            expect(buildPendingChangedUpdate).toHaveBeenCalledWith(
                expect.objectContaining({
                    sessionId: "s-bypass",
                    pendingCount: 0,
                    pendingVersion: 7,
                    meaningfulActivityAt: new Date("2026-01-01T00:00:00.000Z"),
                }),
                701,
                expect.any(String),
            );
        } finally {
            nowSpy.mockRestore();
            if (typeof previousThrottle === "string") {
                process.env.HAPPIER_SOCKET_PENDING_MATERIALIZE_NOOP_THROTTLE_MS = previousThrottle;
            } else {
                delete process.env.HAPPIER_SOCKET_PENDING_MATERIALIZE_NOOP_THROTTLE_MS;
            }
        }
    });

    it("bypasses a cached no-op when the server pending state advanced elsewhere", async () => {
        const previousThrottle = process.env.HAPPIER_SOCKET_PENDING_MATERIALIZE_NOOP_THROTTLE_MS;
        process.env.HAPPIER_SOCKET_PENDING_MATERIALIZE_NOOP_THROTTLE_MS = "1000";
        const nowSpy = vi.spyOn(Date, "now").mockReturnValue(10_000);
        materializeNextPendingMessage
            .mockResolvedValueOnce({
                ok: true,
                didMaterialize: false,
                pendingCount: 0,
                pendingVersion: 5,
            })
            .mockResolvedValueOnce({
                ok: true,
                didMaterialize: true,
                didWriteMessage: true,
                message: {
                    id: "msg-server-advanced",
                    seq: 12,
                    localId: "pending-server-advanced",
                    messageRole: "user",
                    content: { t: "plain", v: { type: "user", text: "hello" } },
                    createdAt: new Date("2026-01-01T00:00:00.000Z"),
                    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
                },
                pendingCount: 0,
                pendingVersion: 6,
                participantCursorsMessage: [],
                participantCursorsPending: [],
                badgeAttentionChanged: false,
            });
        readSessionPendingState.mockResolvedValueOnce({ ok: true, pendingCount: 1, pendingVersion: 6 });
        const socket = createFakeSocket();

        registerSessionUpdateHandler(
            "user-1",
            socket as any,
            { connectionType: "session-scoped", socket: socket as any, userId: "user-1", sessionId: "s-server-advanced" } as any,
        );

        try {
            const handler = getSocketHandler(socket, "pending-materialize-next");
            const firstCallback = vi.fn();
            const secondCallback = vi.fn();

            await handler({ sid: "s-server-advanced" }, firstCallback);
            await handler({ sid: "s-server-advanced" }, secondCallback);

            expect(readSessionPendingState).toHaveBeenCalledWith({ actorUserId: "user-1", sessionId: "s-server-advanced" });
            expect(materializeNextPendingMessage).toHaveBeenCalledTimes(2);
            expect(secondCallback).toHaveBeenCalledWith(expect.objectContaining({
                ok: true,
                didMaterialize: true,
                pendingVersion: 6,
                message: expect.objectContaining({ messageRole: "user" }),
            }));
        } finally {
            nowSpy.mockRestore();
            if (typeof previousThrottle === "string") {
                process.env.HAPPIER_SOCKET_PENDING_MATERIALIZE_NOOP_THROTTLE_MS = previousThrottle;
            } else {
                delete process.env.HAPPIER_SOCKET_PENDING_MATERIALIZE_NOOP_THROTTLE_MS;
            }
        }
    });

    it("terminalizes the active latest turn when a session-end socket event marks the session inactive", async () => {
        const nowSpy = vi.spyOn(Date, "now").mockReturnValue(200);
        sessionFindUnique.mockResolvedValueOnce({
            id: "s-1",
            seq: 3,
            pendingCount: 0,
            lastViewedSessionSeq: 3,
            pendingPermissionRequestCount: 0,
            pendingUserActionRequestCount: 0,
            latestTurnId: "turn-1",
            latestTurnStatus: "in_progress",
            latestTurnStatusObservedAt: 100,
            lastRuntimeIssue: null,
            active: true,
            archivedAt: null,
        });
        sessionUpdate.mockResolvedValueOnce({});
        applySessionTurnMutation.mockResolvedValueOnce({
            ok: true,
            didApply: true,
            latestTurnId: "turn-1",
            latestTurnStatus: "cancelled",
            latestTurnStatusObservedAt: 200,
            lastRuntimeIssue: null,
            participantCursors: [{ accountId: "user-1", cursor: 101 }],
            badgeAttentionChanged: false,
        });

        const socket = createFakeSocket();
        registerSessionUpdateHandler(
            "user-1",
            socket as any,
            { connectionType: "session-scoped", socket: socket as any, userId: "user-1", sessionId: "s-1" } as any,
        );

        try {
            const handler = getSocketHandler(socket, "session-end");
            await handler({ sid: "s-1", time: 200 });

            expect(applySessionTurnMutation).toHaveBeenCalledWith({
                actorUserId: "user-1",
                mutation: {
                    v: 1,
                    sessionId: "s-1",
                    mutationId: "legacy-session-end:s-1:200",
                    action: "end_session",
                    turnId: "turn-1",
                    observedAt: 200,
                },
            });
            expect(buildUpdateSessionUpdate).toHaveBeenCalledWith("s-1", 101, expect.any(String), undefined, undefined, {
                active: false,
                activeAt: 200,
                latestTurnId: "turn-1",
                latestTurnStatus: "cancelled",
                latestTurnStatusObservedAt: 200,
                lastRuntimeIssue: null,
            });
            expect(emitUpdate).toHaveBeenCalledWith(expect.objectContaining({
                userId: "user-1",
                payload: expect.objectContaining({
                    body: expect.objectContaining({
                        latestTurnStatus: "cancelled",
                    }),
                }),
            }));
        } finally {
            nowSpy.mockRestore();
        }
    });

    it("acks successful legacy session-end socket delivery for ordinary sockets", async () => {
        const nowSpy = vi.spyOn(Date, "now").mockReturnValue(200);
        sessionFindUnique.mockResolvedValueOnce({
            id: "s-1",
            seq: 3,
            pendingCount: 0,
            lastViewedSessionSeq: 3,
            pendingPermissionRequestCount: 0,
            pendingUserActionRequestCount: 0,
            latestTurnId: null,
            latestTurnStatus: null,
            latestTurnStatusObservedAt: null,
            lastRuntimeIssue: null,
            active: true,
            archivedAt: null,
        });
        sessionUpdate.mockResolvedValueOnce({});

        const socket = createFakeSocket();
        registerSessionUpdateHandler(
            "user-1",
            socket as any,
            { connectionType: "user-scoped", socket: socket as any, userId: "user-1" } as any,
        );

        try {
            const callback = vi.fn();
            const handler = getSocketHandler(socket, "session-end");
            await handler({ sid: "s-1", time: 200 }, callback);

            expect(callback).toHaveBeenCalledWith(expect.objectContaining({
                ok: true,
                applied: true,
                active: false,
                activeAt: 200,
            }));
            expect(sessionUpdate).toHaveBeenCalledWith(expect.objectContaining({
                where: { id: "s-1" },
            }));
        } finally {
            nowSpy.mockRestore();
        }
    });

    it("rejects legacy session-end from a mismatched session-scoped socket", async () => {
        const socket = createFakeSocket();
        registerSessionUpdateHandler(
            "user-1",
            socket as any,
            { connectionType: "session-scoped", socket: socket as any, userId: "user-1", sessionId: "s-expected" } as any,
        );

        const callback = vi.fn();
        const handler = getSocketHandler(socket, "session-end");
        await handler({ sid: "s-other", time: 200 }, callback);

        expect(callback).toHaveBeenCalledWith({ ok: false, error: "forbidden" });
        expect(sessionFindUnique).not.toHaveBeenCalled();
        expect(sessionUpdate).not.toHaveBeenCalled();
    });

});
