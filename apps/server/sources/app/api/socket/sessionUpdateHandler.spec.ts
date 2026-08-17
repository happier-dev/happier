import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeSocket, getSocketHandler } from "../testkit/socketHarness";

const createSessionMessage = vi.fn<(...args: unknown[]) => Promise<unknown>>(async () => ({ ok: false, error: "invalid-params" }));
const enqueuePendingMessage = vi.fn<(...args: unknown[]) => Promise<unknown>>(async () => ({ ok: false, error: "invalid-params" }));
const materializeNextPendingMessage = vi.fn(async (): Promise<unknown> => ({ ok: false, error: "internal" }));
const resolveAcceptedPendingDelivery = vi.fn(async (): Promise<unknown> => ({ ok: false, error: "internal" }));
const settlePendingInputAdmission = vi.fn(async (): Promise<unknown> => ({ ok: false, error: "internal" }));
const readSessionPendingState = vi.fn(async (): Promise<unknown> => ({ ok: true, pendingCount: 0, pendingVersion: 0 }));
const applySessionTurnMutation = vi.fn(async (): Promise<unknown> => ({ ok: false, error: "internal" }));
const clearSessionRuntimeActivityProjectionInTx = vi.fn(async () => ({
    didWrite: false,
    projection: {},
}));
const updateSessionMetadata = vi.fn(async (): Promise<unknown> => ({ ok: false, error: "internal" }));
const updateSessionMetadataEnvelopeTuple = vi.fn(async (): Promise<unknown> => ({ ok: false, error: "internal" }));
const updateSessionAgentState = vi.fn(async (): Promise<unknown> => ({ ok: false, error: "internal" }));
const updateSessionRuntimeActivityProjection = vi.fn(async (): Promise<unknown> => ({ ok: false, error: "internal" }));
const publishSnapshot = vi.fn(async (): Promise<unknown> => ({ status: "rejected", reason: "invalid-params" }));
const touchPublisher = vi.fn(async (): Promise<unknown> => ({ status: "unregistered" }));
const registerPublisher = vi.fn(async (): Promise<unknown> => ({ status: "rejected", reason: "unauthorized" }));
const closePublisher = vi.fn(async (): Promise<unknown> => ({ status: "superseded" }));
const getSessionParticipantUserIds = vi.fn(async () => ["user-1"]);
const markAccountChanged = vi.fn(async () => 101);
const sessionFindUnique = vi.fn();
const sessionUpdate = vi.fn();
const emitEphemeral = vi.fn();
const emitUpdate = vi.fn();
const activityCacheIsSessionValid = vi.fn(async () => true);
const activityCacheMarkSessionInactive = vi.fn();
const recordSessionAlive = vi.fn(async () => {});
const buildPendingChangedUpdate = vi.fn();
const buildUpdateSessionUpdate = vi.fn(
    (_sessionId: string, seq: number, updateId: string, _metadata: unknown, _agentState: unknown, projection?: unknown) => ({
        id: updateId,
        seq,
        body: { t: "update-session", ...(projection && typeof projection === "object" ? projection : {}) },
    }),
);
const HOSTED_RECIPIENT_PROJECTION = {
    currentStorageState: "hosted",
    acceptedThroughServerSeq: null,
    materializationPublicationId: null,
    materializedThroughSourceAt: null,
    publishedThroughServerSeq: null,
    seq: 0,
    lastViewedSessionSeq: null,
    latestReadyEventSeq: null,
    latestReadyEventAt: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    meaningfulActivityAt: null,
    lastActiveAt: new Date(0),
} as const;
vi.mock("@/app/session/sessionWriteService", () => ({
    createSessionMessage,
    updateSessionMetadata,
    updateSessionMetadataEnvelopeTuple,
    updateSessionAgentState,
    updateSessionRuntimeActivityProjection,
    applySessionTurnMutation,
    clearSessionRuntimeActivityProjectionInTx,
}));
vi.mock("@/app/presence/sessionCache", () => ({
    activityCache: {
        isSessionValid: activityCacheIsSessionValid,
        markSessionInactive: activityCacheMarkSessionInactive,
    },
}));
vi.mock("@/app/presence/presenceRecorder", () => ({
    recordSessionAlive,
}));
vi.mock("@/app/session/pending/pendingMessageService", () => ({
    enqueuePendingMessage,
    materializeNextPendingMessage,
    materializeNextPendingMessageInTx: materializeNextPendingMessage,
    mapPendingMaterializationError: () => ({ ok: false, error: "internal" }),
    resolveAcceptedPendingDelivery,
    settlePendingInputAdmission,
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
const markSessionParticipantsChanged = vi.fn(async () => [{ accountId: "user-1", cursor: 101 }]);
vi.mock("@/app/session/changeTracking/markSessionParticipantsChanged", () => ({
    markSessionParticipantsChanged,
}));
vi.mock("@/app/changes/markAccountChanged", () => ({
    markAccountChanged,
}));
vi.mock("@/storage/inTx", () => ({
    inTx: vi.fn(async (fn: (tx: unknown) => unknown) => await fn({})),
    isTransactionAcquisitionUnavailableError: () => false,
    isTransactionDeadlineExceededError: () => false,
}));
const refreshSessionParticipantBadgePushes = vi.fn(async () => {});
vi.mock("@/app/activity/refreshAccountActivityBadgePushes", () => ({
    refreshSessionParticipantBadgePushes,
}));
const logInfo = vi.fn();
const logDebug = vi.fn();
const logError = vi.fn();
vi.mock("@/utils/logging/log", () => ({ log: logInfo, debug: logDebug, error: logError }));

describe("sessionUpdateHandler", () => {
    let registerSessionUpdateHandler: (userId: string, socket: any, connection: any, publisher?: any) => void;

    const trustedPublisher = {
        presence: { publishSnapshot, touchPublisher, registerPublisher, closePublisher },
        binding: { accountId: "user-1", machineId: "machine-1", sessionId: "s-1" },
    };

    beforeAll(async () => {
        ({ sessionUpdateHandler: registerSessionUpdateHandler } = await import("./sessionUpdateHandler"));
    }, 300_000);

    beforeEach(() => {
        createSessionMessage.mockClear();
        enqueuePendingMessage.mockReset();
        enqueuePendingMessage.mockResolvedValue({ ok: false, error: "invalid-params" });
        materializeNextPendingMessage.mockReset();
        materializeNextPendingMessage.mockResolvedValue({ ok: false, error: "internal" });
        resolveAcceptedPendingDelivery.mockReset();
        resolveAcceptedPendingDelivery.mockResolvedValue({ ok: false, error: "internal" });
        settlePendingInputAdmission.mockReset();
        settlePendingInputAdmission.mockResolvedValue({ ok: false, error: "internal" });
        readSessionPendingState.mockReset();
        readSessionPendingState.mockResolvedValue({ ok: true, pendingCount: 0, pendingVersion: 0 });
        applySessionTurnMutation.mockClear();
        clearSessionRuntimeActivityProjectionInTx.mockReset();
        clearSessionRuntimeActivityProjectionInTx.mockResolvedValue({ didWrite: false, projection: {} });
        updateSessionMetadata.mockClear();
        updateSessionAgentState.mockClear();
        updateSessionRuntimeActivityProjection.mockClear();
        publishSnapshot.mockReset();
        publishSnapshot.mockResolvedValue({ status: "rejected", reason: "invalid-params" });
        touchPublisher.mockReset();
        touchPublisher.mockResolvedValue({ status: "unregistered" });
        registerPublisher.mockReset();
        registerPublisher.mockResolvedValue({ status: "rejected", reason: "unauthorized" });
        closePublisher.mockReset();
        closePublisher.mockResolvedValue({ status: "superseded" });
        sessionFindUnique.mockReset();
        sessionFindUnique.mockResolvedValue(HOSTED_RECIPIENT_PROJECTION);
        sessionUpdate.mockReset();
        emitEphemeral.mockClear();
        emitUpdate.mockClear();
        activityCacheIsSessionValid.mockClear();
        activityCacheMarkSessionInactive.mockClear();
        recordSessionAlive.mockClear();
        buildUpdateSessionUpdate.mockClear();
        buildPendingChangedUpdate.mockClear();
        checkSessionAccess.mockClear();
        requireAccessLevel.mockClear();
        getSessionParticipantUserIds.mockClear();
        getSessionParticipantUserIds.mockResolvedValue(["user-1"]);
        markSessionParticipantsChanged.mockReset();
        markSessionParticipantsChanged.mockResolvedValue([{ accountId: "user-1", cursor: 101 }]);
        markAccountChanged.mockReset();
        markAccountChanged.mockResolvedValue(101);
        refreshSessionParticipantBadgePushes.mockClear();
        logInfo.mockClear();
        logDebug.mockClear();
        logError.mockClear();
        delete process.env.HAPPIER_SOCKET_MESSAGE_DIAGNOSTIC_LOGS;
        delete process.env.HAPPY_SOCKET_MESSAGE_DIAGNOSTIC_LOGS;
    });

    it("settles provider acceptance only through the exact current machine-bound publisher socket", async () => {
        resolveAcceptedPendingDelivery.mockResolvedValueOnce({
            ok: true,
            didResolve: true,
            pendingCount: 0,
            pendingBlockedCount: 0,
            pendingVersion: 9,
            participantCursors: [],
            participantCursorsPending: [],
            participantCursorsMessage: [],
            badgeAttentionChanged: false,
            message: {
                id: "message-1",
                seq: 43,
                localId: "pending-1",
                messageRole: "user",
                content: { t: "plain", v: { role: "user", content: { type: "text", text: "accepted" } } },
                createdAt: new Date(1_000),
                updatedAt: new Date(1_000),
            },
        });
        const socket = createFakeSocket();
        const authority = {
            accountId: "user-1",
            machineId: "machine-1",
            sessionId: "s-1",
            committedFence: new Date(1_000),
        };
        const runAsCurrentPublisher = vi.fn(async (params: { operation: (value: typeof authority) => Promise<unknown> }) =>
            await params.operation(authority));
        registerSessionUpdateHandler(
            "user-1",
            socket as any,
            { connectionType: "session-scoped", socket: socket as any, userId: "user-1", sessionId: "s-1" } as any,
            {
                presence: {
                    runAsCurrentPublisher,
                    runAsCurrentPublisherInTx: async (params: { operation: (value: typeof authority, tx: unknown) => Promise<unknown> }) =>
                        await params.operation(authority, {}),
                },
                binding: { accountId: "user-1", machineId: "machine-1", sessionId: "s-1" },
            } as any,
        );
        const callback = vi.fn();

        await getSocketHandler(socket, "pending-delivery-accepted-v1")({
            v: 1,
            sessionId: "s-1",
            localId: "pending-1",
        }, callback);

        expect(resolveAcceptedPendingDelivery).toHaveBeenCalledWith({
            actorUserId: "user-1",
            sessionId: "s-1",
            localId: "pending-1",
            publisherAuthority: authority,
            diagnosticCorrelationId: expect.stringMatching(/^accepted-settlement:[A-Za-z0-9_-]+$/u),
        });
        expect(callback).toHaveBeenCalledWith(expect.objectContaining({
            ok: true,
            didResolve: true,
            pendingVersion: 9,
            message: expect.objectContaining({ localId: "pending-1" }),
        }));
    });

    it("settles protected input authority only through the exact current target publisher", async () => {
        settlePendingInputAdmission.mockResolvedValueOnce({
            ok: true,
            result: { status: "accepted", localId: "pending-1" },
            pendingCount: 0,
            pendingBlockedCount: 0,
            pendingVersion: 9,
            participantCursors: [],
            participantCursorsPending: [],
            participantCursorsMessage: [],
            badgeAttentionChanged: false,
            message: {
                id: "message-1",
                seq: 43,
                localId: "pending-1",
                messageRole: "user",
                content: { t: "plain", v: { role: "user", content: { type: "text", text: "accepted" } } },
                createdAt: new Date(1_000),
                updatedAt: new Date(1_000),
            },
        });
        const socket = createFakeSocket();
        const authority = {
            accountId: "user-1",
            machineId: "machine-1",
            sessionId: "s-1",
            committedFence: new Date(1_000),
        };
        const runAsCurrentPublisher = vi.fn(async (params: { operation: (value: typeof authority) => Promise<unknown> }) =>
            await params.operation(authority));
        registerSessionUpdateHandler(
            "user-1",
            socket as any,
            { connectionType: "session-scoped", socket: socket as any, userId: "user-1", sessionId: "s-1" } as any,
            {
                presence: { runAsCurrentPublisher },
                binding: { accountId: "user-1", machineId: "machine-1", sessionId: "s-1" },
            } as any,
        );
        const callback = vi.fn();
        const decision = {
            kind: "admit" as const,
            finalContent: { t: "plain" as const, v: { role: "user", content: { type: "text", text: "accepted" } } },
        };

        await getSocketHandler(socket, "session-pending-admission-settlement-v1")({
            v: 1,
            sessionId: "s-1",
            localId: "pending-1",
            decision,
        }, callback);

        expect(settlePendingInputAdmission).toHaveBeenCalledWith({
            actorUserId: "user-1",
            sessionId: "s-1",
            localId: "pending-1",
            publisherAuthority: authority,
            decision,
        });
        expect(callback).toHaveBeenCalledWith({
            v: 1,
            result: { status: "accepted", localId: "pending-1" },
        });
    });

    it("rejects protected input settlement from a stale target publisher before service disclosure", async () => {
        const socket = createFakeSocket();
        const runAsCurrentPublisher = vi.fn(async () => null);
        registerSessionUpdateHandler(
            "user-1",
            socket as any,
            { connectionType: "session-scoped", socket: socket as any, userId: "user-1", sessionId: "s-1" } as any,
            {
                presence: { runAsCurrentPublisher },
                binding: { accountId: "user-1", machineId: "machine-1", sessionId: "s-1" },
            } as any,
        );
        const callback = vi.fn();

        await getSocketHandler(socket, "session-pending-admission-settlement-v1")({
            v: 1,
            sessionId: "s-1",
            localId: "pending-1",
            decision: { kind: "reject", code: "session_input_permission_ceiling_rejected" },
        }, callback);

        expect(settlePendingInputAdmission).not.toHaveBeenCalled();
        expect(callback).toHaveBeenCalledWith({
            v: 1,
            result: { status: "rejected", code: "session_input_unauthorized" },
        });
    });

    it("checks current publisher authority only from the authenticated bound session socket", async () => {
        const socket = createFakeSocket();
        const readCurrentPublisherPrecondition = vi.fn(async () => null);
        registerSessionUpdateHandler(
            "user-1",
            socket as any,
            {
                connectionType: "session-scoped",
                socket: socket as any,
                userId: "user-1",
                sessionId: "s-1",
            } as any,
            {
                presence: {
                    runAsCurrentPublisher: vi.fn(),
                    readCurrentPublisherPrecondition,
                },
                binding: {
                    accountId: "user-1",
                    machineId: "machine-1",
                    sessionId: "s-1",
                },
            } as any,
        );
        const callback = vi.fn();

        await getSocketHandler(
            socket,
            "session-publisher-authority-check",
        )({ sessionId: "s-1" }, callback);

        expect(readCurrentPublisherPrecondition).toHaveBeenCalledWith({
            socket,
        });
        expect(callback).toHaveBeenCalledWith({
            status: "superseded",
            sessionId: "s-1",
        });
    });

    it("forwards only typed transaction-unavailable settlement retry fields", async () => {
        resolveAcceptedPendingDelivery.mockResolvedValueOnce({
            ok: false,
            error: "transaction-unavailable",
            retryAfterMs: 1_000,
            correlationId: "accepted-settlement-1",
        });
        const socket = createFakeSocket();
        const authority = {
            accountId: "user-1",
            machineId: "machine-1",
            sessionId: "s-1",
            committedFence: new Date(1_000),
        };
        const runAsCurrentPublisher = vi.fn(async (params: { operation: (value: typeof authority) => Promise<unknown> }) =>
            await params.operation(authority));
        registerSessionUpdateHandler(
            "user-1",
            socket as any,
            { connectionType: "session-scoped", socket: socket as any, userId: "user-1", sessionId: "s-1" } as any,
            {
                presence: { runAsCurrentPublisher },
                binding: { accountId: "user-1", machineId: "machine-1", sessionId: "s-1" },
            } as any,
        );
        const callback = vi.fn();

        await getSocketHandler(socket, "pending-delivery-accepted-v1")({
            v: 1,
            sessionId: "s-1",
            localId: "pending-1",
        }, callback);

        expect(resolveAcceptedPendingDelivery).toHaveBeenCalledWith(expect.objectContaining({
            diagnosticCorrelationId: expect.stringMatching(/^[A-Za-z0-9_.:-]{1,160}$/u),
        }));
        expect(callback).toHaveBeenCalledWith({
            ok: false,
            error: "transaction-unavailable",
            retryAfterMs: 1_000,
            correlationId: "accepted-settlement-1",
        });
    });

    it("contains unexpected provider acceptance errors with one internal ACK and an observable error log", async () => {
        const unexpectedError = new Error("unexpected settlement failure");
        resolveAcceptedPendingDelivery.mockRejectedValueOnce(unexpectedError);
        const socket = createFakeSocket();
        const authority = {
            accountId: "user-1",
            machineId: "machine-1",
            sessionId: "s-1",
            committedFence: new Date(1_000),
        };
        const runAsCurrentPublisher = vi.fn(async (params: { operation: (value: typeof authority) => Promise<unknown> }) =>
            await params.operation(authority));
        registerSessionUpdateHandler(
            "user-1",
            socket as any,
            { connectionType: "session-scoped", socket: socket as any, userId: "user-1", sessionId: "s-1" } as any,
            {
                presence: { runAsCurrentPublisher },
                binding: { accountId: "user-1", machineId: "machine-1", sessionId: "s-1" },
            } as any,
        );
        const callback = vi.fn();

        await expect(getSocketHandler(socket, "pending-delivery-accepted-v1")({
            v: 1,
            sessionId: "s-1",
            localId: "pending-1",
        }, callback)).resolves.toBeUndefined();

        expect(callback).toHaveBeenCalledTimes(1);
        expect(callback).toHaveBeenCalledWith({ ok: false, error: "internal" });
        expect(logError).toHaveBeenCalledWith(
            {
                module: "websocket",
                event: "pending-delivery-accepted-v1",
                err: unexpectedError,
            },
            "Error settling accepted pending delivery",
        );
    });

    it("rejects provider acceptance from a stale or replaced publisher socket", async () => {
        const socket = createFakeSocket();
        const runAsCurrentPublisher = vi.fn(async () => null);
        registerSessionUpdateHandler(
            "user-1",
            socket as any,
            { connectionType: "session-scoped", socket: socket as any, userId: "user-1", sessionId: "s-1" } as any,
            {
                presence: { runAsCurrentPublisher },
                binding: { accountId: "user-1", machineId: "machine-1", sessionId: "s-1" },
            } as any,
        );
        const callback = vi.fn();

        await getSocketHandler(socket, "pending-delivery-accepted-v1")({
            v: 1,
            sessionId: "s-1",
            localId: "pending-1",
        }, callback);

        expect(callback).toHaveBeenCalledWith({ ok: false, error: "forbidden" });
        expect(resolveAcceptedPendingDelivery).not.toHaveBeenCalled();
    });

    it("keeps the legacy metadata socket layout-zero-only and never delegates a tuple mutation", async () => {
        const socket = createFakeSocket();
        registerSessionUpdateHandler(
            "user-1",
            socket as any,
            {
                connectionType: "session-scoped",
                socket: socket as any,
                userId: "user-1",
                sessionId: "s-1",
            } as any,
        );
        const callback = vi.fn();

        await getSocketHandler(socket, "update-metadata")(
            {
                sid: "s-1",
                mode: "owner",
                metadataLayoutVersion: 1,
                sharedMetadata: {
                    ciphertext: "shared",
                    expectedVersion: 1,
                },
                ownerMetadata: {
                    ciphertext:
                        "oQoBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQGDb9gtt8Xqs3gDuzJU/wWRuslcRY3OZA==",
                },
                agentState: {
                    ciphertext: "private-state",
                    expectedVersion: 2,
                },
            },
            callback,
        );

        expect(callback).toHaveBeenCalledWith({
            result: "metadata_privacy_upgrade_required",
        });
        expect(updateSessionMetadataEnvelopeTuple).not.toHaveBeenCalled();
        expect(updateSessionMetadata).not.toHaveBeenCalled();
        expect(emitUpdate).not.toHaveBeenCalled();
    });

    it.each([
        {
            event: "update-metadata",
            payload: {
                sid: "s-1",
                metadata: "legacy-shared-editor-metadata",
                expectedVersion: 5,
            },
            write: updateSessionMetadata,
            writeResult: {
                ok: false,
                error: "metadata_privacy_upgrade_required",
            },
        },
        {
            event: "update-state",
            payload: {
                sid: "s-1",
                agentState: "legacy-shared-editor-state",
                expectedVersion: 8,
            },
            write: updateSessionAgentState,
            writeResult: {
                ok: false,
                error: "metadata_privacy_upgrade_required",
            },
        },
    ])("fails legacy $event writes before participant publication", async ({
        event,
        payload,
        write,
        writeResult,
    }) => {
        write.mockResolvedValueOnce(writeResult);
        const socket = createFakeSocket();
        registerSessionUpdateHandler(
            "editor",
            socket as any,
            {
                connectionType: "session-scoped",
                socket: socket as any,
                userId: "editor",
                sessionId: "s-1",
            } as any,
        );
        const callback = vi.fn();

        await getSocketHandler(socket, event)(payload, callback);

        expect(write).toHaveBeenCalledWith(expect.objectContaining({
            actorUserId: "editor",
            sessionId: "s-1",
            expectedVersion: payload.expectedVersion,
        }));
        expect(buildUpdateSessionUpdate).not.toHaveBeenCalled();
        expect(emitUpdate).not.toHaveBeenCalled();
        expect(callback).toHaveBeenCalledWith({
            result: "metadata_privacy_upgrade_required",
        });
    });

    it("publishes a successful released layout-zero metadata update only to its owner", async () => {
        updateSessionMetadata.mockResolvedValueOnce({
            ok: true,
            version: 6,
            metadata: "legacy-whole-bag",
            participantCursors: [
                { accountId: "owner", cursor: 10 },
                { accountId: "shared-recipient", cursor: 11 },
            ],
            badgeAttentionChanged: false,
        });
        const socket = createFakeSocket();
        registerSessionUpdateHandler(
            "owner",
            socket as any,
            {
                connectionType: "session-scoped",
                socket: socket as any,
                userId: "owner",
                sessionId: "s-1",
            } as any,
        );
        const callback = vi.fn();

        await getSocketHandler(socket, "update-metadata")({
            sid: "s-1",
            metadata: "legacy-whole-bag",
            expectedVersion: 5,
        }, callback);

        expect(buildUpdateSessionUpdate).toHaveBeenCalledTimes(1);
        expect(buildUpdateSessionUpdate.mock.calls[0]?.[1]).toBe(10);
        expect(emitUpdate).toHaveBeenCalledTimes(1);
        expect(emitUpdate).toHaveBeenCalledWith(
            expect.objectContaining({ userId: "owner" }),
        );
        expect(callback).toHaveBeenCalledWith({
            result: "success",
            version: 6,
            metadata: "legacy-whole-bag",
        });
    });

    it("rejects session-scoped payloads whose target session does not match the socket binding", async () => {
        const socket = createFakeSocket({
            data: {
                clientType: "session-scoped",
                sessionScopedBinding: {
                    sessionId: "s-expected",
                    machineId: null,
                    proof: "owner-session",
                },
            },
        });

        registerSessionUpdateHandler(
            "user-1",
            socket as any,
            { connectionType: "session-scoped", socket: socket as any, userId: "user-1", sessionId: "s-expected" } as any,
        );

        const metadataCallback = vi.fn();
        await getSocketHandler(socket, "update-metadata")(
            { sid: "s-other", metadata: "encrypted-metadata", expectedVersion: 1 },
            metadataCallback,
        );

        const stateCallback = vi.fn();
        await getSocketHandler(socket, "update-state")(
            { sid: "s-other", agentState: "encrypted-state", expectedVersion: 1 },
            stateCallback,
        );

        const messageCallback = vi.fn();
        await getSocketHandler(socket, "message")(
            {
                sid: "s-other",
                message: "encrypted-message",
                localId: "local-1",
                sentFrom: "web",
                permissionMode: "default",
            },
            messageCallback,
        );

        await getSocketHandler(socket, "session-alive")({ sid: "s-other", time: Date.now() });

        expect(metadataCallback).toHaveBeenCalledWith({ result: "forbidden" });
        expect(stateCallback).toHaveBeenCalledWith({ result: "forbidden" });
        expect(messageCallback).toHaveBeenCalledWith({ ok: false, error: "forbidden" });
        expect(updateSessionMetadata).not.toHaveBeenCalled();
        expect(updateSessionAgentState).not.toHaveBeenCalled();
        expect(createSessionMessage).not.toHaveBeenCalled();
        expect(activityCacheIsSessionValid).not.toHaveBeenCalled();
        expect(recordSessionAlive).not.toHaveBeenCalled();
    });

    it("forwards a validated latest turn snapshot from session-alive", async () => {
        const observedAt = Date.now();
        const socket = createFakeSocket();
        registerSessionUpdateHandler(
            "user-1",
            socket as any,
            { connectionType: "session-scoped", socket: socket as any, userId: "user-1", sessionId: "s-1" } as any,
            trustedPublisher,
        );
        touchPublisher.mockResolvedValueOnce({
            status: "touched",
            committedFence: new Date(observedAt),
            activeAt: new Date(observedAt),
            participantCursors: [],
            badgeAttentionChanged: false,
        });
        await getSocketHandler(socket, "session-alive")({
            sid: "s-1",
            time: observedAt,
            thinking: false,
            latestTurnStatus: "completed",
            latestTurnStatusObservedAt: observedAt,
        });

        expect(recordSessionAlive).toHaveBeenCalledWith({
            accountId: "user-1",
            sessionId: "s-1",
            timestamp: observedAt,
            latestTurnStatus: "completed",
            latestTurnStatusObservedAt: observedAt,
        });
    });

    it("drops overlapping session-alive attempts across persistence and accepts the next heartbeat after freshness expires", async () => {
        const observedAt = Date.now();
        const now = vi.spyOn(Date, "now").mockReturnValue(observedAt);
        const socket = createFakeSocket();
        registerSessionUpdateHandler(
            "user-1",
            socket as any,
            { connectionType: "session-scoped", socket: socket as any, userId: "user-1", sessionId: "s-1" } as any,
            trustedPublisher,
        );
        const alive = getSocketHandler(socket, "session-alive");
        const touched = {
            status: "touched",
            committedFence: new Date(observedAt),
            activeAt: new Date(observedAt),
            participantCursors: [],
            badgeAttentionChanged: false,
        };
        let resolveFirstTouch!: (value: typeof touched) => void;
        const firstTouch = new Promise<typeof touched>((resolve) => {
            resolveFirstTouch = resolve;
        });
        let markFirstRecordEntered!: () => void;
        const firstRecordEntered = new Promise<void>((resolve) => {
            markFirstRecordEntered = resolve;
        });
        let releaseFirstRecord!: () => void;
        const firstRecordRelease = new Promise<void>((resolve) => {
            releaseFirstRecord = resolve;
        });
        touchPublisher
            .mockReturnValueOnce(firstTouch)
            .mockResolvedValue({ status: "rejected", reason: "unauthorized" });
        recordSessionAlive.mockImplementationOnce(async () => {
            markFirstRecordEntered();
            await firstRecordRelease;
        });
        const payload = { sid: "s-1", time: observedAt, thinking: true };

        const firstAttempt = alive(payload);
        await Promise.resolve();
        await Promise.resolve();
        const overlapDuringTouch = alive({ ...payload, time: observedAt + 1 });
        const touchCallsDuringTouch = touchPublisher.mock.calls.length;

        resolveFirstTouch(touched);
        await firstRecordEntered;
        const overlapDuringPersistence = alive({ ...payload, time: observedAt + 2 });
        const touchCallsDuringPersistence = touchPublisher.mock.calls.length;

        releaseFirstRecord();
        await Promise.all([firstAttempt, overlapDuringTouch, overlapDuringPersistence]);

        try {
            now.mockReturnValue(observedAt + 60_000);
            await alive({ ...payload, time: observedAt + 60_000 });
            expect(touchCallsDuringTouch).toBe(1);
            expect(touchCallsDuringPersistence).toBe(1);
            expect(touchPublisher).toHaveBeenCalledTimes(2);
            expect(recordSessionAlive).toHaveBeenCalledTimes(1);
        } finally {
            now.mockRestore();
        }
    });

    it("accepts the next session-alive heartbeat after a touch failure", async () => {
        const observedAt = Date.now();
        const socket = createFakeSocket();
        registerSessionUpdateHandler(
            "user-1",
            socket as any,
            { connectionType: "session-scoped", socket: socket as any, userId: "user-1", sessionId: "s-1" } as any,
            trustedPublisher,
        );
        const alive = getSocketHandler(socket, "session-alive");
        let rejectFirstTouch!: (error: Error) => void;
        const firstTouch = new Promise<never>((_resolve, reject) => {
            rejectFirstTouch = reject;
        });
        touchPublisher
            .mockReturnValueOnce(firstTouch)
            .mockResolvedValue({ status: "rejected", reason: "unauthorized" });
        const payload = { sid: "s-1", time: observedAt, thinking: true };

        const firstAttempt = alive(payload);
        await Promise.resolve();
        await Promise.resolve();
        const overlap = alive({ ...payload, time: observedAt + 1 });
        const touchCallsDuringFailure = touchPublisher.mock.calls.length;
        rejectFirstTouch(new Error("touch failed"));
        await Promise.all([firstAttempt, overlap]);

        await alive({ ...payload, time: observedAt + 2 });
        expect(touchCallsDuringFailure).toBe(1);
        expect(touchPublisher).toHaveBeenCalledTimes(2);
    });

    it("backs off repeated session-alive persistence failures instead of retrying every heartbeat", async () => {
        const observedAt = Date.parse("2026-07-22T09:00:00.000Z");
        const now = vi.spyOn(Date, "now").mockReturnValue(observedAt);
        const socket = createFakeSocket();
        registerSessionUpdateHandler(
            "user-1",
            socket as any,
            { connectionType: "session-scoped", socket: socket as any, userId: "user-1", sessionId: "s-1" } as any,
            trustedPublisher,
        );
        touchPublisher.mockResolvedValue({ status: "rejected", reason: "unauthorized" });
        const alive = getSocketHandler(socket, "session-alive");

        try {
            await alive({ sid: "s-1", time: observedAt, thinking: true });
            expect(touchPublisher).toHaveBeenCalledTimes(1);

            // First failure must still retry on the very next heartbeat.
            now.mockReturnValue(observedAt + 2_000);
            await alive({ sid: "s-1", time: observedAt + 2_000, thinking: true });
            expect(touchPublisher).toHaveBeenCalledTimes(2);

            // The second consecutive failure arms a backoff, so the next heartbeat is not an attempt.
            now.mockReturnValue(observedAt + 3_000);
            await alive({ sid: "s-1", time: observedAt + 3_000, thinking: true });
            expect(touchPublisher).toHaveBeenCalledTimes(2);

            now.mockReturnValue(observedAt + 4_001);
            await alive({ sid: "s-1", time: observedAt + 4_001, thinking: true });
            expect(touchPublisher).toHaveBeenCalledTimes(3);
        } finally {
            now.mockRestore();
        }
    });

    it("returns to the ordinary persistence interval once a session-alive attempt succeeds", async () => {
        const observedAt = Date.parse("2026-07-22T10:00:00.000Z");
        const now = vi.spyOn(Date, "now").mockReturnValue(observedAt);
        const socket = createFakeSocket();
        registerSessionUpdateHandler(
            "user-1",
            socket as any,
            { connectionType: "session-scoped", socket: socket as any, userId: "user-1", sessionId: "s-1" } as any,
            trustedPublisher,
        );
        touchPublisher.mockResolvedValue({ status: "rejected", reason: "unauthorized" });
        const alive = getSocketHandler(socket, "session-alive");

        try {
            await alive({ sid: "s-1", time: observedAt, thinking: true });
            now.mockReturnValue(observedAt + 2_000);
            await alive({ sid: "s-1", time: observedAt + 2_000, thinking: true });
            expect(touchPublisher).toHaveBeenCalledTimes(2);

            touchPublisher.mockResolvedValue({
                status: "touched",
                committedFence: new Date(observedAt + 4_001),
                activeAt: new Date(observedAt + 4_001),
                participantCursors: [],
                badgeAttentionChanged: false,
            });
            now.mockReturnValue(observedAt + 4_001);
            await alive({ sid: "s-1", time: observedAt + 4_001, thinking: true });
            expect(touchPublisher).toHaveBeenCalledTimes(3);

            // A success re-arms the full persistence interval, not the failure backoff.
            now.mockReturnValue(observedAt + 20_000);
            await alive({ sid: "s-1", time: observedAt + 20_000, thinking: true });
            expect(touchPublisher).toHaveBeenCalledTimes(3);

            now.mockReturnValue(observedAt + 64_002);
            await alive({ sid: "s-1", time: observedAt + 64_002, thinking: true });
            expect(touchPublisher).toHaveBeenCalledTimes(4);
        } finally {
            now.mockRestore();
        }
    });

    it("coalesces successful released alive reconciliation while its committed presence fence is fresh", async () => {
        const observedAt = Date.parse("2026-07-22T08:00:00.000Z");
        const now = vi.spyOn(Date, "now").mockReturnValue(observedAt);
        const socket = createFakeSocket();
        registerSessionUpdateHandler(
            "user-1",
            socket as any,
            { connectionType: "session-scoped", socket: socket as any, userId: "user-1", sessionId: "s-1" } as any,
            trustedPublisher,
        );
        touchPublisher.mockResolvedValue({
            status: "touched",
            committedFence: new Date(observedAt),
            activeAt: new Date(observedAt),
            participantCursors: [],
            badgeAttentionChanged: false,
        });
        const alive = getSocketHandler(socket, "session-alive");

        try {
            await alive({
                sid: "s-1",
                time: observedAt,
                latestTurnStatus: "completed",
                latestTurnStatusObservedAt: observedAt,
            });
            now.mockReturnValue(observedAt + 1_000);
            await alive({
                sid: "s-1",
                time: observedAt + 1_000,
                latestTurnStatus: "completed",
                latestTurnStatusObservedAt: observedAt,
            });

            expect(touchPublisher).toHaveBeenCalledTimes(1);
            expect(recordSessionAlive).toHaveBeenCalledTimes(1);

            now.mockReturnValue(observedAt + 60_000);
            await alive({
                sid: "s-1",
                time: observedAt + 60_000,
                latestTurnStatus: "completed",
                latestTurnStatusObservedAt: observedAt,
            });
            expect(touchPublisher).toHaveBeenCalledTimes(2);
            expect(recordSessionAlive).toHaveBeenCalledTimes(2);
        } finally {
            now.mockRestore();
        }
    });

    it("refreshes participant badges once after a registration changes reachability contribution", async () => {
        const observedAt = Date.now();
        const socket = createFakeSocket();
        registerSessionUpdateHandler(
            "user-1",
            socket as any,
            { connectionType: "session-scoped", socket: socket as any, userId: "user-1", sessionId: "s-1" } as any,
            trustedPublisher,
        );
        touchPublisher.mockResolvedValueOnce({ status: "unregistered" });
        registerPublisher.mockResolvedValueOnce({
            status: "registered",
            committedFence: new Date(observedAt),
            activeAt: new Date(observedAt),
            activity: { status: "unchanged", projection: {} },
            participantCursors: [
                { accountId: "user-1", cursor: 101 },
                { accountId: "user-2", cursor: 102 },
            ],
            badgeAttentionChanged: true,
        });

        await getSocketHandler(socket, "session-alive")({ sid: "s-1", time: observedAt });

        expect(refreshSessionParticipantBadgePushes).toHaveBeenCalledTimes(1);
        expect(refreshSessionParticipantBadgePushes).toHaveBeenCalledWith({
            badgeAttentionChanged: true,
            participantCursors: [
                { accountId: "user-1", cursor: 101 },
                { accountId: "user-2", cursor: 102 },
            ],
        });
    });

    it("does not register system-record writes as a session socket mutation", () => {
        const socket = createFakeSocket();
        const connection = { connectionType: "session-scoped", socket, userId: "user-1", sessionId: "s-1" } as any;

        registerSessionUpdateHandler("user-1", socket as any, connection);

        expect(socket.handlers.has("upsert-system-record")).toBe(false);
    });

    it.each([
        ["user-scoped", { connectionType: "user-scoped", userId: "user-1" }],
        ["machine-scoped", { connectionType: "machine-scoped", userId: "user-1", machineId: "machine-1" }],
        ["owner-session without a machine binding", { connectionType: "session-scoped", userId: "user-1", sessionId: "s-1" }],
    ])("rejects Activity and alive from %s sockets", async (_label, connectionShape) => {
        const socket = createFakeSocket();
        registerSessionUpdateHandler("user-1", socket as any, { ...connectionShape, socket } as any);

        const callback = vi.fn();
        await getSocketHandler(socket, "session-runtime-activity-snapshot")({
            sessionId: "s-1",
            mutationId: "runtime-activity-snapshot:s-1",
            snapshot: { state: "active", activeCount: 1 },
        }, callback);
        await getSocketHandler(socket, "session-alive")({ sid: "s-1", time: Date.now(), thinking: true });

        expect(callback).toHaveBeenCalledWith({
            status: "rejected",
            reason: "invalid_request",
        });
        expect(publishSnapshot).not.toHaveBeenCalled();
        expect(touchPublisher).not.toHaveBeenCalled();
        expect(recordSessionAlive).not.toHaveBeenCalled();
    });

    it("writes runtime activity projection through a dedicated socket mutation without forwarding diagnostics", async () => {
        publishSnapshot.mockResolvedValue({
            status: "applied",
            projection: {
                runtimeActivityState: "active",
                runtimeActivityActiveCount: 1,
                runtimeActivityObservedAt: 1_000,
                runtimeActivityRevision: 2,
            },
            participantCursors: [
                { accountId: "user-1", cursor: 10 },
                { accountId: "user-2", cursor: 11 },
            ],
        });
        const socket = createFakeSocket();
        const connection = { connectionType: "session-scoped", socket, userId: "user-1", sessionId: "s-1" } as any;

        registerSessionUpdateHandler("user-1", socket as any, connection, trustedPublisher);

        const callback = vi.fn();
        await getSocketHandler(socket, "session-runtime-activity-snapshot")({
            sessionId: "s-1",
            mutationId: "runtime-activity-snapshot:s-1",
            snapshot: { state: "active", activeCount: 1 },
        }, callback);

        expect(publishSnapshot).toHaveBeenCalledWith({
            socket,
            binding: trustedPublisher.binding,
            completeSnapshot: {
                state: "active",
                activeCount: 1,
            },
        });
        expect(buildUpdateSessionUpdate).toHaveBeenNthCalledWith(1, "s-1", 10, expect.any(String), undefined, undefined, {
            runtimeActivityState: "active",
            runtimeActivityActiveCount: 1,
            runtimeActivityObservedAt: 1_000,
            runtimeActivityRevision: 2,
        });
        expect(buildUpdateSessionUpdate).toHaveBeenNthCalledWith(2, "s-1", 11, expect.any(String), undefined, undefined, {
            runtimeActivityState: "active",
            runtimeActivityActiveCount: 1,
            runtimeActivityObservedAt: 1_000,
            runtimeActivityRevision: 2,
        });
        expect(callback).toHaveBeenCalledWith({
            status: "applied",
            sessionId: "s-1",
            mutationId: "runtime-activity-snapshot:s-1",
            projection: {
                state: "active",
                activeCount: 1,
                observedAt: 1_000,
                revision: 2,
            },
        });
        expect(updateSessionMetadata).not.toHaveBeenCalled();
        expect(updateSessionAgentState).not.toHaveBeenCalled();
        expect(buildPendingChangedUpdate).not.toHaveBeenCalled();
    });

    it("publishes one existing Pending reconcile wake after an active-or-unknown to idle commit", async () => {
        publishSnapshot.mockResolvedValueOnce({
            status: "applied",
            becameIdle: true,
            projection: {
                runtimeActivityState: "idle",
                runtimeActivityActiveCount: 0,
                runtimeActivityObservedAt: 2_000,
                runtimeActivityRevision: 3,
            },
            participantCursors: [{ accountId: "user-1", cursor: 12 }],
        });
        readSessionPendingState.mockResolvedValueOnce({
            ok: true,
            pendingCount: 2,
            pendingBlockedCount: 0,
            pendingVersion: 8,
        });
        const socket = createFakeSocket();
        const connection = { connectionType: "session-scoped", socket, userId: "user-1", sessionId: "s-idle" } as any;
        registerSessionUpdateHandler("user-1", socket as any, connection, {
            ...trustedPublisher,
            binding: { ...trustedPublisher.binding, sessionId: "s-idle" },
        });

        const callback = vi.fn();
        await getSocketHandler(socket, "session-runtime-activity-snapshot")({
            sessionId: "s-idle",
            mutationId: "runtime-activity-snapshot:s-idle",
            snapshot: { state: "idle", activeCount: 0 },
        }, callback);

        expect(publishSnapshot).toHaveBeenCalledTimes(1);
        expect(callback).toHaveBeenCalledWith(expect.objectContaining({
            status: "applied",
            sessionId: "s-idle",
            mutationId: "runtime-activity-snapshot:s-idle",
        }));
        expect(readSessionPendingState).toHaveBeenCalledWith({ actorUserId: "user-1", sessionId: "s-idle" });
        expect(buildPendingChangedUpdate).toHaveBeenCalledWith({
            sessionId: "s-idle",
            pendingCount: 2,
            pendingBlockedCount: 0,
            pendingVersion: 8,
            changedByAccountId: "user-1",
        }, 12, expect.any(String));
        expect(emitUpdate).toHaveBeenCalledTimes(2);
    });

    it("rejects runtime activity updates from mismatched session-scoped sockets", async () => {
        const socket = createFakeSocket();
        registerSessionUpdateHandler(
            "user-1",
            socket as any,
            { connectionType: "session-scoped", socket: socket as any, userId: "user-1", sessionId: "s-expected" } as any,
        );

        const callback = vi.fn();
        await getSocketHandler(socket, "session-runtime-activity-snapshot")({
            sessionId: "s-other",
            mutationId: "runtime-activity-snapshot:s-other",
            snapshot: { state: "active", activeCount: 1 },
        }, callback);

        expect(callback).toHaveBeenCalledWith({
            status: "rejected",
            reason: "invalid_request",
        });
        expect(updateSessionRuntimeActivityProjection).not.toHaveBeenCalled();
    });

    it("acks invalid runtime activity payloads without touching session state", async () => {
        const socket = createFakeSocket();
        registerSessionUpdateHandler(
            "user-1",
            socket as any,
            { connectionType: "session-scoped", socket: socket as any, userId: "user-1", sessionId: "s-1" } as any,
            trustedPublisher,
        );
        const callback = vi.fn();
        await getSocketHandler(socket, "session-runtime-activity-snapshot")({
            mutationId: "runtime-activity-snapshot:s-1",
            snapshot: { state: "active", activeCount: 1 },
        }, callback);

        expect(callback).toHaveBeenCalledWith({
            status: "rejected",
            reason: "invalid_request",
        });
        expect(updateSessionRuntimeActivityProjection).not.toHaveBeenCalled();
    });

    it("publishes a successful released layout-zero Agent-state update only to its owner", async () => {
        updateSessionAgentState.mockResolvedValueOnce({
            ok: true,
            version: 2,
            agentState: "encrypted-state",
            participantCursors: [
                { accountId: "user-1", cursor: 10 },
                { accountId: "shared-recipient", cursor: 11 },
            ],
            badgeAttentionChanged: false,
        });
        const socket = createFakeSocket();

        registerSessionUpdateHandler(
            "user-1",
            socket as any,
            { connectionType: "session-scoped", socket: socket as any, userId: "user-1", sessionId: "s-1" } as any,
            trustedPublisher,
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
                    code: "agent_status_error",
                    source: "agent_status_error",
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
        expect(buildUpdateSessionUpdate).toHaveBeenCalledTimes(1);
        expect(buildUpdateSessionUpdate.mock.calls[0]?.[1]).toBe(10);
        expect(emitUpdate).toHaveBeenCalledTimes(1);
        expect(emitUpdate).toHaveBeenCalledWith(
            expect.objectContaining({ userId: "user-1" }),
        );
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

    it("rejects a reserved Agent-transition divider localId on the generic socket ingress", async () => {
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
            localId: "agent-transition:submitted-1",
        }, callback);

        expect(callback).toHaveBeenCalledWith(
            expect.objectContaining({ ok: false, error: "invalid-params" }),
        );
        // Only the owner-only transition service may reach the message owner with
        // a reserved divider localId.
        expect(createSessionMessage).not.toHaveBeenCalled();
    });

    it("keeps role-less predecessor socket payloads on the transcript mutation path", async () => {
        const socket = createFakeSocket();
        registerSessionUpdateHandler(
            "user-1",
            socket as any,
            { connectionType: "session-scoped", socket: socket as any, userId: "user-1", sessionId: "s-1" } as any,
        );

        const handler = getSocketHandler(socket, "message");
        await handler({
            sid: "s-1",
            message: { t: "plain", v: { type: "user", text: "hi" } },
            localId: "socket-user-1",
        }, vi.fn());

        expect(createSessionMessage).toHaveBeenCalledWith(expect.objectContaining({
            actorUserId: "user-1",
            sessionId: "s-1",
            content: { t: "plain", v: { type: "user", text: "hi" } },
            localId: "socket-user-1",
            messageRole: undefined,
            sidechainId: null,
        }));
        expect(enqueuePendingMessage).not.toHaveBeenCalled();
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

    it("rejects the exact released UI v0.2.0 direct-user vector with the bare upgrade acknowledgement", async () => {
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

        expect(createSessionMessage).not.toHaveBeenCalled();
        expect(callback).toHaveBeenCalledWith({
            ok: false,
            error: "client-upgrade-required",
        });
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

    it.each([
        ["an explicit user role", "user"],
        ["an explicitly undefined role", undefined],
    ])("keeps released-looking payloads with %s on the normal transcript path", async (_label, messageRole) => {
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
            messageRole,
        }, callback);

        expect(createSessionMessage).toHaveBeenCalledOnce();
        expect(callback).toHaveBeenCalledWith({ ok: false, error: "invalid-params" });
    });

    it.each(["", "   "])("keeps released-looking payloads with blank localId %j on the normal transcript path", async (localId) => {
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
            localId,
            sentFrom: "web",
            permissionMode: "default",
        }, callback);

        expect(createSessionMessage).toHaveBeenCalledWith(expect.objectContaining({ localId }));
        expect(callback).toHaveBeenCalledWith({ ok: false, error: "invalid-params" });
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

    it("does not forward public unread suppression hints from socket message writes", async () => {
        createSessionMessage.mockResolvedValueOnce({
            ok: true,
            didWrite: false,
            didUpdate: false,
            badgeAttentionChanged: false,
            message: {
                id: "m-1",
                seq: 1,
                localId: "local-user-1",
                sidechainId: null,
                content: { t: "encrypted", c: "enc" },
                createdAt: new Date(1),
                updatedAt: new Date(1),
            },
            participantCursors: [],
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
            localId: "local-user-1",
            attentionImpact: {
                affectsUnread: false,
                affectsMeaningfulActivity: false,
            },
            affectsUnread: false,
        }, vi.fn());

        expect(createSessionMessage).toHaveBeenCalledWith({
            actorUserId: "user-1",
            sessionId: "s-1",
            content: { t: "encrypted", c: "enc" },
            localId: "local-user-1",
            sidechainId: null,
        });
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
            agentTurnId: "provider-turn-1",
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
                agentId: "codex",
                agentTurnId: "provider-turn-1",
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
            agentTurnId: "provider-turn-1",
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

    it("fails closed before materialization when pending-materialize-next omits provider mode", async () => {
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

            expect(materializeNextPendingMessage).not.toHaveBeenCalled();
            expect(firstCallback).toHaveBeenCalledWith({ ok: false, error: "forbidden" });
            expect(secondCallback).toHaveBeenCalledWith({ ok: false, error: "forbidden" });
        } finally {
            nowSpy.mockRestore();
            if (typeof previousThrottle === "string") {
                process.env.HAPPIER_SOCKET_PENDING_MATERIALIZE_NOOP_THROTTLE_MS = previousThrottle;
            } else {
                delete process.env.HAPPIER_SOCKET_PENDING_MATERIALIZE_NOOP_THROTTLE_MS;
            }
        }
    });

    it("emits pending-changed when pending-materialize-next blocks stale provider delivery without writing a message", async () => {
        materializeNextPendingMessage.mockResolvedValueOnce({
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
        const authority = {
            accountId: "user-1",
            machineId: "machine-stale-provider",
            sessionId: "s-stale-provider",
            committedFence: new Date(0),
        };
        const runAsCurrentPublisher = vi.fn(async (params: {
            operation: (value: typeof authority) => Promise<unknown>;
        }) => await params.operation(authority));
        const runAsCurrentPublisherInTx = vi.fn(async (params: {
            operation: (value: typeof authority, tx: unknown) => Promise<unknown>;
        }) => await params.operation(authority, {}));
        registerSessionUpdateHandler(
            "user-1",
            socket as any,
            { connectionType: "session-scoped", socket: socket as any, userId: "user-1", sessionId: "s-stale-provider" } as any,
            {
                presence: { runAsCurrentPublisher, runAsCurrentPublisherInTx },
                binding: {
                    accountId: "user-1",
                    machineId: "machine-stale-provider",
                    sessionId: "s-stale-provider",
                },
            } as any,
        );

        const handler = getSocketHandler(socket, "pending-materialize-next");
        const callback = vi.fn();
        await handler({
            sid: "s-stale-provider",
            deliveryState: "provider",
            deliveryTiming: "after_foreground_ready",
            foregroundState: "ready",
        }, callback);

        expect(runAsCurrentPublisherInTx).toHaveBeenCalledTimes(1);
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

    it("returns typed transaction unavailability before the ACK deadline when the socket mutation queue is held", async () => {
        vi.useFakeTimers();
        vi.setSystemTime(1_000);
        try {
            let releaseMessage!: () => void;
            createSessionMessage.mockImplementationOnce(async () => await new Promise((resolve) => {
                releaseMessage = () => resolve({ ok: false, error: "invalid-params" });
            }));
            const socket = createFakeSocket();
            const authority = {
                accountId: "user-1",
                machineId: "machine-budget",
                sessionId: "s-budget",
                committedFence: new Date(0),
            };
            const runAsCurrentPublisher = vi.fn(async (params: { operation: (value: typeof authority) => Promise<unknown> }) =>
                await params.operation(authority));
            registerSessionUpdateHandler(
                "user-1",
                socket as any,
                { connectionType: "session-scoped", socket: socket as any, userId: "user-1", sessionId: "s-budget" } as any,
                {
                    presence: {
                        runAsCurrentPublisher,
                        runAsCurrentPublisherInTx: async (params: { operation: (value: typeof authority, tx: unknown) => Promise<unknown> }) =>
                            await params.operation(authority, {}),
                    },
                    binding: { accountId: "user-1", machineId: "machine-budget", sessionId: "s-budget" },
                } as any,
            );

            const heldMessage = getSocketHandler(socket, "message")({
                sid: "s-budget",
                message: { t: "plain", v: { role: "user", content: { type: "text", text: "held" } } },
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

            expect(callback).toHaveBeenCalledWith({
                ok: false,
                error: "transaction-unavailable",
                retryAfterMs: expect.any(Number),
            });
            expect(materializeNextPendingMessage).not.toHaveBeenCalled();

            releaseMessage();
            await vi.runAllTimersAsync();
            await Promise.all([heldMessage, materialization]);
            expect(materializeNextPendingMessage).not.toHaveBeenCalled();
        } finally {
            vi.useRealTimers();
        }
    });

    it("defers missing Activity-revision classification to the canonical provider materializer", async () => {
        materializeNextPendingMessage.mockResolvedValueOnce({ ok: false, error: "invalid-params" });
        const authority = {
            accountId: "user-1",
            machineId: "machine-provider-idle",
            sessionId: "s-provider-idle",
            committedFence: new Date(0),
        };
        const runAsCurrentPublisher = vi.fn(async (params: {
            operation: (value: typeof authority) => Promise<unknown>;
        }) => await params.operation(authority));
        const runAsCurrentPublisherInTx = vi.fn(async (params: {
            operation: (value: typeof authority, tx: unknown) => Promise<unknown>;
        }) => await params.operation(authority, {}));
        const socket = createFakeSocket();
        registerSessionUpdateHandler(
            "user-1",
            socket as any,
            { connectionType: "session-scoped", socket: socket as any, userId: "user-1", sessionId: "s-provider-idle" } as any,
            {
                presence: {
                    runAsCurrentPublisher,
                    runAsCurrentPublisherInTx,
                },
                binding: {
                    accountId: "user-1",
                    machineId: "machine-provider-idle",
                    sessionId: "s-provider-idle",
                },
            } as any,
        );

        const handler = getSocketHandler(socket, "pending-materialize-next");
        const callback = vi.fn();
        await handler({
            sid: "s-provider-idle",
            deliveryState: "provider",
            deliveryTiming: "after_runtime_idle",
            foregroundState: "ready",
        }, callback);

        expect(runAsCurrentPublisherInTx).toHaveBeenCalledTimes(1);
        expect(materializeNextPendingMessage).toHaveBeenCalledWith({
            actorUserId: "user-1",
            sessionId: "s-provider-idle",
            deliveryState: "provider",
            deliveryTiming: "after_runtime_idle",
            foregroundState: "ready",
            tx: {},
            publisherAuthority: {
                accountId: "user-1",
                machineId: "machine-provider-idle",
                sessionId: "s-provider-idle",
                committedFence: new Date(0),
            },
        });
        expect(callback).toHaveBeenCalledWith({ ok: false, error: "invalid-params" });
    });

    it.each([null, "", "after_lunch"])(
        "rejects present malformed pending delivery timing %j instead of treating it as legacy omission",
        async (deliveryTiming) => {
            const socket = createFakeSocket();
            registerSessionUpdateHandler(
                "user-1",
                socket as any,
                { connectionType: "session-scoped", socket: socket as any, userId: "user-1", sessionId: "s-malformed-timing" } as any,
            );
            const handler = getSocketHandler(socket, "pending-materialize-next");
            const callback = vi.fn();

            await handler({ sid: "s-malformed-timing", deliveryState: "provider", deliveryTiming }, callback);

            expect(callback).toHaveBeenCalledWith({ ok: false, error: "invalid-params" });
            expect(materializeNextPendingMessage).not.toHaveBeenCalled();
        },
    );

    it("rejects omitted pending delivery timing on the current provider-materialization contract", async () => {
        const socket = createFakeSocket();
        registerSessionUpdateHandler(
            "user-1",
            socket as any,
            { connectionType: "session-scoped", socket: socket as any, userId: "user-1", sessionId: "s-missing-timing" } as any,
        );
        const handler = getSocketHandler(socket, "pending-materialize-next");
        const callback = vi.fn();

        await handler({ sid: "s-missing-timing", deliveryState: "provider" }, callback);

        expect(callback).toHaveBeenCalledWith({ ok: false, error: "invalid-params" });
        expect(materializeNextPendingMessage).not.toHaveBeenCalled();
    });

    it("rejects omitted pending foreground state on the current provider-materialization contract", async () => {
        const socket = createFakeSocket();
        registerSessionUpdateHandler(
            "user-1",
            socket as any,
            { connectionType: "session-scoped", socket: socket as any, userId: "user-1", sessionId: "s-missing-foreground" } as any,
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
    });

    it.each([null, "", "direct"])(
        "rejects present malformed pending delivery state %j instead of treating it as legacy omission",
        async (deliveryState) => {
            const socket = createFakeSocket();
            registerSessionUpdateHandler(
                "user-1",
                socket as any,
                { connectionType: "session-scoped", socket: socket as any, userId: "user-1", sessionId: "s-malformed-state" } as any,
            );
            const handler = getSocketHandler(socket, "pending-materialize-next");
            const callback = vi.fn();

            await handler({ sid: "s-malformed-state", deliveryState }, callback);

            expect(callback).toHaveBeenCalledWith({ ok: false, error: "invalid-params" });
            expect(materializeNextPendingMessage).not.toHaveBeenCalled();
        },
    );

    it.each([null, "", "foreground_unknown"])(
        "rejects present malformed pending foreground state %j instead of treating it as ready",
        async (foregroundState) => {
            const socket = createFakeSocket();
            registerSessionUpdateHandler(
                "user-1",
                socket as any,
                { connectionType: "session-scoped", socket: socket as any, userId: "user-1", sessionId: "s-malformed-foreground" } as any,
            );
            const handler = getSocketHandler(socket, "pending-materialize-next");
            const callback = vi.fn();

            await handler({
                sid: "s-malformed-foreground",
                deliveryState: "provider",
                deliveryTiming: "after_foreground_ready",
                foregroundState,
            }, callback);

            expect(callback).toHaveBeenCalledWith({ ok: false, error: "invalid-params" });
            expect(materializeNextPendingMessage).not.toHaveBeenCalled();
        },
    );

    it("reduces legacy session-end to the exact publisher close and fans out observer-loss Activity", async () => {
        const now = Date.now();
        const socket = createFakeSocket();
        registerSessionUpdateHandler(
            "user-1",
            socket as any,
            { connectionType: "session-scoped", socket: socket as any, userId: "user-1", sessionId: "s-1" } as any,
            trustedPublisher,
        );
        closePublisher.mockResolvedValueOnce({
            status: "closed",
            activeAt: new Date(now),
            participantCursors: [{ accountId: "user-1", cursor: 101 }],
            badgeAttentionChanged: true,
            projection: {
                runtimeActivityState: "unknown",
                runtimeActivityActiveCount: 0,
                runtimeActivityObservedAt: now + 1,
                runtimeActivityRevision: 12,
            },
            turnProjection: {
                latestTurnId: "turn-1",
                latestTurnStatus: "cancelled",
                latestTurnStatusObservedAt: now + 2,
                lastRuntimeIssue: null,
            },
        });

        const callback = vi.fn();
        const handler = getSocketHandler(socket, "session-end");
        await handler({ sid: "s-1", time: now }, callback);

        expect(applySessionTurnMutation).not.toHaveBeenCalled();
        expect(clearSessionRuntimeActivityProjectionInTx).not.toHaveBeenCalled();
        expect(sessionUpdate).not.toHaveBeenCalled();
        expect(buildUpdateSessionUpdate).toHaveBeenCalledWith("s-1", 101, expect.any(String), undefined, undefined, {
            active: false,
            activeAt: now,
            runtimeActivityState: "unknown",
            runtimeActivityActiveCount: 0,
            runtimeActivityObservedAt: now + 1,
            runtimeActivityRevision: 12,
            latestTurnId: "turn-1",
            latestTurnStatus: "cancelled",
            latestTurnStatusObservedAt: now + 2,
            lastRuntimeIssue: null,
        });
        expect(refreshSessionParticipantBadgePushes).toHaveBeenCalledTimes(1);
        expect(refreshSessionParticipantBadgePushes).toHaveBeenCalledWith({
            badgeAttentionChanged: true,
            participantCursors: [{ accountId: "user-1", cursor: 101 }],
        });
        expect(callback).toHaveBeenCalledWith({
            ok: true,
            applied: true,
            active: false,
            activeAt: now,
            projection: { active: false, activeAt: now },
        });
    });

    it("confirms a committed close replay without duplicate cursors, fanout, or badge refresh", async () => {
        const now = Date.now();
        const socket = createFakeSocket();
        registerSessionUpdateHandler(
            "user-1",
            socket as any,
            { connectionType: "session-scoped", socket: socket as any, userId: "user-1", sessionId: "s-1" } as any,
            trustedPublisher,
        );
        closePublisher
            .mockResolvedValueOnce({
                status: "closed",
                activeAt: new Date(now),
                participantCursors: [{ accountId: "user-1", cursor: 101 }],
                badgeAttentionChanged: true,
            })
            .mockResolvedValueOnce({ status: "closed_replay", activeAt: new Date(now) });

        const handler = getSocketHandler(socket, "session-end");
        const firstCallback = vi.fn();
        const replayCallback = vi.fn();
        await handler({ sid: "s-1", time: now }, firstCallback);
        await handler({ sid: "s-1", time: now }, replayCallback);

        expect(emitUpdate).toHaveBeenCalledTimes(1);
        expect(refreshSessionParticipantBadgePushes).toHaveBeenCalledTimes(1);
        expect(firstCallback).toHaveBeenCalledWith(expect.objectContaining({ ok: true, applied: true, active: false, activeAt: now }));
        expect(replayCallback).toHaveBeenCalledWith({
            ok: true,
            applied: false,
            active: false,
            activeAt: now,
            projection: { active: false, activeAt: now },
        });
    });

    it("leaves released user-scoped session-end to the compatibility owner", async () => {
        const socket = createFakeSocket();
        registerSessionUpdateHandler(
            "user-1",
            socket as any,
            { connectionType: "user-scoped", socket: socket as any, userId: "user-1" } as any,
        );

        expect(socket.handlers.has("session-end")).toBe(false);
        expect(closePublisher).not.toHaveBeenCalled();
        expect(sessionUpdate).not.toHaveBeenCalled();
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
        expect(sessionUpdate).not.toHaveBeenCalled();
    });

});
