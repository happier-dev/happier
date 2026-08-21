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

type AccessKeyAccessProof = Readonly<{
    machine: Readonly<{ revokedAt: Date | null; replacedByMachineId: string | null }>;
    session: Readonly<{ accountId: string }>;
}>;

const accessKeyFindUnique = vi.hoisted(() => vi.fn(async (): Promise<AccessKeyAccessProof | null> => ({
    machine: { revokedAt: null, replacedByMachineId: null },
    session: { accountId: "u1" },
})));
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

function createOwnerSessionSocket() {
    const socket = createFakeSocket();
    (socket as any).data = {
        machineId: "m1",
        sessionScopedBinding: {
            sessionId: "s1",
            machineId: "m1",
            proof: "machine-access-key",
        },
    };
    return socket;
}

describe("sessionUpdateHandler (transcript-stream-segment relay)", () => {
    beforeEach(async () => {
        const { clearSessionRelayAuthorizationCache } = await import("./sessionRelayAuthCache");
        clearSessionRelayAuthorizationCache();
        emitEphemeral.mockReset();
        websocketEventsCounterInc.mockReset();
        checkSessionAccess.mockReset();
        requireAccessLevel.mockReset();
        getSessionParticipantUserIds.mockReset();
        accessKeyFindUnique.mockReset();
        accessKeyFindUnique.mockResolvedValue({
            machine: { revokedAt: null, replacedByMachineId: null },
            session: { accountId: "u1" },
        });
        checkSessionAccess.mockImplementation(async (userId, sessionId) => ({
            userId,
            sessionId,
            level: "edit",
            isOwner: true,
        } as any));
        requireAccessLevel.mockReturnValue(true);
        getSessionParticipantUserIds.mockResolvedValue(["u1", "u2"]);
    });

    it("relays transcript-stream-segment snapshots preserving the live-stream tick", async () => {
        const { sessionUpdateHandler } = await import("./sessionUpdateHandler");

        const socket = createOwnerSessionSocket();
        const connection = { connectionType: "session-scoped", socket: socket as any, userId: "u1", sessionId: "s1" } as any;
        sessionUpdateHandler("u1", socket as any, connection);

        const handler = getSocketHandler(socket, "transcript-stream-segment");
        await handler({
            sid: "s1",
            message: {
                localId: "segment-1",
                messageRole: "agent",
                tick: 25,
                content: { t: "encrypted", c: "cipher" },
                createdAt: 1_000,
                updatedAt: 1_040,
                unknownFutureField: true,
            },
        });

        expect(emitEphemeral).toHaveBeenCalledTimes(2);
        expect(emitEphemeral).toHaveBeenCalledWith(expect.objectContaining({
            userId: "u2",
            payload: expect.objectContaining({
                type: "transcript-stream-segment",
                sessionId: "s1",
                message: expect.objectContaining({
                    localId: "segment-1",
                    tick: 25,
                }),
            }),
            recipientFilter: { type: "all-interested-in-session", sessionId: "s1" },
        }));
    });

    it("relays transcript-stream-segment-delta ticks to all session participants", async () => {
        const { sessionUpdateHandler } = await import("./sessionUpdateHandler");

        const socket = createOwnerSessionSocket();
        const connection = { connectionType: "session-scoped", socket: socket as any, userId: "u1", sessionId: "s1" } as any;
        sessionUpdateHandler("u1", socket as any, connection);

        const handler = getSocketHandler(socket, "transcript-stream-segment-delta");
        await handler({
            sid: "s1",
            message: {
                localId: "segment-1",
                messageRole: "agent",
                tick: 2,
                baseLength: 5,
                content: { t: "encrypted", c: "cipher-of-delta" },
                createdAt: 1_000,
                updatedAt: 1_040,
            },
        });

        expect(emitEphemeral).toHaveBeenCalledTimes(2);
        for (const userId of ["u1", "u2"]) {
            expect(emitEphemeral).toHaveBeenCalledWith(expect.objectContaining({
                userId,
                payload: expect.objectContaining({
                    type: "transcript-stream-segment-delta",
                    sessionId: "s1",
                    message: expect.objectContaining({
                        localId: "segment-1",
                        tick: 2,
                        baseLength: 5,
                    }),
                }),
                recipientFilter: { type: "all-interested-in-session", sessionId: "s1" },
            }));
        }

        const ownerCall = emitEphemeral.mock.calls
            .map((call) => call[0])
            .find((payload) => payload?.userId === "u1");
        expect(ownerCall?.skipSenderConnection).toBe(connection);
    });

    it("verifies relay authorization once and serves subsequent stream events from the cached binding", async () => {
        const { sessionUpdateHandler } = await import("./sessionUpdateHandler");
        const { invalidateSessionRelayAuthorizationForSession } = await import("./sessionRelayAuthCache");

        const socket = createOwnerSessionSocket();
        const connection = { connectionType: "session-scoped", socket: socket as any, userId: "u1", sessionId: "s1" } as any;
        sessionUpdateHandler("u1", socket as any, connection);

        const handler = getSocketHandler(socket, "transcript-stream-segment-delta");
        const deltaEvent = (tick: number) => ({
            sid: "s1",
            message: {
                localId: "segment-1",
                messageRole: "agent",
                tick,
                baseLength: 5,
                content: { t: "encrypted", c: "cipher-of-delta" },
                createdAt: 1_000,
                updatedAt: 1_040,
            },
        });

        await handler(deltaEvent(1));
        await handler(deltaEvent(2));

        expect(accessKeyFindUnique).toHaveBeenCalledTimes(1);
        expect(checkSessionAccess).toHaveBeenCalledTimes(1);
        expect(getSessionParticipantUserIds).toHaveBeenCalledTimes(1);
        expect(emitEphemeral).toHaveBeenCalledTimes(4);

        invalidateSessionRelayAuthorizationForSession("s1");
        await handler(deltaEvent(3));

        expect(accessKeyFindUnique).toHaveBeenCalledTimes(2);
        expect(checkSessionAccess).toHaveBeenCalledTimes(2);
        expect(getSessionParticipantUserIds).toHaveBeenCalledTimes(2);
        expect(emitEphemeral).toHaveBeenCalledTimes(6);
    });

    it("drops transcript-stream-segment-delta payloads missing chaining fields", async () => {
        const { sessionUpdateHandler } = await import("./sessionUpdateHandler");

        const socket = createOwnerSessionSocket();
        const connection = { connectionType: "session-scoped", socket: socket as any, userId: "u1", sessionId: "s1" } as any;
        sessionUpdateHandler("u1", socket as any, connection);

        const handler = getSocketHandler(socket, "transcript-stream-segment-delta");
        await handler({
            sid: "s1",
            message: {
                localId: "segment-1",
                messageRole: "agent",
                content: { t: "encrypted", c: "cipher" },
                createdAt: 1_000,
                updatedAt: 1_040,
            },
        });

        expect(emitEphemeral).not.toHaveBeenCalled();
    });

    it("does not relay transcript-stream-segment-delta from non-owner sessions", async () => {
        checkSessionAccess.mockImplementation(async (userId, sessionId) => ({
            userId,
            sessionId,
            level: "edit",
            isOwner: false,
        } as any));

        const { sessionUpdateHandler } = await import("./sessionUpdateHandler");

        const socket = createOwnerSessionSocket();
        const connection = { connectionType: "session-scoped", socket: socket as any, userId: "u1", sessionId: "s1" } as any;
        sessionUpdateHandler("u1", socket as any, connection);

        const handler = getSocketHandler(socket, "transcript-stream-segment-delta");
        await handler({
            sid: "s1",
            message: {
                localId: "segment-1",
                messageRole: "agent",
                tick: 2,
                baseLength: 5,
                content: { t: "encrypted", c: "cipher" },
                createdAt: 1_000,
                updatedAt: 1_040,
            },
        });

        expect(emitEphemeral).not.toHaveBeenCalled();
    });
});
