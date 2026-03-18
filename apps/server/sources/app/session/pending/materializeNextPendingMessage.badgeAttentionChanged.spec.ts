import { beforeEach, describe, expect, it, vi } from "vitest";

const resolveSessionPendingOwnerAccess = vi.fn(async () => ({ ok: true as const }));
vi.mock("@/app/session/pending/resolveSessionPendingAccess", () => ({
    resolveSessionPendingOwnerAccess,
}));

const markSessionParticipantsChanged = vi.fn(async () => []);
vi.mock("@/app/session/changeTracking/markSessionParticipantsChanged", () => ({
    markSessionParticipantsChanged,
}));

const markPendingStateChangedParticipants = vi.fn(async () => []);
vi.mock("@/app/session/pending/markPendingStateChangedParticipants", () => ({
    markPendingStateChangedParticipants,
}));

const dbSessionFindUnique = vi.fn();
const dbSessionPendingMessageFindFirst = vi.fn();
vi.mock("@/storage/db", () => ({
    db: {
        session: {
            findUnique: dbSessionFindUnique,
        },
        sessionPendingMessage: {
            findFirst: dbSessionPendingMessageFindFirst,
        },
    },
}));

const txSessionPendingMessageFindFirst = vi.fn();
const txSessionMessageFindFirst = vi.fn();
const txSessionUpdate = vi.fn();
const txSessionMessageCreate = vi.fn();
const txSessionPendingMessageDelete = vi.fn();
const txSessionUpdateMany = vi.fn();
const txSessionFindUniqueOrThrow = vi.fn();

const inTx = vi.fn(async (run: (tx: any) => Promise<unknown>) => run({
    sessionPendingMessage: {
        findFirst: txSessionPendingMessageFindFirst,
        delete: txSessionPendingMessageDelete,
    },
    sessionMessage: {
        findFirst: txSessionMessageFindFirst,
        create: txSessionMessageCreate,
    },
    session: {
        update: txSessionUpdate,
        updateMany: txSessionUpdateMany,
        findUniqueOrThrow: txSessionFindUniqueOrThrow,
    },
}));
vi.mock("@/storage/inTx", () => ({
    inTx,
}));

vi.mock("@/app/features/catalog/readFeatureEnv", () => ({
    readEncryptionFeatureEnv: () => ({ storagePolicy: "required_e2ee" }),
}));

describe("materializeNextPendingMessage badgeAttentionChanged", () => {
    beforeEach(() => {
        vi.clearAllMocks();

        dbSessionFindUnique.mockResolvedValue({
            encryptionMode: "e2ee",
            seq: 0,
            pendingCount: 1,
            lastViewedSessionSeq: 0,
            pendingPermissionRequestCount: 0,
            pendingUserActionRequestCount: 0,
            active: true,
            archivedAt: null,
        });
        dbSessionPendingMessageFindFirst.mockResolvedValue({ localId: "l1" });

        txSessionPendingMessageFindFirst.mockResolvedValue({
            localId: "l1",
            status: "queued",
            content: { t: "encrypted", c: "ciphertext" },
        });
        txSessionMessageFindFirst.mockResolvedValue(null);
        txSessionUpdate.mockResolvedValueOnce({ seq: 1 });
        txSessionMessageCreate.mockResolvedValue({
            id: "m1",
            seq: 1,
            localId: "l1",
            content: { t: "encrypted", c: "ciphertext" },
            createdAt: new Date("2026-03-16T00:00:00.000Z"),
            updatedAt: new Date("2026-03-16T00:00:00.000Z"),
        });
        txSessionPendingMessageDelete.mockResolvedValue(undefined);
        txSessionUpdateMany.mockResolvedValue({ count: 1 });
        txSessionFindUniqueOrThrow
            .mockResolvedValueOnce({
                seq: 0,
                pendingCount: 0,
                pendingVersion: 6,
                lastViewedSessionSeq: 0,
                pendingPermissionRequestCount: 0,
                pendingUserActionRequestCount: 0,
                active: true,
                archivedAt: null,
            })
            .mockResolvedValueOnce({
                seq: 1,
                pendingCount: 0,
                pendingVersion: 7,
                lastViewedSessionSeq: 0,
                pendingPermissionRequestCount: 0,
                pendingUserActionRequestCount: 0,
                active: true,
                archivedAt: null,
            });
    });

    it("computes badgeAttentionChanged from the transactional pre-update session state", async () => {
        const { materializeNextPendingMessage } = await import("./materializeNextPendingMessage");

        const result = await materializeNextPendingMessage({ actorUserId: "u1", sessionId: "s1" });

        expect(result).toMatchObject({
            ok: true,
            didMaterialize: true,
            badgeAttentionChanged: true,
        });
    });
});
