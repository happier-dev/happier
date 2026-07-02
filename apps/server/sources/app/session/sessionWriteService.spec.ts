import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createEnvPatcher } from "@/testkit/env";
import { createDbMocks, installDbModuleMock } from "../api/testkit/dbMocks";

type MockFunction = ReturnType<typeof vi.fn>;
type SessionWriteTxMock = {
    $queryRawUnsafe?: MockFunction;
    session: {
        findUnique: MockFunction;
        update: MockFunction;
        updateMany: MockFunction;
    };
    sessionShare: {
        findUnique: MockFunction;
    };
    sessionMessage: {
        findUnique: MockFunction;
        create: MockFunction;
        update: MockFunction;
    };
    sessionTurn: {
        findUnique: MockFunction;
        findFirst: MockFunction;
        create: MockFunction;
        update: MockFunction;
    };
    sessionTurnMutationReceipt: {
        findUnique: MockFunction;
        create: MockFunction;
        update: MockFunction;
    };
};

let currentTx: SessionWriteTxMock;

vi.mock("@/storage/inTx", () => ({
    inTx: async <T>(fn: (tx: SessionWriteTxMock) => T | Promise<T>) => await fn(currentTx),
}));

const getSessionParticipantUserIds = vi.fn<(...args: unknown[]) => Promise<string[]>>();
vi.mock("@/app/share/sessionParticipants", () => ({
    getSessionParticipantUserIds: (...args: unknown[]) => getSessionParticipantUserIds(...args),
}));

const markAccountChanged = vi.fn<(...args: unknown[]) => Promise<number>>();
vi.mock("@/app/changes/markAccountChanged", () => ({
    markAccountChanged: (...args: unknown[]) => markAccountChanged(...args),
}));

const observeCreateSessionMessageStage = vi.fn<(...args: unknown[]) => void>();
const sessionMessageRoleMismatchCounter = { inc: vi.fn<(...args: unknown[]) => void>() };
vi.mock("@/app/monitoring/metrics/sessionWriteMetrics", () => ({
    observeCreateSessionMessageStage: (...args: unknown[]) => observeCreateSessionMessageStage(...args),
    sessionMessageRoleMismatchCounter,
}));

const dbMocks = createDbMocks({
    session: ["findUnique"],
    sessionShare: ["findUnique"],
    sessionMessage: ["findUnique"],
} as const);
installDbModuleMock({ db: dbMocks.db });

let createSessionMessage: typeof import("./sessionWriteService").createSessionMessage;
let patchSession: typeof import("./sessionWriteService").patchSession;
let applySessionReadCursorOperation: typeof import("./sessionWriteService").applySessionReadCursorOperation;
let applySessionTurnMutation: typeof import("./sessionWriteService").applySessionTurnMutation;
let sessionWriteServiceExports: typeof import("./sessionWriteService");
let updateSessionAgentState: typeof import("./sessionWriteService").updateSessionAgentState;
let updateSessionMetadata: typeof import("./sessionWriteService").updateSessionMetadata;
let updateSessionReadCursor: typeof import("./sessionWriteService").updateSessionReadCursor;

