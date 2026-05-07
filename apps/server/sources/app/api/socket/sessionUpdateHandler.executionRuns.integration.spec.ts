import { beforeEach, describe, expect, it, vi } from "vitest";

import { createFakeSocket, getSocketHandler } from "../testkit/socketHarness";

type CheckSessionAccessFn = typeof import("@/app/share/accessControl").checkSessionAccess;
type RequireAccessLevelFn = typeof import("@/app/share/accessControl").requireAccessLevel;
type GetSessionParticipantUserIdsFn = typeof import("@/app/share/sessionParticipants").getSessionParticipantUserIds;

const emitEphemeral = vi.fn();
const websocketEventsCounterInc = vi.fn();

vi.mock("@/app/monitoring/metrics2", () => ({
    sessionAliveEventsCounter: { inc: vi.fn() },
    socketMessageAckCounter: { inc: vi.fn() },
    websocketEventsCounter: { inc: websocketEventsCounterInc },
}));

vi.mock("@/app/presence/sessionCache", () => ({
    activityCache: {
        isSessionValid: vi.fn(async () => true),
    },
}));

vi.mock("@/app/session/sessionWriteService", () => ({
    createSessionMessage: vi.fn(async () => ({ ok: false, error: "not-implemented" })),
    updateSessionMetadata: vi.fn(async () => ({ ok: false, error: "not-implemented" })),
    updateSessionAgentState: vi.fn(async () => ({ ok: false, error: "not-implemented" })),
}));

vi.mock("@/app/session/pending/pendingMessageService", () => ({
    materializeNextPendingMessage: vi.fn(async () => ({ ok: false, error: "not-implemented" })),
}));

vi.mock("@/app/session/messageContent/normalizeIncomingSessionMessageContent", () => ({
    normalizeIncomingSessionMessageContent: vi.fn(() => null),
}));

vi.mock("@/app/presence/presenceRecorder", () => ({
    recordSessionAlive: vi.fn(async () => {}),
}));

vi.mock("@/app/activity/refreshAccountActivityBadgePushes", () => ({
    refreshSessionParticipantBadgePushes: vi.fn(async () => {}),
}));

vi.mock("@/app/activity/accountActivityBadge", () => ({
    didSessionActivityBadgeContributionChange: vi.fn(() => false),
}));

const checkSessionAccess = vi.fn<CheckSessionAccessFn>();
const requireAccessLevel = vi.fn<RequireAccessLevelFn>();
vi.mock("@/app/share/accessControl", () => ({
    checkSessionAccess,
    requireAccessLevel,
}));

const getSessionParticipantUserIds = vi.fn<GetSessionParticipantUserIdsFn>();
vi.mock("@/app/share/sessionParticipants", () => ({
    getSessionParticipantUserIds,
}));

const accessKeyFindUnique = vi.hoisted(() => vi.fn(async (): Promise<{ machineId: string } | null> => ({ machineId: "m1" })));
vi.mock("@/storage/db", () => ({
    db: {
        accessKey: {
            findUnique: accessKeyFindUnique,
        },
    },
}));

vi.mock("@/config/env", () => ({
    parseIntEnv: (_value: string | undefined, fallback: number) => fallback,
}));

