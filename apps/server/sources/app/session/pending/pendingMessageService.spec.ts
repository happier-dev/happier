import { beforeEach, describe, expect, it, vi } from "vitest";
import { createEnvPatcher } from "@/testkit/env";

let currentTx: any;

vi.mock("@/storage/inTx", () => ({
    inTx: async (fn: any) => await fn(currentTx),
}));

const resolveSessionPendingEditAccess = vi.fn(async (..._args: any[]) => ({ ok: true, isOwner: true }));
vi.mock("@/app/session/pending/resolveSessionPendingAccess", () => ({
    resolveSessionPendingEditAccess: (...args: any[]) => resolveSessionPendingEditAccess(...args),
    resolveSessionPendingViewAccess: vi.fn(async () => ({ ok: true, isOwner: true })),
}));

const applyPendingSessionStateChange = vi.fn(async (params: { meaningfulActivityAt?: Date } = {}) => ({
    pendingCount: 1,
    pendingVersion: 1,
    participantCursors: [],
    ...(params.meaningfulActivityAt ? { meaningfulActivityAt: params.meaningfulActivityAt } : {}),
}));
vi.mock("@/app/session/pending/applyPendingSessionStateChange", () => ({
    applyPendingSessionStateChange: (...args: any[]) => applyPendingSessionStateChange(...args),
}));

import { enqueuePendingMessage, updatePendingMessage } from "./pendingMessageService";

const enqueuePendingMessageCompat = enqueuePendingMessage as unknown as (params: any) => Promise<any>;
const updatePendingMessageCompat = updatePendingMessage as unknown as (params: any) => Promise<any>;