describe("sessionWriteService", () => {
    const storagePolicyEnv = createEnvPatcher([
        "HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY",
        "HAPPIER_DB_PROVIDER",
    ]);

    beforeAll(async () => {
        const service: typeof import("./sessionWriteService") = await import("./sessionWriteService");
        sessionWriteServiceExports = service;
        ({
            applySessionReadCursorOperation,
            createSessionMessage,
            patchSession,
            updateSessionAgentState,
            updateSessionMetadata,
            updateSessionReadCursor,
        } = service);
        applySessionTurnMutation = service.applySessionTurnMutation;
    });

    beforeEach(() => {
        getSessionParticipantUserIds.mockReset();
        markAccountChanged.mockReset();
        observeCreateSessionMessageStage.mockReset();
        sessionMessageRoleMismatchCounter.inc.mockReset();
        dbMocks.reset();
        storagePolicyEnv.restore();

        currentTx = {
            session: {
                findUnique: vi.fn(),
                update: vi.fn(),
                updateMany: vi.fn(),
            },
            sessionShare: {
                findUnique: vi.fn(),
            },
            sessionMessage: {
                findUnique: vi.fn(),
                create: vi.fn(),
                update: vi.fn(),
            },
            sessionTurn: {
                findUnique: vi.fn(),
                findFirst: vi.fn(),
                create: vi.fn(),
                update: vi.fn(),
            },
            sessionTurnMutationReceipt: {
                findUnique: vi.fn(),
                create: vi.fn(),
                update: vi.fn(),
            },
        };
    });

    it("does not expose the legacy primary turn projection mutation adapter", () => {
        expect(Object.prototype.hasOwnProperty.call(sessionWriteServiceExports, "applyPrimaryTurnProjectionMutation")).toBe(false);
    });

    describe("createSessionMessage", () => {
        it("returns existing message for (sessionId, localId) without writing or marking changes", async () => {
            currentTx.session.findUnique.mockResolvedValue({ accountId: "u1" });
            currentTx.sessionShare.findUnique.mockResolvedValue(null);
            currentTx.session.update.mockResolvedValue({ seq: 10 });
            currentTx.sessionMessage.create.mockRejectedValue({ code: "P2002" });

            dbMocks.db.session.findUnique.mockResolvedValue({ accountId: "u1" });
            dbMocks.db.sessionShare.findUnique.mockResolvedValue(null);
            dbMocks.db.sessionMessage.findUnique.mockResolvedValue({
                id: "m1",
                seq: 4,
                localId: "l1",
                sidechainId: null,
                content: { t: "encrypted", c: "c1" },
                createdAt: new Date(1),
                updatedAt: new Date(2),
            });

            const res = await createSessionMessage({
                actorUserId: "u1",
                sessionId: "s1",
                ciphertext: "c1",
                localId: "l1",
            });

            expect(res).toEqual({
                ok: true,
                didWrite: false,
                didUpdate: false,
                badgeAttentionChanged: false,
                message: {
                    id: "m1",
                    seq: 4,
                    localId: "l1",
                    sidechainId: null,
                    messageRole: null,
                    content: { t: "encrypted", c: "c1" },
                    createdAt: new Date(1),
                    updatedAt: new Date(2),
                },
                participantCursors: [],
            });
            expect(currentTx.session.update).toHaveBeenCalledWith(expect.objectContaining({
                where: { id: "s1" },
                select: { seq: true },
                data: expect.objectContaining({ seq: { increment: 1 } }),
            }));
            expect(currentTx.sessionMessage.create).toHaveBeenCalledWith(
                expect.objectContaining({
                    data: expect.objectContaining({ sessionId: "s1", localId: "l1" }),
                }),
            );
            expect(currentTx.sessionMessage.update).not.toHaveBeenCalled();
            expect(markAccountChanged).not.toHaveBeenCalled();
        });

        it("rejects (sessionId, localId) reuse across sidechains", async () => {
            currentTx.session.findUnique.mockResolvedValue({ accountId: "u1" });
            currentTx.sessionShare.findUnique.mockResolvedValue(null);
            currentTx.session.update.mockResolvedValue({ seq: 10 });
            currentTx.sessionMessage.create.mockRejectedValue({ code: "P2002" });

            dbMocks.db.session.findUnique.mockResolvedValue({ accountId: "u1" });
            dbMocks.db.sessionShare.findUnique.mockResolvedValue(null);
            dbMocks.db.sessionMessage.findUnique.mockResolvedValue({
                id: "m1",
                seq: 4,
                localId: "l1",
                sidechainId: "sc-1",
                content: { t: "encrypted", c: "c1" },
                createdAt: new Date(1),
                updatedAt: new Date(2),
            });

            const res = await createSessionMessage({
                actorUserId: "u1",
                sessionId: "s1",
                ciphertext: "c1",
                localId: "l1",
                sidechainId: null,
            });

            expect(res).toEqual({ ok: false, error: "invalid-params" });
            expect(currentTx.session.update).toHaveBeenCalledTimes(1);
            expect(currentTx.sessionMessage.create).toHaveBeenCalledTimes(1);
            expect(currentTx.sessionMessage.update).not.toHaveBeenCalled();
            expect(markAccountChanged).not.toHaveBeenCalled();
        });

        it("updates existing message content for (sessionId, localId) when payload changes", async () => {
            const createdAt = new Date("2020-01-01T00:00:00.000Z");
            const updatedAt = new Date("2020-01-01T00:00:00.000Z");

            currentTx.session.findUnique.mockResolvedValue({
                accountId: "u1",
                shares: [{ sharedWithUserId: "u2" }],
            });
            currentTx.sessionShare.findUnique.mockResolvedValue(null);
            currentTx.session.update.mockResolvedValue({ seq: 10 });
            currentTx.sessionMessage.create.mockRejectedValue({ code: "P2002" });

            dbMocks.db.session.findUnique.mockResolvedValue({
                accountId: "u1",
                shares: [{ sharedWithUserId: "u2" }],
            });
            dbMocks.db.sessionShare.findUnique.mockResolvedValue(null);
            dbMocks.db.sessionMessage.findUnique.mockResolvedValue({
                id: "m1",
                seq: 4,
                localId: "l1",
                sidechainId: null,
                content: { t: "encrypted", c: "prev" },
                createdAt,
                updatedAt,
            });

            currentTx.sessionMessage.update.mockResolvedValue({
                id: "m1",
                seq: 4,
                localId: "l1",
                sidechainId: null,
                content: { t: "encrypted", c: "next" },
                createdAt,
                updatedAt,
            });

            getSessionParticipantUserIds.mockResolvedValue(["u1", "u2"]);
            markAccountChanged.mockResolvedValueOnce(101).mockResolvedValueOnce(102);

            const res = await createSessionMessage({
                actorUserId: "u1",
                sessionId: "s1",
                ciphertext: "next",
                localId: "l1",
            });

            expect(res.ok).toBe(true);
            if (!res.ok) throw new Error("expected ok");

            expect(res).toEqual({
                ok: true,
                didWrite: false,
                didUpdate: true,
                badgeAttentionChanged: false,
                message: expect.objectContaining({ id: "m1", seq: 4, localId: "l1" }),
                participantCursors: [
                    { accountId: "u1", cursor: 101 },
                    { accountId: "u2", cursor: 102 },
                ],
            });

            expect(currentTx.session.update).toHaveBeenCalledTimes(1);
            expect(currentTx.sessionMessage.create).toHaveBeenCalledTimes(1);
            expect(currentTx.sessionMessage.update).toHaveBeenCalledWith(
                expect.objectContaining({
                    where: { id: "m1" },
                    data: { content: { t: "encrypted", c: "next" }, sidechainId: null, messageRole: null },
                }),
            );
            expect(getSessionParticipantUserIds).not.toHaveBeenCalled();
        });

        it("rejects message creation if actor has no edit access", async () => {
            currentTx.sessionMessage.findUnique.mockResolvedValue(null);
            currentTx.session.findUnique.mockResolvedValue({ accountId: "owner" });
            currentTx.sessionShare.findUnique.mockResolvedValue(null);

            const res = await createSessionMessage({
                actorUserId: "u2",
                sessionId: "s1",
                ciphertext: "c1",
            });

            expect(res).toEqual({ ok: false, error: "forbidden" });
            expect(currentTx.session.update).not.toHaveBeenCalled();
            expect(markAccountChanged).not.toHaveBeenCalled();
        });

        it("creates a message, marks changes for all participants, and returns per-recipient cursors", async () => {
            const createdAt = new Date("2020-01-01T00:00:00.000Z");
            const updatedAt = new Date("2020-01-01T00:00:00.000Z");

            currentTx.sessionMessage.findUnique.mockResolvedValue(null);
            currentTx.session.findUnique
                .mockResolvedValueOnce({
                    accountId: "u1",
                    shares: [{ sharedWithUserId: "u2" }],
                })
                .mockResolvedValueOnce({
                    seq: 9,
                    lastViewedSessionSeq: 9,
                    pendingCount: 0,
                    pendingPermissionRequestCount: 0,
                    pendingUserActionRequestCount: 0,
                    active: true,
                    archivedAt: null,
                });
            currentTx.session.update.mockResolvedValue({ seq: 10 });
            currentTx.sessionMessage.create.mockResolvedValue({
                id: "m1",
                seq: 10,
                localId: "l1",
                sidechainId: null,
                content: { t: "encrypted", c: "cipher" },
                createdAt,
                updatedAt,
            });

            getSessionParticipantUserIds.mockResolvedValue(["u1", "u2"]);
            markAccountChanged.mockResolvedValueOnce(101).mockResolvedValueOnce(102);

            const res = await createSessionMessage({
                actorUserId: "u1",
                sessionId: "s1",
                ciphertext: "cipher",
                localId: "l1",
            });

            expect(res.ok).toBe(true);
            if (!res.ok || res.didWrite === false) throw new Error("expected ok + didWrite");
            expect(res.didUpdate).toBe(false);

            expect(res.message.id).toBe("m1");
            expect(res.message.seq).toBe(10);
            expect(res.badgeAttentionChanged).toBe(true);
            expect(res.participantCursors).toEqual([
                { accountId: "u1", cursor: 101 },
                { accountId: "u2", cursor: 102 },
            ]);

            expect(markAccountChanged).toHaveBeenCalledWith(expect.anything(), {
                accountId: "u1",
                kind: "session",
                entityId: "s1",
                hint: { lastMessageSeq: 10, lastMessageId: "m1" },
            });
            expect(markAccountChanged).toHaveBeenCalledWith(expect.anything(), {
                accountId: "u2",
                kind: "session",
                entityId: "s1",
                hint: { lastMessageSeq: 10, lastMessageId: "m1" },
            });
            expect(getSessionParticipantUserIds).not.toHaveBeenCalled();
            expect(currentTx.session.findUnique).toHaveBeenCalledTimes(1);
            expect(currentTx.sessionMessage.findUnique).not.toHaveBeenCalled();
            expect(currentTx.session.updateMany).toHaveBeenCalledTimes(1);
            expect(currentTx.session.updateMany).toHaveBeenCalledWith({
                where: { id: "s1", seq: 10 },
                data: {
                    meaningfulActivityAt: createdAt,
                },
            });
        });

        it("captures message and ready timestamps after the session seq increment lock is acquired", async () => {
            const createdAt = new Date("2020-01-01T00:00:00.000Z");

            currentTx.session.findUnique.mockResolvedValueOnce({
                accountId: "u1",
                shares: [],
            });
            currentTx.session.update.mockResolvedValue({ seq: 10 });
            currentTx.session.updateMany.mockResolvedValue({ count: 1 });
            currentTx.sessionMessage.create.mockResolvedValue({
                id: "m_ready",
                seq: 10,
                localId: "ready-local",
                sidechainId: null,
                messageRole: "event",
                content: { t: "encrypted", c: "cipher" },
                createdAt,
                updatedAt: createdAt,
            });
            markAccountChanged.mockResolvedValueOnce(101);

            const res = await createSessionMessage({
                actorUserId: "u1",
                sessionId: "s1",
                ciphertext: "cipher",
                localId: "ready-local",
                messageRole: "event",
                trustedSessionEventType: "ready",
            } as Parameters<typeof createSessionMessage>[0]);

            expect(res.ok).toBe(true);
            if (!res.ok) return;
            expect(res).toMatchObject({
                readyProjection: {
                    latestReadyEventSeq: 10,
                    latestReadyEventAt: createdAt.getTime(),
                },
            });
            expect(currentTx.session.update).toHaveBeenCalledWith({
                where: { id: "s1" },
                select: { seq: true },
                data: {
                    seq: { increment: 1 },
                },
            });
            expect(currentTx.session.updateMany).toHaveBeenNthCalledWith(1, {
                where: { id: "s1", seq: 10 },
                data: {
                    meaningfulActivityAt: createdAt,
                },
            });
            expect(currentTx.session.updateMany).toHaveBeenNthCalledWith(2, {
                where: {
                    id: "s1",
                    OR: [
                        { latestReadyEventSeq: null },
                        { latestReadyEventSeq: { lt: 10 } },
                    ],
                },
                data: {
                    latestReadyEventSeq: 10,
                    latestReadyEventAt: createdAt,
                },
            });
        });

        it("persists a ready-event projection when a later message already advanced the session seq", async () => {
            const createdAt = new Date("2020-01-01T00:00:00.000Z");

            currentTx.session.findUnique.mockResolvedValueOnce({
                accountId: "u1",
                shares: [],
            });
            currentTx.session.update.mockResolvedValue({ seq: 10 });
            currentTx.session.updateMany
                .mockResolvedValueOnce({ count: 0 })
                .mockResolvedValueOnce({ count: 1 });
            currentTx.sessionMessage.create.mockResolvedValue({
                id: "m_ready",
                seq: 10,
                localId: "ready-local",
                sidechainId: null,
                messageRole: "event",
                content: { t: "encrypted", c: "cipher" },
                createdAt,
                updatedAt: createdAt,
            });
            markAccountChanged.mockResolvedValueOnce(101);

            const res = await createSessionMessage({
                actorUserId: "u1",
                sessionId: "s1",
                ciphertext: "cipher",
                localId: "ready-local",
                messageRole: "event",
                trustedSessionEventType: "ready",
            } as Parameters<typeof createSessionMessage>[0]);

            expect(res.ok).toBe(true);
            if (!res.ok) return;
            expect(res).toMatchObject({
                readyProjection: {
                    latestReadyEventSeq: 10,
                    latestReadyEventAt: createdAt.getTime(),
                },
            });
            expect(currentTx.session.updateMany).toHaveBeenNthCalledWith(1, {
                where: { id: "s1", seq: 10 },
                data: {
                    meaningfulActivityAt: createdAt,
                },
            });
            expect(currentTx.session.updateMany).toHaveBeenNthCalledWith(2, {
                where: {
                    id: "s1",
                    OR: [
                        { latestReadyEventSeq: null },
                        { latestReadyEventSeq: { lt: 10 } },
                    ],
                },
                data: {
                    latestReadyEventSeq: 10,
                    latestReadyEventAt: createdAt,
                },
            });
        });

        it("does not return a ready-event projection when a newer ready event already won", async () => {
            const createdAt = new Date("2020-01-01T00:00:00.000Z");

            currentTx.session.findUnique.mockResolvedValueOnce({
                accountId: "u1",
                shares: [],
            });
            currentTx.session.update.mockResolvedValue({ seq: 10 });
            currentTx.session.updateMany
                .mockResolvedValueOnce({ count: 1 })
                .mockResolvedValueOnce({ count: 0 });
            currentTx.sessionMessage.create.mockResolvedValue({
                id: "m_ready",
                seq: 10,
                localId: "ready-local",
                sidechainId: null,
                messageRole: "event",
                content: { t: "encrypted", c: "cipher" },
                createdAt,
                updatedAt: createdAt,
            });
            markAccountChanged.mockResolvedValueOnce(101);

            const res = await createSessionMessage({
                actorUserId: "u1",
                sessionId: "s1",
                ciphertext: "cipher",
                localId: "ready-local",
                messageRole: "event",
                trustedSessionEventType: "ready",
            } as Parameters<typeof createSessionMessage>[0]);

            expect(res.ok).toBe(true);
            if (!res.ok) return;
            expect(currentTx.session.updateMany).toHaveBeenNthCalledWith(2, {
                where: {
                    id: "s1",
                    OR: [
                        { latestReadyEventSeq: null },
                        { latestReadyEventSeq: { lt: 10 } },
                    ],
                },
                data: {
                    latestReadyEventSeq: 10,
                    latestReadyEventAt: createdAt,
                },
            });
            expect(res).toMatchObject({
                ok: true,
                didWrite: true,
            });
            expect(res).not.toHaveProperty("readyProjection");
        });

        it("persists a ready-event projection for owner-authored plaintext ready events without a trusted hint", async () => {
            const createdAt = new Date("2020-01-01T00:00:00.000Z");
            const readyContent = {
                t: "plain",
                v: {
                    role: "agent",
                    content: {
                        type: "event",
                        id: "ready-event-1",
                        data: { type: "ready" },
                    },
                },
            } satisfies PrismaJson.SessionMessageContent;

            currentTx.sessionMessage.findUnique.mockResolvedValue(null);
            currentTx.session.findUnique
                .mockResolvedValueOnce({
                    accountId: "u1",
                    encryptionMode: "plain",
                    shares: [],
                    seq: 9,
                    lastViewedSessionSeq: 9,
                    pendingCount: 0,
                    pendingPermissionRequestCount: 0,
                    pendingUserActionRequestCount: 0,
                    active: true,
                    archivedAt: null,
                    latestTurnStatus: null,
                    lastRuntimeIssue: null,
                })
                .mockResolvedValueOnce({
                    seq: 9,
                    lastViewedSessionSeq: 9,
                    pendingCount: 0,
                    pendingPermissionRequestCount: 0,
                    pendingUserActionRequestCount: 0,
                    active: true,
                    archivedAt: null,
                    latestTurnStatus: null,
                    lastRuntimeIssue: null,
                });
            currentTx.session.update.mockResolvedValue({ seq: 10 });
            currentTx.session.updateMany.mockResolvedValue({ count: 1 });
            currentTx.sessionMessage.create.mockResolvedValue({
                id: "m_ready_plain",
                seq: 10,
                localId: "ready-plain-local",
                sidechainId: null,
                messageRole: "event",
                content: readyContent,
                createdAt,
                updatedAt: createdAt,
            });
            markAccountChanged.mockResolvedValueOnce(101);

            const res = await createSessionMessage({
                actorUserId: "u1",
                sessionId: "s1",
                content: readyContent,
                localId: "ready-plain-local",
                messageRole: "event",
            });

            expect(res.ok).toBe(true);
            if (!res.ok) return;
            expect(currentTx.session.updateMany).toHaveBeenNthCalledWith(1, {
                where: { id: "s1", seq: 10 },
                data: {
                    meaningfulActivityAt: createdAt,
                },
            });
            expect(currentTx.session.updateMany).toHaveBeenNthCalledWith(2, {
                where: {
                    id: "s1",
                    OR: [
                        { latestReadyEventSeq: null },
                        { latestReadyEventSeq: { lt: 10 } },
                    ],
                },
                data: {
                    latestReadyEventSeq: 10,
                    latestReadyEventAt: createdAt,
                },
            });
            expect(res).toMatchObject({
                ok: true,
                didWrite: true,
                readyProjection: {
                    latestReadyEventSeq: 10,
                    latestReadyEventAt: createdAt.getTime(),
                },
            });
        });

        it("does not let collaborators project ready state from a supplied ready event hint", async () => {
            const createdAt = new Date("2020-01-01T00:00:00.000Z");

            currentTx.sessionMessage.findUnique.mockResolvedValue(null);
            currentTx.session.findUnique
                .mockResolvedValueOnce({
                    accountId: "owner-1",
                    encryptionMode: "e2ee",
                    shares: [],
                    seq: 9,
                    lastViewedSessionSeq: 9,
                    pendingCount: 0,
                    pendingPermissionRequestCount: 0,
                    pendingUserActionRequestCount: 0,
                    active: true,
                    archivedAt: null,
                    latestTurnStatus: null,
                    lastRuntimeIssue: null,
                })
                .mockResolvedValueOnce({
                    seq: 9,
                    lastViewedSessionSeq: 9,
                    pendingCount: 0,
                    pendingPermissionRequestCount: 0,
                    pendingUserActionRequestCount: 0,
                    active: true,
                    archivedAt: null,
                    latestTurnStatus: null,
                    lastRuntimeIssue: null,
                });
            currentTx.sessionShare.findUnique.mockResolvedValue({ accessLevel: "edit" });
            currentTx.session.update.mockResolvedValue({ seq: 10 });
            currentTx.session.updateMany.mockResolvedValue({ count: 1 });
            currentTx.sessionMessage.create.mockResolvedValue({
                id: "m_collab_ready",
                seq: 10,
                localId: "collab-ready-local",
                sidechainId: null,
                messageRole: "event",
                content: { t: "encrypted", c: "cipher" },
                createdAt,
                updatedAt: createdAt,
            });
            markAccountChanged.mockResolvedValueOnce(101).mockResolvedValueOnce(102);

            const res = await createSessionMessage({
                actorUserId: "collab-1",
                sessionId: "s1",
                ciphertext: "cipher",
                localId: "collab-ready-local",
                messageRole: "event",
                trustedSessionEventType: "ready",
            } as Parameters<typeof createSessionMessage>[0]);

            expect(res.ok).toBe(true);
            if (!res.ok) return;
            expect(currentTx.session.updateMany).toHaveBeenCalledTimes(1);
            expect(currentTx.session.updateMany).toHaveBeenCalledWith({
                where: { id: "s1", seq: 10 },
                data: {
                    meaningfulActivityAt: createdAt,
                },
            });
            expect(res).toMatchObject({
                ok: true,
                didWrite: true,
            });
            expect(res).not.toHaveProperty("readyProjection");
        });

        it("stores supplied encrypted message role metadata when creating a message", async () => {
            const createdAt = new Date("2020-01-01T00:00:00.000Z");

            currentTx.sessionMessage.findUnique.mockResolvedValue(null);
            currentTx.session.findUnique
                .mockResolvedValueOnce({
                    accountId: "u1",
                    shares: [],
                    seq: 9,
                    lastViewedSessionSeq: 9,
                    pendingCount: 0,
                    pendingPermissionRequestCount: 0,
                    pendingUserActionRequestCount: 0,
                    active: true,
                    archivedAt: null,
                })
                .mockResolvedValueOnce({
                    seq: 9,
                    lastViewedSessionSeq: 9,
                    pendingCount: 0,
                    pendingPermissionRequestCount: 0,
                    pendingUserActionRequestCount: 0,
                    active: true,
                    archivedAt: null,
                });
            currentTx.session.update.mockResolvedValue({ seq: 10 });
            currentTx.sessionMessage.create.mockResolvedValue({
                id: "m1",
                seq: 10,
                localId: "l1",
                sidechainId: null,
                messageRole: "user",
                content: { t: "encrypted", c: "cipher" },
                createdAt,
                updatedAt: createdAt,
            });

            markAccountChanged.mockResolvedValueOnce(101);

            const res = await createSessionMessage({
                actorUserId: "u1",
                sessionId: "s1",
                ciphertext: "cipher",
                localId: "l1",
                messageRole: "user",
            });

            expect(res.ok).toBe(true);
            if (!res.ok) throw new Error("expected ok");
            expect(res.message.messageRole).toBe("user");
            expect(currentTx.sessionMessage.create).toHaveBeenCalledWith(
                expect.objectContaining({
                    data: expect.objectContaining({
                        messageRole: "user",
                    }),
                }),
            );
        });

        it("keeps owner-only message writes on the canonical Prisma + change-marking path", async () => {
            const createdAt = new Date("2020-01-01T00:00:00.000Z");
            const updatedAt = new Date("2020-01-01T00:00:00.000Z");
            storagePolicyEnv.set("HAPPIER_DB_PROVIDER", "postgres");

            currentTx.session.findUnique.mockResolvedValue({
                accountId: "u1",
                encryptionMode: "e2ee",
                shares: [],
                seq: 9,
                lastViewedSessionSeq: 9,
                pendingCount: 0,
                pendingPermissionRequestCount: 0,
                pendingUserActionRequestCount: 0,
                active: true,
                archivedAt: null,
            });
            currentTx.session.update.mockResolvedValue({ seq: 10 });
            currentTx.sessionMessage.create.mockResolvedValue({
                id: "m1",
                seq: 10,
                localId: "l1",
                sidechainId: null,
                messageRole: null,
                content: { t: "encrypted", c: "cipher" },
                createdAt,
                updatedAt,
            });
            markAccountChanged.mockResolvedValueOnce(101);

            const res = await createSessionMessage({
                actorUserId: "u1",
                sessionId: "s1",
                ciphertext: "cipher",
                localId: "l1",
            });

            expect(res.ok).toBe(true);
            if (!res.ok || res.didWrite === false) throw new Error("expected ok + didWrite");
            expect(res.didUpdate).toBe(false);
            expect(res.message).toEqual({
                id: "m1",
                seq: 10,
                localId: "l1",
                sidechainId: null,
                messageRole: null,
                content: { t: "encrypted", c: "cipher" },
                createdAt,
                updatedAt,
            });
            expect(res.participantCursors).toEqual([{ accountId: "u1", cursor: 101 }]);
            expect(currentTx.$queryRawUnsafe).toBeUndefined();
            expect(currentTx.session.update).toHaveBeenCalledTimes(1);
            const sessionUpdateCall = currentTx.session.update.mock.calls[0]?.[0];
            const sessionProjectionUpdateCall = currentTx.session.updateMany.mock.calls[0]?.[0];
            const messageCreateCall = currentTx.sessionMessage.create.mock.calls[0]?.[0];
            expect(sessionUpdateCall).toEqual({
                where: { id: "s1" },
                select: { seq: true },
                data: {
                    seq: { increment: 1 },
                },
            });
            expect(messageCreateCall).toEqual(expect.objectContaining({
                data: expect.objectContaining({
                    createdAt: expect.any(Date),
                }),
            }));
            expect(sessionProjectionUpdateCall).toEqual({
                where: { id: "s1", seq: 10 },
                data: {
                    meaningfulActivityAt: createdAt,
                },
            });
            expect(currentTx.sessionMessage.create).toHaveBeenCalledTimes(1);
            expect(getSessionParticipantUserIds).not.toHaveBeenCalled();
            expect(markAccountChanged).toHaveBeenCalledWith(expect.anything(), {
                accountId: "u1",
                kind: "session",
                entityId: "s1",
                hint: { lastMessageSeq: 10, lastMessageId: "m1" },
            });
            expect(observeCreateSessionMessageStage).toHaveBeenCalledWith(
                expect.objectContaining({ stage: "access", result: "ok" }),
            );
            expect(observeCreateSessionMessageStage).toHaveBeenCalledWith(
                expect.objectContaining({ stage: "persist", result: "ok" }),
            );
            expect(observeCreateSessionMessageStage).toHaveBeenCalledWith(
                expect.objectContaining({ stage: "change_tracking", result: "ok" }),
            );
            expect(observeCreateSessionMessageStage).toHaveBeenCalledWith(
                expect.objectContaining({ stage: "total", result: "ok" }),
            );
        });

        it("preserves duplicate localId handling through the canonical Prisma create path", async () => {
            const createdAt = new Date("2020-01-01T00:00:00.000Z");
            const updatedAt = new Date("2020-01-01T00:00:00.000Z");
            storagePolicyEnv.set("HAPPIER_DB_PROVIDER", "postgres");

            currentTx.session.findUnique.mockResolvedValue({
                accountId: "u1",
                encryptionMode: "e2ee",
                shares: [],
                seq: 9,
                lastViewedSessionSeq: 9,
                pendingCount: 0,
                pendingPermissionRequestCount: 0,
                pendingUserActionRequestCount: 0,
                active: true,
                archivedAt: null,
            });
            currentTx.session.update.mockResolvedValue({ seq: 10 });
            currentTx.sessionMessage.create.mockRejectedValue({
                code: "P2002",
                meta: {
                    target: ["sessionId", "localId"],
                },
            });
            dbMocks.db.session.findUnique.mockResolvedValue({
                accountId: "u1",
                encryptionMode: "e2ee",
                shares: [],
                seq: 9,
                lastViewedSessionSeq: 9,
                pendingCount: 0,
                pendingPermissionRequestCount: 0,
                pendingUserActionRequestCount: 0,
                active: true,
                archivedAt: null,
            });
            dbMocks.db.sessionShare.findUnique.mockResolvedValue(null);
            dbMocks.db.sessionMessage.findUnique.mockResolvedValue({
                id: "m1",
                seq: 4,
                localId: "l1",
                sidechainId: null,
                content: { t: "encrypted", c: "cipher" },
                createdAt,
                updatedAt,
            });

            const res = await createSessionMessage({
                actorUserId: "u1",
                sessionId: "s1",
                ciphertext: "cipher",
                localId: "l1",
            });

            expect(res).toEqual({
                ok: true,
                didWrite: false,
                didUpdate: false,
                badgeAttentionChanged: false,
                message: {
                    id: "m1",
                    seq: 4,
                    localId: "l1",
                    sidechainId: null,
                    messageRole: null,
                    content: { t: "encrypted", c: "cipher" },
                    createdAt,
                    updatedAt,
                },
                participantCursors: [],
            });
            expect(currentTx.$queryRawUnsafe).toBeUndefined();
            expect(currentTx.session.update).toHaveBeenCalledTimes(1);
            expect(currentTx.sessionMessage.create).toHaveBeenCalledTimes(1);
            expect(markAccountChanged).not.toHaveBeenCalled();
        });

        it("rejects encrypted writes when the session encryptionMode is plain (with a stable code)", async () => {
            const createdAt = new Date("2020-01-01T00:00:00.000Z");
            storagePolicyEnv.set("HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY", "optional");
            currentTx.sessionMessage.findUnique.mockResolvedValue(null);
            currentTx.session.findUnique.mockResolvedValue({ accountId: "u1", encryptionMode: "plain" });
            currentTx.sessionShare.findUnique.mockResolvedValue(null);
            currentTx.session.update.mockResolvedValue({ seq: 1 });
            currentTx.sessionMessage.create.mockResolvedValue({
                id: "m1",
                seq: 1,
                localId: null,
                content: { t: "encrypted", c: "cipher" },
                createdAt,
                updatedAt: createdAt,
            });
            getSessionParticipantUserIds.mockResolvedValue(["u1"]);
            markAccountChanged.mockResolvedValueOnce(101);

            const res = await createSessionMessage({
                actorUserId: "u1",
                sessionId: "s1",
                ciphertext: "cipher",
            });

            expect(res).toEqual({ ok: false, error: "invalid-params", code: "session_encryption_mode_mismatch" });
            expect(currentTx.session.update).not.toHaveBeenCalled();
            expect(currentTx.sessionMessage.create).not.toHaveBeenCalled();
            expect(markAccountChanged).not.toHaveBeenCalled();
        });

        it("stores plain content when the session encryptionMode is plain and storagePolicy is optional", async () => {
            const createdAt = new Date("2020-01-01T00:00:00.000Z");
            storagePolicyEnv.set("HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY", "optional");

            currentTx.sessionMessage.findUnique.mockResolvedValue(null);
            currentTx.session.findUnique.mockResolvedValue({ accountId: "u1", encryptionMode: "plain" });
            currentTx.sessionShare.findUnique.mockResolvedValue(null);
            currentTx.session.update.mockResolvedValue({ seq: 1 });
            currentTx.sessionMessage.create.mockResolvedValue({
                id: "m1",
                seq: 1,
                localId: null,
                content: { t: "plain", v: { type: "user", text: "hi" } },
                createdAt,
                updatedAt: createdAt,
            });
            getSessionParticipantUserIds.mockResolvedValue(["u1"]);
            markAccountChanged.mockResolvedValueOnce(101);

                const res = await createSessionMessage({
                    actorUserId: "u1",
                    sessionId: "s1",
                    content: { t: "plain", v: { type: "user", text: "hi" } },
            });

            expect(res.ok).toBe(true);
            expect(currentTx.sessionMessage.create).toHaveBeenCalledWith(
                expect.objectContaining({
                    data: expect.objectContaining({
                        content: { t: "plain", v: { type: "user", text: "hi" } },
                        messageRole: "user",
                    }),
                }),
            );
        });

        it("lets a valid supplied role override a plaintext envelope role", async () => {
            const createdAt = new Date("2020-01-01T00:00:00.000Z");
            storagePolicyEnv.set("HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY", "optional");

            currentTx.sessionMessage.findUnique.mockResolvedValue(null);
            currentTx.session.findUnique.mockResolvedValue({ accountId: "u1", encryptionMode: "plain" });
            currentTx.sessionShare.findUnique.mockResolvedValue(null);
            currentTx.session.update.mockResolvedValue({ seq: 1 });
            currentTx.sessionMessage.create.mockResolvedValue({
                id: "m1",
                seq: 1,
                localId: null,
                sidechainId: null,
                messageRole: "event",
                content: { t: "plain", v: { role: "agent", content: { type: "acp", data: { type: "tool-call" } } } },
                createdAt,
                updatedAt: createdAt,
            });
            getSessionParticipantUserIds.mockResolvedValue(["u1"]);
            markAccountChanged.mockResolvedValueOnce(101);

            const res = await createSessionMessage({
                actorUserId: "u1",
                sessionId: "s1",
                content: { t: "plain", v: { role: "agent", content: { type: "acp", data: { type: "tool-call" } } } },
                messageRole: "event",
            });

            expect(res).toEqual(expect.objectContaining({ ok: true }));
            if (!res.ok) throw new Error("expected ok");
            expect(res.message.messageRole).toBe("event");
            expect(currentTx.sessionMessage.create).toHaveBeenCalledWith(
                expect.objectContaining({
                    data: expect.objectContaining({
                        messageRole: "event",
                    }),
                }),
            );
        });
    });

    describe("updateSessionMetadata", () => {
        it("returns version-mismatch with current value", async () => {
            currentTx.sessionShare.findUnique.mockResolvedValue(null);
            currentTx.session.findUnique
                .mockResolvedValueOnce({ accountId: "u1" })
                .mockResolvedValueOnce({ metadataVersion: 5, metadata: "mCurrent" });

            const res = await updateSessionMetadata({
                actorUserId: "u1",
                sessionId: "s1",
                expectedVersion: 4,
                metadataCiphertext: "mNew",
            });

            expect(res).toEqual({ ok: false, error: "version-mismatch", current: { version: 5, metadata: "mCurrent" } });
            expect(currentTx.session.updateMany).not.toHaveBeenCalled();
        });

        it("re-fetches on CAS miss (count=0) and returns the fresh current value", async () => {
            currentTx.sessionShare.findUnique.mockResolvedValue(null);
            currentTx.session.findUnique
                .mockResolvedValueOnce({ accountId: "u1" })
                .mockResolvedValueOnce({ metadataVersion: 4, metadata: "mOld" })
                .mockResolvedValueOnce({ metadataVersion: 5, metadata: "mFresh" });
            currentTx.session.updateMany.mockResolvedValue({ count: 0 });

            const res = await updateSessionMetadata({
                actorUserId: "u1",
                sessionId: "s1",
                expectedVersion: 4,
                metadataCiphertext: "mNew",
            });

            expect(res).toEqual({ ok: false, error: "version-mismatch", current: { version: 5, metadata: "mFresh" } });
        });

        it("returns session-not-found when CAS miss re-fetch finds no row", async () => {
            currentTx.sessionShare.findUnique.mockResolvedValue(null);
            currentTx.session.findUnique
                .mockResolvedValueOnce({ accountId: "u1" })
                .mockResolvedValueOnce({ metadataVersion: 4, metadata: "mOld" })
                .mockResolvedValueOnce(null);
            currentTx.session.updateMany.mockResolvedValue({ count: 0 });

            const res = await updateSessionMetadata({
                actorUserId: "u1",
                sessionId: "s1",
                expectedVersion: 4,
                metadataCiphertext: "mNew",
            });

            expect(res).toEqual({ ok: false, error: "session-not-found" });
        });
    });

    describe("updateSessionAgentState", () => {
        it("updates with CAS and marks participants", async () => {
            currentTx.session.findUnique
                .mockResolvedValueOnce({ accountId: "u1" })
                .mockResolvedValueOnce({
                    agentStateVersion: 1,
                    agentState: "a1",
                    seq: 2,
                    lastViewedSessionSeq: 2,
                    pendingCount: 0,
                    pendingPermissionRequestCount: 0,
                    pendingUserActionRequestCount: 0,
                    active: true,
                    archivedAt: null,
                });
            currentTx.sessionShare.findUnique.mockResolvedValue(null);
            currentTx.session.updateMany.mockResolvedValue({ count: 1 });
            getSessionParticipantUserIds.mockResolvedValue(["u1"]);
            markAccountChanged.mockResolvedValueOnce(200);

            const res = await updateSessionAgentState({
                actorUserId: "u1",
                sessionId: "s1",
                expectedVersion: 1,
                agentStateCiphertext: null,
            });

            expect(res).toEqual({
                ok: true,
                version: 2,
                agentState: null,
                participantCursors: [{ accountId: "u1", cursor: 200 }],
                badgeAttentionChanged: false,
            });
        });

        it("persists pending permission and user action counts atomically with agentState", async () => {
            currentTx.session.findUnique
                .mockResolvedValueOnce({ accountId: "u1" })
                .mockResolvedValueOnce({
                    agentStateVersion: 1,
                    agentState: "a1",
                    seq: 2,
                    lastViewedSessionSeq: 2,
                    pendingCount: 0,
                    pendingPermissionRequestCount: 0,
                    pendingUserActionRequestCount: 0,
                    active: true,
                    archivedAt: null,
                });
            currentTx.sessionShare.findUnique.mockResolvedValue(null);
            currentTx.session.updateMany.mockResolvedValue({ count: 1 });
            getSessionParticipantUserIds.mockResolvedValue(["u1"]);
            markAccountChanged.mockResolvedValueOnce(200);

            const res = await updateSessionAgentState({
                actorUserId: "u1",
                sessionId: "s1",
                expectedVersion: 1,
                agentStateCiphertext: "a2",
                pendingPermissionRequestCount: 2,
                pendingUserActionRequestCount: 1,
            });

            expect(currentTx.session.updateMany).toHaveBeenCalledWith({
                where: { id: "s1", agentStateVersion: 1 },
                data: {
                    agentState: "a2",
                    agentStateVersion: 2,
                    pendingPermissionRequestCount: 2,
                    pendingUserActionRequestCount: 1,
                    pendingRequestObservedAt: expect.any(Date),
                },
            });
            expect(res).toEqual({
                ok: true,
                version: 2,
                agentState: "a2",
                participantCursors: [{ accountId: "u1", cursor: 200 }],
                badgeAttentionChanged: true,
                pendingPermissionRequestCount: 2,
                pendingUserActionRequestCount: 1,
                pendingRequestObservedAt: expect.any(Number),
            });
        });

        it("ignores runtime issue summary boundary input while updating agentState", async () => {
            const issue = {
                v: 1,
                scope: "primary_session",
                status: "failed",
                code: "provider_status_error",
                source: "provider_status_error",
                occurredAt: 200,
                provider: "acp",
                sanitizedPreview: "Provider reported an error",
            } as const;

            currentTx.session.findUnique
                .mockResolvedValueOnce({ accountId: "u1" })
                .mockResolvedValueOnce({
                    agentStateVersion: 1,
                    agentState: "a1",
                    seq: 2,
                    lastViewedSessionSeq: 2,
                    pendingCount: 0,
                    pendingPermissionRequestCount: 0,
                    pendingUserActionRequestCount: 0,
                    latestTurnId: null,
                    latestTurnStatus: null,
                    latestTurnStatusObservedAt: null,
                    lastRuntimeIssueJson: null,
                    active: true,
                    archivedAt: null,
                });
            currentTx.sessionShare.findUnique.mockResolvedValue(null);
            currentTx.session.updateMany.mockResolvedValue({ count: 1 });
            currentTx.sessionTurn.findUnique.mockResolvedValue(null);
            currentTx.sessionTurnMutationReceipt.findUnique.mockResolvedValue(null);
            currentTx.sessionTurn.create.mockResolvedValue({});
            getSessionParticipantUserIds.mockResolvedValue(["u1"]);
            markAccountChanged.mockResolvedValueOnce(200);

            const params: Parameters<typeof updateSessionAgentState>[0] & {
                runtimeIssueSummaryV1: unknown;
            } = {
                actorUserId: "u1",
                sessionId: "s1",
                expectedVersion: 1,
                agentStateCiphertext: "a2",
                runtimeIssueSummaryV1: {
                    latestTurnStatus: "failed",
                    lastRuntimeIssue: issue,
                },
            };
            const res = await updateSessionAgentState(params);

            expect(currentTx.session.updateMany).toHaveBeenCalledWith({
                where: { id: "s1", agentStateVersion: 1 },
                data: {
                    agentState: "a2",
                    agentStateVersion: 2,
                },
            });
            expect(currentTx.sessionTurn.findUnique).not.toHaveBeenCalled();
            expect(currentTx.sessionTurn.create).not.toHaveBeenCalled();
            expect(currentTx.sessionTurn.update).not.toHaveBeenCalled();
            expect(currentTx.sessionTurnMutationReceipt.create).not.toHaveBeenCalled();
            expect(currentTx.session.updateMany).toHaveBeenCalledTimes(1);
            expect(res).toEqual({
                ok: true,
                version: 2,
                agentState: "a2",
                participantCursors: [{ accountId: "u1", cursor: 200 }],
                badgeAttentionChanged: false,
            });
        });

        it("does not expose runtimeIssueSummaryV1 in typed update-state params", () => {
            const params: Parameters<typeof updateSessionAgentState>[0] = {
                actorUserId: "u1",
                sessionId: "s1",
                expectedVersion: 1,
                agentStateCiphertext: "a2",
                // @ts-expect-error runtimeIssueSummaryV1 was a dev-only update-state bridge and is no longer accepted.
                runtimeIssueSummaryV1: { latestTurnStatus: "failed" },
            };

            expect(params).toMatchObject({
                actorUserId: "u1",
                sessionId: "s1",
                expectedVersion: 1,
                agentStateCiphertext: "a2",
            });
        });

        it("ignores malformed runtime issue summary boundary input", async () => {
            const invalidRuntimeIssueSummaryV1: unknown = {
                latestTurnStatus: "failed",
                lastRuntimeIssue: {
                    v: 1,
                    scope: "primary_session",
                    status: "completed",
                    code: "provider_status_error",
                    source: "provider_status_error",
                    occurredAt: 200,
                },
            };
            currentTx.session.findUnique
                .mockResolvedValueOnce({ accountId: "u1" })
                .mockResolvedValueOnce({
                    agentStateVersion: 1,
                    agentState: "a1",
                    seq: 2,
                    lastViewedSessionSeq: 2,
                    pendingCount: 0,
                    pendingPermissionRequestCount: 0,
                    pendingUserActionRequestCount: 0,
                    latestTurnId: null,
                    latestTurnStatus: null,
                    latestTurnStatusObservedAt: null,
                    lastRuntimeIssue: null,
                    active: true,
                    archivedAt: null,
                });
            currentTx.sessionShare.findUnique.mockResolvedValue(null);
            currentTx.session.updateMany.mockResolvedValue({ count: 1 });
            getSessionParticipantUserIds.mockResolvedValue(["u1"]);
            markAccountChanged.mockResolvedValueOnce(200);

            const params: Parameters<typeof updateSessionAgentState>[0] & Record<"runtimeIssueSummaryV1", unknown> = {
                actorUserId: "u1",
                sessionId: "s1",
                expectedVersion: 1,
                agentStateCiphertext: "a2",
                runtimeIssueSummaryV1: invalidRuntimeIssueSummaryV1,
            };
            const res = await updateSessionAgentState(params);

            expect(currentTx.session.updateMany).toHaveBeenCalledWith({
                where: { id: "s1", agentStateVersion: 1 },
                data: {
                    agentState: "a2",
                    agentStateVersion: 2,
                },
            });
            expect(currentTx.sessionTurn.findUnique).not.toHaveBeenCalled();
            expect(currentTx.sessionTurn.create).not.toHaveBeenCalled();
            expect(currentTx.sessionTurn.update).not.toHaveBeenCalled();
            expect(currentTx.session.updateMany).toHaveBeenCalledTimes(1);
            expect(currentTx.sessionTurnMutationReceipt.create).not.toHaveBeenCalled();
            expect(res).toEqual({
                ok: true,
                version: 2,
                agentState: "a2",
                participantCursors: [{ accountId: "u1", cursor: 200 }],
                badgeAttentionChanged: false,
            });
        });

        it("re-fetches on CAS miss (count=0) and returns the fresh current value", async () => {
            currentTx.session.findUnique
                .mockResolvedValueOnce({ accountId: "u1" })
                .mockResolvedValueOnce({ agentStateVersion: 4, agentState: "aOld" })
                .mockResolvedValueOnce({ agentStateVersion: 5, agentState: "aFresh" });
            currentTx.sessionShare.findUnique.mockResolvedValue(null);
            currentTx.session.updateMany.mockResolvedValue({ count: 0 });

            const res = await updateSessionAgentState({
                actorUserId: "u1",
                sessionId: "s1",
                expectedVersion: 4,
                agentStateCiphertext: null,
            });

            expect(res).toEqual({ ok: false, error: "version-mismatch", current: { version: 5, agentState: "aFresh" } });
        });

        it("returns session-not-found when CAS miss re-fetch finds no row", async () => {
            currentTx.session.findUnique
                .mockResolvedValueOnce({ accountId: "u1" })
                .mockResolvedValueOnce({ agentStateVersion: 4, agentState: "aOld" })
                .mockResolvedValueOnce(null);
            currentTx.sessionShare.findUnique.mockResolvedValue(null);
            currentTx.session.updateMany.mockResolvedValue({ count: 0 });

            const res = await updateSessionAgentState({
                actorUserId: "u1",
                sessionId: "s1",
                expectedVersion: 4,
                agentStateCiphertext: null,
            });

            expect(res).toEqual({ ok: false, error: "session-not-found" });
        });
    });

    describe("applySessionTurnMutation", () => {
        const beginMutation = {
            v: 1,
            sessionId: "s1",
            mutationId: "mutation-begin",
            turnId: "turn-1",
            action: "begin",
            provider: "codex",
            observedAt: 100,
        } as const;

        const completedTurnRow = {
            id: "row-turn-1",
            sessionId: "s1",
            turnId: "turn-1",
            provider: "codex",
            providerTurnId: "provider-turn-1",
            status: "completed",
            startedAt: BigInt(100),
            updatedAt: BigInt(200),
            terminalAt: BigInt(200),
            lastRuntimeIssue: null,
            transcriptAnchorsJson: null,
            rollbackState: null,
            rollbackReason: null,
            providerRollbackOrdinal: null,
            rollbackUpdatedAt: null,
            lastMutationId: "mutation-complete",
        };

        const usageLimitIssue = {
            v: 1,
            scope: "primary_session",
            status: "failed",
            code: "usage_limit",
            source: "usage_limit",
            occurredAt: 200,
            provider: "codex",
            providerTurnId: "provider-turn-1",
            sanitizedPreview: "Provider usage limit reached",
            usageLimit: {
                v: 1,
                resetAtMs: null,
                retryAfterMs: null,
                quotaScope: "account",
                recoverability: "switch_account",
                connectedService: {
                    serviceId: "openai-codex",
                    profileId: "old-profile",
                    groupId: "codex-group",
                },
            },
        } as const;

        const failedUsageLimitTurnRow = {
            ...completedTurnRow,
            status: "failed",
            updatedAt: BigInt(200),
            terminalAt: BigInt(200),
            lastRuntimeIssueJson: JSON.stringify(usageLimitIssue),
            lastMutationId: "mutation-failed",
        };

        it("materializes a begun turn without requiring agent state", async () => {
            expect(typeof applySessionTurnMutation).toBe("function");
            currentTx.session.findUnique
                .mockResolvedValueOnce({
                    accountId: "u1",
                    encryptionMode: "e2ee",
                    seq: 5,
                    pendingCount: 0,
                    lastViewedSessionSeq: 5,
                    pendingPermissionRequestCount: 0,
                    pendingUserActionRequestCount: 0,
                    latestTurnStatus: null,
                    lastRuntimeIssueJson: null,
                    active: true,
                    archivedAt: null,
                    shares: [],
                })
                .mockResolvedValueOnce({
                    latestTurnId: null,
                    seq: 5,
                    pendingCount: 0,
                    lastViewedSessionSeq: 5,
                    pendingPermissionRequestCount: 0,
                    pendingUserActionRequestCount: 0,
                    latestTurnStatus: null,
                    lastRuntimeIssue: null,
                    active: true,
                    archivedAt: null,
                });
            currentTx.sessionShare.findUnique.mockResolvedValue(null);
            currentTx.sessionTurnMutationReceipt.findUnique.mockResolvedValue(null);
            currentTx.sessionTurn.findUnique.mockResolvedValue(null);
            currentTx.sessionTurn.create.mockResolvedValue({
                id: "row-turn-1",
                sessionId: "s1",
                turnId: "turn-1",
                provider: "codex",
                providerTurnId: null,
                status: "in_progress",
                startedAt: BigInt(100),
                updatedAt: BigInt(100),
                terminalAt: null,
                lastRuntimeIssue: null,
                transcriptAnchorsJson: null,
                rollbackState: null,
                rollbackReason: null,
                providerRollbackOrdinal: null,
                rollbackUpdatedAt: null,
                lastMutationId: "mutation-begin",
            });
            getSessionParticipantUserIds.mockResolvedValue(["u1"]);
            markAccountChanged.mockResolvedValueOnce(101);
            const dateNowMock = vi.spyOn(Date, "now")
                .mockReturnValueOnce(1_000)
                .mockReturnValueOnce(2_000)
                .mockReturnValue(3_000);

            const res = await (async () => {
                try {
                    return await applySessionTurnMutation({
                    actorUserId: "u1",
                    mutation: beginMutation,
                    });
                } finally {
                    dateNowMock.mockRestore();
                }
            })();

            expect(currentTx.sessionTurn.create).toHaveBeenCalledWith({
                data: expect.objectContaining({
                    sessionId: "s1",
                    turnId: "turn-1",
                    provider: "codex",
                    status: "in_progress",
                    startedAt: BigInt(100),
                    updatedAt: BigInt(100),
                    lastMutationId: "mutation-begin",
                }),
            });
            expect(currentTx.session.update).toHaveBeenCalledWith({
                where: { id: "s1" },
                data: {
                    latestTurnId: "turn-1",
                    latestTurnStatus: "in_progress",
                    latestTurnStatusObservedAt: BigInt(100),
                    lastRuntimeIssue: null,
                    thinking: true,
                    thinkingAt: new Date(100),
                },
            });
            expect(currentTx.sessionTurnMutationReceipt.create).toHaveBeenCalledWith({
                data: {
                    sessionId: "s1",
                    mutationId: "mutation-begin",
                    turnId: "turn-1",
                    action: "begin",
                    decision: "stale-in-progress",
                    observedAt: BigInt(100),
                    appliedAt: BigInt(1_000),
                },
            });
            expect(currentTx.sessionTurnMutationReceipt.update).toHaveBeenCalledWith({
                where: {
                    sessionId_mutationId: {
                        sessionId: "s1",
                        mutationId: "mutation-begin",
                    },
                },
                data: {
                    turnId: "turn-1",
                    action: "begin",
                    decision: "applied",
                    observedAt: BigInt(100),
                    appliedAt: BigInt(2_000),
                },
            });
            expect(res).toMatchObject({
                ok: true,
                didApply: true,
                latestTurnId: "turn-1",
                latestTurnStatus: "in_progress",
                latestTurnStatusObservedAt: 100,
                lastRuntimeIssue: null,
                participantCursors: [{ accountId: "u1", cursor: 101 }],
                badgeAttentionChanged: false,
                receipt: {
                    appliedAt: 2_000,
                },
            });
        });

        it("acknowledges duplicate mutation receipts without rewriting rows", async () => {
            expect(typeof applySessionTurnMutation).toBe("function");
            currentTx.session.findUnique
                .mockResolvedValueOnce({
                    accountId: "u1",
                    encryptionMode: "e2ee",
                    seq: 5,
                    pendingCount: 0,
                    lastViewedSessionSeq: 5,
                    pendingPermissionRequestCount: 0,
                    pendingUserActionRequestCount: 0,
                    latestTurnId: "turn-1",
                    latestTurnStatus: "completed",
                    latestTurnStatusObservedAt: BigInt(200),
                    lastRuntimeIssueJson: null,
                    active: true,
                    archivedAt: null,
                    shares: [],
                })
                .mockResolvedValueOnce({
                    latestTurnId: "turn-1",
                    latestTurnStatus: "completed",
                    latestTurnStatusObservedAt: BigInt(200),
                    lastRuntimeIssue: null,
                });
            currentTx.sessionShare.findUnique.mockResolvedValue(null);
            currentTx.sessionTurnMutationReceipt.findUnique.mockResolvedValue({ id: "receipt-1" });

            const res = await applySessionTurnMutation({
                actorUserId: "u1",
                mutation: {
                    ...beginMutation,
                    mutationId: "mutation-complete",
                    action: "complete",
                    providerTurnId: "provider-turn-1",
                    observedAt: 200,
                },
            });

            expect(currentTx.sessionTurn.create).not.toHaveBeenCalled();
            expect(currentTx.sessionTurn.update).not.toHaveBeenCalled();
            expect(currentTx.session.update).not.toHaveBeenCalled();
            expect(res).toMatchObject({
                ok: true,
                didApply: false,
                reason: "duplicate-mutation",
                latestTurnId: "turn-1",
                latestTurnStatus: "completed",
                latestTurnStatusObservedAt: 200,
                lastRuntimeIssue: null,
                participantCursors: [],
                badgeAttentionChanged: false,
            });
        });

        it("clears legacy thinking state when materializing a terminal turn", async () => {
            expect(typeof applySessionTurnMutation).toBe("function");
            currentTx.session.findUnique
                .mockResolvedValueOnce({
                    accountId: "u1",
                    encryptionMode: "e2ee",
                    seq: 5,
                    pendingCount: 0,
                    lastViewedSessionSeq: 5,
                    pendingPermissionRequestCount: 0,
                    pendingUserActionRequestCount: 0,
                    latestTurnId: "turn-1",
                    latestTurnStatus: "in_progress",
                    latestTurnStatusObservedAt: BigInt(100),
                    lastRuntimeIssue: null,
                    active: true,
                    archivedAt: null,
                    shares: [],
                })
                .mockResolvedValueOnce({
                    latestTurnId: "turn-1",
                    latestTurnStatus: "completed",
                    latestTurnStatusObservedAt: BigInt(200),
                    lastRuntimeIssue: null,
                });
            currentTx.sessionShare.findUnique.mockResolvedValue(null);
            currentTx.sessionTurnMutationReceipt.findUnique.mockResolvedValue(null);
            currentTx.sessionTurn.findUnique.mockResolvedValue({
                id: "row-turn-1",
                sessionId: "s1",
                turnId: "turn-1",
                provider: "codex",
                providerTurnId: "provider-turn-1",
                status: "in_progress",
                startedAt: BigInt(100),
                updatedAt: BigInt(100),
                terminalAt: null,
                lastRuntimeIssue: null,
                transcriptAnchorsJson: null,
                rollbackState: null,
                rollbackReason: null,
                providerRollbackOrdinal: null,
                rollbackUpdatedAt: null,
                lastMutationId: "mutation-begin",
            });
            currentTx.sessionTurn.update.mockResolvedValue({
                ...completedTurnRow,
                lastMutationId: "mutation-complete",
            });
            currentTx.session.update.mockResolvedValue({});
            getSessionParticipantUserIds.mockResolvedValue(["u1"]);
            markAccountChanged.mockResolvedValueOnce(102);

            await applySessionTurnMutation({
                actorUserId: "u1",
                mutation: {
                    ...beginMutation,
                    mutationId: "mutation-complete",
                    action: "complete",
                    providerTurnId: "provider-turn-1",
                    observedAt: 200,
                },
            });

            expect(currentTx.session.update).toHaveBeenCalledWith({
                where: { id: "s1" },
                data: expect.objectContaining({
                    latestTurnStatus: "completed",
                    latestTurnStatusObservedAt: BigInt(200),
                    thinking: false,
                    thinkingAt: new Date(200),
                }),
            });
        });

        it("does not let stale in-progress evidence overwrite a terminal turn", async () => {
            expect(typeof applySessionTurnMutation).toBe("function");
            currentTx.session.findUnique
                .mockResolvedValueOnce({
                    accountId: "u1",
                    encryptionMode: "e2ee",
                    seq: 5,
                    pendingCount: 0,
                    lastViewedSessionSeq: 5,
                    pendingPermissionRequestCount: 0,
                    pendingUserActionRequestCount: 0,
                    latestTurnId: "turn-1",
                    latestTurnStatus: "completed",
                    latestTurnStatusObservedAt: BigInt(200),
                    lastRuntimeIssue: null,
                    active: true,
                    archivedAt: null,
                    shares: [],
                })
                .mockResolvedValueOnce({
                    latestTurnId: "turn-1",
                    latestTurnStatus: "completed",
                    latestTurnStatusObservedAt: BigInt(200),
                    lastRuntimeIssue: null,
                });
            currentTx.sessionShare.findUnique.mockResolvedValue(null);
            currentTx.sessionTurnMutationReceipt.findUnique.mockResolvedValue(null);
            currentTx.sessionTurn.findUnique.mockResolvedValue(completedTurnRow);

            const res = await applySessionTurnMutation({
                actorUserId: "u1",
                mutation: {
                    ...beginMutation,
                    mutationId: "mutation-stale-begin",
                    observedAt: 300,
                },
            });

            expect(currentTx.sessionTurn.update).not.toHaveBeenCalled();
            expect(currentTx.session.update).not.toHaveBeenCalled();
            expect(currentTx.sessionTurnMutationReceipt.create).toHaveBeenCalledWith({
                data: expect.objectContaining({
                    sessionId: "s1",
                    mutationId: "mutation-stale-begin",
                    turnId: "turn-1",
                    action: "begin",
                    decision: "stale-in-progress",
                    observedAt: BigInt(300),
                }),
            });
            expect(res).toMatchObject({
                ok: true,
                didApply: false,
                reason: "terminal-turn",
                latestTurnId: "turn-1",
                latestTurnStatus: "completed",
                latestTurnStatusObservedAt: 200,
            });
        });

        it("lets newer same-context begin evidence clear a failed runtime issue", async () => {
            expect(typeof applySessionTurnMutation).toBe("function");
            currentTx.session.findUnique
                .mockResolvedValueOnce({
                    accountId: "u1",
                    encryptionMode: "e2ee",
                    seq: 5,
                    pendingCount: 0,
                    lastViewedSessionSeq: 5,
                    pendingPermissionRequestCount: 0,
                    pendingUserActionRequestCount: 0,
                    latestTurnId: "turn-1",
                    latestTurnStatus: "failed",
                    latestTurnStatusObservedAt: BigInt(200),
                    lastRuntimeIssue: JSON.stringify(usageLimitIssue),
                    active: true,
                    archivedAt: null,
                    shares: [],
                })
                .mockResolvedValueOnce({
                    latestTurnId: "turn-1",
                    seq: 5,
                    pendingCount: 0,
                    lastViewedSessionSeq: 5,
                    pendingPermissionRequestCount: 0,
                    pendingUserActionRequestCount: 0,
                    latestTurnStatus: "failed",
                    latestTurnStatusObservedAt: BigInt(200),
                    lastRuntimeIssue: JSON.stringify(usageLimitIssue),
                    active: true,
                    archivedAt: null,
                });
            currentTx.sessionShare.findUnique.mockResolvedValue(null);
            currentTx.sessionTurnMutationReceipt.findUnique.mockResolvedValue(null);
            currentTx.sessionTurn.findUnique.mockResolvedValue(failedUsageLimitTurnRow);
            currentTx.sessionTurn.update.mockResolvedValue({
                ...failedUsageLimitTurnRow,
                status: "in_progress",
                startedAt: BigInt(300),
                updatedAt: BigInt(300),
                terminalAt: null,
                lastRuntimeIssueJson: null,
                lastMutationId: "mutation-recovered-begin",
            });
            currentTx.session.update.mockResolvedValue({});
            getSessionParticipantUserIds.mockResolvedValue(["u1"]);
            markAccountChanged.mockResolvedValueOnce(103);

            const res = await applySessionTurnMutation({
                actorUserId: "u1",
                mutation: {
                    ...beginMutation,
                    mutationId: "mutation-recovered-begin",
                    providerTurnId: "provider-turn-1",
                    observedAt: 300,
                },
            });

            expect(currentTx.sessionTurn.update).toHaveBeenCalledWith({
                where: { id: "row-turn-1" },
                data: expect.objectContaining({
                    status: "in_progress",
                    startedAt: BigInt(300),
                    updatedAt: BigInt(300),
                    terminalAt: null,
                    lastRuntimeIssueJson: null,
                    lastMutationId: "mutation-recovered-begin",
                }),
            });
            expect(currentTx.session.update).toHaveBeenCalledWith({
                where: { id: "s1" },
                data: expect.objectContaining({
                    latestTurnId: "turn-1",
                    latestTurnStatus: "in_progress",
                    latestTurnStatusObservedAt: BigInt(300),
                    lastRuntimeIssue: null,
                    thinking: true,
                    thinkingAt: new Date(300),
                }),
            });
            expect(res).toMatchObject({
                ok: true,
                didApply: true,
                latestTurnId: "turn-1",
                latestTurnStatus: "in_progress",
                latestTurnStatusObservedAt: 300,
                lastRuntimeIssue: null,
            });
        });

        it("lets newer same-context completion evidence clear a failed runtime issue", async () => {
            expect(typeof applySessionTurnMutation).toBe("function");
            currentTx.session.findUnique
                .mockResolvedValueOnce({
                    accountId: "u1",
                    encryptionMode: "e2ee",
                    seq: 5,
                    pendingCount: 0,
                    lastViewedSessionSeq: 5,
                    pendingPermissionRequestCount: 0,
                    pendingUserActionRequestCount: 0,
                    latestTurnId: "turn-1",
                    latestTurnStatus: "failed",
                    latestTurnStatusObservedAt: BigInt(200),
                    lastRuntimeIssue: JSON.stringify(usageLimitIssue),
                    active: true,
                    archivedAt: null,
                    shares: [],
                })
                .mockResolvedValueOnce({
                    latestTurnId: "turn-1",
                    seq: 5,
                    pendingCount: 0,
                    lastViewedSessionSeq: 5,
                    pendingPermissionRequestCount: 0,
                    pendingUserActionRequestCount: 0,
                    latestTurnStatus: "failed",
                    latestTurnStatusObservedAt: BigInt(200),
                    lastRuntimeIssue: JSON.stringify(usageLimitIssue),
                    active: true,
                    archivedAt: null,
                });
            currentTx.sessionShare.findUnique.mockResolvedValue(null);
            currentTx.sessionTurnMutationReceipt.findUnique.mockResolvedValue(null);
            currentTx.sessionTurn.findUnique.mockResolvedValue(failedUsageLimitTurnRow);
            currentTx.sessionTurn.update.mockResolvedValue({
                ...failedUsageLimitTurnRow,
                status: "completed",
                updatedAt: BigInt(300),
                terminalAt: BigInt(300),
                lastRuntimeIssueJson: null,
                lastMutationId: "mutation-recovered-complete",
            });
            currentTx.session.update.mockResolvedValue({});
            getSessionParticipantUserIds.mockResolvedValue(["u1"]);
            markAccountChanged.mockResolvedValueOnce(104);

            const res = await applySessionTurnMutation({
                actorUserId: "u1",
                mutation: {
                    ...beginMutation,
                    action: "complete",
                    mutationId: "mutation-recovered-complete",
                    providerTurnId: "provider-turn-1",
                    observedAt: 300,
                },
            });

            expect(currentTx.sessionTurn.update).toHaveBeenCalledWith({
                where: { id: "row-turn-1" },
                data: expect.objectContaining({
                    status: "completed",
                    updatedAt: BigInt(300),
                    terminalAt: BigInt(300),
                    lastRuntimeIssueJson: null,
                    lastMutationId: "mutation-recovered-complete",
                }),
            });
            expect(currentTx.session.update).toHaveBeenCalledWith({
                where: { id: "s1" },
                data: expect.objectContaining({
                    latestTurnId: "turn-1",
                    latestTurnStatus: "completed",
                    latestTurnStatusObservedAt: BigInt(300),
                    lastRuntimeIssue: null,
                    thinking: false,
                    thinkingAt: new Date(300),
                }),
            });
            expect(res).toMatchObject({
                ok: true,
                didApply: true,
                latestTurnId: "turn-1",
                latestTurnStatus: "completed",
                latestTurnStatusObservedAt: 300,
                lastRuntimeIssue: null,
            });
        });

        it("applies rollback eligibility to a terminal turn without changing materialized lifecycle status", async () => {
            expect(typeof applySessionTurnMutation).toBe("function");
            currentTx.session.findUnique
                .mockResolvedValueOnce({
                    accountId: "u1",
                    encryptionMode: "e2ee",
                    seq: 5,
                    pendingCount: 0,
                    lastViewedSessionSeq: 5,
                    pendingPermissionRequestCount: 0,
                    pendingUserActionRequestCount: 0,
                    latestTurnId: "turn-1",
                    latestTurnStatus: "completed",
                    latestTurnStatusObservedAt: BigInt(200),
                    lastRuntimeIssue: null,
                    active: true,
                    archivedAt: null,
                    shares: [],
                })
                .mockResolvedValueOnce({
                    seq: 5,
                    pendingCount: 0,
                    lastViewedSessionSeq: 5,
                    pendingPermissionRequestCount: 0,
                    pendingUserActionRequestCount: 0,
                    latestTurnId: "turn-1",
                    latestTurnStatus: "completed",
                    latestTurnStatusObservedAt: BigInt(200),
                    lastRuntimeIssue: null,
                    active: true,
                    archivedAt: null,
                });
            currentTx.sessionShare.findUnique.mockResolvedValue(null);
            currentTx.sessionTurnMutationReceipt.findUnique.mockResolvedValue(null);
            currentTx.sessionTurn.findUnique.mockResolvedValue({
                ...completedTurnRow,
                transcriptAnchorsJson: JSON.stringify({ startUserMessageSeq: 1, endSeqInclusive: 10 }),
            });
            currentTx.sessionTurn.update.mockResolvedValue({
                ...completedTurnRow,
                transcriptAnchorsJson: JSON.stringify({ startUserMessageSeq: 1, endSeqInclusive: 10 }),
                rollbackState: "eligible",
                providerRollbackOrdinal: 4,
                rollbackUpdatedAt: BigInt(300),
                lastMutationId: "mutation-rollback-eligible",
            });

            const res = await applySessionTurnMutation({
                actorUserId: "u1",
                mutation: {
                    v: 1,
                    sessionId: "s1",
                    mutationId: "mutation-rollback-eligible",
                    turnId: "turn-1",
                    action: "mark_rollback_eligible",
                    providerRollbackOrdinal: 4,
                    observedAt: 300,
                },
            });

            expect(currentTx.sessionTurn.update).toHaveBeenCalledWith({
                where: { id: "row-turn-1" },
                data: expect.objectContaining({
                    status: "completed",
                    rollbackState: "eligible",
                    providerRollbackOrdinal: 4,
                    rollbackUpdatedAt: BigInt(300),
                    lastMutationId: "mutation-rollback-eligible",
                }),
            });
            expect(currentTx.session.update).not.toHaveBeenCalled();
            expect(res).toMatchObject({
                ok: true,
                didApply: true,
                latestTurnId: "turn-1",
                latestTurnStatus: "completed",
                latestTurnStatusObservedAt: 200,
            });
        });

        it("does not mark rollback eligible without trusted transcript anchors", async () => {
            expect(typeof applySessionTurnMutation).toBe("function");
            currentTx.session.findUnique
                .mockResolvedValueOnce({
                    accountId: "u1",
                    encryptionMode: "e2ee",
                    seq: 5,
                    pendingCount: 0,
                    lastViewedSessionSeq: 5,
                    pendingPermissionRequestCount: 0,
                    pendingUserActionRequestCount: 0,
                    latestTurnId: "turn-1",
                    latestTurnStatus: "completed",
                    latestTurnStatusObservedAt: BigInt(200),
                    lastRuntimeIssue: null,
                    active: true,
                    archivedAt: null,
                    shares: [],
                })
                .mockResolvedValueOnce({
                    latestTurnId: "turn-1",
                    latestTurnStatus: "completed",
                    latestTurnStatusObservedAt: BigInt(200),
                    lastRuntimeIssue: null,
                    active: true,
                    archivedAt: null,
                });
            currentTx.sessionShare.findUnique.mockResolvedValue(null);
            currentTx.sessionTurnMutationReceipt.findUnique.mockResolvedValue(null);
            currentTx.sessionTurn.findUnique.mockResolvedValue({
                ...completedTurnRow,
                transcriptAnchorsJson: null,
            });

            const res = await applySessionTurnMutation({
                actorUserId: "u1",
                mutation: {
                    v: 1,
                    sessionId: "s1",
                    mutationId: "mutation-untrusted-rollback",
                    turnId: "turn-1",
                    action: "mark_rollback_eligible",
                    providerRollbackOrdinal: 4,
                    observedAt: 300,
                },
            });

            expect(currentTx.sessionTurn.update).not.toHaveBeenCalled();
            expect(currentTx.session.update).not.toHaveBeenCalled();
            expect(currentTx.sessionTurnMutationReceipt.update).toHaveBeenCalledWith({
                where: {
                    sessionId_mutationId: {
                        sessionId: "s1",
                        mutationId: "mutation-untrusted-rollback",
                    },
                },
                data: expect.objectContaining({
                    turnId: "turn-1",
                    action: "mark_rollback_eligible",
                    decision: "stale-terminal",
                    observedAt: BigInt(300),
                }),
            });
            expect(res).toMatchObject({
                ok: true,
                didApply: false,
                reason: "terminal-turn",
                latestTurnId: "turn-1",
                latestTurnStatus: "completed",
                latestTurnStatusObservedAt: 200,
            });
        });

        it("does not mark failed turns rollback eligible", async () => {
            expect(typeof applySessionTurnMutation).toBe("function");
            currentTx.session.findUnique
                .mockResolvedValueOnce({
                    accountId: "u1",
                    encryptionMode: "e2ee",
                    seq: 5,
                    pendingCount: 0,
                    lastViewedSessionSeq: 5,
                    pendingPermissionRequestCount: 0,
                    pendingUserActionRequestCount: 0,
                    latestTurnId: "turn-1",
                    latestTurnStatus: "failed",
                    latestTurnStatusObservedAt: BigInt(200),
                    lastRuntimeIssue: null,
                    active: true,
                    archivedAt: null,
                    shares: [],
                })
                .mockResolvedValueOnce({
                    latestTurnId: "turn-1",
                    latestTurnStatus: "failed",
                    latestTurnStatusObservedAt: BigInt(200),
                    lastRuntimeIssue: null,
                    active: true,
                    archivedAt: null,
                });
            currentTx.sessionShare.findUnique.mockResolvedValue(null);
            currentTx.sessionTurnMutationReceipt.findUnique.mockResolvedValue(null);
            currentTx.sessionTurn.findUnique.mockResolvedValue({
                ...completedTurnRow,
                status: "failed",
                transcriptAnchorsJson: JSON.stringify({ startUserMessageSeq: 1, endSeqInclusive: 10 }),
            });

            const res = await applySessionTurnMutation({
                actorUserId: "u1",
                mutation: {
                    v: 1,
                    sessionId: "s1",
                    mutationId: "mutation-failed-rollback",
                    turnId: "turn-1",
                    action: "mark_rollback_eligible",
                    observedAt: 300,
                },
            });

            expect(currentTx.sessionTurn.update).not.toHaveBeenCalled();
            expect(currentTx.session.update).not.toHaveBeenCalled();
            expect(res).toMatchObject({
                ok: true,
                didApply: false,
                reason: "terminal-turn",
                latestTurnId: "turn-1",
                latestTurnStatus: "failed",
                latestTurnStatusObservedAt: 200,
            });
        });

        it("does not let an older turn terminal event overwrite a newer active latest turn", async () => {
            expect(typeof applySessionTurnMutation).toBe("function");
            currentTx.session.findUnique
                .mockResolvedValueOnce({
                    accountId: "u1",
                    encryptionMode: "e2ee",
                    seq: 5,
                    pendingCount: 0,
                    lastViewedSessionSeq: 5,
                    pendingPermissionRequestCount: 0,
                    pendingUserActionRequestCount: 0,
                    latestTurnId: "turn-2",
                    latestTurnStatus: "in_progress",
                    latestTurnStatusObservedAt: BigInt(250),
                    lastRuntimeIssue: null,
                    active: true,
                    archivedAt: null,
                    shares: [],
                })
                .mockResolvedValueOnce({
                    latestTurnId: "turn-2",
                    latestTurnStatus: "in_progress",
                    latestTurnStatusObservedAt: BigInt(250),
                    lastRuntimeIssue: null,
                    active: true,
                    archivedAt: null,
                });
            currentTx.sessionShare.findUnique.mockResolvedValue(null);
            currentTx.sessionTurnMutationReceipt.findUnique.mockResolvedValue(null);
            currentTx.sessionTurn.findUnique.mockImplementation(async ({ where }: { where: { sessionId_turnId: { turnId: string } } }) => {
                if (where.sessionId_turnId.turnId === "turn-1") {
                    return {
                        ...completedTurnRow,
                        status: "in_progress",
                        terminalAt: null,
                        updatedAt: BigInt(100),
                    };
                }
                if (where.sessionId_turnId.turnId === "turn-2") {
                    return {
                        ...completedTurnRow,
                        id: "row-turn-2",
                        turnId: "turn-2",
                        status: "in_progress",
                        terminalAt: null,
                        updatedAt: BigInt(250),
                    };
                }
                return null;
            });

            const res = await applySessionTurnMutation({
                actorUserId: "u1",
                mutation: {
                    v: 1,
                    sessionId: "s1",
                    mutationId: "mutation-old-complete",
                    turnId: "turn-1",
                    action: "complete",
                    observedAt: 300,
                },
            });

            expect(currentTx.sessionTurn.update).not.toHaveBeenCalled();
            expect(currentTx.session.update).not.toHaveBeenCalled();
            expect(currentTx.sessionTurnMutationReceipt.update).toHaveBeenCalledWith({
                where: {
                    sessionId_mutationId: {
                        sessionId: "s1",
                        mutationId: "mutation-old-complete",
                    },
                },
                data: expect.objectContaining({
                    turnId: "turn-1",
                    action: "complete",
                    decision: "stale-terminal",
                    observedAt: BigInt(300),
                }),
            });
            expect(res).toMatchObject({
                ok: true,
                didApply: false,
                reason: "terminal-turn",
                latestTurnId: "turn-2",
                latestTurnStatus: "in_progress",
                latestTurnStatusObservedAt: 250,
            });
        });

        it("merges appended transcript anchors without dropping previous user message seqs", async () => {
            expect(typeof applySessionTurnMutation).toBe("function");
            currentTx.session.findUnique
                .mockResolvedValueOnce({
                    accountId: "u1",
                    encryptionMode: "e2ee",
                    seq: 5,
                    pendingCount: 0,
                    lastViewedSessionSeq: 5,
                    pendingPermissionRequestCount: 0,
                    pendingUserActionRequestCount: 0,
                    latestTurnId: "turn-1",
                    latestTurnStatus: "in_progress",
                    latestTurnStatusObservedAt: BigInt(100),
                    lastRuntimeIssue: null,
                    active: true,
                    archivedAt: null,
                    shares: [],
                })
                .mockResolvedValueOnce({
                    seq: 5,
                    pendingCount: 0,
                    lastViewedSessionSeq: 5,
                    pendingPermissionRequestCount: 0,
                    pendingUserActionRequestCount: 0,
                    latestTurnId: "turn-1",
                    latestTurnStatus: "in_progress",
                    latestTurnStatusObservedAt: BigInt(100),
                    lastRuntimeIssue: null,
                    active: true,
                    archivedAt: null,
                });
            currentTx.sessionShare.findUnique.mockResolvedValue(null);
            currentTx.sessionTurnMutationReceipt.findUnique.mockResolvedValue(null);
            currentTx.sessionTurn.findUnique.mockResolvedValue({
                ...completedTurnRow,
                status: "in_progress",
                terminalAt: null,
                transcriptAnchorsJson: JSON.stringify({
                    startUserMessageSeq: 1,
                    startSeqInclusive: 2,
                    endSeqInclusive: 8,
                    userMessageSeqs: [1, 3],
                }),
            });
            currentTx.sessionTurn.update.mockImplementation(async (args: { data: { transcriptAnchorsJson?: string } }) => ({
                ...completedTurnRow,
                status: "in_progress",
                terminalAt: null,
                transcriptAnchorsJson: args.data.transcriptAnchorsJson ?? null,
                updatedAt: BigInt(150),
                lastMutationId: "mutation-anchors-2",
            }));

            await applySessionTurnMutation({
                actorUserId: "u1",
                mutation: {
                    v: 1,
                    sessionId: "s1",
                    mutationId: "mutation-anchors-2",
                    turnId: "turn-1",
                    action: "append_transcript_anchors",
                    transcriptAnchors: {
                        userMessageSeqs: [3, 5],
                        endSeqInclusive: 12,
                    },
                    observedAt: 150,
                },
            });

            const updateArg = currentTx.sessionTurn.update.mock.calls[0]?.[0];
            const anchors = JSON.parse(updateArg.data.transcriptAnchorsJson);
            expect(anchors).toEqual({
                startUserMessageSeq: 1,
                startSeqInclusive: 2,
                endSeqInclusive: 12,
                userMessageSeqs: [1, 3, 5],
            });
        });

        it("treats receipt unique conflicts as duplicate mutations", async () => {
            expect(typeof applySessionTurnMutation).toBe("function");
            currentTx.session.findUnique
                .mockResolvedValueOnce({
                    accountId: "u1",
                    encryptionMode: "e2ee",
                    seq: 5,
                    pendingCount: 0,
                    lastViewedSessionSeq: 5,
                    pendingPermissionRequestCount: 0,
                    pendingUserActionRequestCount: 0,
                    latestTurnId: "turn-1",
                    latestTurnStatus: "completed",
                    latestTurnStatusObservedAt: BigInt(200),
                    lastRuntimeIssue: null,
                    active: true,
                    archivedAt: null,
                    shares: [],
                })
                .mockResolvedValueOnce({
                    seq: 5,
                    pendingCount: 0,
                    lastViewedSessionSeq: 5,
                    pendingPermissionRequestCount: 0,
                    pendingUserActionRequestCount: 0,
                    latestTurnId: "turn-1",
                    latestTurnStatus: "completed",
                    latestTurnStatusObservedAt: BigInt(200),
                    lastRuntimeIssue: null,
                    active: true,
                    archivedAt: null,
                })
                .mockResolvedValueOnce({
                    latestTurnId: "turn-1",
                    latestTurnStatus: "completed",
                    latestTurnStatusObservedAt: BigInt(200),
                    lastRuntimeIssue: null,
                });
            currentTx.sessionShare.findUnique.mockResolvedValue(null);
            currentTx.sessionTurnMutationReceipt.findUnique.mockResolvedValue(null);
            currentTx.sessionTurn.findUnique.mockResolvedValue(completedTurnRow);
            currentTx.sessionTurnMutationReceipt.create.mockRejectedValue(Object.assign(new Error("duplicate"), { code: "P2002" }));

            const res = await applySessionTurnMutation({
                actorUserId: "u1",
                mutation: {
                    ...beginMutation,
                    mutationId: "mutation-stale-begin",
                    observedAt: 300,
                },
            });

            expect(res).toMatchObject({
                ok: true,
                didApply: false,
                reason: "duplicate-mutation",
                latestTurnId: "turn-1",
                latestTurnStatus: "completed",
                latestTurnStatusObservedAt: 200,
                lastRuntimeIssue: null,
                participantCursors: [],
                badgeAttentionChanged: false,
            });
        });

        it("persists the final no-op decision for end-session without a current turn", async () => {
            expect(typeof applySessionTurnMutation).toBe("function");
            const dateNowMock = vi.spyOn(Date, "now")
                .mockReturnValueOnce(1_000)
                .mockReturnValueOnce(2_000)
                .mockReturnValue(3_000);
            currentTx.session.findUnique
                .mockResolvedValueOnce({
                    accountId: "u1",
                    encryptionMode: "e2ee",
                    seq: 5,
                    pendingCount: 0,
                    lastViewedSessionSeq: 5,
                    pendingPermissionRequestCount: 0,
                    pendingUserActionRequestCount: 0,
                    latestTurnId: null,
                    latestTurnStatus: null,
                    latestTurnStatusObservedAt: null,
                    lastRuntimeIssue: null,
                    active: true,
                    archivedAt: null,
                    shares: [],
                })
                .mockResolvedValueOnce({
                    latestTurnId: null,
                    latestTurnStatus: null,
                    latestTurnStatusObservedAt: null,
                    lastRuntimeIssue: null,
                });
            currentTx.sessionShare.findUnique.mockResolvedValue(null);
            currentTx.sessionTurnMutationReceipt.findUnique.mockResolvedValue(null);

            const res = await applySessionTurnMutation({
                actorUserId: "u1",
                mutation: {
                    v: 1,
                    sessionId: "s1",
                    mutationId: "mutation-end-empty",
                    action: "end_session",
                    observedAt: 300,
                },
            });
            dateNowMock.mockRestore();

            expect(currentTx.sessionTurnMutationReceipt.update).toHaveBeenCalledWith({
                where: {
                    sessionId_mutationId: {
                        sessionId: "s1",
                        mutationId: "mutation-end-empty",
                    },
                },
                data: expect.objectContaining({
                    turnId: null,
                    action: "end_session",
                    decision: "missing-turn",
                    observedAt: BigInt(300),
                    appliedAt: BigInt(2_000),
                }),
            });
            expect(res).toMatchObject({
                ok: true,
                didApply: false,
                reason: "no-current-turn",
                receipt: {
                    action: "end_session",
                    decision: "missing-turn",
                    appliedAt: 2_000,
                },
            });
        });

        it("replays the stored duplicate receipt after a begin-turn P2002 race", async () => {
            expect(typeof applySessionTurnMutation).toBe("function");
            const dateNowMock = vi.spyOn(Date, "now").mockReturnValue(150);
            currentTx.session.findUnique
                .mockResolvedValueOnce({
                    accountId: "u1",
                    encryptionMode: "e2ee",
                    seq: 5,
                    pendingCount: 0,
                    lastViewedSessionSeq: 5,
                    pendingPermissionRequestCount: 0,
                    pendingUserActionRequestCount: 0,
                    latestTurnId: null,
                    latestTurnStatus: null,
                    latestTurnStatusObservedAt: null,
                    lastRuntimeIssue: null,
                    active: true,
                    archivedAt: null,
                    shares: [],
                })
                .mockResolvedValueOnce({
                    seq: 5,
                    pendingCount: 0,
                    lastViewedSessionSeq: 5,
                    pendingPermissionRequestCount: 0,
                    pendingUserActionRequestCount: 0,
                    latestTurnId: null,
                    latestTurnStatus: null,
                    latestTurnStatusObservedAt: null,
                    lastRuntimeIssue: null,
                    active: true,
                    archivedAt: null,
                })
                .mockResolvedValueOnce({
                    seq: 5,
                    pendingCount: 0,
                    lastViewedSessionSeq: 5,
                    pendingPermissionRequestCount: 0,
                    pendingUserActionRequestCount: 0,
                    latestTurnId: "turn-1",
                    latestTurnStatus: "in_progress",
                    latestTurnStatusObservedAt: BigInt(100),
                    lastRuntimeIssue: null,
                    active: true,
                    archivedAt: null,
                })
                .mockResolvedValueOnce({
                    latestTurnId: "turn-1",
                    latestTurnStatus: "in_progress",
                    latestTurnStatusObservedAt: BigInt(100),
                    lastRuntimeIssue: null,
                });
            currentTx.sessionShare.findUnique.mockResolvedValue(null);
            currentTx.sessionTurnMutationReceipt.findUnique.mockResolvedValue(null);
            currentTx.sessionTurn.findUnique.mockResolvedValue(null);
            currentTx.sessionTurn.create.mockRejectedValue(Object.assign(new Error("duplicate turn"), { code: "P2002" }));
            currentTx.sessionTurnMutationReceipt.update.mockResolvedValue({});

            const res = await (async () => {
                try {
                    return await applySessionTurnMutation({
                        actorUserId: "u1",
                        mutation: beginMutation,
                    });
                } finally {
                    dateNowMock.mockRestore();
                }
            })();

            expect(res).toMatchObject({
                ok: true,
                didApply: false,
                reason: "duplicate-mutation",
                latestTurnId: "turn-1",
                latestTurnStatus: "in_progress",
                latestTurnStatusObservedAt: 100,
                lastRuntimeIssue: null,
                participantCursors: [],
                badgeAttentionChanged: false,
                receipt: {
                    sessionId: "s1",
                    mutationId: "mutation-begin",
                    turnId: "turn-1",
                    action: "begin",
                    decision: "duplicate-mutation",
                    observedAt: 100,
                    appliedAt: 150,
                },
            });
        });

        it("allows a newer accepted turn to become in-progress after a terminal turn", async () => {
            expect(typeof applySessionTurnMutation).toBe("function");
            currentTx.session.findUnique
                .mockResolvedValueOnce({
                    accountId: "u1",
                    encryptionMode: "e2ee",
                    seq: 5,
                    pendingCount: 0,
                    lastViewedSessionSeq: 5,
                    pendingPermissionRequestCount: 0,
                    pendingUserActionRequestCount: 0,
                    latestTurnId: "turn-1",
                    latestTurnStatus: "completed",
                    latestTurnStatusObservedAt: BigInt(200),
                    lastRuntimeIssueJson: null,
                    active: true,
                    archivedAt: null,
                    shares: [],
                })
                .mockResolvedValueOnce({
                    latestTurnId: "turn-1",
                    seq: 5,
                    pendingCount: 0,
                    lastViewedSessionSeq: 5,
                    pendingPermissionRequestCount: 0,
                    pendingUserActionRequestCount: 0,
                    latestTurnStatus: "completed",
                    lastRuntimeIssue: null,
                    active: true,
                    archivedAt: null,
                });
            currentTx.sessionShare.findUnique.mockResolvedValue(null);
            currentTx.sessionTurnMutationReceipt.findUnique.mockResolvedValue(null);
            currentTx.sessionTurn.findUnique.mockResolvedValue(null);
            currentTx.sessionTurn.create.mockResolvedValue({
                ...completedTurnRow,
                id: "row-turn-2",
                turnId: "turn-2",
                providerTurnId: null,
                status: "in_progress",
                startedAt: BigInt(300),
                updatedAt: BigInt(300),
                terminalAt: null,
                lastMutationId: "mutation-next-begin",
            });
            getSessionParticipantUserIds.mockResolvedValue(["u1"]);
            markAccountChanged.mockResolvedValueOnce(102);

            const res = await applySessionTurnMutation({
                actorUserId: "u1",
                mutation: {
                    ...beginMutation,
                    mutationId: "mutation-next-begin",
                    turnId: "turn-2",
                    observedAt: 300,
                },
            });

            expect(currentTx.session.update).toHaveBeenCalledWith({
                where: { id: "s1" },
                data: {
                    latestTurnId: "turn-2",
                    latestTurnStatus: "in_progress",
                    latestTurnStatusObservedAt: BigInt(300),
                    lastRuntimeIssue: null,
                    thinking: true,
                    thinkingAt: new Date(300),
                },
            });
            expect(res).toMatchObject({
                ok: true,
                didApply: true,
                latestTurnId: "turn-2",
                latestTurnStatus: "in_progress",
                latestTurnStatusObservedAt: 300,
            });
        });

        it("terminalizes only the active current turn on session end", async () => {
            expect(typeof applySessionTurnMutation).toBe("function");
            currentTx.session.findUnique
                .mockResolvedValueOnce({
                    accountId: "u1",
                    encryptionMode: "e2ee",
                    seq: 5,
                    pendingCount: 0,
                    lastViewedSessionSeq: 5,
                    pendingPermissionRequestCount: 0,
                    pendingUserActionRequestCount: 0,
                    latestTurnId: "turn-1",
                    latestTurnStatus: "in_progress",
                    latestTurnStatusObservedAt: BigInt(100),
                    lastRuntimeIssue: null,
                    active: true,
                    archivedAt: null,
                    shares: [],
                })
                .mockResolvedValueOnce({
                    latestTurnId: "turn-1",
                    seq: 5,
                    pendingCount: 0,
                    lastViewedSessionSeq: 5,
                    pendingPermissionRequestCount: 0,
                    pendingUserActionRequestCount: 0,
                    latestTurnStatus: "in_progress",
                    lastRuntimeIssue: null,
                    active: true,
                    archivedAt: null,
                });
            currentTx.sessionShare.findUnique.mockResolvedValue(null);
            currentTx.sessionTurnMutationReceipt.findUnique.mockResolvedValue(null);
            currentTx.sessionTurn.findUnique.mockResolvedValue({
                ...completedTurnRow,
                status: "in_progress",
                terminalAt: null,
                updatedAt: BigInt(100),
            });
            currentTx.sessionTurn.update.mockResolvedValue({
                ...completedTurnRow,
                status: "cancelled",
                updatedAt: BigInt(400),
                terminalAt: BigInt(400),
                lastMutationId: "mutation-end",
            });
            getSessionParticipantUserIds.mockResolvedValue(["u1"]);
            markAccountChanged.mockResolvedValueOnce(103);

            const res = await applySessionTurnMutation({
                actorUserId: "u1",
                mutation: {
                    v: 1,
                    sessionId: "s1",
                    mutationId: "mutation-end",
                    turnId: "turn-1",
                    action: "end_session",
                    observedAt: 400,
                },
            });

            expect(currentTx.sessionTurn.update).toHaveBeenCalledWith({
                where: { id: "row-turn-1" },
                data: expect.objectContaining({
                    status: "cancelled",
                    updatedAt: BigInt(400),
                    terminalAt: BigInt(400),
                    lastRuntimeIssueJson: null,
                    lastMutationId: "mutation-end",
                }),
            });
            expect(res).toMatchObject({
                ok: true,
                didApply: true,
                latestTurnId: "turn-1",
                latestTurnStatus: "cancelled",
                latestTurnStatusObservedAt: 400,
            });
        });

        it("does not let a stale end-session settlement cancel a turn begun after the observed exit", async () => {
            expect(typeof applySessionTurnMutation).toBe("function");
            const dateNowMock = vi.spyOn(Date, "now")
                .mockReturnValueOnce(1_000)
                .mockReturnValueOnce(2_000)
                .mockReturnValue(3_000);
            currentTx.session.findUnique
                .mockResolvedValueOnce({
                    accountId: "u1",
                    encryptionMode: "e2ee",
                    seq: 5,
                    pendingCount: 0,
                    lastViewedSessionSeq: 5,
                    pendingPermissionRequestCount: 0,
                    pendingUserActionRequestCount: 0,
                    latestTurnId: "turn-2",
                    latestTurnStatus: "in_progress",
                    latestTurnStatusObservedAt: BigInt(500),
                    lastRuntimeIssue: null,
                    active: true,
                    archivedAt: null,
                    shares: [],
                })
                .mockResolvedValueOnce({
                    latestTurnId: "turn-2",
                    seq: 5,
                    pendingCount: 0,
                    lastViewedSessionSeq: 5,
                    pendingPermissionRequestCount: 0,
                    pendingUserActionRequestCount: 0,
                    latestTurnStatus: "in_progress",
                    lastRuntimeIssue: null,
                    active: true,
                    archivedAt: null,
                });
            currentTx.sessionShare.findUnique.mockResolvedValue(null);
            currentTx.sessionTurnMutationReceipt.findUnique.mockResolvedValue(null);
            // The replacement runner's turn began at 500 — AFTER the daemon observed the dead
            // runner's exit at 400. The queued settlement must not cancel it.
            currentTx.sessionTurn.findUnique.mockResolvedValue({
                ...completedTurnRow,
                turnId: "turn-2",
                status: "in_progress",
                startedAt: BigInt(500),
                updatedAt: BigInt(500),
                terminalAt: null,
            });

            const res = await applySessionTurnMutation({
                actorUserId: "u1",
                mutation: {
                    v: 1,
                    sessionId: "s1",
                    mutationId: "daemon-exit-turn-settlement:s1:400",
                    action: "end_session",
                    observedAt: 400,
                },
            });
            dateNowMock.mockRestore();

            expect(currentTx.sessionTurn.update).not.toHaveBeenCalled();
            expect(currentTx.sessionTurnMutationReceipt.update).toHaveBeenCalledWith({
                where: {
                    sessionId_mutationId: {
                        sessionId: "s1",
                        mutationId: "daemon-exit-turn-settlement:s1:400",
                    },
                },
                data: expect.objectContaining({
                    action: "end_session",
                    decision: "stale-terminal",
                }),
            });
            expect(res).toMatchObject({
                ok: true,
                didApply: false,
                reason: "terminal-turn",
                latestTurnId: "turn-2",
                latestTurnStatus: "in_progress",
            });
        });
    });

    describe("updateSessionReadCursor", () => {
        it("applies a monotonic max update and marks participants", async () => {
            currentTx.session.findUnique
                .mockResolvedValueOnce({ accountId: "u1" })
                .mockResolvedValueOnce({
                    seq: 8,
                    lastViewedSessionSeq: 3,
                    pendingCount: 0,
                    pendingPermissionRequestCount: 0,
                    pendingUserActionRequestCount: 0,
                    active: true,
                    archivedAt: null,
                });
            currentTx.sessionShare.findUnique.mockResolvedValue(null);
            currentTx.session.updateMany.mockResolvedValue({ count: 1 });
            getSessionParticipantUserIds.mockResolvedValue(["u1"]);
            markAccountChanged.mockResolvedValueOnce(200);

            const res = await updateSessionReadCursor({
                actorUserId: "u1",
                sessionId: "s1",
                lastViewedSessionSeq: 9,
            });

            expect(currentTx.session.updateMany).toHaveBeenCalledWith({
                where: {
                    id: "s1",
                    OR: [{ lastViewedSessionSeq: { lt: 8 } }, { lastViewedSessionSeq: null }],
                },
                data: { lastViewedSessionSeq: 8 },
            });
            expect(res).toEqual({
                ok: true,
                lastViewedSessionSeq: 8,
                participantCursors: [{ accountId: "u1", cursor: 200 }],
                badgeAttentionChanged: true,
            });
        });

        it("persists when the existing cursor is null", async () => {
            currentTx.session.findUnique
                .mockResolvedValueOnce({ accountId: "u1" })
                .mockResolvedValueOnce({
                    seq: 8,
                    lastViewedSessionSeq: null,
                    pendingCount: 0,
                    pendingPermissionRequestCount: 0,
                    pendingUserActionRequestCount: 0,
                    active: true,
                    archivedAt: null,
                });
            currentTx.sessionShare.findUnique.mockResolvedValue(null);
            currentTx.session.updateMany.mockResolvedValue({ count: 1 });
            getSessionParticipantUserIds.mockResolvedValue(["u1"]);
            markAccountChanged.mockResolvedValueOnce(200);

            const res = await updateSessionReadCursor({
                actorUserId: "u1",
                sessionId: "s1",
                lastViewedSessionSeq: 4,
            });

            expect(currentTx.session.updateMany).toHaveBeenCalledWith({
                where: {
                    id: "s1",
                    OR: [{ lastViewedSessionSeq: { lt: 4 } }, { lastViewedSessionSeq: null }],
                },
                data: { lastViewedSessionSeq: 4 },
            });
            expect(res).toEqual({
                ok: true,
                lastViewedSessionSeq: 4,
                participantCursors: [{ accountId: "u1", cursor: 200 }],
                badgeAttentionChanged: false,
            });
        });

        it("clamps advances to zero for empty sessions", async () => {
            currentTx.session.findUnique
                .mockResolvedValueOnce({ accountId: "u1" })
                .mockResolvedValueOnce({
                    seq: 0,
                    lastViewedSessionSeq: null,
                    pendingCount: 0,
                    pendingPermissionRequestCount: 0,
                    pendingUserActionRequestCount: 0,
                    active: true,
                    archivedAt: null,
                });
            currentTx.sessionShare.findUnique.mockResolvedValue(null);
            currentTx.session.updateMany.mockResolvedValue({ count: 1 });
            getSessionParticipantUserIds.mockResolvedValue(["u1"]);
            markAccountChanged.mockResolvedValueOnce(200);

            const res = await updateSessionReadCursor({
                actorUserId: "u1",
                sessionId: "s1",
                lastViewedSessionSeq: 9,
            });

            expect(currentTx.session.updateMany).toHaveBeenCalledWith({
                where: {
                    id: "s1",
                    OR: [{ lastViewedSessionSeq: { lt: 0 } }, { lastViewedSessionSeq: null }],
                },
                data: { lastViewedSessionSeq: 0 },
            });
            expect(res).toEqual({
                ok: true,
                lastViewedSessionSeq: 0,
                participantCursors: [{ accountId: "u1", cursor: 200 }],
                badgeAttentionChanged: false,
            });
        });

        it("returns ok without marking participants when the incoming cursor does not advance", async () => {
            currentTx.session.findUnique
                .mockResolvedValueOnce({ accountId: "u1" })
                .mockResolvedValueOnce({
                    seq: 8,
                    lastViewedSessionSeq: 5,
                    pendingCount: 0,
                    pendingPermissionRequestCount: 0,
                    pendingUserActionRequestCount: 0,
                    active: true,
                    archivedAt: null,
                });
            currentTx.sessionShare.findUnique.mockResolvedValue(null);

            const res = await updateSessionReadCursor({
                actorUserId: "u1",
                sessionId: "s1",
                lastViewedSessionSeq: 4,
            });

            expect(currentTx.session.updateMany).not.toHaveBeenCalled();
            expect(markAccountChanged).not.toHaveBeenCalled();
            expect(res).toEqual({
                ok: true,
                lastViewedSessionSeq: 5,
                participantCursors: [],
                badgeAttentionChanged: false,
            });
        });
    });

    describe("applySessionReadCursorOperation", () => {
        it("marks unread by lowering the cursor with a lowering-aware write", async () => {
            currentTx.session.findUnique
                .mockResolvedValueOnce({ accountId: "u1" })
                .mockResolvedValueOnce({
                    seq: 8,
                    lastViewedSessionSeq: 8,
                    pendingCount: 0,
                    pendingPermissionRequestCount: 0,
                    pendingUserActionRequestCount: 0,
                    active: true,
                    archivedAt: null,
                });
            currentTx.sessionShare.findUnique.mockResolvedValue(null);
            currentTx.session.updateMany.mockResolvedValue({ count: 1 });
            getSessionParticipantUserIds.mockResolvedValue(["u1"]);
            markAccountChanged.mockResolvedValueOnce(200);

            const res = await applySessionReadCursorOperation({
                actorUserId: "u1",
                sessionId: "s1",
                operation: { kind: "mark-unread" },
            });

            expect(currentTx.session.updateMany).toHaveBeenCalledWith({
                where: {
                    id: "s1",
                    lastViewedSessionSeq: { gt: 7 },
                },
                data: { lastViewedSessionSeq: 7 },
            });
            expect(res).toEqual({
                ok: true,
                lastViewedSessionSeq: 7,
                participantCursors: [{ accountId: "u1", cursor: 200 }],
                badgeAttentionChanged: true,
                didChange: true,
                readState: "unread",
            });
        });

        it("preserves null when marking unread is already represented by a missing cursor", async () => {
            currentTx.session.findUnique
                .mockResolvedValueOnce({ accountId: "u1" })
                .mockResolvedValueOnce({
                    seq: 8,
                    lastViewedSessionSeq: null,
                    pendingCount: 0,
                    pendingPermissionRequestCount: 0,
                    pendingUserActionRequestCount: 0,
                    active: true,
                    archivedAt: null,
                });
            currentTx.sessionShare.findUnique.mockResolvedValue(null);

            const res = await applySessionReadCursorOperation({
                actorUserId: "u1",
                sessionId: "s1",
                operation: { kind: "mark-unread" },
            });

            expect(currentTx.session.updateMany).not.toHaveBeenCalled();
            expect(markAccountChanged).not.toHaveBeenCalled();
            expect(res).toEqual({
                ok: true,
                lastViewedSessionSeq: null,
                participantCursors: [],
                badgeAttentionChanged: false,
                didChange: false,
                readState: "unread",
            });
        });

        it("does not make archived sessions contribute badge attention when marked unread", async () => {
            currentTx.session.findUnique
                .mockResolvedValueOnce({ accountId: "u1" })
                .mockResolvedValueOnce({
                    seq: 8,
                    lastViewedSessionSeq: 8,
                    pendingCount: 0,
                    pendingPermissionRequestCount: 0,
                    pendingUserActionRequestCount: 0,
                    active: true,
                    archivedAt: new Date(123),
                });
            currentTx.sessionShare.findUnique.mockResolvedValue(null);
            currentTx.session.updateMany.mockResolvedValue({ count: 1 });
            getSessionParticipantUserIds.mockResolvedValue(["u1"]);
            markAccountChanged.mockResolvedValueOnce(200);

            const res = await applySessionReadCursorOperation({
                actorUserId: "u1",
                sessionId: "s1",
                operation: { kind: "mark-unread" },
            });

            expect(res).toEqual({
                ok: true,
                lastViewedSessionSeq: 7,
                participantCursors: [{ accountId: "u1", cursor: 200 }],
                badgeAttentionChanged: false,
                didChange: true,
                readState: "unread",
            });
        });

        it("marks read by advancing to the current sequence", async () => {
            currentTx.session.findUnique
                .mockResolvedValueOnce({ accountId: "u1" })
                .mockResolvedValueOnce({
                    seq: 8,
                    lastViewedSessionSeq: 3,
                    pendingCount: 0,
                    pendingPermissionRequestCount: 0,
                    pendingUserActionRequestCount: 0,
                    active: true,
                    archivedAt: null,
                });
            currentTx.sessionShare.findUnique.mockResolvedValue(null);
            currentTx.session.updateMany.mockResolvedValue({ count: 1 });
            getSessionParticipantUserIds.mockResolvedValue(["u1"]);
            markAccountChanged.mockResolvedValueOnce(200);

            const res = await applySessionReadCursorOperation({
                actorUserId: "u1",
                sessionId: "s1",
                operation: { kind: "mark-read" },
            });

            expect(currentTx.session.updateMany).toHaveBeenCalledWith({
                where: {
                    id: "s1",
                    OR: [{ lastViewedSessionSeq: { lt: 8 } }, { lastViewedSessionSeq: null }],
                },
                data: { lastViewedSessionSeq: 8 },
            });
            expect(res).toEqual({
                ok: true,
                lastViewedSessionSeq: 8,
                participantCursors: [{ accountId: "u1", cursor: 200 }],
                badgeAttentionChanged: true,
                didChange: true,
                readState: "read",
            });
        });
    });

    describe("patchSession", () => {
        it("returns version-mismatch with current values for requested fields", async () => {
            currentTx.session.findUnique
                .mockResolvedValueOnce({ accountId: "u1" })
                .mockResolvedValueOnce({
                    metadataVersion: 5,
                    metadata: "mCurrent",
                    agentStateVersion: 9,
                    agentState: "aCurrent",
                });
            currentTx.sessionShare.findUnique.mockResolvedValue(null);

            const res = await patchSession({
                actorUserId: "u1",
                sessionId: "s1",
                metadata: { ciphertext: "mNew", expectedVersion: 4 },
                agentState: { ciphertext: null, expectedVersion: 9 },
            });

            expect(res).toEqual({
                ok: false,
                error: "version-mismatch",
                current: {
                    metadata: { version: 5, value: "mCurrent" },
                    agentState: { version: 9, value: "aCurrent" },
                },
            });
            expect(currentTx.session.updateMany).not.toHaveBeenCalled();
        });

        it("updates both fields in one CAS and marks participants once", async () => {
            currentTx.session.findUnique
                .mockResolvedValueOnce({
                    accountId: "u1",
                    shares: [{ sharedWithUserId: "u2" }],
                })
                .mockResolvedValueOnce({
                    metadataVersion: 1,
                    metadata: "m1",
                    agentStateVersion: 2,
                    agentState: "a2",
                });
            currentTx.sessionShare.findUnique.mockResolvedValue(null);
            currentTx.session.updateMany.mockResolvedValue({ count: 1 });
            getSessionParticipantUserIds.mockResolvedValue(["u1", "u2"]);
            markAccountChanged.mockResolvedValueOnce(10).mockResolvedValueOnce(11);

            const res = await patchSession({
                actorUserId: "u1",
                sessionId: "s1",
                metadata: { ciphertext: "mNew", expectedVersion: 1 },
                agentState: { ciphertext: null, expectedVersion: 2 },
            });

            expect(res).toEqual({
                ok: true,
                participantCursors: [
                    { accountId: "u1", cursor: 10 },
                    { accountId: "u2", cursor: 11 },
                ],
                metadata: { version: 2, value: "mNew" },
                agentState: { version: 3, value: null },
            });
        });
    });
});
