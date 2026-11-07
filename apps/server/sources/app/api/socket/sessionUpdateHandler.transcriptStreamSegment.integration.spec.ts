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

// SQLite snapshots use a dedicated persistent connection, outside db.$transaction.
vi.mock("@/storage/prisma", async importOriginal => ({
    ...await importOriginal<typeof import("@/storage/prisma")>(),
    withSqliteReadSnapshot: (await import("../testkit/sessionPublicationDb")).createSessionPublicationDbFixture({
        sessionId: "s1",
        readSession: (...args: unknown[]) => sessionFindUnique(...args),
    }).readSnapshot,
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
    beforeEach(() => {
        emitEphemeral.mockReset();
        websocketEventsCounterInc.mockReset();
        sessionFindUnique.mockReset();
        sessionFindUnique.mockResolvedValue({
            accountId: "u1",
            shares: [{ id: "share-u2", sharedWithUserId: "u2", accessLevel: "view", canApprovePermissions: false }],
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
        });
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

    it("does not relay finite snapshot or delta stream observations to a collaborator", async () => {
        sessionFindUnique.mockResolvedValue({
            accountId: "u1",
            shares: [],
            currentStorageState: "snapshot_complete",
            acceptedThroughServerSeq: 4,
            materializationPublicationId: "stream-publication-v1",
            materializedThroughSourceAt: 42_000n,
            publishedThroughServerSeq: 4,
            seq: 9,
            lastViewedSessionSeq: 9,
            latestReadyEventSeq: 9,
            latestReadyEventAt: new Date(90_000),
            createdAt: new Date(10_000),
            updatedAt: new Date(90_000),
            meaningfulActivityAt: new Date(90_000),
            lastActiveAt: new Date(90_000),
        });
        const { sessionUpdateHandler } = await import("./sessionUpdateHandler");
        const socket = createOwnerSessionSocket();
        const connection = { connectionType: "session-scoped", socket: socket as any, userId: "u1", sessionId: "s1" } as any;
        sessionUpdateHandler("u1", socket as any, connection);

        await getSocketHandler(socket, "transcript-stream-segment")({
            sid: "s1",
            message: {
                localId: "finite-segment",
                messageRole: "agent",
                tick: 1,
                content: { t: "encrypted", c: "finite-cipher" },
                createdAt: 90_000,
                updatedAt: 90_000,
            },
        });
        await getSocketHandler(socket, "transcript-stream-segment-delta")({
            sid: "s1",
            message: {
                localId: "finite-segment",
                messageRole: "agent",
                tick: 2,
                baseLength: 4,
                content: { t: "encrypted", c: "finite-delta" },
                createdAt: 90_000,
                updatedAt: 90_000,
            },
        });

        expect(emitEphemeral.mock.calls.map(([event]) => event?.userId)).not.toContain("u2");
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

});
