import { beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { createEnvPatcher } from "@/testkit/env";
import {
    buildSessionAgentTransitionDividerLocalId,
    serializeSessionInputRequestEqualityIntentV1,
    encodePlainMachineStoredContent,
    MACHINE_PLAIN_DATA_KEY_MARKER,
    decodeBase64,
} from "@happier-dev/protocol";
import { createPresentUserSessionAccessAuthentication } from "@/app/session/access/sessionAccessAuthentication.testkit";
import { buildSessionInputAdmissionReceipt } from '@/app/session/messages/sessionInputAdmission';

const authentication = createPresentUserSessionAccessAuthentication();
const pendingHomeId = `srv_${'p'.repeat(32)}`;

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

// Keep access projection real; only the persistent database boundary is stubbed.
vi.mock("@/storage/db", async (importOriginal) => {
    const original = await importOriginal<typeof import("@/storage/db")>();
    return {
        getActivePrismaRuntime: () => original.prismaRuntime,
        db: {
            session: {
                findUnique: (...args: unknown[]) => currentTx.session.findUnique(...args),
            },
        },
    };
});

const applyPendingSessionStateChange = vi.fn(async (params: { meaningfulActivityAt?: Date } = {}) => ({
    pendingCount: 1,
    pendingBlockedCount: 0,
    pendingVersion: 1,
    recipientCursors: [],
    ...(params.meaningfulActivityAt ? { meaningfulActivityAt: params.meaningfulActivityAt } : {}),
}));
vi.mock("@/app/session/pending/applyPendingSessionStateChange", () => ({
    applyPendingSessionStateChange: (...args: any[]) => applyPendingSessionStateChange(...args),
}));

const pendingPublicationHarness = vi.hoisted(() => ({ emitPendingChanged: vi.fn(async () => undefined) }));
vi.mock("@/app/session/pending/publishPendingMutation", () => ({
    emitPendingChanged: pendingPublicationHarness.emitPendingChanged,
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
    id: string;
    currentStorageState: "hosted";
    shares: { id: string; sharedWithUserId: string; accessLevel: "view" | "edit" | "admin"; canApprovePermissions: boolean }[];
    account: { status: "active" };
    teamGrants: [];
    groupGrants: [];
    primaryTeamId: null;
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
        id: "s1",
        currentStorageState: "hosted",
        shares: [],
        account: { status: "active" },
        teamGrants: [],
        groupGrants: [],
        primaryTeamId: null,
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
        applyPendingSessionStateChange.mockReset();
        applyPendingSessionStateChange.mockImplementation(async (params: { meaningfulActivityAt?: Date } = {}) => ({
            pendingCount: 1,
            pendingBlockedCount: 0,
            pendingVersion: 1,
            recipientCursors: [],
            ...(params.meaningfulActivityAt ? { meaningfulActivityAt: params.meaningfulActivityAt } : {}),
        }));
        pendingPublicationHarness.emitPendingChanged.mockClear();
        storagePolicyEnv.restore();

        currentTx = {
            session: {
                findUnique: vi.fn(async () => createPendingSessionFixture()),
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
            account: {
                findMany: vi.fn(async () => []),
            },
            machine: {
                findUnique: vi.fn(async ({ where }: { where: { id: string } }) => ({
                    id: where.id, kind: 'persistent', accountId: 'u1', installationId: `installation-${where.id}`,
                    active: true, revokedAt: null, replacedByMachineId: null,
                    metadata: encodePlainMachineStoredContent({ name: 'Pending admission fixture' }), metadataVersion: 1,
                    daemonState: null, daemonStateVersion: 0, dataEncryptionKey: decodeBase64(MACHINE_PLAIN_DATA_KEY_MARKER),
                    account: { status: 'active', encryptionMode: 'plain' },
                    accountGrants: [], teamGrants: [], groupGrants: [],
                })),
                findFirst: vi.fn(async () => ({
                    revokedAt: null,
                    replacedByMachineId: null,
                })),
            },
            simpleCache: {
                findUnique: vi.fn(async () => ({ value: pendingHomeId })),
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

    it("returns typed correlated transaction unavailability when enqueue cannot acquire a transaction", async () => {
        const actualTransactions = await vi.importActual<typeof import("@/storage/inTx")>("@/storage/inTx");
        const acquisitionError = Object.assign(
            new Error("Transaction API error: Unable to start a transaction in the given time."),
            { code: "P2028", meta: { error: "Unable to start a transaction in the given time." } },
        );
        const unavailableError = new actualTransactions.TransactionAcquisitionUnavailableError(acquisitionError);
        transactionHarness.inTx.mockRejectedValueOnce(unavailableError);

        await expect(enqueuePendingMessageCompat({
            actorUserId: "u1",
            sessionId: "s1",
            localId: "enqueue-acquisition-unavailable",
            ciphertext: "cipher",
            requestedAction: { v: 1, kind: "enqueue" },
            authentication,
            diagnosticCorrelationId: "enqueue-acquisition-unavailable-correlation",
        })).resolves.toEqual({
            ok: false,
            error: "transaction-unavailable",
            retryAfterMs: 1_000,
            correlationId: "enqueue-acquisition-unavailable-correlation",
        });
        expect(loggingHarness.warn).toHaveBeenCalledWith(
            expect.objectContaining({
                operation: "enqueue",
                correlationId: "enqueue-acquisition-unavailable-correlation",
            }),
            "pending delivery transaction acquisition failed",
        );
    });

    it("projects Machine enqueue transaction acquisition exhaustion as outcome unknown", async () => {
        const actualTransactions = await vi.importActual<typeof import("@/storage/inTx")>("@/storage/inTx");
        transactionHarness.inTx.mockRejectedValueOnce(
            new actualTransactions.TransactionAcquisitionUnavailableError(
                Object.assign(new Error("Unable to start a transaction in the given time."), { code: "P2028" }),
            ),
        );

        await expect(enqueuePendingMessageByAuthenticatedMachine({
            accountId: "u1",
            sourceMachineId: "source-machine",
            targetMachineId: "target-machine",
            sessionId: "s1",
            localId: "machine-enqueue-acquisition-unavailable",
            content: { t: "encrypted", c: "cipher" },
            requestedAction: { v: 1, kind: "enqueue" },
        })).resolves.toEqual({
            status: "outcomeUnknown",
            localId: "machine-enqueue-acquisition-unavailable",
            code: "session_input_admission_outcome_unknown",
        });
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
            targetExecutionRunId: null,
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
            authentication,
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
            authentication,
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
        currentTx.session.findUnique.mockResolvedValue(createPendingSessionFixture({
            accountId: "owner",
            encryptionMode: "plain",
            shares: [{ id: "admin-share", sharedWithUserId: "u1", accessLevel: "admin", canApprovePermissions: false }],
        }));
        currentTx.sessionPendingMessage.findUnique.mockResolvedValue(null);
        currentTx.sessionPendingMessage.findFirst.mockResolvedValue(null);
        currentTx.sessionPendingMessage.create.mockResolvedValue({
            targetExecutionRunId: null,
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
            authentication,
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
            sidechainId: null,
            targetExecutionRunId: null,
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
            authorAccountId: "u1",
            requestEqualityEvidenceV1,
            createdAt,
            updatedAt: createdAt,
        });

        await expect(enqueuePendingMessageCompat({
            authentication,
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

    it("rejoins a materialized plain Pending request by its server-derived digest", async () => {
        const createdAt = new Date("2020-01-01T00:00:00.000Z");
        storagePolicyEnv.set("HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY", "optional");
        const content = { t: "plain" as const, v: { type: "user", text: "hello" } };
        const requestedAction = { v: 1, kind: "enqueue" } as const;
        const requestEqualityEvidenceV1 = {
            kind: "plainDigest",
            digest: createHash("sha256")
                .update(serializeSessionInputRequestEqualityIntentV1({ requestEnvelope: content, requestedAction }), "utf8")
                .digest("base64url"),
        } as const;

        currentTx.session.findUnique.mockResolvedValue(createPendingSessionFixture({ encryptionMode: "plain" }));
        currentTx.sessionPendingMessage.findUnique.mockResolvedValue({
            targetExecutionRunId: null,
            localId: "pending-digest-retry",
            content,
            messageRole: "user",
            requestedAction,
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
                sessionRelationship: "owner",
            },
            requestEqualityEvidenceV1,
        });

        await expect(enqueuePendingMessageCompat({
            authentication,
            actorUserId: "u1",
            sessionId: "s1",
            localId: "pending-digest-retry",
            content,
            requestedAction,
        })).resolves.toMatchObject({
            ok: true,
            didWrite: false,
            pending: { localId: "pending-digest-retry" },
        });
        expect(currentTx.sessionPendingMessage.create).not.toHaveBeenCalled();
    });

    it("rejects direct-token encrypted nonuser pending inputs before they can omit user constraints", async () => {
        await expect(enqueuePendingMessageCompat({ authentication: { ...authentication, apiTokenGrant: {
            v: 1, actions: { families: ["messaging"], ids: [] }, targets: null,
            approve: false, origins: [], models: null, permissionModes: ["default"], create: null,
        } }, actorUserId: "u1", sessionId: "s1", localId: "forged-role", ciphertext: "cipher", messageRole: "event" }))
            .resolves.toMatchObject({ ok: false, error: "invalid-params" });
        await expect(updatePendingMessage({ authentication: { ...authentication, apiTokenGrant: {
            v: 1, actions: { families: ["messaging"], ids: [] }, targets: null,
            approve: false, origins: [], models: null, permissionModes: ["default"], create: null,
        } }, actorUserId: "u1", sessionId: "s1", localId: "forged-role", ciphertext: "cipher", messageRole: "event" }))
            .resolves.toMatchObject({ ok: false, error: "invalid-params" });
    });

    it("stores encrypted pending message role metadata and verified token input constraints", async () => {
        const createdAt = new Date("2020-01-01T00:00:00.000Z");

        currentTx.session.findUnique.mockResolvedValue(createPendingSessionFixture());
        currentTx.sessionPendingMessage.findUnique.mockResolvedValue(null);
        currentTx.sessionPendingMessage.findFirst.mockResolvedValue(null);
        currentTx.sessionPendingMessage.create.mockResolvedValue({
            targetExecutionRunId: null,
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
            authentication: { ...authentication, apiTokenGrant: {
                v: 1, actions: { families: ["messaging"], ids: [] }, targets: null,
                approve: false, origins: [], models: null, permissionModes: ["default"], create: null,
            } },
            actorUserId: "u1",
            sessionId: "s1",
            localId: "l1",
            ciphertext: "cipher",
            requestedAction: { v: 1, kind: "enqueue" },
        });

        expect(res.ok).toBe(true);
        expect(res.pending.messageRole).toBe("user");
        expect(currentTx.sessionPendingMessage.create).toHaveBeenCalledWith(
            expect.objectContaining({
                data: expect.objectContaining({
                    messageRole: "user",
                    inputAdmissionReceipt: expect.objectContaining({
                        actorAccountId: "u1", callerInputConstraints: { models: null, permissionModes: ["default"] },
                    }),
                }),
            }),
        );
    });

    it("rejoins authenticated-machine encrypted retries by opaque equality tag and self-heals missing role metadata", async () => {
        const createdAt = new Date("2020-01-01T00:00:00.000Z");
        const inputAdmissionReceipt = buildSessionInputAdmissionReceipt({ issuer: 'authenticatedMachine',
            admittedTarget: { homeId: pendingHomeId, accountId: 'u1', sessionId: 's1',
                machineId: 'target-machine', installationId: 'installation-target-machine' } });
        const equalityEvidence = {
            kind: "e2eeTag",
            tag: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        } as const;

        currentTx.session.findUnique.mockResolvedValue(createPendingSessionFixture({
            pendingCount: 1,
            pendingVersion: 1,
        }));
        currentTx.sessionPendingMessage.findUnique.mockResolvedValue({
            targetExecutionRunId: null,
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
            inputAdmissionReceipt,
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
            inputAdmissionReceipt,
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

    it("publishes the exact Run recovery hint after authenticated Machine target custody is durable", async () => {
        const createdAt = new Date("2020-01-01T00:00:00.000Z");
        storagePolicyEnv.set("HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY", "optional");
        currentTx.session.findUnique.mockResolvedValue({
            ...createPendingSessionFixture({ encryptionMode: "plain" }),
            account: { status: "active" },
            teamGrants: [],
            groupGrants: [],
            primaryTeamId: null,
        });
        currentTx.accessKey.findUnique.mockResolvedValue({
            session: { accountId: "u1" },
            machine: {
                revokedAt: null,
                replacedByMachineId: null,
                operationProtocolCapabilities: { sessionInputAdmission: { protocolVersions: [1, 2] } },
                operationProtocolCapabilitiesRevision: 1,
            },
        });
        currentTx.sessionPendingMessage.findUnique.mockResolvedValue(null);
        currentTx.sessionPendingMessage.findFirst.mockResolvedValue(null);
        currentTx.sessionPendingMessage.create.mockResolvedValue({
            targetExecutionRunId: "run-1",
            localId: "target-1",
            content: {
                t: "plain",
                v: {
                    type: "user",
                    text: "continue",
                    meta: {
                        happier: {
                            kind: "participant_message.v1",
                            payload: { recipient: { kind: "execution_run", runId: "run-1" } },
                        },
                    },
                },
            },
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
        applyPendingSessionStateChange.mockResolvedValue({
            pendingCount: 0,
            pendingBlockedCount: 0,
            pendingVersion: 2,
            recipientCursors: [],
        });

        const result = await enqueuePendingMessageByAuthenticatedMachine({
            accountId: "u1",
            sourceMachineId: "source-machine",
            targetMachineId: "target-machine",
            sessionId: "s1",
            targetExecutionRunId: "run-1",
            localId: "target-1",
            content: {
                t: "plain",
                v: {
                    type: "user",
                    text: "continue",
                    meta: {
                        happier: {
                            kind: "participant_message.v1",
                            payload: { recipient: { kind: "execution_run", runId: "run-1" } },
                        },
                    },
                },
            },
            requestedAction: { v: 1, kind: "enqueue" },
        });

        expect(result).toEqual({ status: "accepted", localId: "target-1" });
        expect(pendingPublicationHarness.emitPendingChanged).toHaveBeenCalledWith(expect.objectContaining({
            sessionId: "s1",
            pendingVersion: 2,
            recipient: { kind: "execution_run", runId: "run-1" },
        }));
    });

    it("refuses the reserved Agent-transition divider namespace for every Pending adapter", async () => {
        const createdAt = new Date("2020-01-01T00:00:00.000Z");
        currentTx.session.findUnique.mockResolvedValue(createPendingSessionFixture());
        currentTx.sessionPendingMessage.findUnique.mockResolvedValue(null);
        currentTx.sessionPendingMessage.findFirst.mockResolvedValue(null);
        currentTx.sessionPendingMessage.create.mockResolvedValue({
            targetExecutionRunId: null,
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
        currentTx.session.findUnique.mockResolvedValue(createPendingSessionFixture({
            accountId: "owner",
            shares: [{ id: "editor-share", sharedWithUserId: "u1", accessLevel: "edit", canApprovePermissions: false }],
            encryptionMode: "plain",
            pendingCount: 1,
            pendingVersion: 1,
        }));
        currentTx.sessionPendingMessage.findUnique.mockResolvedValue({
            targetExecutionRunId: null,
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
            authentication,
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
            targetExecutionRunId: null,
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
            authentication,
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
            authentication,
            actorUserId: "u1",
            sessionId: "s1",
            localId: "l1",
            ciphertext: "cipher",
        });

        expect(res).toEqual({ ok: false, error: "invalid-params", code: "session_encryption_mode_mismatch" });
        expect(currentTx.sessionPendingMessage.update).not.toHaveBeenCalled();
    });

    it("updates pending content using plain envelopes and stamps the editing token's input constraints", async () => {
        storagePolicyEnv.set("HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY", "optional");

        currentTx.session.findUnique.mockResolvedValue(createPendingSessionFixture({
            encryptionMode: "plain",
            pendingCount: 1,
            pendingVersion: 1,
        }));
        currentTx.sessionPendingMessage.findUnique.mockResolvedValue({ id: "p1", status: "queued" });
        currentTx.sessionPendingMessage.update = vi.fn();

        const res = await updatePendingMessageCompat({
            authentication: { ...authentication, apiTokenGrant: {
                v: 1, actions: { families: ["messaging"], ids: [] }, targets: null,
                approve: false, origins: [], models: null, permissionModes: ["default"], create: null,
            } },
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
                    inputAdmissionReceipt: expect.objectContaining({
                        actorAccountId: "u1",
                        callerInputConstraints: { models: null, permissionModes: ["default"] },
                    }),
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
            authentication,
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
        currentTx.session.findUniqueOrThrow = vi.fn(async () => ({ pendingActivationRequestId: null }));
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
            authentication,
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
                authentication,
                actorUserId: "u1",
                sessionId: "s1",
                localId: "l1",
                ciphertext: "cipher-1",
                requestedAction: { v: 1, kind: "enqueue" },
            }),
            enqueuePendingMessageCompat({
                authentication,
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
