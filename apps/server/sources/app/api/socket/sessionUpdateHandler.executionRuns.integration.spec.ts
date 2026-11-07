import { beforeEach, describe, expect, it, vi } from "vitest";

import { createFakeSocket, getSocketHandler } from "../testkit/socketHarness";


const emitEphemeral = vi.fn();
const websocketEventsCounterInc = vi.fn();

vi.mock("@/app/monitoring/metrics/index", () => ({
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


vi.mock("@/app/activity/refreshAccountActivityBadgePushes", () => ({
    refreshTrackedSessionAccountBadgePushes: vi.fn(async () => {}),
}));

vi.mock("@/app/activity/accountActivityBadge", () => ({
    didSessionActivityBadgeSignalChange: vi.fn(() => false),
}));



const sessionFindUnique = vi.hoisted(() => vi.fn());
vi.mock("@/storage/db", async importOriginal => ({
    ...await importOriginal<typeof import("@/storage/db")>(),
    db: (await import("../testkit/sessionPublicationDb")).createSessionPublicationDbMock({
        sessionId: "s1",
        readSession: (...args: unknown[]) => sessionFindUnique(...args),
    }),
}));

// SQLite read-only transactions use a dedicated connection rather than db.$transaction.
// Substitute that persistent boundary while retaining the real snapshot and audience owners.
vi.mock("@/storage/prisma", async importOriginal => ({
    ...await importOriginal<typeof import("@/storage/prisma")>(),
    withSqliteReadSnapshot: (await import("../testkit/sessionPublicationDb")).createSessionPublicationDbFixture({
        sessionId: "s1",
        readSession: (...args: unknown[]) => sessionFindUnique(...args),
    }).readSnapshot,
}));

function buildPublicationRow(overrides: Record<string, unknown> = {}) {
    return {
        accountId: "u1",
        shares: [{ id: "share-u2", sharedWithUserId: "u2", accessLevel: "view", canApprovePermissions: false }],
        seq: 5,
        currentStorageState: "hosted",
        acceptedThroughServerSeq: null,
        materializationPublicationId: null,
        materializedThroughSourceAt: null,
        publishedThroughServerSeq: null,
        lastViewedSessionSeq: 5,
        latestReadyEventSeq: null,
        latestReadyEventAt: null,
        createdAt: new Date("2026-08-29T00:00:00Z"),
        updatedAt: new Date("2026-08-29T00:00:00Z"),
        meaningfulActivityAt: null,
        lastActiveAt: new Date("2026-08-29T00:00:00Z"),
        ...overrides,
    };
}


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

// Load the real handler graph during collection, outside the per-event test deadline.
const { sessionUpdateHandler } = await import("./sessionUpdateHandler");

describe("sessionUpdateHandler (execution-run-updated)", () => {
    beforeEach(() => {
        emitEphemeral.mockReset();
        websocketEventsCounterInc.mockReset();
        sessionFindUnique.mockReset();
        sessionFindUnique.mockResolvedValue(buildPublicationRow());
    });

    it("suppresses execution-run-updated for a finite collaborator once the transcript publication is finite", async () => {
        sessionFindUnique.mockResolvedValue(buildPublicationRow({
            currentStorageState: "server_partial",
            acceptedThroughServerSeq: 7,
        }));


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

        expect(sessionFindUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "s1" } }));
        expect(emitEphemeral).toHaveBeenCalledTimes(1);
        expect(emitEphemeral).toHaveBeenCalledWith(expect.objectContaining({
            userId: "u1",
            payload: expect.objectContaining({
                type: "execution-run-updated",
                run: expect.objectContaining({ runId: "run_1", status: "running" }),
            }),
        }));
    });

    it("suppresses execution-run-updated for a collaborator under a malformed non-hosted publication state", async () => {
        sessionFindUnique.mockResolvedValue(buildPublicationRow({
            currentStorageState: "machine_only",
            acceptedThroughServerSeq: null,
        }));


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

        expect(emitEphemeral).toHaveBeenCalledTimes(1);
        expect(emitEphemeral).toHaveBeenCalledWith(expect.objectContaining({ userId: "u1" }));
    });

    it("fails closed without any execution-run-updated delivery when the publication row is unavailable", async () => {
        sessionFindUnique.mockResolvedValue(null);


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

        expect(emitEphemeral).not.toHaveBeenCalled();
    });

    it("broadcasts execution-run-updated ephemeral updates from a daemon session socket to all session participants", async () => {


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

    it("forwards a content-free input turn and refuses one that carries turn text", async () => {
        const socket = createFakeSocket();
        (socket as any).data = {
            machineId: "m1",
            sessionScopedBinding: { sessionId: "s1", machineId: "m1", proof: "machine-access-key" },
        };
        const connection = { connectionType: "session-scoped", socket: socket as any, userId: "u1", sessionId: "s1" } as any;
        sessionUpdateHandler("u1", socket as any, connection);
        const handler = getSocketHandler(socket, "execution-run-updated");
        const turn = { turnId: "turn-1", inputIds: ["input-1"], state: "completed" };
        const frame = (last: Record<string, unknown>) => ({
            sid: "s1",
            run: {
                runId: "run_1",
                callId: "call_1",
                sidechainId: "call_1",
                intent: "agent",
                backendTarget: { kind: "builtInAgent", agentId: "claude" },
                permissionMode: "read_only",
                retentionPolicy: "resumable",
                runClass: "long_lived",
                ioMode: "streaming",
                status: "running",
                startedAtMs: 123,
                inputTurns: { occurrenceId: "occurrence-1", last },
            },
        });

        await handler(frame({ ...turn, result: { kind: "text", value: "agent output" } }));
        expect(emitEphemeral).not.toHaveBeenCalled();

        await handler(frame(turn));
        expect(emitEphemeral).toHaveBeenCalledWith(expect.objectContaining({
            payload: expect.objectContaining({
                run: expect.objectContaining({ inputTurns: { occurrenceId: "occurrence-1", last: turn } }),
            }),
        }));
    });

    it("does not broadcast execution-run-updated without machine-bound session proof even when the sender owns the session", async () => {


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

        expect(emitEphemeral).not.toHaveBeenCalled();
    });

    it("does not broadcast when the socket is scoped to a different session id", async () => {

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

        expect(emitEphemeral).not.toHaveBeenCalled();
    });

    it("strips untrusted extra execution-run fields before rebroadcasting", async () => {


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
        sessionFindUnique.mockReset();
        sessionFindUnique.mockResolvedValue(buildPublicationRow());
    });

    it("broadcasts transcript stream segment ephemerals to all session participants", async () => {

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

        const handler = getSocketHandler(socket, "transcript-stream-segment");
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
                            agentId: "codex",
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
            },
        });

        expect(emitEphemeral).toHaveBeenCalledTimes(2);
        expect(emitEphemeral).toHaveBeenCalledWith(expect.objectContaining({
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
    });
});
