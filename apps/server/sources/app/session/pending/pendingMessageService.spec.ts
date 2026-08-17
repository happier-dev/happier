import { beforeEach, describe, expect, it, vi } from "vitest";
import { createEnvPatcher } from "@/testkit/env";
import { buildSessionAgentTransitionDividerLocalId } from "@happier-dev/protocol";

let currentTx: any;

const { inTxMock, warn } = vi.hoisted(() => ({
    inTxMock: vi.fn(),
    warn: vi.fn(),
}));
vi.mock("@/storage/inTx", async (importOriginal) => ({
    ...(await importOriginal<typeof import("@/storage/inTx")>()),
    inTx: (...args: any[]) => inTxMock(...args),
}));

vi.mock("@/utils/logging/log", async (importOriginal) => ({
    ...(await importOriginal<typeof import("@/utils/logging/log")>()),
    warn,
}));

const resolveSessionPendingEditAccess = vi.fn(async (..._args: any[]) => ({ ok: true, isOwner: true }));
const resolveSessionPendingOwnerAccess = vi.fn(async (..._args: any[]) => ({ ok: true, isOwner: true }));
vi.mock("@/app/session/pending/resolveSessionPendingAccess", () => ({
    resolveSessionPendingEditAccess: (...args: any[]) => resolveSessionPendingEditAccess(...args),
    resolveSessionPendingOwnerAccess: (...args: any[]) => resolveSessionPendingOwnerAccess(...args),
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

import {
    deletePendingMessage,
    enqueuePendingMessage,
    resolveAcceptedPendingDelivery as resolveAcceptedPendingDeliveryOwner,
    updatePendingMessage,
} from "./pendingMessageService";
import { TransactionAcquisitionUnavailableError } from "@/storage/inTx";

const enqueuePendingMessageCompat = enqueuePendingMessage as unknown as (params: any) => Promise<any>;
const updatePendingMessageCompat = updatePendingMessage as unknown as (params: any) => Promise<any>;
const enqueueRequestedAction = { v: 1, kind: "enqueue" } as const;
const trustedPublisherFence = {
    accountId: "u1",
    machineId: "m1",
    sessionId: "s1",
    committedFence: new Date("2026-07-19T00:00:00.000Z"),
};
const resolveAcceptedPendingDelivery = (
    params: Omit<Parameters<typeof resolveAcceptedPendingDeliveryOwner>[0], "trustedPublisherFence">,
) => resolveAcceptedPendingDeliveryOwner({ ...params, trustedPublisherFence });

describe("pendingMessageService", () => {
    const storagePolicyEnv = createEnvPatcher([
        "HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY",
    ]);
    const transactionProviderEnv = createEnvPatcher([
        "HAPPIER_DB_PROVIDER",
        "HAPPY_DB_PROVIDER",
    ]);

    beforeEach(() => {
        inTxMock.mockReset();
        inTxMock.mockImplementation(async (fn: any) => await fn(currentTx));
        warn.mockReset();
        resolveSessionPendingEditAccess.mockReset();
        resolveSessionPendingEditAccess.mockResolvedValue({ ok: true, isOwner: true });
        resolveSessionPendingOwnerAccess.mockReset();
        resolveSessionPendingOwnerAccess.mockResolvedValue({ ok: true, isOwner: true });
        applyPendingSessionStateChange.mockReset();
        applyPendingSessionStateChange.mockResolvedValue({ pendingCount: 1, pendingVersion: 1, participantCursors: [] });
        storagePolicyEnv.restore();
        transactionProviderEnv.restore();

        currentTx = {
            accessKey: {
                findUnique: vi.fn(async () => ({
                    machine: { revokedAt: null, replacedByMachineId: null },
                    session: { accountId: "u1" },
                })),
            },
            session: {
                findUnique: vi.fn(async () => ({
                    accountId: "u1",
                    active: true,
                    archivedAt: null,
                    lastActiveAt: trustedPublisherFence.committedFence,
                    updatedAt: new Date("2026-07-19T00:00:01.000Z"),
                })),
                update: vi.fn(async () => ({ pendingQueueSeq: 1 })),
            },
            sessionPendingMessage: {
                findUnique: vi.fn(),
                findFirst: vi.fn(),
                create: vi.fn(),
            },
            sessionMessage: {
                findUnique: vi.fn(async () => null),
                findFirst: vi.fn(async () => null),
            },
        };
    });

    it("returns the exact committed transcript message when accepted settlement is replayed after response loss", async () => {
        const createdAt = new Date("2026-07-19T00:00:02.000Z");
        const updatedAt = new Date("2026-07-19T00:00:03.000Z");
        currentTx.sessionPendingMessage.findUnique.mockResolvedValue(null);
        currentTx.sessionMessage.findFirst.mockResolvedValue({
            id: "message-1",
            seq: 17,
            localId: "l1",
            messageRole: "user",
            content: { t: "plain", v: { role: "user", content: { type: "text", text: "hello" } } },
            createdAt,
            updatedAt,
        });
        currentTx.session.findUnique
            .mockResolvedValueOnce({
                accountId: "u1",
                active: true,
                archivedAt: null,
                lastActiveAt: trustedPublisherFence.committedFence,
                updatedAt: new Date("2026-07-19T00:00:01.000Z"),
            })
            .mockResolvedValueOnce({
                pendingCount: 0,
                pendingBlockedCount: 0,
                pendingVersion: 4,
            });

        await expect(resolveAcceptedPendingDelivery({
            actorUserId: "u1",
            sessionId: "s1",
            localId: "l1",
        })).resolves.toEqual(expect.objectContaining({
            ok: true,
            didResolve: false,
            message: expect.objectContaining({
                id: "message-1",
                seq: 17,
                localId: "l1",
                createdAt,
                updatedAt,
            }),
        }));
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
            requestedAction: enqueueRequestedAction,
            content: { t: "plain", v: { type: "user", text: "hi" } },
        });

        expect(res.ok).toBe(true);
        expect(currentTx.sessionPendingMessage.create).toHaveBeenCalledWith(
            expect.objectContaining({
                data: expect.objectContaining({
                    content: { t: "plain", v: { type: "user", text: "hi" } },
                    messageRole: "user",
                }),
            }),
        );
    });

    it("refuses the reserved Agent-transition divider namespace at the Pending admission owner", async () => {
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

        // A Pending row materializes into a transcript row under its own
        // localId, so a row planted at the deterministic divider id would
        // permanently conflict every future Agent transition for this Session.
        // The refusal belongs to the admission owner every adapter reaches, not
        // to any one route.
        await expect(enqueuePendingMessageCompat({
            actorUserId: "u1",
            sessionId: "s1",
            localId: buildSessionAgentTransitionDividerLocalId("submitted-1"),
            requestedAction: enqueueRequestedAction,
            ciphertext: "cipher",
        })).resolves.toEqual({ ok: false, error: "invalid-params" });
        expect(currentTx.sessionPendingMessage.create).not.toHaveBeenCalled();
        expect(resolveSessionPendingEditAccess).not.toHaveBeenCalled();

        await expect(enqueuePendingMessageCompat({
            actorUserId: "u1",
            sessionId: "s1",
            localId: "l1",
            requestedAction: enqueueRequestedAction,
            ciphertext: "cipher",
        })).resolves.toMatchObject({ ok: true });
        expect(currentTx.sessionPendingMessage.create).toHaveBeenCalledTimes(1);
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
            requestedAction: enqueueRequestedAction,
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
            requestedAction: enqueueRequestedAction,
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

    it("self-heals missing pending role metadata on idempotent enqueue retry", async () => {
        const createdAt = new Date("2020-01-01T00:00:00.000Z");
        const backfilledAt = new Date("2020-01-01T00:00:01.000Z");
        const existingPending = {
            localId: "l1",
            content: { t: "encrypted", c: "cipher" },
            messageRole: null,
            requestedAction: enqueueRequestedAction,
            status: "queued",
            deliveryState: null,
            deliveryBlockedReason: null,
            position: 1,
            createdAt,
            updatedAt: createdAt,
            discardedAt: null,
            discardedReason: null,
            authorAccountId: "u1",
        };

        currentTx.session.findUnique.mockResolvedValue({ encryptionMode: "e2ee", pendingCount: 1, pendingVersion: 1 });
        currentTx.sessionPendingMessage.findUnique.mockResolvedValue(existingPending);
        currentTx.sessionPendingMessage.updateMany = vi.fn(async () => ({ count: 1 }));
        currentTx.sessionPendingMessage.findUniqueOrThrow = vi.fn(async () => ({
            ...existingPending,
            messageRole: "user",
            requestedAction: enqueueRequestedAction,
            updatedAt: backfilledAt,
        }));

        const res = await enqueuePendingMessageCompat({
            actorUserId: "u1",
            sessionId: "s1",
            localId: "l1",
            requestedAction: enqueueRequestedAction,
            ciphertext: "cipher",
            messageRole: "user",
        });

        expect(res.ok).toBe(true);
        expect(res.pending.messageRole).toBe("user");
        expect(res.pending.updatedAt).toEqual(backfilledAt);
        const updateArgs = currentTx.sessionPendingMessage.updateMany.mock.calls[0]?.[0];
        expect(updateArgs).toEqual({
            where: {
                sessionId: "s1",
                localId: "l1",
                status: "queued",
                messageRole: null,
                updatedAt: createdAt,
            },
            data: {
                messageRole: "user",
                updatedAt: expect.any(Date),
            },
        });
        expect(updateArgs.data.updatedAt.getTime()).toBeGreaterThan(createdAt.getTime());
    });

    it("does not backfill legacy identity metadata on a discarded retry", async () => {
        const createdAt = new Date("2020-01-01T00:00:00.000Z");
        currentTx.session.findUnique.mockResolvedValue({ encryptionMode: "e2ee", pendingCount: 0, pendingVersion: 2 });
        currentTx.sessionPendingMessage.findUnique.mockResolvedValue({
            localId: "l1",
            content: { t: "encrypted", c: "cipher" },
            messageRole: null,
            requestedAction: enqueueRequestedAction,
            status: "discarded",
            deliveryState: null,
            deliveryBlockedReason: null,
            position: 1,
            createdAt,
            updatedAt: createdAt,
            discardedAt: createdAt,
            discardedReason: "user_discarded",
            authorAccountId: "u1",
        });
        currentTx.sessionPendingMessage.updateMany = vi.fn(async () => ({ count: 1 }));
        currentTx.sessionPendingMessage.findUniqueOrThrow = vi.fn();

        await expect(enqueuePendingMessageCompat({
            actorUserId: "u1",
            sessionId: "s1",
            localId: "l1",
            requestedAction: enqueueRequestedAction,
            ciphertext: "cipher",
            messageRole: "user",
        })).resolves.toEqual({ ok: false, error: "requested-action-conflict" });
        expect(currentTx.sessionPendingMessage.updateMany).not.toHaveBeenCalled();
        expect(currentTx.sessionPendingMessage.findUniqueOrThrow).not.toHaveBeenCalled();
    });

    it("does not backfill role metadata when an external-handoff retry conflicts with the stored lifecycle", async () => {
        const createdAt = new Date("2020-01-01T00:00:00.000Z");
        currentTx.session.findUnique.mockResolvedValue({ encryptionMode: "e2ee", pendingCount: 1, pendingVersion: 1 });
        currentTx.sessionPendingMessage.findUnique.mockResolvedValue({
            localId: "l1",
            content: { t: "encrypted", c: "cipher" },
            messageRole: null,
            requestedAction: enqueueRequestedAction,
            status: "queued",
            deliveryState: null,
            deliveryBlockedReason: null,
            position: 1,
            createdAt,
            updatedAt: createdAt,
            discardedAt: null,
            discardedReason: null,
            authorAccountId: "u1",
        });
        currentTx.sessionPendingMessage.updateMany = vi.fn(async () => ({ count: 1 }));
        currentTx.sessionPendingMessage.findUniqueOrThrow = vi.fn();

        await expect(enqueuePendingMessageCompat({
            actorUserId: "u1",
            sessionId: "s1",
            localId: "l1",
            requestedAction: enqueueRequestedAction,
            ciphertext: "cipher",
            messageRole: "user",
            deliveryMode: "external_handoff",
        })).resolves.toEqual({ ok: false, error: "invalid-params" });
        expect(currentTx.sessionPendingMessage.updateMany).not.toHaveBeenCalled();
        expect(currentTx.sessionPendingMessage.findUniqueOrThrow).not.toHaveBeenCalled();
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
                requestedAction: enqueueRequestedAction,
                ciphertext: "cipher-1",
            }),
            enqueuePendingMessageCompat({
                actorUserId: "u1",
                sessionId: "s1",
                localId: "l2",
                requestedAction: enqueueRequestedAction,
                ciphertext: "cipher-2",
            }),
        ]);

        expect(first.ok).toBe(true);
        expect(second.ok).toBe(true);
        expect(currentTx.session.update).toHaveBeenCalledTimes(2);
        expect(currentTx.sessionPendingMessage.findFirst).toHaveBeenCalledTimes(2);
        expect(currentTx.sessionPendingMessage.create.mock.calls.map((call: any[]) => call[0].data.position)).toEqual([1, 2]);
    });

    it.each([
        {
            operation: "delete" as const,
            invoke: () => deletePendingMessage({
                actorUserId: "u1",
                sessionId: "s1",
                localId: "l1",
                diagnosticCorrelationId: "req-delete-1",
            }),
            correlationId: "req-delete-1",
            expectedAttempts: 1,
        },
        {
            operation: "provider-acceptance" as const,
            invoke: () => resolveAcceptedPendingDelivery({
                actorUserId: "u1",
                sessionId: "s1",
                localId: "l1",
                diagnosticCorrelationId: "req-accept-1",
            }),
            correlationId: "req-accept-1",
            expectedAttempts: 1,
        },
    ])("returns and logs a correlated typed transaction-acquisition failure for $operation", async ({ operation, invoke, correlationId, expectedAttempts }) => {
        const error = Object.assign(
            new Error("Transaction API error: Unable to start a transaction in the given time."),
            { code: "P2028", meta: { error: "Unable to start a transaction in the given time." } },
        );
        inTxMock.mockRejectedValue(new TransactionAcquisitionUnavailableError(error));

        await expect(invoke()).resolves.toEqual({
            ok: false,
            error: "transaction-unavailable",
            retryAfterMs: 1_000,
            correlationId,
        });
        expect(inTxMock).toHaveBeenCalledTimes(expectedAttempts);
        expect(warn).toHaveBeenCalledWith(
            expect.objectContaining({
                module: "session-pending-service",
                operation,
                sessionId: "s1",
                localId: "l1",
                correlationId,
                prismaCode: "P2028",
                err: error,
            }),
            "pending delivery transaction acquisition failed",
            error,
        );
    });

    it("does not reset the canonical SQLite retry budget after acquisition P2028", async () => {
        transactionProviderEnv.set("HAPPIER_DB_PROVIDER", "sqlite");
        const error = Object.assign(
            new Error("Transaction API error: Unable to start a transaction in the given time."),
            { code: "P2028", meta: { error: "Unable to start a transaction in the given time." } },
        );
        inTxMock.mockRejectedValue(new TransactionAcquisitionUnavailableError(error));

        await expect(resolveAcceptedPendingDelivery({
            actorUserId: "u1",
            sessionId: "s1",
            localId: "l1",
            diagnosticCorrelationId: "req-accept-sqlite",
        })).resolves.toEqual({
            ok: false,
            error: "transaction-unavailable",
            retryAfterMs: 1_000,
            correlationId: "req-accept-sqlite",
        });
        expect(inTxMock).toHaveBeenCalledTimes(1);
    });

    it("does not retry acquisition-shaped P2028 after the transaction callback starts", async () => {
        const error = Object.assign(
            new Error("Transaction API error: Unable to start a transaction in the given time."),
            { code: "P2028", meta: { error: "Unable to start a transaction in the given time." } },
        );
        currentTx.sessionPendingMessage.findUnique.mockRejectedValue(error);

        await expect(resolveAcceptedPendingDelivery({
            actorUserId: "u1",
            sessionId: "s1",
            localId: "l1",
            diagnosticCorrelationId: "req-accept-entered",
        })).resolves.toEqual({ ok: false, error: "internal" });
        expect(inTxMock).toHaveBeenCalledTimes(1);
        expect(warn).toHaveBeenCalledTimes(1);
        expect(warn).toHaveBeenCalledWith(
            expect.objectContaining({
                operation: "provider-acceptance",
                correlationId: "req-accept-entered",
                err: error,
            }),
            "pending delivery operation failed",
            error,
        );
    });

    it("returns forbidden with zero settlement mutation when publisher replacement wins after prevalidation", async () => {
        currentTx.session.update.mockRejectedValueOnce(
            Object.assign(new Error("record to update not found"), { code: "P2025" }),
        );

        await expect(resolveAcceptedPendingDelivery({
            actorUserId: "u1",
            sessionId: "s1",
            localId: "l1",
        })).resolves.toEqual({ ok: false, error: "forbidden" });

        expect(currentTx.accessKey.findUnique).toHaveBeenCalledTimes(1);
        expect(currentTx.session.findUnique).toHaveBeenCalledTimes(1);
        expect(currentTx.session.update).toHaveBeenCalledTimes(1);
        expect(currentTx.sessionPendingMessage.findUnique).not.toHaveBeenCalled();
        expect(currentTx.sessionPendingMessage.findFirst).not.toHaveBeenCalled();
        expect(currentTx.sessionMessage.findUnique).not.toHaveBeenCalled();
        expect(applyPendingSessionStateChange).not.toHaveBeenCalled();
    });

    it.each([
        {
            operation: "delete" as const,
            invoke: () => deletePendingMessage({
                actorUserId: "u1",
                sessionId: "s1",
                localId: "l1",
                diagnosticCorrelationId: "req-delete-internal",
            }),
            correlationId: "req-delete-internal",
        },
        {
            operation: "provider-acceptance" as const,
            invoke: () => resolveAcceptedPendingDelivery({
                actorUserId: "u1",
                sessionId: "s1",
                localId: "l1",
                diagnosticCorrelationId: "req-accept-internal",
            }),
            correlationId: "req-accept-internal",
        },
    ])("logs the correlated root exception before returning internal for $operation", async ({ operation, invoke, correlationId }) => {
        const error = new Error("unexpected pending transaction failure");
        inTxMock.mockRejectedValueOnce(error);

        await expect(invoke()).resolves.toEqual({ ok: false, error: "internal" });
        expect(warn).toHaveBeenCalledWith(
            expect.objectContaining({
                module: "session-pending-service",
                operation,
                sessionId: "s1",
                localId: "l1",
                correlationId,
                prismaCode: null,
                err: error,
            }),
            "pending delivery operation failed",
            error,
        );
    });
});
