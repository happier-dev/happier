import { beforeEach, describe, expect, it, vi } from "vitest";

let currentTx: any;

vi.mock("@/storage/inTx", () => ({
    inTx: async (fn: any) => await fn(currentTx),
}));

const resolveSessionPendingEditAccess = vi.fn(async (..._args: any[]) => ({ ok: true, isOwner: true }));
vi.mock("@/app/session/pending/resolveSessionPendingAccess", () => ({
    resolveSessionPendingEditAccess: (...args: any[]) => resolveSessionPendingEditAccess(...args),
    resolveSessionPendingViewAccess: vi.fn(async () => ({ ok: true, isOwner: true })),
}));

const applyPendingSessionStateChange = vi.fn(async (..._args: any[]) => ({
    pendingCount: 1,
    pendingVersion: 1,
    participantCursors: [],
}));
vi.mock("@/app/session/pending/applyPendingSessionStateChange", () => ({
    applyPendingSessionStateChange: (...args: any[]) => applyPendingSessionStateChange(...args),
}));

import { enqueuePendingMessage, updatePendingMessage } from "./pendingMessageService";

const enqueuePendingMessageCompat = enqueuePendingMessage as unknown as (params: any) => Promise<any>;
const updatePendingMessageCompat = updatePendingMessage as unknown as (params: any) => Promise<any>;

describe("pendingMessageService", () => {
    beforeEach(() => {
        resolveSessionPendingEditAccess.mockReset();
        resolveSessionPendingEditAccess.mockResolvedValue({ ok: true, isOwner: true });
        applyPendingSessionStateChange.mockReset();
        applyPendingSessionStateChange.mockResolvedValue({ pendingCount: 1, pendingVersion: 1, participantCursors: [] });

        currentTx = {
            session: {
                findUnique: vi.fn(),
            },
            sessionPendingMessage: {
                findUnique: vi.fn(),
                findFirst: vi.fn(),
                create: vi.fn(),
            },
        };
    });

    it("stores plain content when session encryptionMode is plain and storagePolicy is optional", async () => {
        const createdAt = new Date("2020-01-01T00:00:00.000Z");
        const prevStoragePolicy = process.env.HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY;
        process.env.HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY = "optional";

        try {
            currentTx.session.findUnique.mockResolvedValue({ encryptionMode: "plain", pendingCount: 0, pendingVersion: 0 });
            currentTx.sessionPendingMessage.findUnique.mockResolvedValue(null);
            currentTx.sessionPendingMessage.findFirst.mockResolvedValue(null);
            currentTx.sessionPendingMessage.create.mockResolvedValue({
                localId: "l1",
                content: { t: "plain", v: { type: "user", text: "hi" } },
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
            expect(currentTx.sessionPendingMessage.create).toHaveBeenCalledWith(
                expect.objectContaining({
                    data: expect.objectContaining({
                        content: { t: "plain", v: { type: "user", text: "hi" } },
                    }),
                }),
            );
        } finally {
            if (typeof prevStoragePolicy === "string") process.env.HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY = prevStoragePolicy;
            else delete (process.env as any).HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY;
        }
    });

    it("rejects encrypted writes when session encryptionMode is plain", async () => {
        const createdAt = new Date("2020-01-01T00:00:00.000Z");
        const prevStoragePolicy = process.env.HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY;
        process.env.HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY = "optional";

        try {
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
        } finally {
            if (typeof prevStoragePolicy === "string") process.env.HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY = prevStoragePolicy;
            else delete (process.env as any).HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY;
        }
    });

    it("rejects encrypted update writes when session encryptionMode is plain (with a stable code)", async () => {
        const prevStoragePolicy = process.env.HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY;
        process.env.HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY = "optional";

        try {
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
        } finally {
            if (typeof prevStoragePolicy === "string") process.env.HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY = prevStoragePolicy;
            else delete (process.env as any).HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY;
        }
    });

    it("updates pending content using plain envelopes when session encryptionMode is plain and storagePolicy is optional", async () => {
        const prevStoragePolicy = process.env.HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY;
        process.env.HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY = "optional";

        try {
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
                    data: { content: { t: "plain", v: { type: "user", text: "hi" } } },
                }),
            );
        } finally {
            if (typeof prevStoragePolicy === "string") process.env.HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY = prevStoragePolicy;
            else delete (process.env as any).HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY;
        }
    });
});