vi.mock("@/app/session/parseSessionMessageSidechainId", () => ({
    parseSessionMessageSidechainId: () => ({ ok: false }),
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

vi.mock("@/utils/logging/log", () => ({ log: vi.fn() }));
vi.mock("@/utils/keys/randomKeyNaked", () => ({ randomKeyNaked: () => "rand" }));
vi.mock("@/utils/runtime/lock", () => ({
    AsyncLock: class {
        async inLock<T>(fn: () => Promise<T> | T): Promise<T> {
            return await fn();
        }
    },
}));

describe("sessionUpdateHandler (execution-run-updated)", () => {
    beforeEach(() => {
        emitEphemeral.mockReset();
        websocketEventsCounterInc.mockReset();
        checkSessionAccess.mockReset();
        requireAccessLevel.mockReset();
        getSessionParticipantUserIds.mockReset();
        accessKeyFindUnique.mockReset();
        accessKeyFindUnique.mockResolvedValue({ machineId: "m1" });
        checkSessionAccess.mockImplementation(async (userId, sessionId) => ({
            userId,
            sessionId,
            level: "view",
            isOwner: false,
        }));
        requireAccessLevel.mockReturnValue(true);
        getSessionParticipantUserIds.mockResolvedValue(["u1", "u2"]);
    });

    it("broadcasts execution-run-updated ephemeral updates from a daemon session socket to all session participants", async () => {
        checkSessionAccess.mockResolvedValue({
            userId: "u1",
            sessionId: "s1",
            level: "edit",
            isOwner: true,
        } as any);

        const { sessionUpdateHandler } = await import("./sessionUpdateHandler");

        const socket = createFakeSocket();
        (socket as any).data = {
            machineId: "m1",
            sessionScopedBinding: {
                sessionId: "s1",
                machineId: "m1",
                proof: "machine-access-key",
            },
        };
        const connection = { connectionType: "session-scoped", socket: socket as any, userId: "u1", sessionId: "s1" } as any;
        sessionUpdateHandler(
            "u1",
            socket as any,
            connection,
        );

        const handler = getSocketHandler(socket, "execution-run-updated");
        await handler({
            sid: "s1",
            run: {
                runId: "run_1",
                callId: "call_1",
                sidechainId: "call_1",
                intent: "review",
                backendTarget: { kind: "builtInAgent", agentId: "claude" },
                permissionMode: "read_only",
                retentionPolicy: "ephemeral",
                runClass: "bounded",
                ioMode: "request_response",
                status: "running",
                startedAtMs: 123,
            },
        });

        expect(checkSessionAccess).toHaveBeenCalledWith("u1", "s1");
        expect(getSessionParticipantUserIds).toHaveBeenCalledWith({ sessionId: "s1" });

        expect(emitEphemeral).toHaveBeenCalledTimes(2);
        expect(emitEphemeral).toHaveBeenCalledWith(expect.objectContaining({
            userId: "u1",
            payload: expect.objectContaining({
                type: "execution-run-updated",
                sessionId: "s1",
                run: expect.objectContaining({ runId: "run_1", status: "running" }),
            }),
            recipientFilter: { type: "all-interested-in-session", sessionId: "s1" },
        }));
        expect(emitEphemeral).toHaveBeenCalledWith(expect.objectContaining({
            userId: "u2",
            payload: expect.objectContaining({
                type: "execution-run-updated",
                sessionId: "s1",
                run: expect.objectContaining({ runId: "run_1", status: "running" }),
            }),
            recipientFilter: { type: "all-interested-in-session", sessionId: "s1" },
        }));

        const ownerCall = emitEphemeral.mock.calls
            .map((call) => call[0])
            .find((payload) => payload?.userId === "u1");
        const collaboratorCall = emitEphemeral.mock.calls
            .map((call) => call[0])
            .find((payload) => payload?.userId === "u2");

        expect(ownerCall?.skipSenderConnection).toBe(connection);
        expect(collaboratorCall?.skipSenderConnection).toBeUndefined();
    });

    it("does not broadcast execution-run-updated when the machine access key binding has been revoked", async () => {
        accessKeyFindUnique.mockResolvedValueOnce(null);
        checkSessionAccess.mockResolvedValue({
            userId: "u1",
            sessionId: "s1",
            level: "edit",
            isOwner: true,
        } as any);

        const { sessionUpdateHandler } = await import("./sessionUpdateHandler");

        const socket = createFakeSocket();
        (socket as any).data = {
            machineId: "m1",
            sessionScopedBinding: {
                sessionId: "s1",
                machineId: "m1",
                proof: "machine-access-key",
            },
        };
        sessionUpdateHandler(
            "u1",
            socket as any,
            { connectionType: "session-scoped", socket: socket as any, userId: "u1", sessionId: "s1" } as any,
        );

        const handler = getSocketHandler(socket, "execution-run-updated");
        await handler({
            sid: "s1",
            run: {
                runId: "run_1",
                callId: "call_1",
                sidechainId: "call_1",
                intent: "review",
                backendTarget: { kind: "builtInAgent", agentId: "claude" },
                permissionMode: "read_only",
                retentionPolicy: "ephemeral",
                runClass: "bounded",
                ioMode: "request_response",
                status: "running",
                startedAtMs: 123,
            },
        });

        expect(accessKeyFindUnique).toHaveBeenCalledWith({
            where: {
                accountId_machineId_sessionId: {
                    accountId: "u1",
                    machineId: "m1",
                    sessionId: "s1",
                },
            },
            select: { machineId: true },
        });
        expect(checkSessionAccess).not.toHaveBeenCalled();
        expect(getSessionParticipantUserIds).not.toHaveBeenCalled();
        expect(emitEphemeral).not.toHaveBeenCalled();
    });

    it("does not broadcast execution-run-updated without machine-bound session proof even when the sender owns the session", async () => {
        checkSessionAccess.mockResolvedValue({
            userId: "u1",
            sessionId: "s1",
            level: "edit",
            isOwner: true,
        } as any);

        const { sessionUpdateHandler } = await import("./sessionUpdateHandler");

        const socket = createFakeSocket();
        (socket as any).data = {
            sessionScopedBinding: {
                sessionId: "s1",
                machineId: null,
                proof: "owner-session",
            },
        };
        sessionUpdateHandler(
            "u1",
            socket as any,
            { connectionType: "session-scoped", socket: socket as any, userId: "u1", sessionId: "s1" } as any,
        );

        const handler = getSocketHandler(socket, "execution-run-updated");
        await handler({
            sid: "s1",
            run: {
                runId: "run_1",
                callId: "call_1",
                sidechainId: "call_1",
                intent: "review",
                backendTarget: { kind: "builtInAgent", agentId: "claude" },
                permissionMode: "read_only",
                retentionPolicy: "ephemeral",
                runClass: "bounded",
                ioMode: "request_response",
                status: "running",
                startedAtMs: 123,
            },
        });

        expect(checkSessionAccess).not.toHaveBeenCalled();
        expect(getSessionParticipantUserIds).not.toHaveBeenCalled();
        expect(emitEphemeral).not.toHaveBeenCalled();
    });

    it("does not broadcast when the socket is scoped to a different session id", async () => {
        const { sessionUpdateHandler } = await import("./sessionUpdateHandler");

        const socket = createFakeSocket();
        (socket as any).data = {
            machineId: "m1",
            sessionScopedBinding: {
                sessionId: "s1",
                machineId: "m1",
                proof: "machine-access-key",
            },
        };
        (socket as any).data = {
            sessionScopedBinding: {
                sessionId: "s1",
                machineId: null,
                proof: "owner-session",
            },
        };
        sessionUpdateHandler(
            "u1",
            socket as any,
            { connectionType: "session-scoped", socket: socket as any, userId: "u1", sessionId: "s1" } as any,
        );

        const handler = getSocketHandler(socket, "execution-run-updated");
        await handler({
            sid: "s2",
            run: {
                runId: "run_1",
                callId: "call_1",
                sidechainId: "call_1",
                intent: "review",
                backendTarget: { kind: "builtInAgent", agentId: "claude" },
                permissionMode: "read_only",
                retentionPolicy: "ephemeral",
                runClass: "bounded",
                ioMode: "request_response",
                status: "running",
                startedAtMs: 123,
            },
        });

        expect(emitEphemeral).toHaveBeenCalledTimes(0);
    });

    it("does not broadcast when the session-scoped socket is not a daemon session socket", async () => {
        const { sessionUpdateHandler } = await import("./sessionUpdateHandler");

        const socket = createFakeSocket();
        sessionUpdateHandler(
            "u1",
            socket as any,
            { connectionType: "session-scoped", socket: socket as any, userId: "u1", sessionId: "s1" } as any,
        );

        const handler = getSocketHandler(socket, "execution-run-updated");
        await handler({
            sid: "s1",
            run: {
                runId: "run_1",
                callId: "call_1",
                sidechainId: "call_1",
                intent: "review",
                backendTarget: { kind: "builtInAgent", agentId: "claude" },
                permissionMode: "read_only",
                retentionPolicy: "ephemeral",
                runClass: "bounded",
                ioMode: "request_response",
                status: "running",
                startedAtMs: 123,
            },
        });

        expect(checkSessionAccess).not.toHaveBeenCalled();
        expect(emitEphemeral).not.toHaveBeenCalled();
    });

    it("requires edit access before broadcasting execution-run-updated", async () => {
        requireAccessLevel.mockReturnValue(false);

        const { sessionUpdateHandler } = await import("./sessionUpdateHandler");

        const socket = createFakeSocket();
        (socket as any).data = {
            machineId: "m1",
            sessionScopedBinding: {
                sessionId: "s1",
                machineId: "m1",
                proof: "machine-access-key",
            },
        };
        sessionUpdateHandler(
            "u1",
            socket as any,
            { connectionType: "session-scoped", socket: socket as any, userId: "u1", sessionId: "s1" } as any,
        );

        const handler = getSocketHandler(socket, "execution-run-updated");
        await handler({
            sid: "s1",
            run: {
                runId: "run_1",
                callId: "call_1",
                sidechainId: "call_1",
                intent: "review",
                backendTarget: { kind: "builtInAgent", agentId: "claude" },
                permissionMode: "read_only",
                retentionPolicy: "ephemeral",
                runClass: "bounded",
                ioMode: "request_response",
                status: "running",
                startedAtMs: 123,
            },
        });

        expect(requireAccessLevel).toHaveBeenCalledWith(
            expect.objectContaining({ level: "view" }),
            "edit",
        );
        expect(emitEphemeral).not.toHaveBeenCalled();
    });

    it("does not broadcast execution-run-updated from a shared editor daemon when the session owner differs", async () => {
        const { sessionUpdateHandler } = await import("./sessionUpdateHandler");

        const socket = createFakeSocket();
        (socket as any).data = {
            machineId: "m1",
            sessionScopedBinding: {
                sessionId: "s1",
                machineId: "m1",
                proof: "machine-access-key",
            },
        };
        sessionUpdateHandler(
            "shared-editor",
            socket as any,
            { connectionType: "session-scoped", socket: socket as any, userId: "shared-editor", sessionId: "s1" } as any,
        );

        const handler = getSocketHandler(socket, "execution-run-updated");
        await handler({
            sid: "s1",
            run: {
                runId: "run_1",
                callId: "call_1",
                sidechainId: "call_1",
                intent: "review",
                backendTarget: { kind: "builtInAgent", agentId: "claude" },
                permissionMode: "read_only",
                retentionPolicy: "ephemeral",
                runClass: "bounded",
                ioMode: "request_response",
                status: "running",
                startedAtMs: 123,
            },
        });

        expect(emitEphemeral).not.toHaveBeenCalled();
    });

    it("strips untrusted extra execution-run fields before rebroadcasting", async () => {
        checkSessionAccess.mockResolvedValue({
            userId: "u1",
            sessionId: "s1",
            level: "edit",
            isOwner: true,
        } as any);

        const { sessionUpdateHandler } = await import("./sessionUpdateHandler");

        const socket = createFakeSocket();
        (socket as any).data = {
            machineId: "m1",
            sessionScopedBinding: {
                sessionId: "s1",
                machineId: "m1",
                proof: "machine-access-key",
            },
        };
        sessionUpdateHandler(
            "u1",
            socket as any,
            { connectionType: "session-scoped", socket: socket as any, userId: "u1", sessionId: "s1" } as any,
        );

        const handler = getSocketHandler(socket, "execution-run-updated");
        await handler({
            sid: "s1",
            run: {
                runId: "run_1",
                callId: "call_1",
                sidechainId: "call_1",
                intent: "review",
                backendTarget: { kind: "builtInAgent", agentId: "claude" },
                permissionMode: "read_only",
                retentionPolicy: "ephemeral",
                runClass: "bounded",
                ioMode: "request_response",
                status: "running",
                startedAtMs: 123,
                injectedFlag: true,
            },
        });

        expect(emitEphemeral).toHaveBeenCalledTimes(2);
        expect(emitEphemeral).toHaveBeenNthCalledWith(1, expect.objectContaining({
            payload: expect.objectContaining({
                run: expect.not.objectContaining({ injectedFlag: true }),
            }),
        }));
    });
});

describe("sessionUpdateHandler (transcript-stream-segment)", () => {
    beforeEach(() => {
        emitEphemeral.mockReset();
        websocketEventsCounterInc.mockReset();
        checkSessionAccess.mockReset();
        requireAccessLevel.mockReset();
        getSessionParticipantUserIds.mockReset();
        accessKeyFindUnique.mockReset();
        accessKeyFindUnique.mockResolvedValue({ machineId: "m1" });
        checkSessionAccess.mockResolvedValue({
            userId: "u1",
            sessionId: "s1",
            level: "edit",
            isOwner: true,
        } as any);
        requireAccessLevel.mockReturnValue(true);
        getSessionParticipantUserIds.mockResolvedValue(["u1", "u2"]);
    });

    it("broadcasts transcript stream segment ephemerals to all session participants", async () => {
        const { sessionUpdateHandler } = await import("./sessionUpdateHandler");

        const socket = createFakeSocket();
        (socket as any).data = {
            machineId: "m1",
            sessionScopedBinding: {
                sessionId: "s1",
                machineId: "m1",
                proof: "machine-access-key",
            },
        };
        const connection = { connectionType: "session-scoped", socket: socket as any, userId: "u1", sessionId: "s1" } as any;
        sessionUpdateHandler("u1", socket as any, connection);

        const handler = socket.handlers.get("transcript-stream-segment");
        expect(handler).toEqual(expect.any(Function));
        if (!handler) return;

        await handler({
            sid: "s1",
            message: {
                localId: "segment-1",
                sidechainId: "tool_1",
                content: {
                    t: "plain",
                    v: {
                        role: "agent",
                        content: {
                            type: "acp",
                            provider: "codex",
                            data: { type: "message", message: "Hello" },
                        },
                        meta: {
                            happierStreamSegmentV1: {
                                v: 1,
                                segmentKind: "assistant",
                                segmentLocalId: "segment-1",
                                segmentState: "streaming",
                                startedAtMs: 1_000,
                                updatedAtMs: 1_010,
                            },
                        },
                    },
                },
                createdAt: 1_000,
                updatedAt: 1_010,
                injectedMessageField: true,
            },
        });

        expect(getSessionParticipantUserIds).toHaveBeenCalledWith({ sessionId: "s1" });
        expect(emitEphemeral).toHaveBeenCalledTimes(2);
        const ownerCall = emitEphemeral.mock.calls
            .map((call) => call[0])
            .find((payload) => payload?.userId === "u1");
        const collaboratorCall = emitEphemeral.mock.calls
            .map((call) => call[0])
            .find((payload) => payload?.userId === "u2");

        expect(ownerCall).toEqual(expect.objectContaining({
            userId: "u1",
            payload: expect.objectContaining({
                type: "transcript-stream-segment",
                sessionId: "s1",
                message: expect.objectContaining({
                    localId: "segment-1",
                    sidechainId: "tool_1",
                }),
            }),
            recipientFilter: { type: "all-interested-in-session", sessionId: "s1" },
        }));
        expect(ownerCall?.payload.message).not.toHaveProperty("injectedMessageField");
        expect(ownerCall?.skipSenderConnection).toBe(connection);
        expect(collaboratorCall?.skipSenderConnection).toBeUndefined();
    });

    it("does not broadcast transcript stream segments without machine-bound session proof", async () => {
        const { sessionUpdateHandler } = await import("./sessionUpdateHandler");

        const socket = createFakeSocket();
        (socket as any).data = {
            sessionScopedBinding: {
                sessionId: "s1",
                machineId: null,
                proof: "owner-session",
            },
        };
        sessionUpdateHandler(
            "u1",
            socket as any,
            { connectionType: "session-scoped", socket: socket as any, userId: "u1", sessionId: "s1" } as any,
        );

        const handler = socket.handlers.get("transcript-stream-segment");
        expect(handler).toEqual(expect.any(Function));
        if (!handler) return;

        await handler({
            sid: "s1",
            message: {
                localId: "segment-1",
                content: { t: "plain", v: { role: "agent", content: { type: "acp", provider: "codex", data: { type: "message", message: "Hello" } } } },
                createdAt: 1_000,
                updatedAt: 1_010,
            },
        });

        expect(checkSessionAccess).not.toHaveBeenCalled();
        expect(getSessionParticipantUserIds).not.toHaveBeenCalled();
        expect(emitEphemeral).not.toHaveBeenCalled();
    });
});