describe("pendingMessageService", () => {
    const storagePolicyEnv = createEnvPatcher([
        "HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY",
    ]);

    beforeEach(() => {
        resolveSessionPendingEditAccess.mockReset();
        resolveSessionPendingEditAccess.mockResolvedValue({ ok: true, isOwner: true });
        applyPendingSessionStateChange.mockReset();
        applyPendingSessionStateChange.mockImplementation(async (params: { meaningfulActivityAt?: Date } = {}) => ({
            pendingCount: 1,
            pendingVersion: 1,
            participantCursors: [],
            ...(params.meaningfulActivityAt ? { meaningfulActivityAt: params.meaningfulActivityAt } : {}),
        }));
        storagePolicyEnv.restore();

        currentTx = {
            session: {
                findUnique: vi.fn(),
                update: vi.fn(async () => ({ pendingQueueSeq: 1 })),
            },
            sessionPendingMessage: {
                findUnique: vi.fn(),
                findFirst: vi.fn(),
                create: vi.fn(),
                update: vi.fn(),
            },
        };
    });

    it("stores plain content when session encryptionMode is plain and storagePolicy is optional", async () => {
        const createdAt = new Date("2020-01-01T00:00:00.000Z");
        storagePolicyEnv.set("HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY", "optional");

        currentTx.session.findUnique.mockResolvedValue({ encryptionMode: "plain", pendingCount: 0, pendingVersion: 0 });
        currentTx.sessionPendingMessage.findUnique.mockResolvedValue(null);
        currentTx.sessionPendingMessage.findFirst.mockResolvedValue(null);
        currentTx.sessionPendingMessage.create.mockResolvedValue({
            localId: "l1",
            content: { t: "plain", v: { type: "user", text: "hi" } },
            messageRole: "user",
            status: "queued",
            position: 1,
            createdAt,
            updatedAt: createdAt,
            discardedAt: null,
            discardedReason: null,
            authorAccountId: "u1",
        });

        const res = await enqueuePendingMessageCompat({
            actorUserId: "u1",
            sessionId: "s1",
            localId: "l1",
            content: { t: "plain", v: { type: "user", text: "hi" } },
        });

        expect(res.ok).toBe(true);
        expect(res.meaningfulActivityAt).toEqual(createdAt);
        expect(currentTx.sessionPendingMessage.create).toHaveBeenCalledWith(
            expect.objectContaining({
                data: expect.objectContaining({
                    content: { t: "plain", v: { type: "user", text: "hi" } },
                    messageRole: "user",
                }),
            }),
        );
    });

    it("stores supplied encrypted pending message role metadata", async () => {
        const createdAt = new Date("2020-01-01T00:00:00.000Z");

        currentTx.session.findUnique.mockResolvedValue({ encryptionMode: "e2ee", pendingCount: 0, pendingVersion: 0 });
        currentTx.sessionPendingMessage.findUnique.mockResolvedValue(null);
        currentTx.sessionPendingMessage.findFirst.mockResolvedValue(null);
        currentTx.sessionPendingMessage.create.mockResolvedValue({
            localId: "l1",
            content: { t: "encrypted", c: "cipher" },
            messageRole: "user",
            status: "queued",
            position: 1,
            createdAt,
            updatedAt: createdAt,
            discardedAt: null,
            discardedReason: null,
            authorAccountId: "u1",
        });

        const res = await enqueuePendingMessageCompat({
            actorUserId: "u1",
            sessionId: "s1",
            localId: "l1",
            ciphertext: "cipher",
            messageRole: "user",
        });

        expect(res.ok).toBe(true);
        expect(res.pending.messageRole).toBe("user");
        expect(currentTx.sessionPendingMessage.create).toHaveBeenCalledWith(
            expect.objectContaining({
                data: expect.objectContaining({
                    messageRole: "user",
                }),
            }),
        );
    });

    it("self-heals missing role metadata on idempotent encrypted enqueue retry", async () => {
        const createdAt = new Date("2020-01-01T00:00:00.000Z");

        currentTx.session.findUnique.mockResolvedValue({ encryptionMode: "e2ee", pendingCount: 1, pendingVersion: 1 });
        currentTx.sessionPendingMessage.findUnique.mockResolvedValue({
            localId: "l1",
            content: { t: "encrypted", c: "cipher" },
            messageRole: null,
            status: "queued",
            position: 1,
            createdAt,
            updatedAt: createdAt,
            discardedAt: null,
            discardedReason: null,
            authorAccountId: "u1",
        });
        currentTx.sessionPendingMessage.update.mockResolvedValue({
            localId: "l1",
            content: { t: "encrypted", c: "cipher" },
            messageRole: "user",
            status: "queued",
            position: 1,
            createdAt,
            updatedAt: createdAt,
            discardedAt: null,
            discardedReason: null,
            authorAccountId: "u1",
        });

        const res = await enqueuePendingMessageCompat({
            actorUserId: "u1",
            sessionId: "s1",
            localId: "l1",
            ciphertext: "cipher",
            messageRole: "user",
        });

        expect(res.ok).toBe(true);
        expect(res.didWrite).toBe(false);
        expect(res.pending.messageRole).toBe("user");
        expect(currentTx.sessionPendingMessage.update).toHaveBeenCalledWith(expect.objectContaining({
            data: { messageRole: "user" },
        }));
    });

    it("rejects encrypted writes when session encryptionMode is plain", async () => {
        const createdAt = new Date("2020-01-01T00:00:00.000Z");
        storagePolicyEnv.set("HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY", "optional");

        currentTx.session.findUnique.mockResolvedValue({ encryptionMode: "plain", pendingCount: 0, pendingVersion: 0 });
        currentTx.sessionPendingMessage.findUnique.mockResolvedValue(null);
        currentTx.sessionPendingMessage.findFirst.mockResolvedValue(null);
        currentTx.sessionPendingMessage.create.mockResolvedValue({
            localId: "l1",
            content: { t: "encrypted", c: "cipher" },
            status: "queued",
            position: 1,
            createdAt,
            updatedAt: createdAt,
            discardedAt: null,
            discardedReason: null,
            authorAccountId: "u1",
        });

        const res = await enqueuePendingMessageCompat({
            actorUserId: "u1",
            sessionId: "s1",
            localId: "l1",
            ciphertext: "cipher",
        });

        expect(res).toEqual({ ok: false, error: "invalid-params", code: "session_encryption_mode_mismatch" });
        expect(currentTx.sessionPendingMessage.create).not.toHaveBeenCalled();
    });

    it("rejects encrypted update writes when session encryptionMode is plain (with a stable code)", async () => {
        storagePolicyEnv.set("HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY", "optional");

        currentTx.session.findUnique.mockResolvedValue({ encryptionMode: "plain", pendingCount: 1, pendingVersion: 1 });
        currentTx.sessionPendingMessage.findUnique.mockResolvedValue({ id: "p1", status: "queued" });
        currentTx.sessionPendingMessage.update = vi.fn();

        const res = await updatePendingMessageCompat({
            actorUserId: "u1",
            sessionId: "s1",
            localId: "l1",
            ciphertext: "cipher",
        });

        expect(res).toEqual({ ok: false, error: "invalid-params", code: "session_encryption_mode_mismatch" });
        expect(currentTx.sessionPendingMessage.update).not.toHaveBeenCalled();
    });

    it("updates pending content using plain envelopes when session encryptionMode is plain and storagePolicy is optional", async () => {
        storagePolicyEnv.set("HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY", "optional");

        currentTx.session.findUnique.mockResolvedValue({ encryptionMode: "plain", pendingCount: 1, pendingVersion: 1 });
        currentTx.sessionPendingMessage.findUnique.mockResolvedValue({ id: "p1", status: "queued" });
        currentTx.sessionPendingMessage.update = vi.fn();

        const res = await updatePendingMessageCompat({
            actorUserId: "u1",
            sessionId: "s1",
            localId: "l1",
            content: { t: "plain", v: { type: "user", text: "hi" } },
        });

        expect(res.ok).toBe(true);
        expect(currentTx.sessionPendingMessage.update).toHaveBeenCalledWith(
            expect.objectContaining({
                data: { content: { t: "plain", v: { type: "user", text: "hi" } }, messageRole: "user" },
            }),
        );
    });

    it("updates pending content in place without changing queue position", async () => {
        storagePolicyEnv.set("HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY", "optional");

        currentTx.session.findUnique.mockResolvedValue({ encryptionMode: "plain", pendingCount: 3, pendingVersion: 7 });
        currentTx.sessionPendingMessage.findUnique.mockResolvedValue({ id: "p2", status: "queued" });
        currentTx.sessionPendingMessage.update = vi.fn();

        const res = await updatePendingMessageCompat({
            actorUserId: "u1",
            sessionId: "s1",
            localId: "p2",
            content: { t: "plain", v: { type: "user", text: "edited middle row" } },
        });

        expect(res.ok).toBe(true);
        expect(currentTx.sessionPendingMessage.update).toHaveBeenCalledWith(
            expect.objectContaining({
                where: { sessionId_localId: { sessionId: "s1", localId: "p2" } },
                data: {
                    content: { t: "plain", v: { type: "user", text: "edited middle row" } },
                    messageRole: "user",
                },
            }),
        );
        expect(currentTx.sessionPendingMessage.create).not.toHaveBeenCalled();
    });

    it("allocates queued positions from a session counter so racing enqueues keep their order", async () => {
        const createdAt = new Date("2020-01-01T00:00:00.000Z");
        let nextPendingQueueSeq = 0;

        currentTx.session.findUnique.mockResolvedValue({
            encryptionMode: "e2ee",
            pendingCount: 0,
            pendingVersion: 0,
            pendingQueueSeq: 0,
        });
        currentTx.session.update.mockImplementation(async () => ({ pendingQueueSeq: ++nextPendingQueueSeq }));
        currentTx.sessionPendingMessage.findUnique.mockResolvedValue(null);
        currentTx.sessionPendingMessage.findFirst.mockResolvedValue(null);
        currentTx.sessionPendingMessage.create.mockImplementation(async ({ data }: { data: any }) => ({
            localId: data.localId,
            content: data.content,
            status: data.status,
            position: data.position,
            createdAt,
            updatedAt: createdAt,
            discardedAt: null,
            discardedReason: null,
            authorAccountId: data.authorAccountId,
        }));

        const [first, second] = await Promise.all([
            enqueuePendingMessageCompat({
                actorUserId: "u1",
                sessionId: "s1",
                localId: "l1",
                ciphertext: "cipher-1",
            }),
            enqueuePendingMessageCompat({
                actorUserId: "u1",
                sessionId: "s1",
                localId: "l2",
                ciphertext: "cipher-2",
            }),
        ]);

        expect(first.ok).toBe(true);
        expect(second.ok).toBe(true);
        expect(currentTx.session.update).toHaveBeenCalledTimes(2);
        expect(currentTx.sessionPendingMessage.findFirst).toHaveBeenCalledTimes(2);
        expect(currentTx.sessionPendingMessage.create.mock.calls.map((call: any[]) => call[0].data.position)).toEqual([1, 2]);
    });
});
