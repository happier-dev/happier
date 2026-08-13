import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeSocket, getSocketHandler } from "../testkit/socketHarness";
import { LockAdmissionDeadlineExceededError } from "@/utils/runtime/lock";
import type { CurrentPublisherResult, PublisherBinding } from "@/app/presence/sessionPublisherPresence";
import type { Tx } from "@/storage/inTx";

const createSessionMessage = vi.fn<(...args: unknown[]) => Promise<unknown>>(async () => ({ ok: false, error: "invalid-params" }));
const updateSessionMetadata = vi.fn(async (): Promise<unknown> => ({ ok: false, error: "internal" }));
const updateSessionAgentState = vi.fn(async (): Promise<unknown> => ({ ok: false, error: "internal" }));
const applySessionTurnMutation = vi.fn(async (): Promise<unknown> => ({ ok: false, error: "internal" }));
const applySessionReadCursorOperation = vi.fn(async (): Promise<unknown> => ({ ok: false, error: "internal" }));
const materializeNextPendingMessage = vi.fn(async (): Promise<unknown> => ({ ok: false, error: "internal" }));
const materializeNextPendingMessageForCurrentPublisher = vi.fn(async (): Promise<unknown> => ({ ok: false, error: "internal" }));
const readSessionPendingState = vi.fn(async (): Promise<unknown> => ({ ok: true, pendingCount: 0, pendingVersion: 0 }));
const refreshSessionParticipantBadgePushes = vi.fn(async (): Promise<unknown> => undefined);
const authorizeSessionRelayPublish = vi.fn(async (): Promise<readonly string[] | null> => ["user-1"]);
const currentPublisher: Extract<CurrentPublisherResult, { status: "current" }> = {
    status: "current" as const,
    runtimeActivityProjectionRead: { status: "invalid" as const, revision: null },
    committedFence: new Date(1_000),
    sessionUpdatedAt: new Date(1_000),
};
// The database transaction is the system boundary mocked by this socket-owner test; the
// materialization service itself is mocked below and never reads from this fixture.
const transactionClientFixture = {} as Tx;
const resolveCurrentPublisher = vi.fn(async () => currentPublisher);
const runAsCurrentPublisher = async <T>(params: {
    action: (publisher: typeof currentPublisher) => Promise<T>;
}) => ({
    status: "current" as const,
    value: await params.action(currentPublisher),
});
const runAsCurrentPublisherInTx = async <T>(params: {
    socket: object;
    binding: PublisherBinding;
    deadlineAtMs: number;
    action: (publisher: typeof currentPublisher, tx: Tx) => Promise<T>;
}) => ({
    status: "current" as const,
    value: await params.action(currentPublisher, transactionClientFixture),
});
const sessionMessageFindUnique = vi.fn(async (): Promise<unknown> => null);
const coordinateAcceptedPendingSettlement = vi.fn(async (): Promise<unknown> => ({ ok: false, error: "internal" }));
const emitEphemeral = vi.fn();
const emitUpdate = vi.fn();
const buildNewMessageUpdate = vi.fn((_message: unknown, _sessionId: string, seq: number, updateId: string) => ({
    id: updateId,
    seq,
    body: { t: "new-message" },
}));
const buildMessageUpdatedUpdate = vi.fn((_message: unknown, _sessionId: string, seq: number, updateId: string) => ({
    id: updateId,
    seq,
    body: { t: "message-updated" },
}));
const buildPendingChangedUpdate = vi.fn((_pendingState: unknown, seq: number, updateId: string) => ({
    id: updateId,
    seq,
    body: { t: "pending-changed" },
}));
const buildUpdateSessionUpdate = vi.fn(
    (_sessionId: string, seq: number, updateId: string, _metadata: unknown, _agentState: unknown, projection?: unknown) => ({
        id: updateId,
        seq,
        body: { t: "update-session", ...(projection && typeof projection === "object" ? projection : {}) },
    }),
);
vi.mock("@/app/session/sessionWriteService", () => ({
    createSessionMessage,
    updateSessionMetadata,
    updateSessionAgentState,
    applySessionTurnMutation,
    applySessionReadCursorOperation,
}));
vi.mock("@/app/activity/refreshAccountActivityBadgePushes", () => ({
    refreshSessionParticipantBadgePushes,
}));
vi.mock("./sessionRelayAuthCache", () => ({ authorizeSessionRelayPublish }));
vi.mock("@/storage/db", () => ({
    db: { sessionMessage: { findUnique: sessionMessageFindUnique } },
}));
vi.mock("@/app/session/pending/acceptedPendingSettlementCoordinator", () => ({
    coordinateAcceptedPendingSettlement,
}));
vi.mock("@/app/session/pending/pendingMessageService", async (importOriginal) => {
    const actual = await importOriginal<typeof import("@/app/session/pending/pendingMessageService")>();
    return {
        ...actual,
        materializeNextPendingMessage,
        materializeNextPendingMessageForCurrentPublisher,
        materializeNextPendingMessageForCurrentPublisherInTx: materializeNextPendingMessageForCurrentPublisher,
        mapPendingMaterializationError: (error: unknown) => ({ ok: false, error: "internal", cause: error }),
        readSessionPendingState,
    };
});
vi.mock("@/app/events/eventRouter", () => ({
    eventRouter: {
        emitEphemeral,
        emitUpdate,
    },
    buildMessageUpdatedUpdate,
    buildNewMessageUpdate,
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

const getSessionParticipantUserIds = vi.fn(async () => ["user-1"]);
vi.mock("@/app/share/sessionParticipants", () => ({
    getSessionParticipantUserIds,
}));
const markAccountChanged = vi.fn(async () => 1);
vi.mock("@/app/changes/markAccountChanged", () => ({ markAccountChanged }));
const isSessionValid = vi.fn(async () => true);
vi.mock("@/app/presence/sessionCache", () => ({
    activityCache: { isSessionValid },
}));
vi.mock("@/storage/inTx", () => ({
    inTx: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => await fn({})),
}));
const log = vi.fn();
vi.mock("@/utils/logging/log", () => ({ log }));

describe("sessionUpdateHandler", () => {
    type TrustedPublisher = Parameters<typeof import("./sessionUpdateHandler").sessionUpdateHandler>[3];
    let registerSessionUpdateHandler: (
        userId: string,
        socket: any,
        connection: any,
        trustedPublisher?: TrustedPublisher,
    ) => void;

    beforeAll(async () => {
        ({ sessionUpdateHandler: registerSessionUpdateHandler } = await import("./sessionUpdateHandler"));
    }, 120_000);

    beforeEach(() => {
        createSessionMessage.mockClear();
        updateSessionMetadata.mockClear();
        updateSessionAgentState.mockClear();
        applySessionTurnMutation.mockClear();
        applySessionReadCursorOperation.mockClear();
        materializeNextPendingMessage.mockClear();
        materializeNextPendingMessageForCurrentPublisher.mockClear();
        readSessionPendingState.mockClear();
        readSessionPendingState.mockResolvedValue({ ok: true, pendingCount: 0, pendingVersion: 0 });
        refreshSessionParticipantBadgePushes.mockClear();
        refreshSessionParticipantBadgePushes.mockResolvedValue(undefined);
        authorizeSessionRelayPublish.mockReset();
        authorizeSessionRelayPublish.mockResolvedValue(["user-1"]);
        resolveCurrentPublisher.mockReset();
        resolveCurrentPublisher.mockResolvedValue(currentPublisher);
        sessionMessageFindUnique.mockReset();
        sessionMessageFindUnique.mockResolvedValue(null);
        coordinateAcceptedPendingSettlement.mockReset();
        coordinateAcceptedPendingSettlement.mockResolvedValue({ ok: false, error: "internal" });
        emitEphemeral.mockClear();
        emitUpdate.mockClear();
        buildNewMessageUpdate.mockClear();
        buildMessageUpdatedUpdate.mockClear();
        buildPendingChangedUpdate.mockClear();
        buildUpdateSessionUpdate.mockClear();
        checkSessionAccess.mockClear();
        requireAccessLevel.mockClear();
        getSessionParticipantUserIds.mockClear();
        markAccountChanged.mockReset();
        markAccountChanged.mockResolvedValue(1);
        isSessionValid.mockClear();
        isSessionValid.mockResolvedValue(true);
        log.mockClear();
    });

    it("settles accepted Pending only through the exact current machine-bound publisher socket", async () => {
        coordinateAcceptedPendingSettlement.mockResolvedValueOnce({
            ok: true,
            didResolve: true,
            pendingCount: 0,
            pendingBlockedCount: 0,
            pendingVersion: 9,
            message: {
                id: "message-1",
                seq: 43,
                localId: "pending-1",
                messageRole: "user",
                content: { t: "plain", v: { role: "user", content: { type: "text", text: "accepted" } } },
                createdAt: new Date(1_000),
                updatedAt: new Date(1_000),
            },
            participantCursors: [],
            participantCursorsPending: [],
            participantCursorsMessage: [],
            badgeAttentionChanged: false,
        });
        const socket = createFakeSocket();
        const connection = { connectionType: "session-scoped", socket, userId: "user-1", sessionId: "s-1" } as any;
        registerSessionUpdateHandler("user-1", socket as any, connection, {
            presence: { resolveCurrentPublisher, runAsCurrentPublisher, runAsCurrentPublisherInTx },
            binding: { accountId: "user-1", machineId: "machine-1", sessionId: "s-1" },
        });
        const callback = vi.fn();

        await getSocketHandler(socket, "pending-delivery-accepted-v1")({
            v: 1,
            sessionId: "s-1",
            localId: "pending-1",
        }, callback);

        expect(coordinateAcceptedPendingSettlement).toHaveBeenCalledWith(expect.objectContaining({
            actorUserId: "user-1",
            sessionId: "s-1",
            localId: "pending-1",
            trustedPublisherFence: {
                accountId: "user-1",
                machineId: "machine-1",
                sessionId: "s-1",
                committedFence: new Date(1_000),
            },
        }));
        expect(callback).toHaveBeenCalledWith(expect.objectContaining({
            ok: true,
            didResolve: true,
            pendingVersion: 9,
            message: expect.objectContaining({ id: "message-1", seq: 43, localId: "pending-1" }),
        }));
    });

    it("rejects accepted settlement when current publisher authority is unavailable", async () => {
        const socket = createFakeSocket();
        const connection = { connectionType: "session-scoped", socket, userId: "user-1", sessionId: "s-1" } as any;
        registerSessionUpdateHandler("user-1", socket as any, connection, {
            presence: {
                resolveCurrentPublisher,
                runAsCurrentPublisher: vi.fn(async () => ({ status: "superseded" as const })),
            },
            binding: { accountId: "user-1", machineId: "machine-1", sessionId: "s-1" },
        });
        const callback = vi.fn();

        await getSocketHandler(socket, "pending-delivery-accepted-v1")({
            v: 1,
            sessionId: "s-1",
            localId: "pending-1",
        }, callback);

        expect(callback).toHaveBeenCalledWith({ ok: false, error: "forbidden" });
        expect(coordinateAcceptedPendingSettlement).not.toHaveBeenCalled();
    });

    it("positively negotiates transcript observation only for the current machine-bound session producer", async () => {
        const socket = createFakeSocket();
        const connection = { connectionType: "session-scoped", socket, userId: "user-1", sessionId: "s-1" } as any;
        registerSessionUpdateHandler("user-1", socket as any, connection, {
            presence: { resolveCurrentPublisher },
            binding: { accountId: "user-1", machineId: "machine-1", sessionId: "s-1" },
        });
        const callback = vi.fn();

        await getSocketHandler(socket, "transcript-observation-capability-v1")(
            { v: 1, sessionId: "s-1" },
            callback,
        );

        expect(authorizeSessionRelayPublish).toHaveBeenCalledWith({ socket, connection, userId: "user-1", sessionId: "s-1" });
        expect(callback).toHaveBeenCalledWith({ ok: true, capability: "session-transcript-observation-v1" });
    });

    it("rejects transcript observation negotiation from a stale or replaced runtime producer", async () => {
        authorizeSessionRelayPublish.mockResolvedValueOnce(null);
        const socket = createFakeSocket();
        const connection = { connectionType: "session-scoped", socket, userId: "user-1", sessionId: "s-1" } as any;
        registerSessionUpdateHandler("user-1", socket as any, connection, {
            presence: { resolveCurrentPublisher },
            binding: { accountId: "user-1", machineId: "machine-1", sessionId: "s-1" },
        });
        const callback = vi.fn();

        await getSocketHandler(socket, "transcript-observation-capability-v1")(
            { v: 1, sessionId: "s-1" },
            callback,
        );

        expect(callback).toHaveBeenCalledWith({ ok: false, error: "forbidden" });
        expect(createSessionMessage).not.toHaveBeenCalled();
    });

    it("durably ingests authorized output while its referenced Pending input remains unresolved", async () => {
        sessionMessageFindUnique.mockResolvedValueOnce(null);
        createSessionMessage.mockResolvedValueOnce({
            ok: true,
            didWrite: true,
            didUpdate: false,
            message: { id: "assistant-row", seq: 8, localId: "assistant-1" },
            participantCursors: [],
            badgeAttentionChanged: false,
        });
        const socket = createFakeSocket();
        registerSessionUpdateHandler(
            "user-1",
            socket as any,
            { connectionType: "session-scoped", socket, userId: "user-1", sessionId: "s-1" } as any,
            {
                presence: { resolveCurrentPublisher },
                binding: { accountId: "user-1", machineId: "machine-1", sessionId: "s-1" },
            },
        );
        const callback = vi.fn();
        const content = { t: "plain", v: { role: "agent", content: { type: "text", text: "visible now" } } };

        await getSocketHandler(socket, "transcript-observation-v1")({
            v: 1,
            sessionId: "s-1",
            localId: "assistant-1",
            messageRole: "agent",
            content,
            createdAt: 1234,
            updatedAt: 1567,
            provenance: { kind: "non_dependent", source: "history" },
        }, callback);

        expect(authorizeSessionRelayPublish).toHaveBeenCalledWith(expect.objectContaining({
            userId: "user-1",
            sessionId: "s-1",
        }));
        expect(createSessionMessage).toHaveBeenCalledWith(expect.objectContaining({
            actorUserId: "user-1",
            sessionId: "s-1",
            content,
            localId: "assistant-1",
            trustedPublisherFence: {
                accountId: "user-1",
                machineId: "machine-1",
                sessionId: "s-1",
                committedFence: new Date(1_000),
            },
            trustedSourceTimestamps: { createdAt: 1234, updatedAt: 1567 },
            trustedTranscriptObservationProvenance: { kind: "non_dependent", source: "history" },
        }));
        expect(callback).toHaveBeenCalledWith(expect.objectContaining({
            ok: true,
            status: "observed",
            localId: "assistant-1",
            ingestedAt: expect.any(Number),
        }));
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
        createSessionMessage.mockResolvedValueOnce({ ok: false, error: "invalid-params" });
        const socket = createFakeSocket();

        registerSessionUpdateHandler(
            "user-1",
            socket as any,
            { connectionType: "session-scoped", socket: socket as any, userId: "user-1", sessionId: "s-1" } as any,
        );

        const handler = getSocketHandler(socket, "message");
        await handler({ sid: "s-1", message: { t: "plain", v: { type: "user", text: "hi" } } }, vi.fn());

        expect(log).not.toHaveBeenCalledWith(
            expect.objectContaining({ module: "websocket" }),
            expect.stringContaining("Received message from socket"),
        );
    });

    it("rejects the released UI v0.2.0 direct-user payload with client-upgrade-required before effects", async () => {
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

        expect(callback).toHaveBeenCalledWith({ ok: false, error: "client-upgrade-required" });
        expect(createSessionMessage).not.toHaveBeenCalled();
    });

    it("keeps a padded sentFrom value on the ordinary transcript mutation path", async () => {
        const socket = createFakeSocket();

        registerSessionUpdateHandler(
            "user-1",
            socket,
            { connectionType: "session-scoped", socket, userId: "user-1", sessionId: "s-1" },
        );

        const callback = vi.fn();
        await getSocketHandler(socket, "message")({
            sid: "s-1",
            message: "encrypted-payload",
            localId: "local-user-1",
            sentFrom: " web ",
            permissionMode: "default",
        }, callback);

        expect(createSessionMessage).toHaveBeenCalledOnce();
        expect(callback).toHaveBeenCalledWith({ ok: false, error: "invalid-params" });
    });

    it("rejects a whitespace-only sid as invalid params rather than as the released UI vector", async () => {
        const socket = createFakeSocket();

        registerSessionUpdateHandler(
            "user-1",
            socket,
            { connectionType: "user-scoped", socket, userId: "user-1" } as any,
        );

        const callback = vi.fn();
        await getSocketHandler(socket, "message")({
            sid: "   ",
            message: "encrypted-payload",
            localId: "local-user-1",
            sentFrom: "web",
            permissionMode: "default",
        }, callback);

        expect(createSessionMessage).not.toHaveBeenCalled();
        expect(callback).toHaveBeenCalledWith({ ok: false, error: "invalid-params" });
    });

    it("accepts the neighboring explicit-role mutation instead of classifying it as released UI v0.2.0", async () => {
        const createdAt = new Date("2020-01-01T00:00:00.000Z");
        createSessionMessage.mockResolvedValueOnce({
            ok: true,
            didWrite: true,
            didUpdate: false,
            message: {
                id: "m-agent",
                seq: 10,
                localId: "local-agent-1",
                sidechainId: null,
                content: { t: "encrypted", c: "encrypted-payload" },
                createdAt,
                updatedAt: createdAt,
            },
            participantCursors: [],
            badgeAttentionChanged: false,
            readyProjection: null,
        });
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
            localId: "local-agent-1",
            messageRole: "agent",
            sentFrom: "web",
            permissionMode: "default",
        }, callback);

        expect(createSessionMessage).toHaveBeenCalledWith({
            actorUserId: "user-1",
            sessionId: "s-1",
            content: { t: "encrypted", c: "encrypted-payload" },
            localId: "local-agent-1",
            sidechainId: null,
            messageRole: "agent",
        });
        expect(callback).toHaveBeenCalledWith({
            ok: true,
            id: "m-agent",
            seq: 10,
            localId: "local-agent-1",
            didWrite: true,
        });
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

    it("releases the message socket lock without awaiting badge push refresh work", async () => {
        let resolveBadgeRefresh: (() => void) | undefined;
        refreshSessionParticipantBadgePushes.mockImplementationOnce(
            () => new Promise<void>((resolve) => {
                resolveBadgeRefresh = resolve;
            }),
        );
        createSessionMessage.mockResolvedValueOnce({
            ok: true,
            didWrite: true,
            didUpdate: false,
            message: {
                id: "m-1",
                seq: 10,
                content: { t: "plain", v: { type: "user", text: "hi" } },
                localId: "local-1",
                createdAt: 1_000,
                updatedAt: 1_000,
            },
            participantCursors: [{ accountId: "user-1", cursor: 11 }],
            badgeAttentionChanged: true,
            readyProjection: null,
        });
        const socket = createFakeSocket();

        registerSessionUpdateHandler(
            "user-1",
            socket as any,
            { connectionType: "session-scoped", socket: socket as any, userId: "user-1", sessionId: "s-1" } as any,
        );

        const handler = getSocketHandler(socket, "message");
        const callback = vi.fn();
        const handlerPromise = Promise.resolve(handler({
            sid: "s-1",
            message: { t: "plain", v: { type: "user", text: "hi" } },
            localId: "local-1",
        }, callback));
        await vi.waitFor(() => {
            expect(callback).toHaveBeenCalledWith(expect.objectContaining({ ok: true, id: "m-1", seq: 10 }));
        });

        let settled = false;
        handlerPromise.then(() => {
            settled = true;
        });
        await Promise.resolve();

        expect(refreshSessionParticipantBadgePushes).toHaveBeenCalledWith({
            badgeAttentionChanged: true,
            participantCursors: [{ accountId: "user-1", cursor: 11 }],
        });
        expect(settled).toBe(true);

        resolveBadgeRefresh?.();
        await handlerPromise;
    });


    it("ignores runtimeIssueSummaryV1 and still updates agent state", async () => {
        updateSessionAgentState.mockResolvedValueOnce({
            ok: true,
            agentState: "{}",
            version: 2,
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
            agentState: "{}",
            expectedVersion: 1,
            runtimeIssueSummaryV1: {
                latestTurnStatus: "failed",
                lastRuntimeIssue: {
                    v: 1,
                    scope: "primary_session",
                    status: "failed",
                    code: "auth_error",
                    source: "auth_error",
                    occurredAt: 123,
                    provider: "codex",
                    sanitizedPreview: "Authentication failed",
                },
            },
        }, callback);

        expect(updateSessionAgentState).toHaveBeenCalledWith({
            actorUserId: "user-1",
            sessionId: "s-1",
            expectedVersion: 1,
            agentStateCiphertext: "{}",
        });
        expect(callback).toHaveBeenCalledWith({ result: "success", version: 2, agentState: "{}" });
    });

    it("does not register system-record writes as a session socket mutation", () => {
        const socket = createFakeSocket();

        registerSessionUpdateHandler(
            "user-1",
            socket as any,
            { connectionType: "session-scoped", socket: socket as any, userId: "user-1", sessionId: "s-1" } as any,
        );

        expect(socket.handlers.has("upsert-system-record")).toBe(false);
    });

    it("applies session turn socket mutations and fans out materialized updates", async () => {
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
            action: "complete",
            turnId: "turn-1",
            provider: "codex",
            providerTurnId: "turn-1",
            observedAt: 123,
        }, callback);

        expect(applySessionTurnMutation).toHaveBeenCalledWith({
            actorUserId: "user-1",
            mutation: {
                v: 1,
                sessionId: "s-1",
                mutationId: "mutation-1",
                action: "complete",
                turnId: "turn-1",
                provider: "codex",
                providerTurnId: "turn-1",
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

    it("returns the canonical non-positive exact receipt without making it positive", async () => {
        applySessionTurnMutation.mockResolvedValueOnce({
            ok: true,
            didApply: false,
            reason: "missing-turn",
            receipt: {
                v: 1,
                sessionId: "s-1",
                mutationId: "exact-end-missing",
                turnId: "turn-1",
                action: "end_session",
                decision: "missing-turn",
                observedAt: 123,
                appliedAt: 124,
            },
            latestTurnId: null,
            latestTurnStatus: null,
            latestTurnStatusObservedAt: null,
            lastRuntimeIssue: null,
            participantCursors: [],
            badgeAttentionChanged: false,
        });
        const socket = createFakeSocket();

        registerSessionUpdateHandler(
            "user-1",
            socket as any,
            { connectionType: "session-scoped", socket: socket as any, userId: "user-1", sessionId: "s-1" } as any,
        );

        const callback = vi.fn();
        await getSocketHandler(socket, "session-turn-mutation")({
            v: 1,
            sessionId: "s-1",
            mutationId: "exact-end-missing",
            action: "end_session",
            turnId: "turn-1",
            observedAt: 123,
        }, callback);

        expect(callback).toHaveBeenCalledWith({
            result: "success",
            applied: false,
            reason: "missing-turn",
            receipt: expect.objectContaining({ decision: "missing-turn", turnId: "turn-1" }),
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
            action: "begin",
            turnId: "turn-1",
            provider: "codex",
            providerTurnId: "turn-1",
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

    it("forwards ready event hints so the message write service can apply owner-only validation", async () => {
        const createdAt = new Date("2020-01-01T00:00:00.000Z");
        createSessionMessage.mockResolvedValueOnce({
            ok: true,
            didWrite: true,
            didUpdate: false,
            message: {
                id: "m-ready",
                seq: 10,
                localId: "ready-local",
                sidechainId: null,
                content: { t: "plain", v: { type: "event" } },
                createdAt,
                updatedAt: createdAt,
            },
            participantCursors: [{ accountId: "user-1", cursor: 10 }],
            badgeAttentionChanged: false,
        });
        const socket = createFakeSocket();

        registerSessionUpdateHandler(
            "user-1",
            socket as any,
            { connectionType: "session-scoped", socket: socket as any, userId: "user-1", sessionId: "s-1" } as any,
        );

        const handler = getSocketHandler(socket, "message");
        const callback = vi.fn();
        await handler({
            sid: "s-1",
            message: { t: "plain", v: { type: "event" } },
            localId: "ready-local",
            sessionEventType: "ready",
        }, callback);

        expect(createSessionMessage).toHaveBeenCalledWith(expect.objectContaining({
            actorUserId: "user-1",
            sessionId: "s-1",
            content: { t: "plain", v: { type: "event" } },
            localId: "ready-local",
            trustedSessionEventType: "ready",
        }));
        expect(buildNewMessageUpdate).toHaveBeenCalledWith(expect.anything(), "s-1", 10, expect.any(String));
        expect(buildUpdateSessionUpdate).not.toHaveBeenCalled();
        expect(emitUpdate).toHaveBeenCalledTimes(1);
        expect(callback).toHaveBeenCalledWith(expect.objectContaining({ ok: true, didWrite: true }));
    });

    it("does not forward caller-supplied attention overrides from the public socket event", async () => {
        const createdAt = new Date("2020-01-01T00:00:00.000Z");
        createSessionMessage.mockResolvedValueOnce({
            ok: true,
            didWrite: true,
            didUpdate: false,
            message: {
                id: "m-user",
                seq: 10,
                localId: "local-user-1",
                sidechainId: null,
                content: { t: "plain", v: { type: "user", text: "hi" } },
                createdAt,
                updatedAt: createdAt,
            },
            participantCursors: [{ accountId: "user-1", cursor: 10 }],
            badgeAttentionChanged: false,
        });
        const socket = createFakeSocket();

        registerSessionUpdateHandler(
            "user-1",
            socket as any,
            { connectionType: "session-scoped", socket: socket as any, userId: "user-1", sessionId: "s-1" } as any,
        );

        const handler = getSocketHandler(socket, "message");
        const callback = vi.fn();
        await handler({
            sid: "s-1",
            message: { t: "plain", v: { type: "user", text: "hi" } },
            localId: "local-user-1",
            attentionImpact: {
                affectsUnread: false,
                affectsMeaningfulActivity: false,
            },
            affectsUnread: false,
        }, callback);

        expect(createSessionMessage).toHaveBeenCalledWith({
            actorUserId: "user-1",
            sessionId: "s-1",
            content: { t: "plain", v: { type: "user", text: "hi" } },
            localId: "local-user-1",
            sidechainId: null,
        });
        expect(callback).toHaveBeenCalledWith(expect.objectContaining({ ok: true, didWrite: true }));
    });

    it("fails omitted socket materialization closed without invoking either Pending materializer", async () => {
        materializeNextPendingMessage.mockResolvedValueOnce({
            ok: true,
            didMaterialize: false,
            pendingCount: 1,
            pendingBlockedCount: 0,
            pendingVersion: 1,
        });
        const socket = createFakeSocket();

        registerSessionUpdateHandler(
            "user-1",
            socket as any,
            { connectionType: "session-scoped", socket: socket as any, userId: "user-1", sessionId: "s-omitted" } as any,
        );

        const handler = getSocketHandler(socket, "pending-materialize-next");
        const callback = vi.fn();
        await handler({ sid: "s-omitted" }, callback);

        expect(callback).toHaveBeenCalledWith({ ok: false, error: "forbidden" });
        expect(materializeNextPendingMessage).not.toHaveBeenCalled();
        expect(materializeNextPendingMessageForCurrentPublisher).not.toHaveBeenCalled();
        expect(buildNewMessageUpdate).not.toHaveBeenCalled();
        expect(buildPendingChangedUpdate).not.toHaveBeenCalled();
    });

    it("emits pending-changed when socket materialization blocks stale provider delivery without writing a message", async () => {
        materializeNextPendingMessageForCurrentPublisher.mockResolvedValueOnce({
            ok: true,
            didMaterialize: false,
            pendingCount: 1,
            pendingBlockedCount: 1,
            pendingVersion: 8,
            pendingStateChanged: true,
            participantCursorsPending: [{ accountId: "user-1", cursor: 30 }],
            badgeAttentionChanged: false,
            deliveryState: { mode: "provider", unresolved: false },
        });
        const socket = createFakeSocket();

        registerSessionUpdateHandler(
            "user-1",
            socket as any,
            { connectionType: "session-scoped", socket: socket as any, userId: "user-1", sessionId: "s-stale-provider" } as any,
            {
                presence: { resolveCurrentPublisher, runAsCurrentPublisher, runAsCurrentPublisherInTx },
                binding: { accountId: "user-1", machineId: "machine-1", sessionId: "s-stale-provider" },
            },
        );

        const handler = getSocketHandler(socket, "pending-materialize-next");
        const callback = vi.fn();
        await handler({
            sid: "s-stale-provider",
            deliveryState: "provider",
            deliveryTiming: "after_foreground_ready",
            foregroundState: "ready",
        }, callback);

        expect(callback).toHaveBeenCalledWith({
            ok: true,
            didMaterialize: false,
            pendingCount: 1,
            pendingBlockedCount: 1,
            pendingVersion: 8,
            deliveryState: { mode: "provider", unresolved: false },
        });
        expect(buildPendingChangedUpdate).toHaveBeenCalledWith(
            expect.objectContaining({
                sessionId: "s-stale-provider",
                pendingCount: 1,
                pendingBlockedCount: 1,
                pendingVersion: 8,
                changedByAccountId: "user-1",
            }),
            30,
            expect.any(String),
        );
        expect(emitUpdate).toHaveBeenCalledTimes(1);
    });

    it("passes provider delivery-state opt-in through socket pending materialization", async () => {
        materializeNextPendingMessageForCurrentPublisher.mockResolvedValueOnce({
            ok: true,
            didMaterialize: true,
            didWriteMessage: false,
            message: {
                id: null,
                seq: null,
                localId: "pending-provider",
                messageRole: "user",
                content: { t: "plain", v: { type: "user", text: "hello" } },
                requestedAction: { v: 1, kind: "enqueue" },
                providerAction: "send",
                createdAt: new Date(1_000),
                updatedAt: new Date(1_000),
            },
            pendingCount: 1,
            pendingVersion: 8,
            deliveryState: {
                mode: "provider",
                unresolved: true,
            },
            participantCursorsMessage: [],
            participantCursorsPending: [],
            badgeAttentionChanged: false,
        });
        const socket = createFakeSocket();

        registerSessionUpdateHandler(
            "user-1",
            socket as any,
            { connectionType: "session-scoped", socket: socket as any, userId: "user-1", sessionId: "s-provider" } as any,
            {
                presence: { resolveCurrentPublisher, runAsCurrentPublisher, runAsCurrentPublisherInTx },
                binding: { accountId: "user-1", machineId: "machine-1", sessionId: "s-provider" },
            },
        );

        const handler = getSocketHandler(socket, "pending-materialize-next");
        const callback = vi.fn();
        await handler({
            sid: "s-provider",
            deliveryState: "provider",
            deliveryTiming: "after_foreground_ready",
            foregroundState: "ready",
        }, callback);

        expect(materializeNextPendingMessageForCurrentPublisher).toHaveBeenCalledWith({
            tx: {},
            actorUserId: "user-1",
            sessionId: "s-provider",
            deliveryTiming: "after_foreground_ready",
            foregroundState: "ready",
            trustedPublisherFence: {
                accountId: "user-1",
                machineId: "machine-1",
                sessionId: "s-provider",
                committedFence: currentPublisher.committedFence,
            },
        });
        expect(materializeNextPendingMessage).not.toHaveBeenCalled();
        expect(callback).toHaveBeenCalledWith(expect.objectContaining({
            ok: true,
            didMaterialize: true,
            didWrite: false,
            pendingCount: 1,
            pendingVersion: 8,
            deliveryState: {
                mode: "provider",
                unresolved: true,
            },
            message: expect.objectContaining({
                id: null,
                seq: null,
                localId: "pending-provider",
            }),
        }));
        expect(buildNewMessageUpdate).not.toHaveBeenCalled();
    });

    it("returns typed transaction unavailability before the ACK deadline when the socket mutation queue is held and never starts materialization later", async () => {
        vi.useFakeTimers();
        vi.setSystemTime(1_000);
        try {
            let releaseMessage!: () => void;
            createSessionMessage.mockImplementationOnce(async () => await new Promise((resolve) => {
                releaseMessage = () => resolve({ ok: false, error: "invalid-params" });
            }));
            const socket = createFakeSocket();
            registerSessionUpdateHandler(
                "user-1",
                socket as any,
                { connectionType: "session-scoped", socket: socket as any, userId: "user-1", sessionId: "s-budget" } as any,
                {
                    presence: { resolveCurrentPublisher, runAsCurrentPublisher, runAsCurrentPublisherInTx },
                    binding: { accountId: "user-1", machineId: "machine-1", sessionId: "s-budget" },
                },
            );

            const heldMessage = getSocketHandler(socket, "message")({
                sid: "s-budget",
                message: { t: "plain", v: { type: "agent", text: "held" } },
            }, vi.fn());
            await vi.advanceTimersByTimeAsync(0);

            const callback = vi.fn();
            const materialization = getSocketHandler(socket, "pending-materialize-next")({
                sid: "s-budget",
                deliveryState: "provider",
                deliveryTiming: "after_foreground_ready",
                foregroundState: "ready",
            }, callback);

            await vi.advanceTimersByTimeAsync(9_500);
            const callbackAtDeadline = callback.mock.calls.map((call) => call[0]);
            const materializerCallsAtDeadline = materializeNextPendingMessageForCurrentPublisher.mock.calls.length;

            releaseMessage();
            await vi.runAllTimersAsync();
            await Promise.all([heldMessage, materialization]);
            expect(callbackAtDeadline).toContainEqual({
                ok: false,
                error: "transaction-unavailable",
                retryAfterMs: expect.any(Number),
            });
            expect(materializerCallsAtDeadline).toBe(0);
            expect(materializeNextPendingMessageForCurrentPublisher).not.toHaveBeenCalled();
        } finally {
            vi.useRealTimers();
        }
    });

    it("returns typed transaction unavailability when the publisher queue admission deadline expires", async () => {
        const deadlinePresence = {
            resolveCurrentPublisher,
            runAsCurrentPublisher,
            runAsCurrentPublisherInTx: vi.fn(async () => {
                throw new LockAdmissionDeadlineExceededError();
            }),
        };
        const socket = createFakeSocket();
        registerSessionUpdateHandler(
            "user-1",
            socket as any,
            { connectionType: "session-scoped", socket: socket as any, userId: "user-1", sessionId: "s-publisher-budget" } as any,
            {
                presence: deadlinePresence,
                binding: { accountId: "user-1", machineId: "machine-1", sessionId: "s-publisher-budget" },
            },
        );

        const callback = vi.fn();
        await getSocketHandler(socket, "pending-materialize-next")({
            sid: "s-publisher-budget",
            deliveryState: "provider",
            deliveryTiming: "after_foreground_ready",
            foregroundState: "ready",
        }, callback);

        expect(callback).toHaveBeenCalledWith({
            ok: false,
            error: "transaction-unavailable",
            retryAfterMs: 1_000,
        });
        expect(materializeNextPendingMessageForCurrentPublisher).not.toHaveBeenCalled();
    });

    it("passes runtime-idle delivery timing through socket pending materialization", async () => {
        materializeNextPendingMessageForCurrentPublisher.mockResolvedValueOnce({
            ok: true,
            didMaterialize: false,
            pendingCount: 1,
            pendingBlockedCount: 0,
            pendingVersion: 8,
            deferredReason: "waiting_for_runtime_activity",
        });
        const socket = createFakeSocket();

        registerSessionUpdateHandler(
            "user-1",
            socket as any,
            { connectionType: "session-scoped", socket: socket as any, userId: "user-1", sessionId: "s-runtime-idle" } as any,
            {
                presence: { resolveCurrentPublisher, runAsCurrentPublisher, runAsCurrentPublisherInTx },
                binding: { accountId: "user-1", machineId: "machine-1", sessionId: "s-runtime-idle" },
            },
        );

        const handler = getSocketHandler(socket, "pending-materialize-next");
        const callback = vi.fn();
        await handler({
            sid: "s-runtime-idle",
            deliveryState: "provider",
            deliveryTiming: "after_runtime_idle",
            foregroundState: "ready",
        }, callback);

        expect(materializeNextPendingMessageForCurrentPublisher).toHaveBeenCalledWith({
            tx: {},
            actorUserId: "user-1",
            sessionId: "s-runtime-idle",
            deliveryTiming: "after_runtime_idle",
            foregroundState: "ready",
            trustedPublisherFence: {
                accountId: "user-1",
                machineId: "machine-1",
                sessionId: "s-runtime-idle",
                committedFence: currentPublisher.committedFence,
            },
        });
        expect(callback).toHaveBeenCalledWith({
            ok: true,
            didMaterialize: false,
            pendingCount: 1,
            pendingBlockedCount: 0,
            pendingVersion: 8,
            deferredReason: "waiting_for_runtime_activity",
        });
    });

    it.each([null, "", "after_everything", 42])(
        "rejects an explicitly malformed socket delivery timing: %j",
        async (deliveryTiming) => {
            const socket = createFakeSocket();
            registerSessionUpdateHandler(
                "user-1",
                socket as any,
                { connectionType: "session-scoped", socket: socket as any, userId: "user-1", sessionId: "s-invalid-timing" } as any,
                {
                    presence: { resolveCurrentPublisher, runAsCurrentPublisher, runAsCurrentPublisherInTx },
                    binding: { accountId: "user-1", machineId: "machine-1", sessionId: "s-invalid-timing" },
                },
            );

            const handler = getSocketHandler(socket, "pending-materialize-next");
            const callback = vi.fn();
            await handler({
                sid: "s-invalid-timing",
                deliveryState: "provider",
                deliveryTiming,
            }, callback);

            expect(callback).toHaveBeenCalledWith({ ok: false, error: "invalid-params" });
            expect(materializeNextPendingMessage).not.toHaveBeenCalled();
            expect(materializeNextPendingMessageForCurrentPublisher).not.toHaveBeenCalled();
        },
    );

    it("rejects an omitted delivery timing on the current provider-materialization socket contract", async () => {
        const socket = createFakeSocket();
        registerSessionUpdateHandler(
            "user-1",
            socket as any,
            { connectionType: "session-scoped", socket: socket as any, userId: "user-1", sessionId: "s-missing-timing" } as any,
            {
                presence: { resolveCurrentPublisher, runAsCurrentPublisher, runAsCurrentPublisherInTx },
                binding: { accountId: "user-1", machineId: "machine-1", sessionId: "s-missing-timing" },
            },
        );

        const handler = getSocketHandler(socket, "pending-materialize-next");
        const callback = vi.fn();
        await handler({
            sid: "s-missing-timing",
            deliveryState: "provider",
        }, callback);

        expect(callback).toHaveBeenCalledWith({ ok: false, error: "invalid-params" });
        expect(materializeNextPendingMessage).not.toHaveBeenCalled();
        expect(materializeNextPendingMessageForCurrentPublisher).not.toHaveBeenCalled();
    });

    it("rejects an omitted foreground state on the current provider-materialization socket contract", async () => {
        const socket = createFakeSocket();
        registerSessionUpdateHandler(
            "user-1",
            socket as any,
            { connectionType: "session-scoped", socket: socket as any, userId: "user-1", sessionId: "s-missing-foreground" } as any,
            {
                presence: { resolveCurrentPublisher, runAsCurrentPublisher, runAsCurrentPublisherInTx },
                binding: { accountId: "user-1", machineId: "machine-1", sessionId: "s-missing-foreground" },
            },
        );

        const handler = getSocketHandler(socket, "pending-materialize-next");
        const callback = vi.fn();
        await handler({
            sid: "s-missing-foreground",
            deliveryState: "provider",
            deliveryTiming: "after_foreground_ready",
        }, callback);

        expect(callback).toHaveBeenCalledWith({ ok: false, error: "invalid-params" });
        expect(materializeNextPendingMessage).not.toHaveBeenCalled();
        expect(materializeNextPendingMessageForCurrentPublisher).not.toHaveBeenCalled();
    });

    it("preserves unresolved-head backpressure through socket pending materialization", async () => {
        materializeNextPendingMessageForCurrentPublisher.mockResolvedValueOnce({
            ok: true,
            didMaterialize: false,
            pendingCount: 2,
            pendingBlockedCount: 0,
            pendingVersion: 9,
            deliveryState: { mode: "provider", unresolved: true },
            deferredReason: "waiting_for_predecessor",
        });
        const socket = createFakeSocket();

        registerSessionUpdateHandler(
            "user-1",
            socket as any,
            { connectionType: "session-scoped", socket: socket as any, userId: "user-1", sessionId: "s-head-blocked" } as any,
            {
                presence: { resolveCurrentPublisher, runAsCurrentPublisher, runAsCurrentPublisherInTx },
                binding: { accountId: "user-1", machineId: "machine-1", sessionId: "s-head-blocked" },
            },
        );

        const handler = getSocketHandler(socket, "pending-materialize-next");
        const callback = vi.fn();
        await handler({
            sid: "s-head-blocked",
            deliveryState: "provider",
            deliveryTiming: "after_foreground_ready",
            foregroundState: "ready",
        }, callback);

        expect(callback).toHaveBeenCalledWith({
            ok: true,
            didMaterialize: false,
            pendingCount: 2,
            pendingBlockedCount: 0,
            pendingVersion: 9,
            deliveryState: { mode: "provider", unresolved: true },
            deferredReason: "waiting_for_predecessor",
        });
    });

});
