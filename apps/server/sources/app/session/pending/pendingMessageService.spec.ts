import { beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { createEnvPatcher } from "@/testkit/env";
import {
    buildSessionAgentTransitionDividerLocalId,
    serializeSessionInputRequestEqualityIntentV1,
} from "@happier-dev/protocol";

type ResolveSessionPendingAccess =
    typeof import("./resolveSessionPendingAccess").resolveSessionPendingEditAccess;

let currentTx: any;

const transactionHarness = vi.hoisted(() => ({
    inTx: vi.fn(async (fn: any) => await fn(currentTx)),
}));

vi.mock("@/storage/inTx", async (importOriginal) => ({
    ...await importOriginal<typeof import("@/storage/inTx")>(),
    inTx: transactionHarness.inTx,
}));

const loggingHarness = vi.hoisted(() => ({ warn: vi.fn() }));
vi.mock("@/utils/logging/log", async (importOriginal) => ({
    ...await importOriginal<typeof import("@/utils/logging/log")>(),
    warn: loggingHarness.warn,
}));

const resolveSessionPendingEditAccess = vi.fn<ResolveSessionPendingAccess>(
    async () => ({ ok: true, isOwner: true, level: "owner" }),
);
vi.mock("@/app/session/pending/resolveSessionPendingAccess", () => ({
    resolveSessionPendingEditAccess: (...args: Parameters<ResolveSessionPendingAccess>) =>
        resolveSessionPendingEditAccess(...args),
    resolveSessionPendingOwnerAccess: (...args: Parameters<ResolveSessionPendingAccess>) =>
        resolveSessionPendingEditAccess(...args),
    resolveSessionPendingViewAccess: vi.fn<ResolveSessionPendingAccess>(
        async () => ({ ok: true, isOwner: true, level: "owner" }),
    ),
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

import {
    enqueuePendingMessage,
    enqueuePendingMessageByAuthenticatedMachine,
    resolveAcceptedPendingDelivery,
    sendPendingDeliveryAsNew,
    updatePendingMessage,
} from "./pendingMessageService";

const enqueuePendingMessageCompat = enqueuePendingMessage as unknown as (params: any) => Promise<any>;
const sendPendingDeliveryAsNewCompat = sendPendingDeliveryAsNew as unknown as (params: any) => Promise<any>;
const updatePendingMessageCompat = updatePendingMessage as unknown as (params: any) => Promise<any>;

type PendingSessionFixture = Readonly<{
    accountId: string;
    active: boolean;
    archivedAt: null;
    encryptionMode: "e2ee" | "plain";
    pendingCount: number;
    pendingBlockedCount: number;
    pendingVersion: number;
    pendingQueueSeq: number;
}>;

function createPendingSessionFixture(
    overrides: Partial<PendingSessionFixture> = {},
): PendingSessionFixture {
    return {
        accountId: "u1",
        active: true,
        archivedAt: null,
        encryptionMode: "e2ee",
        pendingCount: 0,
        pendingBlockedCount: 0,
        pendingVersion: 0,
        pendingQueueSeq: 0,
        ...overrides,
    };
}

describe("pendingMessageService", () => {
    const storagePolicyEnv = createEnvPatcher([
        "HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY",
    ]);

    beforeEach(() => {
        loggingHarness.warn.mockClear();
        transactionHarness.inTx.mockReset();
        transactionHarness.inTx.mockImplementation(async (fn: any) => await fn(currentTx));
        resolveSessionPendingEditAccess.mockReset();
        resolveSessionPendingEditAccess.mockResolvedValue({ ok: true, isOwner: true, level: "owner" });
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
            sessionMessage: {
                findUnique: vi.fn(async () => null),
            },
            sessionPendingMessage: {
                findUnique: vi.fn(),
                findFirst: vi.fn(),
                create: vi.fn(),
                update: vi.fn(),
            },
            machine: {
                findFirst: vi.fn(async () => ({
                    revokedAt: null,
                    replacedByMachineId: null,
                })),
            },
            accessKey: {
                findUnique: vi.fn(async () => ({
                    session: { accountId: "u1" },
                    machine: {
                        revokedAt: null,
                        replacedByMachineId: null,
                        operationProtocolCapabilities: {
                            sessionInputAdmission: { protocolVersions: [1] },
                        },
                        operationProtocolCapabilitiesRevision: 1,
                    },
                })),
            },
        };
    });

    it("returns typed correlated transaction unavailability only for pre-callback acquisition failure", async () => {
        const actualTransactions = await vi.importActual<typeof import("@/storage/inTx")>("@/storage/inTx");
        const acquisitionError = Object.assign(
            new Error("Transaction API error: Unable to start a transaction in the given time."),
            { code: "P2028", meta: { error: "Unable to start a transaction in the given time." } },
        );
        const unavailableError = new actualTransactions.TransactionAcquisitionUnavailableError(acquisitionError);
        expect(actualTransactions.isTransactionAcquisitionUnavailableError(unavailableError)).toBe(true);
        expect(actualTransactions.isTransactionAcquisitionUnavailableError(acquisitionError)).toBe(false);
        transactionHarness.inTx.mockRejectedValueOnce(unavailableError);

        await expect(resolveAcceptedPendingDelivery({
            actorUserId: "u1",
            sessionId: "s1",
            localId: "l1",
            publisherAuthority: {
                accountId: "u1",
                machineId: "m1",
                sessionId: "s1",
                committedFence: new Date(1_000),
            },
            diagnosticCorrelationId: "accepted-settlement-1",
        })).resolves.toEqual({
            ok: false,
            error: "transaction-unavailable",
            retryAfterMs: 1_000,
            correlationId: "accepted-settlement-1",
        });
        expect(loggingHarness.warn).toHaveBeenCalledWith(
            expect.objectContaining({
                operation: "provider-acceptance",
                correlationId: "accepted-settlement-1",
                err: unavailableError,
            }),
            "pending delivery transaction acquisition failed",
        );
    });

    it("keeps transaction-body P2028 classified as an internal operation failure", async () => {
        const actualTransactions = await vi.importActual<typeof import("@/storage/inTx")>("@/storage/inTx");
        const operationError = Object.assign(
            new Error("Transaction API error: Unable to start a transaction in the given time."),
            { code: "P2028", meta: { error: "Unable to start a transaction in the given time." } },
        );
        expect(actualTransactions.isTransactionAcquisitionUnavailableError(operationError)).toBe(false);
        transactionHarness.inTx.mockRejectedValueOnce(operationError);

        await expect(resolveAcceptedPendingDelivery({
            actorUserId: "u1",
            sessionId: "s1",
            localId: "l1",
            publisherAuthority: {
                accountId: "u1",
                machineId: "m1",
                sessionId: "s1",
                committedFence: new Date(1_000),
            },
            diagnosticCorrelationId: "accepted-settlement-2",
        })).resolves.toEqual({ ok: false, error: "internal" });
    });

    it("stores plain content when session encryptionMode is plain and storagePolicy is optional", async () => {
        const createdAt = new Date("2020-01-01T00:00:00.000Z");
        storagePolicyEnv.set("HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY", "optional");

        currentTx.session.findUnique.mockResolvedValue(createPendingSessionFixture({ encryptionMode: "plain" }));
        currentTx.sessionPendingMessage.findUnique.mockResolvedValue(null);
        currentTx.sessionPendingMessage.findFirst.mockResolvedValue(null);
        currentTx.sessionPendingMessage.create.mockResolvedValue({
            localId: "l1",
            content: { t: "plain", v: { type: "user", text: "hi" } },
            messageRole: "user",
            requestedAction: { v: 1, kind: "enqueue" },
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

        const res = await enqueuePendingMessageCompat({
            actorUserId: "u1",
            sessionId: "s1",
            localId: "l1",
            content: { t: "plain", v: { type: "user", text: "hi" } },
            requestedAction: { v: 1, kind: "enqueue" },
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

    it("rejects caller-supplied equality evidence on the Account admission path", async () => {
        await expect(enqueuePendingMessageCompat({
            actorUserId: "u1",
            sessionId: "s1",
            localId: "account-equality-forbidden",
            ciphertext: "cipher",
            requestedAction: { v: 1, kind: "enqueue" },
            requestEqualityEvidenceV1: {
                kind: "e2eeTag",
                tag: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
            },
        })).resolves.toEqual({ ok: false, error: "invalid-params" });
        expect(currentTx.session.findUnique).not.toHaveBeenCalled();
    });

    it("derives an immutable shared-admin admission receipt instead of accepting caller receipt data", async () => {
        const createdAt = new Date("2020-01-01T00:00:00.000Z");
        storagePolicyEnv.set("HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY", "optional");
        resolveSessionPendingEditAccess.mockResolvedValue({ ok: true, isOwner: false, level: "admin" });
        currentTx.session.findUnique.mockResolvedValue(createPendingSessionFixture({ encryptionMode: "plain" }));
        currentTx.sessionPendingMessage.findUnique.mockResolvedValue(null);
        currentTx.sessionPendingMessage.findFirst.mockResolvedValue(null);
        currentTx.sessionPendingMessage.create.mockResolvedValue({
            localId: "receipt-admin",
            content: { t: "plain", v: { type: "user", text: "hi" } },
            messageRole: "user",
            requestedAction: { v: 1, kind: "enqueue" },
            status: "queued",
            deliveryState: null,
            deliveryBlockedReason: null,
            position: 1,
            createdAt,
            updatedAt: createdAt,
            discardedAt: null,
            discardedReason: null,
            authorAccountId: "u1",
            inputAdmissionReceipt: {
                v: 1,
                issuer: "authenticatedAccount",
                actorAccountId: "u1",
                sessionRelationship: "sharedAdmin",
            },
        });

        await expect(enqueuePendingMessageCompat({
            actorUserId: "u1",
            sessionId: "s1",
            localId: "receipt-admin",
            content: { t: "plain", v: { type: "user", text: "hi" } },
            requestedAction: { v: 1, kind: "enqueue" },
            inputAdmissionReceipt: { v: 1, issuer: "authenticatedMachine" },
        })).resolves.toMatchObject({ ok: true });

        expect(currentTx.sessionPendingMessage.create).toHaveBeenCalledWith(
            expect.objectContaining({
                data: expect.objectContaining({
                    inputAdmissionReceipt: {
                        v: 1,
                        issuer: "authenticatedAccount",
                        actorAccountId: "u1",
                        sessionRelationship: "sharedAdmin",
                    },
                }),
            }),
        );
    });

    it("rejoins a materialized plain request by its server-derived terminal digest after target settlement replaces content", async () => {
        const createdAt = new Date("2020-01-01T00:00:00.000Z");
        storagePolicyEnv.set("HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY", "optional");
        const requestContent = {
            t: "plain" as const,
            v: {
                happierInputRequestV1: { v: 1, producer: "cli" },
                text: "hello",
            },
        };
        const requestedAction = { v: 1, kind: "enqueue" } as const;
        const receipt = {
            v: 1,
            issuer: "authenticatedAccount",
            actorAccountId: "u1",
            sessionRelationship: "owner",
        } as const;
        const requestEqualityEvidenceV1 = {
            kind: "plainDigest",
            digest: createHash("sha256")
                .update(serializeSessionInputRequestEqualityIntentV1({
                    requestEnvelope: requestContent,
                    requestedAction,
                }), "utf8")
                .digest("base64url"),
        } as const;

        currentTx.session.findUnique.mockResolvedValue(createPendingSessionFixture({
            encryptionMode: "plain",
            pendingVersion: 1,
        }));
        currentTx.sessionPendingMessage.findUnique.mockResolvedValue(null);
        currentTx.sessionMessage.findUnique.mockResolvedValue({
            id: "terminal-1",
            seq: 4,
            localId: "digest-retry",
            content: {
                t: "plain",
                v: {
                    happierInputAuthorityV1: {
                        v: 1,
                        producer: "cli",
                        caller: { kind: "host" },
                        permission: { admittedPermissionCeiling: "default" },
                    },
                    text: "hello",
                },
            },
            messageRole: "user",
            deliveryResolution: null,
            inputAdmissionReceipt: receipt,
            requestEqualityEvidenceV1,
            createdAt,
            updatedAt: createdAt,
        });

        await expect(enqueuePendingMessageCompat({
            actorUserId: "u1",
            sessionId: "s1",
            localId: "digest-retry",
            content: requestContent,
            requestedAction,
        })).resolves.toMatchObject({
            ok: true,
            terminal: true,
            didWrite: false,
            message: { id: "terminal-1" },
        });
        expect(currentTx.sessionPendingMessage.create).not.toHaveBeenCalled();
    });

    it("stores supplied encrypted pending message role metadata", async () => {
        const createdAt = new Date("2020-01-01T00:00:00.000Z");

        currentTx.session.findUnique.mockResolvedValue(createPendingSessionFixture());
        currentTx.sessionPendingMessage.findUnique.mockResolvedValue(null);
        currentTx.sessionPendingMessage.findFirst.mockResolvedValue(null);
        currentTx.sessionPendingMessage.create.mockResolvedValue({
            localId: "l1",
            content: { t: "encrypted", c: "cipher" },
            messageRole: "user",
            requestedAction: { v: 1, kind: "enqueue" },
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

        const res = await enqueuePendingMessageCompat({
            actorUserId: "u1",
            sessionId: "s1",
            localId: "l1",
            ciphertext: "cipher",
            messageRole: "user",
            requestedAction: { v: 1, kind: "enqueue" },
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

    it("rejoins authenticated-machine encrypted retries by opaque equality tag and self-heals missing role metadata", async () => {
        const createdAt = new Date("2020-01-01T00:00:00.000Z");
        const equalityEvidence = {
            kind: "e2eeTag",
            tag: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        } as const;

        currentTx.session.findUnique.mockResolvedValue(createPendingSessionFixture({
            pendingCount: 1,
            pendingVersion: 1,
        }));
        currentTx.sessionPendingMessage.findUnique.mockResolvedValue({
            localId: "l1",
            content: { t: "encrypted", c: "first-random-cipher" },
            messageRole: null,
            requestedAction: { v: 1, kind: "enqueue" },
            status: "queued",
            deliveryState: null,
            deliveryBlockedReason: null,
            position: 1,
            createdAt,
            updatedAt: createdAt,
            discardedAt: null,
            discardedReason: null,
            authorAccountId: null,
            inputAdmissionReceipt: {
                v: 1,
                issuer: "authenticatedMachine",
            },
            requestEqualityEvidenceV1: equalityEvidence,
        });
        currentTx.sessionPendingMessage.update.mockResolvedValue({
            localId: "l1",
            content: { t: "encrypted", c: "first-random-cipher" },
            messageRole: "user",
            requestedAction: { v: 1, kind: "enqueue" },
            status: "queued",
            deliveryState: null,
            deliveryBlockedReason: null,
            position: 1,
            createdAt,
            updatedAt: createdAt,
            discardedAt: null,
            discardedReason: null,
            authorAccountId: null,
            inputAdmissionReceipt: {
                v: 1,
                issuer: "authenticatedMachine",
            },
            requestEqualityEvidenceV1: equalityEvidence,
        });

        const res = await enqueuePendingMessageByAuthenticatedMachine({
            accountId: "u1",
            sourceMachineId: "source-machine",
            targetMachineId: "target-machine",
            sessionId: "s1",
            localId: "l1",
            content: { t: "encrypted", c: "retry-random-cipher" },
            requestedAction: { v: 1, kind: "enqueue" },
            requestEqualityEvidenceV1: equalityEvidence,
        });

        expect(res).toEqual({ status: "alreadyAccepted", localId: "l1" });
        expect(currentTx.sessionPendingMessage.update).toHaveBeenCalledWith(expect.objectContaining({
            data: { messageRole: "user" },
        }));
    });

    it("refuses the reserved Agent-transition divider namespace for every Pending adapter", async () => {
        const createdAt = new Date("2020-01-01T00:00:00.000Z");
        currentTx.session.findUnique.mockResolvedValue(createPendingSessionFixture());
        currentTx.sessionPendingMessage.findUnique.mockResolvedValue(null);
        currentTx.sessionPendingMessage.findFirst.mockResolvedValue(null);
        currentTx.sessionPendingMessage.create.mockResolvedValue({
            localId: "plugin-input-v1:abc",
            content: { t: "encrypted", c: "cipher" },
            messageRole: "user",
            requestedAction: { v: 1, kind: "enqueue" },
            status: "queued",
            deliveryState: null,
            deliveryBlockedReason: null,
            position: 1,
            createdAt,
            updatedAt: createdAt,
            discardedAt: null,
            discardedReason: null,
            authorAccountId: null,
            inputAdmissionReceipt: { v: 1, issuer: "authenticatedMachine" },
            requestEqualityEvidenceV1: null,
        });

        const machineParams = {
            accountId: "u1",
            sourceMachineId: "source-machine",
            targetMachineId: "target-machine",
            sessionId: "s1",
            content: { t: "encrypted" as const, c: "cipher" },
            requestedAction: { v: 1 as const, kind: "enqueue" as const },
        };

        // An authenticated Machine on the same Account must not be able to
        // pre-plant a row at the deterministic divider id and permanently
        // conflict a future Agent transition for this Session.
        await expect(enqueuePendingMessageByAuthenticatedMachine({
            ...machineParams,
            localId: buildSessionAgentTransitionDividerLocalId("submitted-1"),
        })).resolves.toEqual({ status: "rejected", code: "session_input_invalid" });
        expect(currentTx.sessionPendingMessage.create).not.toHaveBeenCalled();

        await expect(enqueuePendingMessageByAuthenticatedMachine({
            ...machineParams,
            localId: "plugin-input-v1:abc",
        })).resolves.toEqual({ status: "accepted", localId: "plugin-input-v1:abc" });
        expect(currentTx.sessionPendingMessage.create).toHaveBeenCalledTimes(1);
    });

    it("rechecks current access without rewriting historical collaborator attribution", async () => {
        const createdAt = new Date("2020-01-01T00:00:00.000Z");
        storagePolicyEnv.set("HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY", "optional");
        resolveSessionPendingEditAccess.mockResolvedValue({ ok: true, isOwner: false, level: "edit" });
        currentTx.session.findUnique.mockResolvedValue(createPendingSessionFixture({
            encryptionMode: "plain",
            pendingCount: 1,
            pendingVersion: 1,
        }));
        currentTx.sessionPendingMessage.findUnique.mockResolvedValue({
            localId: "relationship-drift",
            content: { t: "plain", v: { type: "user", text: "hello" } },
            messageRole: "user",
            requestedAction: { v: 1, kind: "enqueue" },
            status: "queued",
            deliveryState: null,
            deliveryBlockedReason: null,
            position: 1,
            createdAt,
            updatedAt: createdAt,
            discardedAt: null,
            discardedReason: null,
            authorAccountId: "u1",
            inputAdmissionReceipt: {
                v: 1,
                issuer: "authenticatedAccount",
                actorAccountId: "u1",
                sessionRelationship: "sharedAdmin",
            },
            requestEqualityEvidenceV1: null,
        });

        await expect(enqueuePendingMessageCompat({
            actorUserId: "u1",
            sessionId: "s1",
            localId: "relationship-drift",
            content: { t: "plain", v: { type: "user", text: "hello" } },
            requestedAction: { v: 1, kind: "enqueue" },
        })).resolves.toMatchObject({ ok: true, didWrite: false });
    });

    it("rejects encrypted writes when session encryptionMode is plain", async () => {
        const createdAt = new Date("2020-01-01T00:00:00.000Z");
        storagePolicyEnv.set("HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY", "optional");

        currentTx.session.findUnique.mockResolvedValue(createPendingSessionFixture({ encryptionMode: "plain" }));
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
            requestedAction: { v: 1, kind: "enqueue" },
        });

        expect(res).toEqual({ ok: false, error: "invalid-params", code: "session_encryption_mode_mismatch" });
        expect(currentTx.sessionPendingMessage.create).not.toHaveBeenCalled();
    });

    it("rejects encrypted update writes when session encryptionMode is plain (with a stable code)", async () => {
        storagePolicyEnv.set("HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY", "optional");

        currentTx.session.findUnique.mockResolvedValue(createPendingSessionFixture({
            encryptionMode: "plain",
            pendingCount: 1,
            pendingVersion: 1,
        }));
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

        currentTx.session.findUnique.mockResolvedValue(createPendingSessionFixture({
            encryptionMode: "plain",
            pendingCount: 1,
            pendingVersion: 1,
        }));
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
                data: expect.objectContaining({
                    content: { t: "plain", v: { type: "user", text: "hi" } },
                    messageRole: "user",
                }),
            }),
        );
    });

    it("updates pending content in place without changing queue position", async () => {
        storagePolicyEnv.set("HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY", "optional");

        currentTx.session.findUnique.mockResolvedValue(createPendingSessionFixture({
            encryptionMode: "plain",
            pendingCount: 3,
            pendingVersion: 7,
        }));
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
                data: expect.objectContaining({
                    content: { t: "plain", v: { type: "user", text: "edited middle row" } },
                    messageRole: "user",
                }),
            }),
        );
        expect(currentTx.sessionPendingMessage.create).not.toHaveBeenCalled();
    });

    it("does not copy request equality evidence when resend-as-new changes the requested action", async () => {
        currentTx.sessionPendingMessage.findUnique
            .mockResolvedValueOnce({
                status: "queued",
                deliveryState: "blocked",
                deliveryBlockedReason: "delivery_outcome_uncertain",
                discardedReason: null,
                messageRole: "user",
                content: { t: "encrypted", c: "randomized-ciphertext" },
                requestedAction: { v: 1, kind: "send_now" },
                authorAccountId: "u1",
                inputAdmissionReceipt: {
                    v: 1,
                    issuer: "authenticatedAccount",
                    actorAccountId: "u1",
                    sessionRelationship: "owner",
                },
                requestEqualityEvidenceV1: { kind: "e2eeTag", tag: "opaque-original-tag" },
            })
            .mockResolvedValueOnce(null);
        currentTx.sessionPendingMessage.findFirst.mockResolvedValue(null);
        currentTx.session.update.mockResolvedValue({ pendingQueueSeq: 1 });

        await expect(sendPendingDeliveryAsNewCompat({
            actorUserId: "u1",
            sessionId: "s1",
            localId: "original",
        })).resolves.toMatchObject({ ok: true, didWrite: true });

        expect(currentTx.sessionPendingMessage.create).toHaveBeenCalledWith(expect.objectContaining({
            data: expect.not.objectContaining({
                requestEqualityEvidenceV1: expect.anything(),
            }),
        }));
    });

    it("allocates queued positions from a session counter so racing enqueues keep their order", async () => {
        const createdAt = new Date("2020-01-01T00:00:00.000Z");
        let nextPendingQueueSeq = 0;

        currentTx.session.findUnique.mockResolvedValue(createPendingSessionFixture());
        currentTx.session.update.mockImplementation(async () => ({ pendingQueueSeq: ++nextPendingQueueSeq }));
        currentTx.sessionPendingMessage.findUnique.mockResolvedValue(null);
        currentTx.sessionPendingMessage.findFirst.mockResolvedValue(null);
        currentTx.sessionPendingMessage.create.mockImplementation(async ({ data }: { data: any }) => ({
            localId: data.localId,
            content: data.content,
            requestedAction: data.requestedAction,
            status: data.status,
            deliveryState: data.deliveryState ?? null,
            deliveryBlockedReason: null,
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
                requestedAction: { v: 1, kind: "enqueue" },
            }),
            enqueuePendingMessageCompat({
                actorUserId: "u1",
                sessionId: "s1",
                localId: "l2",
                ciphertext: "cipher-2",
                requestedAction: { v: 1, kind: "enqueue" },
            }),
        ]);

        expect(first.ok).toBe(true);
        expect(second.ok).toBe(true);
        expect(currentTx.session.update).toHaveBeenCalledTimes(2);
        expect(currentTx.sessionPendingMessage.findFirst).toHaveBeenCalledTimes(2);
        expect(currentTx.sessionPendingMessage.create.mock.calls.map((call: any[]) => call[0].data.position)).toEqual([1, 2]);
    });
});
